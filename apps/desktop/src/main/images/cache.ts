import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { parseCachedImageUrl } from '@cslytics/catalogue';
import type { ImageFetch } from './fetch.js';

/**
 * Where item art lives between runs, and the only thing in this app that fetches a picture.
 *
 * ## Why this exists
 *
 * The renderer used to load art straight from Steam's CDN. The failure the user reported —
 * "sometimes the inventory doesn't load skin images" — is not one bug but a family of them, and
 * every member fails the same silent way through an `<img>` element:
 *
 *  - the window opened before the network was up, or the machine resumed from sleep;
 *  - the CDN edge answered slowly, or an intercepting appliance on the network served an HTML
 *    block page with a `200` (which decodes as a broken image, not as an error anybody can read);
 *  - a host answered `30x` to somewhere `img-src` did not name, which is invisible by
 *    construction — it is how every account avatar stayed as initials for weeks;
 *  - a certificate verdict the compiled exception did not enumerate.
 *
 * None of those could be logged, told apart, or retried from inside an element whose entire
 * error vocabulary is one `onerror` event. Worse, nothing was *kept*: the bytes lived only in
 * Chromium's HTTP cache, which is shared, unbounded (the catalogue plan §9.5 owed a bound it never
 * paid) and evictable, so a cold start with no network drew placeholders for items the app had
 * displayed a thousand times.
 *
 * ## What it guarantees
 *
 * 1. **Seen once is kept.** Every reference this app addresses is content-addressed upstream — an
 *    economy hash is derived from the image, and an avatar hash changes when the avatar does — so
 *    a stored file can never be stale and is *never revalidated*. There is no conditional request,
 *    no `max-age`, no expiry. That is what makes an offline launch look like an online one.
 * 2. **A failure is attributable.** Status, content type and host are logged once per reference
 *    per transition, so the next occurrence names which of the causes above it was instead of
 *    leaving a shrug on the screen.
 * 3. **A transient failure is retried, a permanent one is left alone.** The backoff lives in
 *    memory and never reaches the disk: persisting "this image failed" is precisely the bug being
 *    fixed, because the commonest cause is a condition that is over by the next launch.
 * 4. **It is bounded.** `BUDGET_BYTES` of least-recently-used files, enforced on open and after
 *    writes. Deleting the directory is a complete and safe reset; nothing here is a record of
 *    anything, which is why it is a main-owned directory under `userData` and emphatically not a
 *    table in `trading.sqlite`.
 * 5. **One request per image, not one per tile.** Forty rows of the same case coalesce onto a
 *    single fetch, and at most `CONCURRENCY` fetches are in flight at once — the renderer-side cap
 *    the catalogue plan §9.5 asked for, enforced where it can actually be counted.
 *
 * The cache is keyed by the *upstream URL*, so the same hash at 64 and at 256 are two files, and
 * changing `ECON_IMAGE_HOST` invalidates nothing by accident — it simply addresses new keys.
 */

/**
 * Least-recently-used ceiling. Item art is 8–60 KB a file at list sizes and about 100 KB at the
 * inspector's 512, so this is still several thousand pictures.
 */
const BUDGET_BYTES = 192 * 1024 * 1024;
/** Evict down to this share of the budget, so a full cache does not evict on every single write. */
const EVICT_TO = 0.9;
/** Chromium's own per-host ceiling, applied to our own fetches so a big page cannot stampede. */
const CONCURRENCY = 6;
/** A picture larger than this is not one of ours, whatever the content type claims. */
const MAX_BYTES = 4 * 1024 * 1024;
/** Long enough for a cold CDN edge; short enough that a hung socket becomes a retry, not a gap. */
const TIMEOUT_MS = 20_000;
/** Recency is tracked by mtime, and refreshed at most this often, so a hit is normally free. */
const TOUCH_AFTER_MS = 24 * 60 * 60 * 1000;
/** Transient-failure backoff. The last figure repeats; nothing here outlives the process. */
const BACKOFF_MS = [2_000, 10_000, 60_000, 300_000];

/** What may be decoded as a picture. An HTML block page with a `200` is caught precisely here. */
const EXTENSIONS = new Map<string, string>([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
  ['image/avif', 'avif'],
  ['image/bmp', 'bmp']
]);

type Stored = { file: string; bytes: number; used: number };
type Failure = { attempts: number; nextAt: number; reason: string };

export type ImageCacheStats = { files: number; bytes: number; hits: number; fetched: number; failed: number; waiting: number };

export class ImageCache {
  private readonly stored = new Map<string, Stored>();
  private readonly failures = new Map<string, Failure>();
  private readonly inFlight = new Map<string, Promise<Stored | null>>();
  private readonly queue: Array<() => void> = [];
  private active = 0;
  private total = 0;
  private hits = 0;
  private fetched = 0;
  private failed = 0;

  constructor(
    private readonly directory: string,
    private readonly fetchImage: ImageFetch,
    private readonly now: () => number = () => Date.now()
  ) {}

  /**
   * Adopt whatever is already on disk.
   *
   * The directory listing *is* the index — there is no manifest to fall out of step with it, get
   * half-written, or need a version. A file that cannot be read is dropped on the next miss, and
   * a file nobody remembers is simply an old picture, which is exactly what it is.
   */
  async open(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true });
    for (const entry of await fs.readdir(this.directory, { withFileTypes: true })) {
      if (!entry.isFile() || entry.name.endsWith('.tmp')) continue;
      const key = entry.name.split('.')[0] ?? '';
      if (!/^[0-9a-f]{64}$/.test(key)) continue;
      try {
        const stat = await fs.stat(join(this.directory, entry.name));
        this.stored.set(key, { file: entry.name, bytes: stat.size, used: stat.mtimeMs });
        this.total += stat.size;
      } catch { /* vanished between listing and stat; it simply is not cached */ }
    }
    await this.evict();
  }

  stats(): ImageCacheStats {
    return { files: this.stored.size, bytes: this.total, hits: this.hits, fetched: this.fetched, failed: this.failed, waiting: this.queue.length };
  }

  /**
   * Answer one `cs-image:` request.
   *
   * A non-2xx here is not an error state the window has to handle — `Thumbnail` draws its labelled
   * placeholder and retries on a schedule — so this method never throws and never blocks the
   * window on a network it cannot reach.
   */
  async handle(url: string): Promise<Response> {
    const request = parseCachedImageUrl(url);
    if (!request) {
      console.warn('image: refused an unaddressable reference', url);
      return new Response(null, { status: 400, headers: { 'cache-control': 'no-store' } });
    }
    const key = createHash('sha256').update(request.upstream).digest('hex');

    const hit = await this.read(key);
    if (hit) {
      this.hits += 1;
      return this.serve(hit.bytes, hit.type);
    }

    const waiting = this.failures.get(key);
    if (waiting && waiting.nextAt > this.now()) {
      return new Response(null, { status: 503, headers: { 'cache-control': 'no-store', 'retry-after': '5' } });
    }

    // One fetch per image, however many tiles asked for it.
    let flight = this.inFlight.get(key);
    if (!flight) {
      flight = this.acquire(() => this.download(key, request.ref, request.upstream)).finally(() => this.inFlight.delete(key));
      this.inFlight.set(key, flight);
    }
    const entry = await flight;
    if (!entry) return new Response(null, { status: 504, headers: { 'cache-control': 'no-store', 'retry-after': '5' } });

    const bytes = await this.readFile(key, entry);
    return bytes ? this.serve(bytes, contentTypeOf(entry.file)) : new Response(null, { status: 504, headers: { 'cache-control': 'no-store' } });
  }

  /**
   * Bytes are immutable, so the window may hold them for a year without asking again.
   *
   * This is the in-session half of the same guarantee the directory gives across sessions: a
   * scroll back up a long inventory does not re-enter this process at all.
   */
  private serve(bytes: Uint8Array, type: string): Response {
    return new Response(bytes as unknown as BodyInit, {
      status: 200,
      headers: {
        'content-type': type,
        'content-length': String(bytes.byteLength),
        'cache-control': 'public, max-age=31536000, immutable'
      }
    });
  }

  private async read(key: string): Promise<{ bytes: Uint8Array; type: string } | null> {
    const entry = this.stored.get(key);
    if (!entry) return null;
    const bytes = await this.readFile(key, entry);
    return bytes ? { bytes, type: contentTypeOf(entry.file) } : null;
  }

  private async readFile(key: string, entry: Stored): Promise<Uint8Array | null> {
    try {
      const bytes = await fs.readFile(join(this.directory, entry.file));
      // Recency, refreshed at most daily: an LRU that writes on every hit costs more than it saves.
      if (this.now() - entry.used > TOUCH_AFTER_MS) {
        entry.used = this.now();
        void fs.utimes(join(this.directory, entry.file), new Date(entry.used), new Date(entry.used)).catch(() => undefined);
      }
      return bytes;
    } catch {
      // Evicted by hand, or on a volume that lost it. Forget it and let the next call refetch.
      this.stored.delete(key);
      this.total -= entry.bytes;
      return null;
    }
  }

  /** Fetch, validate and store one picture, or record why not. Never throws. */
  private async download(key: string, ref: string, upstream: string): Promise<Stored | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await this.fetchImage(upstream, { signal: controller.signal });
      if (response.status >= 300 && response.status < 400) {
        // The failure mode that hid for weeks, now named out loud: a redirect target is a host
        // nobody allowlisted, and following it would let the response choose where art comes from.
        return this.note(key, ref, `redirected to ${response.headers.get('location') ?? 'an unnamed host'}`);
      }
      if (!response.ok) return this.note(key, ref, `HTTP ${response.status}`);

      const type = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
      const extension = EXTENSIONS.get(type);
      // A captive portal or a web filter answers 200 with HTML. That is the shape of "the picture
      // is missing and the network lied about it", and it must not be written to the cache.
      if (!extension) return this.note(key, ref, `content-type ${type || 'absent'} is not an image`);

      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength === 0) return this.note(key, ref, 'empty body');
      if (bytes.byteLength > MAX_BYTES) return this.note(key, ref, `${bytes.byteLength} bytes exceeds the ceiling`);

      const entry = await this.store(key, extension, bytes);
      this.fetched += 1;
      // A success clears the backoff outright: the condition that caused the last failure is over,
      // and remembering it would re-create the latched placeholder this whole cache replaces.
      if (this.failures.delete(key)) console.info('image: recovered', ref);
      return entry;
    } catch (error) {
      const reason = controller.signal.aborted ? `no answer in ${TIMEOUT_MS} ms` : error instanceof Error ? error.message : String(error);
      return this.note(key, ref, reason);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Record a failure, log the first one and every escalation, and back off. */
  private note(key: string, ref: string, reason: string): null {
    const previous = this.failures.get(key);
    const attempts = (previous?.attempts ?? 0) + 1;
    const backoff = BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)]!;
    this.failures.set(key, { attempts, nextAt: this.now() + backoff, reason });
    this.failed += 1;
    // Once per reason, not once per attempt: a window full of tiles failing the same way should
    // produce one legible line, not a scroll of them.
    if (previous?.reason !== reason) console.warn(`image: ${ref} failed — ${reason} (attempt ${attempts}, retrying in ${backoff} ms)`);
    return null;
  }

  private async store(key: string, extension: string, bytes: Uint8Array): Promise<Stored> {
    const file = `${key}.${extension}`;
    const target = join(this.directory, file);
    // Write then rename, the discipline `CatalogueStore` uses for the same reason: a process that
    // dies mid-write must leave no half a picture behind to be served forever as a hit.
    const temporary = `${target}.${process.pid}.${this.now()}.tmp`;
    await fs.writeFile(temporary, bytes);
    try {
      await fs.rename(temporary, target);
    } catch (error) {
      await fs.rm(temporary, { force: true });
      throw error;
    }
    const previous = this.stored.get(key);
    if (previous) this.total -= previous.bytes;
    const entry: Stored = { file, bytes: bytes.byteLength, used: this.now() };
    this.stored.set(key, entry);
    this.total += entry.bytes;
    await this.evict();
    return entry;
  }

  /** Least-recently-used, down to `EVICT_TO` of the budget so this is rare rather than constant. */
  private async evict(): Promise<void> {
    if (this.total <= BUDGET_BYTES) return;
    const target = BUDGET_BYTES * EVICT_TO;
    const oldest = [...this.stored.entries()].sort(([, a], [, b]) => a.used - b.used);
    let removed = 0;
    for (const [key, entry] of oldest) {
      if (this.total <= target) break;
      this.stored.delete(key);
      this.total -= entry.bytes;
      removed += 1;
      await fs.rm(join(this.directory, entry.file), { force: true }).catch(() => undefined);
    }
    if (removed > 0) console.info(`image: evicted ${removed} least-recently-used files, now ${Math.round(this.total / 1024 / 1024)} MB`);
  }

  /** At most `CONCURRENCY` upstream fetches at once; the rest wait rather than stampede. */
  private async acquire<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= CONCURRENCY) await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active += 1;
    try {
      return await work();
    } finally {
      this.active -= 1;
      this.queue.shift()?.();
    }
  }
}

function contentTypeOf(file: string): string {
  const extension = file.split('.').pop() ?? '';
  for (const [type, candidate] of EXTENSIONS) if (candidate === extension) return type;
  return 'application/octet-stream';
}

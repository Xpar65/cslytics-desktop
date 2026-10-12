import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import type { StorePriceEntry, StorePriceSheet } from '@cslytics/ports';

/**
 * The CS2 in-game store price sheet, from bytes to a strict shape.
 *
 * `StoreGetUserDataResponse.price_sheet` is a Valve LZMA container around a binary KeyValues
 * tree. Three stages, each pinned to a captured fixture in `tests/unit/in-game-store-sheet.test.ts`:
 * the container header is validated before any decoding, the KeyValues walk knows exactly the
 * type bytes Valve emits and refuses the rest, and the sheet converter demands the fields a
 * purchase needs. A sheet that fails any stage is *unparseable*, never partially trusted —
 * a price read out of a half-parsed tree is a price the engine would freeze into a command.
 *
 * Formats: the container is the Source SDK's `lzma_header_t` (`tier1/lzmaDecoder.h`), and the
 * tag numbers are SteamKit's `KeyValue.Type`. The first live capture
 * (`fixtures/steam/contracts/gc-store-price-sheet-*-live.json`) decoded cleanly under both.
 */

export class StoreSheetError extends Error {
  constructor(readonly stage: 'lzma' | 'keyvalues' | 'shape', message: string) {
    super(message);
    this.name = 'StoreSheetError';
  }
}

// ---------------------------------------------------------------- the Valve LZMA container

/**
 * Byte offsets of `lzma_header_t`: an id that spells `LZMA`, the decoded size (`actualSize`) and
 * the compressed size (`lzmaSize`) as little-endian uint32s, five LZMA property bytes, and then
 * the compressed stream itself.
 */
const LZMA_LAYOUT = { id: 0, actualSize: 4, lzmaSize: 8, properties: 12, stream: 17 } as const;
const LZMA_ID = 'LZMA';

export type ValveLzmaHeader = {
  uncompressedLength: number;
  compressedLength: number;
};

/**
 * Reads and checks the 17-byte Valve prefix without decoding anything.
 *
 * Separate from the decode so a unit test can prove the refusal paths — short buffer, wrong
 * magic, a compressed length that runs past the end — with byte vectors and no decoder.
 */
export function readValveLzmaHeader(container: Buffer): ValveLzmaHeader {
  if (container.length < LZMA_LAYOUT.stream) {
    throw new StoreSheetError('lzma', `a Valve LZMA header is ${LZMA_LAYOUT.stream} bytes and this container has ${container.length}`);
  }
  const id = container.toString('latin1', LZMA_LAYOUT.id, LZMA_LAYOUT.id + LZMA_ID.length);
  if (id !== LZMA_ID) {
    throw new StoreSheetError('lzma', `bad magic: the container id reads ${JSON.stringify(id)}, not "${LZMA_ID}"`);
  }
  const header: ValveLzmaHeader = {
    uncompressedLength: container.readUInt32LE(LZMA_LAYOUT.actualSize),
    compressedLength: container.readUInt32LE(LZMA_LAYOUT.lzmaSize)
  };
  const end = LZMA_LAYOUT.stream + header.compressedLength;
  if (end > container.length) {
    throw new StoreSheetError('lzma', `the header declares ${end} bytes and the container has ${container.length}`);
  }
  return header;
}

/**
 * Re-frames the Valve container as an LZMA-alone (`.lzma`) stream and decodes it.
 *
 * The two framings share the property bytes; LZMA-alone follows them with the decoded size as a
 * uint64 instead of a uint32, and has no id. So the conversion widens the size and drops the id.
 *
 * The decoder is the pure-JavaScript `lzma` package rather than `lzma-native`: the Engine
 * Runtime is an Electron utility process, and a native addon there means a rebuild per Electron
 * version and an asar-unpack rule, for a sheet that is a few kilobytes. The decoder hands back
 * a signed byte array for binary input and a string for text; both are converted losslessly
 * (verified 2026-09-13 on NUL-bearing, multibyte and invalid-lead vectors).
 */
export async function decodeValveLzma(container: Buffer): Promise<Buffer> {
  const { uncompressedLength, compressedLength } = readValveLzmaHeader(container);
  const size = Buffer.alloc(8);
  size.writeBigUInt64LE(BigInt(uncompressedLength));
  const alone = Buffer.concat([
    container.subarray(LZMA_LAYOUT.properties, LZMA_LAYOUT.stream),
    size,
    container.subarray(LZMA_LAYOUT.stream, LZMA_LAYOUT.stream + compressedLength)
  ]);
  const decoded = await runDecoder(alone);
  if (decoded.length !== uncompressedLength) {
    throw new StoreSheetError('lzma', `the container declared ${uncompressedLength} bytes and ${decoded.length} decoded`);
  }
  return decoded;
}

const require = createRequire(import.meta.url);
type LzmaModule = { decompress(bytes: number[] | Uint8Array, onFinish: (result: unknown, error: unknown) => void): void };

function runDecoder(stream: Buffer): Promise<Buffer> {
  const lzma = require('lzma') as LzmaModule;
  return new Promise((resolve, reject) => {
    try {
      lzma.decompress([...stream], (result, error) => {
        if (error) {
          reject(new StoreSheetError('lzma', `LZMA decode failed: ${String(error)}`));
          return;
        }
        if (typeof result === 'string') {
          resolve(Buffer.from(result, 'utf8'));
          return;
        }
        if (Array.isArray(result)) {
          resolve(Buffer.from(result.map((byte) => Number(byte) & 0xff)));
          return;
        }
        reject(new StoreSheetError('lzma', `LZMA decoder returned ${typeof result}`));
      });
    } catch (error) {
      reject(new StoreSheetError('lzma', `LZMA decode threw: ${error instanceof Error ? error.message : String(error)}`));
    }
  });
}

// ---------------------------------------------------------------- binary KeyValues

export type KeyValuesLeaf = string | number | bigint;
export type KeyValuesNode = { [key: string]: KeyValuesNode | KeyValuesLeaf };

/** The tag byte in front of every entry. A tag outside this table is a refusal, not a guess. */
const TAG = {
  object: 0,
  string: 1,
  int32: 2,
  float32: 3,
  pointer: 4,
  wideString: 5,
  color: 6,
  uint64: 7,
  end: 8,
  int64: 10,
  alternateEnd: 11
} as const;

type FixedWidth = { bytes: number; read(source: Buffer, at: number): KeyValuesLeaf };

/** The leaves with a fixed width, keyed by tag. Pointers and colours are four opaque bytes. */
const FIXED_WIDTH: ReadonlyMap<number, FixedWidth> = new Map<number, FixedWidth>([
  [TAG.int32, { bytes: 4, read: (source, at) => source.readInt32LE(at) }],
  [TAG.pointer, { bytes: 4, read: (source, at) => source.readInt32LE(at) }],
  [TAG.color, { bytes: 4, read: (source, at) => source.readInt32LE(at) }],
  [TAG.float32, { bytes: 4, read: (source, at) => source.readFloatLE(at) }],
  [TAG.uint64, { bytes: 8, read: (source, at) => source.readBigUInt64LE(at) }],
  [TAG.int64, { bytes: 8, read: (source, at) => source.readBigInt64LE(at) }]
]);

/** A forward-only cursor that refuses to read past the end rather than throwing a RangeError. */
class KeyValuesReader {
  private position = 0;

  constructor(private readonly source: Buffer) {}

  get offset(): number {
    return this.position;
  }

  get done(): boolean {
    return this.position >= this.source.length;
  }

  tag(): number {
    return this.source[this.position++]!;
  }

  text(): string {
    const nul = this.source.indexOf(0, this.position);
    if (nul === -1) throw new StoreSheetError('keyvalues', `unterminated string at offset ${this.position}`);
    const value = this.source.toString('utf8', this.position, nul);
    this.position = nul + 1;
    return value;
  }

  fixed(width: FixedWidth): KeyValuesLeaf {
    if (this.position + width.bytes > this.source.length) {
      throw new StoreSheetError('keyvalues', `a ${width.bytes}-byte value at offset ${this.position} runs past the end`);
    }
    const value = width.read(this.source, this.position);
    this.position += width.bytes;
    return value;
  }
}

/**
 * Walks a binary KeyValues stream into a tree, with an explicit stack of open objects.
 *
 * The outermost object arrives with an empty name followed by its real one (`store` in the
 * price sheet), so the walk takes that second string as the key; without it the tree would sit
 * under `""` and the sheet converter could not find `store`. An empty-named leaf carries
 * nothing addressable and is dropped. The walk ends when the outermost object closes.
 */
export function parseBinaryKeyValues(buffer: Buffer): KeyValuesNode {
  const reader = new KeyValuesReader(buffer);
  const root: KeyValuesNode = {};
  const open: KeyValuesNode[] = [root];
  for (;;) {
    if (reader.done) throw new StoreSheetError('keyvalues', 'KeyValues ended without an End marker');
    const at = reader.offset;
    const tag = reader.tag();
    const parent = open[open.length - 1]!;
    if (tag === TAG.end || tag === TAG.alternateEnd) {
      open.pop();
      if (open.length === 0) return root;
      continue;
    }
    let key = reader.text();
    if (tag === TAG.object) {
      if (key === '' && parent === root && Object.keys(root).length === 0) key = reader.text();
      const child: KeyValuesNode = {};
      parent[key] = child;
      open.push(child);
      continue;
    }
    let leaf: KeyValuesLeaf;
    if (tag === TAG.string) leaf = reader.text();
    else if (FIXED_WIDTH.has(tag)) leaf = reader.fixed(FIXED_WIDTH.get(tag)!);
    else if (tag === TAG.wideString) throw new StoreSheetError('keyvalues', `wide string at offset ${at} is not supported`);
    else throw new StoreSheetError('keyvalues', `unknown KeyValues type ${tag} at offset ${at}`);
    if (key !== '') parent[key] = leaf;
  }
}

// ---------------------------------------------------------------- sheet shape

/**
 * The fields a purchase needs, and nothing looser.
 *
 * `entries` is keyed by the string the GC uses (the first live capture settles whether that is
 * a def index); each entry's `prices` and optional `sale_prices` are keyed by a currency label.
 * Every price must be an integer in minor units: a float or a negative is a refusal, because a
 * rounded price becomes the `cost_in_local_currency` the GC is asked to charge.
 */
export function parsePriceSheet(root: KeyValuesNode, version: number): StorePriceSheet {
  const store = objectField(root, 'store', 'root');
  const rawEntries = objectField(store, 'entries', 'store');
  const rawCurrencies = objectField(store, 'currencies', 'store');

  const currencies: Record<string, number> = {};
  for (const [code, value] of Object.entries(rawCurrencies)) {
    currencies[code] = integerLeaf(value, `currencies.${code}`);
  }

  const entries: StorePriceEntry[] = [];
  for (const [key, value] of Object.entries(rawEntries)) {
    if (typeof value !== 'object') throw new StoreSheetError('shape', `entries.${key} is not an object`);
    const itemLink = stringField(value, 'item_link', `entries.${key}`);
    const categoryTags = stringField(value, 'category_tags', `entries.${key}`);
    const prices = priceMap(objectField(value, 'prices', `entries.${key}`), `entries.${key}.prices`);
    const entry: StorePriceEntry = { key, itemLink, categoryTags, prices };
    if ('sale_prices' in value) {
      entry.salePrices = priceMap(objectField(value, 'sale_prices', `entries.${key}`), `entries.${key}.sale_prices`);
    }
    entries.push(entry);
  }
  return { version, currencies, entries };
}

function objectField(node: KeyValuesNode, key: string, path: string): KeyValuesNode {
  const value = node[key];
  if (value === undefined || typeof value !== 'object') throw new StoreSheetError('shape', `${path}.${key} is missing or not an object`);
  return value;
}

function stringField(node: KeyValuesNode, key: string, path: string): string {
  const value = node[key];
  if (typeof value !== 'string') throw new StoreSheetError('shape', `${path}.${key} is missing or not a string`);
  return value;
}

function priceMap(node: KeyValuesNode, path: string): Record<string, number> {
  const prices: Record<string, number> = {};
  for (const [code, value] of Object.entries(node)) {
    const cents = integerLeaf(value, `${path}.${code}`);
    if (cents < 0) throw new StoreSheetError('shape', `${path}.${code} is negative`);
    prices[code] = cents;
  }
  return prices;
}

function integerLeaf(value: KeyValuesNode | KeyValuesLeaf, path: string): number {
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new StoreSheetError('shape', `${path} is not an integer`);
    return value;
  }
  if (typeof value === 'bigint') {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new StoreSheetError('shape', `${path} does not fit a safe integer`);
    }
    return Number(value);
  }
  throw new StoreSheetError('shape', `${path} is not a number`);
}

/** The whole pipeline, for the adapter and the probe alike. */
export async function decodePriceSheet(container: Buffer, version: number): Promise<StorePriceSheet> {
  const bytes = await decodeValveLzma(container);
  const tree = parseBinaryKeyValues(bytes);
  return parsePriceSheet(tree, version);
}

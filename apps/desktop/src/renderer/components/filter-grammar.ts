/**
 * The filter bar's grammar: typed tokens become chips.
 *
 * Modelled on CSFloat's `/search` spotlight — tokenise on spaces, run every matcher over the
 * tokens in parallel, let the strong (keyword) matches consume their span first, and make the
 * chips, never the raw string, the query. Two things CSFloat does not have are here: a float
 * predicate (`f > 0.15`) and a **normalised** float predicate (`nf > 0.9`), where the normalised
 * float is where an item sits inside its own skin's range.
 *
 * The split of labour is the important part. Everything this file can decide alone — a wear tier,
 * a float bound, a seed, a location, a lock — becomes a number or an enum on the engine filter.
 * Everything that needs to know what an item is *called* — an item, a collection, a rarity, a
 * normalised float, which needs float ranges — stays a chip and is resolved by the host against
 * the catalogue. No name ever reaches the engine.
 *
 * Storage units and accounts are the third kind of name: ones the user chose, which the window
 * already holds. They resolve here, against the scope's own list, into a `casketId` and a narrower
 * `accountIds` — so they never travel to the host as names either.
 */

export type ChipOperator = '>' | '>=' | '<' | '<=' | '=';
export type ChipKind = 'item' | 'name' | 'wear' | 'float' | 'norm' | 'seed' | 'category' | 'rarity' | 'collection' | 'where' | 'tradable' | 'lock' | 'unit' | 'account';

export type FilterChip = {
  kind: ChipKind;
  /** What the user typed or picked, folded. The host resolves the catalogue-shaped kinds by it. */
  text: string;
  minWear?: number;
  maxWear?: number;
  op?: ChipOperator;
  value?: number;
  quality?: 'stattrak' | 'souvenir' | 'normal';
  rarityId?: string;
  location?: 'MAIN' | 'CASKET';
  /** A `where` chip that asks for listed holdings. Listed is not a place: a listed item is in main inventory. */
  listed?: boolean;
  lock?: 'market' | 'trade';
  /** An `account` chip's account, or the account that owns a `unit` chip's storage unit. */
  accountId?: string;
  casketId?: string;
};

/** `=` on a float is a tolerance, never an equality: the stored wear is a 32-bit float. */
export const FLOAT_TOLERANCE = 0.0005;

/**
 * Only one of these may be in the bar at a time, so a second one replaces the first.
 *
 * CSFloat's `filterConflictingResults` does the same. Two wear tiers or two locations would be a
 * contradiction rather than a narrowing, and silently returning nothing is a worse answer than
 * replacing. Float and normalised-float chips are deliberately absent: those *intersect*, because
 * `f>0.1 f<0.2` is a band and means exactly what it looks like.
 */
const EXCLUSIVE: ReadonlySet<ChipKind> = new Set<ChipKind>(['wear', 'where', 'unit', 'tradable', 'lock', 'seed', 'category']);

/**
 * A storage unit is a location, only a narrower one, so the two share one slot. "In this unit"
 * beside "In inventory" is a contradiction, and beside "In storage" it says the same thing twice.
 */
function slotOf(kind: ChipKind): ChipKind {
  return kind === 'unit' ? 'where' : kind;
}

export const WEAR_TIERS: ReadonlyArray<{ code: string; label: string; min: number; max: number; tokens: readonly string[] }> = [
  { code: 'FN', label: 'Factory New', min: 0, max: 0.07, tokens: ['fn', 'factory new', 'factorynew'] },
  { code: 'MW', label: 'Minimal Wear', min: 0.07, max: 0.15, tokens: ['mw', 'minimal wear', 'minimalwear'] },
  { code: 'FT', label: 'Field-Tested', min: 0.15, max: 0.38, tokens: ['ft', 'field tested', 'field-tested', 'fieldtested'] },
  { code: 'WW', label: 'Well-Worn', min: 0.38, max: 0.45, tokens: ['ww', 'well worn', 'well-worn', 'wellworn'] },
  { code: 'BS', label: 'Battle-Scarred', min: 0.45, max: 1, tokens: ['bs', 'battle scarred', 'battle-scarred', 'battlescarred'] }
];

const FLOAT_KEYWORDS = ['float', 'fl', 'f'];
const NORM_KEYWORDS = ['nfloat', 'normfloat', 'normalised', 'normalized', 'nf', 'norm'];
const SEED_KEYWORDS = ['seed', 'pattern', 'paintseed'];
/**
 * Where a holding is, or that it is listed. Two questions on one chip kind, because a person asks
 * them the same way, but never one answer: a listed item is in main inventory, so "inv listed" is
 * every listed item and "storage listed" is nothing.
 */
const WHERE: ReadonlyArray<({ location: 'MAIN' | 'CASKET' } | { listed: true }) & { tokens: readonly string[] }> = [
  { location: 'MAIN', tokens: ['inv', 'inventory'] },
  { location: 'CASKET', tokens: ['storage', 'stored', 'crated', 'unit'] },
  { listed: true, tokens: ['listed', 'market'] }
];

/** A `WHERE` entry's answer, without its tokens. */
function whereOf(entry: (typeof WHERE)[number]): Pick<FilterChip, 'location' | 'listed'> {
  return 'listed' in entry ? { listed: true } : { location: entry.location };
}
const QUALITY: ReadonlyArray<{ quality: 'stattrak' | 'souvenir' | 'normal'; tokens: readonly string[] }> = [
  // `fold` is NFKD, so 'StatTrak™' arrives here as 'stattraktm'. The folded form is the one
  // that has to be in the list; the pretty one would never match a token.
  { quality: 'stattrak', tokens: ['st', 'stat', 'stattrak', 'stat trak', 'stattraktm'] },
  { quality: 'souvenir', tokens: ['souv', 'souvenir'] },
  { quality: 'normal', tokens: ['normal'] }
];
const LOCKS: ReadonlyArray<{ lock: 'market' | 'trade'; tokens: readonly string[] }> = [
  { lock: 'market', tokens: ['market-locked', 'marketlocked', 'market locked'] },
  { lock: 'trade', tokens: ['trade-protected', 'tradeprotected', 'trade protected', 'locked'] }
];
const RARITIES: ReadonlyArray<{ name: string; tokens: readonly string[] }> = [
  { name: 'Consumer Grade', tokens: ['consumer'] },
  { name: 'Industrial Grade', tokens: ['industrial'] },
  { name: 'Mil-Spec Grade', tokens: ['milspec', 'mil-spec', 'mil spec'] },
  { name: 'Restricted', tokens: ['restricted'] },
  { name: 'Classified', tokens: ['classified'] },
  { name: 'Covert', tokens: ['covert'] },
  { name: 'Contraband', tokens: ['contraband'] }
];

export function fold(value: string): string {
  return value.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/★/g, ' ').toLowerCase().trim();
}

/** Tokens, plus the spans a matcher may claim. Empty tokens are dropped, as CSFloat does. */
export function tokenise(text: string): string[] {
  return fold(text).split(/\s+/).filter(Boolean);
}

const OPERATOR = /^(>=|<=|>|<|=)$/;
const NUMBER = /^\d*\.?\d+$/;
const RANGE = /^(\d*\.?\d+)-(\d*\.?\d+)$/;
/** `f>0.15` in one token, or `#661`. Splitting here is what lets operators be typed either way. */
const GLUED = /^([a-z#]+)(>=|<=|>|<|=)?(\d*\.?\d+)?$/;

type Claim = { chip: FilterChip; length: number };

/**
 * One parse of a whole string into chips.
 *
 * Strong forms are tried first and consume their span, so `awp fn f>0.05` gives a wear chip and a
 * float chip and leaves only `awp` for the host's name matcher — the item matcher never eats `fn`.
 * Whatever no matcher claims comes back as `unclaimed`, which the bar keeps as one name chip so
 * it never does less than the plain search box it replaces.
 */
export function parse(text: string): { chips: FilterChip[]; unclaimed: string[] } {
  const tokens = tokenise(text);
  const chips: FilterChip[] = [];
  const unclaimed: string[] = [];
  let index = 0;
  while (index < tokens.length) {
    const claim = claimAt(tokens, index);
    if (claim) {
      chips.push(claim.chip);
      index += claim.length;
    } else {
      unclaimed.push(tokens[index]!);
      index += 1;
    }
  }
  return { chips, unclaimed };
}

/** The strongest chip starting at `index`, or nothing. Order here *is* the precedence in §9.2. */
function claimAt(tokens: readonly string[], index: number): Claim | null {
  return claimFloat(tokens, index)
    ?? claimNorm(tokens, index)
    ?? claimSeed(tokens, index)
    ?? claimWear(tokens, index)
    ?? claimQuality(tokens, index)
    ?? claimLock(tokens, index)
    ?? claimWhere(tokens, index)
    ?? claimRarity(tokens, index);
}

/** `keyword op number` across one, two or three tokens; returns the span length it consumed. */
function readPredicate(tokens: readonly string[], index: number, keywords: readonly string[]): { op: ChipOperator; value: number; length: number } | null {
  const head = tokens[index];
  if (head === undefined) return null;
  const glued = GLUED.exec(head);
  const keyword = glued?.[1];
  if (!keyword || !keywords.includes(keyword)) return null;

  // `f>0.15` — everything in one token.
  if (glued[2] && glued[3] !== undefined) return { op: glued[2] as ChipOperator, value: Number(glued[3]), length: 1 };
  // `f> 0.15` — the operator glued to the keyword, the number after it.
  if (glued[2] && tokens[index + 1] && NUMBER.test(tokens[index + 1]!)) return { op: glued[2] as ChipOperator, value: Number(tokens[index + 1]), length: 2 };
  // `f > 0.15` — three tokens.
  const next = tokens[index + 1];
  if (next && OPERATOR.test(next) && tokens[index + 2] && NUMBER.test(tokens[index + 2]!)) {
    return { op: next as ChipOperator, value: Number(tokens[index + 2]), length: 3 };
  }
  // `f >0.15` — the operator glued to the number.
  if (next) {
    const tail = /^(>=|<=|>|<|=)(\d*\.?\d+)$/.exec(next);
    if (tail) return { op: tail[1] as ChipOperator, value: Number(tail[2]), length: 2 };
  }
  return null;
}

function claimFloat(tokens: readonly string[], index: number): Claim | null {
  const head = tokens[index]!;
  // A bare range, `0.15-0.38`, and a bare comparison, `<0.07`, are both forms CSFloat accepts.
  const range = RANGE.exec(head);
  if (range) {
    const min = Number(range[1]);
    const max = Number(range[2]);
    if (inUnit(min) && inUnit(max) && min <= max) {
      return { chip: { kind: 'float', text: `${min}-${max}`, minWear: min, maxWear: max }, length: 1 };
    }
  }
  const bare = /^(>=|<=|>|<)(\d*\.?\d+)$/.exec(head);
  if (bare && inUnit(Number(bare[2]))) return { chip: floatChip(bare[1] as ChipOperator, Number(bare[2])), length: 1 };

  const read = readPredicate(tokens, index, FLOAT_KEYWORDS);
  if (!read || !inUnit(read.value)) return null;
  return { chip: floatChip(read.op, read.value), length: read.length };
}

/**
 * `norm` is ambiguous and the operator decides it.
 *
 * `norm` followed by an operator or a number is the normalised float; bare `norm` is the Normal
 * category, which is what CSFloat means by it. The suggestion list shows both readings while the
 * word is still being typed, so the choice is visible rather than guessed.
 */
function claimNorm(tokens: readonly string[], index: number): Claim | null {
  const read = readPredicate(tokens, index, NORM_KEYWORDS);
  if (read && inUnit(read.value)) {
    return { chip: { kind: 'norm', text: `${tokens[index]} ${read.op} ${read.value}`.replace(/\s+/g, ' '), op: read.op, value: read.value }, length: read.length };
  }
  // `norm 0.1` — a bare number after the keyword still reads as the predicate, with `=`.
  const head = tokens[index];
  const next = tokens[index + 1];
  if (head && NORM_KEYWORDS.includes(head) && next && NUMBER.test(next) && inUnit(Number(next))) {
    return { chip: { kind: 'norm', text: `${head} = ${next}`, op: '=', value: Number(next) }, length: 2 };
  }
  return null;
}

function claimSeed(tokens: readonly string[], index: number): Claim | null {
  const head = tokens[index]!;
  const hash = /^#(\d+)$/.exec(head);
  if (hash) return seedChip(Number(hash[1]), 1);
  if (SEED_KEYWORDS.includes(head)) {
    const next = tokens[index + 1];
    if (next && /^\d+$/.test(next)) return seedChip(Number(next), 2);
    return null;
  }
  // A bare integer with no operator is a pattern index, which is CSFloat's rule. A bare decimal
  // is not: that is a float, and `claimFloat` has already had its turn.
  if (/^\d+$/.test(head)) return seedChip(Number(head), 1);
  return null;
}

function claimWear(tokens: readonly string[], index: number): Claim | null {
  const one = tokens[index]!;
  const two = tokens[index + 1] ? `${one} ${tokens[index + 1]}` : '';
  for (const tier of WEAR_TIERS) {
    if (two && tier.tokens.includes(two)) return { chip: wearChip(tier), length: 2 };
    if (tier.tokens.includes(one)) return { chip: wearChip(tier), length: 1 };
  }
  return null;
}

function claimQuality(tokens: readonly string[], index: number): Claim | null {
  const one = tokens[index]!;
  const two = tokens[index + 1] ? `${one} ${tokens[index + 1]}` : '';
  for (const entry of QUALITY) {
    if (two && entry.tokens.includes(two)) return { chip: { kind: 'category', text: entry.quality, quality: entry.quality }, length: 2 };
    if (entry.tokens.includes(one)) return { chip: { kind: 'category', text: entry.quality, quality: entry.quality }, length: 1 };
  }
  // Bare `norm` is the Normal category; `norm >` was already claimed as a predicate above.
  if (one === 'norm') return { chip: { kind: 'category', text: 'normal', quality: 'normal' }, length: 1 };
  return null;
}

function claimLock(tokens: readonly string[], index: number): Claim | null {
  const one = tokens[index]!;
  const two = tokens[index + 1] ? `${one} ${tokens[index + 1]}` : '';
  for (const entry of LOCKS) {
    if (two && entry.tokens.includes(two)) return { chip: { kind: 'lock', text: entry.lock, lock: entry.lock }, length: 2 };
    if (entry.tokens.includes(one)) return { chip: { kind: 'lock', text: entry.lock, lock: entry.lock }, length: 1 };
  }
  if (one === 'tradable') return { chip: { kind: 'tradable', text: 'tradable' }, length: 1 };
  return null;
}

function claimWhere(tokens: readonly string[], index: number): Claim | null {
  const one = tokens[index]!;
  for (const entry of WHERE) {
    if (entry.tokens.includes(one)) return { chip: { kind: 'where', text: one, ...whereOf(entry) }, length: 1 };
  }
  return null;
}

function claimRarity(tokens: readonly string[], index: number): Claim | null {
  const one = tokens[index]!;
  const two = tokens[index + 1] ? `${one} ${tokens[index + 1]}` : '';
  for (const entry of RARITIES) {
    if (two && entry.tokens.includes(two)) return { chip: { kind: 'rarity', text: entry.name }, length: 2 };
    if (entry.tokens.includes(one)) return { chip: { kind: 'rarity', text: entry.name }, length: 1 };
  }
  return null;
}

function inUnit(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function floatChip(op: ChipOperator, value: number): FilterChip {
  const chip: FilterChip = { kind: 'float', text: `${op} ${value}`, op, value };
  if (op === '>' || op === '>=') chip.minWear = value;
  else if (op === '<' || op === '<=') chip.maxWear = value;
  else { chip.minWear = Math.max(0, value - FLOAT_TOLERANCE); chip.maxWear = Math.min(1, value + FLOAT_TOLERANCE); }
  return chip;
}

function seedChip(value: number, length: number): Claim | null {
  if (!Number.isInteger(value) || value < 0 || value > 1000) return null;
  return { chip: { kind: 'seed', text: String(value), value }, length };
}

function wearChip(tier: (typeof WEAR_TIERS)[number]): FilterChip {
  return { kind: 'wear', text: tier.code.toLowerCase(), minWear: tier.min, maxWear: tier.max };
}

/**
 * Add a chip, replacing rather than conflicting where the kind is exclusive.
 *
 * A draft may be just a kind and a text — which is how the Location select and the "Tradable
 * only" pill add chips. They go through the same grammar as typing does, so there is one filter
 * model rather than two that can disagree.
 */
export function addChip(chips: readonly FilterChip[], draft: FilterChip | { kind: ChipKind; text: string }): FilterChip[] {
  const chip = 'minWear' in draft || 'op' in draft || 'quality' in draft || 'location' in draft || 'lock' in draft || 'rarityId' in draft
    || 'accountId' in draft || 'casketId' in draft
    ? draft as FilterChip
    : completeChip(draft.kind, draft.text);
  const kept = withoutOwnerConflict(
    EXCLUSIVE.has(chip.kind) ? chips.filter((existing) => slotOf(existing.kind) !== slotOf(chip.kind)) : chips,
    chip
  );
  // The same chip twice is one chip, whatever the kind. Two units or accounts can share a name, so
  // the ids take part in "the same".
  if (kept.some((existing) => existing.kind === chip.kind && existing.text === chip.text
    && existing.accountId === chip.accountId && existing.casketId === chip.casketId)) return [...kept];
  return [...kept, chip];
}

/**
 * A unit belongs to exactly one account, so a unit chip and account chips that leave its owner out
 * are a contradiction. The newer chip wins, as it does for every exclusive kind: naming a unit on
 * another account drops the account chips, and naming an account drops a unit it does not own.
 */
function withoutOwnerConflict(chips: readonly FilterChip[], added: FilterChip): FilterChip[] {
  if (added.kind === 'unit' && added.accountId) {
    const accounts = chips.filter((chip) => chip.kind === 'account');
    return accounts.length > 0 && !accounts.some((chip) => chip.accountId === added.accountId)
      ? chips.filter((chip) => chip.kind !== 'account')
      : [...chips];
  }
  if (added.kind === 'account') {
    const owners = new Set([...chips.filter((chip) => chip.kind === 'account').map((chip) => chip.accountId), added.accountId]);
    return chips.filter((chip) => !(chip.kind === 'unit' && !owners.has(chip.accountId)));
  }
  return [...chips];
}

/**
 * A suggestion that finishes what is being typed rather than adding a chip: `fill` replaces the
 * box's text, and the person types the number it still needs.
 */
export type Completion = { kind: ChipKind; label: string; fill: string; detail: string };

/**
 * The predicates, which need a number before they are a chip. Each offers its forms as soon as its
 * keyword is recognisable, so `f` or `flo` already shows Float below and Float above, rather than
 * nothing until `float>0` parses.
 */
const PREDICATES: ReadonlyArray<{
  kind: 'float' | 'norm' | 'seed';
  keywords: readonly string[];
  /** The keyword a filled form is written with. */
  word: string;
  /** What is still to type, once the keyword and any operator are there. */
  wanted: string;
  forms: ReadonlyArray<{ op?: ChipOperator; label: string; example: string }>;
}> = [
  {
    kind: 'float', keywords: FLOAT_KEYWORDS, word: 'float', wanted: 'Type a float from 0 to 1',
    forms: [
      { op: '<', label: 'Float below …', example: 'float < 0.07' },
      { op: '>', label: 'Float above …', example: 'float > 0.38' },
      { op: '=', label: 'Float about …', example: 'float = 0.15' }
    ]
  },
  {
    kind: 'norm', keywords: NORM_KEYWORDS, word: 'nf', wanted: 'Type a normalised float from 0 to 1',
    forms: [
      { op: '<', label: 'Normalised float below …', example: 'nf < 0.01 is the top 1 % of its range' },
      { op: '>', label: 'Normalised float above …', example: 'nf > 0.99 is the bottom 1 %' },
      { op: '=', label: 'Normalised float about …', example: 'nf = 0.5 is the middle of its range' }
    ]
  },
  {
    kind: 'seed', keywords: SEED_KEYWORDS, word: 'seed', wanted: 'Type a pattern from 0 to 1000',
    forms: [{ label: 'Pattern …', example: 'seed 661, or #661' }]
  }
];

/** The word filters, which are chips the moment their word is recognised. */
const WORDS: ReadonlyArray<{ tokens: readonly string[]; chip: FilterChip }> = [
  ...WEAR_TIERS.map((tier) => ({ tokens: tier.tokens, chip: wearChip(tier) })),
  ...QUALITY.map((entry) => ({ tokens: entry.tokens, chip: { kind: 'category' as const, text: entry.quality, quality: entry.quality } })),
  ...WHERE.map((entry) => ({ tokens: entry.tokens, chip: { kind: 'where' as const, text: entry.tokens[0]!, ...whereOf(entry) } })),
  ...LOCKS.map((entry) => ({ tokens: entry.tokens, chip: { kind: 'lock' as const, text: entry.lock, lock: entry.lock } })),
  { tokens: ['tradable'], chip: { kind: 'tradable', text: 'tradable' } }
];

/**
 * What the word being typed could become, before it parses as anything.
 *
 * `parse` only claims a finished token, so on its own the bar is silent until a filter is typed in
 * full. This looks at the tail of the text and offers three things:
 *
 *  - **A predicate's forms** while its keyword is typed or half typed (`f`, `flo`, `float`, `nf`,
 *    `pat`), each filling the box with the keyword and its operator.
 *  - **What a predicate still needs** once the operator is there but the number is not (`float >`,
 *    `f<=`, `nf < 0.`), so Enter does not turn the half-typed predicate into a name search.
 *  - **A word filter** whose word is half typed (`fact`, `factory n`, `sto`, `statt`), as its chip.
 *
 * A one-letter word only completes when it is a keyword itself, as `f` is: a single letter begins
 * too many words to mean any of them. A filter `parse` already offers is not offered again, so `st`
 * is StatTrak once, with In storage after it.
 */
export function completions(text: string): { chips: FilterChip[]; fills: Completion[] } {
  const tokens = tokenise(text);
  if (tokens.length === 0) return { chips: [], fills: [] };
  const finished = /\s$/.test(text);

  // A keyword and an operator, the number still to come. Up to three tokens, because the three
  // parts may each have been typed with or without spaces.
  for (const span of [3, 2, 1]) {
    if (tokens.length < span) continue;
    const tail = /^([a-z]+)(>=|<=|>|<|=)(\d*\.?)$/.exec(tokens.slice(-span).join(''));
    if (!tail || NUMBER.test(tail[3]!)) continue;
    const predicate = PREDICATES.find((entry) => entry.forms.some((form) => form.op) && entry.keywords.includes(tail[1]!));
    if (!predicate) continue;
    const op = tail[2] as ChipOperator;
    const form = predicate.forms.find((entry) => entry.op === (op === '>=' ? '>' : op === '<=' ? '<' : op)) ?? predicate.forms[0]!;
    return { chips: [], fills: [{ kind: predicate.kind, label: form.label, fill: text, detail: predicate.wanted }] };
  }

  const last = tokens.at(-1)!;
  const before = tokens.slice(0, -1);
  const fills: Completion[] = [];
  for (const predicate of PREDICATES) {
    const exact = predicate.keywords.includes(last);
    const partial = !finished && last.length >= 2 && predicate.keywords.some((keyword) => keyword.startsWith(last));
    if (!exact && !partial) continue;
    for (const form of predicate.forms) {
      fills.push({
        kind: predicate.kind,
        label: form.label,
        fill: `${[...before, form.op ? `${predicate.word} ${form.op}` : predicate.word].join(' ')} `,
        detail: form.example
      });
    }
  }

  // What `parse` already offers is not offered twice: `st` is StatTrak there, and In storage here.
  const offered = new Set(parse(text).chips.map(filterKey));
  const chips: FilterChip[] = [];
  for (const span of [2, 1]) {
    if (tokens.length < span) continue;
    const typed = tokens.slice(-span).join(' ');
    if (typed.length < 2) continue;
    const prefix = finished ? `${typed} ` : typed;
    for (const word of WORDS) {
      const key = filterKey(word.chip);
      if (offered.has(key) || !word.tokens.some((token) => token.startsWith(prefix))) continue;
      offered.add(key);
      chips.push(word.chip);
    }
  }
  return { chips, fills };
}

/** What a chip filters by, so two chips that ask the same question are one suggestion. */
function filterKey(chip: FilterChip): string {
  const by = chip.kind === 'where' ? (chip.listed ? 'listed' : chip.location) : chip.quality ?? chip.lock ?? chip.text;
  return `${chip.kind}:${by ?? chip.text}`;
}

export function removeChip(chips: readonly FilterChip[], index: number): FilterChip[] {
  return chips.filter((_, position) => position !== index);
}

/** Fill in the parts of a chip its kind implies, so a kind-and-text draft is a complete chip. */
export function completeChip(kind: ChipKind, text: string): FilterChip {
  const folded = fold(text);
  if (kind === 'where') {
    const entry = WHERE.find((row) => row.tokens.includes(folded));
    return { kind, text: folded, ...(entry ? whereOf(entry) : {}) };
  }
  if (kind === 'wear') {
    const tier = WEAR_TIERS.find((row) => row.tokens.includes(folded) || row.code.toLowerCase() === folded);
    return tier ? wearChip(tier) : { kind, text: folded };
  }
  if (kind === 'lock') {
    const entry = LOCKS.find((row) => row.tokens.includes(folded) || row.lock === folded);
    return { kind, text: folded, ...(entry ? { lock: entry.lock } : {}) };
  }
  if (kind === 'category') {
    const entry = QUALITY.find((row) => row.tokens.includes(folded) || row.quality === folded);
    return { kind, text: folded, ...(entry ? { quality: entry.quality } : {}) };
  }
  if (kind === 'seed') return { kind, text: folded, value: Number(folded) };
  // `item`, `name`, `rarity` and `collection` keep the text they were given: only the host, which
  // holds the catalogue, can turn any of them into identity keys. A `unit` or `account` draft with
  // no id stays inert — `ownedSuggestions` is the only thing that knows which one a name means.
  return { kind, text: text.trim() };
}

export type ScopeAccount = { id: string; name: string };
export type ScopeUnit = { accountId: string; casketId: string; label: string | null };

/** How many units and how many accounts the bar offers for one string. */
const OWNED_LIMIT = 5;

/**
 * Storage units and accounts whose name the typed text is part of, as ready chips.
 *
 * These are names the user chose, so a match is almost always meant, and the bar offers them ahead
 * of the catalogue. An exact name ranks first, then a prefix, then anything containing the text; a
 * single character only matches a prefix, or every account with an `a` in it would be offered.
 *
 * The whole string is tried, and so is whatever the grammar leaves unclaimed — `knives ft` still
 * finds the unit called Knives, while a unit called `Storage 1` is still found by its full name
 * even though the grammar reads both of its words as filters.
 */
export function ownedSuggestions(text: string, scope: { accounts: readonly ScopeAccount[]; units: readonly ScopeUnit[] }): {
  units: FilterChip[];
  accounts: FilterChip[];
} {
  const whole = tokenise(text).join(' ');
  const remainder = parse(text).unclaimed.join(' ');
  const needles = [...new Set([whole, remainder])].filter(Boolean);
  const rank = (name: string): number | null => {
    const hay = tokenise(name).join(' ');
    let best: number | null = null;
    for (const needle of needles) {
      const score = hay === needle ? 0 : hay.startsWith(needle) ? 1 : needle.length > 1 && hay.includes(needle) ? 2 : null;
      if (score !== null && (best === null || score < best)) best = score;
    }
    return best;
  };
  const ranked = <T>(rows: readonly T[], name: (row: T) => string | null): T[] => rows
    .flatMap((row, index) => {
      const label = name(row);
      const score = label ? rank(label) : null;
      return score === null ? [] : [{ row, score, index }];
    })
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .slice(0, OWNED_LIMIT)
    .map((entry) => entry.row);

  return {
    units: ranked(scope.units, (unit) => unit.label).map((unit) => ({
      kind: 'unit', text: unit.label!, accountId: unit.accountId, casketId: unit.casketId
    })),
    accounts: ranked(scope.accounts, (account) => account.name).map((account) => ({
      kind: 'account', text: account.name, accountId: account.id
    }))
  };
}

/**
 * Which of the scope's accounts the chips leave.
 *
 * An account chip is not an engine predicate: every read is already asked per account, so naming
 * one narrows the request's `accountIds` instead. Account chips union — naming two accounts shows
 * both. A chip for an account outside the scope is ignored rather than read as "no account", so
 * the answer is never empty while the scope is not: the sidebar can change under a chip.
 */
export function chipAccounts(chips: readonly FilterChip[], scope: readonly string[]): string[] {
  const named = new Set(chips.flatMap((chip) => (chip.kind === 'account' && chip.accountId && scope.includes(chip.accountId) ? [chip.accountId] : [])));
  return named.size > 0 ? scope.filter((id) => named.has(id)) : [...scope];
}

/**
 * The chips, as a filter.
 *
 * Two halves, and they never mix. Numbers and enums go straight to the engine. Catalogue-shaped
 * chips travel as `chips` for the host's mediator to resolve into `matchKeys` and `wearBands` —
 * so what finally reaches the engine carries keys and ranges and no name at all.
 *
 * Account chips are absent from both halves on purpose. They narrow which accounts are asked, not
 * what is asked of them; `chipAccounts` is their half.
 */
export function chipsToFilter(chips: readonly FilterChip[]): {
  location?: 'MAIN' | 'CASKET';
  listed?: boolean;
  casketId?: string;
  tradableOnly?: boolean;
  minWear?: number;
  maxWear?: number;
  paintSeed?: number;
  lock?: 'market' | 'trade';
  chips: Array<{ kind: string; text: string; rarityId?: string; quality?: string; op?: ChipOperator; value?: number }>;
} {
  let minWear: number | undefined;
  let maxWear: number | undefined;
  let paintSeed: number | undefined;
  let location: 'MAIN' | 'CASKET' | undefined;
  let listed: boolean | undefined;
  let casketId: string | undefined;
  let lock: 'market' | 'trade' | undefined;
  let tradableOnly: boolean | undefined;
  const hostChips: Array<{ kind: string; text: string; rarityId?: string; quality?: string; op?: ChipOperator; value?: number }> = [];

  for (const chip of chips) {
    switch (chip.kind) {
      case 'wear':
      case 'float':
        // Float chips intersect: `f>0.1 f<0.2` is a band, and a wear tier is the same thing said
        // in one word. Taking the tighter bound on each side is what makes that true.
        if (chip.minWear !== undefined) minWear = minWear === undefined ? chip.minWear : Math.max(minWear, chip.minWear);
        if (chip.maxWear !== undefined) maxWear = maxWear === undefined ? chip.maxWear : Math.min(maxWear, chip.maxWear);
        break;
      case 'seed':
        if (chip.value !== undefined) paintSeed = chip.value;
        break;
      case 'where':
        if (chip.listed) listed = true;
        else if (chip.location) { location = chip.location; casketId = undefined; }
        break;
      case 'unit':
        // A unit is in storage by definition, and the engine already filters by `casketId`. Saying
        // the location too is what lets the Location select show where the bar is looking.
        if (chip.casketId) { location = 'CASKET'; casketId = chip.casketId; }
        break;
      case 'lock':
        if (chip.lock) lock = chip.lock;
        break;
      case 'tradable':
        tradableOnly = true;
        break;
      case 'norm':
        if (chip.op && chip.value !== undefined) hostChips.push({ kind: 'norm', text: chip.text, op: chip.op, value: chip.value });
        break;
      case 'category':
        if (chip.quality) hostChips.push({ kind: 'category', text: chip.text, quality: chip.quality });
        break;
      case 'rarity':
        hostChips.push({ kind: 'rarity', text: chip.text, ...(chip.rarityId ? { rarityId: chip.rarityId } : {}) });
        break;
      case 'item':
      case 'name':
      case 'collection':
        hostChips.push({ kind: chip.kind, text: chip.text });
        break;
    }
  }

  return {
    ...(location ? { location } : {}),
    ...(listed ? { listed } : {}),
    ...(casketId ? { casketId } : {}),
    ...(tradableOnly ? { tradableOnly } : {}),
    ...(minWear !== undefined ? { minWear } : {}),
    ...(maxWear !== undefined ? { maxWear } : {}),
    ...(paintSeed !== undefined ? { paintSeed } : {}),
    ...(lock ? { lock } : {}),
    chips: hostChips
  };
}

/**
 * The chips a Listings bar can hold: the inventory's, less every question a listed item cannot
 * answer. It is at the venue by definition, so it has no location, no storage unit and no lock
 * worth asking about, and a bar that offered them would offer filters that match nothing.
 */
export const LISTING_CHIP_KINDS: ReadonlySet<ChipKind> = new Set<ChipKind>([
  'item', 'name', 'wear', 'float', 'norm', 'seed', 'category', 'rarity', 'collection', 'account'
]);

/**
 * The chips a Buy orders bar can hold: the Listings bar's, less the normalised float. An order is
 * for a market name, so main answers every other chip from what the order would buy — its skin's
 * type, rarity and collection, its StatTrak or Souvenir, the wear in its name and the float range
 * it sets, the patterns it names, the stickers and charms it requires. A normalised float needs
 * one item's own float range, and an order has none.
 */
export const BUY_ORDER_CHIP_KINDS: ReadonlySet<ChipKind> = new Set<ChipKind>([
  'item', 'name', 'wear', 'float', 'seed', 'category', 'rarity', 'collection', 'account'
]);

/**
 * The chips, as a listings filter — or a buy-order one, which is the same shape over fewer kinds.
 *
 * `chipsToFilter`, less the kinds `kinds` leaves out, and with one change of hands: a typed name
 * goes as `search`, because a listing or an order carries the venue's own name for its item and a
 * listing or order number is typed the same way. Everything else is the inventory's half for half
 * — numbers straight through, catalogue chips to the host.
 */
export function chipsToListingFilter(chips: readonly FilterChip[], kinds: ReadonlySet<ChipKind> = LISTING_CHIP_KINDS): {
  minWear?: number;
  maxWear?: number;
  paintSeed?: number;
  search?: string[];
  chips?: Array<{ kind: string; text: string; rarityId?: string; quality?: string; op?: ChipOperator; value?: number }>;
} {
  const { minWear, maxWear, paintSeed, chips: host } = chipsToFilter(chips.filter((chip) => kinds.has(chip.kind)));
  const search = host.filter((chip) => chip.kind === 'name').map((chip) => chip.text);
  const resolved = host.filter((chip) => chip.kind !== 'name');
  return {
    ...(minWear !== undefined ? { minWear } : {}),
    ...(maxWear !== undefined ? { maxWear } : {}),
    ...(paintSeed !== undefined ? { paintSeed } : {}),
    ...(search.length ? { search } : {}),
    ...(resolved.length ? { chips: resolved } : {})
  };
}

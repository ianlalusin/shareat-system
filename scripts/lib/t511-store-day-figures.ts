/**
 * T-511 slice 1, exit criterion 5 - the pure half of `scripts/t511-read-store-day-figures.ts`.
 *
 * Everything here is a plain function over plain data: no Firestore, no file system, no environment, no
 * network. That is what lets `packages/etl/tests/t511-store-day-figures.test.ts` prove the safety rules without
 * any credential and without a database.
 *
 * What lives here, and why each piece exists:
 *   - `assertReadablePath` - the read guard. The script may read exactly two kinds of v1 collection and nothing
 *     else (the roster of stores, and one store's `salesDays`). Anything else throws before any call is made.
 *   - `makeGuardedReader`  - wraps the repo's read-only v1 client (`makeReadOnlyV1Client`, which already exposes
 *     `collection(path).get()` and nothing else) so every read goes through the guard first.
 *   - `safeFailureLine`    - turns ANY error into one fixed sentence plus a short code. The error's own message is
 *     never used, because a driver can echo part of a credential or a connection string into a message.
 *   - `extractDayFigures` / `formatDayReport` - pick the recorded channel figures out of a v1 sales-day document
 *     and print ONLY figures, ids, dates, the store name and channel names. Names of people, reasons, notes and
 *     every field not listed below are never copied out of the document.
 *
 * v1 field names are used here because they are the real names on the wire (docs/discovery/01-data-model.md);
 * the glossary traps (docs/GLOSSARY.md, tests/unit/glossary-trap-names.test.ts) are deliberately NOT named.
 */
import type { ReadOnlyV1Client } from '../../packages/etl/src/master-data/snapshot';

type Raw = Record<string, unknown>;

/** A refusal whose text is written by this module, so it is safe to print. Nothing else is ever printed verbatim. */
export class SafeRefusal extends Error {
  readonly safe = true as const;
}

// ---------------------------------------------------------------------------------------------------------------
// The read guard
// ---------------------------------------------------------------------------------------------------------------

const ROSTER_PATH = 'stores';
const SALES_DAYS_PATH = /^stores\/[A-Za-z0-9]{8,40}\/salesDays$/;

/** Only `stores` and `stores/<id>/salesDays` may be read. Throws a SafeRefusal for anything else. */
export function assertReadablePath(path: string): void {
  if (path === ROSTER_PATH || SALES_DAYS_PATH.test(path)) return;
  throw new SafeRefusal('Refused: this script may only read the store list and one store\'s salesDays.');
}

export interface V1DocLike {
  id: string;
  data(): Raw;
}

export interface GuardedReader {
  readCollection(path: string): Promise<V1DocLike[]>;
}

/** The only door the script reads through. The client underneath has no write method to call (T-391 R1). */
export function makeGuardedReader(client: ReadOnlyV1Client): GuardedReader {
  return {
    async readCollection(path: string): Promise<V1DocLike[]> {
      assertReadablePath(path);
      const snap = await client.collection(path).get();
      return snap.docs;
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Failure text: never the error's own message
// ---------------------------------------------------------------------------------------------------------------

const SAFE_CODE = /^[A-Za-z0-9_./-]{1,48}$/;

/** One fixed sentence plus the error's code if it has a short, plain one. The message and stack are never read. */
export function safeFailureLine(err: unknown): string {
  if (err instanceof SafeRefusal) return err.message;
  let code = 'unknown';
  if (err !== null && typeof err === 'object') {
    const raw = (err as { code?: unknown }).code;
    if ((typeof raw === 'string' && SAFE_CODE.test(raw)) || typeof raw === 'number') code = String(raw);
  }
  return `The read failed (error code: ${code}). Details are not printed on purpose, so no credential can leak into this output.`;
}

// ---------------------------------------------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------------------------------------------

export interface Options {
  store: string;
  storeId: string | null;
  channels: string[];
  dates: string[];
}

export const DEFAULT_STORE = 'Lipa';
export const DEFAULT_CHANNELS = ['Grab', 'Foodpanda'];
/** The two chosen store-days: 2026-10-12 for both channels, 2026-10-20 as the second Grab day with a discount. */
export const DEFAULT_DATES = ['2026-10-12', '2026-10-20'];

const FLAGS = new Set(['--store', '--store-id', '--channels', '--dates']);

/** A real calendar date, YYYY-MM-DD. */
export function isIsoDate(text: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

export function parseArgs(argv: readonly string[]): Options {
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]!;
    const value = argv[i + 1];
    if (!FLAGS.has(flag)) throw new SafeRefusal(`Unknown argument "${flag.slice(0, 24)}". Allowed: --store, --store-id, --channels, --dates.`);
    if (value === undefined || value.startsWith('--') || value.trim() === '') throw new SafeRefusal(`${flag} needs a value.`);
    values[flag] = value.trim();
  }
  const list = (flag: string, fallback: readonly string[]): string[] => {
    const given = values[flag];
    return given === undefined ? [...fallback] : given.split(',').map((s) => s.trim()).filter(Boolean);
  };
  const dates = list('--dates', DEFAULT_DATES);
  for (const d of dates) if (!isIsoDate(d)) throw new SafeRefusal('Every date must be a real calendar date written YYYY-MM-DD.');
  const channels = list('--channels', DEFAULT_CHANNELS);
  if (channels.length === 0) throw new SafeRefusal('--channels needs at least one name.');
  if (dates.length === 0) throw new SafeRefusal('--dates needs at least one date.');
  const storeId = values['--store-id'] ?? null;
  if (storeId !== null && !/^[A-Za-z0-9]{8,40}$/.test(storeId)) throw new SafeRefusal('--store-id must be a v1 store id (letters and digits).');
  return { store: values['--store'] ?? DEFAULT_STORE, storeId, channels, dates };
}

// ---------------------------------------------------------------------------------------------------------------
// Store and channel selection
// ---------------------------------------------------------------------------------------------------------------

export interface ChannelRef {
  channelId: string;
  name: string;
  isActive: boolean;
  isRemittedDaily: boolean | null;
}

export interface StoreRef {
  id: string;
  name: string;
  channels: ChannelRef[];
}

const squash = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function asChannels(value: unknown): ChannelRef[] {
  if (!Array.isArray(value)) return [];
  const out: ChannelRef[] = [];
  for (const c of value) {
    if (c === null || typeof c !== 'object') continue;
    const r = c as Raw;
    if (typeof r.channelId !== 'string' || typeof r.name !== 'string') continue;
    out.push({
      channelId: r.channelId,
      name: r.name,
      isActive: r.isActive !== false,
      isRemittedDaily: typeof r.isRemittedDaily === 'boolean' ? r.isRemittedDaily : null,
    });
  }
  return out;
}

export function toStoreRef(doc: V1DocLike): StoreRef {
  const d = doc.data();
  return { id: doc.id, name: typeof d.name === 'string' ? d.name : '', channels: asChannels(d.salesChannels) };
}

/** `--store-id` wins; otherwise the name must match exactly one store (whole name first, then part of a name). */
export function pickStore(roster: readonly StoreRef[], opts: Pick<Options, 'store' | 'storeId'>): StoreRef {
  if (opts.storeId !== null) {
    const hit = roster.find((s) => s.id === opts.storeId);
    if (!hit) throw new SafeRefusal('No store has that id.');
    return hit;
  }
  const want = squash(opts.store);
  const exact = roster.filter((s) => squash(s.name) === want);
  const part = roster.filter((s) => squash(s.name).includes(want));
  const hits = exact.length > 0 ? exact : part;
  if (hits.length === 1) return hits[0]!;
  const listing = (hits.length > 0 ? hits : roster).map((s) => `${s.name} (${s.id})`).join('; ');
  throw new SafeRefusal(
    hits.length === 0
      ? `No store name contains "${opts.store.slice(0, 40)}". Stores: ${listing}. Use --store or --store-id.`
      : `More than one store matches "${opts.store.slice(0, 40)}": ${listing}. Use --store-id.`,
  );
}

export interface ChannelMatch {
  pattern: string;
  channels: ChannelRef[];
}

/** Each pattern matches channel names containing it, ignoring capitals, spaces and punctuation ("food panda" = Foodpanda). */
export function matchChannels(store: StoreRef, patterns: readonly string[]): ChannelMatch[] {
  return patterns.map((pattern) => ({
    pattern,
    channels: store.channels.filter((c) => squash(c.name).includes(squash(pattern))),
  }));
}

// ---------------------------------------------------------------------------------------------------------------
// Reading a day
// ---------------------------------------------------------------------------------------------------------------

const VERIFIED_STATES = new Set(['verified', 'partially_remitted', 'remitted']);

/** A number as the document stores it, or undefined. Never throws. */
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Peso text with two decimals; a stored figure that is not a whole number of centavos also shows its raw value. */
export function money(v: number | undefined): string {
  if (v === undefined) return 'absent';
  const text = v.toFixed(2);
  return Math.abs(v * 100 - Math.round(v * 100)) > 1e-6 ? `${text} (raw ${String(v)}, not whole centavos)` : text;
}

function iso(ms: unknown): string | null {
  const n = num(ms);
  if (n === undefined) return null;
  const d = new Date(n);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function breakdownAt(doc: Raw | undefined, channelId: string): number | undefined {
  const b = doc?.salesChannelBreakdown;
  if (b === null || typeof b !== 'object') return undefined;
  return num((b as Raw)[channelId]);
}

function sumBreakdown(doc: Raw): number | undefined {
  const b = doc.salesChannelBreakdown;
  if (b === null || typeof b !== 'object') return undefined;
  let sum = 0;
  let any = false;
  for (const v of Object.values(b as Raw)) {
    const n = num(v);
    if (n !== undefined) {
      sum += n;
      any = true;
    }
  }
  return any ? Math.round(sum * 100) / 100 : undefined;
}

export interface ChannelDayFigures {
  channel: ChannelRef;
  /** salesChannelBreakdown[channelId] on the live document. */
  recorded: number | undefined;
  /** remittedSalesChannelBreakdown[channelId], present only on days a till-remitted channel was split. */
  recordedRemittedPart: number | undefined;
  confirmedNoSales: boolean;
  /** Same channel in preAdjustmentSnapshot: the figure before the first admin correction, if there was one. */
  beforeFirstAdjustment: number | undefined;
}

export interface DayFigures {
  date: string;
  found: boolean;
  status: string | null;
  verified: boolean;
  verifiedAt: string | null;
  hasAdjustments: boolean;
  adjustmentCount: number | undefined;
  totalSales: number | undefined;
  channelBreakdownSum: number | undefined;
  discountColumns: { name: string; value: number | undefined }[];
  legacySummaryFields: { name: string; value: number | undefined }[];
  channels: ChannelDayFigures[];
}

const DISCOUNT_COLUMNS = ['totalDiscounts', 'seniorDiscount', 'pwdDiscount', 'otherDiscount', 'comps'] as const;
const LEGACY_SUMMARY_FIELDS = ['foodpandaSales', 'grabSales', 'otherSales'] as const;

export function extractDayFigures(date: string, doc: V1DocLike | undefined, channels: readonly ChannelRef[]): DayFigures {
  if (!doc) {
    return {
      date,
      found: false,
      status: null,
      verified: false,
      verifiedAt: null,
      hasAdjustments: false,
      adjustmentCount: undefined,
      totalSales: undefined,
      channelBreakdownSum: undefined,
      discountColumns: [],
      legacySummaryFields: [],
      channels: channels.map((channel) => ({ channel, recorded: undefined, recordedRemittedPart: undefined, confirmedNoSales: false, beforeFirstAdjustment: undefined })),
    };
  }
  const d = doc.data();
  const status = typeof d.status === 'string' ? d.status : null;
  const noSales = Array.isArray(d.noSalesChannelIds) ? (d.noSalesChannelIds as unknown[]) : [];
  const snapshot = d.preAdjustmentSnapshot !== null && typeof d.preAdjustmentSnapshot === 'object' ? (d.preAdjustmentSnapshot as Raw) : undefined;
  return {
    date,
    found: true,
    status,
    verified: status !== null && VERIFIED_STATES.has(status),
    verifiedAt: iso(d.verifiedAt),
    hasAdjustments: d.hasAdjustments === true,
    adjustmentCount: num(d.adjustmentCount),
    totalSales: num(d.totalSales),
    channelBreakdownSum: sumBreakdown(d),
    discountColumns: DISCOUNT_COLUMNS.map((name) => ({ name, value: num(d[name]) })),
    legacySummaryFields: LEGACY_SUMMARY_FIELDS.map((name) => ({ name, value: num(d[name]) })),
    channels: channels.map((channel) => ({
      channel,
      recorded: breakdownAt(d, channel.channelId),
      recordedRemittedPart: (() => {
        const r = d.remittedSalesChannelBreakdown;
        return r !== null && typeof r === 'object' ? num((r as Raw)[channel.channelId]) : undefined;
      })(),
      confirmedNoSales: noSales.includes(channel.channelId),
      beforeFirstAdjustment: snapshot ? breakdownAt(snapshot, channel.channelId) : undefined,
    })),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Printing: figures, ids, names. Nothing else.
// ---------------------------------------------------------------------------------------------------------------

export function formatDayReport(day: DayFigures, patternByChannelId: ReadonlyMap<string, string>): string[] {
  const where = `stores/<store id>/salesDays/${day.date}`;
  if (!day.found) return [`Date ${day.date}  ${where}  NOT FOUND (no sales day was recorded for this date in v1)`];
  const lines: string[] = [];
  lines.push(`Date ${day.date}  ${where}  FOUND`);
  lines.push(`  status: ${day.status ?? 'absent'}   verified or later: ${day.verified ? 'yes' : 'no'}   verifiedAt: ${day.verifiedAt ?? 'none'}`);
  lines.push(`  admin adjustments: ${day.hasAdjustments ? `yes (count ${day.adjustmentCount ?? 'unknown'})` : 'no'}`);
  lines.push(`  totalSales ${money(day.totalSales)}   sum of salesChannelBreakdown ${money(day.channelBreakdownSum)}`);
  lines.push(`  discount columns on the day: ${day.discountColumns.map((c) => `${c.name} ${money(c.value)}`).join(', ')}`);
  lines.push(`  legacy summary fields: ${day.legacySummaryFields.map((c) => `${c.name} ${money(c.value)}`).join(', ')}`);
  for (const c of day.channels) {
    const matched = patternByChannelId.get(c.channel.channelId) ?? '?';
    lines.push(`  channel "${c.channel.name}" (channelId ${c.channel.channelId}, matched "${matched}")`);
    lines.push(`    RECORDED salesChannelBreakdown[${c.channel.channelId}] = ${money(c.recorded)}${c.confirmedNoSales ? '   (staff confirmed no sales)' : ''}`);
    if (c.recordedRemittedPart !== undefined) lines.push(`    remittedSalesChannelBreakdown[${c.channel.channelId}] = ${money(c.recordedRemittedPart)}`);
    if (day.hasAdjustments) lines.push(`    before the first admin adjustment (preAdjustmentSnapshot) = ${money(c.beforeFirstAdjustment)}`);
  }
  return lines;
}

export function formatStoreHeader(store: StoreRef, matches: readonly ChannelMatch[]): string[] {
  const lines = [`Store: ${store.name} (v1 store id ${store.id})`];
  for (const m of matches) {
    if (m.channels.length === 0) {
      lines.push(`Channel pattern "${m.pattern}": NO channel name matches. This store's channels: ${store.channels.map((c) => `${c.name} (${c.channelId})`).join('; ') || 'none'}`);
      continue;
    }
    for (const c of m.channels) {
      lines.push(
        `Channel pattern "${m.pattern}": "${c.name}" channelId ${c.channelId}, ${c.isActive ? 'active' : 'RETIRED'}, ` +
          `${c.isRemittedDaily === null ? 'remitted-daily flag absent' : c.isRemittedDaily ? 'remitted daily (till)' : 'not remitted daily (platform settles later)'}`,
      );
    }
    if (m.channels.length > 1) lines.push(`  NOTE: ${m.channels.length} channels match "${m.pattern}"; every one is printed below, compare the one staff use.`);
  }
  return lines;
}

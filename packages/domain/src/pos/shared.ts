/**
 * T-524 - what every POS v2 function shares: the store switch and tablet check (R1), the injectable business-rule reader, the audit writer,
 * the "recorded differently" refusal, and the bill loader that `getSessionBill` and `completeSale` both price from.
 * docs/tasks/524-pos-v2-domain.md.
 */
import { createHash } from 'node:crypto';
import { addDays, parseBusinessDate, toBusinessDate } from '@shareat/core/datetime';
import { accessRepo, auditLogRepo, posV2Repo, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { readPosRules } from '../business-rules/pos-rules';
import { refuse } from '../shared/refusal';
import type { PriceDiscountInput, PriceLineInput, PriceSnapshot } from './price';

// ---------------------------------------------------------------------------------------------------------------------
// Business rules (BOSS ruling 6 Nov): percents travel as basis points (12% = 1200n); the day starts at an integer hour.
// The default reader is `readPosRules` (T-539): `tax.vat_percent`, `pos.senior_pwd_discount_percent` and `pos.business_day_start_hour` from the
// dated business-rule rows (registry defaults when an org has none). A test may inject its own through `deps.readRules`.
// ---------------------------------------------------------------------------------------------------------------------
export interface PosRules {
  readonly vatPercentBasisPoints: bigint;
  readonly scPwdPercentBasisPoints: bigint;
  /** The Manila hour a business day starts at (4 = 04:00). */
  readonly businessDayStartHour: number;
  readonly tableWarnMinutes: number;
  /** T-558: the largest short payment (centavos) recorded as a routine variance; above it, a finding. */
  readonly saleVarianceToleranceCentavos: bigint;
  /** T-576: a line cancel / line discount / discount removal needs a manager PIN (or manager approval). Absent from an injected reader = off. */
  readonly requirePinLineActions: boolean;
}
export interface PosDeps {
  readonly readRules?: (tx: Tx, orgId: string, businessDate: string) => Promise<PosRules>;
  /** Tests only: the clock `currentBusinessDate` uses before the first Z. */
  readonly now?: () => Date;
}

export async function readRules(tx: Tx, orgId: string, businessDate: string, deps: PosDeps | undefined): Promise<PosRules> {
  return (deps?.readRules ?? readPosRules)(tx, orgId, businessDate);
}

/**
 * The business date a sale (or a Z) carries. T-531 ruling 1 (8 Nov 2026): a Z is dated with the business day it CLOSES, so receipts and statutory
 * rows must carry the date their Z will have:
 *
 *   max(lastZ.business_date + 1 day, startHourDate(at))      where startHourDate(t) = the Manila date of (t - businessDayStartHour)
 *
 * With no earlier Z only the second term applies (the start-hour rule). The moment of the EVENT (a sale's issuedAtDevice) decides the second term, so an
 * offline sale replayed after the day-start hour still lands on its own day; the server clock is only the answer when no device time is given. The hour is
 * read on the Manila calendar date of the moment itself, not the business date: the business date is unknown until the hour is known.
 */
export async function businessDateOf(tx: Tx, orgId: string, storeId: string, deps: PosDeps | undefined, at?: Date): Promise<string> {
  const now = at ?? (deps?.now ? deps.now() : new Date());
  const { businessDayStartHour } = await readRules(tx, orgId, toBusinessDate(now), deps);
  const byClock = startHourDate(now, businessDayStartHour);
  const lastZ = await posV2Repo.lastDayCloseBusinessDate(tx, orgId, storeId);
  if (!lastZ) return byClock;
  const afterZ = addDays(parseBusinessDate(lastZ), 1);
  return afterZ > byClock ? afterZ : byClock;
}

/** The business date of an instant under a day that starts at `hour` Manila time (4 = 04:00): the Manila date of (t - hour). */
export const startHourDate = (t: Date, hour: number): string => toBusinessDate(new Date(t.getTime() - hour * 3_600_000));

/** The business date and the rules in force on it (a sale with a senior or PWD discount needs both). */
export async function businessDateAndRules(tx: Tx, orgId: string, storeId: string, deps: PosDeps | undefined, at?: Date): Promise<{ businessDate: string; rules: PosRules }> {
  const businessDate = await businessDateOf(tx, orgId, storeId, deps, at);
  return { businessDate, rules: await readRules(tx, orgId, businessDate, deps) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Context (R1)
// ---------------------------------------------------------------------------------------------------------------------
export const NOT_ON = 'The new POS is not switched on for this store yet.';
export const RECORDED_DIFFERENTLY = 'This change was already recorded differently on the till.';
export const recordedDifferently = () => refuse('RECORDED_DIFFERENTLY: pos: same device id, different content', RECORDED_DIFFERENTLY);

/**
 * R1, after `authorize`: the store's POS switch must be test or live, and the tablet a live pairing of this store. `pairingId: null` is a
 * phone browser, allowed only where `phoneOk`. Returns the pairing id (null for a phone).
 */
export async function requireContext(tx: Tx, who: Actor, storeId: string, pairingId: string | null, phoneOk: boolean): Promise<string | null> {
  const store = await posV2Repo.getPosStore(tx, who.orgId, storeId);
  if (!store || store.mode === 'off') throw refuse('pos: store switched off', NOT_ON);
  if (pairingId === null) {
    if (!phoneOk) throw refuse('pos: till-only write without a pairing', 'This can only be done on the till tablet.');
    return null;
  }
  if (!(await posV2Repo.getLivePairing(tx, who.orgId, storeId, pairingId))) {
    throw refuse('pos: pairing not live for this store', 'This tablet is not paired to this store. Ask a manager to pair it again.');
  }
  return pairingId;
}

/** Reads need no capability beyond the store itself: the person must be in scope of it. */
export async function requireStoreScope(tx: Tx, who: Actor, storeId: string): Promise<void> {
  const inOrg = await accessRepo.storeBelongsToOrg(tx, storeId, who.orgId);
  if (!inOrg || !(await accessRepo.personHasStoreScope(tx, who.personId, storeId))) {
    throw refuse('pos: no store scope', 'You do not have access to this store.');
  }
}

/** A device time (ISO text or a Date) as a Date, or a plain refusal. */
export function deviceTime(raw: unknown, what: string): Date {
  const d = raw instanceof Date ? raw : typeof raw === 'string' ? new Date(raw) : new Date(NaN);
  if (Number.isNaN(d.getTime())) throw refuse(`pos: ${what} is not a time`, `${what} is not a valid time.`);
  return d;
}

/** A whole number within bounds, or a plain refusal. The label travels in an object (not a string argument) so the numeric-write guard does not read the result as string-derived. */
export function wholeNumber(raw: unknown, rule: { what: string; min: number; max: number }): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < rule.min || raw > rule.max) {
    throw refuse(`pos: ${rule.what} out of range`, `${rule.what} must be a whole number from ${rule.min} to ${rule.max}.`);
  }
  return raw;
}

export function uuidInput(raw: unknown, what: string): string {
  if (typeof raw !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
    throw refuse(`pos: ${what} is not an id`, `${what} is not valid.`);
  }
  return raw.toLowerCase();
}

/** RFC 4122 name-based (SHA-1) uuid: the same name in the same namespace is the same id, so a replay makes the same rows. */
export function uuidv5(name: string, namespace: string): string {
  const h = createHash('sha1').update(Buffer.from(namespace.replace(/-/g, ''), 'hex')).update(name).digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Audit (R12): ids, counts, amounts, never a person's name or card number (row 353).
// ---------------------------------------------------------------------------------------------------------------------
export async function audit(
  tx: Tx,
  actor: Actor,
  action: string,
  o: { storeId: string; entityId: string; pairingId: string | null; at: Date; before?: unknown; after?: unknown },
): Promise<void> {
  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action,
    storeId: o.storeId,
    entityId: o.entityId,
    before: o.before ?? null,
    after: o.after ?? null,
    source: 'pos',
    deviceId: o.pairingId,
    occurredAt: o.at,
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// The bill, loaded from the database (never from the device)
// ---------------------------------------------------------------------------------------------------------------------
/** A session line with its ACTIVE discounts. `bundleHeads` is the row's own column (N > 1 on a "(up to N)" bundle line, else null): never read from the name. */
export type LoadedLine = posV2Repo.TableSessionLineRow & { discounts: posV2Repo.TableSessionLineDiscountRow[] };

/** The session's NON-cancelled lines in creation order, each with its ACTIVE discounts in creation order. */
export async function loadLiveLines(tx: Tx, orgId: string, storeId: string, sessionId: string): Promise<LoadedLine[]> {
  const lines = (await posV2Repo.listSessionLines(tx, orgId, storeId, sessionId)).filter((l) => l.kitchenStatus !== 'cancelled');
  const discounts = (await posV2Repo.listLineDiscounts(tx, orgId, storeId, lines.map((l) => l.id))).filter((d) => d.status === 'active');
  return lines.map((l) => ({ ...l, discounts: discounts.filter((d) => d.sessionLineId === l.id) }));
}

/** How many units a line can be discounted on: its qty, or the heads of a bundle line. */
export const capacityOf = (qty: number, bundleHeads: number | null): number => (bundleHeads !== null && bundleHeads > 1 ? bundleHeads : qty);
export const coveredOf = (qtys: readonly number[]): number => qtys.reduce((a, q) => a + q, 0);

export const billedHeads = (headsCashier: number, headsServer: number | null): number => Math.max(headsCashier, headsServer ?? 0);

export function snapshotOf(lines: readonly LoadedLine[], vatRegistered: boolean, rules: Pick<PosRules, 'vatPercentBasisPoints' | 'scPwdPercentBasisPoints'>): PriceSnapshot {
  return {
    vatRegistered,
    vatPercentBasisPoints: rules.vatPercentBasisPoints,
    scPwdPercentBasisPoints: rules.scPwdPercentBasisPoints,
    lines: lines.map(
      (l): PriceLineInput => ({
        lineId: l.id,
        qty: l.qty,
        unitPrice: l.unitPrice,
        bundleHeads: l.bundleHeads,
        discounts: l.discounts.map((d): PriceDiscountInput => ({ discountId: d.id, kind: d.kind, valueType: d.valueType, value: d.value, qty: d.qty })),
      }),
    ),
  };
}

/** A basis-point percent as the percent text the discount row stores: 2000n -> '20.00'. */
export const percentText = (bp: bigint): string => `${bp / 100n}.${String(bp % 100n).padStart(2, '0')}`;

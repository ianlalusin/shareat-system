/**
 * T-531 - the POS v2 day close: the X reading, the Z (closeDay), the "close day by day" backlog run (closeBacklog), the ERP sales day derived from the Z
 * (deriveSalesDayFromZ, bible row 270), and the December bridge to v1 (sendV1Bridge / resendV1Bridge, row 436). docs/tasks/531-pos-day-close.md R2-R5, R10-R11
 * and the planner's rulings of 8 Nov 2026 (which override earlier text).
 *
 * ## What a Z is
 * A Z freezes ONE terminal's receipts since its last Z into one `pos_day_closes` row (`day_close_id` on every receipt: a late receipt can never silently change a
 * closed day) and, for a live store, derives the ERP sales day for the Z's business date (source `pos_receipts`, status `submitted`). Verification and posting are
 * the existing `verifySalesDay` (a second, senior person: R10); T-531 adds NO posting code, the entry is `sale.mixed` looked up in POSTING-PATTERNS, never decided.
 * It is "cash control, not a BIR document" (row 390). Selling continues after a Z; the next window starts where the last one ended.
 *
 * ## The rules that are easy to get wrong
 *  - Business date of a Z (ruling 1): `max(lastZ.business_date + 1 day, startHourDate(windowEnd))`, the SAME formula `businessDateOf` (pos/shared.ts) gives a sale, so
 *    receipts and statutory rows carry the date their Z will have. A backlog Z is dated with its own business day.
 *  - Approval (rulings 4, R3): the manager's PIN is checked on the server (`verifyPosManagerApproval`) with the throttle charge committed in its OWN transaction
 *    (tx = null), so a wrong PIN counts although this close rolls back. The approver must be a different person from the closer, and if an Employee ID is typed it must
 *    be that approver's staff code at the store (else the same refusal, counted as a miss). The PIN is never logged or stored.
 *  - Everything for one close is ONE top-level transaction (the caller's). A refusal at any step (an existing sales day, a figure that cannot post) rolls the whole close
 *    back, so no receipt is left frozen to a Z that has no day.
 *  - The bridge runs AFTER the commit, in another transaction; its failure never undoes the close.
 */
import {
  authorize,
  AuthenticationError,
  isStoreManagerOrAbove,
  POS_APPROVAL_REFUSED,
  POS_TERMINAL_NOT_REGISTERED,
  recordPosApprovalMiss,
  tabletEmployeeIdToStaffCode,
  verifyPosManagerApproval,
  type Actor,
} from '@shareat/auth';
import { addDays, businessDayRange, parseBusinessDate, toBusinessDate } from '@shareat/core/datetime';
import { logger } from '@shareat/core/logger';
import { add, compare, fromCentavos, money, toCentavos, ZERO, type Money } from '@shareat/core/money';
import { accessRepo, advisoryLocksRepo, auditLogRepo, moneyAccountsRepo, posV1Repo, posV2Repo, RefusalError, salesDaysRepo, withOrgPrincipal, type Tx } from '@shareat/db';
import { gone, internalFault, refuse } from '../shared/refusal';
import { routeSalesDay } from '../sales-days/routing';
import { isUniqueViolation } from './order';
import { audit, NOT_ON, readRules, requireContext, startHourDate, uuidInput, uuidv5, type PosDeps } from './shared';
import { buildV1BridgePayload, v1BridgeDateAllowed, V1_BRIDGE_LAST_DATE, type V1BridgeClose } from './v1-bridge-payload';

// ---------------------------------------------------------------------------------------------------------------------
// Sentences
// ---------------------------------------------------------------------------------------------------------------------
export const NO_SALES_TO_CLOSE = 'There are no sales to close since the last Z.';
export const CLOSE_RACE = 'Another close is in progress. Try again.';
export const MORE_THAN_TWO_DAYS = 'This close would cover more than 2 days. Call a manager.';
export const DIFFERENT_MANAGER = 'A different manager must approve the close.';
export const NOT_A_MANAGER = 'Only a store manager can close the days one by one.';
export const NO_EARLIER_DAYS = 'There are no earlier days to close.';
export const V1_NOT_SENT_PAST = `Days after ${V1_BRIDGE_LAST_DATE} are not sent to v1.`;

/** A named constant: the T-342 guard reads a literal `null` first argument as a null transaction. Here it is deliberate (see `approve`). */
const NO_TX = null;

// ---------------------------------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------------------------------
export interface TenderLine {
  tenderId: string;
  name: string;
  kind: 'cash' | 'wallet';
  /** The NET collected: for cash the amount tendered minus the change given; for a wallet as tendered. */
  amount: Money;
}
export interface Reading {
  storeId: string;
  terminalId: string;
  windowStart: Date;
  windowEnd: Date;
  receiptCount: number;
  /** Σ of the receipt totals, which are AFTER discounts. This is what `pos_day_closes.gross_total` takes. */
  grossTotal: Money;
  /** Σ before discounts: the sales day's total_sales. */
  subtotal: Money;
  discountTotal: Money;
  discounts: { senior: Money; pwd: Money; other: Money };
  seniorPwdDiners: number;
  /** Σ gross of package lines, and Σ gross of every other line: STATED from the receipt lines, never a residual. They add up to the subtotal (asserted). */
  unliSales: Money;
  alaCarteSales: Money;
  byTender: TenderLine[];
  /** T-558: Σ of the receipts' short payments (a gap above zero only; an overpayment's change never offsets one). Σ byTender + varianceTotal = grossTotal (asserted). */
  varianceTotal: Money;
  /** T-558: how many receipts have a gap above the tolerance in force on their business date (the findings). Receipts, not audit rows. */
  shortfallCount: number;
  /** Offline wallet payments still to check against the statement. */
  toCheckCount: number;
  heads: number;
  packageSessions: number;
  /** Receipts issued before the window opened but recorded after the last Z: counted here, flagged, never lost. */
  lateCount: number;
  spansTwoDates: boolean;
}

type Receipt = posV2Repo.PosSalesReceiptRow;
const sumCentavos = (xs: readonly string[]): bigint => xs.reduce((a, x) => a + toCentavos(money(x)), 0n);
const daysBetween = (a: string, b: string): number => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
/** The instant a business day starts: its Manila midnight plus the start hour. */
const dayStart = (date: string, hour: number): Date => new Date(businessDayRange(parseBusinessDate(date)).start.getTime() + hour * 3_600_000);
const nowOf = (deps: PosDeps | undefined): Date => (deps?.now ? deps.now() : new Date());

// ---------------------------------------------------------------------------------------------------------------------
// R2 the reading
// ---------------------------------------------------------------------------------------------------------------------
interface OpenWindow {
  store: posV2Repo.PosStoreRow | undefined;
  open: Receipt[];
  hour: number;
  lastZ: posV2Repo.PosDayCloseRow | undefined;
  start: Date;
}

/**
 * The open window of one terminal: its unclosed receipts and where the window starts. After a Z: that Z's window_end. Before the first Z (ruling 3): the start
 * hour on the EARLIER of the store's live_from and the business date of the oldest unclosed receipt (a test-mode store has no live_from, so the oldest receipt's
 * date alone; with neither, today's).
 */
async function openWindow(tx: Tx, orgId: string, storeId: string, terminalId: string, at: Date, deps: PosDeps | undefined): Promise<OpenWindow> {
  const terminal = await posV2Repo.getTerminal(tx, orgId, storeId, terminalId);
  if (!terminal) throw gone(`pos: terminal ${terminalId} not found`, 'till');
  const store = await posV2Repo.getPosStore(tx, orgId, storeId);
  const { businessDayStartHour: hour } = await readRules(tx, orgId, toBusinessDate(at), deps);
  // A LIVE store ignores unclosed receipts of business days BEFORE live_from: they are test-mode receipts from before the switch (the T-533 runbook purges them). They stay
  // open and untouched; counting them would block every future Z with "more than 2 days", and a backlog Z for such a day would meet the 0247 guard (no sales day before live_from).
  const liveFrom = store?.mode === 'live' ? store.liveFrom : null;
  const allOpen = await posV2Repo.listOpenReceipts(tx, orgId, storeId, terminalId);
  const open = liveFrom ? allOpen.filter((r) => startHourDate(r.issuedAtDevice, hour) >= liveFrom) : allOpen;
  const lastZ = await posV2Repo.lastDayCloseOfTerminal(tx, orgId, storeId, terminalId);
  if (lastZ) return { store, open, hour, lastZ, start: lastZ.windowEnd };
  const dates = [store?.liveFrom ?? null, open[0] ? startHourDate(open[0].issuedAtDevice, hour) : null].filter((d): d is string => d !== null).sort();
  return { store, open, hour, lastZ, start: dayStart(dates[0] ?? startHourDate(at, hour), hour) };
}

/** T-558: the receipts paid short (total above the sum tendered), with the gap in centavos. A receipt paid in full or over (change) is never listed: change never offsets a gap. */
async function shortPaid(tx: Tx, orgId: string, receipts: readonly Receipt[]): Promise<{ receipt: Receipt; gap: bigint }[]> {
  const paid = await posV2Repo.receiptPaidSums(tx, orgId, receipts.map((r) => r.id));
  return receipts
    .map((receipt) => ({ receipt, gap: toCentavos(money(receipt.total)) - toCentavos(money(paid.get(receipt.id) ?? '0')) }))
    .filter((x) => x.gap > 0n);
}

/** The figures of a set of receipts in a window. Every amount is exact centavos; three identities are asserted, and a break is a bug, never a rounding. */
async function figuresOf(
  tx: Tx,
  orgId: string,
  storeId: string,
  terminalId: string,
  receipts: readonly Receipt[],
  window: { start: Date; end: Date },
  hour: number,
  deps: PosDeps | undefined,
): Promise<Reading> {
  const f = await posV2Repo.receiptFigures(tx, orgId, receipts.map((r) => r.id));
  const subtotal = sumCentavos(receipts.map((r) => r.subtotal));
  const discountTotal = sumCentavos(receipts.map((r) => r.discountTotal));
  const gross = sumCentavos(receipts.map((r) => r.total));
  const unli = sumCentavos([f.packageGross]);
  const ala = sumCentavos([f.otherGross]);
  if (unli + ala !== subtotal) throw internalFault(`day close: unli ${unli} + a la carte ${ala} centavos != subtotal ${subtotal}`);
  const senior = sumCentavos([f.discountByKind.senior]);
  const pwd = sumCentavos([f.discountByKind.pwd]);
  const other = sumCentavos([f.discountByKind.preset, f.discountByKind.custom]);
  if (senior + pwd + other !== discountTotal) throw internalFault(`day close: discounts by kind ${senior + pwd + other} != receipt discounts ${discountTotal} centavos`);

  const tenders = new Map((await posV1Repo.listTendersByStore(tx, orgId, storeId)).map((t) => [t.id, t]));
  const byTender: TenderLine[] = f.byTender
    .map((p) => {
      const t = tenders.get(p.tenderId);
      return { tenderId: p.tenderId, name: t?.name ?? 'Unknown tender', kind: (t?.kind ?? 'wallet') as 'cash' | 'wallet', amount: fromCentavos(toCentavos(money(p.amount)) - toCentavos(money(p.change))) };
    })
    .sort((a, b) => compare(b.amount, a.amount) || a.name.localeCompare(b.name));
  // T-558 (row 453): a short-paid receipt is the tender side's gap. Σ tenders + Σ gaps = gross, exactly.
  let variance = 0n;
  let shortfallCount = 0;
  const toleranceOn = new Map<string, bigint>();
  for (const { receipt: r, gap } of await shortPaid(tx, orgId, receipts)) {
    variance += gap;
    // shortcut: the receipt's business date is taken from its own device time; a late receipt carried into a later Z could differ, only when the rule changes between those days.
    const day = startHourDate(r.issuedAtDevice, hour);
    if (!toleranceOn.has(day)) toleranceOn.set(day, (await readRules(tx, orgId, day, deps)).saleVarianceToleranceCentavos);
    if (gap > toleranceOn.get(day)!) shortfallCount += 1;
  }
  if (byTender.reduce((a, t) => a + toCentavos(t.amount), 0n) + variance !== gross) throw internalFault(`day close: tenders ${byTender.reduce((a, t) => a + toCentavos(t.amount), 0n)} + short payments ${variance} do not add up to the receipts' total ${gross} centavos`);

  const lastMs = Math.max(window.start.getTime(), window.end.getTime() - 1);
  return {
    storeId,
    terminalId,
    windowStart: window.start,
    windowEnd: window.end,
    receiptCount: receipts.length,
    grossTotal: fromCentavos(gross),
    subtotal: fromCentavos(subtotal),
    discountTotal: fromCentavos(discountTotal),
    discounts: { senior: fromCentavos(senior), pwd: fromCentavos(pwd), other: fromCentavos(other) },
    seniorPwdDiners: f.statutoryDiners,
    unliSales: fromCentavos(unli),
    alaCarteSales: fromCentavos(ala),
    byTender,
    varianceTotal: fromCentavos(variance),
    shortfallCount,
    toCheckCount: f.byTender.reduce((a, p) => a + p.toCheck, 0),
    heads: f.heads,
    packageSessions: f.packageSessions,
    lateCount: receipts.filter((r) => r.issuedAtDevice.getTime() < window.start.getTime()).length,
    spansTwoDates: startHourDate(window.start, hour) !== startHourDate(new Date(lastMs), hour),
  };
}

/** The open window of one terminal as figures. Pure apart from reads; no capability check (its callers have done theirs). */
export async function readingFor(tx: Tx, actor: Actor, input: { storeId: string; terminalId: string; at: Date }, deps?: PosDeps): Promise<Reading> {
  const w = await openWindow(tx, actor.orgId, input.storeId, input.terminalId, input.at, deps);
  return figuresOf(tx, actor.orgId, input.storeId, input.terminalId, w.open, { start: w.start, end: input.at }, w.hour, deps);
}

/** The X reading: the open window of the paired tablet's till, written nowhere. `record_sale`. */
export async function xReading(tx: Tx, actor: Actor, input: { storeId: string; terminalId?: string; pairingId?: string | null }, deps?: PosDeps): Promise<Reading> {
  await authorize(tx, actor, 'record_sale', { storeId: input.storeId });
  let terminalId = input.terminalId;
  if (input.pairingId) {
    const pairingId = await requireContext(tx, actor, input.storeId, input.pairingId, false);
    const terminal = await posV2Repo.getTerminalForPairing(tx, actor.orgId, input.storeId, pairingId!);
    if (!terminal || (terminalId !== undefined && terminal.id !== terminalId)) throw refuse('pos: terminal mismatch', 'This tablet is not set up as a till yet. Ask a manager.');
    terminalId = terminal.id;
  }
  if (!terminalId) throw refuse('pos: x reading needs a till', 'This tablet is not set up as a till yet. Ask a manager.');
  return readingFor(tx, actor, { storeId: input.storeId, terminalId: uuidInput(terminalId, 'The till'), at: nowOf(deps) }, deps);
}

/** The figures of a Z already closed, from the receipts frozen to it (the replay of a close, the history, the bridge). */
async function readingOfClose(tx: Tx, orgId: string, close: posV2Repo.PosDayCloseRow, deps: PosDeps | undefined): Promise<Reading> {
  const receipts = await posV2Repo.listReceiptsOfClose(tx, orgId, close.storeId, close.id);
  const { businessDayStartHour: hour } = await readRules(tx, orgId, close.businessDate, deps);
  return figuresOf(tx, orgId, close.storeId, close.terminalId, receipts, { start: close.windowStart, end: close.windowEnd }, hour, deps);
}

// ---------------------------------------------------------------------------------------------------------------------
// Approval (R3 step 1)
// ---------------------------------------------------------------------------------------------------------------------
export interface CloseApproval {
  pin: string;
  /** What the manager typed on the keypad: the staff code (`SE-007`) or its number (`7`). The route requires it; when present it must be the PIN owner's staff code at the store. */
  employeeId?: string;
}

/**
 * The manager who approves, from their PIN. A wrong PIN is charged against the cap in its OWN committed transaction (`verifyPosManagerApproval` with no
 * transaction commits the charge before it looks, and refunds a right PIN), so it counts although this close rolls back, and exactly once. PINs are unique per
 * organisation, so the PIN names the person; a typed Employee ID that is not that person's staff code at the store is the same refusal, charged as a miss.
 */
async function approve(tx: Tx, actor: Actor, storeId: string, approval: CloseApproval): Promise<string> {
  if (typeof approval?.pin !== 'string' || approval.pin === '') throw refuse('pos: close without a PIN', 'A manager must approve the close with their PIN.');
  const terminalPersonId = await posV2Repo.getActiveTerminalPersonId(tx, actor.orgId, storeId);
  if (!terminalPersonId) throw refuse('pos: no terminal link for the store', POS_TERMINAL_NOT_REGISTERED);
  const { approverPersonId } = await verifyPosManagerApproval(NO_TX, { orgId: actor.orgId, erpStoreId: storeId, pin: approval.pin, terminalPersonId });
  if (approval.employeeId !== undefined) {
    const typed = tabletEmployeeIdToStaffCode(approval.employeeId) ?? String(approval.employeeId).trim().toUpperCase();
    const staff = (await posV2Repo.listOpenEmploymentsAtStore(tx, actor.orgId, storeId)).find((e) => e.personId === approverPersonId);
    if (!staff || staff.staffCode.toUpperCase() !== typed) {
      await withOrgPrincipal(actor.orgId, (t) => recordPosApprovalMiss(t, { orgId: actor.orgId, terminalPersonId }));
      throw new AuthenticationError(POS_APPROVAL_REFUSED);
    }
  }
  if (approverPersonId === actor.personId) throw refuse('pos: the closer approved their own close', DIFFERENT_MANAGER);
  return approverPersonId;
}

/** The till the pairing acts as (the close is a till act: the terminal must be this tablet's, as `completeSale` checks). */
async function tillOf(tx: Tx, actor: Actor, input: { storeId: string; pairingId?: string | null; terminalId?: string }): Promise<{ pairingId: string; terminalId: string }> {
  const pairingId = (await requireContext(tx, actor, input.storeId, input.pairingId ?? null, false))!;
  const terminal = input.terminalId
    ? await posV2Repo.getTerminal(tx, actor.orgId, input.storeId, uuidInput(input.terminalId, 'The till'))
    : await posV2Repo.getTerminalForPairing(tx, actor.orgId, input.storeId, pairingId);
  if (!terminal || terminal.pairingId !== pairingId) throw refuse('pos: terminal mismatch', 'This tablet is not set up as that till. Ask a manager.');
  return { pairingId, terminalId: terminal.id };
}

// ---------------------------------------------------------------------------------------------------------------------
// Writing one Z (shared by closeDay and closeBacklog)
// ---------------------------------------------------------------------------------------------------------------------
interface ZPlan {
  closeId: string;
  zNo: number;
  businessDate: string;
  windowStart: Date;
  windowEnd: Date;
  receipts: readonly Receipt[];
  reading: Reading;
}

async function writeZ(
  tx: Tx,
  actor: Actor,
  c: { storeId: string; terminalId: string; pairingId: string; approverId: string; at: Date },
  z: ZPlan,
): Promise<{ salesDayId: string | null }> {
  const { orgId } = actor;
  if (z.windowEnd.getTime() <= z.windowStart.getTime()) throw refuse('pos: window end not after its start', 'The server clock is behind the last close. Try again in a minute.');
  try {
    await posV2Repo.insertDayClose(tx, {
      id: z.closeId, orgId, storeId: c.storeId, terminalId: c.terminalId, zNo: z.zNo, businessDate: z.businessDate, windowStart: z.windowStart, windowEnd: z.windowEnd,
      receiptCount: z.reading.receiptCount, grossTotal: z.reading.grossTotal, closedBy: actor.personId, approvedBy: c.approverId,
    });
  } catch (err) {
    if (isUniqueViolation(err, 'pos_day_closes_terminal_z_no_unique') || isUniqueViolation(err, 'pos_day_closes_store_date_terminal_unique')) throw refuse('pos: close race on the Z row', CLOSE_RACE);
    throw err;
  }
  await posV2Repo.insertDayCloseTenders(tx, z.reading.byTender.map((t) => ({ orgId, dayCloseId: z.closeId, tenderId: t.tenderId, amount: t.amount })));
  // The one-time column write: only receipts still open are taken; a different count means another close got one first.
  const closed = await posV2Repo.closeReceipts(tx, orgId, c.storeId, z.closeId, z.receipts.map((r) => r.id));
  if (closed !== z.receipts.length) throw refuse(`pos: closed ${closed} of ${z.receipts.length} receipts`, CLOSE_RACE);
  const salesDayId = await deriveSalesDayFromZ(tx, actor, {
    storeId: c.storeId, pairingId: c.pairingId, close: { id: z.closeId, businessDate: z.businessDate }, reading: z.reading, at: c.at,
  });
  await audit(tx, actor, 'pos.day_closed', {
    storeId: c.storeId, entityId: z.closeId, pairingId: c.pairingId, at: c.at, before: null,
    after: {
      zNo: z.zNo, businessDate: z.businessDate, windowStart: z.windowStart.toISOString(), windowEnd: z.windowEnd.toISOString(), receiptCount: z.reading.receiptCount,
      grossTotal: z.reading.grossTotal, byTender: z.reading.byTender.map((t) => ({ tenderId: t.tenderId, amount: t.amount })), approvedBy: c.approverId, salesDayId,
    },
  });
  return { salesDayId };
}

// ---------------------------------------------------------------------------------------------------------------------
// R3 closeDay
// ---------------------------------------------------------------------------------------------------------------------
export interface CloseDayInput {
  storeId: string;
  /** The tablet (its cookie's pairing); the close is a till act. */
  pairingId: string | null;
  /** Optional: the till this tablet acts as (from its pairing) when absent. */
  terminalId?: string;
  /** Device-made uuid: the Z's own id, so a replay is a no-op. */
  closeId: string;
  approval: CloseApproval;
}
export interface CloseDayResult {
  wrote: boolean;
  dayCloseId: string;
  zNo: number;
  businessDate: string;
  reading: Reading;
  /** The derived ERP sales day; null for a test-mode store (test mode never books). */
  salesDayId: string | null;
  /** For the Z-slip ("printed by", "approved by"): names, never ids (row 229). */
  closedByName: string;
  approvedByName: string;
}

export async function closeDay(tx: Tx, actor: Actor, input: CloseDayInput, deps?: PosDeps): Promise<CloseDayResult> {
  const { storeId } = input;
  const orgId = actor.orgId;
  await authorize(tx, actor, 'record_sale', { storeId });
  const till = await tillOf(tx, actor, input);
  const closeId = uuidInput(input.closeId, 'The close id');
  const approverId = await approve(tx, actor, storeId, input.approval);
  // One close of a store at a time: the second reads what the first committed (the receipts, the sales day), so no receipt is in two Zs.
  await advisoryLocksRepo.lockPosDayClose(tx, storeId);

  const prior = await posV2Repo.getDayClose(tx, orgId, storeId, closeId);
  if (prior) {
    const salesDayId = (await salesDaysRepo.getIdByPosDayClose(tx, orgId, closeId)) ?? null;
    const names = await posV2Repo.listPersonNames(tx, orgId, [prior.closedBy, prior.approvedBy]);
    return {
      wrote: false, dayCloseId: prior.id, zNo: prior.zNo, businessDate: prior.businessDate, reading: await readingOfClose(tx, orgId, prior, deps), salesDayId,
      closedByName: names.get(prior.closedBy) ?? '', approvedByName: names.get(prior.approvedBy) ?? '',
    };
  }

  const at = nowOf(deps);
  const w = await openWindow(tx, orgId, storeId, till.terminalId, at, deps);
  if (!w.store || w.store.mode === 'off') throw refuse('pos: store switched off', NOT_ON);
  const reading = await figuresOf(tx, orgId, storeId, till.terminalId, w.open, { start: w.start, end: at }, w.hour, deps);
  if (reading.receiptCount === 0) throw refuse('pos: nothing to close', NO_SALES_TO_CLOSE);
  // R11 (row 450): from the oldest unclosed receipt's business day to today's, no more than 2 business dates.
  const today = startHourDate(at, w.hour);
  if (daysBetween(startHourDate(w.open[0]!.issuedAtDevice, w.hour), today) + 1 > 2) throw refuse('pos: the close would span more than 2 business days', MORE_THAN_TWO_DAYS);

  // Ruling 1: a Z is dated with the business day it closes, and after this terminal's last Z.
  const afterLast = w.lastZ ? addDays(parseBusinessDate(w.lastZ.businessDate), 1) : null;
  const businessDate = afterLast !== null && afterLast > today ? afterLast : today;
  const { salesDayId } = await writeZ(tx, actor, { storeId, terminalId: till.terminalId, pairingId: till.pairingId, approverId, at }, {
    closeId, zNo: (w.lastZ?.zNo ?? 0) + 1, businessDate, windowStart: w.start, windowEnd: at, receipts: w.open, reading,
  });
  await posV2Repo.bumpStateVersion(tx, orgId, storeId);
  const names = await posV2Repo.listPersonNames(tx, orgId, [actor.personId, approverId]);
  return {
    wrote: true, dayCloseId: closeId, zNo: (w.lastZ?.zNo ?? 0) + 1, businessDate, reading, salesDayId,
    closedByName: names.get(actor.personId) ?? '', approvedByName: names.get(approverId) ?? '',
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// R11 closeBacklog - "Close day by day"
// ---------------------------------------------------------------------------------------------------------------------
export interface CloseBacklogInput {
  storeId: string;
  pairingId: string | null;
  terminalId?: string;
  /** Device-made uuid of the run; each day's Z id is uuidv5(businessDate, closeRunId), so a replay writes nothing new. */
  closeRunId: string;
  approval: CloseApproval;
}
export interface BacklogClose {
  dayCloseId: string;
  zNo: number;
  businessDate: string;
  salesDayId: string | null;
  grossTotal?: string;
}

/**
 * Closes the unclosed backlog ONE BUSINESS DAY AT A TIME, oldest first, up to and including yesterday's business date; the current day stays open. A manager's act
 * (role manager or above, and a different manager's PIN). Each Z's window runs from the previous end to that day's end (the next day at the start hour), takes the
 * receipts whose business day it is, and derives its own sales day; a day with no receipts gets no Z; z_no keeps counting. One transaction: a day that cannot derive
 * its sales day rolls the whole run back.
 */
export async function closeBacklog(tx: Tx, actor: Actor, input: CloseBacklogInput, deps?: PosDeps): Promise<{ wrote: boolean; closes: BacklogClose[] }> {
  const { storeId } = input;
  const orgId = actor.orgId;
  await authorize(tx, actor, 'record_sale', { storeId });
  const till = await tillOf(tx, actor, input);
  const runId = uuidInput(input.closeRunId, 'The run id');
  if (!isStoreManagerOrAbove((await accessRepo.activeRoleForPerson(tx, actor.personId, orgId))?.role)) throw refuse('pos: backlog close by a non-manager', NOT_A_MANAGER);
  const approverId = await approve(tx, actor, storeId, input.approval);
  await advisoryLocksRepo.lockPosDayClose(tx, storeId);

  const done = await auditLogRepo.latestForEntity(tx, orgId, { entity: 'pos_day_closes', entityId: runId, action: 'pos.day_closed_backlog' });
  if (done) return { wrote: false, closes: ((done.after as { closes?: BacklogClose[] } | null)?.closes ?? []) };

  const at = nowOf(deps);
  const w = await openWindow(tx, orgId, storeId, till.terminalId, at, deps);
  if (!w.store || w.store.mode === 'off') throw refuse('pos: store switched off', NOT_ON);
  const today = startHourDate(at, w.hour);
  // The earliest day a Z of this run may take: the day the window opens on, and after this terminal's last Z (one Z per date per till). Late receipts fold into it.
  const afterLast = w.lastZ ? addDays(parseBusinessDate(w.lastZ.businessDate), 1) : null;
  const windowDay = startHourDate(w.start, w.hour);
  const earliest = afterLast !== null && afterLast > windowDay ? afterLast : windowDay;
  const groups = new Map<string, Receipt[]>();
  for (const r of w.open) {
    const own = startHourDate(r.issuedAtDevice, w.hour);
    const day = own < earliest ? earliest : own;
    if (day >= today) continue; // today (and anything dated after it) stays open
    groups.set(day, [...(groups.get(day) ?? []), r]);
  }
  const days = [...groups.keys()].sort();
  if (days.length === 0) throw refuse('pos: no earlier day to close', NO_EARLIER_DAYS);

  const ctx = { storeId, terminalId: till.terminalId, pairingId: till.pairingId, approverId, at };
  const closes: BacklogClose[] = [];
  let start = w.start;
  let zNo = w.lastZ?.zNo ?? 0;
  for (const day of days) {
    const receipts = groups.get(day)!;
    const end = dayStart(addDays(parseBusinessDate(day), 1), w.hour);
    const reading = await figuresOf(tx, orgId, storeId, till.terminalId, receipts, { start, end }, w.hour, deps);
    zNo += 1;
    const closeId = uuidv5(day, runId);
    const { salesDayId } = await writeZ(tx, actor, ctx, { closeId, zNo, businessDate: day, windowStart: start, windowEnd: end, receipts, reading });
    closes.push({ dayCloseId: closeId, zNo, businessDate: day, salesDayId, grossTotal: reading.grossTotal });
    start = end;
  }
  await audit(tx, actor, 'pos.day_closed_backlog', {
    storeId, entityId: runId, pairingId: till.pairingId, at, before: null,
    after: { approvedBy: approverId, days: closes.map((x) => x.businessDate), zNos: closes.map((x) => x.zNo), totals: closes.map((x) => x.grossTotal), closes },
  });
  await posV2Repo.bumpStateVersion(tx, orgId, storeId);
  return { wrote: true, closes };
}

// ---------------------------------------------------------------------------------------------------------------------
// R4 the ERP sales day from the Z
// ---------------------------------------------------------------------------------------------------------------------
const dateText = (d: string): string => d; // ISO YYYY-MM-DD in every sentence (ruling 5)

/**
 * Derives the ERP sales day for a Z, inside the close's transaction: `source = 'pos_receipts'`, `submitted` with the closing cashier as submitter. A refusal rolls the
 * whole close back: a live sales day already on the date (a second terminal, a v1 feed day), a tender with no money account, or figures that cannot post (the
 * `sale.mixed` identities, checked with the real router BEFORE anything is written). A store in test mode closes with NO sales day (returns null). T-531 adds no
 * posting code: a different, senior person verifies it through the existing `verifySalesDay` (R10).
 */
export async function deriveSalesDayFromZ(
  tx: Tx,
  actor: Actor,
  input: { storeId: string; pairingId: string | null; close: { id: string; businessDate: string }; reading: Reading; at: Date },
): Promise<string | null> {
  const { orgId } = actor;
  const { storeId, close, reading } = input;
  const store = await posV2Repo.getPosStore(tx, orgId, storeId);
  if (!store || store.mode !== 'live') return null;
  const date = dateText(close.businessDate);
  const existing = await salesDaysRepo.findByBusinessDate(tx, orgId, storeId, close.businessDate);
  if (existing) throw refuse(`pos: a ${existing.source} sales day already holds ${date}`, `A sales day for ${date} already exists (${existing.source}). Ask an accountant.`);

  // Where the money went, as the v1-feed import resolves it: cash is the till's; each wallet tender lands in its own money account (summed per account).
  const tenders = new Map((await posV1Repo.listTendersByStore(tx, orgId, storeId)).map((t) => [t.id, t]));
  let cash: Money = ZERO;
  const wallets = new Map<string, Money>();
  for (const line of reading.byTender) {
    const t = tenders.get(line.tenderId);
    if (!t) throw internalFault(`day close: tender ${line.tenderId} is not a tender of store ${storeId}`);
    if (t.kind === 'cash') {
      cash = add(cash, line.amount);
      continue;
    }
    if (!t.moneyAccountId) {
      throw refuse(`pos: wallet tender ${t.id} has no money account`, `The tender ${t.name} has no money account. An admin fixes it under Settings › POS link, then the day can be closed.`);
    }
    wallets.set(t.moneyAccountId, add(wallets.get(t.moneyAccountId) ?? ZERO, line.amount));
  }
  for (const accountId of wallets.keys()) {
    const account = await moneyAccountsRepo.getById(tx, orgId, accountId);
    if (!account || !account.isActive) {
      const name = [...tenders.values()].find((x) => x.moneyAccountId === accountId)?.name ?? 'A wallet tender';
      throw refuse(`pos: money account ${accountId} of tender "${name}" is retired or missing`, `${name}'s money account is no longer active, so ${date} can't be closed. An admin sets ${name}'s account under Settings › POS link.`);
    }
  }
  const online = wallets.size === 0 ? ZERO : add(...wallets.values());

  // Both balance identities of sale.mixed (POSTING-PATTERNS "Sale"), through the router verify will use: nothing is written if the day could never post.
  const routed = routeSalesDay({
    totalSales: reading.subtotal, unliSales: reading.unliSales, alaCarteSales: reading.alaCarteSales,
    seniorDiscount: reading.discounts.senior, pwdDiscount: reading.discounts.pwd, otherDiscount: reading.discounts.other,
    comps: ZERO, serviceCharge: ZERO, otherCharges: ZERO, cashCollected: cash, onlineCollected: online, creditSales: ZERO, refunds: ZERO,
    allowShortPayment: true, channels: [], tenders: [...wallets.entries()].map(([moneyAccountId, amount]) => ({ moneyAccountId, amount })),
  });
  if (!routed.ok) throw refuse(`pos: the day ${date} cannot post: ${routed.reason}`, `The day ${date} cannot be booked as it stands: ${routed.reason}. Nothing was closed.`);

  const salesDayId = await salesDaysRepo.withSalesDayDerivation(tx, async () => {
    const { id } = await salesDaysRepo.insertPosReceiptsDay(tx, {
      orgId, storeId, businessDate: close.businessDate, posDayCloseId: close.id, createdBy: actor.personId, posSourcedAt: input.at,
      totalSales: reading.subtotal, unliSales: reading.unliSales, alaCarteSales: reading.alaCarteSales,
      seniorDiscount: reading.discounts.senior, pwdDiscount: reading.discounts.pwd, otherDiscount: reading.discounts.other,
      cashCollected: cash, onlineCollected: online,
    });
    await salesDaysRepo.replaceTenders(tx, id, [...wallets.entries()].map(([moneyAccountId, amount]) => ({ moneyAccountId, amount })));
    return id;
  });
  // As `submitSalesDay` would: submitted by the closing cashier. (Not through it: its channel-completeness and `submit_sales_day` rules are for typed days.)
  await salesDaysRepo.markSubmitted(tx, orgId, salesDayId, actor.personId);
  await audit(tx, actor, 'sales_day.derived_from_z', {
    storeId, entityId: salesDayId, pairingId: input.pairingId, at: input.at, before: null,
    after: { businessDate: close.businessDate, posDayCloseId: close.id, totalSales: reading.subtotal, cashCollected: cash, onlineCollected: online },
  });
  await audit(tx, actor, 'sales_day.submitted', { storeId, entityId: salesDayId, pairingId: input.pairingId, at: input.at, before: { status: 'open' }, after: { status: 'submitted' } });
  return salesDayId;
}

// ---------------------------------------------------------------------------------------------------------------------
// R5 the December bridge to v1
// ---------------------------------------------------------------------------------------------------------------------
/** What the bridge writes through: the real one is apps/erp/src/lib/v1-bridge.ts (firebase-admin); a test injects a fake. */
export interface V1BridgeWriter {
  set(path: string, data: Record<string, unknown>, opts: { merge: boolean }): Promise<void>;
}
export type V1BridgeStatus = 'sent' | 'failed' | 'skipped';

/** The document for a store and date, rebuilt from the DATABASE (the Z rows and the receipts frozen to them), or null when the store has no v1 link or the date has no Z. */
async function bridgePayloadFor(tx: Tx, orgId: string, storeId: string, businessDate: string) {
  const link = await posV1Repo.getLinkByStore(tx, orgId, storeId);
  if (!link) return null;
  // Test mode never books, so it never writes into v1 either.
  if ((await posV2Repo.getPosStore(tx, orgId, storeId))?.mode !== 'live') return null;
  const days = await posV2Repo.listDayClosesOfDate(tx, orgId, storeId, businessDate);
  if (days.length === 0) return null;
  const tenders = new Map((await posV1Repo.listTendersByStore(tx, orgId, storeId)).map((t) => [t.id, t]));
  const closes: V1BridgeClose[] = [];
  for (const d of days) {
    const receipts = await posV2Repo.listReceiptsOfClose(tx, orgId, storeId, d.close.id);
    const f = await posV2Repo.receiptFigures(tx, orgId, receipts.map((r) => r.id));
    closes.push({
      receiptCount: d.close.receiptCount,
      grossTotal: d.close.grossTotal,
      varianceTotal: fromCentavos((await shortPaid(tx, orgId, receipts)).reduce((a, x) => a + x.gap, 0n)),
      discountTotal: fromCentavos(sumCentavos(receipts.map((r) => r.discountTotal))),
      unliSales: fromCentavos(sumCentavos([f.packageGross])),
      heads: f.heads,
      packageSessions: f.packageSessions,
      tenders: d.tenders.map((t) => {
        const row = tenders.get(t.tenderId);
        return { name: row?.name ?? 'Unknown tender', kind: row?.kind ?? 'wallet', v1Alias: row?.posV1Alias ?? null, amount: t.amount };
      }),
    });
  }
  return buildV1BridgePayload({ posStoreId: link.posStoreId, businessDate, closes });
}

/**
 * After a close commits: writes each business date's document to v1, in date order, in the CALLER'S (new) transaction. It NEVER throws on a failed write: a failure is
 * logged and recorded as `pos.v1_bridge_failed` (the Till tab then says "Not yet sent to v1. Tap Resend."), a success as `pos.v1_bridge_sent`. A store with no v1 link,
 * a date with no Z, and a date after 2026-12-31 are `skipped` and write nothing.
 */
export async function sendV1Bridge(
  tx: Tx,
  actor: Actor,
  input: { storeId: string; businessDates: readonly string[] },
  deps: { writer: V1BridgeWriter },
): Promise<{ results: { businessDate: string; status: V1BridgeStatus; reason?: string }[] }> {
  await authorize(tx, actor, 'record_sale', { storeId: input.storeId });
  const results: { businessDate: string; status: V1BridgeStatus; reason?: string }[] = [];
  const at = new Date();
  for (const businessDate of [...new Set(input.businessDates)].sort()) {
    if (!v1BridgeDateAllowed(businessDate)) {
      results.push({ businessDate, status: 'skipped', reason: V1_NOT_SENT_PAST });
      continue;
    }
    try {
      const payload = await bridgePayloadFor(tx, actor.orgId, input.storeId, businessDate);
      if (!payload) {
        results.push({ businessDate, status: 'skipped', reason: 'Nothing to send to v1 for this day.' });
        continue;
      }
      await deps.writer.set(payload.path, payload.data as unknown as Record<string, unknown>, { merge: payload.merge });
      await audit(tx, actor, 'pos.v1_bridge_sent', { storeId: input.storeId, entityId: input.storeId, pairingId: null, at, after: { businessDate, path: payload.path } });
      results.push({ businessDate, status: 'sent' });
    } catch (err) {
      const reason = err instanceof RefusalError ? err.userMessage : 'v1 could not be reached.';
      logger.warn({ storeId: input.storeId, businessDate, refusal: err instanceof RefusalError }, 'pos v1 bridge: the write failed, the close stays committed');
      await audit(tx, actor, 'pos.v1_bridge_failed', { storeId: input.storeId, entityId: input.storeId, pairingId: null, at, after: { businessDate, reason } });
      results.push({ businessDate, status: 'failed', reason });
    }
  }
  return { results };
}

/** A manager sends a day to v1 again: rebuilt from the database and rewritten (idempotent: a full overwrite). `approve_pos_correction`. A refusal (no mapping, no key, a date after 31 Dec) is the answer. */
export async function resendV1Bridge(
  tx: Tx,
  actor: Actor,
  input: { storeId: string; businessDate: string },
  deps: { writer: V1BridgeWriter },
): Promise<{ sent: true }> {
  await authorize(tx, actor, 'approve_pos_correction', { storeId: input.storeId });
  parseBusinessDate(input.businessDate);
  if (!v1BridgeDateAllowed(input.businessDate)) throw refuse(`v1 bridge: ${input.businessDate} is after ${V1_BRIDGE_LAST_DATE}`, V1_NOT_SENT_PAST);
  const payload = await bridgePayloadFor(tx, actor.orgId, input.storeId, input.businessDate);
  if (!payload) throw refuse('v1 bridge: nothing to send', 'There is nothing to send to v1 for this day. The store may not be linked to v1, or the day was not closed.');
  try {
    await deps.writer.set(payload.path, payload.data as unknown as Record<string, unknown>, { merge: payload.merge });
  } catch (err) {
    if (err instanceof RefusalError) throw err;
    logger.warn({ storeId: input.storeId, businessDate: input.businessDate }, 'pos v1 bridge: the resend failed');
    throw refuse('v1 bridge: the write failed', 'v1 could not be reached. Try again in a moment.');
  }
  await audit(tx, actor, 'pos.v1_bridge_sent', { storeId: input.storeId, entityId: input.storeId, pairingId: null, at: new Date(), after: { businessDate: input.businessDate, path: payload.path, resent: true } });
  return { sent: true };
}

// ---------------------------------------------------------------------------------------------------------------------
// The history (R6): today's and recent Zs
// ---------------------------------------------------------------------------------------------------------------------
export type V1HistoryStatus = 'sent' | 'failed' | 'pending' | 'not_applicable';
export interface DayCloseListItem {
  id: string;
  zNo: number;
  businessDate: string;
  grossTotal: string;
  byTender: { tenderId: string; name: string; amount: Money }[];
  v1Status: V1HistoryStatus;
  closedByName: string;
  approvedByName: string;
  windowStart: Date;
  windowEnd: Date;
  /** The full figures (what Reprint prints). */
  reading: Reading;
}

/** The store's recent Zs (newest first), each with its tenders, its v1 bridge status and its figures. `record_sale`. */
export async function listDayCloses(tx: Tx, actor: Actor, input: { storeId: string; limit?: number }, deps?: PosDeps): Promise<{ closes: DayCloseListItem[] }> {
  await authorize(tx, actor, 'record_sale', { storeId: input.storeId });
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 7), 1), 31);
  const rows = await posV2Repo.listDayCloses(tx, actor.orgId, input.storeId, limit);
  const link = await posV1Repo.getLinkByStore(tx, actor.orgId, input.storeId);
  const marks = await auditLogRepo.listForStoreActions(tx, actor.orgId, input.storeId, ['pos.v1_bridge_sent', 'pos.v1_bridge_failed']);
  const names = await posV2Repo.listPersonNames(tx, actor.orgId, rows.flatMap((r) => [r.close.closedBy, r.close.approvedBy]));
  const tenders = new Map((await posV1Repo.listTendersByStore(tx, actor.orgId, input.storeId)).map((t) => [t.id, t.name]));
  const closes: DayCloseListItem[] = [];
  for (const { close, tenders: tl } of rows) {
    const mark = marks.find((m) => (m.after as { businessDate?: string } | null)?.businessDate === close.businessDate);
    const v1Status: V1HistoryStatus = !link || !v1BridgeDateAllowed(close.businessDate) ? 'not_applicable' : mark ? (mark.action === 'pos.v1_bridge_sent' ? 'sent' : 'failed') : 'pending';
    closes.push({
      id: close.id,
      zNo: close.zNo,
      businessDate: close.businessDate,
      grossTotal: close.grossTotal,
      byTender: tl.map((t) => ({ tenderId: t.tenderId, name: tenders.get(t.tenderId) ?? 'Unknown tender', amount: money(t.amount) })),
      v1Status,
      closedByName: names.get(close.closedBy) ?? '',
      approvedByName: names.get(close.approvedBy) ?? '',
      windowStart: close.windowStart,
      windowEnd: close.windowEnd,
      reading: await readingOfClose(tx, actor.orgId, close, deps),
    });
  }
  return { closes };
}

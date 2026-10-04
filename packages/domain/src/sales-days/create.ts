/**
 * createSalesDay — and **the create-block**, which is the interesting part.
 * docs/tasks/123-sales-day.md §4.2, bible row 126.
 *
 * ## The forcing function, and why it does not deadlock
 *
 * Ian: *"Block creating a new sales report when an older unverified one is already in place, so
 * the revenue is only hours late."* Without it, unrecognised revenue accumulates silently; with
 * it, **the pile cannot grow past one** and the person who must act cannot do their next job until
 * they do.
 *
 * ⚠️ **v1's three carve-outs are load-bearing and every one of them falls out of the design rather
 * than being special-cased:**
 *
 *   - **Editing an existing draft** — a different function (`editSalesDay`), which never consults
 *     the block. Otherwise the blocked day could never be fixed.
 *   - **Backfilling an OLDER date** — the query is *strictly before* the date being created, so an
 *     earlier date is not blocked by a later one. You can always fill the gap that caused the
 *     block.
 *   - **Starting a shift** — a different document entirely (T-136). **The block is about
 *     RECOGNITION, never about trading.**
 *
 * ## Admins bypass
 *
 * v1 flipped to this deliberately in June 2026 at Ian's request, having originally shipped with no
 * exemption. ⚠️ **Do not "restore" the stricter version** on the strength of reading the first
 * commit — the exemption is the newer decision.
 */
import { authorize, AuthorizationError, type Actor } from '@shareat/auth';
import { moneyAccountsRepo, salesDaysRepo, tradeDiscrepanciesRepo, transaction, type Tx } from '@shareat/db';
import { add, compare, isZero, ZERO, type Money } from '@shareat/core/money';
import { parseBusinessDate } from '@shareat/core/datetime';
import { parseDecimalInput, parseMoneyInput } from '../shared/money-input';
import { refuse, humanDate, RefusalError } from '../shared/refusal';

/**
 * A refusal message builder must never itself throw (code-review item 7, 2026-09-26):
 * `input.businessDate` is caller-supplied and `parseBusinessDate` rejects anything not strictly
 * `YYYY-MM-DD` (e.g. `2026-1-10`, unpadded) — a malformed date must fall back to the raw string
 * rather than crash the refusal it is naming.
 */
function safeHumanDate(rawBusinessDate: string): string {
  try {
    return humanDate(parseBusinessDate(rawBusinessDate));
  } catch {
    return rawBusinessDate;
  }
}

export interface CreateSalesDayChannelInput {
  channelId: string;
  amount: string;
  /** True = the reporter explicitly confirmed no sales on this channel, as opposed to leaving it
   *  blank. **An absent row and a confirmed zero must not mean the same thing** (v1's
   *  `noSalesChannelIds`, and the same distinction T-134 draws for a counted zero). */
  noSales?: boolean;
}

export interface CreateSalesDayTenderInput {
  moneyAccountId: string;
  amount: string;
}

export interface CreateSalesDayInput {
  storeId: string;
  businessDate: string;
  posSourced?: boolean;
  totalSales: string;
  unliSales: string;
  alaCarteSales: string;
  seniorDiscount?: string;
  pwdDiscount?: string;
  otherDiscount?: string;
  comps?: string;
  serviceCharge?: string;
  otherCharges?: string;
  cashCollected?: string;
  onlineCollected?: string;
  creditSales?: string;
  channels?: CreateSalesDayChannelInput[];
  /** ⭐ WHERE the online money landed — one row per wallet (DEF-068). Required whenever
   *  `onlineCollected` is non-zero: `1140` is a control account and `verifySalesDay` refuses to
   *  post a day whose wallets do not sum to its online total. */
  tenders?: CreateSalesDayTenderInput[];
}

/**
 * ⭐ T-174. Thrown when an unresolved transit shortfall blocks a new day at the COMMISSARY.
 *
 * ⚠️ v1's reason is exactly right and worth keeping in the code: *forces resolution before revenue
 * can be understated further.* A commissary whose dispatched goods are unaccounted for is a
 * commissary whose cost of sales is wrong, and every day it opens on top of that makes the figure
 * worse and harder to unpick.
 */
export class TransitShortfallBlockedError extends Error {
  constructor(
    message: string,
    readonly discrepancyIds: readonly string[],
  ) {
    super(message);
    this.name = 'TransitShortfallBlockedError';
  }
}

/** Thrown when an older unverified day blocks this one. A named type, not a bare Error, because
 *  a caller has a genuinely useful thing to do with it: send the user to that day. It is a
 *  `RefusalError`, so the screen shows `userMessage` (a plain sentence naming the date) and never the
 *  developer text in `message`. */
export class SalesDayBlockedError extends RefusalError {
  constructor(
    message: string,
    userMessage: string,
    readonly blockingDayId: string,
    readonly blockingBusinessDate: string,
  ) {
    super(message, userMessage);
    this.name = 'SalesDayBlockedError';
  }
}

export async function createSalesDay(
  tx: Tx | null,
  actor: Actor,
  input: CreateSalesDayInput,
): Promise<{ id: string }> {
  if (tx) return runCreate(tx, actor, input);
  return transaction((trx) => runCreate(trx, actor, input));
}

async function runCreate(tx: Tx, actor: Actor, input: CreateSalesDayInput): Promise<{ id: string }> {
  await authorize(tx, actor, 'submit_sales_day', { storeId: input.storeId });

  const existing = await salesDaysRepo.findByBusinessDate(tx, actor.orgId, input.storeId, input.businessDate);
  if (existing) {
    throw refuse(
      `createSalesDay: a sales day already exists for store ${input.storeId} on ${input.businessDate} ` +
        `(status ${existing.status}) — edit it rather than creating a second`,
      `This store already has a sales day for ${safeHumanDate(input.businessDate)} ` +
        `(${existing.status}). Edit that one instead of starting a second.`,
    );
  }

  // T-369 S7 (Ian Q1): a VOIDED day frees its date, but only a manager may enter it again - never staff.
  // The same capability that lets someone withdraw a day lets them re-enter its date. Asked only when a
  // voided day really is on this date, so an ordinary create never pays for it.
  if (await salesDaysRepo.hasVoidedOn(tx, actor.orgId, input.storeId, input.businessDate)) {
    try {
      await authorize(tx, actor, 'void_sales_day', { storeId: input.storeId });
    } catch (err) {
      if (!(err instanceof AuthorizationError)) throw err;
      throw refuse(
        `createSalesDay: ${input.businessDate} at store ${input.storeId} was voided and re-entering it needs void_sales_day`,
        `${safeHumanDate(input.businessDate)} was withdrawn earlier. Only a manager can enter that date again — ask one to do it.`,
      );
    }
    // Cash handed over and counted against this date has to be reversed before the date is entered again.
    if (await salesDaysRepo.hasPostedHandoverOn(tx, actor.orgId, input.storeId, input.businessDate)) {
      throw refuse(
        `createSalesDay: ${input.businessDate} at store ${input.storeId} has a posted remittance allocation`,
        'Cash handed over has been counted against this date. Reverse that handover first.',
      );
    }
  }

  // ── The create-block ────────────────────────────────────────────────────────────────
  // Admins bypass. Checked by asking whether this actor could close a period — the closest
  // existing capability that only admins and org-wide managers hold — rather than reading a
  // role name here, so the matrix stays the single source of who may do what.
  const isAdmin = await canBypassBlock(tx, actor, input.storeId);
  if (!isAdmin) {
    const blocking = await salesDaysRepo.findOldestUnverifiedBefore(
      tx,
      actor.orgId,
      input.storeId,
      input.businessDate,
    );
    if (blocking) {
      throw new SalesDayBlockedError(
        `createSalesDay: ${blocking.businessDate} is still ${blocking.status} and must be verified ` +
          `before a newer day can be created. You can still edit that day, or backfill an even ` +
          `older one`,
        `${safeHumanDate(blocking.businessDate)} is still ${blocking.status} — verify or edit it before entering a newer day.`,
        blocking.id,
        blocking.businessDate,
      );
    }

    // ── T-174: the transit-shortfall block ────────────────────────────────────────────
    // ⭐ Everything `open`, plus everything `deferred` whose date has ARRIVED — a deferral is a
    // promise to decide by a date, not an exemption. ⛔ Derived from the rows every time, never a
    // counter (DEF-075), and it is the SAME query the discrepancy screen lists from: one source,
    // two consumers, so the block can never refuse a day over something the screen does not show.
    const shortfalls = await tradeDiscrepanciesRepo.blocking(
      tx,
      actor.orgId,
      input.storeId,
      input.businessDate,
    );
    if (shortfalls.length > 0) {
      const first = shortfalls[0]!;
      throw new TransitShortfallBlockedError(
        `createSalesDay: ${shortfalls.length} dispatched shipment` +
          `${shortfalls.length === 1 ? ' has' : 's have'} goods unaccounted for — ` +
          `${first.quantity} units worth ₱${first.value} and ` +
          `${shortfalls.length - 1} other${shortfalls.length === 2 ? '' : 's'}. ` +
          `Decide what happened to them before opening a new day`,
        shortfalls.map((d) => d.id),
      );
    }
  }

  // T-371 R5/R6: parsed after authorize(), and a blank follows its column — the three revenue figures
  // (NOT NULL, no default) are refused in words; the defaulted ones fall back to the column default.
  const parsed = parseSalesDayFigures(input, 'createSalesDay');
  // The defaulted figures stay optional: `insertSalesDay` omits a blank one, so the column's own DEFAULT applies (R13).
  const figures = parsed;

  const posSourced = input.posSourced ?? false;
  const { id } = await salesDaysRepo.insertSalesDay(tx, {
    orgId: actor.orgId,
    storeId: input.storeId,
    businessDate: input.businessDate,
    posSourced,
    // Provenance is a pair or neither — a CHECK constraint enforces it too.
    posSourcedAt: posSourced ? new Date() : null,
    totalSales: figures.totalSales,
    unliSales: figures.unliSales,
    alaCarteSales: figures.alaCarteSales,
    seniorDiscount: figures.seniorDiscount,
    pwdDiscount: figures.pwdDiscount,
    otherDiscount: figures.otherDiscount,
    comps: figures.comps,
    serviceCharge: figures.serviceCharge,
    otherCharges: figures.otherCharges,
    cashCollected: figures.cashCollected,
    onlineCollected: figures.onlineCollected,
    creditSales: figures.creditSales,
    createdBy: actor.personId,
  });

  if (input.channels && input.channels.length > 0) {
    await writeChannels(tx, actor, input.storeId, id, input.channels);
  }
  if (input.tenders && input.tenders.length > 0) {
    await writeTenders(tx, actor, input.storeId, id, input.tenders);
  }

  return { id };
}

/**
 * Channel rows, validated against this store's OWN channel configuration.
 *
 * ⚠️ A channel id that does not belong to this store is refused rather than written — otherwise a
 * day could reference another store's channel and its money would be attributed to the wrong
 * receivable. Exported because `editSalesDay` needs exactly the same validation.
 */
export async function writeChannels(
  tx: Tx,
  actor: Actor,
  storeId: string,
  salesDayId: string,
  channels: CreateSalesDayChannelInput[],
): Promise<void> {
  const configured = await salesDaysRepo.listChannels(tx, actor.orgId, storeId);
  const byId = new Map(configured.map((c) => [c.id, c]));

  const rows = channels.map((c) => {
    const cfg = byId.get(c.channelId);
    if (!cfg) {
      throw refuse(
        `sales day channels: channel ${c.channelId} is not configured for store ${storeId} — ` +
          `a day may only report channels its own store has`,
        "One of the sales channels on this day isn't set up for this store. Reload the page and try again.",
      );
    }
    // T-371: parsed in words (was a raw `money()` whose TypeError is a developer message). The column is
    // NOT NULL DEFAULT '0', but a channel row is only sent when it carries a figure or a confirmed zero.
    const amount = parseMoneyInput(c.amount, `sales day channels: "${cfg.name}"'s amount`, `The amount for "${cfg.name}"`);
    const noSales = c.noSales ?? false;
    if (noSales && !isZero(amount)) {
      throw refuse(
        `sales day channels: "${cfg.name}" is marked "no sales" but carries ${amount} — ` +
          `a confirmed zero and an amount are different claims`,
        `"${cfg.name}" is marked "no sales" but carries ${amount} — a confirmed zero and an amount are different claims.`,
      );
    }
    return { channelId: c.channelId, amount, noSales };
  });

  await salesDaysRepo.replaceChannels(tx, salesDayId, rows);
}

/**
 * Whether this actor bypasses the create-block.
 *
 * ⚠️ Deliberately expressed as a CAPABILITY question, not a role check. `close_period` is held by
 * admins and by managers whose scope covers the whole org (bible row 123) — the same population
 * that v1's `isAdmin` bypass was reaching for, and asking it this way means the capability matrix
 * stays the one place that decides who may do what. A `role === 'admin'` here would be a second,
 * competing authority (bible row 120).
 */
async function canBypassBlock(tx: Tx, actor: Actor, storeId: string): Promise<boolean> {
  try {
    await authorize(tx, actor, 'close_period', { storeId });
    return true;
  } catch (err) {
    if (err instanceof AuthorizationError) return false;
    throw err;
  }
}

/** Sum of a day's figures, for callers that want to show a total before writing. Pure. */
export function sumTender(input: {
  cashCollected: Money;
  onlineCollected: Money;
  creditSales: Money;
  discountsTotal: Money;
  comps: Money;
}): Money {
  return add(input.cashCollected, input.onlineCollected, input.creditSales, input.discountsTotal, input.comps);
}

/**
 * Persists the day's tender breakdown.
 *
 * ⚠️ Every wallet must belong to THIS store, checked the same way a channel is. A day reporting
 * money into another branch's wallet is either a typo or a cross-store leak, and both should stop
 * here rather than reach the ledger — where the line would still post, because
 * `journal_lines.party_id` carries no FK by design (DEF-040).
 */
export async function writeTenders(
  tx: Tx,
  actor: Actor,
  storeId: string,
  salesDayId: string,
  tenders: CreateSalesDayTenderInput[],
): Promise<void> {
  const available = await moneyAccountsRepo.listMoneyAccounts(tx, actor.orgId, { storeId });
  const byId = new Map(available.map((m) => [m.id, m]));

  const seen = new Set<string>();
  const rows: { moneyAccountId: string; amount: Money }[] = [];
  for (const t of tenders) {
    const cfg = byId.get(t.moneyAccountId);
    if (!cfg) {
      throw refuse(
        `sales day tenders: money account ${t.moneyAccountId} is not an active account for store ` +
          `${storeId} — a day may only report money into its own store's wallets`,
        "One of the wallets on this day isn't an active wallet of this store. Reload the page and try again.",
      );
    }
    if (seen.has(t.moneyAccountId)) {
      throw refuse(
        `sales day tenders: "${cfg.name}" appears twice — one row per wallet, summed by the caller`,
        `"${cfg.name}" appears twice — one row per wallet, summed by the caller.`,
      );
    }
    seen.add(t.moneyAccountId);
    // DEF-272: was a raw `money()` call — well-formed already, but its TypeError is a developer
    // message, not a written sentence. `parseMoneyInput` is the shared entry point that fixes that.
    // T-371 R6: a blank box is "nothing landed here" — no row, never a guessed '0'.
    const amount = parseDecimalInput(t.amount, '14,2', `sales day tenders: "${cfg.name}"'s amount`, `The amount for "${cfg.name}"`, {
      blank: 'omit',
    });
    // A typed zero says "nothing landed here", which is exactly what a blank box says: no row (a row of
    // zero would claim money moved). A negative is not a figure a wallet can receive.
    if (amount === undefined || isZero(amount)) continue;
    if (compare(amount, ZERO) < 0) {
      throw refuse(
        `sales day tenders: "${cfg.name}" carries ${amount} — a tender cannot be negative`,
        `The amount for "${cfg.name}" can't be negative. Leave it blank if no money landed there.`,
      );
    }
    rows.push({ moneyAccountId: t.moneyAccountId, amount });
  }

  await salesDaysRepo.replaceTenders(tx, salesDayId, rows);
}

/**
 * T-371 R6 — a sales day's twelve figures, parsed into `Money` in words. Shared by create and edit.
 *
 * The three revenue figures are NOT NULL with no default, so a blank is refused with a sentence. The
 * other nine are NOT NULL DEFAULT '0', so a blank (or an absent field) is `undefined`: the caller omits
 * it — the database default on insert, the stored figure kept on an edit. `'0'` is never invented here.
 */
export function parseSalesDayFigures(
  input: Omit<CreateSalesDayInput, 'storeId' | 'businessDate'>,
  fn: string,
): {
  totalSales: Money;
  unliSales: Money;
  alaCarteSales: Money;
  seniorDiscount: Money | undefined;
  pwdDiscount: Money | undefined;
  otherDiscount: Money | undefined;
  comps: Money | undefined;
  serviceCharge: Money | undefined;
  otherCharges: Money | undefined;
  cashCollected: Money | undefined;
  onlineCollected: Money | undefined;
  creditSales: Money | undefined;
} {
  const required = (value: string | undefined, label: string): Money =>
    parseDecimalInput(value, '14,2', `${fn}: ${label}`, label, { blank: 'refuse' });
  const defaulted = (value: string | undefined, label: string): Money | undefined =>
    parseDecimalInput(value, '14,2', `${fn}: ${label}`, label, { blank: 'omit' });
  return {
    totalSales: required(input.totalSales, 'Total sales'),
    unliSales: required(input.unliSales, 'Unli sales'),
    alaCarteSales: required(input.alaCarteSales, 'À la carte sales'),
    seniorDiscount: defaulted(input.seniorDiscount, 'Senior discount'),
    pwdDiscount: defaulted(input.pwdDiscount, 'PWD discount'),
    otherDiscount: defaulted(input.otherDiscount, 'Other discount'),
    comps: defaulted(input.comps, 'Comps'),
    serviceCharge: defaulted(input.serviceCharge, 'Service charge'),
    otherCharges: defaulted(input.otherCharges, 'Other charges'),
    cashCollected: defaulted(input.cashCollected, 'Cash collected'),
    onlineCollected: defaulted(input.onlineCollected, 'Online collected'),
    creditSales: defaulted(input.creditSales, 'Credit sales'),
  };
}

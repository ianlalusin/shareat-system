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
import { add, money, type Money } from '@shareat/core/money';
import { parseMoneyInput } from '../shared/money-input';

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
 *  a caller has a genuinely useful thing to do with it: send the user to that day. */
export class SalesDayBlockedError extends Error {
  constructor(
    message: string,
    readonly blockingDayId: string,
    readonly blockingBusinessDate: string,
  ) {
    super(message);
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
    throw new Error(
      `createSalesDay: a sales day already exists for store ${input.storeId} on ${input.businessDate} ` +
        `(status ${existing.status}) — edit it rather than creating a second`,
    );
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

  const figures = {
    totalSales: money(input.totalSales),
    unliSales: money(input.unliSales),
    alaCarteSales: money(input.alaCarteSales),
    seniorDiscount: money(input.seniorDiscount ?? '0'),
    pwdDiscount: money(input.pwdDiscount ?? '0'),
    otherDiscount: money(input.otherDiscount ?? '0'),
    comps: money(input.comps ?? '0'),
    serviceCharge: money(input.serviceCharge ?? '0'),
    otherCharges: money(input.otherCharges ?? '0'),
    cashCollected: money(input.cashCollected ?? '0'),
    onlineCollected: money(input.onlineCollected ?? '0'),
    creditSales: money(input.creditSales ?? '0'),
  };

  const posSourced = input.posSourced ?? false;
  const { id } = await salesDaysRepo.insertSalesDay(tx, {
    orgId: actor.orgId,
    storeId: input.storeId,
    businessDate: input.businessDate,
    posSourced,
    // Provenance is a pair or neither — a CHECK constraint enforces it too.
    posSourcedAt: posSourced ? new Date() : null,
    totalSales: String(figures.totalSales),
    unliSales: String(figures.unliSales),
    alaCarteSales: String(figures.alaCarteSales),
    seniorDiscount: String(figures.seniorDiscount),
    pwdDiscount: String(figures.pwdDiscount),
    otherDiscount: String(figures.otherDiscount),
    comps: String(figures.comps),
    serviceCharge: String(figures.serviceCharge),
    otherCharges: String(figures.otherCharges),
    cashCollected: String(figures.cashCollected),
    onlineCollected: String(figures.onlineCollected),
    creditSales: String(figures.creditSales),
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
      throw new Error(
        `sales day channels: channel ${c.channelId} is not configured for store ${storeId} — ` +
          `a day may only report channels its own store has`,
      );
    }
    const amount = money(c.amount);
    const noSales = c.noSales ?? false;
    if (noSales && Number(amount) !== 0) {
      throw new Error(
        `sales day channels: "${cfg.name}" is marked "no sales" but carries ${amount} — ` +
          `a confirmed zero and an amount are different claims`,
      );
    }
    return { channelId: c.channelId, amount: String(amount), noSales };
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
async function writeTenders(
  tx: Tx,
  actor: Actor,
  storeId: string,
  salesDayId: string,
  tenders: CreateSalesDayTenderInput[],
): Promise<void> {
  const available = await moneyAccountsRepo.listMoneyAccounts(tx, actor.orgId, { storeId });
  const byId = new Map(available.map((m) => [m.id, m]));

  const seen = new Set<string>();
  const rows = tenders.map((t) => {
    const cfg = byId.get(t.moneyAccountId);
    if (!cfg) {
      throw new Error(
        `sales day tenders: money account ${t.moneyAccountId} is not an active account for store ` +
          `${storeId} — a day may only report money into its own store's wallets`,
      );
    }
    if (seen.has(t.moneyAccountId)) {
      throw new Error(
        `sales day tenders: "${cfg.name}" appears twice — one row per wallet, summed by the caller`,
      );
    }
    seen.add(t.moneyAccountId);
    // DEF-272: was a raw `money()` call — well-formed already, but its TypeError is a developer
    // message, not a written sentence. `parseMoneyInput` is the shared entry point that fixes that.
    const amount = parseMoneyInput(t.amount, `sales day tenders: "${cfg.name}"'s amount`);
    if (Number(amount) <= 0) {
      throw new Error(
        `sales day tenders: "${cfg.name}" carries ${amount} — a tender row of zero says money ` +
          `moved and the amount was nothing, which is not a fact about anything. Omit the row`,
      );
    }
    return { moneyAccountId: t.moneyAccountId, amount: String(amount) };
  });

  await salesDaysRepo.replaceTenders(tx, salesDayId, rows);
}

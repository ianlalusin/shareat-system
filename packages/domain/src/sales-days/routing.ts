/**
 * routeSalesDay — a PURE function from a verified day's figures to balanced journal lines.
 * docs/tasks/123-sales-day.md §6, and `docs/POSTING-PATTERNS.md`'s five `sale.*` patterns.
 *
 * ## Look the patterns up; do not re-derive them
 *
 * `sale.unli.simple` · `sale.alacarte.simple` · `sale.discount.senior-pwd` · `sale.comps` ·
 * `sale.mixed` are already pinned and verified by T-108. This function is their generalisation and
 * must agree with every one of them.
 *
 * ## ⭐ The balance identity is THREE checks, not one
 *
 *   1. **Revenue side** — `unli + àlaCarte = totalSales`. Enforced by a CHECK constraint too, but
 *      re-asserted here so a caller gets a named reason rather than a constraint violation.
 *   2. **Channel side** — `Σ all channels = totalSales`, remitted and non-remitted together
 *      (Ian, bible row 133). ⚠️ **This one was missing from the first cut** and its absence let a
 *      smoketest pass a day whose channels summed to a ninth of its total.
 *   3. **Tender side** — `cash + online + credit + nonRemittedChannels + discounts + comps =
 *      totalSales`. **Cannot be a CHECK**, because the non-remitted channel amounts live in
 *      `sales_day_channels`; it spans two tables and belongs here.
 *
 * **A day failing either QUARANTINES rather than posting a guessed entry** — the same rule the
 * ETL applies to a leg it cannot map, and the same reason: a balanced-looking entry built from
 * figures that disagree with each other is worse than no entry, because it looks finished.
 *
 * ## ⚠️ v1 floors its derived cash at zero. We refuse instead
 *
 * `derive-totals.ts` computes cash as *"remitted channels − online − credit − other, floored at
 * 0"*. **Flooring hides exactly the case worth seeing**: a negative means the tender figures
 * disagree, which is a real signal about a real problem. Here it surfaces as a blocked posting.
 */
import { add, isZero, money, subtract, type Money } from '@shareat/core/money';

/** Where a sales day's money lands. Deliberately a named map rather than literals scattered
 *  through the routing logic — the same shape as EXPENSE_FUNDING_ACCOUNTS. */
export const SALES_DAY_ACCOUNTS = {
  /** Selling cash always enters the CASHIER's till first — never the office safe. The
   *  cashier/office owner split (bible row 127) arises on the REMITTANCE, not on the sale. */
  CASH_CASHIER: '1110',
  ONLINE: '1140',
  /** A sale on account. ⚠️ Not cash — v1's `creditSales`. */
  AR: '1210',
  UNLI: '4100',
  ALA_CARTE: '4150',
  /** Senior/PWD and other discounts. **Contra-revenue, confirmed by Ian** (bible row 132) —
   *  NOT the "Expenses – PWD Discounts" account BIR guidance points at. That divergence is
   *  deliberate and recorded; discovery 24 §4 explains the tax-vs-financial-reporting tension. */
  DISCOUNTS: '4900',
  /** ⚠️ Comps post HERE, not to 4900 and never to a marketing expense. Ian confirmed directly:
   *  comps are revenue foregone, not a cost incurred (bible row 74). */
  COMPS: '4950',
} as const;

export interface SalesDayChannelInput {
  channelId: string;
  channelName: string;
  isRemittedDaily: boolean;
  receivableAccountCode: string | null;
  amount: Money;
  noSales: boolean;
}

export interface RouteSalesDayInput {
  totalSales: Money;
  unliSales: Money;
  alaCarteSales: Money;
  seniorDiscount: Money;
  pwdDiscount: Money;
  otherDiscount: Money;
  comps: Money;
  cashCollected: Money;
  onlineCollected: Money;
  creditSales: Money;
  /** Every channel row on the day, remitted and not. */
  channels: SalesDayChannelInput[];
}

export interface RoutedLine {
  accountCode: string;
  side: 'debit' | 'credit';
  amount: Money;
  partyType?: 'customer' | 'channel' | null;
  partyId?: string | null;
  lineMemo?: string | null;
}

export type RouteSalesDayResult =
  | { ok: true; lines: RoutedLine[] }
  | { ok: false; reason: string };

export function routeSalesDay(input: RouteSalesDayInput): RouteSalesDayResult {
  // ── Check 1: the revenue side exhausts the total ─────────────────────────────────────
  const revenueSide = add(input.unliSales, input.alaCarteSales);
  if (!isZero(subtract(revenueSide, input.totalSales))) {
    return {
      ok: false,
      reason:
        `revenue split does not equal total sales: unli ${input.unliSales} + à la carte ` +
        `${input.alaCarteSales} = ${revenueSide}, but totalSales is ${input.totalSales}`,
    };
  }

  // ── Check 1b: the CHANNELS exhaust the total ─────────────────────────────────────────
  // ⭐ Ian, 2026-08-25: "total sales are all sales channel sum, remitted daily and un-remitted
  // daily combined." Confirmed at source — v1 derives `totalSales = channelsTotal + branchDelta`
  // (`derive-totals.ts:143`). ⚠️ This identity was MISSING from the first cut, and its absence let
  // a browser smoketest pass a day whose channels summed to ₱550 against a ₱6,000 total.
  //
  // Skipped entirely when NO channel rows exist: a day may legitimately report only its headline
  // figures before channels are configured, and a store with no channels must not be unable to
  // report at all. Once a single row exists, the breakdown is claiming to be the breakdown.
  if (input.channels.length > 0) {
    const channelsTotal = add(...input.channels.map((c) => c.amount));
    if (!isZero(subtract(channelsTotal, input.totalSales))) {
      return {
        ok: false,
        reason:
          `channel breakdown does not equal total sales: the channels sum to ${channelsTotal}, ` +
          `but totalSales is ${input.totalSales}. Every channel's takings are part of the total — ` +
          `remitted and non-remitted alike`,
      };
    }
  }

  // ── Non-remitted channels: money that never reaches the till ─────────────────────────
  // ⚠️ Resolved by JOINING the channel's own configuration, never by a name match. DEF-059 is
  // what v1's substring fallback on "dine" costs: a channel it cannot resolve silently drops
  // its sales. Here an unwired channel BLOCKS.
  const receivableLines: RoutedLine[] = [];
  let nonRemittedTotal = money('0');
  for (const c of input.channels) {
    if (c.isRemittedDaily) continue;
    if (isZero(c.amount)) continue;
    if (!c.receivableAccountCode) {
      return {
        ok: false,
        reason:
          `channel "${c.channelName}" is not remitted daily but has no receivable account ` +
          `configured — its ${c.amount} would otherwise be silently lost (DEF-059)`,
      };
    }
    nonRemittedTotal = add(nonRemittedTotal, c.amount);
    receivableLines.push({
      accountCode: c.receivableAccountCode,
      side: 'debit',
      amount: c.amount,
      partyType: 'channel',
      partyId: c.channelId,
      lineMemo: `${c.channelName} receivable`,
    });
  }

  const discountsTotal = add(input.seniorDiscount, input.pwdDiscount, input.otherDiscount);

  // ── Check 2: the tender side exhausts the total ──────────────────────────────────────
  const tenderSide = add(
    input.cashCollected,
    input.onlineCollected,
    input.creditSales,
    nonRemittedTotal,
    discountsTotal,
    input.comps,
  );
  if (!isZero(subtract(tenderSide, input.totalSales))) {
    return {
      ok: false,
      reason:
        `tender split does not equal total sales: cash ${input.cashCollected} + online ` +
        `${input.onlineCollected} + credit ${input.creditSales} + non-remitted channels ` +
        `${nonRemittedTotal} + discounts ${discountsTotal} + comps ${input.comps} = ${tenderSide}, ` +
        `but totalSales is ${input.totalSales}`,
    };
  }

  // ── Lines: debits (tender + contra-revenue) first, credits (revenue) last ────────────
  // The order POSTING-PATTERNS.md's sale.mixed uses, and the shape every module copies.
  const lines: RoutedLine[] = [];

  if (!isZero(input.cashCollected)) {
    lines.push({ accountCode: SALES_DAY_ACCOUNTS.CASH_CASHIER, side: 'debit', amount: input.cashCollected });
  }
  if (!isZero(input.onlineCollected)) {
    lines.push({ accountCode: SALES_DAY_ACCOUNTS.ONLINE, side: 'debit', amount: input.onlineCollected });
  }
  if (!isZero(input.creditSales)) {
    // ⚠️ 1210 has requires_party — the posting trigger rejects a line without one regardless;
    // naming the reason here surfaces it earlier and more usefully than a constraint violation.
    return {
      ok: false,
      reason:
        `credit sales of ${input.creditSales} need a customer to owe the money, and a sales DAY ` +
        `has no customer — 1210 requires a party (T-118). Credit sales belong to AR (T-131), ` +
        `not to a daily summary. Record them there instead of guessing a counterparty here`,
    };
  }
  lines.push(...receivableLines);

  if (!isZero(discountsTotal)) {
    lines.push({
      accountCode: SALES_DAY_ACCOUNTS.DISCOUNTS,
      side: 'debit',
      amount: discountsTotal,
      lineMemo: 'senior, PWD and other discounts',
    });
  }
  if (!isZero(input.comps)) {
    lines.push({ accountCode: SALES_DAY_ACCOUNTS.COMPS, side: 'debit', amount: input.comps, lineMemo: 'comps' });
  }

  if (!isZero(input.unliSales)) {
    lines.push({ accountCode: SALES_DAY_ACCOUNTS.UNLI, side: 'credit', amount: input.unliSales });
  }
  if (!isZero(input.alaCarteSales)) {
    lines.push({ accountCode: SALES_DAY_ACCOUNTS.ALA_CARTE, side: 'credit', amount: input.alaCarteSales });
  }

  if (lines.length === 0) {
    return { ok: false, reason: 'a sales day with no figures at all has nothing to post' };
  }

  return { ok: true, lines };
}

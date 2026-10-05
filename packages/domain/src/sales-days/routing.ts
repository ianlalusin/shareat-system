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
 * ## ⭐ v2 records GROSS, with discounts and charges on their own lines
 *
 * Ian, 2026-08-25: v1's pull is net — *"so discounts and charges are accounted"* — **but for v2**
 * *"it is better to include discounts and charges in the sales report so they both have clear
 * lines and the data can easily be used."* So `totalSales` here is **gross food revenue**, and
 * every adjustment to it is a line somebody can read.
 *
 * ## ⭐ The two kinds of "charge", and only ONE of them is yours
 *
 *   - **Other charges — leftover, packaging, similar → 4500, INCOME.** The business keeps these.
 *   - **Service charge → 2160, a FLOAT.** Not revenue, and not accounts payable.
 *
 * Ian ruled out both alternatives and was right on each. *"Don't push to accounts payable"* — AP
 * is money owed to SUPPLIERS, with a party, an age and a payment process, and this is none of
 * those. And *"it will bloat the revenue"* — it would: ₱1M of food plus ₱100k of service charge
 * would read as ₱1.1M of income, ₱100k of which was never the business's money.
 *
 * ⭐ **So it touches neither.** The float fills on collection and empties when payroll distributes
 * it (RA 11360: 100% to rank-and-file staff, at least twice a month). **No revenue on the way in
 * and no expense on the way out** — money that was never yours cannot be a cost when you hand it
 * over. That also removes the timing problem a revenue treatment would have created, where
 * collection and distribution landing in different months makes a month-end read rich.
 *
 * ## "Can it just not touch accounting?" — no, and here is why the float is the closest thing
 *
 * **It cannot be kept out entirely: the cash physically enters the drawer.** A customer paying
 * ₱1,100 on a ₱1,000 bill leaves ₱1,100 in the till, so books recording ₱1,000 never reconcile
 * against a count. It has to land somewhere; the only question is where. **The float is the
 * treatment that touches accounting least** — balance sheet only, invisible to the P&L, and it
 * clears itself.
 *
 * ## How the field handles it — and why PH is the exception
 *
 * Practice draws the line at **whose money it is**, not at what the line is called on the bill:
 *
 *   - **Tips** — voluntary, belong to staff → **a liability clearing account** ("Tips Payable",
 *     other current liabilities), cleared through payroll. *"Since tips do not belong to the
 *     restaurant, the deposit should be accounted for as a liability."*
 *   - **Service charges** — mandatory, and elsewhere they are the RESTAURANT's money to
 *     distribute or not → **revenue**, with the payout as **wage expense**.
 *
 * ⭐ **RA 11360 moves PH service charge across that line.** With 100% distribution mandated, the
 * restaurant has no discretion and the money is not its own — so it behaves like TIPS do
 * elsewhere, and takes the tips treatment. **This is not an invention; it is the standard pattern
 * applied to the case the law actually creates.**
 *
 * ⚠️ If Ian's accountant prefers the international service-charge reading, the change is one line:
 * point this constant at an income account instead. The decision is recorded, not buried.
 *
 * ⚠️ **See DEF-061.** POS's endpoint reads a gross field and *falls back to a net computation
 * when it has not been backfilled*, with nothing to tell the caller which it returned — so a day's
 * figures may not be on the basis this module assumes. **The reconciliation below is the
 * protection**: net figures arriving where gross is expected fail loudly rather than posting
 * revenue on one basis and cash on another.
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
  /** T-375 (W11): POS refunds of a day - contra-revenue, the account comps use, never comps themselves. */
  REFUNDS: '4950',
  /** ⭐ A FLOAT, not revenue and not AP. It fills on collection and empties when payroll
   *  distributes it, and touches the P&L at neither end (bible row 135). */
  SERVICE_CHARGE_FLOAT: '2160',
  /** Leftover, packaging and similar. The business KEEPS these, so unlike service charge they
   *  really are income (Ian: "all in one account, separated from service charge"). */
  OTHER_CHARGES: '4500',
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
  /** ⭐ Held, not earned. Neither revenue nor AP — see this file's header (bible row 135). */
  serviceCharge: Money;
  /** Leftover, packaging and similar. The business keeps these: income. */
  otherCharges: Money;
  cashCollected: Money;
  onlineCollected: Money;
  creditSales: Money;
  /**
   * T-375 (R4, W11): POS refunds of the day, paid out of the cash drawer. On the COLLECTED side of check 3 (cash
   * collected is already net of them) and posted as a `Dr 4950` line. Absent = 0: a legacy typed day never has any.
   */
  refunds?: Money;
  /** Every channel row on the day, remitted and not. */
  channels: SalesDayChannelInput[];
  /** ⭐ WHERE the online money landed — one row per money account (DEF-068, bible row 148).
   *
   *  ⚠️ NOT the same axis as `channels`. A channel says where the sale came FROM (Walk-in,
   *  Foodpanda); a tender says where the money WENT (GCash-cashier, BDO-office). A Foodpanda sale
   *  can settle into any wallet, so neither answers the other's question — and v2 modelled only
   *  the first until DEF-068. */
  tenders: SalesDayTenderInput[];
}

export interface SalesDayTenderInput {
  moneyAccountId: string;
  amount: Money;
}

export interface RoutedLine {
  accountCode: string;
  side: 'debit' | 'credit';
  amount: Money;
  partyType?: 'customer' | 'channel' | 'money_account' | null;
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

  // ── Check 3: what was COLLECTED reconciles to gross revenue plus charges ─────────────
  // Everything taken in, plus everything given away, must equal everything earned:
  //   collected + discounts + comps  =  gross sales + service charge + other charges
  // ⚠️ Charges sit on the RIGHT because they are amounts the customer additionally owed — the
  // service charge on behalf of the staff, the other charges on the business's own account.
  const discountsTotal = add(input.seniorDiscount, input.pwdDiscount, input.otherDiscount);
  const refunds = input.refunds ?? money('0');
  const collectedSide = add(
    input.cashCollected,
    input.onlineCollected,
    input.creditSales,
    nonRemittedTotal,
    discountsTotal,
    input.comps,
    refunds,
  );
  const earnedSide = add(input.totalSales, input.serviceCharge, input.otherCharges);
  if (!isZero(subtract(collectedSide, earnedSide))) {
    return {
      ok: false,
      reason:
        `the day does not reconcile: collected ${input.cashCollected} cash + ` +
        `${input.onlineCollected} online + ${input.creditSales} credit + ${nonRemittedTotal} ` +
        `non-remitted, plus ${discountsTotal} discounts + ${input.comps} comps + ${refunds} refunds = ${collectedSide}; ` +
        `but gross sales ${input.totalSales} + service charge ${input.serviceCharge} + other ` +
        `charges ${input.otherCharges} = ${earnedSide}`,
    };
  }

  // ── Lines: debits (tender + contra-revenue) first, credits (revenue) last ────────────
  // The order POSTING-PATTERNS.md's sale.mixed uses, and the shape every module copies.
  const lines: RoutedLine[] = [];

  if (!isZero(input.cashCollected)) {
    lines.push({ accountCode: SALES_DAY_ACCOUNTS.CASH_CASHIER, side: 'debit', amount: input.cashCollected });
  }
  if (!isZero(input.onlineCollected)) {
    // ⭐ ONE LEG PER WALLET, never one lump to 1140. Since ADR-010, 1140 is a control account
    // keyed by the money account — so a day that cannot say which wallet its online money reached
    // cannot post at all. That is deliberate: collections are the largest inflow, so unattributed
    // online sales would make "how much is in the cashier's hands" wrong by exactly the amount
    // that matters most, and undeposited funds (bible row 143) is defined from that figure.
    const tendersTotal = input.tenders.length === 0 ? money('0') : add(...input.tenders.map((t) => t.amount));
    if (!isZero(subtract(tendersTotal, input.onlineCollected))) {
      return {
        ok: false,
        reason:
          `the online tender breakdown does not equal online collected: the wallets sum to ` +
          `${tendersTotal}, the day reports ${input.onlineCollected}`,
      };
    }
    for (const t of input.tenders) {
      lines.push({
        accountCode: SALES_DAY_ACCOUNTS.ONLINE,
        side: 'debit',
        amount: t.amount,
        partyType: 'money_account',
        partyId: t.moneyAccountId,
      });
    }
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
  if (!isZero(refunds)) {
    lines.push({ accountCode: SALES_DAY_ACCOUNTS.REFUNDS, side: 'debit', amount: refunds, lineMemo: 'refunds (POS)' });
  }

  if (!isZero(input.unliSales)) {
    lines.push({ accountCode: SALES_DAY_ACCOUNTS.UNLI, side: 'credit', amount: input.unliSales });
  }
  if (!isZero(input.alaCarteSales)) {
    lines.push({ accountCode: SALES_DAY_ACCOUNTS.ALA_CARTE, side: 'credit', amount: input.alaCarteSales });
  }

  if (!isZero(input.otherCharges)) {
    lines.push({
      accountCode: SALES_DAY_ACCOUNTS.OTHER_CHARGES,
      side: 'credit',
      amount: input.otherCharges,
      lineMemo: 'leftover, packaging and similar charges',
    });
  }
  if (!isZero(input.serviceCharge)) {
    lines.push({
      accountCode: SALES_DAY_ACCOUNTS.SERVICE_CHARGE_FLOAT,
      side: 'credit',
      amount: input.serviceCharge,
      lineMemo: 'service charge float — held for staff, distributed via payroll (RA 11360)',
    });
  }

  if (lines.length === 0) {
    return { ok: false, reason: 'a sales day with no figures at all has nothing to post' };
  }

  return { ok: true, lines };
}

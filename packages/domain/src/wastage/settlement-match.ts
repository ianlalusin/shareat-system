/**
 * Settlement-match — reconciling open order wastages against T-150's channel settlement. T-178
 * §4/§9. ⛔ **This module is PURE: it takes no `Tx`, reads nothing, writes nothing** (invariant
 * 9). It PROPOSES; a manager disposes by calling `resolveOrderWastage` with `platform_paid` (or
 * whatever disposition they actually decide on) after reading the proposal (invariant 7).
 *
 * ## ⚠️ Why the match is at CHANNEL-DAY granularity, not per order
 *
 * `docs/tasks/150-channel-settlement.md` §Contract/§Out-of-scope is explicit: one settlement row
 * clears one channel's ENTIRE verified sales day, aggregated (`grossAmount`, six deduction
 * columns, `netDeposited`) — there is no per-order line item, and building one would be the
 * second settlement parser this task is expressly forbidden from building (task §4).
 *
 * So a "match" here is: *does a POSTED settlement exist for this wastage's channel and business
 * date?* If so, the wastage is proposed for review ALONGSIDE that settlement's own numbers — the
 * gross, the deductions, the variance — so a human can judge whether the platform's payout
 * already accounted for this order (mark it `platform_paid`) or genuinely still leaves the store
 * or a person holding the cost (`absorbed`/`charged`, through the ordinary resolve path). The
 * matcher does not try to be cleverer than the data it has.
 */
// ⚠️ Imported, not redefined — channel-settlements/index.ts is the ONE place this shape is
// declared (it is what exposes T-150's parsed deductions in the first place). Redeclaring an
// identical interface here collided under `export * from` in the package barrel (two same-named
// exports), which is exactly the kind of drift a single source of truth avoids.
import type { PostedSettlementSummary } from '../channel-settlements';
import { compare, money, ZERO } from '@shareat/core/money';

export interface SettleableOrderWastage {
  wastageId: string;
  storeId: string;
  /** ⭐ T-230 — the match key. See the matcher's own note on why it is not the name. */
  channelId: string;
  /** Display only, in the rationale sentence. */
  channel: string;
  /** The channel-day this wastage's `sales_day_id` resolves to. */
  businessDate: string;
  amount: string;
  orderRef: string | null;
  status: 'open' | 'disputed';
}

export interface SettlementMatchCandidate {
  wastageId: string;
  settlementId: string;
  storeId: string;
  channel: string;
  businessDate: string;
  amount: string;
  rationale: string;
}

/**
 * Every open/disputed wastage that shares a store, channel and business date with a POSTED
 * settlement — one candidate per wastage, carrying the settlement's own figures for a human to
 * read alongside it. Order-preserving, no dedupe surprises: one settlement summary is expected
 * per (store, channel, businessDate) — T-150 invariant 10 already enforces that at the DB.
 */
export function matchWastagesToSettlement(
  wastages: SettleableOrderWastage[],
  settlements: PostedSettlementSummary[],
): SettlementMatchCandidate[] {
  // ⭐ T-230 — keyed on the channel ID, not its name. Renaming a channel used to silently stop
  // matching open wastages to the settlement that covers them: the wastage kept the old name, the
  // settlement summary reported the new one, and the proposal simply never appeared. A missing
  // proposal is invisible, which is the worst shape a defect can take here.
  // ⛔ A missing key is REFUSED, loudly, and this guard is not defensive padding — it is the
  // remedy for a defect this module already suffered once. `/wastage`'s list page built these
  // literals without `channelId` and typecheck stayed CLEAN, because a
  // `(w): w is SettleableOrderWastage` type predicate on the caller's `.filter()` asserted the
  // shape instead of checking it. The key silently became `store|undefined|date`, so the page
  // stopped proposing matches for good — and a proposal that never appears is invisible: nobody
  // can notice a settlement they were never shown. A pure function's only defence is to refuse.
  for (const s of settlements) {
    if (!s.channelId) {
      throw new Error(
        `matchWastagesToSettlement: settlement ${s.settlementId} arrived with no channelId. ` +
          'Matching is keyed on the channel id, so this would silently propose nothing rather than fail.',
      );
    }
  }
  for (const w of wastages) {
    if (!w.channelId) {
      throw new Error(
        `matchWastagesToSettlement: wastage ${w.wastageId} arrived with no channelId. ` +
          'Matching is keyed on the channel id, so this would silently propose nothing rather than fail.',
      );
    }
  }

  const byKey = new Map<string, PostedSettlementSummary>();
  for (const s of settlements) {
    byKey.set(`${s.storeId}|${s.channelId}|${s.businessDate}`, s);
  }

  const candidates: SettlementMatchCandidate[] = [];
  for (const w of wastages) {
    const settlement = byKey.get(`${w.storeId}|${w.channelId}|${w.businessDate}`);
    if (!settlement) continue;
    candidates.push({
      wastageId: w.wastageId,
      settlementId: settlement.settlementId,
      storeId: w.storeId,
      channel: w.channel,
      businessDate: w.businessDate,
      amount: w.amount,
      rationale:
        `${settlement.channel} settled ${w.businessDate} — gross ${settlement.grossAmount}, ` +
        `net deposited ${settlement.netDeposited}` +
        (compare(money(settlement.variance), ZERO) > 0 ? `, a ${settlement.variance} shortfall was already swept to expense` : '') +
        (compare(money(settlement.settlementGain), ZERO) > 0 ? `, a ${settlement.settlementGain} gain was already recognised` : '') +
        `. Review against this wastage's ${w.amount} before marking it paid.`,
    });
  }
  return candidates;
}

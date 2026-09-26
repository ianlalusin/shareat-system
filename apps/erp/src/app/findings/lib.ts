/**
 * Server-only helpers for `/findings`. T-135's surface — see DEF-084 for why it arrived late.
 *
 * ⭐ **Every figure here is DERIVED on read.** There is no findings table and no stored count:
 * the feed asks the ledger its questions each time the page loads, which is why a finding cannot
 * be "resolved" while it is still true.
 */
import {
  closeReadiness,
  lastCompletedPeriod,
  listFindings,
  logFindingView,
  managerScorecard,
} from '@shareat/domain';
import { storesRepo } from '@shareat/db';
import { withOrgPrincipal } from '../expenses/lib';

export { peso } from '../../lib/format';
export { withOrgPrincipal } from '../expenses/lib';

/**
 * The month the periodic-posting detectors ask about.
 *
 * ⚠️ **The last COMPLETED month, not the current one.** Asking "did depreciation run for the month
 * we are still in" would fire on the 1st of every month and be wrong for thirty days — the
 * schedule has not missed anything until the month it was for is over.
 *
 * ⛔ DEF-283: this used to be a second, independent, raw-UTC implementation of the same idea as
 * `@shareat/domain`'s `lastCompletedPeriod`. Two copies of one rule is what produced the defect —
 * re-exported from the sanctioned one instead (bible §8 rule 13: apps depend on packages).
 */
export { lastCompletedPeriod };

/**
 * Twelve months back from the last completed one — enough to close a late period, not a scroll.
 *
 * Derived from `lastCompletedPeriod` by walking the `YYYY-MM` string back one month at a time, so
 * this never re-derives the business month itself and cannot drift from it — the exact trap DEF-283
 * describes: fixing the default without fixing this list opens the page on a month it rejects.
 */
export function selectablePeriods(now = new Date()): string[] {
  const out: string[] = [];
  let period = lastCompletedPeriod(now);
  for (let i = 0; i < 12; i++) {
    out.push(period);
    period = previousPeriod(period);
  }
  return out;
}

/** One month before a `YYYY-MM` period string, rolling the year back at January. */
function previousPeriod(period: string): string {
  const [yStr, mStr] = period.split('-');
  const y = Number(yStr);
  const m = Number(mStr);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

/**
 * The feed and the close verdict, from ONE call each, in one transaction.
 *
 * ⛔ **`closeReadiness` is not recomputed here.** The task spec's own rule: the close checker and
 * the findings feed are one machine, or they disagree on the 15th.
 */
export async function findingsFor(orgId: string, period: string) {
  return withOrgPrincipal(orgId, async (tx) => {
    const feed = await listFindings(tx, orgId, { period });
    const readiness = await closeReadiness(tx, orgId, period);
    return { feed, readiness };
  });
}

/** ⭐ `hard` before `soft` — a list becomes a queue. Within a severity, open before acknowledged. */
export function bySeverityThenStatus<T extends { severity: 'hard' | 'soft'; status: string }>(
  a: T,
  b: T,
): number {
  if (a.severity !== b.severity) return a.severity === 'hard' ? -1 : 1;
  if (a.status !== b.status) return a.status === 'open' ? -1 : 1;
  return 0;
}

/** Human labels. ⚠️ The KIND is still shown beside it — a label can drift, a kind is the key. */
export const KIND_LABEL: Record<string, string> = {
  trialBalanceDoesNotTie: 'Trial balance does not tie',
  dueFromDueToNotReciprocal: 'Due-from and due-to disagree',
  subledgerDoesNotMatchControl: 'Control account has unattributed lines',
  openingBalanceEquityNonZero: 'Opening balance equity is not zero',
  clearingAccountNotAtRest: 'Clearing account not at rest',
  depreciationNotBooked: 'Depreciation not booked',
  amortisationNotBooked: 'Amortisation not booked',
  unremittedCeilingBreached: 'Un-remitted cash over the ceiling',
  remittanceOverdue: 'Remittance overdue',
  serviceChargeFloatAgeing: 'Service-charge float ageing',
  tillFloatOffTarget: 'Till float off its target',
  tillCountVarianceOpen: 'Counted variance on a closed shift',
  itemHasNoThreshold: 'Items with no reorder threshold',
  fiscalPeriodRunwayLow: 'Fiscal period coverage running low',
  payoutIntervalTooLong: 'Pay cycle exceeds the sixteen-day ceiling',
  attendanceConfigMissing: 'No pay-cycle policy configured',
  openingDateContradicted: 'Opening date contradicted by recorded sales',
  assetHeldPastOpening: 'Asset waiting on its store to open',
};

/**
 * ⭐ T-214 — record that someone opened this screen.
 *
 * ⚠️ **A write on a read path, so it is deliberately forgiving.** The view log is accountability;
 * the page is the work. A failure here — a lost connection, a constraint we did not foresee — must
 * never cost somebody the screen they came to use, so it is swallowed and logged rather than thrown.
 * ⛔ That is the one place in this codebase where swallowing an error is correct, and it is correct
 * only because nothing downstream depends on the row existing.
 */
export async function noteFindingView(orgId: string, personId: string): Promise<void> {
  try {
    await withOrgPrincipal(orgId, (tx) => logFindingView(tx, orgId, personId));
  } catch (err) {
    console.error('[findings] view log failed, page continues:', err);
  }
}

/** The scorecard's window. Defaults to the trailing 90 days, in Manila. */
export function scorecardRange(now = new Date()): { from: string; to: string } {
  const manila = new Date(now.getTime() + 8 * 3_600_000);
  const to = manila.toISOString().slice(0, 10);
  const from = new Date(manila.getTime() - 89 * 86_400_000).toISOString().slice(0, 10);
  return { from, to };
}

export async function scorecardFor(orgId: string, range: { from: string; to: string }) {
  return withOrgPrincipal(orgId, async (tx) => {
    const card = await managerScorecard(tx, orgId, range);
    const stores = await storesRepo.listForOrg(tx, orgId);
    return { card, storeName: new Map(stores.map((s) => [s.id, `${s.code} — ${s.name}`])) };
  });
}

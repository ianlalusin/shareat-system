/**
 * Server-only helpers for `/findings`. T-135's surface — see DEF-084 for why it arrived late.
 *
 * ⭐ **Every figure here is DERIVED on read.** There is no findings table and no stored count:
 * the feed asks the ledger its questions each time the page loads, which is why a finding cannot
 * be "resolved" while it is still true.
 */
import { closeReadiness, listFindings } from '@shareat/domain';
import { withOrgPrincipal } from '../expenses/lib';

export { peso } from '../../lib/format';
export { withOrgPrincipal } from '../expenses/lib';

/**
 * The month the periodic-posting detectors ask about.
 *
 * ⚠️ **The last COMPLETED month, not the current one.** Asking "did depreciation run for the month
 * we are still in" would fire on the 1st of every month and be wrong for thirty days — the
 * schedule has not missed anything until the month it was for is over.
 */
export function lastCompletedPeriod(now = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  d.setUTCMonth(d.getUTCMonth() - 1);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Twelve months back from the last completed one — enough to close a late period, not a scroll. */
export function selectablePeriods(now = new Date()): string[] {
  const out: string[] = [];
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  for (let i = 0; i < 12; i++) {
    d.setUTCMonth(d.getUTCMonth() - 1);
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
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
};

import { auth } from '@/lib/firebase/client';
import { statutoryInputOf, type StatutorySession } from './session';
import { statutoryPaymentBlockers } from './capture';
import type { SessionBillLine } from '@/lib/types';

/** Run before reserving a sale number or writing any sale. A blocked points reward must be reversed online. */
export async function assertStatutoryPaymentReady(input: { storeId: string; session: StatutorySession;
  lines: SessionBillLine[]; loyalty: { redemptionId: string }[]; offline?: boolean }): Promise<void> {
  const statutory = statutoryInputOf(input.session);
  if (!statutory) return;
  const blockers = statutoryPaymentBlockers({ ...statutory, lines: input.lines, loyaltyRedemptions: input.loyalty });
  const first = blockers[0];
  if (!first) return;
  const releases = blockers.flatMap(blocker => blocker.releaseRedemptionIds ?? []);
  if (releases.length) {
    if (input.offline) throw new Error(`${first.message} Connect to the internet to release the points before payment.`);
    try {
      const token = await auth.currentUser?.getIdToken();
      if (!token) throw new Error('Sign in again.');
      for (const redemptionId of new Set(releases)) {
        const response = await fetch('/api/loyalty/redeem', { method: 'DELETE',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ storeId: input.storeId, redemptionId, reason: 'statutory-no-remainder' }) });
        const body = await response.json();
        if (!response.ok || body?.ok !== true) throw new Error('Release not confirmed.');
      }
    } catch { throw new Error(`${first.message} Could not confirm that all points were released. Check the rewards online before payment.`); }
    throw new Error(`${first.message} The points redemption has been released. Review the bill and try again.`);
  }
  throw new Error(first.message);
}

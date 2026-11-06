'use server';

/**
 * T-511 S5b - the review screen's server actions: reject a staged settlement day, reopen a rejected one (administrators), and pin a Grab day's loan
 * deductions to loans (administrators). Thin adapters: the actor comes from the session, never the form; the domain does the gate, the typed-field rules
 * and the compare-and-set, and a refusal reaches the person as its own sentence. One database transaction per call. Nothing here books anything.
 */
import { overrideLoanAllocation, rejectDay, reopenDay } from '@shareat/domain';
import { requireActor } from '../../../lib/session';
import { errorMessage } from '@/lib/constraint-messages';
import { redirectWithFlash, type Nav } from '@/lib/flash';
import { withOrgPrincipal } from '../lib';

const REVIEW = '/channel-settlements/review';

function text(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v : '';
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERIOD = /^\d{4}-\d{2}$/;

/** Where to go back to: the day, plus the page's filters as the form posted them (a closed set of shapes; anything else is dropped, never passed on). */
function navOf(fd: FormData, lineId: string): Nav {
  const nav: Nav = { day: lineId };
  const store = text(fd, 'store').trim();
  const platform = text(fd, 'platform').trim();
  const period = text(fd, 'period').trim();
  if (UUID.test(store)) nav.store = store;
  if (platform === 'grab' || platform === 'foodpanda') nav.platform = platform;
  if (PERIOD.test(period)) nav.period = period;
  if (text(fd, 'needs').trim() === '1') nav.needs = '1';
  return nav;
}

export async function rejectDayAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const lineId = text(formData, 'lineId').trim();
  const nav = navOf(formData, lineId);
  try {
    await withOrgPrincipal(actor.orgId, (tx) => rejectDay(tx, actor, { lineId, reason: text(formData, 'reason') }));
  } catch (err) {
    return await redirectWithFlash(REVIEW, nav, { error: errorMessage(err) });
  }
  return await redirectWithFlash(REVIEW, nav, { ok: 'Day rejected. Nothing was booked. An administrator can reopen it.' });
}

export async function reopenDayAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const lineId = text(formData, 'lineId').trim();
  const nav = navOf(formData, lineId);
  try {
    await withOrgPrincipal(actor.orgId, (tx) => reopenDay(tx, actor, { lineId }));
  } catch (err) {
    return await redirectWithFlash(REVIEW, nav, { error: errorMessage(err) });
  }
  return await redirectWithFlash(REVIEW, nav, { ok: 'Day reopened. It is waiting for a decision again.' });
}

/** The form posts `loanId` and `amount` side by side, one pair per loan; a pair with both boxes empty is ignored. */
export async function overrideLoanAllocationAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const lineId = text(formData, 'lineId').trim();
  const nav = navOf(formData, lineId);
  const loanIds = formData.getAll('loanId');
  const amounts = formData.getAll('amount');
  const allocations = loanIds
    .map((loanId, i) => ({ loanId: typeof loanId === 'string' ? loanId.trim() : '', amount: typeof amounts[i] === 'string' ? (amounts[i] as string).trim() : '' }))
    .filter((a) => a.loanId !== '' || a.amount !== '');
  try {
    await withOrgPrincipal(actor.orgId, (tx) => overrideLoanAllocation(tx, actor, { lineId, allocations }));
  } catch (err) {
    return await redirectWithFlash(REVIEW, nav, { error: errorMessage(err) });
  }
  return await redirectWithFlash(REVIEW, nav, { ok: 'Loan allocation saved. Nothing was booked.' });
}

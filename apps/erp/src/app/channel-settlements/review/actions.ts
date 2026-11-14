'use server';

/**
 * T-511 S5b, S7b - the review screen's server actions: approve a staged settlement day (this books it), book a charge that belongs to no day, reject a day, reopen a
 * rejected one (administrators), and pin a Grab day's loan deductions to loans (administrators). Thin adapters: the actor comes from the session, never the form; the
 * domain does the gate, the typed-field rules and the compare-and-set, and a refusal reaches the person as its own sentence. One database transaction per call.
 * Approve is the one action with a second answer: when the payout differs from the day by more than the tolerance the domain asks for a reason, and the page is
 * shown again with that question (the nav key `ack`) and no error banner.
 */
import { SettlementIntakeRefusal, approveDay, bookPeriodCharge, overrideLoanAllocation, rejectDay, reopenDay } from '@shareat/domain';
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
const NOT_FOUND = 'That item could not be found.';

/** Where to go back to: the day, plus the page's filters as the form posted them (a closed set of shapes; anything else is dropped, never passed on). */
function navOf(fd: FormData, lineId: string): Nav {
  const nav: Nav = UUID.test(lineId) ? { day: lineId } : {};
  const store = text(fd, 'store').trim();
  const platform = text(fd, 'platform').trim();
  const period = text(fd, 'period').trim();
  if (UUID.test(store)) nav.store = store;
  if (platform === 'grab' || platform === 'foodpanda') nav.platform = platform;
  if (PERIOD.test(period)) nav.period = period;
  if (text(fd, 'needs').trim() === '1') nav.needs = '1';
  return nav;
}

export async function approveDayAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const lineId = text(formData, 'lineId').trim();
  const nav = navOf(formData, lineId);
  const differenceReason = text(formData, 'reason');
  const confirmedDifference = text(formData, 'confirmedDifference').trim();
  if (!UUID.test(lineId)) return await redirectWithFlash(REVIEW, nav, { error: NOT_FOUND });
  try {
    await withOrgPrincipal(actor.orgId, (tx) =>
      approveDay(tx, actor, { lineId, ...(differenceReason.trim() === '' ? {} : { differenceReason }), ...(confirmedDifference === '' ? {} : { confirmedDifference }) }),
    );
  } catch (err) {
    // the books ask for the approver's reason: the page asks it, with the figure; this is a question, not an error banner
    if (err instanceof SettlementIntakeRefusal && err.code === 'NEEDS_REASON') {
      const { difference, sign } = err as SettlementIntakeRefusal & { difference: string; sign: string };
      return await redirectWithFlash(REVIEW, { ...nav, ack: `${sign}-${difference}` });
    }
    return await redirectWithFlash(REVIEW, nav, { error: errorMessage(err) });
  }
  return await redirectWithFlash(REVIEW, nav, { ok: "Booked. The day's payout is on the books and the sales figure now matches the file.", stamp: 'POSTED' });
}

/** Books one charge that belongs to no sales day (a Foodpanda statement charge); the payout of the invoice's last day then settles it. */
export async function bookChargeAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const otherLineId = text(formData, 'otherLineId').trim();
  const nav = navOf(formData, text(formData, 'lineId').trim());
  if (!UUID.test(otherLineId)) return await redirectWithFlash(REVIEW, nav, { error: NOT_FOUND });
  let posted = true;
  try {
    posted = (await withOrgPrincipal(actor.orgId, (tx) => bookPeriodCharge(tx, actor, { otherLineId }))).posted;
  } catch (err) {
    return await redirectWithFlash(REVIEW, nav, { error: errorMessage(err) });
  }
  // a second press on a charge that is already booked books nothing, so it says so and carries no stamp
  if (!posted) return await redirectWithFlash(REVIEW, nav, { ok: 'This charge was already booked.' });
  return await redirectWithFlash(REVIEW, nav, { ok: 'Charge booked.', stamp: 'POSTED' });
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

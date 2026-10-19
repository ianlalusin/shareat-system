'use server';

/**
 * Server actions for the order/channel wastage screens — T-178.
 *
 * Thin adapters. ⛔ No rule is re-implemented here — every domain function (`recordOrderWastage`,
 * `disputeOrderWastage`, `resolveOrderWastage`, `reverseAutoCharge`) authorises itself as its own
 * first statement, unlike `commissary/discrepancies` where the action authorised. That difference
 * is deliberate here: `resolveOrderWastage` is also the function the 15-day backstop's own
 * scheduler job calls indirectly through `runOrderWastageBackstop`, so the authorisation belongs
 * with the rule, not scattered across every caller.
 */
import { redirectWithFlash } from '@/lib/flash';
import { revalidatePath } from 'next/cache';
import { salesDaysRepo, type OrderWastageDisposition } from '@shareat/db';
import { toBusinessDate } from '@shareat/core/datetime';
import {
  disputeOrderWastage,
  recordOrderWastage,
  resolveOrderWastage,
  reverseAutoCharge,
  assertFieldRules,
} from '@shareat/domain';
import { WASTAGE_RECORD_RULES, WASTAGE_REVERSE_RULES } from '@shareat/domain/field-rules';
import { requireActor } from '../../lib/session';
import { withOrgPrincipal } from '../expenses/lib';
import { errorMessage as sharedErrorMessage } from '@/lib/constraint-messages';
import { can, verifyAdminApproval } from '@shareat/auth';
import { loadDestructiveTarget, recordApproval } from '@/lib/destructive';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}
function strs(fd: FormData, key: string): string[] {
  return fd.getAll(key).map((v) => (typeof v === 'string' ? v.trim() : ''));
}

/**
 * ⛔ Every action below calls `backToList`/`backToDetail` — which call `redirect()` — from INSIDE
 * its own try block (the success path, and the `if (!result.ok)` validation-failure path both do).
 * `redirect()` signals Next.js by THROWING; that throw lands in this file's own `catch (err)`,
 * which otherwise treats it as a real error and shows the user the literal string "NEXT_REDIRECT".
 * Every catch block below must re-throw a redirect signal rather than swallow it. `next/navigation`
 * does not publicly export a checker for this (`next/dist/client/components/redirect-error`'s
 * `isRedirectError` is dist-internal), so this duck-types the same `digest` shape Next.js itself
 * uses. Found live on 9008: every save/dispute/resolve/reverse click in this screen redirected
 * nowhere and showed "NEXT_REDIRECT" instead of the real success or error message.
 */
function isRedirectSignal(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'digest' in err &&
    typeof (err as { digest?: unknown }).digest === 'string' &&
    (err as { digest: string }).digest.startsWith('NEXT_REDIRECT')
  );
}

/**
 * T-343 S5.1d — DEF-448. `authorize()`'s `AuthorizationError`s already carry the S2/S2b
 * `userMessage`; this used to regex-match the raw diagnostic and answer with a generic role/scope
 * sentence of its own before `sharedErrorMessage` ever got a chance to prefer the real one.
 * Deleted, not bypassed.
 */
function errorMessageOf(err: unknown): string {
  return sharedErrorMessage(err);
}

/** The "record" form on the list screen. */
export async function recordOrderWastageAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/wastage');
  const storeId = str(fd, 'storeId');
  const channel = str(fd, 'channel');
  const businessDate = str(fd, 'businessDate') || toBusinessDate();
  // ⛔ No `typeMode` is read, and the form no longer offers one — bible §13 row 180. The CHANNEL
  // carries the policy; `recordOrderWastage` derives it. Reading one here would be re-opening the
  // hole from the other end.
  const disposition = (str(fd, 'disposition') || undefined) as OrderWastageDisposition | undefined;
  const personIds = strs(fd, 'personId');
  const percents = strs(fd, 'percent');
  const allocations = personIds
    .map((personId, i) => ({ personId, percent: percents[i] ?? '' }))
    .filter((a) => a.personId && a.percent);

  try {
    const salesDay = await withOrgPrincipal(actor.orgId, async (tx) => {
      // T-440 S9 (iii): the field check runs only for a caller `recordOrderWastage`'s first authorize() ('record_order_wastage' at
      // this store) would let in; anyone else is refused by that gate before any field sentence. It stays here, not in the domain,
      // because this action defaults a blank date to today before the domain sees it, and the raw form's blank date is refused.
      if (await can(tx, actor, 'record_order_wastage', { storeId })) assertFieldRules(WASTAGE_RECORD_RULES, fd);
      return salesDaysRepo.findByBusinessDate(tx, actor.orgId, storeId, businessDate);
    });
    if (!salesDay) {
      return await redirectWithFlash('/wastage', { store: storeId }, { error: `No sales day exists for ${businessDate} at this store yet — record one first. If that day was withdrawn, only a manager can enter the date again, so ask a manager.` });
    }

    const result = await withOrgPrincipal(actor.orgId, (tx) =>
      recordOrderWastage(tx, actor, {
        storeId,
        salesDayId: salesDay.id,
        channel,
        orderRef: str(fd, 'orderRef') || null,
        amount: str(fd, 'amount'),
        reason: str(fd, 'reason'),
        openedOn: businessDate,
        allocations: allocations.length > 0 ? allocations : undefined,
        disposition,
      }),
    );
    revalidatePath('/wastage');
    return await redirectWithFlash('/wastage', { store: storeId }, { ok: `Recorded — ${result.status === 'resolved' ? 'posted immediately' : 'awaiting disposition'}.` });
  } catch (err) {
    if (isRedirectSignal(err)) throw err;
    return await redirectWithFlash('/wastage', { store: storeId }, { error: errorMessageOf(err) });
  }
}

export async function disputeOrderWastageAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/wastage');
  const id = str(fd, 'id');
  const storeId = str(fd, 'storeId');
  try {
    const result = await withOrgPrincipal(actor.orgId, (tx) => disputeOrderWastage(tx, actor, { wastageId: id, storeId }));
    if (!result.ok) return await redirectWithFlash(`/wastage/${id}`, {}, { error: result.reason });
    revalidatePath('/wastage');
    revalidatePath(`/wastage/${id}`);
    return await redirectWithFlash(`/wastage/${id}`, {}, { ok: 'Marked disputed. The 15-day backstop clock is unaffected.' });
  } catch (err) {
    if (isRedirectSignal(err)) throw err;
    return await redirectWithFlash(`/wastage/${id}`, {}, { error: errorMessageOf(err) });
  }
}

export async function resolveOrderWastageAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/wastage');
  const id = str(fd, 'id');
  const storeId = str(fd, 'storeId');
  const disposition = str(fd, 'disposition') as OrderWastageDisposition;
  const personIds = strs(fd, 'personId');
  const percents = strs(fd, 'percent');
  const allocations = personIds
    .map((personId, i) => ({ personId, percent: percents[i] ?? '' }))
    .filter((a) => a.personId && a.percent);

  try {
    const result = await withOrgPrincipal(actor.orgId, (tx) =>
      resolveOrderWastage(tx, actor, {
        wastageId: id,
        storeId,
        disposition,
        allocations: disposition === 'charged' && allocations.length > 0 ? allocations : undefined,
        resolvedOn: str(fd, 'resolvedOn') || toBusinessDate(),
      }),
    );
    if (!result.ok) return await redirectWithFlash(`/wastage/${id}`, {}, { error: result.reason });
    revalidatePath('/wastage');
    revalidatePath(`/wastage/${id}`);
    return await redirectWithFlash(`/wastage/${id}`, {}, { ok: `Resolved as ${disposition}.` });
  } catch (err) {
    if (isRedirectSignal(err)) throw err;
    return await redirectWithFlash(`/wastage/${id}`, {}, { error: errorMessageOf(err) });
  }
}

/** The settlement-match panel's "Mark paid" button — resolves `platform_paid`, posts nothing. */
export async function confirmSettlementMatchAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/wastage');
  const id = str(fd, 'id');
  const storeId = str(fd, 'storeId');
  const settlementId = str(fd, 'settlementId');

  try {
    const result = await withOrgPrincipal(actor.orgId, (tx) =>
      resolveOrderWastage(tx, actor, {
        wastageId: id,
        storeId,
        disposition: 'platform_paid',
        settlementId,
        resolvedOn: toBusinessDate(),
      }),
    );
    if (!result.ok) return await redirectWithFlash(`/wastage/${id}`, {}, { error: result.reason });
    revalidatePath('/wastage');
    revalidatePath(`/wastage/${id}`);
    return await redirectWithFlash(`/wastage/${id}`, {}, { ok: 'Marked paid by the platform. Nothing further posts here.' });
  } catch (err) {
    if (isRedirectSignal(err)) throw err;
    return await redirectWithFlash(`/wastage/${id}`, {}, { error: errorMessageOf(err) });
  }
}

export async function reverseAutoChargeAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/wastage');
  const id = str(fd, 'id');
  const storeId = str(fd, 'storeId');
  const reason = str(fd, 'reason');

  try {
    // T-412 Tier P: an administrator's PIN, verified on the server against the RECORD's store. The domain call below gets the
    // record's store too, not the form's `storeId`.
    const target = await loadDestructiveTarget(actor, 'order_wastage', id, ['reverse_auto_charge']);
    assertFieldRules(WASTAGE_REVERSE_RULES, fd);
    const approval = await verifyAdminApproval(null, { actor, storeId: target.storeId, pin: str(fd, 'adminPin'), capability: 'reverse_auto_charge' });
    const result = await withOrgPrincipal(actor.orgId, async (tx) => {
      const reversed = await reverseAutoCharge(tx, actor, { wastageId: id, storeId: target.storeId ?? storeId, reason, reversedOn: toBusinessDate() });
      if (reversed.ok) await recordApproval(tx, actor, approval, { capability: 'reverse_auto_charge', entityType: 'order_wastage', entityId: id, storeId: target.storeId });
      return reversed;
    });
    if (!result.ok) return await redirectWithFlash(`/wastage/${id}`, {}, { error: result.reason });
    revalidatePath('/wastage');
    revalidatePath(`/wastage/${id}`);
    return await redirectWithFlash(`/wastage/${id}`, {}, { ok: 'Auto-charge reversed. Resolve it again with the correct disposition.' });
  } catch (err) {
    if (isRedirectSignal(err)) throw err;
    return await redirectWithFlash(`/wastage/${id}`, {}, { error: errorMessageOf(err) });
  }
}

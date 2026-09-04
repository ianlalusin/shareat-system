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
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { salesDaysRepo, type OrderWastageDisposition } from '@shareat/db';
import { toBusinessDate } from '@shareat/core/datetime';
import {
  disputeOrderWastage,
  recordOrderWastage,
  resolveOrderWastage,
  reverseAutoCharge,
} from '@shareat/domain';
import { requireActor } from '../../lib/session';
import { withOrgPrincipal } from '../expenses/lib';

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

/** Strips the throwing function's name and turns an authorisation refusal into a sentence. */
function errorMessageOf(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const denied = /may not '([a-z_]+)'/.exec(raw);
  if (denied) return `Your role may not ${denied[1]!.replace(/_/g, ' ')}.`;
  if (/no store scope/.test(raw)) return 'You are not assigned to the store this action belongs to.';
  return raw.replace(/^[a-z][A-Za-z0-9_]*:\s*/, '');
}

function backToList(storeId: string, error?: string, ok?: string): never {
  const qs = new URLSearchParams({ store: storeId });
  if (error) qs.set('error', error);
  if (ok) qs.set('ok', ok);
  redirect(`/wastage?${qs.toString()}`);
}

function backToDetail(id: string, error?: string, ok?: string): never {
  const qs = new URLSearchParams();
  if (error) qs.set('error', error);
  if (ok) qs.set('ok', ok);
  redirect(`/wastage/${id}${qs.toString() ? `?${qs.toString()}` : ''}`);
}

/** The "record" form on the list screen. */
export async function recordOrderWastageAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/wastage');
  const storeId = str(fd, 'storeId');
  const channel = str(fd, 'channel');
  const businessDate = str(fd, 'businessDate') || toBusinessDate();
  const typeMode = str(fd, 'typeMode') as 'instant' | 'tracked';
  const disposition = (str(fd, 'disposition') || undefined) as OrderWastageDisposition | undefined;
  const personIds = strs(fd, 'personId');
  const percents = strs(fd, 'percent');
  const allocations = personIds
    .map((personId, i) => ({ personId, percent: percents[i] ?? '' }))
    .filter((a) => a.personId && a.percent);

  try {
    const salesDay = await withOrgPrincipal(actor.orgId, (tx) =>
      salesDaysRepo.findByBusinessDate(tx, actor.orgId, storeId, businessDate),
    );
    if (!salesDay) {
      backToList(storeId, `No sales day exists for ${businessDate} at this store yet — record one first.`);
    }

    const result = await withOrgPrincipal(actor.orgId, (tx) =>
      recordOrderWastage(tx, actor, {
        storeId,
        salesDayId: salesDay.id,
        channel,
        orderRef: str(fd, 'orderRef') || null,
        typeMode,
        amount: str(fd, 'amount'),
        reason: str(fd, 'reason'),
        openedOn: businessDate,
        allocations: allocations.length > 0 ? allocations : undefined,
        disposition,
      }),
    );
    revalidatePath('/wastage');
    backToList(storeId, undefined, `Recorded — ${result.status === 'resolved' ? 'posted immediately' : 'awaiting disposition'}.`);
  } catch (err) {
    if (isRedirectSignal(err)) throw err;
    backToList(storeId, errorMessageOf(err));
  }
}

export async function disputeOrderWastageAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/wastage');
  const id = str(fd, 'id');
  const storeId = str(fd, 'storeId');
  try {
    const result = await withOrgPrincipal(actor.orgId, (tx) => disputeOrderWastage(tx, actor, { wastageId: id, storeId }));
    if (!result.ok) backToDetail(id, result.reason);
    revalidatePath('/wastage');
    revalidatePath(`/wastage/${id}`);
    backToDetail(id, undefined, 'Marked disputed. The 15-day backstop clock is unaffected.');
  } catch (err) {
    if (isRedirectSignal(err)) throw err;
    backToDetail(id, errorMessageOf(err));
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
    if (!result.ok) backToDetail(id, result.reason);
    revalidatePath('/wastage');
    revalidatePath(`/wastage/${id}`);
    backToDetail(id, undefined, `Resolved as ${disposition}.`);
  } catch (err) {
    if (isRedirectSignal(err)) throw err;
    backToDetail(id, errorMessageOf(err));
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
    if (!result.ok) backToDetail(id, result.reason);
    revalidatePath('/wastage');
    revalidatePath(`/wastage/${id}`);
    backToDetail(id, undefined, 'Marked paid by the platform. Nothing further posts here.');
  } catch (err) {
    if (isRedirectSignal(err)) throw err;
    backToDetail(id, errorMessageOf(err));
  }
}

export async function reverseAutoChargeAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/wastage');
  const id = str(fd, 'id');
  const storeId = str(fd, 'storeId');
  const reason = str(fd, 'reason');

  try {
    const result = await withOrgPrincipal(actor.orgId, (tx) =>
      reverseAutoCharge(tx, actor, { wastageId: id, storeId, reason, reversedOn: toBusinessDate() }),
    );
    if (!result.ok) backToDetail(id, result.reason);
    revalidatePath('/wastage');
    revalidatePath(`/wastage/${id}`);
    backToDetail(id, undefined, 'Auto-charge reversed. Resolve it again with the correct disposition.');
  } catch (err) {
    if (isRedirectSignal(err)) throw err;
    backToDetail(id, errorMessageOf(err));
  }
}

'use server';

/**
 * Server actions for the transit-shortfall screen — T-174.
 *
 * Thin adapters. ⛔ **No rule is re-implemented here.** `resolveDiscrepancy` owns which store may
 * decide (the commissary, never the branch), that resolution is terminal, and that a charge must
 * name a person; the DATABASE owns defer-once. This file authorises, calls, and reports back.
 */
import { revalidatePath } from 'next/cache';
import { redirectWithFlash } from '@/lib/flash';
import { authorize } from '@shareat/auth';

import { toBusinessDate } from '@shareat/core/datetime';
import { assertFieldRules, deferDiscrepancy, resolveDiscrepancy, type Disposition } from '@shareat/domain';
import { COMMISSARY_DEFER_RULES, COMMISSARY_RETURN_RULES } from '@shareat/domain/field-rules';
import { requireActor } from '../../../lib/session';
import { errorMessage, outcomeMessage } from '../../../lib/constraint-messages';
import { withOrgPrincipal } from '../../expenses/lib';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

export async function resolveDiscrepancyAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/commissary/discrepancies');
  const storeId = str(fd, 'storeId');
  const disposition = str(fd, 'disposition') as Disposition;
  const chargePersonId = str(fd, 'chargePersonId');

  let result: Awaited<ReturnType<typeof resolveDiscrepancy>>;
  try {
    result = await withOrgPrincipal(actor.orgId, async (tx) => {
      await authorize(tx, actor, 'resolve_trade_discrepancy', { storeId });
      // ⚠️ A charge takes money off a named person. That is a SECOND decision and a second
      // capability — v1's `canChargeStaff`, and never staff-level.
      if (disposition === 'charge') {
        await authorize(tx, actor, 'charge_staff_for_discrepancy', { storeId });
      }
      // The branch's recount-and-return form always says "return"; that disposition must carry its note (the decide form's
      // note is optional, so it is not asserted for the other dispositions).
      if (disposition === 'return') assertFieldRules(COMMISSARY_RETURN_RULES, fd);
      return resolveDiscrepancy(tx, {
        orgId: actor.orgId,
        discrepancyId: str(fd, 'id'),
        commissaryStoreId: storeId,
        disposition,
        chargePersonId: disposition === 'charge' ? chargePersonId : null,
        note: str(fd, 'note') || null,
        // ⚠️ The business date — a UTC slice would post an evening decision to the previous day.
        resolvedOn: str(fd, 'resolvedOn') || toBusinessDate(),
        resolvedBy: actor.personId,
      });
    });
  } catch (error) {
    // T-379 S1 (DEF-575 / DEF-570): a thrown refusal (an authorization, a closed month at the database) is a sentence on
    // the page, never an error boundary - and through `errorMessage`, so no uuid reaches the URL.
    return await redirectWithFlash('/commissary/discrepancies', { store: storeId }, { error: errorMessage(error) });
  }

  // ⚠️ A refusal is a real answer here, not an exception — *"already resolved as loss"*, *"the
  // branch reports, it does not decide"*. Shown on the page rather than thrown into an error
  // boundary, because the reader's next move depends on which one it was.
  if (!result.ok) return await redirectWithFlash('/commissary/discrepancies', { store: storeId }, { error: outcomeMessage(result) });
  revalidatePath('/commissary/discrepancies');
  return await redirectWithFlash('/commissary/discrepancies', { store: storeId });
}

export async function deferDiscrepancyAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/commissary/discrepancies');
  const storeId = str(fd, 'storeId');

  let result: Awaited<ReturnType<typeof deferDiscrepancy>>;
  try {
    result = await withOrgPrincipal(actor.orgId, async (tx) => {
      await authorize(tx, actor, 'resolve_trade_discrepancy', { storeId });
      assertFieldRules(COMMISSARY_DEFER_RULES, fd);
      return deferDiscrepancy(tx, {
        orgId: actor.orgId,
        discrepancyId: str(fd, 'id'),
        commissaryStoreId: storeId,
        toDate: str(fd, 'deferredTo'),
      });
    });
  } catch (error) {
    // ⭐ **A second deferral is refused by a TRIGGER**, so it arrives as a thrown PostgresError
    // rather than a returned reason. Catching it here is what turns v1's rule into a sentence the
    // manager reads instead of a stack trace: *"decide it."*
    const message = error instanceof Error ? error.message : String(error);
    return await redirectWithFlash('/commissary/discrepancies', { store: storeId }, { error: message.includes('already deferred') ? message : `Could not defer: ${message}` });
  }

  if (!result.ok) return await redirectWithFlash('/commissary/discrepancies', { store: storeId }, { error: result.reason });
  revalidatePath('/commissary/discrepancies');
  return await redirectWithFlash('/commissary/discrepancies', { store: storeId });
}

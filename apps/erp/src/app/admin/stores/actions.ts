'use server';

/**
 * Server actions for store creation and management. T-222.
 *
 * Thin adapters: parse `FormData`, call the gated function, redirect with a message. ⭐ The actor
 * comes from the session, never the form (T-138, `tests/unit/no-client-supplied-actor.test.ts`).
 *
 * ⚠️ **No authorization is written here.** It lives in `packages/domain/src/stores/service.ts`, so a
 * second caller cannot skip it — a rule in one route file is a rule the next route file misses,
 * which is how DEF-180 happened.
 */
import { redirect } from 'next/navigation';
import { createStore, deactivateStore, reactivateStore, updateStoreDetails } from '@shareat/domain';
import { withOrgPrincipal } from '../../expenses/lib';
import { requireActor } from '../../../lib/session';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * ⭐ **Translation, not validation.** The cash-custody rule lives in the database
 * (`stores_pooling_requires_ceiling_check`); this maps its constraint NAME to a sentence a human can
 * act on. ⛔ Keyed on the constraint name deliberately, so a rename fails loudly here rather than
 * silently falling through to a generic error — and there is no second copy of the rule itself
 * (bible §6.3, `setCashPolicy`'s own precedent).
 */
function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (/stores_pooling_requires_ceiling_check/.test(raw)) {
    return 'A store that pools cash must name the ceiling that bounds it. Either set the cadence to daily, or give an unremitted ceiling.';
  }
  if (/stores_unremitted_ceiling_positive_check/.test(raw)) {
    return 'An unremitted ceiling must be a positive amount.';
  }
  if (/stores_org_id_code_unique|duplicate key/.test(raw)) {
    return 'Another store in this organisation already uses that code. Codes are the stable handle and must be unique.';
  }
  if (/no store scope|has no store scope/.test(raw)) {
    return 'You do not have access to that store.';
  }
  if (/authorize:/.test(raw)) {
    return 'Only an admin or super-admin can open or close a branch.';
  }
  return raw;
}

function back(path: string, params: Record<string, string>): never {
  const q = new URLSearchParams(params).toString();
  redirect(`${path}?${q}`);
}

export async function createStoreAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/admin/stores');
  const cadence = str(fd, 'remittanceCadence') || 'daily';
  const ceilingRaw = str(fd, 'unremittedCeiling');

  let result: Awaited<ReturnType<typeof createStore>> | undefined;
  try {
    result = await withOrgPrincipal(actor.orgId, (tx) =>
      createStore(tx, actor, {
        code: str(fd, 'code'),
        name: str(fd, 'name'),
        timezone: str(fd, 'timezone') || undefined,
        stockModel: (str(fd, 'stockModel') || 'single_room') as 'single_room' | 'multi_room',
        remittanceCadence: cadence,
        // ⚠️ Empty string is NOT zero — an unset ceiling is null, and the database decides whether
        // that is legal for this cadence.
        unremittedCeiling: ceilingRaw === '' ? null : ceilingRaw,
      }),
    );
  } catch (err) {
    back('/admin/stores', { error: errorMessage(err) });
  }

  // ⭐ The fan-out is REPORTED, not silent. §C.2's second half is invisible unless someone says it
  // happened — which is precisely how its first half went unnoticed for two weeks (DEF-180).
  back(`/admin/stores/${result!.storeId}`, {
    ok:
      `Store created with its default room, and store scope granted to ${result!.scopedAdminIds.length} ` +
      `admin(s). ⚠️ Nobody can sign in here yet — see the readiness checklist below.`,
  });
}

export async function updateStoreAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/admin/stores');
  const storeId = str(fd, 'storeId');
  try {
    await withOrgPrincipal(actor.orgId, (tx) =>
      updateStoreDetails(tx, actor, storeId, {
        name: str(fd, 'name'),
        timezone: str(fd, 'timezone') || undefined,
        // ⭐ T-229 slice 4 / DEF-208. `''` means "not stated" and CLEARS the column — never the
        // empty string (DEF-087's shape). The form submits all three on every save, so an absent
        // value is a real choice rather than a key that happened not to be sent.
        address: str(fd, 'address') || null,
        contactNumber: str(fd, 'contactNumber') || null,
        tinBranchCode: str(fd, 'tinBranchCode') || null,
      }),
    );
  } catch (err) {
    back(`/admin/stores/${storeId}`, { error: errorMessage(err) });
  }
  back(`/admin/stores/${storeId}`, { ok: 'Store updated. ⛔ The code is deliberately not editable — it is the stable handle.' });
}

export async function deactivateStoreAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/admin/stores');
  const storeId = str(fd, 'storeId');
  try {
    await withOrgPrincipal(actor.orgId, (tx) => deactivateStore(tx, actor, storeId));
  } catch (err) {
    back(`/admin/stores/${storeId}`, { error: errorMessage(err) });
  }
  back(`/admin/stores/${storeId}`, {
    ok: 'Store deactivated. ⛔ Nothing was deleted — its journal entries, attendance and stock remain queryable.',
  });
}

export async function reactivateStoreAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/admin/stores');
  const storeId = str(fd, 'storeId');
  let result: Awaited<ReturnType<typeof reactivateStore>> | undefined;
  try {
    result = await withOrgPrincipal(actor.orgId, (tx) => reactivateStore(tx, actor, storeId));
  } catch (err) {
    back(`/admin/stores/${storeId}`, { error: errorMessage(err) });
  }
  // ⚠️ Re-fanned deliberately: an admin appointed WHILE this store was inactive has no scope row for
  // it, so reactivating without this leaves the store invisible to them — §C.2's failure in a third
  // costume (T-219's own smoketest saw "3 store(s), not 4, because one is inactive").
  back(`/admin/stores/${storeId}`, {
    ok: `Store reactivated, and store scope re-granted to ${result!.scopedAdminIds.length} admin(s).`,
  });
}

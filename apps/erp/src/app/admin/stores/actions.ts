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
import {
  CANONICAL_POSITION_DEFAULTS,
  createStore,
  deactivateStore,
  reactivateStore,
  setStoreOpeningDate,
  setStoreStockModel,
  updateStoreDetails,
} from '@shareat/domain';

// Derived, never hand-typed — T-336 §1's own lesson (three documents once quoted "~8-12" and none
// had checked it). Recomputes to 38 today; changes with the ruling, not with this file.
const TOTAL_RULED_ACCESS_DEFAULTS = Object.values(CANONICAL_POSITION_DEFAULTS).reduce(
  (sum, caps) => sum + caps.length,
  0,
);
import { withOrgPrincipal } from '../../expenses/lib';
import { requireActor } from '../../../lib/session';
import { errorMessage as sharedErrorMessage } from '@/lib/constraint-messages';
import { isPresentable } from '../../../lib/error-shape';
import { redirectWithFlash } from '@/lib/flash';
// T-346 Amendment R3.1 — the one date-validity check, never re-derived per call site.
import { storesRepo } from '@shareat/db';

function invalidDateMessage(raw: string): string {
  return `"${raw}" is not a valid date. Use the date picker, or type it as YYYY-MM-DD.`;
}

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
 *
 * T-343 S5.1d — DEF-448's twin here. Every `AuthorizationError` `authorize` throws already carries
 * the S2/S2b `userMessage`; presentable wins first (the shared function's own step 0, run here so
 * the constraint-name branches below never get a chance to out-guess it). The old two branches —
 * one keyed on the store-scope-refusal shape, one matching any diagnostic with that gate function's
 * own name in front — answered a GENERIC role/scope sentence for every refusal, including ones
 * that were never about `manage_stores` at all (`manage_store_settings`, `stores/service.ts:455`)
 * — deleted, not bypassed. The `setStoreOpeningDate`/`createStore` prefix-strip duplicated the
 * shared function's own step 4, and pre-empted a presentable error whose raw happened to start
 * with the same prefix — deleted too.
 */
function errorMessage(err: unknown): string {
  if (isPresentable(err)) return sharedErrorMessage(err);
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
  return sharedErrorMessage(err);
}

export async function createStoreAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/admin/stores');
  const cadence = str(fd, 'remittanceCadence') || 'daily';
  const ceilingRaw = str(fd, 'unremittedCeiling');
  const openingDate = str(fd, 'openingDate') || null;
  // T-346 Amendment R3.1 — validated here, in human terms, rather than let a malformed string
  // reach `createStore`'s date-typed column as a raw 22007.
  if (openingDate !== null && !storesRepo.isValidDateString(openingDate)) {
    return await redirectWithFlash('/admin/stores', {}, { error: invalidDateMessage(openingDate) });
  }

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
        openingDate,
      }),
    );
  } catch (err) {
    return await redirectWithFlash('/admin/stores', {}, { error: errorMessage(err) });
  }

  // ⭐ The fan-out is REPORTED, not silent. §C.2's second half is invisible unless someone says it
  // happened — which is precisely how its first half went unnoticed for two weeks (DEF-180).
  // T-336/DEF-413 — the access-defaults seed gets the same treatment: a shortfall here means a
  // hired Cashier can do nothing, and that must not be discoverable only by opening the grid.
  const defaultsMessage =
    result!.missingCanonical.length > 0
      ? ` ⚠️ ${result!.accessDefaultsSeeded} of ${TOTAL_RULED_ACCESS_DEFAULTS} access defaults ` +
        `seeded: canonical position(s) missing — ${result!.missingCanonical.join(', ')}. Run T-335's ` +
        'backfill for this organisation.'
      : ` Access defaults seeded (${result!.accessDefaultsSeeded}/${TOTAL_RULED_ACCESS_DEFAULTS}).`;
  return await redirectWithFlash(
    `/admin/stores/${result!.storeId}`,
    {},
    {
      ok:
        `Store created with its default room, and store scope granted to ${result!.scopedAdminIds.length} ` +
        `admin(s).${defaultsMessage} ⚠️ Nobody can sign in here yet — see the readiness checklist below.`,
    },
  );
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
    return await redirectWithFlash(`/admin/stores/${storeId}`, {}, { error: errorMessage(err) });
  }
  return await redirectWithFlash(
    `/admin/stores/${storeId}`,
    {},
    { ok: 'Store updated. ⛔ The code is deliberately not editable — it is the stable handle.' },
  );
}

/**
 * ⭐ T-284 / DEF-316 — how a branch gains a second stockroom. Ian: *"shareat lipa needs more than
 * 1 storage room, i can not edit the store."*
 *
 * ⛔ **Deliberately NOT a field on `updateStoreAction` above.** `stock_model` is an invariant, not
 * a detail: `setStoreStockModel` runs a room-count pre-flight before it narrows, because the
 * database guards this transition from the `stock_locations` side only (DEF-316). Folding it into
 * the details save would route the column past that check.
 */
export async function setStoreStockModelAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/admin/stores');
  const storeId = str(fd, 'storeId');
  const raw = str(fd, 'stockModel');
  // ⚠️ Validated here rather than cast: the value reaches the database through a CHECK constraint
  //    either way, but a refusal that names the two legal values is worth more than a 23514.
  if (raw !== 'single_room' && raw !== 'multi_room') {
    return await redirectWithFlash(`/admin/stores/${storeId}`, {}, { error: 'Choose either one room or several rooms.' });
  }
  const model = raw as 'single_room' | 'multi_room';
  try {
    await withOrgPrincipal(actor.orgId, (tx) => setStoreStockModel(tx, actor, storeId, model));
  } catch (err) {
    return await redirectWithFlash(`/admin/stores/${storeId}`, {}, { error: errorMessage(err) });
  }
  return await redirectWithFlash(
    `/admin/stores/${storeId}`,
    {},
    {
      ok:
        model === 'multi_room'
          ? 'This store may now hold several stockrooms. Add them under Inventory / Locations.'
          : 'This store is back to a single stockroom.',
    },
  );
}

/**
 * T-346 S1 (DEF-428) / S2 (DEF-427), §3.2 step 3 / R4.5. Moving the opening date can cascade a
 * reversal across every `'store_opening'`-sourced follower asset — `setStoreOpeningDate` itself
 * plans that and refuses once, naming every affected asset, unless `confirmedPlan` carries the token of exactly that plan. The
 * refusal's OWN message (the one thing that names which assets, which months, and how much) is
 * what the in-page confirm step below shows verbatim — never a `window.confirm()`.
 */
export async function setStoreOpeningDateAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/admin/stores');
  const storeId = str(fd, 'storeId');
  const openingDate = str(fd, 'openingDate') || null;
  // The token of the plan the person confirmed (T-368 S2 / DEF-441), resubmitted from the confirm step.
  const confirmedPlan = str(fd, 'confirmedPlan') || undefined;
  // T-346 Amendment R3.1 — same helper as createStoreAction; no second copy of the check.
  if (openingDate !== null && !storesRepo.isValidDateString(openingDate)) {
    // M4: the refusal quotes the typed date; the date rides the flash so the box comes back as typed.
    return await redirectWithFlash(
      `/admin/stores/${storeId}`,
      {},
      { error: invalidDateMessage(openingDate), keep: { openingDate } },
    );
  }
  try {
    await withOrgPrincipal(actor.orgId, (tx) =>
      setStoreOpeningDate(tx, actor, storeId, { openingDate, confirmedPlan }),
    );
  } catch (err) {
    const message = errorMessage(err);
    // "confirm to proceed" is `setStoreOpeningDate`'s own refusal shape (stores/service.ts) — the
    // ONE string this action recognises to show the in-page confirm step instead of a plain error.
    if (message.endsWith('confirm to proceed')) {
      // The consent text names every affected asset; `plan` is a hash of entry ids, so the text cannot be
      // rebuilt from it. Carried whole in the flash cookie, never truncated.
      return await redirectWithFlash(
        `/admin/stores/${storeId}`,
        {},
        {
          confirm: message,
          plan: (err as { planToken?: string }).planToken ?? '',
          keep: { openingDate: openingDate ?? '' },
        },
      );
    }
    return await redirectWithFlash(`/admin/stores/${storeId}`, {}, { error: message });
  }
  return await redirectWithFlash(
    `/admin/stores/${storeId}`,
    {},
    { ok: openingDate ? `Opening date set to ${openingDate}.` : 'Opening date cleared.' },
  );
}

export async function deactivateStoreAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/admin/stores');
  const storeId = str(fd, 'storeId');
  try {
    await withOrgPrincipal(actor.orgId, (tx) => deactivateStore(tx, actor, storeId));
  } catch (err) {
    return await redirectWithFlash(`/admin/stores/${storeId}`, {}, { error: errorMessage(err) });
  }
  return await redirectWithFlash(
    `/admin/stores/${storeId}`,
    {},
    { ok: 'Store deactivated. ⛔ Nothing was deleted — its journal entries, attendance and stock remain queryable.' },
  );
}

export async function reactivateStoreAction(fd: FormData): Promise<void> {
  const actor = await requireActor('/admin/stores');
  const storeId = str(fd, 'storeId');
  let result: Awaited<ReturnType<typeof reactivateStore>> | undefined;
  try {
    result = await withOrgPrincipal(actor.orgId, (tx) => reactivateStore(tx, actor, storeId));
  } catch (err) {
    return await redirectWithFlash(`/admin/stores/${storeId}`, {}, { error: errorMessage(err) });
  }
  // ⚠️ Re-fanned deliberately: an admin appointed WHILE this store was inactive has no scope row for
  // it, so reactivating without this leaves the store invisible to them — §C.2's failure in a third
  // costume (T-219's own smoketest saw "3 store(s), not 4, because one is inactive").
  return await redirectWithFlash(
    `/admin/stores/${storeId}`,
    {},
    { ok: `Store reactivated, and store scope re-granted to ${result!.scopedAdminIds.length} admin(s).` },
  );
}

/**
 * Store creation and management — T-222, `docs/tasks/222-store-creation-and-management.md`.
 *
 * ## ⛔ A store row is the smallest part of creating a store
 *
 * v1 learned this expensively and wrote the scar down in its own
 * `store-provision.actions.ts`: *"Creating a store only writes `stores/{id}`. Seeds were kicked off
 * from the client fire-and-forget — a failure was `console.error`'d while the UI still said **Store
 * Created***. A success message with nothing executable behind it, which is DEF-185's shape rendered
 * as a toast.
 *
 * ⭐ **v2's improvement is not a better checklist, it is a transaction.** Firestore had no
 * multi-document transaction across those writes, so v1 *had* to run each seed separately and report
 * each individually. Postgres does, so the entire `auto` half commits or none of it does, and the
 * half-provisioned store v1 kept landing in **cannot exist**. Only the genuinely manual half — which
 * bank, which sales channels — remains a checklist, and that checklist is DERIVED (§4).
 *
 * ## ⚠️ Two corrections to the spec, reported rather than worked around (RULES §3.4a)
 *
 * **1. The fan-out must precede the room, and the spec has it the other way round.** §2 orders the
 * steps store → room → fan-out and says to create the room by reusing T-160's `createLocation`. That
 * cannot work: `createLocation` calls `authorize(…, 'manage_locations', { storeId })`, and
 * `authorize` requires a `person_store_scope` row for **every** store-scoped capability with **no
 * admin bypass** (deliberately — v1 let admin bypass and v2 does not). The creating admin cannot
 * have scope for a store that did not exist a moment ago, so the reuse is refused by the system's own
 * gate.
 *
 * ⛔ **And reordering alone does not rescue the reuse**: the fan-out grants scope to active `admin`
 * roles only (mirroring T-219's half of §C.2), so a **super_admin** creator still ends with no scope
 * row and would still be refused. Rather than widen §C.2 inside the task that merely consumes it,
 * the default room is inserted through `stockLocationsRepo.insertLocation`. Nothing is lost: the
 * single-room rule is enforced by T-160's `stock_locations_single_room_guard` **trigger**, so the
 * database still refuses what `createLocation` would have refused.
 *
 * **2. A brand-new org may have no `location_types` row**, and `createLocation` requires one. Left
 * alone, `createStore` would be unusable in exactly the situation it exists for. One is created if
 * the org has none — an `auto` default in the spec's own sense, not a business fact.
 */
import {
  accessRepo,
  orderWastageRepo,
  personsRepo,
  stockLocationsRepo,
  storesRepo,
  type StoreRow,
  type Tx,
} from '@shareat/db';
import { authorize, type Actor } from '@shareat/auth';
import { normaliseBranchCode } from '../organizations';

const CAPABILITY = 'manage_stores' as const;

export interface CreateStoreInput {
  readonly code: string;
  readonly name: string;
  readonly timezone?: string;
  readonly stockModel?: 'single_room' | 'multi_room';
  readonly remittanceCadence?: string;
  readonly unremittedCeiling?: string | null;
  /** The default room's code/name. Defaults to a stockroom, which every store needs to hold stock. */
  readonly roomCode?: string;
  readonly roomName?: string;
}

export interface CreateStoreResult {
  readonly storeId: string;
  readonly locationId: string;
  /** ⭐ Reported, never silent: "granted scope to N admin(s)" is how §C.2's second half becomes
   *  visible rather than something a reader has to trust happened. */
  readonly scopedAdminIds: readonly string[];
}

/**
 * ⭐ **ONE transaction. Everything with a defined default, or nothing.**
 *
 * ⚠️ The step that will be forgotten is the fan-out, and DEF-180 is the proof: §C.2's *first* half
 * was decided 2026-08-25, never written into `assignRole`, and went unnoticed for two weeks only
 * because nothing called the function. This is the same ADR, the same paragraph, the other half.
 */
export async function createStore(
  tx: Tx,
  actor: Actor,
  input: CreateStoreInput,
): Promise<CreateStoreResult> {
  // 1. Authorize FIRST — bible §7 rule 1, no exceptions.
  await authorize(tx, actor, CAPABILITY, {});

  const code = input.code.trim();
  const name = input.name.trim();
  if (!code) throw new Error('createStore: a store needs a code.');
  if (!name) throw new Error('createStore: a store needs a name.');

  // 2. The store row. ⛔ The cash-custody pairing is NOT re-checked here — the database refuses an
  //    unbounded pile of cash on a long cadence (`stores_pooling_requires_ceiling_check`), and a
  //    TypeScript copy would be a second source of truth that drifts (bible §6.3).
  const { id: storeId } = await storesRepo.insertStore(tx, {
    orgId: actor.orgId,
    code,
    name,
    timezone: input.timezone,
    stockModel: input.stockModel,
    remittanceCadence: input.remittanceCadence,
    unremittedCeiling: input.unremittedCeiling,
  });

  // 3. ⭐ CAPABILITY-MATRIX.md §C.2, second half — BEFORE the room, see this file's header.
  //    "a store created later appears in nobody's scope, so creating a store must add scope rows for
  //    that org's existing admins — otherwise a new branch is invisible to the person who just
  //    opened it, and the failure looks like a permissions bug rather than a missing row."
  const scopedAdminIds = await fanStoreScopeToAdmins(tx, actor, storeId);

  // 4. The default room. A store with zero rooms holds no stock at all.
  const locationId = await createDefaultRoom(tx, actor, storeId, input);

  return { storeId, locationId, scopedAdminIds };
}

/**
 * ⭐ Shared by `createStore` and `reactivateStore` rather than copied, because §C.2 has now failed
 * twice by being restated instead of reused.
 *
 * ⚠️ **Reactivation needs this too, and that is a real bug waiting to happen.** T-219's own
 * smoketest observed *"granted store scope for 3 store(s) — 3, not 4, because one store is
 * inactive."* So an admin appointed while a store was inactive has **no** scope row for it; bring the
 * store back and it is invisible to them — §C.2's failure a third time, in a third costume.
 */
async function fanStoreScopeToAdmins(tx: Tx, actor: Actor, storeId: string): Promise<string[]> {
  const adminIds = await accessRepo.activeAdminPersonIds(tx, actor.orgId);
  for (const personId of adminIds) {
    await accessRepo.grantStoreScope(tx, { personId, storeId, grantedBy: actor.personId });
  }
  return adminIds;
}

async function createDefaultRoom(
  tx: Tx,
  actor: Actor,
  storeId: string,
  input: CreateStoreInput,
): Promise<string> {
  const types = await stockLocationsRepo.listLocationTypes(tx, actor.orgId);
  let typeId = types[0]?.id;
  if (!typeId) {
    // ⚠️ See header correction 2 — an org with no room types would otherwise make store creation
    // impossible. A stockroom type is an `auto` default, not a business fact.
    const created = await stockLocationsRepo.insertLocationType(tx, {
      orgId: actor.orgId,
      code: 'STK',
      name: 'Stockroom',
      sortOrder: 1,
    });
    typeId = created.id;
  }

  const { id } = await stockLocationsRepo.insertLocation(tx, {
    orgId: actor.orgId,
    storeId,
    code: input.roomCode?.trim() || 'MAIN',
    name: input.roomName?.trim() || 'Main stockroom',
    typeId,
    role: 'operating',
    purpose: 'normal',
    // ⚠️ Inserted as the default directly is safe here and only here: the store was created in this
    // same transaction, so there is no existing active default to collide with. `createLocation`
    // inserts false-then-promotes because it runs against stores that already have rooms.
    isDefault: true,
    createdBy: actor.personId,
  });
  return id;
}

/**
 * ⭐ **T-229 slice 4 widened this rather than adding a second function** — it already authorises
 * `manage_stores` (admin ✅, manager ✗), which is the right bar for a trading address: a manager
 * who could edit the name and address printed on the store's own documents is a wider grant than a
 * manager needs. ⛔ Deliberately NOT `manage_store_settings`, the manager-level gate slice 3 and
 * T-230 use for operational configuration — identity is not operational configuration.
 *
 * ⚠️ **`patch` is Partial: an absent key means "leave alone", an explicit `null` CLEARS.** The
 * screen submits every field it owns on every save, so the distinction survives the form.
 */
export async function updateStoreDetails(
  tx: Tx,
  actor: Actor,
  storeId: string,
  patch: {
    name?: string;
    timezone?: string;
    address?: string | null;
    contactNumber?: string | null;
    tinBranchCode?: string | null;
  },
): Promise<void> {
  await authorize(tx, actor, CAPABILITY, {});
  // ⭐ Normalised the same way the org's TIN is, and refused with the same sentence — the database
  //   holds the identical rule as `stores_tin_branch_code_format_check` and is the authority.
  const normalised =
    patch.tinBranchCode === undefined
      ? patch
      : { ...patch, tinBranchCode: normaliseBranchCode(patch.tinBranchCode) };
  await storesRepo.updateStore(tx, actor.orgId, storeId, normalised);
}

// -----------------------------------------------------------------------------------------
// The Wastage Monitor — T-229 slice 3, DEF-206
// -----------------------------------------------------------------------------------------

/**
 * ⚠️ **NOT this file's `CAPABILITY`, and the difference is deliberate.** Every other function here
 * is `manage_stores` — admin-only, because opening and closing a branch is an owner's act. Naming
 * who answers for a wasted order is store configuration, the same bar as the channel's own wastage
 * policy that T-230 put beside it, and **a manager holds it**. Stated as its own constant so the
 * gate cannot be copied from the function above by accident.
 */
const MONITOR_CAPABILITY = 'manage_store_settings' as const;

/**
 * ⭐ **DEF-206.** `stores.wastage_monitor_person_id` had **zero writers** — the only assignment
 * anywhere was a raw `UPDATE` inside T-178's own test file. Meanwhile `/wastage` instructed people
 * to *"set the Monitor under Settings"*, a surface that did not exist, and
 * `packages/db/src/cutover/classification.ts` **clears** the column at cutover recording that it
 * is *"cleared and re-assigned at cutover"* — with no path to re-assign it. This function is that
 * path, and it is what makes both sentences true.
 *
 * ⛔ **The consequence of leaving it unset is silent and costs money.** `recordOrderWastage`'s
 * invariant 2 seeds the Monitor only *"if monitor"*, so with none set every tracked wastage is
 * created ownerless and falls to the 15-day backstop's third tier — *store absorbs, net zero*.
 * Nothing is recovered and nothing errors.
 *
 * ⭐ **`null` CLEARS it, and must keep doing so.** The column is nullable on purpose (schema:
 * *"an unassigned Monitor is not a failure — it is the last rung of the backstop's own fallback
 * order"*), so a Monitor who leaves the company must be removable. A screen that could only ever
 * SET one would make a wrong assignment permanent.
 *
 * ⚠️ **Store scope is deliberately NOT required of the Monitor.** The pool is everyone active in
 * the organisation, matching `listActivePersons`' own stated reason: who money can be charged to
 * is WIDER than who can act in the ERP, and a scope filter would exclude exactly the people who
 * never sign in here.
 */
export async function setWastageMonitor(
  tx: Tx,
  actor: Actor,
  input: { storeId: string; personId: string | null },
): Promise<void> {
  await authorize(tx, actor, MONITOR_CAPABILITY, { storeId: input.storeId });

  const store = await storesRepo.getById(tx, actor.orgId, input.storeId);
  if (!store) throw new Error('setWastageMonitor: that store does not exist in this organisation.');

  if (input.personId !== null) {
    // ⚠️ Org-scoped, so one organisation cannot name another's person as its Monitor — the FK
    // alone would allow it, because `persons.id` carries no org in the reference.
    const person = await personsRepo.getPersonById(tx, actor.orgId, input.personId);
    if (!person) throw new Error('setWastageMonitor: that person does not exist in this organisation.');
    if (!person.isActive) {
      throw new Error(
        `setWastageMonitor: ${person.displayName} is no longer active, so wastages would be ` +
          'charged to somebody who has left.',
      );
    }
  }

  await storesRepo.setWastageMonitor(tx, actor.orgId, input.storeId, input.personId);
}

/** The store's Monitor with their name, or `null`. Read-only; the gate belongs to the write. */
export async function wastageMonitorOf(
  tx: Tx,
  actor: Actor,
  storeId: string,
): Promise<{ personId: string; displayName: string; isActive: boolean } | null> {
  return storesRepo.wastageMonitorWithName(tx, actor.orgId, storeId);
}

/**
 * ⭐ What an unset Monitor is costing right now — unresolved TRACKED wastages with nobody
 * answering for them. Derived on read, never stored (bible §4.2 rule 7).
 *
 * ⚠️ Setting a Monitor does **not** retro-own these: an allocation is an attribution, and
 * back-filling one would assert a decision nobody made. The screen says so in words.
 */
export async function ownerlessTrackedWastages(
  tx: Tx,
  actor: Actor,
  storeId: string,
): Promise<{ count: number; amount: string }> {
  return orderWastageRepo.ownerlessTrackedWastages(tx, actor.orgId, storeId);
}

/** ⛔ Deactivate, never delete — a store carries journal entries, attendance and stock. */
export async function deactivateStore(tx: Tx, actor: Actor, storeId: string): Promise<void> {
  await authorize(tx, actor, CAPABILITY, {});
  await storesRepo.setActive(tx, actor.orgId, storeId, false);
}

/** ⭐ Re-fans scope, because admins appointed while this store was inactive have no row for it. */
export async function reactivateStore(
  tx: Tx,
  actor: Actor,
  storeId: string,
): Promise<{ scopedAdminIds: readonly string[] }> {
  await authorize(tx, actor, CAPABILITY, {});
  await storesRepo.setActive(tx, actor.orgId, storeId, true);
  const scopedAdminIds = await fanStoreScopeToAdmins(tx, actor, storeId);
  return { scopedAdminIds };
}

// -----------------------------------------------------------------------------------------
// Readiness — ⛔ DERIVED, never stored
// -----------------------------------------------------------------------------------------

export interface ReadinessCheck {
  readonly key: string;
  readonly label: string;
  readonly ok: boolean;
  /** `auto` conditions are guaranteed by construction; `manual` ones encode a business fact. */
  readonly kind: 'auto' | 'manual';
  /** Blocks real use of the store until satisfied. */
  readonly blocking: boolean;
  readonly detail: string;
}

/**
 * ⭐ **Computed on read from the live tables. Nothing about readiness is persisted, and that is
 * bible row 123's lesson rather than a style preference.** v1's OIL layer stored `state` per finding
 * key, so resolving one suppressed tomorrow's recompute *while the condition still held* — the
 * symptom hidden with the cause intact. A stored "store is ready" flag is the same defect: someone
 * ticks it, the sales channel is later deleted, and the store reports ready forever.
 */
export async function storeReadiness(
  tx: Tx,
  actor: Actor,
  store: StoreRow,
): Promise<ReadinessCheck[]> {
  await authorize(tx, actor, CAPABILITY, {});

  const rooms = await stockLocationsRepo.listActiveLocations(tx, store.id);
  const adminIds = await accessRepo.activeAdminPersonIds(tx, actor.orgId);
  const scopedEverywhere: string[] = [];
  for (const id of adminIds) {
    if (await accessRepo.personHasStoreScope(tx, id, store.id)) scopedEverywhere.push(id);
  }
  const channels = await storesRepo.countSalesChannels(tx, actor.orgId, store.id);
  const credentials = await storesRepo.countActiveCredentials(tx, store.id);

  return [
    {
      key: 'room',
      label: 'A default room exists',
      ok: rooms.length > 0,
      kind: 'auto',
      blocking: true,
      detail: rooms.length > 0
        ? `${rooms.length} active room(s).`
        : 'A store with no rooms holds no stock at all.',
    },
    {
      key: 'adminScope',
      // ⚠️ Re-derived rather than trusted, so a LATER drift shows — an admin appointed while this
      // store was inactive, for instance.
      label: 'Every active admin can see this store',
      ok: scopedEverywhere.length === adminIds.length,
      kind: 'auto',
      blocking: true,
      detail:
        scopedEverywhere.length === adminIds.length
          ? `${adminIds.length} admin(s) scoped.`
          : `${adminIds.length - scopedEverywhere.length} admin(s) have no scope row — reactivating the store re-fans them.`,
    },
    {
      key: 'salesChannel',
      label: 'At least one sales channel',
      ok: channels > 0,
      kind: 'manual',
      blocking: true,
      detail: channels > 0
        ? `${channels} active channel(s).`
        : // ⭐ T-230 names the remedy. Until then this check reported a blocking condition with no
          // screen anywhere that could clear it (DEF-207) — a checklist item nobody could tick.
          'Without one a sales day has nowhere to land, and an unresolvable channel blocks rather ' +
            'than silently defaulting (DEF-059). Add one under Settings › Sales channels.',
    },
    {
      key: 'signIn',
      // ⭐ §5, and the sharpest one. A credential belongs to a (person, store) PAIR — `setPin` hashes
      // with `pinLookupHash(storeId, pin)` — so a new store has ZERO credentials while the sign-in
      // page happily lists it. The first person to try reports "my PIN stopped working", the least
      // informative possible symptom of a correct system.
      label: 'Someone can sign in here',
      ok: credentials > 0,
      kind: 'manual',
      blocking: true,
      detail: credentials > 0
        ? `${credentials} active credential(s).`
        : 'No one can sign in at this store yet. Issue a PIN from Staff — ⛔ store creation deliberately does not auto-issue one, because a generated default PIN ends up in a screenshot.',
    },
  ];
}

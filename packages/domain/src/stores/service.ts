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
  fixedAssetsRepo,
  manilaToday,
  orderWastageRepo,
  personsRepo,
  stockLocationsRepo,
  storesRepo,
  type StoreRow,
  type Tx,
} from '@shareat/db';
import { authorize, type Actor } from '@shareat/auth';
import { describeReversal, executeReversals, planInServiceReversal } from '../fixed-assets/in-service';
// ⭐ The LEAF module, not `../organizations` — `organizations/index.ts` imports `createStore` from
// this file, so importing its barrel back would close an import cycle. See `identifiers.ts`.
import { normaliseBranchCode } from '../organizations/identifiers';
// ⛔ The pure rule is CALLED, never re-implemented here — see `setStoreStockModel`.
import { singleRoomViolation, type StockModel } from '../stock-locations/rules';
import { seedAttendanceConfig } from '../attendance/config';
// ⭐ The LEAF module, not the `../people` barrel — same discipline as `../organizations/identifiers`
// above, on this file's own precedent (T-336 §7): a barrel pulls in every sibling it re-exports, and
// this file has already been burned once by an import cycle closing through one (see the header
// comment on that import). No cycle exists today between `people` and `stores/service` specifically —
// this is the defensive default, not a fix for one measured.
import { seedStoreAccessDefaults } from '../people/position-defaults';

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
  /** T-346 S1 (DEF-428). Absent or `null` both mean "not yet open". */
  readonly openingDate?: string | null;
}

export interface CreateStoreResult {
  readonly storeId: string;
  readonly locationId: string;
  /** ⭐ Reported, never silent: "granted scope to N admin(s)" is how §C.2's second half becomes
   *  visible rather than something a reader has to trust happened. */
  readonly scopedAdminIds: readonly string[];
  /** T-336/DEF-413 — how many of the ruled 38 rows this store actually got. */
  readonly accessDefaultsSeeded: number;
  /** Canonical names this store's org has no row for yet (see `seedStoreAccessDefaults`) — empty
   *  for any org T-335 has already seeded. */
  readonly missingCanonical: readonly string[];
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
  // T-346 Amendment R3.1 / delta audit — same check and same helper as `setStoreOpeningDate`; a new
  // store cannot have traded yet, so there is no "has traded" comparison here, only the format one.
  if (input.openingDate != null && !storesRepo.isValidDateString(input.openingDate)) {
    throw new Error(`createStore: "${input.openingDate}" is not a valid date (expected YYYY-MM-DD)`);
  }

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
    openingDate: input.openingDate,
  });

  // 2b. ⭐ T-332/DEF-249. A store with no `store_attendance_config` row is not "using defaults", it
  //     is unconfigured — `getConfigForShiftDay` refuses every day, and the attendance sweep's
  //     population join (`scheduler/index.ts`) skips the store outright, silently. `seedAttendanceConfig`
  //     is idempotent, so this is safe to call unconditionally, and `createStore` is the ONLY
  //     production INSERT into `stores` — see the task doc's §4 for why this is not duplicated at
  //     `scripts/bootstrap-org.ts`.
  await seedAttendanceConfig(tx, {
    orgId: actor.orgId,
    storeId,
    effectiveFrom: await manilaToday(tx),
    createdBy: actor.personId,
  });

  // 2c. ⭐ T-336/DEF-413. A store with zero access-default rows is not "using the matrix", it is
  //     unusable — a hired Cashier can do nothing until an admin visits `/admin/access-defaults` by
  //     hand. `seedStoreAccessDefaults` is the only place this table is written for a NEW store
  //     (T-335's own precedent: `createStore` is the only production INSERT into `stores`, so one
  //     call here covers a new org's first store AND every later branch). Never throws for a
  //     positionless org — it reports `missingCanonical` instead, which T-335's backfill owns closing.
  const { inserted: accessDefaultsSeeded, missingCanonical } = await seedStoreAccessDefaults(
    tx,
    actor,
    storeId,
  );
  // ⭐ Surfaced here, not only in `scripts/bootstrap-org.ts`'s own print line, because this function
  // is also `/admin/stores`' path for every LATER store — a shortfall there has no script output to
  // read. `console.warn` rather than a thrown error: T-335's backfill, not this call, owns closing
  // the gap (§5/§8), and a positionless org must still get its store.
  if (missingCanonical.length > 0) {
    console.warn(
      `createStore: org ${actor.orgId}, store ${storeId} seeded only ${accessDefaultsSeeded} access ` +
        `default(s) — missing canonical position(s): ${missingCanonical.join(', ')}. Run T-335's ` +
        'backfill (scripts/backfill-canonical-positions.ts) for this org.',
    );
  }

  // 3. ⭐ CAPABILITY-MATRIX.md §C.2, second half — BEFORE the room, see this file's header.
  //    "a store created later appears in nobody's scope, so creating a store must add scope rows for
  //    that org's existing admins — otherwise a new branch is invisible to the person who just
  //    opened it, and the failure looks like a permissions bug rather than a missing row."
  const scopedAdminIds = await fanStoreScopeToAdmins(tx, actor, storeId);

  // 4. The default room. A store with zero rooms holds no stock at all.
  const locationId = await createDefaultRoom(tx, actor, storeId, input);

  return { storeId, locationId, scopedAdminIds, accessDefaultsSeeded, missingCanonical };
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
    // T-336 SCOPE LIFECYCLE fix, migration 0156 — 'fan_out', never 'manual' or 'employment': this
    // row exists because a new store appeared, not because anyone hired or explicitly granted.
    await accessRepo.grantStoreScope(tx, { personId, storeId, grantedBy: actor.personId, source: 'fan_out' });
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

/**
 * ⭐ T-346 S1 (DEF-428). `openingDate: null` = not yet open; a future date = planned; a past date =
 * the day it opened.
 *
 * ⚠️ **Once a store has traded, its opening date can never be later than the day it first traded**
 * (Amendment R3.6, superseding R2.1/R2.4's looser "not cleared or moved into the future") —
 * `storesRepo.firstTradingDate` is the SAME definition `store_first_trading_date` (migration 0162)
 * used to backfill this column, so a store the backfill already called "open" can never be told a
 * later — or no — date by a subsequent edit. Moving the date EARLIER than first trading is
 * unrestricted — that is a correction, not a claim that it never opened.
 *
 * ⭐ **T-346 S2 (DEF-427), §3.2 step 3.** Every `'store_opening'`-sourced follower asset re-derives
 * its `in_service_on` from this store's date the moment it changes — migration 0163's
 * `stores_opening_date_propagate` trigger does that re-derivation automatically once the write
 * below lands. What this function adds on top is everything the trigger CANNOT do: plan which
 * followers' posted depreciation the new date would make illegal, refuse outright on a DEF-435
 * conflict, and reverse what needs reversing — all BEFORE the write, in the same transaction, so
 * the trigger's own guard (`fixed_assets_in_service_b_guard`) never has anything left to catch.
 * ONE confirm covers every affected asset — not one per asset — reusing `planInServiceReversal` /
 * `executeReversals` / `describeReversal` so this cascade and `setAssetInService`'s own single-asset
 * path can never describe the same reversal two different ways.
 */
export async function setStoreOpeningDate(
  tx: Tx,
  actor: Actor,
  storeId: string,
  input: { openingDate: string | null; confirmReversal?: boolean },
): Promise<void> {
  await authorize(tx, actor, CAPABILITY, {});

  // Amendment R3.1 — a real calendar date, not merely shaped like one, before any comparison below
  // trusts it as a sortable string ('2026-3-1' sorts before '2026-03-01' despite naming a later day).
  if (input.openingDate !== null && !storesRepo.isValidDateString(input.openingDate)) {
    throw new Error(`setStoreOpeningDate: "${input.openingDate}" is not a valid date (expected YYYY-MM-DD)`);
  }

  const store = await storesRepo.getById(tx, actor.orgId, storeId);
  if (!store) throw new Error('setStoreOpeningDate: that store does not exist in this organisation.');

  const firstTrading = await storesRepo.firstTradingDate(tx, storeId);
  if (firstTrading !== null && (input.openingDate === null || input.openingDate > firstTrading)) {
    throw new Error(
      `setStoreOpeningDate: ${store.name} has traded since ${firstTrading}; its opening date must ` +
        'be on or before that',
    );
  }

  // §3.2 step 3 — every follower this store's own opening-date change would touch. Mirrors
  // migration 0163's `fixed_assets_in_service_a_fill`'s own `'store_opening'` branch exactly
  // (NULL while the store has none, else the later of the new opening date and the asset's own
  // acquisition), so the plan below matches what the trigger will actually derive once written.
  //
  // ⛔ Amendment R4.4 (1) — `status = 'active'` only. A disposed asset is no longer depreciating
  // anything and re-deriving its in_service_on would be a no-op with teeth: it can only ever
  // surface a phantom DEF-435 conflict or reversal against history that no longer matters. The
  // propagation trigger's own `WHERE` carries the identical `status = 'active'` condition, so a
  // disposed follower is frozen on BOTH sides, never just one.
  const followers = (await fixedAssetsRepo.listAssets(tx, actor.orgId, { storeId, status: 'active' })).filter(
    (a) => a.inServiceSource === 'store_opening',
  );

  const plans = await Promise.all(
    followers.map(async (asset) => {
      // ⭐ Safe: `inServiceSource === 'store_opening'` only ever exists on a non-shell row (the
      // fill trigger forces both columns NULL for `pending_valuation`), and a non-shell row always
      // carries a cost and an acquisition date (0163's own shape CHECK ties the three together).
      const newInServiceOn =
        input.openingDate === null
          ? null
          : input.openingDate > asset.acquiredOn!
            ? input.openingDate
            : asset.acquiredOn!;
      return { asset, plan: await planInServiceReversal(tx, actor.orgId, asset, newInServiceOn) };
    }),
  );

  const conflicted = plans.find(({ plan }) => plan.conflict);
  if (conflicted) {
    throw new Error(
      `setStoreOpeningDate: ${conflicted.asset.name}: ${conflicted.plan.conflict!.period} would need ` +
        `re-booking at ${conflicted.plan.conflict!.amount}, which this cannot do yet (DEF-435)`,
    );
  }

  const affected = plans.filter(({ plan }) => plan.toReverse.length > 0);
  if (affected.length > 0 && !input.confirmReversal) {
    const perAsset = affected
      .map(({ asset, plan }) => `${asset.name} — ${describeReversal(plan.toReverse)}`)
      .join('; ');
    throw new Error(
      `setStoreOpeningDate: ${store.name} — moving the opening date reverses depreciation for ` +
        `${affected.length} asset(s): ${perAsset}; confirm to proceed`,
    );
  }

  if (affected.length > 0) {
    const today = await manilaToday(tx);
    const dateLabel = input.openingDate ?? 'held (no opening date yet)';
    for (const { asset, plan } of affected) {
      await executeReversals(
        tx,
        actor.personId,
        today,
        `${store.name}'s opening date changed to ${dateLabel} — in-service date follows automatically`,
        plan.toReverse,
      );
    }
  }

  await storesRepo.updateStore(tx, actor.orgId, storeId, { openingDate: input.openingDate });
}

/**
 * ⭐ **T-284 / DEF-316 — the first writer `stores.stock_model` has ever had.**
 *
 * Ian, 2026-09-12: *"shareat lipa needs more than 1 storage room, i can not edit the store."*
 * The column and its CHECK were created by migration `0062`; nothing in the repository has ever
 * written it, so every store has sat on the default `single_room` with no path off it. Same shape
 * as DEF-299, DEF-260 and DEF-314 — built, constrained, never called.
 *
 * ## ⛔ Why this is its own function and not a sixth field on `updateStoreDetails`
 *
 * `stock_model` is an INVARIANT, not a preference — the schema says exactly that. It needs a
 * pre-flight the other five fields do not, and a refusal about ROOMS, which is not something a
 * general "save store details" call should have to know about. Same reasoning that gave
 * `setWastageMonitor` below its own function and its own capability constant.
 *
 * ## ⛔ DEF-316 — the direction the DATABASE does not guard
 *
 * `stock_locations_single_room_guard_trg` fires on **`stock_locations`** and reads the store's
 * model at that moment. **Nothing fires on `stores` when the model itself changes.** So
 * `multi_room -> single_room` on a store already holding two rooms would land in a state the
 * invariant forbids, with no error, and every later room insert would then refuse by pointing at
 * a condition the store was already in.
 *
 * That transition has never been reachable because no writer existed. **This function is what
 * makes it reachable, so it carries the guard in the same change.**
 *
 * ⚠️ **And this is currently the ONLY layer holding it.** Bible §15.11 — no layer may be the only
 * one for a given risk — wants an `AFTER UPDATE OF stock_model ON stores` trigger reusing
 * `0062:132-161`'s own counting query. DEF-316 carries that disposition; it needs a migration slot
 * and none is claimed here. This is a disclosed temporary state, not a design.
 *
 * ## The rule is CALLED, never copied
 *
 * `singleRoomViolation` already answers this question and is already tested. `0062`'s own header
 * records what a second copy costs: *"the pure rule filtered the whole list and got it right; the
 * SQL did not, and only a test against real PostgreSQL could see the two disagree."*
 *
 * ⭐ **Widening is always safe.** `single_room -> multi_room` cannot violate anything — one room
 * is a legal shape for a multi-room store — so it is never blocked. Only the narrowing direction
 * is checked, which is also the only direction that can be wrong.
 */
export async function setStoreStockModel(
  tx: Tx,
  actor: Actor,
  storeId: string,
  model: StockModel,
): Promise<void> {
  await authorize(tx, actor, CAPABILITY, {});

  if (model === 'single_room') {
    const locations = await stockLocationsRepo.listLocations(tx, storeId);
    const violation = singleRoomViolation(model, locations);
    if (violation) {
      throw new Error(
        'This store cannot become single-room while it holds more than one active non-Receiving ' +
          `room. Deactivate or merge the extras first — ${violation}`,
      );
    }
  }

  await storesRepo.updateStore(tx, actor.orgId, storeId, { stockModel: model });
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

/** Where a person goes to clear a check, and what the link says. ⛔ Built per request beside the
 *  predicate it belongs to — never a column, never cached (bible §4.2 rule 7, §13 row 176). */
export interface ReadinessRemedy {
  readonly href: string;
  readonly label: string;
}

export interface ReadinessCheck {
  readonly key: string;
  readonly label: string;
  readonly ok: boolean;
  /** `auto` conditions are guaranteed by construction; `manual` ones encode a business fact. */
  readonly kind: 'auto' | 'manual';
  /** Blocks real use of the store until satisfied. */
  readonly blocking: boolean;
  readonly detail: string;
  /**
   * ⭐ T-243 / DEF-216. Absent when no single screen clears it — `adminScope`'s remedy is the
   * Reactivate button already on this same page, not a link to itself. Meant to be rendered only
   * while `ok` is false.
   */
  readonly remedy?: ReadinessRemedy;
}

/**
 * The one place a readiness remedy ROUTE is written. Exported as plain string literals — never
 * imported into a module that needs a database — so `apps/erp/tests/readiness-remedy-routes.test.ts`
 * can check every one resolves to a real screen without touching Postgres.
 *
 * ⛔ `adminScope` deliberately has no entry: it is cleared by the Reactivate button on this same
 * page, not by navigating anywhere.
 */
export const READINESS_REMEDY_ROUTE = {
  room: '/inventory/locations',
  salesChannel: '/settings/sales-channels',
  signIn: '/staff',
} as const;

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
  const today = await manilaToday(tx);

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
      remedy: {
        href: `${READINESS_REMEDY_ROUTE.room}?store=${store.id}`,
        label: 'Add a stock room →',
      },
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
      remedy: {
        href: `${READINESS_REMEDY_ROUTE.salesChannel}?store=${store.id}`,
        label: 'Add a sales channel →',
      },
    },
    {
      key: 'signIn',
      // ⭐ §5, and the sharpest one. A new store has nobody who can sign in at it, while the
      // sign-in page happily lists it — the first person to try reports "my PIN stopped working",
      // the least informative possible symptom of a correct system.
      //
      // ⭐ **T-302 changed what this counts, and the label had to change with it.** It used to
      // count credential ROWS stamped with this store id. Under org-scoped hashing a PIN works at
      // every branch its holder works at, so the honest count is PEOPLE who can sign in here —
      // `countActiveCredentials` now asks exactly the question `personMaySignInAtStore` asks on
      // the sign-in path. Left as it was, this gate would have BLOCKED a new branch as
      // "No one can sign in here yet" while everybody could.
      label: 'Someone can sign in here',
      ok: credentials > 0,
      kind: 'manual',
      blocking: true,
      detail: credentials > 0
        ? `${credentials} person(s) with a live PIN can sign in here.`
        : 'No one can sign in at this store yet. Hire someone here, or give an existing person store scope, and make sure they hold a PIN — issue one from Staff. ⛔ Store creation deliberately does not auto-issue a PIN, because a generated default ends up in a screenshot.',
      // ⚠️ No `?store=` — `/staff` takes no store param today; adding one is a behaviour change and
      // is out of scope for T-243.
      remedy: { href: READINESS_REMEDY_ROUTE.signIn, label: 'Issue a PIN from Staff →' },
    },
    {
      // ⭐ T-346 S1 (DEF-428). Manual, and deliberately NON-blocking (R2.2): a store not open yet is
      // a real, ordinary state — under construction, or waiting on a launch date — never a fault.
      // S2 adds the depreciation consequence to this same detail; S1 only states the fact.
      key: 'openingDate',
      label: 'Opening date',
      ok: store.openingDate !== null,
      kind: 'manual',
      blocking: false,
      detail:
        store.openingDate === null
          ? 'Not yet open — no opening date set'
          : storesRepo.isPreOpening(store.openingDate, today)
            ? `Opens ${store.openingDate}`
            : `Opened ${store.openingDate}`,
    },
  ];
}

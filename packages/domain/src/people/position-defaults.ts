/**
 * Position access defaults — the spine. T-289.
 * `docs/tasks/289-position-access-defaults-spine.md`; `docs/plans/289-position-access-defaults-plan.md`.
 *
 * An administrator sets, per POSITION and per STORE, which capabilities every holder of that job
 * gets in ADDITION to the role matrix — bible row 120's pattern ("decide once, at the moment a
 * human is present, and store the answer") applied to jobs. Each toggle writes one
 * `position_capability_defaults` row and materialises ordinary `person_grants` rows for every
 * current holder, tagged `grant_source = 'position'` with a `source_ref` back to the default.
 *
 * ⛔ **`packages/auth/src/authorize.ts` is never touched by anything in this file, and must stay
 * that way (Invariant 1).** A position never enters the check path and is never a parameter to
 * `authorize()` — it is a decision recorded as ROWS, applied by the ordinary grant mechanism
 * `authorize()` already understands.
 */
import { authorize, type Actor, type Capability } from '@shareat/auth';
import {
  CAPABILITIES,
  CAPABILITY_SCOPE,
  SUPER_ADMIN_ONLY_CAPABILITIES,
} from '@shareat/auth';
import { accessRepo, employmentRepo, personsRepo, positionDefaultsRepo, type Tx } from '@shareat/db';
import { CANONICAL_POSITIONS } from '@shareat/db/schema';

export class PositionDefaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PositionDefaultError';
  }
}

/**
 * T-289 §C10. What a position may ever be OFFERED to default — derived, never hand-listed, the
 * same "argue each new member" discipline `ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER` carries
 * (`packages/auth/src/capabilities.ts`, bible row 196).
 *
 * ⛔ **Was two checks; T-318 (2026-09-14) retired the second.** This constant is what the SCREEN
 * may render as toggleable, and it never excluded the 21 capabilities that `staff` used to hold
 * automatically through the matrix — a constant that excluded them would have left nothing for
 * T-290's INHERITED badge to render. `setPositionDefault` used to carry a SECOND check refusing a
 * default for any of those 21 ("a row that changes nothing"); Ian's ruling moved them off the
 * matrix onto position grants, so that refusal no longer applies and was deleted. This constant's
 * own definition needed no change — it never read `.staff` in the first place.
 *
 * Measured the day this was written: `CAPABILITIES` = 96, `SUPER_ADMIN_ONLY_CAPABILITIES` = 4
 * (`approve_item`, `post_journal_entry`, `cross_org_access`, `view_franchise_sales`),
 * `CAPABILITY_SCOPE` platform = 2 (both already inside the 4), `close_period` = 1 →
 * `OFFERABLE_TO_POSITIONS.length === 91`. The test asserts the DERIVATION, not 91 — the number
 * is here only so a reviewer can tell at a glance whether it ran.
 *
 * ⭐ T-344/DEF-422, R1.3 — `create_missing_period` excluded too, same bar as `close_period`: it
 * changes closed books, so it sits with the capabilities that change what a position can widen
 * rather than what it is offered. `CAPABILITIES` is 97 as of that migration; still 91 offerable.
 *
 * ⭐ T-345, same bar again — `book_missed_month` excluded too: it also changes what counts as
 * booked for a closed month. `CAPABILITIES` is 98 as of this migration; still 91 offerable.
 */
export const OFFERABLE_TO_POSITIONS: readonly Capability[] = CAPABILITIES.filter(
  (c) =>
    !SUPER_ADMIN_ONLY_CAPABILITIES.includes(c) &&
    CAPABILITY_SCOPE[c] !== 'platform' &&
    c !== 'close_period' &&
    c !== 'create_missing_period' &&
    c !== 'book_missed_month',
);

/**
 * T-336 — DEF-413. Ian's ruled table (`docs/decisions/PROPOSAL-DEF-413-default-position-capabilities.md`,
 * "approve all", plus its 2026-09-24 Amendment: Server and Dishwasher each gain `record_stock_movement`).
 * The one source of truth `seedStoreAccessDefaults` seeds from and the admin grid renders — no
 * second copy anywhere, so neither can drift from the other.
 *
 * Lives here, not beside `CANONICAL_POSITIONS` (`packages/db/schema/employment.ts`): `packages/db`
 * must not know `@shareat/auth`'s members (ADR-004) and a `Capability`-typed table there would
 * reverse that dependency.
 *
 * `Record<(typeof CANONICAL_POSITIONS)[number], …>` is the drift guard — a seventh canonical name,
 * or a rename, fails typecheck here until this table answers for it.
 */
export const CANONICAL_POSITION_DEFAULTS: Readonly<
  Record<(typeof CANONICAL_POSITIONS)[number], readonly Capability[]>
> = {
  Cashier: [
    'record_sale',
    'submit_sales_day',
    'record_statutory_discount',
    'record_till_count',
    'create_expense',
    'edit_own_expense',
    'record_order_wastage',
    'record_supplier_invoice',
    'receive_delivery',
    'confirm_receipt',
    'record_supplier_return',
    'place_branch_order',
    'fulfil_branch_order',
    'post_order_message',
    'set_item_threshold',
    'record_stock_movement',
    'transfer_stock',
    'record_wastage',
  ],
  Cook: ['record_stock_movement', 'record_wastage'],
  Server: ['record_stock_movement', 'record_wastage'],
  Dishwasher: ['record_stock_movement', 'record_wastage'],
  Slicer: ['record_stock_movement', 'record_wastage', 'request_pos_map'],
  'Inventory Staff': [
    'receive_delivery',
    'confirm_receipt',
    'record_supplier_return',
    'place_branch_order',
    'fulfil_branch_order',
    'post_order_message',
    'set_item_threshold',
    'record_stock_movement',
    'transfer_stock',
    'record_wastage',
    'request_pos_map',
  ],
};

export interface SeedStoreAccessDefaultsResult {
  readonly inserted: number;
  /** Canonical names this org has no row for yet (a raw fixture, or a pre-T-335 org the backfill
   *  hasn't reached) — reported, never thrown. T-335's backfill owns closing this, not this
   *  function. */
  readonly missingCanonical: readonly string[];
}

/**
 * T-336 §5 — seeds a brand-new store's per-position access defaults from
 * `CANONICAL_POSITION_DEFAULTS`. Called ONLY from `createStore` step 2c, on the caller's
 * transaction, after the store row exists and before the admin-scope fan-out.
 *
 * ⛔ **Virgin-store guard.** If the store already carries ANY default row (active or revoked),
 * this throws. It can never fire inside `createStore` — the store id was minted a moment earlier
 * on this same `tx` — so this is what guarantees at the code level that no existing store, and so
 * none of production's `0152` rows, can ever be seeded or re-seeded, even by a future caller.
 *
 * No `reconcilePositionGrants` call: a store minted on this `tx` has no employments yet, so there
 * is nobody to grant to. Grants arrive at hire, through `createEmployment`.
 *
 * ⛔ Authorizes itself (bible §7 rule 1: every actor-taking function's first statement is
 * `authorize()`, never "my one caller already checked"). `createStore` also authorizes
 * `manage_stores` before calling this, so the two checks are redundant on that path by
 * construction — deliberately: this function is exported and directly callable (T-336's own
 * integration tests call it outside `createStore` to exercise the virgin-store guard), and a
 * second entry point with no gate of its own would be exactly the "authorization lives one call
 * away, trust the caller" shape bible §7 exists to forbid.
 */
export async function seedStoreAccessDefaults(
  tx: Tx,
  actor: Actor,
  storeId: string,
): Promise<SeedStoreAccessDefaultsResult> {
  await authorize(tx, actor, 'manage_stores', {});

  if (await positionDefaultsRepo.anyDefaultAtStore(tx, storeId)) {
    throw new PositionDefaultError(
      `Store ${storeId} already has access-default rows — seedStoreAccessDefaults only ever runs ` +
        'once, on a brand-new store. Re-seeding an existing store is refused, not repeated.',
    );
  }

  const positions = await employmentRepo.listPositions(tx, actor.orgId, storeId);
  // Matched case/space-insensitively, like every other canonical-name comparison in this codebase
  // (`positions_org_scope_name_unique`, `employmentRepo.findPositionByName`) — a canonical row
  // seeded or hand-inserted as ' server ' must still resolve to `Server`'s defaults.
  const canonicalByName = new Map(
    positions.filter((p) => p.isCanonical).map((p) => [p.name.trim().toLowerCase(), p.id]),
  );

  const missingCanonical: string[] = [];
  const pairs: { positionId: string; capability: string }[] = [];
  for (const name of CANONICAL_POSITIONS) {
    const positionId = canonicalByName.get(name.trim().toLowerCase());
    if (!positionId) {
      missingCanonical.push(name);
      continue;
    }
    for (const capability of CANONICAL_POSITION_DEFAULTS[name]) {
      if (!OFFERABLE_TO_POSITIONS.includes(capability)) {
        // The constant must never contain one (U1 pins that) — this is the last line, not the only one.
        throw new PositionDefaultError(
          `CANONICAL_POSITION_DEFAULTS['${name}'] names '${capability}', which is not offerable to a position.`,
        );
      }
      pairs.push({ positionId, capability });
    }
  }

  const { inserted } = await positionDefaultsRepo.insertDefaultsForNewStore(tx, {
    orgId: actor.orgId,
    storeId,
    setBy: actor.personId,
    pairs,
  });
  return { inserted, missingCanonical };
}

export interface ReconcileResult {
  readonly granted: readonly Capability[];
  readonly revoked: readonly Capability[];
  readonly skippedSelf: boolean;
}

/**
 * The ONE primitive every moment a job changes calls. §C7. All steps run inside the CALLER's
 * transaction — it never opens its own (Invariant 9; the closed-caller-list test,
 * `tests/unit/position-defaults-callers.test.ts`, is what keeps this function reachable only
 * from the five call sites the spec names).
 *
 * **Authority note — the one place a lower authority causes grant rows** (plan §4.1). This
 * function does NOT call `authorize()` itself. The *decision* was authorised at toggle time by
 * a `grant_capability` holder (`setPositionDefault`); a hire by an `enrol_staff` holder merely
 * *applies* it. Same relationship as `assignRole` writing elevation grants after one
 * `manage_users` check.
 */
export async function reconcilePositionGrants(
  tx: Tx,
  actor: Actor,
  input: { personId: string; storeId: string },
): Promise<ReconcileResult> {
  // Step 1 — skip self, first. Self-grant stays refused (bible §7 rule 5); the rest of the
  // fan-out proceeds and the CALLER reports the skip (decision 4).
  if (input.personId === actor.personId) {
    return { granted: [], revoked: [], skippedSelf: true };
  }

  // Step 2 — "wanted": the active defaults for this store this person's open employment
  // positions there justify.
  const wanted = await positionDefaultsRepo.wantedDefaultsForPersonAtStore(tx, {
    personId: input.personId,
    storeId: input.storeId,
  });
  const wantedIds = new Set(wanted.map((w) => w.id));
  // Two positions may default the same capability (case 6); either default id justifies it
  // equally and only one active person_grants row can ever exist regardless, so dedupe.
  const wantedByCapability = new Map<Capability, string>();
  for (const w of wanted) {
    const capability = w.capability as Capability;
    if (!wantedByCapability.has(capability)) wantedByCapability.set(capability, w.id);
  }

  // Step 3 — "held": this person's active 'position'-sourced grants whose ref belongs to a
  // default of this store, active OR revoked (a switched-off default's grant rows must stay
  // reachable here, or they become unreachable orphans).
  const held = await positionDefaultsRepo.heldPositionGrantsForPersonAtStore(tx, {
    personId: input.personId,
    storeId: input.storeId,
  });

  // Step 4 — revoke every held row no longer wanted.
  const revoked: Capability[] = [];
  for (const row of held) {
    if (!wantedIds.has(row.sourceRef)) {
      await accessRepo.revokeGrantById(
        tx,
        row.id,
        `Position default no longer applies: ${row.positionName} at ${row.storeName}`,
      );
      revoked.push(row.grantName as Capability);
    }
  }

  // Step 5 — grant every wanted capability. T-341 / DEF-414: `grantCapability`'s 'position' arm
  // COEXISTS with a person-level row rather than rewriting it (schema/access.ts's two partial
  // unique indexes, migration 0159) — no rank logic survives here either. `existingActive` is
  // this person's active 'position' rows AT THIS STORE ONLY: a capability already held here via a
  // position default is idempotent (not newly granted); a capability held only by a person-level
  // hand-grant, or by a 'position' row at a DIFFERENT store, is still genuinely NEW at this store
  // — `grantCapability` inserts a real second row for it, and `granted` reports that (Amendment
  // R1 item 3: `affected` now counts this, where the old rank comparison undercounted it).
  const existingActive = new Map(
    (await accessRepo.grantsForPerson(tx, input.personId))
      .filter((g) => g.revokedAt === null && g.grantSource === 'position' && g.storeId === input.storeId)
      .map((g) => [g.grantName as Capability, g] as const),
  );

  const granted: Capability[] = [];
  for (const [capability, defaultId] of wantedByCapability) {
    await accessRepo.grantCapability(tx, {
      personId: input.personId,
      grantName: capability,
      grantedBy: actor.personId,
      grantSource: 'position',
      sourceRef: defaultId,
    });
    if (!existingActive.has(capability)) {
      granted.push(capability);
    }
  }

  return { granted, revoked, skippedSelf: false };
}

export interface SetPositionDefaultInput {
  positionId: string;
  storeId: string;
  capability: Capability;
  on: boolean;
  reason?: string;
}

/**
 * Toggle one (position, store, capability) default on or off, then reconcile every open-
 * employment holder of that position at that store. §C8, §C9 moments 1 and 2 (one function,
 * both directions).
 */
export async function setPositionDefault(
  tx: Tx,
  actor: Actor,
  input: SetPositionDefaultInput,
): Promise<{ affected: number; skippedSelf: boolean; wroteDefault: boolean }> {
  // 1 — every call, both directions. `grant_capability` already means "may change who can do
  // what" (plan §2 constraint 6); no new capability is added for this screen.
  await authorize(tx, actor, 'grant_capability', {});

  // 2 — the store belongs to the actor's org.
  const storeInOrg = await accessRepo.storeBelongsToOrg(tx, input.storeId, actor.orgId);
  if (!storeInOrg) {
    throw new PositionDefaultError(`Store ${input.storeId} does not belong to this organisation.`);
  }

  // 3 — the position is canonical, or belongs to this store (§C1.5 — enforced here because
  // Drizzle/Postgres cannot express a cross-table rule without a trigger).
  const [position] = await employmentRepo.getPositionsByIds(tx, actor.orgId, [input.positionId]);
  if (!position) {
    throw new PositionDefaultError(`Position ${input.positionId} does not exist in this organisation.`);
  }
  if (position.storeId !== null && position.storeId !== input.storeId) {
    throw new PositionDefaultError(`Position '${position.name}' belongs to a different store.`);
  }

  // 4 — the capability is offerable (§C10's original single check). ⛔ T-318 (2026-09-14):
  // the second check that lived here — refusing a default for any of the 21 capabilities the
  // `staff` role held automatically — is deleted. Ian's ruling moved those 21 OFF the matrix and
  // onto position grants, so a default for one of them is now the only way a position holds it,
  // not "a row that changes nothing".
  if (!OFFERABLE_TO_POSITIONS.includes(input.capability)) {
    throw new PositionDefaultError(
      `'${input.capability}' may not be defaulted to a position — it is reserved to a role, a ` +
        'platform-only action, or conditional on data about the PERSON rather than the job.',
    );
  }

  // 5 — insert (idempotent) or revoke. `wroteDefault` says whether a DEFAULT row changed, which
  // the bulk actions report separately from `affected` (people): writing four rows that reach
  // nobody today is a real change, and "Nothing changed" over it would be a lie about the rows.
  let wroteDefault = false;
  if (input.on) {
    const existing = await positionDefaultsRepo.findActiveDefault(tx, {
      positionId: input.positionId,
      storeId: input.storeId,
      capability: input.capability,
    });
    if (!existing) {
      await positionDefaultsRepo.insertDefault(tx, {
        orgId: actor.orgId,
        positionId: input.positionId,
        storeId: input.storeId,
        capability: input.capability,
        setBy: actor.personId,
      });
      wroteDefault = true;
    }
  } else {
    const existing = await positionDefaultsRepo.findActiveDefault(tx, {
      positionId: input.positionId,
      storeId: input.storeId,
      capability: input.capability,
    });
    if (existing) {
      const actorPerson = await personsRepo.getPersonById(tx, actor.orgId, actor.personId);
      const reason = input.reason?.trim() || `Switched off by ${actorPerson?.displayName ?? 'an administrator'}`;
      await positionDefaultsRepo.revokeDefaultById(tx, existing.id, actor.personId, reason);
      wroteDefault = true;
    }
  }

  // 6 — reconcile every person with an open employment at this store holding this position.
  const fanout = await reconcileHolders(tx, actor, input.storeId, input.positionId);
  return { ...fanout, wroteDefault };
}

/**
 * Retire a store's own position. §C8, §C9 moment 6. Never a canonical position (T-154: a store
 * may not edit or delete one of the canonical six). Retiring only ever NARROWS (Invariant 3) —
 * it revokes the position's default rows and reconciles its holders; it never widens anything.
 */
export async function retireStorePosition(
  tx: Tx,
  actor: Actor,
  input: { positionId: string },
): Promise<{ affected: number; skippedSelf: boolean }> {
  await authorize(tx, actor, 'grant_capability', {});

  const [position] = await employmentRepo.getPositionsByIds(tx, actor.orgId, [input.positionId]);
  if (!position) {
    throw new PositionDefaultError(`Position ${input.positionId} does not exist in this organisation.`);
  }
  if (position.storeId === null) {
    throw new PositionDefaultError(
      `'${position.name}' is a canonical position and belongs to the organisation, not to a ` +
        'store — it cannot be retired.',
    );
  }

  const activeDefaults = await positionDefaultsRepo.activeDefaultsForPosition(tx, input.positionId);
  for (const d of activeDefaults) {
    await positionDefaultsRepo.revokeDefaultById(tx, d.id, actor.personId, 'Position retired');
  }
  await positionDefaultsRepo.deactivatePosition(tx, input.positionId);

  return reconcileHolders(tx, actor, position.storeId, input.positionId);
}

/** Shared fan-out: reconcile every person with an open employment at `storeId` holding
 *  `positionId`, and summarise the result the way `setPositionDefault`/`retireStorePosition`
 *  both report it — `affected` counts people ACTUALLY written, `skippedSelf` is true if the
 *  actor was one of the holders. */
async function reconcileHolders(
  tx: Tx,
  actor: Actor,
  storeId: string,
  positionId: string,
): Promise<{ affected: number; skippedSelf: boolean }> {
  const personIds = await positionDefaultsRepo.openEmploymentPersonIdsForPosition(tx, { storeId, positionId });

  let affected = 0;
  let skippedSelf = false;
  for (const personId of personIds) {
    const result = await reconcilePositionGrants(tx, actor, { personId, storeId });
    if (result.skippedSelf) {
      skippedSelf = true;
    } else if (result.granted.length > 0 || result.revoked.length > 0) {
      affected++;
    }
  }
  return { affected, skippedSelf };
}

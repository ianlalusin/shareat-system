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
  CAPABILITY_MATRIX,
  CAPABILITY_SCOPE,
  SUPER_ADMIN_ONLY_CAPABILITIES,
} from '@shareat/auth';
import { accessRepo, employmentRepo, personsRepo, positionDefaultsRepo, type Tx } from '@shareat/db';

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
 * ⭐ **Two checks, not one — planner ruling, plan §11.3.** This constant is what the SCREEN may
 * render as toggleable. It deliberately does NOT also exclude the 21 capabilities the `staff`
 * role already holds in the matrix: T-290 must still render those as INHERITED ("shown, not
 * hidden" — plan §4.3), and a constant that excluded them would leave nothing to render. The
 * staff-matrix refusal is the second, separate check, in `setPositionDefault` below.
 *
 * Measured the day this was written: `CAPABILITIES` = 96, `SUPER_ADMIN_ONLY_CAPABILITIES` = 4
 * (`approve_item`, `post_journal_entry`, `cross_org_access`, `view_franchise_sales`),
 * `CAPABILITY_SCOPE` platform = 2 (both already inside the 4), `close_period` = 1 →
 * `OFFERABLE_TO_POSITIONS.length === 91`. The test asserts the DERIVATION, not 91 — the number
 * is here only so a reviewer can tell at a glance whether it ran.
 */
export const OFFERABLE_TO_POSITIONS: readonly Capability[] = CAPABILITIES.filter(
  (c) =>
    !SUPER_ADMIN_ONLY_CAPABILITIES.includes(c) &&
    CAPABILITY_SCOPE[c] !== 'platform' &&
    c !== 'close_period',
);

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

  // Step 5 — grant every wanted capability. `grantCapability` is idempotent per §C4/§C5; a
  // capability already actively held (any source) is left alone unless the incoming 'position'
  // rank strictly outranks the stored one, in which case grantCapability rewrites provenance
  // (and, for 'position', the ref) in the same statement. `granted` reports only capabilities
  // that are genuinely NEW to this person or newly justified at the 'position' rank — read
  // BEFORE the call so a same-rank or higher-ranked existing row is never miscounted.
  const existingActive = new Map(
    (await accessRepo.grantsForPerson(tx, input.personId))
      .filter((g) => g.revokedAt === null)
      .map((g) => [g.grantName as Capability, g] as const),
  );

  const granted: Capability[] = [];
  for (const [capability, defaultId] of wantedByCapability) {
    const existing = existingActive.get(capability);
    const existingRank = existing ? accessRepo.grantSourceRank(existing.grantSource) : -1;
    await accessRepo.grantCapability(tx, {
      personId: input.personId,
      grantName: capability,
      grantedBy: actor.personId,
      grantSource: 'position',
      sourceRef: defaultId,
    });
    if (accessRepo.grantSourceRank('position') > existingRank) {
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
): Promise<{ affected: number; skippedSelf: boolean }> {
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

  // 4 — the capability is offerable (§C10's two checks).
  if (!OFFERABLE_TO_POSITIONS.includes(input.capability)) {
    throw new PositionDefaultError(
      `'${input.capability}' may not be defaulted to a position — it is reserved to a role, a ` +
        'platform-only action, or conditional on data about the PERSON rather than the job.',
    );
  }
  if (CAPABILITY_MATRIX[input.capability].staff) {
    throw new PositionDefaultError(
      `Every staff member already holds '${input.capability}' through the role matrix — a ` +
        'position default would be a row that changes nothing.',
    );
  }

  // 5 — insert (idempotent) or revoke.
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
    }
  }

  // 6 — reconcile every person with an open employment at this store holding this position.
  return reconcileHolders(tx, actor, input.storeId, input.positionId);
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

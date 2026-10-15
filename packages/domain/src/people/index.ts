/**
 * The staff master record — hiring, ending, and what work someone does. T-154.
 * `docs/tasks/154-positions-and-employments.md`, `docs/plans/phase-4-attendance.md` §2.
 *
 * ## ⭐ Every function here takes an `Actor`, and never a person id it believes
 *
 * Bible §7.1, binding: *"Acting identity is read from that token, server-side. **No server action
 * ever accepts an actor identity as a parameter.**"* The `Actor` reaching these functions comes from
 * `resolveActor` (T-138), which is why `created_by` on an employment is worth anything at all —
 * v1's equivalent is a client-supplied parameter on ~24 server actions (landmine #17).
 */
import { authorize, can, type Actor } from '@shareat/auth';
import {
  accessRepo,
  auditLogRepo,
  employmentRepo,
  personsRepo,
  sessionsRepo,
  type EmploymentRow,
  type PersonRow,
  type PositionRow,
  type RosterRow,
  type Tx,
} from '@shareat/db';
import { DEFAULT_POSITION, type EmploymentStatus } from '@shareat/db/schema';
// T-289 — the primitive used internally at moments 3, 4, 5 (hire / positions changed / end),
// and the two screen-facing entry points re-exported below. `reconcilePositionGrants` itself is
// NOT re-exported here — `tests/unit/position-defaults-callers.test.ts` is the closed-importer
// guard that keeps it reachable only from this file, its own definition, and its integration test.
import { reconcilePositionGrants } from './position-defaults';
// `OFFERABLE_TO_POSITIONS` crosses the barrel too: T-290's screen renders from it and the spec
// says "import it, never re-derive it" — a second derivation in apps/erp is a second source of
// truth. (T-289's own file list missed this line; T-290's build found it.)
export {
  OFFERABLE_TO_POSITIONS,
  CANONICAL_POSITION_DEFAULTS,
  retireStorePosition,
  setPositionDefault,
  seedStoreAccessDefaults,
} from './position-defaults';

export class EmploymentError extends Error {
  /** A sentence a person at the screen (or Ian at the terminal) can act on. Set where the refusal is about their input. */
  readonly userReason?: string;
  constructor(message: string, userReason?: string) {
    super(message);
    this.name = 'EmploymentError';
    if (userReason !== undefined) this.userReason = userReason;
  }
}

/** T-391 S9: v2's staff-code shape. */
const STAFF_CODE_SHAPE = /^SE-\d{3}$/i;

/** The statuses that MEAN the person has left, and therefore require an end date. */
const ENDED_STATUSES: readonly EmploymentStatus[] = ['resigned', 'terminated'];

export interface CreateEmploymentInput {
  storeId: string;
  personId: string;
  employmentStatus: EmploymentStatus;
  startedOn: string;
  notes?: string | null;
  /** Omitted ⇒ the least-privileged default. See below. */
  positionIds?: string[];
  primaryPositionId?: string;
  /**
   * T-391 S9. Keep a code the person already carries (v1's) instead of allocating the next one. Shape `SE-NNN`; refused
   * when the code is taken at this store; one audit row when used. Omitted: `max + 1`, as always.
   */
  staffCode?: string;
  /** Where the hire came from, for the override's audit row. */
  source?: 'web' | 'etl';
}

/**
 * Hire someone.
 *
 * ⭐ **With no position given, they get `Server`** — v1's `DEFAULT_POSITION_NAME`, chosen because
 * *"'Server' is not referenced by any nav group or server-side gate, so an unspecified role lands on
 * the floor-crew baseline instead of silently inheriting someone else's permissions"*
 * (`ERP-rebuild/src/types/position.ts:58-64`). Fail-closed, applied to a taxonomy.
 */
export async function createEmployment(
  tx: Tx,
  actor: Actor,
  input: CreateEmploymentInput,
): Promise<EmploymentRow> {
  await authorize(tx, actor, 'enrol_staff', { storeId: input.storeId });

  if (ENDED_STATUSES.includes(input.employmentStatus)) {
    throw new EmploymentError(
      `Cannot hire someone as '${input.employmentStatus}' — that status means they have left, and ` +
        'an ended employment needs an end date. Hire them, then end it.',
    );
  }

  // ⛔ Checked here for a comprehensible message, and enforced by a partial unique index regardless
  // (bible §16.4's principle: the database enforces the rule, the service explains it).
  const open = await employmentRepo.findOpenEmployment(tx, input.personId, input.storeId);
  if (open) {
    throw new EmploymentError(
      `This person already has an open employment at this store (${open.staffCode}). End it before ` +
        'starting a new one — two open employments is how a punch lands on the wrong one.',
    );
  }

  let staffCode: string;
  const override = input.staffCode === undefined ? undefined : input.staffCode.trim().toUpperCase();
  if (override !== undefined) {
    if (!STAFF_CODE_SHAPE.test(override)) {
      throw new EmploymentError(
        `Staff code '${input.staffCode}' is not SE-NNN.`,
        `Staff code '${input.staffCode}' is not valid. It looks like SE-014: SE, a dash, three digits.`,
      );
    }
    if (await employmentRepo.findEmploymentByStaffCode(tx, input.storeId, override)) {
      throw new EmploymentError(
        `Staff code ${override} is already used at this store.`,
        `Staff code ${override} is already used at this store. Leave the code blank to get the next free one.`,
      );
    }
    staffCode = override;
  } else {
    staffCode = await employmentRepo.allocateStaffCode(tx, input.storeId);
  }
  const employment = await employmentRepo.insertEmployment(tx, {
    orgId: actor.orgId,
    storeId: input.storeId,
    personId: input.personId,
    staffCode,
    employmentStatus: input.employmentStatus,
    startedOn: input.startedOn,
    notes: input.notes ?? null,
    createdBy: actor.personId,
  });

  if (override !== undefined) {
    await auditLogRepo.append(tx, actor.orgId, {
      actorPersonId: actor.personId,
      action: 'set_staff_code',
      storeId: input.storeId,
      entityId: employment.id,
      before: null,
      after: { staffCode: override, storeId: input.storeId, personId: input.personId },
      source: input.source ?? 'web',
    });
  }

  const { positionIds, primaryPositionId } = await resolvePositions(tx, actor, input);
  await employmentRepo.replaceEmploymentPositions(tx, {
    employmentId: employment.id,
    positionIds,
    primaryPositionId,
  });

  // T-336, Ian's ruling 2026-09-24 — a hire is inert without this: `authorize()` refuses anyone
  // with no active role at all, before it ever looks at a position-sourced grant
  // (`packages/auth/src/authorize.ts`, axis 1), so T-336's whole per-position defaults table would
  // grant nothing to a plain hire without a baseline role to carry it. Guarded, not unconditional —
  // a person hired at a SECOND store who already holds admin/manager/super_admin/staff in this org
  // must never be touched here. `accessRepo.insertRole` is the bare primitive (no revoke-prior-role
  // logic, no elevation logic — see its own doc comment); `assignRoleAsActor`
  // (`packages/auth/src/roles.ts`) is for an explicit admin-initiated role CHANGE and does not apply
  // to a brand-new hire's baseline role.
  //
  // ⛔ Race-safe: `accessRepo.lockOrgAccess` (T-237, DEF-232's shape) serialises this check-then-act
  // per ORG, so two concurrent hires of the same person at two different stores in this org cannot
  // both read "no active role" and both insert — the second waits, then sees the first's row and
  // skips. `insertRole` itself stays a bare primitive with no `on conflict` of its own (its other
  // caller, `createFirstAdmin`, wants a real 23505 if a role somehow already exists there); the lock
  // is what makes the check trustworthy instead of the insert forgiving.
  await accessRepo.lockOrgAccess(tx, actor.orgId);
  if (!(await accessRepo.activeRoleForPerson(tx, input.personId, actor.orgId))) {
    await accessRepo.insertRole(tx, {
      personId: input.personId,
      orgId: actor.orgId,
      role: 'staff',
      grantedBy: actor.personId,
    });
  }

  // T-336 — the auto-role above satisfies authorize()'s axis 1, but a store-scoped capability
  // (`CAPABILITY-MATRIX.md` rule 4) still needs axis 2, a `person_store_scope` row, checked
  // SEPARATELY and ALWAYS. Without this, a fresh hire with a real position grant is refused "no
  // store scope" — role and scope are different axes on purpose (invariant 6), so satisfying one
  // does not imply the other. `source: 'employment'` (SCOPE LIFECYCLE fix, migration 0156) is what
  // lets `endEmployment` later tell "this row exists because of THIS hire" apart from an admin's
  // deliberate grant or the new-admin/new-store fan-out — never overwrites an existing row of any
  // source, so calling it here unconditionally is safe: nothing changes if this hire (e.g. the
  // org's own admin, hired at their own store) already holds scope some other way.
  await accessRepo.grantStoreScope(tx, {
    personId: input.personId,
    storeId: input.storeId,
    grantedBy: actor.personId,
    source: 'employment',
  });

  // T-289 moment 3 — a hire applies whatever position defaults the assigned positions carry.
  await reconcilePositionGrants(tx, actor, { personId: input.personId, storeId: input.storeId });

  // T-402 S2 - last, so a refused hire (every throw above) leaves no row, and a rolled-back hire takes it with it.
  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: 'employment.created',
    storeId: input.storeId,
    entityId: employment.id,
    before: null,
    after: {
      personId: input.personId,
      storeId: input.storeId,
      staffCode,
      employmentStatus: input.employmentStatus,
      startedOn: input.startedOn,
    },
    source: input.source ?? 'web',
  });

  return employment;
}

/**
 * ⭐ T-202 / DEF-131. The gap T-154 didn't anticipate: no domain function anywhere created a
 * `persons` row — the only writer in the whole repo was raw SQL in `scripts/dev-seed.ts:102`, and
 * `createEmployment` above requires an existing `personId`. A real onboarding screen cannot work
 * without this.
 *
 * Authorises `enrol_staff` scoped to `input.storeId` — **the same capability `createEmployment`
 * already checks**, not a new one. `storeId` is context for the authorize call only; it is never
 * persisted on `persons` (bible §4.2 — a person has no store of its own, an employment does).
 */
export async function createPerson(
  tx: Tx,
  actor: Actor,
  input: { storeId: string; displayName: string },
): Promise<PersonRow> {
  await authorize(tx, actor, 'enrol_staff', { storeId: input.storeId });

  const displayName = input.displayName.trim();
  if (!displayName) throw new EmploymentError('A person needs a name.');

  return personsRepo.insertPerson(tx, { orgId: actor.orgId, displayName });
}

/**
 * ⭐ T-202. Finds "the same Maria who already works Lipa" so the hire flow can offer the existing
 * person back instead of minting a duplicate — T-154 invariant 8 (one person, two stores, two
 * employments) only works if the UI ever does.
 *
 * `enrol_staff` has store scope (Contract §2), and this call carries no single store to check —
 * a manager searching for someone to hire may cover several. Authorised against **every store the
 * actor covers**, refused only if none of them pass — the same sweep
 * `statutoryDiscounts/authorizeRead` already uses for a store-scoped capability with no one store
 * named.
 */
export async function searchPersons(
  tx: Tx,
  actor: Actor,
  input: { query: string },
): Promise<PersonRow[]> {
  const storeIds = await accessRepo.storeIdsForPerson(tx, actor.personId);
  if (storeIds.length === 0) {
    throw new EmploymentError('You have no store scope, so you may not search for staff to hire.');
  }

  // T-402 S2 (A2): each store is asked with the non-logging `can()`; only when none passes is `authorize()` called ONCE
  // on the first store, so a refused search logs one real denial and throws the usual refusal (like trade's authorizeEither).
  let authorized = false;
  for (const storeId of storeIds) {
    if (await can(tx, actor, 'enrol_staff', { storeId })) {
      authorized = true;
      break;
    }
  }
  if (!authorized) {
    await authorize(tx, actor, 'enrol_staff', { storeId: storeIds[0]! });
    throw new EmploymentError('Not authorized to search staff.');
  }

  return personsRepo.searchPersons(tx, { orgId: actor.orgId, query: input.query });
}

/**
 * End an employment. **Never a delete** — the row, its positions and its punches are the audit
 * trail for everything the person did.
 */
export async function endEmployment(
  tx: Tx,
  actor: Actor,
  input: { employmentId: string; endedOn: string; employmentStatus: EmploymentStatus },
): Promise<EmploymentRow> {
  const existing = await employmentRepo.getEmployment(tx, input.employmentId);
  if (!existing) throw new EmploymentError(`No employment ${input.employmentId}`);
  await authorize(tx, actor, 'enrol_staff', { storeId: existing.storeId, orgId: existing.orgId });

  if (!ENDED_STATUSES.includes(input.employmentStatus)) {
    throw new EmploymentError(
      `Ending an employment needs a terminal status (${ENDED_STATUSES.join(' or ')}), not ` +
        `'${input.employmentStatus}'. An end date with a live status is the shape that makes ` +
        '"when did they leave" unanswerable, which is exactly what v1 does.',
    );
  }
  if (input.endedOn < existing.startedOn) {
    throw new EmploymentError(
      `End date ${input.endedOn} is before the start date ${existing.startedOn}.`,
    );
  }

  // T-407 Inv 21: serialise concurrent ends for the same person BEFORE writing (no lock-order deadlock).
  await employmentRepo.lockPersonEmployments(tx, existing.personId, existing.orgId);

  const closed = await employmentRepo.closeEmployment(tx, input);

  // T-289 moment 5 — ending the employment leaves no open employment at this store, so
  // `wanted` computes empty and every position-sourced row for THIS store is revoked; other
  // stores are untouched (a person may hold two open employments, one per store).
  await reconcilePositionGrants(tx, actor, { personId: existing.personId, storeId: existing.storeId });

  // T-336 SCOPE LIFECYCLE fix (migration 0156) — the bug this closes: the hire-time scope grant
  // was never revoked, so a terminated cashier kept sign-in. Delete the row ONLY when it exists
  // BECAUSE of this employment (`source = 'employment'`) and no other open employment remains at
  // this store — never an admin's deliberate `'manual'` grant or the `'fan_out'` materialisation,
  // and never scope this same person still needs for a genuinely separate reason at this store.
  const scope = await accessRepo.findStoreScope(tx, existing.personId, existing.storeId);
  if (scope?.source === 'employment') {
    const stillOpen = await employmentRepo.findOpenEmployment(tx, existing.personId, existing.storeId);
    if (!stillOpen) {
      await accessRepo.deleteStoreScopeById(tx, scope.id);
    }
  }

  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: 'employment.ended',
    storeId: existing.storeId,
    entityId: existing.id,
    before: { employmentStatus: existing.employmentStatus, endedOn: existing.endedOn },
    after: { employmentStatus: input.employmentStatus, endedOn: input.endedOn, personId: existing.personId },
    source: 'web',
  });

  // T-407 R4 (DEF-649): a person who can no longer sign in loses the sessions they already hold, in THIS transaction -
  // the end and the revocation commit or roll back together (a failure here refuses the whole termination, visibly).
  // The two checks take `for share` on the person's employment rows (R7), so a racing sign-in is either seen here or
  // refused by the closed row.
  let endedSessions = 0;
  let endedAtStore: string | null = null;
  if (!(await accessRepo.personMaySignInToOrg(tx, existing.personId, existing.orgId))) {
    endedSessions = await sessionsRepo.endAllForPerson(tx, existing.personId, 'revoked');
  } else if (!(await accessRepo.personMaySignInAtStore(tx, existing.personId, existing.storeId))) {
    endedAtStore = existing.storeId;
    endedSessions = await sessionsRepo.endAllForPerson(tx, existing.personId, 'revoked', existing.storeId);
  }
  if (endedSessions > 0) {
    // Built outside the call: the T-402 S1b static guard reads any `storeId:` inside an append call as the row's store.
    const after = { reason: 'employment_ended', employmentId: existing.id, storeId: endedAtStore, ended: endedSessions };
    await auditLogRepo.append(tx, actor.orgId, {
      actorPersonId: actor.personId,
      action: 'session.ended_all',
      storeId: null,
      entityId: existing.personId,
      before: null,
      after,
      source: 'web',
    });
  }

  return closed;
}

/** Replace the set of positions an employment holds, naming exactly one primary. */
export async function setEmploymentPositions(
  tx: Tx,
  actor: Actor,
  input: { employmentId: string; positionIds: string[]; primaryPositionId: string },
): Promise<void> {
  const existing = await employmentRepo.getEmployment(tx, input.employmentId);
  if (!existing) throw new EmploymentError(`No employment ${input.employmentId}`);
  await authorize(tx, actor, 'enrol_staff', { storeId: existing.storeId, orgId: existing.orgId });

  const resolved = await resolvePositions(tx, actor, {
    storeId: existing.storeId,
    positionIds: input.positionIds,
    primaryPositionId: input.primaryPositionId,
  });
  await employmentRepo.replaceEmploymentPositions(tx, {
    employmentId: input.employmentId,
    ...resolved,
  });

  // T-289 moment 4 — a positions change reconciles the new set: capabilities the old positions
  // defaulted and the new ones do not are revoked; capabilities the new ones default are granted.
  await reconcilePositionGrants(tx, actor, { personId: existing.personId, storeId: existing.storeId });

  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: 'employment.positions_set',
    storeId: existing.storeId,
    entityId: existing.id,
    before: null,
    after: { personId: existing.personId, positionIds: input.positionIds, primaryPositionId: input.primaryPositionId },
    source: 'web',
  });
}

/** Add or rename a store's own position. ⛔ Canonical positions are not editable by a store. */
export async function upsertStorePosition(
  tx: Tx,
  actor: Actor,
  input: { storeId: string; name: string },
): Promise<PositionRow> {
  await authorize(tx, actor, 'manage_store_settings', { storeId: input.storeId });

  const name = input.name.trim();
  if (!name) throw new EmploymentError('A position needs a name.');

  const canonical = await employmentRepo.findPositionByName(tx, actor.orgId, null, name);
  if (canonical) {
    throw new EmploymentError(
      `'${name}' is a canonical position and belongs to the organisation, not to a store. ` +
        'It is already available here — assign it rather than redefining it.',
    );
  }

  const existing = await employmentRepo.findPositionByName(tx, actor.orgId, input.storeId, name);
  if (existing) return existing;

  return employmentRepo.insertStorePosition(tx, {
    orgId: actor.orgId,
    storeId: input.storeId,
    name,
    createdBy: actor.personId,
  });
}

export async function listPositions(
  tx: Tx,
  actor: Actor,
  input: { storeId: string },
): Promise<PositionRow[]> {
  return employmentRepo.listPositions(tx, actor.orgId, input.storeId);
}

/** Who is on the roster. Reads `v_active_employments` — there is no stored boolean to read. */
export async function listRoster(tx: Tx, input: { storeId: string }): Promise<RosterRow[]> {
  return employmentRepo.listActiveRoster(tx, input.storeId);
}

/** Seed the canonical six for an org. Idempotent. */
export async function seedCanonicalPositions(tx: Tx, orgId: string): Promise<{ inserted: number }> {
  return employmentRepo.seedCanonical(tx, orgId);
}

// -------------------------------------------------------------------------------------

/**
 * Turn the caller's position intent into a validated `{ positionIds, primaryPositionId }`.
 *
 * Three rules, all of which exist because their absence is a real failure mode:
 *   - nothing given ⇒ the least-privileged default, as primary;
 *   - a primary outside the assigned set is refused, not silently added — "primary" would
 *     otherwise mean something the list does not say;
 *   - one primary given with no explicit list ⇒ that one, alone.
 */
async function resolvePositions(
  tx: Tx,
  actor: Actor,
  input: { storeId: string; positionIds?: string[]; primaryPositionId?: string },
): Promise<{ positionIds: string[]; primaryPositionId: string }> {
  const requested = input.positionIds ?? (input.primaryPositionId ? [input.primaryPositionId] : []);

  if (requested.length === 0) {
    const fallback = await employmentRepo.findPositionByName(tx, actor.orgId, null, DEFAULT_POSITION);
    if (!fallback) {
      throw new EmploymentError(
        `The default position '${DEFAULT_POSITION}' is missing for this organisation — the ` +
          'canonical positions have not been seeded. Seed them before hiring.',
      );
    }
    return { positionIds: [fallback.id], primaryPositionId: fallback.id };
  }

  const unique = [...new Set(requested)];
  const found = await employmentRepo.getPositionsByIds(tx, actor.orgId, unique);
  if (found.length !== unique.length) {
    throw new EmploymentError('One or more positions do not exist in this organisation.');
  }
  for (const p of found) {
    if (p.storeId !== null && p.storeId !== input.storeId) {
      throw new EmploymentError(`Position '${p.name}' belongs to a different store.`);
    }
  }

  const primary = input.primaryPositionId ?? unique[0]!;
  if (!unique.includes(primary)) {
    throw new EmploymentError(
      'The primary position must be one of the assigned positions — a primary the list does not ' +
        'contain is a contradiction, not a shortcut for adding it.',
    );
  }
  return { positionIds: unique, primaryPositionId: primary };
}

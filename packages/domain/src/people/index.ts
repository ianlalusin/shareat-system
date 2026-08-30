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
import { authorize, type Actor } from '@shareat/auth';
import { employmentRepo, type EmploymentRow, type PositionRow, type RosterRow, type Tx } from '@shareat/db';
import { DEFAULT_POSITION, type EmploymentStatus } from '@shareat/db/schema';

export class EmploymentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmploymentError';
  }
}

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

  const staffCode = await employmentRepo.allocateStaffCode(tx, input.storeId);
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

  const { positionIds, primaryPositionId } = await resolvePositions(tx, actor, input);
  await employmentRepo.replaceEmploymentPositions(tx, {
    employmentId: employment.id,
    positionIds,
    primaryPositionId,
  });

  return employment;
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

  return employmentRepo.closeEmployment(tx, input);
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
export async function seedCanonicalPositions(tx: Tx, orgId: string): Promise<void> {
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

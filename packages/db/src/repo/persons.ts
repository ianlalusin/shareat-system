/**
 * The only place SQL is written for `persons`. T-202 / DEF-131.
 *
 * ⭐ Until this file existed, the only writer of a `persons` row anywhere in the codebase was raw
 * SQL in `scripts/dev-seed.ts:102` — `createEmployment` (T-154) requires an existing `personId`,
 * so a real onboarding screen could not work without this closing first (docs/tasks/202-*.md).
 */
import { and, asc, eq, ilike, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../client';
import { persons } from '../../schema/persons';
import { personGrants, personRoles, personStoreScope } from '../../schema/access';

export interface PersonRow {
  id: string;
  orgId: string;
  displayName: string;
  isActive: boolean;
}

export async function insertPerson(
  tx: Tx,
  input: { orgId: string; displayName: string },
): Promise<PersonRow> {
  const [row] = await tx
    .insert(persons)
    .values({ orgId: input.orgId, displayName: input.displayName })
    .returning({ id: persons.id, orgId: persons.orgId, displayName: persons.displayName, isActive: persons.isActive });
  if (!row) throw new Error('insertPerson: insert returned no row');
  return row;
}

export interface PersonWithAccessRow extends PersonRow {
  /** ⚠️ `null` is a REAL state, not missing data: this person holds no active role, and
   *  `authorize()` denies them everything (`authorize.ts`: *"an unconfigured person is
   *  authorized for NOTHING, not 'staff by default'"*). Nothing in the hire flow assigns a
   *  role, so every newly hired person reads `null` here until someone uses `/admin/users`. */
  role: 'super_admin' | 'admin' | 'manager' | 'staff' | null;
  /** When the active role was granted; `null` whenever `role` is. */
  grantedAt: Date | null;
  storeScopeCount: number;
  activeGrantCount: number;
}

/**
 * T-219 — everyone in the org with their access at a glance, for `/admin/users`.
 *
 * One statement, not a person-by-person fan-out: the two totals are scalar subqueries rather
 * than joins, because joining three one-to-many tables and grouping would multiply rows
 * before it counted them (the classic double-count: two scope rows and two grants produce
 * four of each). A LEFT JOIN onto the active role is safe on its own — the partial unique
 * index behind `activeRoleForPerson` guarantees at most one per (person, org), which the
 * "a second revoked role does not duplicate them" test pins.
 *
 * Org-scoped in the query as well as by RLS — the same belt-and-braces every other repo read
 * here applies.
 */
export async function listWithAccessForOrg(tx: Tx, orgId: string): Promise<PersonWithAccessRow[]> {
  const rows = await tx
    .select({
      id: persons.id,
      orgId: persons.orgId,
      displayName: persons.displayName,
      isActive: persons.isActive,
      role: personRoles.role,
      grantedAt: personRoles.grantedAt,
      storeScopeCount: sql<number>`(select count(*)::int from ${personStoreScope} where ${personStoreScope.personId} = ${persons.id})`,
      activeGrantCount: sql<number>`(select count(*)::int from ${personGrants} where ${personGrants.personId} = ${persons.id} and ${personGrants.revokedAt} is null)`,
    })
    .from(persons)
    .leftJoin(
      personRoles,
      and(eq(personRoles.personId, persons.id), eq(personRoles.orgId, orgId), isNull(personRoles.revokedAt)),
    )
    .where(eq(persons.orgId, orgId))
    .orderBy(asc(persons.displayName));
  return rows as PersonWithAccessRow[];
}

export async function getPersonById(tx: Tx, orgId: string, id: string): Promise<PersonRow | undefined> {
  const [row] = await tx
    .select({ id: persons.id, orgId: persons.orgId, displayName: persons.displayName, isActive: persons.isActive })
    .from(persons)
    .where(and(eq(persons.id, id), eq(persons.orgId, orgId)))
    .limit(1);
  return row;
}

/**
 * `ilike displayName` (`%query%`), org-scoped, ordered by name, default limit 20. Exists so the
 * hire flow can find "the same Maria who already works Lipa" rather than minting a duplicate
 * person — T-154 invariant 8 (one person, two stores, two employments) only works if the UI ever
 * offers the existing person back.
 */
export async function searchPersons(
  tx: Tx,
  input: { orgId: string; query: string; limit?: number },
): Promise<PersonRow[]> {
  const limit = input.limit ?? 20;
  const rows = await tx
    .select({ id: persons.id, orgId: persons.orgId, displayName: persons.displayName, isActive: persons.isActive })
    .from(persons)
    .where(and(eq(persons.orgId, input.orgId), ilike(persons.displayName, `%${input.query}%`)))
    .orderBy(asc(persons.displayName))
    .limit(limit);
  return rows;
}

/**
 * The only place SQL is written for `persons`. T-202 / DEF-131.
 *
 * ⭐ Until this file existed, the only writer of a `persons` row anywhere in the codebase was raw
 * SQL in `scripts/dev-seed.ts:102` — `createEmployment` (T-154) requires an existing `personId`,
 * so a real onboarding screen could not work without this closing first (docs/tasks/202-*.md).
 */
import { and, asc, eq, ilike } from 'drizzle-orm';
import type { Tx } from '../client';
import { persons } from '../../schema/persons';

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

/**
 * The only place SQL is written for `persons`. T-202 / DEF-131.
 *
 * ⭐ Until this file existed, the only writer of a `persons` row anywhere in the codebase was raw
 * SQL in `scripts/dev-seed.ts:102` — `createEmployment` (T-154) requires an existing `personId`,
 * so a real onboarding screen could not work without this closing first (docs/tasks/202-*.md).
 */
import { and, asc, eq, ilike, isNull, or, sql } from 'drizzle-orm';
import type { Tx } from '../client';
import { persons } from '../../schema/persons';
import { personGrants, personRoles, personStoreScope } from '../../schema/access';

export interface PersonRow {
  id: string;
  orgId: string;
  displayName: string;
  isActive: boolean;
  /** ⭐ T-304 — explicit, read wherever a caller must not treat a terminal as a person (a role
   *  grant, a staff listing, a headcount). Never inferred from a proxy column. */
  kind: 'person' | 'terminal';
}

export async function insertPerson(
  tx: Tx,
  /** ⭐ T-304 — `kind` defaults to `'person'`; every existing caller is unaffected. Only
   *  `scripts/provision-terminal.ts` ever passes `'terminal'`. */
  input: { orgId: string; displayName: string; kind?: 'person' | 'terminal' },
): Promise<PersonRow> {
  const [row] = await tx
    .insert(persons)
    .values({ orgId: input.orgId, displayName: input.displayName, kind: input.kind ?? 'person' })
    .returning({
      id: persons.id,
      orgId: persons.orgId,
      displayName: persons.displayName,
      isActive: persons.isActive,
      kind: persons.kind,
    });
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
      kind: persons.kind,
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
    // ⛔ T-304 — a terminal (option (a)'s shared-credential person) is not staff and must never
    // appear on the "everyone in the org with their access" screen. Read directly rather than
    // via `employments` (unlike `v_active_employments`, this listing has no employment join to
    // lean on), so this filter is load-bearing on its own, not a belt-and-braces.
    .where(and(eq(persons.orgId, orgId), eq(persons.kind, 'person')))
    .orderBy(asc(persons.displayName));
  return rows as PersonWithAccessRow[];
}

export async function getPersonById(tx: Tx, orgId: string, id: string): Promise<PersonRow | undefined> {
  const [row] = await tx
    .select({
      id: persons.id,
      orgId: persons.orgId,
      displayName: persons.displayName,
      isActive: persons.isActive,
      kind: persons.kind,
    })
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
  input: {
    orgId: string;
    query: string;
    limit?: number;
  },
): Promise<PersonRow[]> {
  const limit = input.limit ?? 20;
  const rows = await tx
    .select({
      id: persons.id,
      orgId: persons.orgId,
      displayName: persons.displayName,
      isActive: persons.isActive,
      kind: persons.kind,
    })
    .from(persons)
    // ⛔ T-304 — a terminal is not a candidate for "the same Maria who already works Lipa".
    .where(
      and(
        eq(persons.orgId, input.orgId),
        eq(persons.kind, 'person'),
        ilike(persons.displayName, `%${input.query}%`),
      ),
    )
    .orderBy(asc(persons.displayName))
    .limit(limit);
  return rows;
}

/**
 * T-435: every employment (any status) of these persons, with its store's name. The hire search uses it to tell a hit at the
 * searcher's own stores from one who works only elsewhere (shown as name + branch only).
 */
export async function employmentStoresFor(
  tx: Tx,
  personIds: readonly string[],
): Promise<{ personId: string; storeId: string; storeName: string }[]> {
  if (personIds.length === 0) return [];
  const rows = (await tx.execute(sql`
    select e.person_id, e.store_id, s.name as store_name
    from employments e join stores s on s.id = e.store_id
    where e.person_id in (${sql.join(personIds.map((i) => sql`${i}`), sql`, `)})
    order by s.name`)) as unknown as Record<string, string>[];
  return rows.map((r) => ({ personId: String(r.person_id), storeId: String(r.store_id), storeName: String(r.store_name) }));
}

/**
 * T-434: the person's CURRENT signature file id (null = none). ⛔ The ONLY reader of `persons.signature_file_id`; no list,
 * roster or search select may add the column. Callers are the signature rule and the staff detail loader in
 * `@shareat/domain`, never a screen.
 */
export async function getSignatureFileId(tx: Tx, orgId: string, personId: string): Promise<string | null> {
  const [row] = await tx
    .select({ signatureFileId: persons.signatureFileId })
    .from(persons)
    .where(and(eq(persons.id, personId), eq(persons.orgId, orgId)))
    .limit(1);
  return row?.signatureFileId ?? null;
}

/** T-434: point the person at a new current signature (or null to remove). The old stored_files row is kept. */
export async function setSignatureFileId(tx: Tx, orgId: string, personId: string, fileId: string | null): Promise<void> {
  await tx
    .update(persons)
    .set({ signatureFileId: fileId, updatedAt: sql`now()` })
    .where(and(eq(persons.id, personId), eq(persons.orgId, orgId)));
}

import type postgres from 'postgres';

/**
 * T-635: a slice record has to name a person who holds the canonical Slicer position at the store on the day it was produced
 * (`postProduction` refuses otherwise). Fixtures that post a slice record name one made here.
 *
 * `seedSlicerPerson` makes a person with an open employment at the store and that position (their only one, so primary).
 * `grantSlicerPosition` adds the position to an employment that already exists (as a second, non-primary position).
 */
async function slicerPositionId(sql: postgres.Sql<{}>, orgId: string): Promise<string> {
  const [existing] = await sql<{ id: string }[]>`select id from positions where org_id = ${orgId} and store_id is null and name = 'Slicer'`;
  if (existing) return existing.id;
  const [row] = await sql<{ id: string }[]>`
    insert into positions (org_id, store_id, name, is_canonical, is_active) values (${orgId}, null, 'Slicer', true, true) returning id`;
  return row!.id;
}

export async function grantSlicerPosition(sql: postgres.Sql<{}>, args: { orgId: string; employmentId: string; primary?: boolean }): Promise<void> {
  const positionId = await slicerPositionId(sql, args.orgId);
  await sql`
    insert into employment_positions (employment_id, position_id, is_primary)
    values (${args.employmentId}, ${positionId}, ${args.primary ?? false}) on conflict do nothing`;
}

/** Returns the new person's id. `code` must be unique per store (`SE-901`...). */
export async function seedSlicerPerson(
  sql: postgres.Sql<{}>,
  args: { orgId: string; storeId: string; name?: string; code?: string; startedOn?: string; endedOn?: string | null },
): Promise<{ personId: string; employmentId: string }> {
  const [p] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${args.orgId}, ${args.name ?? 'Sam Slicer'}) returning id`;
  const ended = args.endedOn ?? null;
  const [e] = await sql<{ id: string }[]>`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on, ended_on)
    values (${args.orgId}, ${args.storeId}, ${p!.id}, ${args.code ?? 'SE-901'}, ${ended ? 'resigned' : 'regular'}, ${args.startedOn ?? '2025-01-01'}, ${ended})
    returning id`;
  await grantSlicerPosition(sql, { orgId: args.orgId, employmentId: e!.id, primary: true });
  return { personId: p!.id, employmentId: e!.id };
}

/** The one slicer a fixture needs: made on first call, found on later ones (same org and store). Returns the person's id. */
export async function ensureSlicerPerson(sql: postgres.Sql<{}>, args: { orgId: string; storeId: string }): Promise<string> {
  const [found] = await sql<{ id: string }[]>`
    select p.id from persons p join employments e on e.person_id = p.id
    where p.org_id = ${args.orgId} and e.store_id = ${args.storeId} and p.display_name = 'Sam Slicer' limit 1`;
  if (found) return found.id;
  const code = 'SE-990';
  return (await seedSlicerPerson(sql, { ...args, code })).personId;
}

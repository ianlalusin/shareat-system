/**
 * DEF-803 (a) - `commissaryCatalogueRepo.commissaryUsage`: the one cheap read behind the nav filter. Real Postgres.
 * A franchisee's org (one single-room store, no links) uses no commissary screen; Ian's org with a commissary (a multi-room store, or a link row) does.
 * The composed nav result (usage -> commissaryNavAllowed) is asserted per org, including an Ian-org admin's nav staying unchanged.
 *
 * MUTANTS: reads another org's links (tenant leak); counts only ACTIVE links (a retired link would hide the screens that manage it); ignores a multi-room
 * commissary store with no link yet (the chicken-and-egg: the catalogue is where the first link is made); a single-room store counts as a commissary.
 */
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import { closeDb, commissaryCatalogueRepo, systemTransaction, withOrgPrincipal } from '@shareat/db';
import { createFirstAdmin, createOrganization } from '../../packages/domain/src/organizations';
import { COMMISSARY_NAV_HREFS, commissaryNavAllowed } from '../../apps/erp/src/lib/route-capability';

const sql = postgres(process.env.TEST_DATABASE_URL!, { max: 4 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

let seq = 0;
const tag = () => `${Date.now().toString(36)}${++seq}`.toUpperCase();

async function org() {
  const t = tag();
  const o = await systemTransaction(async (tx) => {
    const created = await createOrganization(tx, { code: `D803${t}`, name: `DEF803 Co ${t}` });
    const admin = await createFirstAdmin(tx, { orgId: created.orgId, displayName: `Admin ${t}` });
    return { orgId: created.orgId, adminId: admin.personId };
  });
  const store = async (code: string, model: 'single_room' | 'multi_room') =>
    (await sql<{ id: string }[]>`insert into stores (org_id, code, name, stock_model) values (${o.orgId}, ${`${code}${t}`}, ${`${code} ${t}`}, ${model}) returning id`)[0]!.id;
  return { ...o, store };
}
const usage = (orgId: string) => withOrgPrincipal(orgId, (tx) => commissaryCatalogueRepo.commissaryUsage(tx, orgId));
const shown = (u: { hasCommissary: boolean; hasBranchLink: boolean }) => COMMISSARY_NAV_HREFS.filter((h) => commissaryNavAllowed(h, u)).sort();

describe('commissaryUsage', () => {
  it('franchisee-shaped org (one single-room store, no links): no commissary, no branch link, all three hidden - Mutant: a single-room store counts as a commissary', async () => {
    const pg = await org();
    await pg.store('PG', 'single_room');
    const u = await usage(pg.orgId);
    expect(u).toEqual({ hasCommissary: false, hasBranchLink: false });
    expect(shown(u)).toEqual([]);
  });

  it('Ian-shaped org with a multi-room commissary store and no link yet: all three shown - Mutant: ignores a commissary with no link (first link impossible)', async () => {
    const ian = await org();
    await ian.store('CM', 'multi_room');
    const u = await usage(ian.orgId);
    expect(u.hasCommissary).toBe(true);
    expect(shown(u)).toEqual([...COMMISSARY_NAV_HREFS].sort());
  });

  it('Ian-shaped org with an INACTIVE link only: still all three shown - Mutant: counts only active links', async () => {
    const ian = await org();
    const cm = await ian.store('CM', 'single_room');
    const br = await ian.store('BR', 'single_room');
    await sql`insert into commissary_links (org_id, commissary_store_id, branch_store_id, status, created_by) values (${ian.orgId}, ${cm}, ${br}, 'inactive', ${ian.adminId})`;
    const u = await usage(ian.orgId);
    expect(u).toEqual({ hasCommissary: true, hasBranchLink: true });
    expect(shown(u)).toEqual([...COMMISSARY_NAV_HREFS].sort());
  });

  it('does not read another org links - Mutant: tenant leak', async () => {
    const ian = await org();
    const cm = await ian.store('CM', 'single_room');
    const br = await ian.store('BR', 'single_room');
    await sql`insert into commissary_links (org_id, commissary_store_id, branch_store_id, status, created_by) values (${ian.orgId}, ${cm}, ${br}, 'active', ${ian.adminId})`;
    const pg = await org();
    await pg.store('PG', 'single_room');
    expect(await usage(pg.orgId)).toEqual({ hasCommissary: false, hasBranchLink: false });
  });
});

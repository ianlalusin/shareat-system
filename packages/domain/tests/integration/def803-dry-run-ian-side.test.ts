/**
 * DEF-803 (b) - `scripts/onboard-franchise.ts` dry run printed only steps 1-7 of the plan. It must also list the Ian-side steps 8-10: the franchise customer,
 * the price list with its item count and the total it would write (S7-REFRESH C5), the PG commissary supplier and the number of items mirrored to PG.
 * Real Postgres. The plan comes from `onboardFranchiseOrganization(..., { dryRun: true })`, which is what the CLI prints line by line.
 *
 * MUTANTS: steps 8-10 lines missing; the count includes an inactive offering or an unpriced item; the total sums wrong (counts items, or uses the live
 * price of an unpriced item); the mirrored count is hard-coded / read from the wrong list; the dry run writes (customer, price list or supplier appears).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import { closeDb, systemTransaction } from '@shareat/db';
import { createFirstAdmin, createOrganization, onboardFranchiseOrganization } from '../../src/organizations';
import { parseOnboardingFile } from '../../src/organizations/onboarding-file';

const sql = postgres(process.env.TEST_DATABASE_URL!, { max: 4 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..');
const MOCK = JSON.parse(readFileSync(join(repoRoot, 'scripts', 'fixtures', 'onboarding', 'MOCK-padre-garcia.onboarding.json'), 'utf8'));
let seq = 0;
const tag = () => `${Date.now().toString(36)}${++seq}`.toUpperCase();
const itemCode = () => `${Math.random().toString(36).slice(2, 6).toUpperCase().padEnd(4, 'A')}-${String(1 + Math.floor(Math.random() * 998)).padStart(3, '0')}`;

async function world() {
  const t = tag();
  const code = `D803F${t}`;
  const base = await systemTransaction(async (tx) => {
    const org = await createOrganization(tx, { code, name: `Mock Franchisor Co ${t}` });
    const admin = await createFirstAdmin(tx, { orgId: org.orgId, displayName: `Mock Ian ${t}` });
    return { orgId: org.orgId, adminId: admin.personId };
  });
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${base.orgId}, ${`CM${t}`}, ${`Mock Commissary ${t}`}) returning id`;
  const item = async (name: string, price: string | null, status: 'active' | 'inactive') => {
    const [i] = await sql<{ id: string }[]>`insert into items (org_id, code, name, kind, base_unit, created_by) values (${base.orgId}, ${itemCode()}, ${name}, 'raw_material', 'kg', ${base.adminId}) returning id`;
    if (price) await sql`insert into item_pricing (org_id, item_id, pricing_mode, fixed_amount, set_by) values (${base.orgId}, ${i!.id}, 'fixed', ${price}, ${base.adminId})`;
    await sql`insert into commissary_item_offerings (org_id, commissary_store_id, item_id, status, created_by) values (${base.orgId}, ${store!.id}, ${i!.id}, ${status}, ${base.adminId})`;
  };
  await item(`Mock A ${t}`, '120.50', 'active');
  await item(`Mock B ${t}`, '45.00', 'active');
  await item(`Mock Retired ${t}`, '10.00', 'inactive');
  await item(`Mock Unpriced ${t}`, null, 'active');
  const file = parseOnboardingFile({
    ...MOCK,
    franchisorOrgCode: code,
    org: { code: `MOCKPG${t}`, name: `Mock Padre Garcia Foods ${t}` },
    store: { ...MOCK.store, code: `MPG${t}`, name: `Mock SharEat Padre Garcia ${t}`, posStoreId: `MOCK-POS-${t}` },
    franchisorPerson: { ...MOCK.franchisorPerson, email: `f.${t.toLowerCase()}@example.test` },
    owner: { ...MOCK.owner, email: `o.${t.toLowerCase()}@example.test` },
    commissary: { ...MOCK.commissary, customerName: `Mock PG Customer ${t}`, supplierName: `Mock PG Supplier ${t}`, priceListName: `Mock PG prices ${t}` },
  });
  return { ...base, file };
}

describe('DEF-803 (b) dry run lists the Ian-side steps', () => {
  it('lists the customer, the price list with item count and total, the supplier and the mirrored item count - Mutant: steps 8-10 missing / count includes inactive or unpriced / total wrong / mirrored count wrong', async () => {
    const w = await world();
    const r = await onboardFranchiseOrganization({ file: w.file, byPersonId: w.adminId }, { dryRun: true });
    expect(r.status).toBe('dry-run');
    const text = r.plan.join('\n');
    expect(text).toContain(`customer: ${w.file.commissary.customerName}`);
    expect(text).toContain(`price list: ${w.file.commissary.priceListName}`);
    expect(text).toMatch(/price list: .*: 2 items, total 165\.50/);
    expect(text).toContain(`supplier: ${w.file.commissary.supplierName}`);
    expect(text).toMatch(/items mirrored to the new company: 2\b/);
  });

  it('a dry run writes nothing on either side - Mutant: the plan is built by doing it', async () => {
    const w = await world();
    await onboardFranchiseOrganization({ file: w.file, byPersonId: w.adminId }, { dryRun: true });
    const [n] = await sql<{ c: number; p: number }[]>`select (select count(*) from customers where org_id = ${w.orgId})::int c, (select count(*) from price_lists where org_id = ${w.orgId})::int p`;
    expect(n).toEqual({ c: 0, p: 0 });
    expect((await sql`select 1 from organizations where code = ${w.file.org.code}`).length).toBe(0);
  });
});

/**
 * DEF-804 - a dry run against a company that ALREADY exists with its agreement used to run steps 8-10 for real. It must write nothing on either side,
 * say "already-onboarded" when a real re-run would add nothing, and otherwise print what a re-run would add.
 * MUTANTS: the dry run commits steps 8-10 for an existing company; a dry run on a complete company reports dry-run instead of already-onboarded;
 * a dry run on a company missing a line hides it (status already-onboarded).
 */
describe('DEF-804 dry run on an already-onboarded company writes nothing', () => {
  const counts = async (orgIds: string[]) =>
    (
      await sql<{ c: number; pl: number; pli: number; s: number; i: number; si: number; a: number }[]>`
        select (select count(*) from customers where org_id = any(${orgIds}::uuid[]))::int c,
               (select count(*) from price_lists where org_id = any(${orgIds}::uuid[]))::int pl,
               (select count(*) from price_list_items where org_id = any(${orgIds}::uuid[]))::int pli,
               (select count(*) from suppliers where org_id = any(${orgIds}::uuid[]))::int s,
               (select count(*) from items where org_id = any(${orgIds}::uuid[]))::int i,
               (select count(*) from supplier_items where org_id = any(${orgIds}::uuid[]))::int si,
               (select count(*) from audit_log where org_id = any(${orgIds}::uuid[]) and action like 'onboard%')::int a`
    )[0]!;

  it('complete company: already-onboarded, nothing written - Mutant: dry run commits / reports dry-run', async () => {
    const w = await world();
    await onboardFranchiseOrganization({ file: w.file, byPersonId: w.adminId }, { dryRun: false });
    const [pg] = await sql<{ id: string }[]>`select id from organizations where code = ${w.file.org.code}`;
    const before = await counts([w.orgId, pg!.id]);
    const r = await onboardFranchiseOrganization({ file: w.file, byPersonId: w.adminId }, { dryRun: true });
    expect(r.status).toBe('already-onboarded');
    expect(await counts([w.orgId, pg!.id])).toEqual(before);
  }, 60_000);

  it('company missing a new offered item: dry-run lists what a re-run adds, writes nothing - Mutant: dry run commits / hides the missing line', async () => {
    const w = await world();
    await onboardFranchiseOrganization({ file: w.file, byPersonId: w.adminId }, { dryRun: false });
    const [pg] = await sql<{ id: string }[]>`select id from organizations where code = ${w.file.org.code}`;
    const [cm] = await sql<{ id: string }[]>`select id from stores where org_id = ${w.orgId} limit 1`;
    const [it] = await sql<{ id: string }[]>`insert into items (org_id, code, name, kind, base_unit, created_by) values (${w.orgId}, ${itemCode()}, ${`Late Item ${tag()}`}, 'raw_material', 'kg', ${w.adminId}) returning id`;
    await sql`insert into item_pricing (org_id, item_id, pricing_mode, fixed_amount, set_by) values (${w.orgId}, ${it!.id}, 'fixed', '10.00', ${w.adminId})`;
    await sql`insert into commissary_item_offerings (org_id, commissary_store_id, item_id, status, created_by) values (${w.orgId}, ${cm!.id}, ${it!.id}, 'active', ${w.adminId})`;
    const before = await counts([w.orgId, pg!.id]);
    const r = await onboardFranchiseOrganization({ file: w.file, byPersonId: w.adminId }, { dryRun: true });
    expect(r.status).toBe('dry-run');
    expect(r.plan.join('\n')).toMatch(/items mirrored to the new company: 3\b/);
    expect(await counts([w.orgId, pg!.id])).toEqual(before);
  }, 60_000);
});

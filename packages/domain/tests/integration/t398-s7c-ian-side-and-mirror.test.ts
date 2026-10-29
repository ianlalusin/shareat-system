/**
 * T-398 S7c (TESTER) - onboarding steps 8-10: Ian's side (customer + franchise price list), PG's side (commissary supplier + PG item mirror),
 * and the audit row. O1 (rest), O8, O11, O17. docs/tasks/398-s7/S7-REFRESH.md s5 steps 8-10, s11, s15 (Q-S7-4 = a).
 * Real Postgres via TEST_DATABASE_URL; `onboardFranchiseOrganization` opens its own systemTransactions; state is read back AS OWNER.
 *
 * RED TODAY for one reason: the Ian-side / PG-side half of `onboardFranchiseOrganization` is not built (or the function itself is missing),
 * so no customer, price list, supplier, PG item or audit row exists after a call. O8's planner legs call code that EXISTS (planParties) on rows the
 * onboarding is meant to have created, so they are red only through the missing rows; the `--org-code` mismatch leg is GREEN-AS-GUARD (assertRunTarget).
 *
 * ASSUMED NAMES / RULES (the refresh pins the steps, not these details):
 *   onboardFranchiseOrganization({ file, byPersonId }, { dryRun }) -> { status }       (same as the S7b file)
 *   "commissary-offered item" = an item of the franchisor org with an ACTIVE `commissary_item_offerings` row (any commissary store) AND a pricing rule
 *       `branchPriceFor` can answer; an inactive offering, or an offered item with no price rule, gets no line and no PG item.
 *   price list line rate = branchPriceFor(...).price at onboarding, 2 decimals (the `price_list_items.rate` column).
 *   PG item: same name, same base_unit, same kind, status 'active', no `item_pricing` row (no price) and no stock layer (no cost).
 *   audit action `onboard.franchise` in the FRANCHISOR org's audit_log, actor = byPersonId (Ian's side), at least one row per completed onboarding,
 *   none added by an "already-onboarded" run.
 *
 * MUTANTS: step 8/9/10 skipped; customer linked by store not org; price list reading the live branch price (C5/O11); a line for an inactive offering;
 * PG items created without a supplier_items row (O17); a duplicate PG item when one of that name already exists; supplier without counterparty_org_id;
 * second half sharing the first half's transaction (a late failure would roll PG back); re-run double-creating the customer / supplier / items.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import { closeDb, systemTransaction, withOrgPrincipal } from '@shareat/db';
import { sql as dsql } from 'drizzle-orm';
import { createFirstAdmin, createOrganization } from '../../src/organizations';
import { parseOnboardingFile, type OnboardingFile } from '../../src/organizations/onboarding-file';
import { planParties } from '../../../etl/src/master-data/parties-plan';
import { assertRunTarget, parseStoreMap } from '../../../etl/src/master-data/store-map';

const url = process.env.TEST_DATABASE_URL!;
const sql = postgres(url, { max: 6 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..');
const MOCK = JSON.parse(readFileSync(join(repoRoot, 'scripts', 'fixtures', 'onboarding', 'MOCK-padre-garcia.onboarding.json'), 'utf8'));
let seq = 0;
const tag = () => `${Date.now().toString(36)}${++seq}`.toUpperCase();
const itemCode = () => `${Math.random().toString(36).slice(2, 6).toUpperCase().padEnd(4, 'A')}-${String(1 + Math.floor(Math.random() * 998)).padStart(3, '0')}`;

interface World {
  t: string;
  orgId: string;
  adminId: string;
  code: string;
  commissaryStoreId: string;
  // item ids by role
  a: string;
  b: string;
  inactive: string;
  noRule: string;
  unoffered: string;
  names: { a: string; b: string };
}

/** Ian's company with a commissary store, three offered items (two active + priced, one inactive offering), one offered with no price rule, one not offered. */
async function franchisor(): Promise<World> {
  const t = tag();
  const code = `S7CL${t}`;
  const base = await systemTransaction(async (tx) => {
    const org = await createOrganization(tx, { code, name: `Mock Franchisor Co ${t}` });
    const admin = await createFirstAdmin(tx, { orgId: org.orgId, displayName: `Mock Ian ${t}` });
    return { orgId: org.orgId, adminId: admin.personId };
  });
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${base.orgId}, ${`CM${t}`}, ${`Mock Commissary ${t}`}) returning id`;
  const item = async (name: string, kind: string, unit: string, price: string | null) => {
    const [i] = await sql<{ id: string }[]>`
      insert into items (org_id, code, name, kind, base_unit, created_by) values (${base.orgId}, ${itemCode()}, ${name}, ${kind}, ${unit}, ${base.adminId}) returning id`;
    if (price) await sql`insert into item_pricing (org_id, item_id, pricing_mode, fixed_amount, set_by) values (${base.orgId}, ${i!.id}, 'fixed', ${price}, ${base.adminId})`;
    return i!.id;
  };
  const names = { a: `Mock Pork Belly ${t}`, b: `Mock Sauce Pack ${t}` };
  const a = await item(names.a, 'raw_material', 'kg', '120.50');
  const b = await item(names.b, 'supply', 'pcs', '45.00');
  const inactive = await item(`Mock Retired Item ${t}`, 'raw_material', 'kg', '10.00');
  const noRule = await item(`Mock Unpriced Item ${t}`, 'raw_material', 'kg', null);
  const unoffered = await item(`Mock Not Offered ${t}`, 'raw_material', 'kg', '99.00');
  for (const [id, status] of [[a, 'active'], [b, 'active'], [inactive, 'inactive'], [noRule, 'active']] as const) {
    await sql`insert into commissary_item_offerings (org_id, commissary_store_id, item_id, status, created_by) values (${base.orgId}, ${store!.id}, ${id}, ${status}, ${base.adminId})`;
  }
  return { t, ...base, code, commissaryStoreId: store!.id, a, b, inactive, noRule, unoffered, names };
}

function fileFor(l: World, over: Partial<OnboardingFile['commissary']> = {}, priceListName?: string): OnboardingFile {
  const t = tag();
  return parseOnboardingFile({
    ...MOCK,
    franchisorOrgCode: l.code,
    org: { code: `MOCKPG${t}`, name: `Mock Padre Garcia Foods ${t}` },
    store: { ...MOCK.store, code: `MPG${t}`, name: `Mock SharEat Padre Garcia ${t}`, posStoreId: `MOCK-POS-${t}` },
    franchisorPerson: { ...MOCK.franchisorPerson, email: `franchisor.${t.toLowerCase()}@example.test` },
    owner: { ...MOCK.owner, email: `owner.${t.toLowerCase()}@example.test` },
    commissary: { ...MOCK.commissary, customerName: `Mock SharEat Padre Garcia ${t}`, supplierName: `Mock SharEat Commissary ${t}`, priceListName: priceListName ?? `Mock PG prices ${t}`, ...over },
  });
}

async function onboard(file: OnboardingFile, byPersonId: string): Promise<{ status: string }> {
  const mod = (await import('../../src/organizations')) as unknown as {
    onboardFranchiseOrganization: (i: { file: OnboardingFile; byPersonId: string }, o: { dryRun: boolean }) => Promise<{ status: string }>;
  };
  return mod.onboardFranchiseOrganization({ file, byPersonId }, { dryRun: false });
}
const orgId = async (code: string) => (await sql<{ id: string }[]>`select id from organizations where code = ${code}`)[0]?.id;

describe('O1 (rest) - Ian\'s side', () => {
  it('customer with counterparty_org_id = PG (inter_entity, no store link) + price list; one line per ACTIVE priced offered item; credit fields unset when null - Mutant: customer linked by store / step 8 skipped / a line for an inactive offering or an unpriced item', async () => {
    const l = await franchisor();
    const file = fileFor(l);
    await onboard(file, l.adminId);
    const pg = (await orgId(file.org.code))!;
    const [c] = await sql<{ id: string; counterparty_org_id: string | null; counterparty_store_id: string | null; price_list_id: string | null; credit_limit: string | null; credit_terms_days: number | null }[]>`
      select id, counterparty_org_id, counterparty_store_id, price_list_id, credit_limit::text, credit_terms_days from customers where org_id = ${l.orgId} and name = ${file.commissary.customerName}`;
    expect(c, 'the Ian-side customer was not created').toBeDefined();
    expect(c).toMatchObject({ counterparty_org_id: pg, counterparty_store_id: null, credit_limit: null, credit_terms_days: null });
    const [pl] = await sql<{ id: string }[]>`select id from price_lists where org_id = ${l.orgId} and name = ${file.commissary.priceListName}`;
    expect(pl!.id).toBe(c!.price_list_id);
    const lines = await sql<{ item_id: string; rate: string }[]>`select item_id, rate::text from price_list_items where price_list_id = ${pl!.id} order by item_id`;
    expect(lines.map((r) => r.item_id).sort()).toEqual([l.a, l.b].sort());
    expect(Object.fromEntries(lines.map((r) => [r.item_id, r.rate]))).toEqual({ [l.a]: '120.50', [l.b]: '45.00' });
  });

  it('credit limit and terms from the file are carried when given - Mutant: credit fields dropped', async () => {
    const l = await franchisor();
    const file = fileFor(l, { creditLimit: '50000.00', creditTermsDays: 30 });
    await onboard(file, l.adminId);
    const [c] = await sql<{ credit_limit: string; credit_terms_days: number }[]>`select credit_limit::text, credit_terms_days from customers where org_id = ${l.orgId} and name = ${file.commissary.customerName}`;
    expect(c).toEqual({ credit_limit: '50000.00', credit_terms_days: 30 });
  });

  it('PG\'s supplier carries counterparty_org_id = Ian\'s org and the file\'s name - Mutant: supplier without the org link (K4)', async () => {
    const l = await franchisor();
    const file = fileFor(l);
    await onboard(file, l.adminId);
    const pg = (await orgId(file.org.code))!;
    const sups = await sql<{ counterparty_org_id: string | null; counterparty_store_id: string | null }[]>`
      select counterparty_org_id, counterparty_store_id from suppliers where org_id = ${pg} and name = ${file.commissary.supplierName}`;
    expect(sups).toEqual([{ counterparty_org_id: l.orgId, counterparty_store_id: null }]);
  });

  it('writes an `onboard.franchise` audit row in the franchisor org by --by; an "already-onboarded" run adds none - Mutant: no audit / audit on every run', async () => {
    const l = await franchisor();
    const file = fileFor(l);
    await onboard(file, l.adminId);
    const rows = await sql<{ actor_person_id: string }[]>`select actor_person_id from audit_log where org_id = ${l.orgId} and action = 'onboard.franchise'`;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const r of rows) expect(r.actor_person_id).toBe(l.adminId);
    const n = rows.length;
    expect((await onboard(file, l.adminId)).status).toBe('already-onboarded');
    expect((await sql`select 1 from audit_log where org_id = ${l.orgId} and action = 'onboard.franchise'`).length).toBe(n);
  });
});

describe('Q-S7-4 (a) / O17 - the PG item mirror', () => {
  it('a PG item (name, base unit, kind copied; active; no price rule) for every price-list line, each declared on PG\'s commissary supplier; none for the inactive / unpriced / unoffered ones - Mutant: items created but no supplier_items row', async () => {
    const l = await franchisor();
    const file = fileFor(l);
    await onboard(file, l.adminId);
    const pg = (await orgId(file.org.code))!;
    const items = await sql<{ id: string; name: string; base_unit: string; kind: string; status: string }[]>`select id, name, base_unit, kind, status from items where org_id = ${pg} order by name`;
    expect(items.map((i) => [i.name, i.base_unit, i.kind, i.status])).toEqual([
      [l.names.b, 'pcs', 'supply', 'active'],
      [l.names.a, 'kg', 'raw_material', 'active'],
    ].sort((x, y) => String(x[0]).localeCompare(String(y[0]))));
    expect(await sql`select 1 from item_pricing where org_id = ${pg}`, 'a mirrored item carries no price').toHaveLength(0);
    const [sup] = await sql<{ id: string }[]>`select id from suppliers where org_id = ${pg} and name = ${file.commissary.supplierName}`;
    const declared = await sql<{ item_id: string }[]>`select item_id from supplier_items where org_id = ${pg} and supplier_id = ${sup!.id}`;
    expect(declared.map((d) => d.item_id).sort()).toEqual(items.map((i) => i.id).sort());
  });

  it('O17 - the receipt form\'s choices: under PG\'s principal the declared items of the commissary supplier are exactly the mirrored names (declaredItemsOf) - Mutant: supplier_items declared for the wrong supplier / org', async () => {
    const l = await franchisor();
    const file = fileFor(l);
    await onboard(file, l.adminId);
    const pg = (await orgId(file.org.code))!;
    const [sup] = await sql<{ id: string }[]>`select id from suppliers where org_id = ${pg} and name = ${file.commissary.supplierName}`;
    const { declaredItemsOf } = await import('../../../db/src/repo/inter-entity');
    const choices = await withOrgPrincipal(pg, (tx) => declaredItemsOf(tx, pg, sup!.id));
    expect(choices.map((c) => c.name).sort()).toEqual([l.names.a, l.names.b].sort());
    // Not part of this slice, said so: the shipment + receive itself (a hand-made item must not be needed) is S5's receive path; here the precondition is proven.
  });
});

describe('O11 - the price list is a snapshot', () => {
  it('after onboarding, changing the branch price does not move the list - Mutant: price list reading the live branch price', async () => {
    const l = await franchisor();
    const file = fileFor(l);
    await onboard(file, l.adminId);
    await sql`update item_pricing set fixed_amount = '999.00' where item_id = ${l.a}`;
    const [row] = await sql<{ rate: string }[]>`
      select pli.rate::text from price_list_items pli join price_lists pl on pl.id = pli.price_list_id
      where pl.org_id = ${l.orgId} and pl.name = ${file.commissary.priceListName} and pli.item_id = ${l.a}`;
    expect(row!.rate).toBe('120.50');
  });
});

describe('re-run completes a half-done onboarding (s5: two transactions)', () => {
  it('a failure in Ian\'s half leaves PG\'s company; the re-run completes it with exactly one customer, one supplier, one agreement, no duplicate items - Mutant: both halves in one transaction / re-run double-creates', async () => {
    const l = await franchisor();
    const fault = `S7C FAULT ${tag()}`;
    const file = fileFor(l, {}, fault);
    const fn = `s7c_fault_${tag().toLowerCase()}`;
    await sql.unsafe(`create function ${fn}() returns trigger language plpgsql as $f$ begin if new.name = '${fault}' then raise exception 's7c injected fault'; end if; return new; end $f$`);
    await sql.unsafe(`create trigger ${fn} before insert on price_lists for each row execute function ${fn}()`);
    try {
      await expect(onboard(file, l.adminId)).rejects.toThrow(/injected fault/);
    } finally {
      await sql.unsafe(`drop trigger if exists ${fn} on price_lists`);
      await sql.unsafe(`drop function if exists ${fn}()`);
    }
    const pg = await orgId(file.org.code);
    expect(pg, 'PG\'s half must survive a failure in Ian\'s half').toBeDefined();
    expect(await sql`select 1 from customers where org_id = ${l.orgId} and name = ${file.commissary.customerName}`, 'Ian\'s half must have rolled back').toHaveLength(0);

    await onboard(file, l.adminId);
    expect(await sql`select 1 from organizations where code = ${file.org.code}`).toHaveLength(1);
    expect(await sql`select 1 from customers where org_id = ${l.orgId} and name = ${file.commissary.customerName}`).toHaveLength(1);
    expect(await sql`select 1 from suppliers where org_id = ${pg!} and name = ${file.commissary.supplierName}`).toHaveLength(1);
    expect(await sql`select 1 from franchise_agreements where org_id = ${pg!}`).toHaveLength(1);
    expect(await sql`select 1 from items where org_id = ${pg!}`).toHaveLength(2);
    const [sup] = await sql<{ id: string }[]>`select id from suppliers where org_id = ${pg!} and name = ${file.commissary.supplierName}`;
    expect(await sql`select 1 from supplier_items where supplier_id = ${sup!.id}`).toHaveLength(2);
  });

  it('an active PG item that already has that name is reused, not duplicated (still declared on the supplier) - Mutant: duplicate item on re-run', async () => {
    const l = await franchisor();
    const file = fileFor(l);
    await onboard(file, l.adminId);
    const pg = (await orgId(file.org.code))!;
    // simulate T-391 having loaded v1's PG items: remove the declaration for one mirrored item, then re-run the Ian/PG second half by running again
    const [sup] = await sql<{ id: string }[]>`select id from suppliers where org_id = ${pg} and name = ${file.commissary.supplierName}`;
    await sql`delete from supplier_items where supplier_id = ${sup!.id}`;
    await onboard(file, l.adminId);
    expect(await sql`select 1 from items where org_id = ${pg} and name = ${l.names.a}`).toHaveLength(1);
    expect(await sql`select 1 from supplier_items where supplier_id = ${sup!.id}`, 'the declarations are restored by the re-run').toHaveLength(2);
  });
});

describe('O8 - T-391 meets the onboarded names', () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const MAP = (pgOrg: string) =>
    parseStoreMap(
      [
        'v1_store_id,name,role,org_code,store_code',
        'LLLLLLLLLLLLLLLLLLLL,SharEat Lipa,own,SE,LIPA',
        `y1DMgfisuTHBF57cNL6i,SharEat Padre Garcia,franchise,${pgOrg},PGAR`,
      ].join('\r\n'),
    );
  const snap = (suppliers: any[], arCustomers: any[]): any => ({ version: 1, stores: [], items: [], suppliers, arCustomers, staff: [], staffIdentities: [] });
  const creates = (p: any, entity: string, name: string) => p.writes.filter((w: any) => w.op === 'create' && w.entity === entity && w.name.trim().toLowerCase() === name.trim().toLowerCase());

  it('the PG-side run creates NO second commissary-named supplier: v1\'s mirror supplier links to the onboarded one - Mutant: onboarding names that differ from v1\'s', async () => {
    const l = await franchisor();
    const file = fileFor(l, { supplierName: 'SharEat Commissary' });
    await onboard(file, l.adminId);
    const pg = (await orgId(file.org.code))!;
    const existingSuppliers = await sql<{ id: string; name: string; status: string }[]>`select id, name, status from suppliers where org_id = ${pg}`;
    expect(existingSuppliers.length).toBeGreaterThan(0);
    const plan = await planParties({
      snapshot: snap([{ id: 's1', store: 'y1DMgfisuTHBF57cNL6i', businessName: 'SharEat Commissary', classification: 'Corporate', isActive: true, updatedAt: '2026-01-01T00:00:00.000Z' }], []),
      map: MAP(file.org.code),
      orgCode: file.org.code,
      existingSuppliers,
      existingCustomers: [],
      links: [],
      answers: {},
    } as any);
    expect(creates(plan, 'supplier', 'SharEat Commissary')).toHaveLength(0);
    expect((plan as any).writes.filter((w: any) => w.op === 'link' && w.entity === 'supplier')).toHaveLength(1);
  });

  it('the Ian-side run creates NO second PG-named customer: v1\'s AR customer links to the onboarded one - Mutant: customer name differs from v1\'s PG AR customer', async () => {
    const l = await franchisor();
    const file = fileFor(l, { customerName: 'SharEat Padre Garcia' });
    await onboard(file, l.adminId);
    const existingCustomers = await sql<{ id: string; name: string; status: string }[]>`select id, name, status from customers where org_id = ${l.orgId}`;
    expect(existingCustomers.map((c) => c.name)).toContain('SharEat Padre Garcia');
    const plan = await planParties({
      snapshot: snap([], [{ id: 'c1', store: 'LLLLLLLLLLLLLLLLLLLL', name: 'SharEat Padre Garcia', classification: 'corporate', status: 'active', updatedAt: '2026-01-01T00:00:00.000Z' }]),
      map: MAP(file.org.code),
      orgCode: 'SE',
      existingSuppliers: [],
      existingCustomers,
      links: [],
      answers: {},
    } as any);
    expect(creates(plan, 'customer', 'SharEat Padre Garcia')).toHaveLength(0);
  });

  it('control (green today): a T-391 run whose --org-code differs from the org row is refused (R6)', () => {
    expect(() => assertRunTarget(MAP('SEPG'), { orgCode: 'SEPG', orgRowCode: 'SOMETHING_ELSE' })).toThrow(/Refused/);
  });
});

void dsql;

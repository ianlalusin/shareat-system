import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-649 - price-list rates that follow the delivery cost (fixed / cost + peso / cost + %), and one default list.
 * docs/tasks/649-price-list-cost-plus.md.
 *
 * MUTANTS (each goes red): the default-list fallback removed from `listIdFor` (customer-without-list tests); `computeBranchPrice` mode swapped (the 128.40 / 170.00 tests);
 * `setDefaultPriceList` not clearing the old default (the "making B default unsets A" test + the unique index); the shape CHECK dropped (the migration cases);
 * the retired-list refusal removed (the retired-list test + the CHECK); `upsertPriceListItem` not replacing `rate` with null when the mode changes (the "re-quote switches mode" test).
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} — the database name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, transaction, APP_ROLE, customersRepo, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { createCustomer, createPriceList, quoteForCustomer, quoteWithReason, setDefaultPriceList, setPrice } from '@shareat/domain';
import { testItemCode } from './_fixtures/item-code';

const sql = postgres(url, { max: 5 });

let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

async function fixture(hint: string) {
  const code = uid(`t649-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const mkPerson = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${store!.id})`;
    return p!.id;
  };
  const adminId = await mkPerson('Admin', 'admin');
  const staffId = await mkPerson('Staff', 'staff');
  return { orgId, storeId: store!.id, adminId, admin: actor(orgId, adminId), staff: actor(orgId, staffId) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function wholesaleItem(f: Fixture, name: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into items (org_id, code, name, kind, base_unit, created_by, sellable_wholesale)
    values (${f.orgId}, ${testItemCode()}, ${`${name} ${uid('n')}`}, 'raw_material', 'kg', ${f.adminId}, true) returning id`;
  return row!.id;
}

/** A delivery cost: one supplier bill for the item at `price` a kg (no fees), which is what `costBasisFor` reads. */
async function landCost(f: Fixture, itemId: string, price: string, on = '2026-01-20'): Promise<void> {
  const [sup] = await sql<{ id: string }[]>`insert into suppliers (org_id, name, created_by) values (${f.orgId}, ${uid('sup')}, ${f.adminId}) returning id`;
  const [inv] = await sql<{ id: string }[]>`
    insert into supplier_invoices (org_id, store_id, supplier_id, invoice_date, total_amount, created_by)
    values (${f.orgId}, ${f.storeId}, ${sup!.id}, ${on}, ${price}, ${f.adminId}) returning id`;
  await sql`
    insert into supplier_invoice_lines (supplier_invoice_id, line_no, item_id, quantity, purchase_unit, conversion_factor, unit_price, line_total)
    values (${inv!.id}, 1, ${itemId}, '1', 'kg', '1', ${price}, ${price})`;
}

const newList = (f: Fixture, name = 'List') => asOrg(f.orgId, (tx) => createPriceList(tx, f.admin, { name: uid(name) }));
const newCustomer = (f: Fixture, priceListId: string | null = null) =>
  asOrg(f.orgId, (tx) => createCustomer(tx, f.admin, { name: uid('Buyer'), priceListId }));
const quote = (f: Fixture, customerId: string, itemId: string) => asOrg(f.orgId, (tx) => quoteForCustomer(tx, f.orgId, customerId, itemId));
const why = (f: Fixture, customerId: string, itemId: string) => asOrg(f.orgId, (tx) => quoteWithReason(tx, f.orgId, customerId, itemId));

/** The sentence a person is shown: `userMessage` when the refusal carries one, else the plain message. */
async function sentence(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as { userMessage?: string }).userMessage ?? (e as Error).message;
  }
  return '(did not refuse)';
}

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('0289 the database shape', () => {
  async function raw(f: Fixture, listId: string, itemId: string, cols: string) {
    // The admin connection, so the CHECK is what answers, not a policy.
    return sql.unsafe(`insert into price_list_items (org_id, price_list_id, item_id, ${cols.split('=')[0]}) values ('${f.orgId}', '${listId}', '${itemId}', ${cols.split('=')[1]})`);
  }

  it('refuses a fixed row with a markup, a percent row with a rate, a markup row without its figure, a negative markup', async () => {
    const f = await fixture('shape');
    const list = await newList(f);
    const bad: [string, string][] = [
      ["pricing_mode, rate, markup_amount", "'fixed', '10.00', '5.00'"],
      ["pricing_mode, rate, markup_percent", "'fixed', '10.00', '5'"],
      ["pricing_mode", "'fixed'"], // fixed with no rate
      ["pricing_mode, rate, markup_percent", "'percent_markup', '10.00', '5'"],
      ["pricing_mode", "'percent_markup'"], // no percent
      ["pricing_mode, markup_amount, markup_percent", "'percent_markup', '1.00', '5'"],
      ["pricing_mode, rate, markup_amount", "'fixed_markup', '10.00', '5.00'"],
      ["pricing_mode", "'fixed_markup'"], // no amount
      ["pricing_mode, markup_amount", "'fixed_markup', '-1.00'"],
      ["pricing_mode, markup_percent", "'percent_markup', '-1'"],
      ["pricing_mode, rate", "'nonsense', '1.00'"],
    ];
    for (const [cols, vals] of bad) {
      const itemId = await wholesaleItem(f, 'Shape');
      await expect(raw(f, list.id, itemId, `${cols}=${vals}`), `${cols} = ${vals}`).rejects.toThrow(/price_list_items_(mode_shape|pricing_mode)_check/);
    }
  });

  it('accepts exactly one well-formed row per mode, and a legacy rate-only row is a fixed row', async () => {
    const f = await fixture('shapeok');
    const list = await newList(f);
    const [a, b, c, d] = [await wholesaleItem(f, 'A'), await wholesaleItem(f, 'B'), await wholesaleItem(f, 'C'), await wholesaleItem(f, 'D')];
    await raw(f, list.id, a, "pricing_mode, rate='fixed', '100.00'");
    await raw(f, list.id, b, "pricing_mode, markup_percent='percent_markup', '7'");
    await raw(f, list.id, c, "pricing_mode, markup_amount='fixed_markup', '50.00'");
    await raw(f, list.id, d, "rate='12.50'"); // what every row looked like before 0289: no mode named
    const [legacy] = await sql<{ pricing_mode: string; markup_amount: string | null; markup_percent: string | null }[]>`
      select pricing_mode, markup_amount, markup_percent from price_list_items where item_id = ${d}`;
    expect(legacy).toEqual({ pricing_mode: 'fixed', markup_amount: null, markup_percent: null });
  });

  it('one default per organisation: a second default is refused, another org may have its own, a retired list cannot be the default', async () => {
    const f = await fixture('onedefault');
    const g = await fixture('otherorg');
    const a = await newList(f);
    const b = await newList(f);
    const other = await newList(g);
    await sql`update price_lists set is_default = true where id = ${a.id}`;
    await expect(sql`update price_lists set is_default = true where id = ${b.id}`).rejects.toThrow(/price_lists_one_default_per_org_key/);
    await sql`update price_lists set is_default = true where id = ${other.id}`; // another organisation: fine
    await expect(sql`update price_lists set retired_at = now() where id = ${a.id}`).rejects.toThrow(/price_lists_default_not_retired_check/);
    await expect(sql`update price_lists set is_default = true, retired_at = now() where id = ${b.id}`).rejects.toThrow(/price_lists_default_not_retired_check/);
  });
});

describe('the one resolver: which list, which rule, which number', () => {
  /** Ian's example: wholesale = a fixed 100, b cost + 7%, c cost + P50, d cost + 10%; retail prices the same items differently. */
  async function world() {
    const f = await fixture('resolver');
    const [a, b, c, d] = [await wholesaleItem(f, 'A'), await wholesaleItem(f, 'B'), await wholesaleItem(f, 'C'), await wholesaleItem(f, 'D')];
    for (const i of [b, c, d]) await landCost(f, i, '120.00');
    const wholesale = await newList(f, 'Wholesale');
    const retail = await newList(f, 'Retail');
    const set = (listId: string, itemId: string, input: Record<string, string>) => asOrg(f.orgId, (tx) => setPrice(tx, f.admin, { priceListId: listId, itemId, ...input }));
    await set(wholesale.id, a, { mode: 'fixed', rate: '100' });
    await set(wholesale.id, b, { mode: 'percent_markup', markupPercent: '7' });
    await set(wholesale.id, c, { mode: 'fixed_markup', markupAmount: '50' });
    await set(wholesale.id, d, { mode: 'percent_markup', markupPercent: '10' });
    await set(retail.id, a, { mode: 'fixed', rate: '150' });
    await set(retail.id, b, { mode: 'percent_markup', markupPercent: '30' });
    return { f, a, b, c, d, wholesale, retail, set };
  }

  it('a customer on a list gets that list rule for each item, to the centavo', async () => {
    const { f, a, b, c, d, wholesale, retail } = await world();
    const onWholesale = await newCustomer(f, wholesale.id);
    const onRetail = await newCustomer(f, retail.id);
    expect(await quote(f, onWholesale.id, a)).toMatchObject({ rate: '100.00', basis: 'fixed', listId: wholesale.id });
    expect(await quote(f, onWholesale.id, b)).toMatchObject({ rate: '128.40', basis: 'cost_plus' }); // 120 x 1.07, exact
    expect(await quote(f, onWholesale.id, c)).toMatchObject({ rate: '170.00', basis: 'cost_plus' });
    expect(await quote(f, onWholesale.id, d)).toMatchObject({ rate: '132.00', basis: 'cost_plus' });
    // the same items, a different list, a different number
    expect(await quote(f, onRetail.id, a)).toMatchObject({ rate: '150.00', listId: retail.id });
    expect(await quote(f, onRetail.id, b)).toMatchObject({ rate: '156.00' }); // 120 x 1.30
  });

  it('⭐ a customer with NO list is priced from the default list (mutant: the fallback removed -> null)', async () => {
    const { f, a, b, wholesale } = await world();
    const none = await newCustomer(f);
    expect(await quote(f, none.id, a)).toBeNull(); // no default yet: nobody quotes it
    expect((await why(f, none.id, a)).reason).toBe('no_list');
    await asOrg(f.orgId, (tx) => setDefaultPriceList(tx, f.admin, { priceListId: wholesale.id }));
    expect(await quote(f, none.id, a)).toMatchObject({ rate: '100.00', listId: wholesale.id });
    expect(await quote(f, none.id, b)).toMatchObject({ rate: '128.40' });
  });

  it("a customer's own list beats the default list", async () => {
    const { f, a, wholesale, retail } = await world();
    await asOrg(f.orgId, (tx) => setDefaultPriceList(tx, f.admin, { priceListId: wholesale.id }));
    const onRetail = await newCustomer(f, retail.id);
    expect(await quote(f, onRetail.id, a)).toMatchObject({ rate: '150.00', listId: retail.id });
  });

  it('an item that is not on the list has no quote, never another list and never zero', async () => {
    const { f, wholesale, retail } = await world();
    const stray = await wholesaleItem(f, 'Stray');
    await asOrg(f.orgId, (tx) => setDefaultPriceList(tx, f.admin, { priceListId: retail.id }));
    const onWholesale = await newCustomer(f, wholesale.id);
    expect(await quote(f, onWholesale.id, stray)).toBeNull();
    expect((await why(f, onWholesale.id, stray)).reason).toBe('not_on_list');
  });

  it('a markup on an item with no delivery cost yet has no quote, and says why', async () => {
    const { f, wholesale, set } = await world();
    const fresh = await wholesaleItem(f, 'Fresh');
    await set(wholesale.id, fresh, { mode: 'percent_markup', markupPercent: '7' });
    const c = await newCustomer(f, wholesale.id);
    expect(await quote(f, c.id, fresh)).toBeNull();
    expect((await why(f, c.id, fresh)).reason).toBe('no_delivery_cost');
    await landCost(f, fresh, '200.00'); // the first delivery lands: the price appears with no edit to the list
    expect(await quote(f, c.id, fresh)).toMatchObject({ rate: '214.00' });
  });

  it('the price follows a NEW delivery cost (the list holds a rule, not a number)', async () => {
    const { f, b, wholesale } = await world();
    const c = await newCustomer(f, wholesale.id);
    expect((await quote(f, c.id, b))!.rate).toBe('128.40');
    await landCost(f, b, '200.00', '2026-02-10');
    expect((await quote(f, c.id, b))!.rate).toBe('214.00'); // basis is the dearer of the last two receives: 200 x 1.07
  });
});

describe('setPrice: one price per item, the mode decides which figure is kept', () => {
  it('re-quoting switches the mode and clears the figure the old mode used (mutant: rate kept -> the shape CHECK refuses)', async () => {
    const f = await fixture('requote');
    const list = await newList(f);
    const item = await wholesaleItem(f, 'Beef');
    await asOrg(f.orgId, (tx) => setPrice(tx, f.admin, { priceListId: list.id, itemId: item, rate: '380.00' })); // a pre-T-649 caller: no mode named
    await asOrg(f.orgId, (tx) => setPrice(tx, f.admin, { priceListId: list.id, itemId: item, mode: 'percent_markup', markupPercent: '7.5' }));
    const rows = await asOrg(f.orgId, (tx) => customersRepo.listPriceListItems(tx, f.orgId, list.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ pricingMode: 'percent_markup', rate: null, markupAmount: null });
    expect(Number(rows[0]!.markupPercent)).toBe(7.5);
    await asOrg(f.orgId, (tx) => setPrice(tx, f.admin, { priceListId: list.id, itemId: item, mode: 'fixed', rate: '400' }));
    const [again] = await asOrg(f.orgId, (tx) => customersRepo.listPriceListItems(tx, f.orgId, list.id));
    expect(again).toMatchObject({ pricingMode: 'fixed', rate: '400.00', markupPercent: null, markupAmount: null });
  });

  it('refuses a mode with no figure, a negative markup and an unknown mode, in plain words', async () => {
    const f = await fixture('refuse');
    const list = await newList(f);
    const item = await wholesaleItem(f, 'Pork');
    const attempt = (input: Record<string, string>) => asOrg(f.orgId, (tx) => setPrice(tx, f.admin, { priceListId: list.id, itemId: item, ...input }));
    expect(await sentence(attempt({ mode: 'percent_markup', markupPercent: '' }))).toMatch(/percent over the delivery cost/i);
    expect(await sentence(attempt({ mode: 'fixed_markup', markupAmount: '' }))).toMatch(/amount over the delivery cost/i);
    expect(await sentence(attempt({ mode: 'fixed_markup', markupAmount: '-5' }))).toMatch(/amount over the delivery cost/i);
    expect(await sentence(attempt({ mode: 'percent_markup', markupPercent: '-1' }))).toMatch(/percent over the delivery cost/i);
    expect(await sentence(attempt({ mode: 'bogus' as never, rate: '1' }))).toMatch(/how the price is worked out/i);
    expect(await sentence(attempt({ mode: 'fixed', rate: '' }))).toMatch(/rate/i);
    const [counted] = await sql<{ count: string }[]>`select count(*)::text as count from price_list_items where org_id = ${f.orgId}`;
    expect(counted!.count).toBe('0');
  });

  it('a stray figure from another mode is ignored, not stored', async () => {
    const f = await fixture('stray');
    const list = await newList(f);
    const item = await wholesaleItem(f, 'Stray');
    await asOrg(f.orgId, (tx) => setPrice(tx, f.admin, { priceListId: list.id, itemId: item, mode: 'fixed_markup', markupAmount: '50', rate: '999', markupPercent: '5' }));
    const [row] = await asOrg(f.orgId, (tx) => customersRepo.listPriceListItems(tx, f.orgId, list.id));
    expect(row).toMatchObject({ pricingMode: 'fixed_markup', rate: null, markupAmount: '50.00', markupPercent: null });
  });
});

describe('the default list', () => {
  it('making B the default unsets A, in one step, and writes who did it', async () => {
    const f = await fixture('swap');
    const a = await newList(f, 'A');
    const b = await newList(f, 'B');
    await asOrg(f.orgId, (tx) => setDefaultPriceList(tx, f.admin, { priceListId: a.id }));
    expect((await asOrg(f.orgId, (tx) => customersRepo.getDefaultPriceList(tx, f.orgId)))?.id).toBe(a.id);
    await asOrg(f.orgId, (tx) => setDefaultPriceList(tx, f.admin, { priceListId: b.id }));
    const flags = await sql<{ id: string; is_default: boolean }[]>`select id, is_default from price_lists where org_id = ${f.orgId}`;
    expect(flags.find((r) => r.id === a.id)!.is_default).toBe(false);
    expect(flags.find((r) => r.id === b.id)!.is_default).toBe(true);
    const audits = await sql<{ actor_person_id: string; before: { defaultListId: string | null }; after: { defaultListId: string | null } }[]>`
      select actor_person_id, before, after from audit_log where org_id = ${f.orgId} and action = 'price_list.default_set' order by id`;
    expect(audits).toHaveLength(2);
    expect(audits[1]).toMatchObject({ actor_person_id: f.adminId, before: { defaultListId: a.id }, after: { defaultListId: b.id } });
  });

  it('can be cleared, and setting the current default again writes nothing', async () => {
    const f = await fixture('clear');
    const a = await newList(f);
    await asOrg(f.orgId, (tx) => setDefaultPriceList(tx, f.admin, { priceListId: a.id }));
    await asOrg(f.orgId, (tx) => setDefaultPriceList(tx, f.admin, { priceListId: a.id }));
    await asOrg(f.orgId, (tx) => setDefaultPriceList(tx, f.admin, { priceListId: null }));
    await asOrg(f.orgId, (tx) => setDefaultPriceList(tx, f.admin, { priceListId: null }));
    expect(await asOrg(f.orgId, (tx) => customersRepo.getDefaultPriceList(tx, f.orgId))).toBeUndefined();
    const [counted] = await sql<{ count: string }[]>`select count(*)::text as count from audit_log where org_id = ${f.orgId} and action = 'price_list.default_set'`;
    expect(counted!.count).toBe('2'); // set, then cleared; the two repeats changed nothing
  });

  it('a retired list cannot be made the default (mutant: refusal removed -> the CHECK says it instead)', async () => {
    const f = await fixture('retired');
    const a = await newList(f);
    await sql`update price_lists set retired_at = now() where id = ${a.id}`;
    expect(await sentence(asOrg(f.orgId, (tx) => setDefaultPriceList(tx, f.admin, { priceListId: a.id })))).toMatch(/is retired, so it cannot be the default list/);
    expect(await asOrg(f.orgId, (tx) => customersRepo.getDefaultPriceList(tx, f.orgId))).toBeUndefined();
  });

  it('a list that does not exist is refused, and so is a person who may not edit price lists', async () => {
    const f = await fixture('refusals');
    const a = await newList(f);
    await expect(asOrg(f.orgId, (tx) => setDefaultPriceList(tx, f.admin, { priceListId: '00000000-0000-4000-8000-000000000000' }))).rejects.toThrow(/does not exist/);
    await expect(asOrg(f.orgId, (tx) => setDefaultPriceList(tx, f.staff, { priceListId: a.id }))).rejects.toThrow();
    expect(await asOrg(f.orgId, (tx) => customersRepo.getDefaultPriceList(tx, f.orgId))).toBeUndefined();
  });
});

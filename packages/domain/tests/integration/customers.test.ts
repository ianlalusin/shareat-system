import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-129 — customers and price lists. Fixes DEF-075.
 *
 * ⭐ Two tests carry the design:
 *   1. *"the treatment is derived, and both links at once is refused"* — ADR-008 §2. One treatment
 *      eliminates the movement, the other books real revenue; ambiguity there is invisible.
 *   2. *"no column stores the balance"* — DEF-075, the fifth time.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(
    `Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`,
  );
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { customersRepo, closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import {
  createCustomer,
  createPriceList,
  reconcileCustomer,
  setPrice,
  treatmentOf,
} from '@shareat/domain';

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
  const code = uid(`cust-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id
  `;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id
  `;
  await sql`
    insert into fiscal_periods (org_id, starts_on, ends_on, status)
    values (${orgId}, '2026-01-01', '2026-01-31', 'open')
  `;
  const [p] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id
  `;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${store!.id})`;
  return { orgId, storeId: store!.id, adminId: p!.id, admin: actor(orgId, p!.id) };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

beforeAll(async () => {
  await sql`select 1`;
});
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('⭐ the treatment is derived from the links — ADR-008 §2', () => {
  it('no link → EXTERNAL, real revenue', async () => {
    const f = await fixture('external');
    const created = await asOrg(f.orgId, (tx) =>
      createCustomer(tx, f.admin, { name: 'Resto Bulacan' }),
    );
    expect(created.treatment).toBe('external');
  });

  it('⭐ our own store → INTERNAL, and it ELIMINATES rather than becoming revenue', async () => {
    const f = await fixture('internal');
    const created = await asOrg(f.orgId, (tx) =>
      createCustomer(tx, f.admin, { name: 'Lipa branch', counterpartyStoreId: f.storeId }),
    );
    expect(created.treatment).toBe('internal');
  });

  it('⭐ another org → INTER-ENTITY, real revenue — the case v1 cannot express at all', async () => {
    const f = await fixture('interentity');
    const [other] = await sql<{ id: string }[]>`
      insert into organizations (name, code) values ('Franchise', ${uid('fr')}) returning id
    `;
    // ⛔ v1 models a franchise as a branch (ADR-008 §7), so this movement would eliminate there —
    // hiding revenue that genuinely crosses a legal entity.
    const created = await asOrg(f.orgId, (tx) =>
      createCustomer(tx, f.admin, { name: 'Padre Garcia', counterpartyOrgId: other!.id }),
    );
    expect(created.treatment).toBe('inter_entity');
  });

  it('⛔ BOTH links at once is refused — the two treatments are not close', async () => {
    const f = await fixture('bothlinks');
    const [other] = await sql<{ id: string }[]>`
      insert into organizations (name, code) values ('Franchise', ${uid('fr')}) returning id
    `;
    // One eliminates the movement entirely, the other books real revenue. Whichever the code tested
    // first would win, and nothing on any screen would look wrong.
    await expect(
      asOrg(f.orgId, (tx) =>
        createCustomer(tx, f.admin, {
          name: 'Ambiguous', counterpartyStoreId: f.storeId, counterpartyOrgId: other!.id,
        }),
      ),
    ).rejects.toThrow(/either one of our own stores or another company, never both/);
  });

  it('⛔ our OWN org as a counterparty is refused — that is a sale to ourselves', async () => {
    const f = await fixture('selforg');
    await expect(
      asOrg(f.orgId, (tx) =>
        createCustomer(tx, f.admin, { name: 'Us', counterpartyOrgId: f.orgId }),
      ),
    ).rejects.toThrow(/that is this organisation/);
  });

  it('⚠️ the DATABASE refuses both links too, not only the service', async () => {
    const f = await fixture('dbcheck');
    const [other] = await sql<{ id: string }[]>`
      insert into organizations (name, code) values ('Franchise', ${uid('fr')}) returning id
    `;
    // A service guard protects one caller; the CHECK protects every path into the table.
    await expect(
      sql`
        insert into customers (org_id, name, counterparty_store_id, counterparty_org_id, created_by)
        values (${f.orgId}, 'Sneaky', ${f.storeId}, ${other!.id}, ${f.adminId})
      `,
    ).rejects.toThrow(/customers_one_counterparty_check/);
  });

  it('⭐ customer_group does NOT decide the treatment', async () => {
    const f = await fixture('group');
    // ADR-008 §2: "customer_group never drives accounting." A row labelled `internal` with no link
    // is still an external sale, and if that ever stops being true it is the bug this pins.
    const created = await asOrg(f.orgId, (tx) =>
      createCustomer(tx, f.admin, { name: 'Mislabelled', customerGroup: 'internal' }),
    );
    expect(created.treatment).toBe('external');
  });
});

describe('⛔ the balance is derived — DEF-075', () => {
  it('⭐ no column stores it, and it reads zero before AR exists', async () => {
    const f = await fixture('balance');
    const created = await asOrg(f.orgId, (tx) =>
      createCustomer(tx, f.admin, { name: 'Resto Cavite' }),
    );
    const balance = await asOrg(f.orgId, (tx) =>
      customersRepo.balanceOf(tx, f.orgId, created.id),
    );
    // ⚠️ Nothing posts to 1210 yet — AR is T-131. Zero here is the figure being DERIVED from an
    // empty ledger, not a stored default.
    expect(balance).toBe('0.00');

    // ⛔ v1 keeps outstandingBalance on ARCustomerPlain, and another on ApSupplierPlain.
    const cols = await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns where table_name = 'customers'
    `;
    expect(cols.map((c) => c.column_name)).not.toContain('outstanding_balance');
  });

  it('⭐ and it reads a REAL posting once one exists', async () => {
    const f = await fixture('realbalance');
    const created = await asOrg(f.orgId, (tx) =>
      createCustomer(tx, f.admin, { name: 'Resto Batangas' }),
    );
    // Posted by hand because AR (T-131) does not exist yet — proving the query, not the module.
    const [period] = await sql<{ id: string }[]>`
      select id from fiscal_periods where org_id = ${f.orgId} limit 1
    `;
    await sql.begin(async (tx) => {
      const [e] = await tx<{ id: string }[]>`
        insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
        values (${f.orgId}, '2026-01-10', ${period!.id}, 'sale', ${uid('s')}, 'draft') returning id
      `;
      const codes = await tx<{ id: string; code: string }[]>`
        select id, code from accounts where org_id = ${f.orgId} and code in ('1210', '4100')
      `;
      const by = new Map(codes.map((c) => [c.code, c.id]));
      await tx`
        insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit, party_type, party_id)
        values (${e!.id}, 1, ${by.get('1210')!}, ${f.storeId}, '15000.00', '0', 'customer', ${created.id})
      `;
      await tx`
        insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit)
        values (${e!.id}, 2, ${by.get('4100')!}, ${f.storeId}, '0', '15000.00')
      `;
      await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
    });

    expect(await asOrg(f.orgId, (tx) => customersRepo.balanceOf(tx, f.orgId, created.id))).toBe(
      '15000.00',
    );
  });
});

describe('the reconciliation anchor', () => {
  it('records who and when, and only at zero', async () => {
    const f = await fixture('anchor');
    const created = await asOrg(f.orgId, (tx) =>
      createCustomer(tx, f.admin, { name: 'Resto Laguna' }),
    );
    await asOrg(f.orgId, (tx) =>
      reconcileCustomer(tx, f.admin, { customerId: created.id, asOf: '2026-01-31' }),
    );
    const row = await asOrg(f.orgId, (tx) => customersRepo.getById(tx, f.orgId, created.id));
    expect(row!.reconciledAsOf).toBe('2026-01-31');
    expect(row!.reconciledBy).toBe(f.adminId);
    expect(row!.reconciledAt).not.toBeNull();
  });

  it('⛔ is refused while the customer still owes money', async () => {
    const f = await fixture('anchorowed');
    const created = await asOrg(f.orgId, (tx) =>
      createCustomer(tx, f.admin, { name: 'Resto Rizal' }),
    );
    const [period] = await sql<{ id: string }[]>`
      select id from fiscal_periods where org_id = ${f.orgId} limit 1
    `;
    await sql.begin(async (tx) => {
      const [e] = await tx<{ id: string }[]>`
        insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
        values (${f.orgId}, '2026-01-10', ${period!.id}, 'sale', ${uid('s')}, 'draft') returning id
      `;
      const codes = await tx<{ id: string; code: string }[]>`
        select id, code from accounts where org_id = ${f.orgId} and code in ('1210', '4100')
      `;
      const by = new Map(codes.map((c) => [c.code, c.id]));
      await tx`
        insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit, party_type, party_id)
        values (${e!.id}, 1, ${by.get('1210')!}, ${f.storeId}, '900.00', '0', 'customer', ${created.id})
      `;
      await tx`
        insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit)
        values (${e!.id}, 2, ${by.get('4100')!}, ${f.storeId}, '0', '900.00')
      `;
      await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
    });

    // An anchor claiming zero against a live balance would tell every later aging report that a
    // real debt was settled.
    await expect(
      asOrg(f.orgId, (tx) =>
        reconcileCustomer(tx, f.admin, { customerId: created.id, asOf: '2026-01-31' }),
      ),
    ).rejects.toThrow(/this customer owes ₱900.00/);
  });

  it('⚠️ the DATABASE refuses a half-stamped anchor', async () => {
    const f = await fixture('halfanchor');
    // A date with no person is an assertion nobody can check.
    await expect(
      sql`
        insert into customers (org_id, name, reconciled_as_of, created_by)
        values (${f.orgId}, 'Half', '2026-01-31', ${f.adminId})
      `,
    ).rejects.toThrow(/customers_reconciled_shape_check/);
  });
});

describe('price lists', () => {

/** ⭐ T-145: a price list quotes an ITEM, not a text code. One helper mints one. */
async function item(f: Fixture, code: string, name: string, baseUnit = 'kg'): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into items (org_id, code, name, kind, base_unit, created_by, sellable_wholesale)
    -- ⭐ T-149: a price list is a WHOLESALE instrument, so anything quoted on one must be sold
    -- wholesale. These fixtures exist to test rates, so they are wholesale items by definition.
    values (${f.orgId}, ${code}, ${name}, 'raw_material', ${baseUnit}, ${f.adminId}, true)
    on conflict (org_id, code) do update set updated_at = now()
    returning id
  `;
  return row!.id;
}

  async function listWith(f: Fixture, itemCode: string, rate: string) {
    const list = await asOrg(f.orgId, (tx) =>
      createPriceList(tx, f.admin, { name: uid('Wholesale') }),
    );
    const itemId = await item(f, itemCode, 'Pork belly');
    await asOrg(f.orgId, (tx) =>
      setPrice(tx, f.admin, { priceListId: list.id, itemId, rate, unit: 'kg' }),
    );
    return list.id;
  }

  it('a customer on a list gets its rate', async () => {
    const f = await fixture('rate');
    const priceListId = await listWith(f, 'PORK-BELLY', '380.00');
    const created = await asOrg(f.orgId, (tx) =>
      createCustomer(tx, f.admin, { name: 'Resto Tagaytay', priceListId }),
    );
    const probeId = await item(f, 'PORK-BELLY', 'Pork-Belly');
    expect(
      await asOrg(f.orgId, (tx) => customersRepo.rateFor(tx, f.orgId, created.id, probeId)),
    ).toBe('380.00');
  });

  it('⛔ an unpriced item returns NULL, never zero and never another list', async () => {
    const f = await fixture('norate');
    const priceListId = await listWith(f, 'PORK-BELLY', '380.00');
    const created = await asOrg(f.orgId, (tx) =>
      createCustomer(tx, f.admin, { name: 'Resto Silang', priceListId }),
    );
    // Inventing a number where nobody has priced an item is how something ships free.
    const probeId = await item(f, 'BEEF-RIB', 'Beef-Rib');
    expect(
      await asOrg(f.orgId, (tx) => customersRepo.rateFor(tx, f.orgId, created.id, probeId)),
    ).toBeNull();
  });

  it('⛔ a customer with NO price list has no rate for anything', async () => {
    const f = await fixture('nolist');
    const created = await asOrg(f.orgId, (tx) =>
      createCustomer(tx, f.admin, { name: 'Resto Naic' }),
    );
    const probeId = await item(f, 'PORK-BELLY', 'Pork-Belly');
    expect(
      await asOrg(f.orgId, (tx) => customersRepo.rateFor(tx, f.orgId, created.id, probeId)),
    ).toBeNull();
  });

  it('⭐ re-quoting REPLACES the rate — a list holds one price per item, not a history', async () => {
    const f = await fixture('requote');
    const list = await asOrg(f.orgId, (tx) =>
      createPriceList(tx, f.admin, { name: uid('Wholesale') }),
    );
    const pb = await item(f, 'PORK-BELLY', 'Pork-Belly');
    await asOrg(f.orgId, (tx) =>
      setPrice(tx, f.admin, { priceListId: list.id, itemId: pb, rate: '380.00' }),
    );
    await asOrg(f.orgId, (tx) =>
      setPrice(tx, f.admin, { priceListId: list.id, itemId: pb, rate: '410.00' }),
    );
    const items = await asOrg(f.orgId, (tx) =>
      customersRepo.listPriceListItems(tx, f.orgId, list.id),
    );
    // Two rows would make "what does this cost?" answer whichever the planner reached first.
    expect(items).toHaveLength(1);
    expect(items[0]!.rate).toBe('410.00');
  });

  it('⭐ a re-quote keeps the unit, and the label can no longer be blanked at all (T-145)', async () => {
    const f = await fixture('requotelabel');
    const list = await asOrg(f.orgId, (tx) =>
      createPriceList(tx, f.admin, { name: uid('Wholesale') }),
    );
    const pbId = await item(f, 'PORK-BELLY', 'Pork belly');
    await asOrg(f.orgId, (tx) =>
      setPrice(tx, f.admin, {
        priceListId: list.id, itemId: pbId, rate: '380.00', unit: 'kg',
      }),
    );
    // ⭐ This test used to guard a real browser-found bug: re-pricing the normal way (a code and a
    // number) overwrote the label with null, so ₱380 "Pork belly / kg" came back as a bare code at
    // ₱410. T-145 made that bug UNREACHABLE rather than guarded — the name lives on the `items`
    // row and a price list holds only a rate, so there is no label here to blank. What still needs
    // guarding is the unit, which the list does own.
    await asOrg(f.orgId, (tx) =>
      setPrice(tx, f.admin, { priceListId: list.id, itemId: pbId, rate: '410.00' }),
    );
    const [row] = await asOrg(f.orgId, (tx) =>
      customersRepo.listPriceListItems(tx, f.orgId, list.id),
    );
    expect(row!.rate).toBe('410.00');
    expect(row!.itemName, 'the name comes from the item, and cannot be lost by re-pricing').toBe('Pork belly');
    expect(row!.unit).toBe('kg');
  });

  it('⚠️ zero is allowed, negative is not', async () => {
    const f = await fixture('zerorate');
    const list = await asOrg(f.orgId, (tx) =>
      createPriceList(tx, f.admin, { name: uid('Samples') }),
    );
    // A genuinely free line exists — a sample, a promotional unit — and refusing it pushes people
    // to type 0.01.
    const sampleId = await item(f, 'SAMPLE', 'Sample');
    await asOrg(f.orgId, (tx) =>
      setPrice(tx, f.admin, { priceListId: list.id, itemId: sampleId, rate: '0.00' }),
    );
    const oddId = await item(f, 'ODD', 'Odd');
    await expect(
      asOrg(f.orgId, (tx) =>
        setPrice(tx, f.admin, { priceListId: list.id, itemId: oddId, rate: '-5.00' }),
      ),
    ).rejects.toThrow(/cannot be negative/);
  });
});

describe('treatmentOf is a pure function of the links', () => {
  it('answers without touching the database', () => {
    expect(treatmentOf({ counterpartyStoreId: 's', counterpartyOrgId: null })).toBe('internal');
    expect(treatmentOf({ counterpartyStoreId: null, counterpartyOrgId: 'o' })).toBe('inter_entity');
    expect(treatmentOf({ counterpartyStoreId: null, counterpartyOrgId: null })).toBe('external');
  });
});

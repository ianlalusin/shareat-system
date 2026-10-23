import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-137 — the per-transaction SC/PWD statutory record. `docs/tasks/137-statutory-discount-logbook.md`.
 *
 * ⭐ **What these tests are really asserting is that the DATABASE holds the rules**, not the
 * service layer (bible §6.3, and RULES.md's "three that catch people out" #3). Every invariant
 * below is proved by attempting the bad write and watching Postgres refuse it — so the rule
 * survives a future caller that forgets to go through the domain function.
 *
 * ⛔ **Invariant 8 is the one to keep:** this table must never post to the ledger. Bible row 75
 * says a statutory basis is a separate layer OVER the ledger, never a retrofit of the accounts,
 * and a test is the only thing that stops a later well-meaning change from wiring it in.
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
import { closeDb, statutoryDiscountsRepo, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { AuthorizationError, CAPABILITY_MATRIX, type Actor } from '@shareat/auth';
import {
  recordStatutoryDiscount,
  voidStatutoryDiscount,
  listStatutoryDiscounts,
  summariseStatutoryDiscounts,
} from '@shareat/domain';
import { grantEverydayPositionAccess } from './_fixtures/staff-everyday-access';

const sql = postgres(url, { max: 5 });

let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

async function newOrg(hint: string) {
  const code = uid(`sd-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id
  `;
  await seedChartOfAccounts(sql, org!.id);
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${org!.id}, ${uid(hint)}, ${`Store ${hint}`}) returning id
  `;
  return { orgId: org!.id, storeId: store!.id };
}

async function person(orgId: string, storeId: string, name: string, role?: string) {
  const [p] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id
  `;
  if (role) {
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
  }
  await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
  return p!.id;
}

/** A 'staff' person() with the everyday position grant T-318 moved off the automatic matrix —
 *  this file's cashiers record statutory discounts, which is one of the 21. */
async function staffPerson(orgId: string, storeId: string, name: string): Promise<string> {
  const personId = await person(orgId, storeId, name, 'staff');
  const [employment] = await sql<{ id: string }[]>`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
    values (${orgId}, ${storeId}, ${personId}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e6)}${Math.floor(Math.random() * 1e6)}`}, 'regular', '2025-01-01')
    returning id
  `;
  await grantEverydayPositionAccess(sql, {
    orgId, storeId, employmentId: employment!.id, personId, setBy: personId,
  });
  return personId;
}

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

/** A well-formed record. Individual tests break exactly one field. */
const goodInput = (storeId: string) => ({
  storeId,
  businessDate: '2026-01-15',
  invoiceNumber: 'OR-000123',
  kind: 'senior' as const,
  idNumber: 'OSCA-0001234',
  holderName: 'Maria Santos',
  grossAmount: '1120.00',
  discountAmount: '224.00',
});

afterAll(async () => {
  await sql.end({ timeout: 5 });
  await closeDb();
});

describe('T-137 statutory discount records', () => {
  it('invariant 1 — records all six statutory fields, and derives the net rather than storing it', async () => {
    const { orgId, storeId } = await newOrg('inv1');
    const cashier = await staffPerson(orgId, storeId, 'Cashier');

    const { id } = await asOrg(orgId, (tx) =>
      recordStatutoryDiscount(tx, actor(orgId, cashier), goodInput(storeId)),
    );

    const [row] = await sql<Record<string, string>[]>`
      select business_date::text, invoice_number, kind, id_number, holder_name,
             gross_amount::text, discount_amount::text, source
      from statutory_discount_records where id = ${id}
    `;
    expect(row).toMatchObject({
      business_date: '2026-01-15',
      invoice_number: 'OR-000123',
      kind: 'senior',
      id_number: 'OSCA-0001234',
      holder_name: 'Maria Santos',
      gross_amount: '1120.00',
      discount_amount: '224.00',
      // ⭐ Provenance defaults to `manual`: nothing but a human can produce a row today, and
      // there is no paper logbook being transcribed FROM either (bible row 164).
      source: 'manual',
    });

    // ⛔ No `net_amount` column. A stored net is a third number that can disagree with the two
    // that define it — DEF-075's habit, and the whole point of deriving it.
    const cols = await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
      where table_name = 'statutory_discount_records'
    `;
    expect(cols.map((c) => c.column_name)).not.toContain('net_amount');

    const listed = await asOrg(orgId, (tx) =>
      listStatutoryDiscounts(tx, actor(orgId, cashier), { storeId, from: '2026-01-01', to: '2026-01-31' }),
    );
    expect(listed).toHaveLength(1);
    expect(listed[0]!.netAmount).toBe('896.00');
  });

  it('invariant 2 — ONE LIVE RECORD PER INVOICE: the "one discount only" rule is a constraint, not a check in code', async () => {
    const { orgId, storeId } = await newOrg('inv2');
    const cashier = await staffPerson(orgId, storeId, 'Cashier');
    const a = actor(orgId, cashier);

    await asOrg(orgId, (tx) => recordStatutoryDiscount(tx, a, goodInput(storeId)));

    // A PWD who is also a senior claims one 20%, not both. Same invoice, other kind.
    // ⚠️ Asserting the CONSTRAINT NAME, not merely "it threw". A bare rejects.toThrow() is
    // satisfied by any error at all — including the TypeError you get before the function
    // exists — which is how a test comes into the world already green and proving nothing.
    await expect(
      asOrg(orgId, (tx) =>
        recordStatutoryDiscount(tx, a, { ...goodInput(storeId), kind: 'pwd', idNumber: 'PWD-99', holderName: 'Same Person' }),
      ),
    ).rejects.toThrow(/statutory_discount_records_live_invoice_key/);
  });

  it('invariant 3 — a voided record frees its invoice, so a mistyped row can be re-entered', async () => {
    const { orgId, storeId } = await newOrg('inv3');
    const manager = await person(orgId, storeId, 'Manager', 'manager');
    const a = actor(orgId, manager);

    const { id } = await asOrg(orgId, (tx) => recordStatutoryDiscount(tx, a, goodInput(storeId)));
    await asOrg(orgId, (tx) => voidStatutoryDiscount(tx, a, { id, reason: 'ID number mistyped at entry' }));

    // Re-entering the same invoice must now succeed — a total unique index would block it forever.
    const { id: replacement } = await asOrg(orgId, (tx) =>
      recordStatutoryDiscount(tx, a, { ...goodInput(storeId), idNumber: 'OSCA-0007777' }),
    );
    expect(replacement).not.toBe(id);

    // ⛔ And the original is still THERE. Void, never DELETE: the burden of proof in a BIR audit
    // is on the seller, so the register must show that a row existed and was withdrawn.
    const [voided] = await sql<Record<string, string | null>[]>`
      select void_reason, voided_by, voided_at::text from statutory_discount_records where id = ${id}
    `;
    expect(voided!.void_reason).toBe('ID number mistyped at entry');
    expect(voided!.voided_by).toBe(manager);
    expect(voided!.voided_at).not.toBeNull();
  });

  it('invariant 4 — the database refuses a blank identity, not merely a NULL one', async () => {
    const { orgId, storeId } = await newOrg('inv4');
    const cashier = await staffPerson(orgId, storeId, 'Cashier');

    // NOT NULL stops a NULL; whitespace is what actually gets typed.
    for (const bad of [
      { holderName: '   ' },
      { idNumber: '' },
      { invoiceNumber: '  ' },
    ]) {
      await expect(
        asOrg(orgId, (tx) =>
          recordStatutoryDiscount(tx, actor(orgId, cashier), { ...goodInput(storeId), ...bad }),
        ),
      ).rejects.toThrow(/statutory_discount_records_identity_present_check/);
    }
  });

  it('invariant 5 — amounts must be positive and the discount cannot exceed the gross', async () => {
    const { orgId, storeId } = await newOrg('inv5');
    const cashier = await staffPerson(orgId, storeId, 'Cashier');
    const a = actor(orgId, cashier);

    for (const [bad, constraint] of [
      [{ grossAmount: '0.00' }, /amounts_positive_check/],        // not a sale
      [{ discountAmount: '0.00' }, /amounts_positive_check/],     // not a discount
      [{ discountAmount: '-5.00' }, /amounts_positive_check/],
      [{ discountAmount: '1200.00' }, /discount_within_gross_check/], // exceeds the 1120.00 gross
    ] as const) {
      await expect(
        asOrg(orgId, (tx) => recordStatutoryDiscount(tx, a, { ...goodInput(storeId), ...bad })),
      ).rejects.toThrow(constraint);
    }
  });

  it('invariant 6 — the register is org-isolated by RLS, because it names customers', async () => {
    const one = await newOrg('inv6a');
    const two = await newOrg('inv6b');
    const cashier = await staffPerson(one.orgId, one.storeId, 'Cashier');

    await asOrg(one.orgId, (tx) =>
      recordStatutoryDiscount(tx, actor(one.orgId, cashier), goodInput(one.storeId)),
    );

    // ⚠️ Reading another org's register would be reading named individuals' age or disability
    // status — a privacy boundary, not merely a commercial one.
    const seenByOther = await asOrg(two.orgId, async (tx) => {
      const rows = await tx.execute(dsql`select id from statutory_discount_records`);
      return (rows as unknown as unknown[]).length;
    });
    expect(seenByOther).toBe(0);
  });

  it('invariant 7 — recording is staff-open, voiding is NOT, and that asymmetry is the control', async () => {
    const { orgId, storeId } = await newOrg('inv7');
    const cashier = await staffPerson(orgId, storeId, 'Cashier');
    const manager = await person(orgId, storeId, 'Manager', 'manager');

    // T-318 moved recording off the automatic staff matrix cell onto a position grant — the
    // cashier above holds it through staffPerson()'s helper-granted position, not the role.
    // Voiding stays a manager-tier matrix cell, unmoved by this task.
    expect(CAPABILITY_MATRIX.record_statutory_discount.staff).toBe(false);
    expect(CAPABILITY_MATRIX.void_statutory_discount.staff).toBe(false);

    // A cashier transcribing the paper logbook is the ONLY way this table gets filled today.
    const { id } = await asOrg(orgId, (tx) =>
      recordStatutoryDiscount(tx, actor(orgId, cashier), goodInput(storeId)),
    );

    await expect(
      asOrg(orgId, (tx) =>
        voidStatutoryDiscount(tx, actor(orgId, cashier), { id, reason: 'cashier should not be able to' }),
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);

    await asOrg(orgId, (tx) =>
      voidStatutoryDiscount(tx, actor(orgId, manager), { id, reason: 'supervisory withdrawal' }),
    );
  });

  it('invariant 8 — ⛔ recording a statutory discount POSTS NOTHING to the ledger (bible row 75)', async () => {
    const { orgId, storeId } = await newOrg('inv8');
    const cashier = await staffPerson(orgId, storeId, 'Cashier');

    const before = await sql<{ n: string }[]>`
      select count(*)::text as n from journal_entries where org_id = ${orgId}
    `;
    await asOrg(orgId, (tx) =>
      recordStatutoryDiscount(tx, actor(orgId, cashier), goodInput(storeId)),
    );
    const after = await sql<{ n: string }[]>`
      select count(*)::text as n from journal_entries where org_id = ${orgId}
    `;

    // A statutory basis is a separate layer OVER the ledger, never a retrofit of the accounts.
    // The daily sales_days.senior_discount / pwd_discount totals remain the only thing that
    // reaches 4900.
    expect(after[0]!.n).toBe(before[0]!.n);

    // And the table carries no journal_entry_id at all, so it cannot be wired in later by
    // accident — it would take a migration, which is a conversation.
    const cols = await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
      where table_name = 'statutory_discount_records'
    `;
    expect(cols.map((c) => c.column_name)).not.toContain('journal_entry_id');
  });

  it('invariant 9 — the report lists live rows in date order and totals them, excluding voided', async () => {
    const { orgId, storeId } = await newOrg('inv9');
    const manager = await person(orgId, storeId, 'Manager', 'manager');
    const a = actor(orgId, manager);

    await asOrg(orgId, (tx) =>
      recordStatutoryDiscount(tx, a, { ...goodInput(storeId), businessDate: '2026-01-20', invoiceNumber: 'OR-2' }),
    );
    await asOrg(orgId, (tx) =>
      recordStatutoryDiscount(tx, a, {
        ...goodInput(storeId), businessDate: '2026-01-10', invoiceNumber: 'OR-1',
        kind: 'pwd', idNumber: 'PWD-55', holderName: 'Jose Cruz',
        grossAmount: '560.00', discountAmount: '112.00',
      }),
    );
    const { id: dropped } = await asOrg(orgId, (tx) =>
      recordStatutoryDiscount(tx, a, { ...goodInput(storeId), businessDate: '2026-01-25', invoiceNumber: 'OR-3' }),
    );
    await asOrg(orgId, (tx) => voidStatutoryDiscount(tx, a, { id: dropped, reason: 'duplicate of OR-2' }));

    const rows = await asOrg(orgId, (tx) =>
      listStatutoryDiscounts(tx, a, { storeId, from: '2026-01-01', to: '2026-01-31' }),
    );
    expect(rows.map((r) => r.invoiceNumber)).toEqual(['OR-1', 'OR-2']);

    const summary = await asOrg(orgId, (tx) =>
      statutoryDiscountsRepo.summaryForRange(tx, orgId, { storeId, from: '2026-01-01', to: '2026-01-31' }),
    );
    expect(summary).toMatchObject({
      count: 2,
      grossAmount: '1680.00',
      discountAmount: '336.00',
      seniorCount: 1,
      pwdCount: 1,
    });
  });

  it('invariant 11 — an unfiltered read is bounded by the caller’s OWN store scope, not by the org', async () => {
    // ⛔ Regression for a bug found in self-review, not by a failing test: `listStatutoryDiscounts`
    // originally passed `storeId: undefined` straight to `authorize`, which THROWS for a
    // store-scoped capability with no store — so the "All stores" filter crashed every time.
    // Fixing the crash exposed the real question: what should "all" mean? Not "every store in the
    // org. RLS bounds the ORG; nothing was bounding the STORE.
    const { orgId, storeId } = await newOrg('inv11');
    const [otherStore] = await sql<{ id: string }[]>`
      insert into stores (org_id, code, name) values (${orgId}, ${uid('inv11-other')}, 'Other branch') returning id
    `;

    // A manager scoped to ONE branch of a two-branch org.
    const scopedManager = await person(orgId, storeId, 'Branch Manager', 'manager');
    const wideManager = await person(orgId, storeId, 'Area Manager', 'manager');
    await sql`insert into person_store_scope (person_id, store_id) values (${wideManager}, ${otherStore!.id})`;

    await asOrg(orgId, (tx) =>
      recordStatutoryDiscount(tx, actor(orgId, wideManager), { ...goodInput(storeId), invoiceNumber: 'OR-HERE' }),
    );
    await asOrg(orgId, (tx) =>
      recordStatutoryDiscount(tx, actor(orgId, wideManager), {
        ...goodInput(otherStore!.id), invoiceNumber: 'OR-THERE',
      }),
    );

    const q = { from: '2026-01-01', to: '2026-01-31' };

    // Clearing the dropdown must not widen what a branch manager can read.
    const narrow = await asOrg(orgId, (tx) => listStatutoryDiscounts(tx, actor(orgId, scopedManager), q));
    expect(narrow.map((r) => r.invoiceNumber)).toEqual(['OR-HERE']);

    // ...while someone actually scoped to both branches sees both.
    const wide = await asOrg(orgId, (tx) => listStatutoryDiscounts(tx, actor(orgId, wideManager), q));
    expect(wide.map((r) => r.invoiceNumber).sort()).toEqual(['OR-HERE', 'OR-THERE']);

    // And the summary agrees with the list rather than being scoped differently — two readers of
    // one rule is how they drift.
    const narrowSummary = await asOrg(orgId, (tx) =>
      summariseStatutoryDiscounts(tx, actor(orgId, scopedManager), q),
    );
    expect(narrowSummary.count).toBe(1);
  });

  it('invariant 10 — no discount RATE is enforced, because the statutes define more than one', async () => {
    const { orgId, storeId } = await newOrg('inv10');
    const cashier = await staffPerson(orgId, storeId, 'Cashier');

    // RR 5-2017 carries a 5% special discount on basic necessities alongside the headline 20%,
    // and promotional pricing can interact with both. A hard 20% rule here would reject valid
    // records, so the rate is recorded rather than judged — "where v1 and correct accounting
    // disagree, practice wins" (RULES §3).
    const { id } = await asOrg(orgId, (tx) =>
      recordStatutoryDiscount(tx, actor(orgId, cashier), {
        ...goodInput(storeId), grossAmount: '1000.00', discountAmount: '50.00',
      }),
    );
    const [row] = await sql<Record<string, string>[]>`
      select discount_amount::text from statutory_discount_records where id = ${id}
    `;
    expect(row!.discount_amount).toBe('50.00');
  });
});

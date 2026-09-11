import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-264 / DEF-284 slice 2 — a way to CLOSE a fiscal period.
 * `docs/tasks/264-def-284-fiscal-period-lock.md`, `docs/decisions/ADR-006-period-close.md`.
 *
 * ⭐ Slice 2 is the generic lock for ANY period, month or year alike — `closed_at`/`closed_by` plus
 * the readiness gate. The year-close journal entry ADR-006 describes is deliberately NOT built
 * here; it is unsliced follow-on work (orchestrator ruling, 2026-09-11).
 *
 * Gate order proved, in this order, per the task's own discipline — a gate not watched failing is
 * not a gate that has been tested:
 *   1. capability refusal — staff
 *   2. capability refusal — manager without org-wide store scope
 *   3. unposted-draft gate (expenses/deliveries dated in the period)
 *   4. readiness gate (closeReadiness's hard findings)
 *   5. earlier-period-still-open gate
 *   6. the happy path, closed_at/closed_by both written, atomically
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import { closePeriod, postEntry } from '@shareat/domain';

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

/**
 * One org, two stores, real periods, and four people: an admin, a manager scoped to BOTH stores
 * (org-wide), a manager scoped to only ONE (the non-zero control for the org-wide-scope rule), and
 * a staff member. `PERIOD` ('2026-01') is real-clock-disjoint from "today" so `fiscalPeriodRunwayLow`
 * — a hard finding — never fires by accident (same technique `findings.test.ts` uses).
 */
async function fixture(hint: string) {
  const code = uid(`fpc-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);

  const [storeA] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid('A')}, 'Store A') returning id`;
  const [storeB] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid('B')}, 'Store B') returning id`;

  const person = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    return p!.id;
  };
  const adminId = await person('Admin', 'admin');
  const wholeOrgManagerId = await person('Whole-org Manager', 'manager');
  const oneStoreManagerId = await person('One-store Manager', 'manager');
  const staffId = await person('Staff', 'staff');
  // The admin needs no store scope — the role alone carries it (authorize.ts's plain `true` row).
  await sql`insert into person_store_scope (person_id, store_id) values (${wholeOrgManagerId}, ${storeA!.id}), (${wholeOrgManagerId}, ${storeB!.id})`;
  await sql`insert into person_store_scope (person_id, store_id) values (${oneStoreManagerId}, ${storeA!.id})`;

  return {
    orgId,
    storeAId: storeA!.id,
    storeBId: storeB!.id,
    admin: actor(orgId, adminId),
    wholeOrgManager: actor(orgId, wholeOrgManagerId),
    oneStoreManager: actor(orgId, oneStoreManagerId),
    staff: actor(orgId, staffId),
    adminPersonId: adminId,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** `starts_on`/`ends_on` a real month apart, real-clock-disjoint from "today" so the fiscal-period
 *  runway finding never fires. `status` defaults to `open`. */
async function openPeriod(orgId: string, period: string, status: 'open' | 'closed' | 'locked' = 'open') {
  const [y, m] = period.split('-').map(Number);
  const startsOn = `${period}-01`;
  const endsOn = new Date(Date.UTC(y!, m!, 0)).toISOString().slice(0, 10);
  await sql`
    insert into fiscal_periods (org_id, starts_on, ends_on, status)
    values (${orgId}, ${startsOn}, ${endsOn}, ${status})`;
}

const PERIOD = '2026-01';
const PRIOR_PERIOD = '2025-12';

async function statusOf(orgId: string, period: string): Promise<string> {
  const startsOn = `${period}-01`;
  const [row] = await sql<{ status: string }[]>`
    select status from fiscal_periods where org_id = ${orgId} and starts_on = ${startsOn}`;
  return row!.status;
}

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('T-264 slice 2 — closePeriod: the capability refusals', () => {
  it('⛔ staff may not close a period', async () => {
    const f = await fixture('staff-refused');
    await openPeriod(f.orgId, PERIOD);
    await expect(
      asOrg(f.orgId, (tx) => closePeriod(tx, f.staff, { period: PERIOD })),
    ).rejects.toThrow(AuthorizationError);
    expect(await statusOf(f.orgId, PERIOD)).toBe('open');
  });

  it('⛔ a manager whose store scope does not cover the whole org may not close it', async () => {
    const f = await fixture('partial-manager-refused');
    await openPeriod(f.orgId, PERIOD);
    await expect(
      asOrg(f.orgId, (tx) => closePeriod(tx, f.oneStoreManager, { period: PERIOD })),
    ).rejects.toThrow(/whole org/);
    expect(await statusOf(f.orgId, PERIOD)).toBe('open');
  });

  it('✅ a manager whose store scope covers the whole org MAY close it', async () => {
    const f = await fixture('whole-org-manager-allowed');
    await openPeriod(f.orgId, PERIOD);
    const result = await asOrg(f.orgId, (tx) => closePeriod(tx, f.wholeOrgManager, { period: PERIOD }));
    expect(result.periodId).toBeTruthy();
    expect(await statusOf(f.orgId, PERIOD)).toBe('closed');
  });
});

describe('T-264 slice 2 — closePeriod: the unposted-draft gate', () => {
  /** T-130's gate: an expense (even a draft) names a real supplier and a real invoice. */
  async function aSupplierInvoice(f: Fixture) {
    const [supplier] = await sql<{ id: string }[]>`
      insert into suppliers (org_id, name, created_by) values (${f.orgId}, ${'Supplier ' + uid('s')}, ${f.adminPersonId})
      returning id`;
    const [file] = await sql<{ id: string }[]>`
      insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
      values (${f.orgId}, ${f.storeAId}, 'receipt_photo', ${'orgs/' + f.orgId + '/p-' + uid('f') + '.jpg'}, 'image/jpeg', 1024, ${uid('sum')}, ${f.adminPersonId})
      returning id`;
    const [invoice] = await sql<{ id: string }[]>`
      insert into supplier_invoices (
        org_id, store_id, supplier_id, invoice_date, total_amount, status,
        receipt_file_id, verified_by, verified_at, created_by,
        attested_supplier, attested_invoice, attested_items, attested_price
      ) values (
        ${f.orgId}, ${f.storeAId}, ${supplier!.id}, '2026-01-01', '99999.00', 'verified',
        ${file!.id}, ${f.wholeOrgManager.personId}, now(), ${f.adminPersonId}, true, true, true, true
      )
      returning id`;
    return invoice!.id;
  }

  it('⛔ a draft expense dated in the period blocks the close, and names the count', async () => {
    const f = await fixture('draft-expense-blocks');
    await openPeriod(f.orgId, PERIOD);
    const invoiceId = await aSupplierInvoice(f);
    const [cat] = await sql<{ id: string }[]>`
      insert into expense_categories (org_id, "group", category, account_code)
      values (${f.orgId}, 'OPEX', ${uid('cat')}, '6200') returning id`;
    await sql`
      insert into expenses (org_id, store_id, business_date, total_amount, category_id, supplier_id, supplier_invoice_id, particulars, status, created_by)
      select ${f.orgId}, ${f.storeAId}, '2026-01-15', '500.00', ${cat!.id}, supplier_id, ${invoiceId}, 'fixture', 'draft', ${f.adminPersonId}
      from supplier_invoices where id = ${invoiceId}`;

    await expect(
      asOrg(f.orgId, (tx) => closePeriod(tx, f.admin, { period: PERIOD })),
    ).rejects.toThrow(/1 draft expense/);
    expect(await statusOf(f.orgId, PERIOD)).toBe('open');
  });

  it('⛔ a draft delivery dated in the period blocks the close, and names the count', async () => {
    const f = await fixture('draft-delivery-blocks');
    await openPeriod(f.orgId, PERIOD);
    const [file] = await sql<{ id: string }[]>`
      insert into stored_files (org_id, storage_path, content_type, byte_size, checksum, purpose, uploaded_by)
      values (${f.orgId}, ${'orgs/' + f.orgId + '/p.jpg'}, 'image/jpeg', 10, 'x', 'receipt_photo', ${f.adminPersonId}) returning id`;
    await sql`
      insert into deliveries (org_id, store_id, kind, delivered_on, proof_file_id, created_by)
      values (${f.orgId}, ${f.storeAId}, 'purchase', '2026-01-20', ${file!.id}, ${f.adminPersonId})`;

    await expect(
      asOrg(f.orgId, (tx) => closePeriod(tx, f.admin, { period: PERIOD })),
    ).rejects.toThrow(/1 draft delivery/);
    expect(await statusOf(f.orgId, PERIOD)).toBe('open');
  });

  it('✅ a draft expense dated OUTSIDE the period does not block it', async () => {
    const f = await fixture('draft-expense-out-of-period');
    await openPeriod(f.orgId, PERIOD);
    const invoiceId = await aSupplierInvoice(f);
    const [cat] = await sql<{ id: string }[]>`
      insert into expense_categories (org_id, "group", category, account_code)
      values (${f.orgId}, 'OPEX', ${uid('cat')}, '6200') returning id`;
    // February — a real month outside January's range.
    await sql`
      insert into expenses (org_id, store_id, business_date, total_amount, category_id, supplier_id, supplier_invoice_id, particulars, status, created_by)
      select ${f.orgId}, ${f.storeAId}, '2026-02-03', '500.00', ${cat!.id}, supplier_id, ${invoiceId}, 'fixture', 'draft', ${f.adminPersonId}
      from supplier_invoices where id = ${invoiceId}`;

    const result = await asOrg(f.orgId, (tx) => closePeriod(tx, f.admin, { period: PERIOD }));
    expect(result.periodId).toBeTruthy();
  });
});

describe('T-264 slice 2 — closePeriod: the readiness gate (closeReadiness re-run, never trusted)', () => {
  it('⛔ a hard finding (due-from/due-to not reciprocal) blocks the close', async () => {
    const f = await fixture('readiness-blocks');
    await openPeriod(f.orgId, PERIOD);
    // Balanced overall (postEntry's own requirement) — 1250 has no matching 2150 anywhere, which
    // is what `reciprocalDrift` exists to catch. Same technique findings.test.ts already uses.
    await asOrg(f.orgId, (tx) =>
      postEntry(tx, {
        orgId: f.orgId,
        entryDate: '2026-01-10',
        sourceType: 'test',
        sourceId: uid('drift'),
        idempotencyKey: uid('drift-key'),
        lines: [
          { accountCode: '1250', storeId: f.storeAId, debit: '500.00', partyType: 'store', partyId: f.storeBId },
          { accountCode: '1110', storeId: f.storeAId, credit: '500.00' },
        ],
      }),
    );

    await expect(
      asOrg(f.orgId, (tx) => closePeriod(tx, f.admin, { period: PERIOD })),
    ).rejects.toThrow(/not ready to close.*dueFromDueToNotReciprocal/);
    expect(await statusOf(f.orgId, PERIOD)).toBe('open');
  });

  it('✅ a clean ledger is ready — closeReadiness reports ready and the close proceeds', async () => {
    const f = await fixture('readiness-clean');
    await openPeriod(f.orgId, PERIOD);
    await asOrg(f.orgId, (tx) =>
      postEntry(tx, {
        orgId: f.orgId,
        entryDate: '2026-01-10',
        sourceType: 'test',
        sourceId: uid('clean'),
        idempotencyKey: uid('clean-key'),
        lines: [
          { accountCode: '6300', storeId: f.storeAId, debit: '10.00' },
          { accountCode: '1110', storeId: f.storeAId, credit: '10.00' },
        ],
      }),
    );
    const result = await asOrg(f.orgId, (tx) => closePeriod(tx, f.admin, { period: PERIOD }));
    expect(result.periodId).toBeTruthy();
  });
});

describe('T-264 slice 2 — closePeriod: periods close in order', () => {
  it('⛔ an earlier period still open refuses the close', async () => {
    const f = await fixture('earlier-open-blocks');
    await openPeriod(f.orgId, PRIOR_PERIOD);
    await openPeriod(f.orgId, PERIOD);

    await expect(
      asOrg(f.orgId, (tx) => closePeriod(tx, f.admin, { period: PERIOD })),
    ).rejects.toThrow(/in order/);
    expect(await statusOf(f.orgId, PERIOD)).toBe('open');
  });

  it('✅ closing the earlier period first, then the later one, both succeed', async () => {
    const f = await fixture('earlier-open-then-closed');
    await openPeriod(f.orgId, PRIOR_PERIOD);
    await openPeriod(f.orgId, PERIOD);

    await asOrg(f.orgId, (tx) => closePeriod(tx, f.admin, { period: PRIOR_PERIOD }));
    expect(await statusOf(f.orgId, PRIOR_PERIOD)).toBe('closed');

    const result = await asOrg(f.orgId, (tx) => closePeriod(tx, f.admin, { period: PERIOD }));
    expect(result.periodId).toBeTruthy();
    expect(await statusOf(f.orgId, PERIOD)).toBe('closed');
  });
});

describe('T-264 slice 2 — closePeriod: the happy path, and what it actually writes', () => {
  it('✅ writes status, closed_at and closed_by together, and returns them', async () => {
    const f = await fixture('happy-path');
    await openPeriod(f.orgId, PERIOD);
    const before = Date.now();

    const result = await asOrg(f.orgId, (tx) => closePeriod(tx, f.admin, { period: PERIOD }));

    expect(result.closedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    const [row] = await sql<{ status: string; closed_at: Date; closed_by: string }[]>`
      select status, closed_at, closed_by from fiscal_periods where id = ${result.periodId}`;
    expect(row!.status).toBe('closed');
    expect(row!.closed_at).not.toBeNull();
    expect(row!.closed_by).toBe(f.adminPersonId);
  });

  it('⛔ closing an already-closed period is refused, not silently repeated', async () => {
    const f = await fixture('already-closed');
    await openPeriod(f.orgId, PERIOD);
    await asOrg(f.orgId, (tx) => closePeriod(tx, f.admin, { period: PERIOD }));

    await expect(
      asOrg(f.orgId, (tx) => closePeriod(tx, f.admin, { period: PERIOD })),
    ).rejects.toThrow(/does not exist, or is not open/);
  });

  it('⛔ closing a period that was never seeded is refused, naming that it does not exist', async () => {
    const f = await fixture('never-seeded');
    await expect(
      asOrg(f.orgId, (tx) => closePeriod(tx, f.admin, { period: PERIOD })),
    ).rejects.toThrow(/does not exist, or is not open/);
  });
});

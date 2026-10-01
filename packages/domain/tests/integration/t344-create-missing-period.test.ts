import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-344 / DEF-422 — the admin action that creates a month missing inside closed books.
 * `docs/tasks/344-def-422-fiscal-period-holes.md` §4, File 2.
 *
 * ⛔ RED until the builder lands `createMissingClosedPeriod`/`closeBlockers` (§3.3) and migration
 * 0160 (§3.5). F12 needs 0160's `created_by`/`fill_reason` columns and triggers directly — it fails
 * on the missing migration, a DIFFERENT red than the rest, which fail on
 * `createMissingClosedPeriod is not a function`.
 *
 * Every decision goes through the real `authorize()` (F1-F5). `asOrg`/`fixture`-style helpers
 * follow `fiscal-period-close.test.ts`'s own pattern for actors and roles.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, transaction, withOrgPrincipal, APP_ROLE, type Tx } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import { createMissingClosedPeriod, closePeriod, postEntry } from '@shareat/domain';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

function monthEnd(year: number, month1based: number): string {
  return new Date(Date.UTC(year, month1based, 0)).toISOString().slice(0, 10);
}
async function insertPeriod(
  orgId: string,
  startsOn: string,
  endsOn: string,
  opts: { status?: 'open' | 'closed' | 'locked'; closedAt?: string; closedBy?: string } = {},
): Promise<void> {
  await sql`
    insert into fiscal_periods (org_id, starts_on, ends_on, status, closed_at, closed_by)
    values (${orgId}, ${startsOn}, ${endsOn}, ${opts.status ?? 'open'}, ${opts.closedAt ?? null}, ${opts.closedBy ?? null})`;
}
async function insertMonths(
  orgId: string,
  startYear: number,
  startMonth: number,
  endYear: number,
  endMonth: number,
  opts: { status?: 'open' | 'closed' | 'locked'; closedAt?: string; closedBy?: string } = {},
): Promise<void> {
  let y = startYear;
  let m = startMonth;
  while (y < endYear || (y === endYear && m <= endMonth)) {
    await insertPeriod(orgId, `${y}-${String(m).padStart(2, '0')}-01`, monthEnd(y, m), opts);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
}

interface PeriodRow {
  starts_on: string;
  ends_on: string;
  status: string;
}
async function periodsFor(orgId: string): Promise<PeriodRow[]> {
  return sql<PeriodRow[]>`
    select starts_on::text as starts_on, ends_on::text as ends_on, status
    from fiscal_periods where org_id = ${orgId} order by starts_on`;
}
async function periodCount(orgId: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`select count(*)::int as n from fiscal_periods where org_id = ${orgId}`;
  return row!.n;
}
async function periodStatus(orgId: string, startsOn: string): Promise<{ status: string; closed_by: string; created_by: string | null; fill_reason: string | null } | undefined> {
  const [row] = await sql<{ status: string; closed_by: string; created_by: string | null; fill_reason: string | null }[]>`
    select status, closed_by, created_by, fill_reason from fiscal_periods where org_id = ${orgId} and starts_on = ${startsOn}`;
  return row;
}

/** One org, a store, and four people: admin, super_admin, a manager scoped to the WHOLE org
 *  (holds `close_period` baseline), and staff — `fiscal-period-close.test.ts`'s own shape,
 *  extended with a super_admin actor. */
async function rolesFixture(hint: string) {
  const code = uid(`t344-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  // T-346 S2 (R4.1): opening_date before activeFixedAsset's 2026-01-01 acquired_on, so once the S2
  // in-service fill trigger lands, `periodFullyCovered` (missed-months/index.ts, via the exported
  // `scheduleInputFor`) still sees this asset owing its schedule instead of reading it as HELD.
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name, opening_date) values (${orgId}, ${uid('s')}, 'Store', '2020-01-01') returning id`;
  const person = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    return p!.id;
  };
  const adminId = await person('Admin', 'admin');
  const superAdminId = await person('Super Admin', 'super_admin');
  const managerId = await person('Manager', 'manager');
  const staffId = await person('Staff', 'staff');
  await sql`insert into person_store_scope (person_id, store_id) values (${managerId}, ${store!.id})`;
  return {
    orgId,
    storeId: store!.id,
    adminId,
    admin: actor(orgId, adminId),
    superAdmin: actor(orgId, superAdminId),
    manager: actor(orgId, managerId),
    staff: actor(orgId, staffId),
  };
}
type RolesFixture = Awaited<ReturnType<typeof rolesFixture>>;

/** H3's shape: 2026-01..03 closed, 04 MISSING, 05 closed, 06..2027-08 open. */
async function h3Shape(hint: string): Promise<RolesFixture> {
  const f = await rolesFixture(hint);
  await insertMonths(f.orgId, 2026, 1, 2026, 3, { status: 'closed', closedAt: '2026-04-01T00:00:00Z', closedBy: f.adminId });
  await insertMonths(f.orgId, 2026, 5, 2026, 5, { status: 'closed', closedAt: '2026-06-01T00:00:00Z', closedBy: f.adminId });
  await insertMonths(f.orgId, 2026, 6, 2027, 8);
  return f;
}

/** H7's shape: 2026-04 closed, 05-01..05-20 closed, 06 closed, 07..2027-08 open — the missing
 *  piece is 2026-05-21..2026-05-31 (part of May). */
async function h7Shape(hint: string): Promise<RolesFixture> {
  const f = await rolesFixture(hint);
  await insertMonths(f.orgId, 2026, 4, 2026, 4, { status: 'closed', closedAt: '2026-05-01T00:00:00Z', closedBy: f.adminId });
  await insertPeriod(f.orgId, '2026-05-01', '2026-05-20', { status: 'closed', closedAt: '2026-05-21T00:00:00Z', closedBy: f.adminId });
  await insertMonths(f.orgId, 2026, 6, 2026, 6, { status: 'closed', closedAt: '2026-07-01T00:00:00Z', closedBy: f.adminId });
  await insertMonths(f.orgId, 2026, 7, 2027, 8);
  return f;
}

/** H5's shape: 2025 all locked except 2025-06 missing; 2026-01..2027-08 open. */
async function h5Shape(hint: string): Promise<RolesFixture> {
  const f = await rolesFixture(hint);
  await insertMonths(f.orgId, 2025, 1, 2025, 5, { status: 'locked', closedAt: '2025-06-01T00:00:00Z', closedBy: f.adminId });
  await insertMonths(f.orgId, 2025, 7, 2025, 12, { status: 'locked', closedAt: '2026-01-01T00:00:00Z', closedBy: f.adminId });
  await insertMonths(f.orgId, 2026, 1, 2027, 8);
  return f;
}

/** T-130's gate shape: a real supplier + a verified invoice, copied from
 *  `fiscal-period-close.test.ts`'s `aSupplierInvoice`. */
async function aSupplierInvoice(f: RolesFixture, supplierName: string): Promise<{ invoiceId: string; supplierId: string }> {
  const [supplier] = await sql<{ id: string }[]>`
    insert into suppliers (org_id, name, created_by) values (${f.orgId}, ${supplierName}, ${f.adminId})
    returning id`;
  const [file] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
    values (${f.orgId}, ${f.storeId}, 'receipt_photo', ${'orgs/' + f.orgId + '/p-' + uid('f') + '.jpg'}, 'image/jpeg', 1024, ${uid('sum')}, ${f.adminId})
    returning id`;
  const [invoice] = await sql<{ id: string }[]>`
    insert into supplier_invoices (
      org_id, store_id, supplier_id, invoice_date, total_amount, status,
      receipt_file_id, verified_by, verified_at, created_by,
      attested_supplier, attested_invoice, attested_items, attested_price
    ) values (
      ${f.orgId}, ${f.storeId}, ${supplier!.id}, '2026-01-01', '99999.00', 'verified',
      ${file!.id}, ${f.manager.personId}, now(), ${f.adminId}, true, true, true, true
    )
    returning id`;
  return { invoiceId: invoice!.id, supplierId: supplier!.id };
}

async function draftExpenseDated(f: RolesFixture, businessDate: string, invoiceId: string): Promise<string> {
  const [cat] = await sql<{ id: string }[]>`
    insert into expense_categories (org_id, "group", category, account_code)
    values (${f.orgId}, 'OPEX', ${uid('cat')}, '6200') returning id`;
  const [row] = await sql<{ id: string }[]>`
    insert into expenses (org_id, store_id, business_date, total_amount, category_id, supplier_id, supplier_invoice_id, particulars, status, created_by)
    select ${f.orgId}, ${f.storeId}, ${businessDate}, '500.00', ${cat!.id}, supplier_id, ${invoiceId}, 'fixture', 'draft', ${f.adminId}
    from supplier_invoices where id = ${invoiceId}
    returning id`;
  return row!.id;
}

async function draftDeliveryDated(f: RolesFixture, deliveredOn: string, kind: string, supplierId?: string): Promise<string> {
  const [file] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, storage_path, content_type, byte_size, checksum, purpose, uploaded_by)
    values (${f.orgId}, ${'orgs/' + f.orgId + '/d-' + uid('f') + '.jpg'}, 'image/jpeg', 10, ${uid('sum')}, 'receipt_photo', ${f.adminId}) returning id`;
  const [row] = await sql<{ id: string }[]>`
    insert into deliveries (org_id, store_id, kind, delivered_on, proof_file_id, supplier_id, created_by)
    values (${f.orgId}, ${f.storeId}, ${kind}, ${deliveredOn}, ${file!.id}, ${supplierId ?? null}, ${f.adminId})
    returning id`;
  return row!.id;
}

async function activeFixedAsset(f: RolesFixture): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into fixed_assets (org_id, store_id, name, category, acquired_on, cost,
                              useful_life_months, salvage_value, status, created_by)
    values (${f.orgId}, ${f.storeId}, 'Chiller', 'equipment', '2026-01-01', 50000, 60, 0, 'active', ${f.adminId})
    returning id`;
  return row!.id;
}

const create = (
  actorArg: Actor,
  input: { startsOn: string; endsOn: string; reason: string },
) => withOrgPrincipal(actorArg.orgId, (tx) => createMissingClosedPeriod(tx, actorArg, input));

/** R1.1's SECOND path to "the calendar year is closed": a posted `year_close` journal entry dated
 *  `(year+1)-01-01`, with NO period anywhere actually `closed`/`locked` — mirrors
 *  `t344-fiscal-period-holes.test.ts`'s H11b technique. Used so a fixture can make one year "closed"
 *  without ever writing a `closed`/`locked` row, which would otherwise conflict with an EARLIER
 *  period left deliberately `open` under the post-0160 order guard (R1.2: no open period may start
 *  before a closed/locked one, anywhere in the org). Requires a period covering `(year+1)-01-01` to
 *  already exist (the entry's `period_id` FK). */
async function postYearCloseEntry(f: RolesFixture, year: number): Promise<void> {
  const [period] = await sql<{ id: string }[]>`
    select id from fiscal_periods where org_id = ${f.orgId} and starts_on = ${`${year + 1}-01-01`}`;
  const accts = await sql<{ id: string; code: string }[]>`
    select id, code from accounts where org_id = ${f.orgId} and code in ('6300', '1110')`;
  const acctId = (code: string) => accts.find((a) => a.code === code)!.id;
  await sql.begin(async (tx) => {
    const [entry] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, idempotency_key, memo, posted_by, status)
      values (${f.orgId}, ${`${year + 1}-01-01`}, ${period!.id}, 'year_close', ${`${f.orgId}:${year}`}, ${uid('yc-key')}, 'fixture year close', ${f.adminId}, 'draft')
      returning id`;
    await tx`
      insert into journal_lines (entry_id, line_no, account_id, debit, credit)
      values
        (${entry!.id}, 1, ${acctId('6300')}, 500.00, 0),
        (${entry!.id}, 2, ${acctId('1110')}, 0, 500.00)`;
    await tx`update journal_entries set status = 'posted', posted_at = now() where id = ${entry!.id}`;
  });
}

describe('F1-F3 — the happy path, by role', () => {
  it('F1 — admin fills April as closed, trimmed reason, closed_by = created_by = admin', async () => {
    const f = await h3Shape('f1');
    const result = await create(f.admin, { startsOn: '2026-04-01', endsOn: '2026-04-30', reason: '  late setup  ' });
    expect(result.status).toBe('closed');

    const row = await periodStatus(f.orgId, '2026-04-01');
    expect(row?.status).toBe('closed');
    expect(row?.closed_by).toBe(f.adminId);
    expect(row?.created_by).toBe(f.adminId);
    expect(row?.fill_reason).toBe('late setup');

    await expect(
      withOrgPrincipal(f.orgId, (tx) =>
        postEntry(tx, {
          orgId: f.orgId,
          entryDate: '2026-04-15',
          sourceType: 'test',
          sourceId: uid('f1'),
          idempotencyKey: uid('f1-key'),
          lines: [
            { accountCode: '6300', debit: '10.00' },
            { accountCode: '1110', credit: '10.00' },
          ],
        }),
      ),
    ).rejects.toThrow(/fiscal period .* is closed/);

    // NEGATIVE — no other row changed.
    const others = (await periodsFor(f.orgId)).filter((p) => p.starts_on !== '2026-04-01');
    expect(others.every((p) => p.status === 'closed' || p.status === 'open')).toBe(true);
  });

  it('F2 — H5 shape, admin: the missing 2025-06 is created LOCKED (its year is closed), still refused', async () => {
    const f = await h5Shape('f2');
    const result = await create(f.admin, { startsOn: '2025-06-01', endsOn: '2025-06-30', reason: 'backfill' });
    expect(result.status).toBe('locked');
    const row = await periodStatus(f.orgId, '2025-06-01');
    expect(row?.status).toBe('locked');
    expect(row?.status).not.toBe('closed');
  });

  it('F3 — super_admin resolves', async () => {
    const f = await h3Shape('f3');
    const result = await create(f.superAdmin, { startsOn: '2026-04-01', endsOn: '2026-04-30', reason: 'super admin fill' });
    expect(result.status).toBe('closed');
  });
});

describe('F4-F5 — only admin and super_admin hold create_missing_period', () => {
  it('F4 — a manager holding close_period with org-wide scope may not', async () => {
    const f = await h3Shape('f4');
    await expect(create(f.manager, { startsOn: '2026-04-01', endsOn: '2026-04-30', reason: 'x' })).rejects.toThrow(
      /may not 'create_missing_period'/,
    );
    expect(await periodStatus(f.orgId, '2026-04-01')).toBeUndefined();
  });

  it('F5 — staff may not', async () => {
    const f = await h3Shape('f5');
    await expect(create(f.staff, { startsOn: '2026-04-01', endsOn: '2026-04-30', reason: 'x' })).rejects.toThrow(
      /may not 'create_missing_period'/,
    );
    expect(await periodStatus(f.orgId, '2026-04-01')).toBeUndefined();
  });
});

describe('F6 — a range that already has a period is refused', () => {
  it('2026-03-01..03-31 is already covered', async () => {
    const f = await h3Shape('f6');
    await expect(create(f.admin, { startsOn: '2026-03-01', endsOn: '2026-03-31', reason: 'x' })).rejects.toThrow(
      /is not missing — the period 2026-03-01 to 2026-03-31 covers it/,
    );
    expect(await periodCount(f.orgId)).toBe((await periodsFor(f.orgId)).length);
  });
});

describe('F7-F7b — Q4: the action fills exactly the missing piece of a month', () => {
  it('F7 — the WHOLE missing piece, 2026-05-21..05-31, is created closed; a rerun has no C line', async () => {
    const f = await h7Shape('f7');
    const result = await create(f.admin, { startsOn: '2026-05-21', endsOn: '2026-05-31', reason: 'partial fill' });
    expect(result.status).toBe('closed');
    expect(result.startsOn).toBe('2026-05-21');
    expect(result.endsOn).toBe('2026-05-31');
  });

  it('F7 negative — a range that leaves part of the month still missing is refused', async () => {
    const f = await h7Shape('f7-partial');
    await expect(create(f.admin, { startsOn: '2026-05-21', endsOn: '2026-05-25', reason: 'x' })).rejects.toThrow(
      /would leave 2026-05-26\.\.2026-05-31 of 2026-05 still missing/,
    );
    expect(await periodStatus(f.orgId, '2026-05-21')).toBeUndefined();
  });

  it('F7 negative — a range spanning two months is refused', async () => {
    const f = await h7Shape('f7-span');
    await expect(create(f.admin, { startsOn: '2026-05-21', endsOn: '2026-06-02', reason: 'x' })).rejects.toThrow(
      /spans more than one month/,
    );
  });

  it('F7b — the missing part of a LOCKED year is created locked', async () => {
    const f = await rolesFixture('f7b');
    await insertPeriod(f.orgId, '2025-06-01', '2025-06-15', { status: 'locked', closedAt: '2025-07-01T00:00:00Z', closedBy: f.adminId });
    await insertMonths(f.orgId, 2026, 1, 2027, 8);
    const result = await create(f.admin, { startsOn: '2025-06-16', endsOn: '2025-06-30', reason: 'partial locked fill' });
    expect(result.status).toBe('locked');
    expect(result.status).not.toBe('closed');
  });
});

describe('F8 — the action never fills class A (open books) or class D (part-month, open books)', () => {
  it('a whole open month and an open part-month are both refused', async () => {
    const f = await rolesFixture('f8');
    await insertMonths(f.orgId, 2026, 1, 2026, 5);
    await insertMonths(f.orgId, 2026, 9, 2027, 7);
    await expect(create(f.admin, { startsOn: '2026-07-01', endsOn: '2026-07-31', reason: 'x' })).rejects.toThrow(
      /not inside closed books/,
    );
    // 0174: an open period must be a whole month, so the part-month piece is closed; closed-after-open
    // is legacy state (R1.2), built under replica as the cutover ETL does. Only this raw insert.
    await sql.begin(async (tx) => {
      await tx`set local session_replication_role = 'replica'`;
      await tx`
        insert into fiscal_periods (org_id, starts_on, ends_on, status)
        values (${f.orgId}, '2027-08-01', '2027-08-15', 'closed')`;
    });

    await expect(create(f.admin, { startsOn: '2027-08-16', endsOn: '2027-08-31', reason: 'x' })).rejects.toThrow(
      /not inside closed books/,
    );
    expect(await periodStatus(f.orgId, '2026-07-01')).toBeUndefined();
    expect(await periodStatus(f.orgId, '2027-08-16')).toBeUndefined();
  });
});

describe('F9 — a blank reason is refused', () => {
  it('whitespace-only reason', async () => {
    const f = await h3Shape('f9');
    await expect(create(f.admin, { startsOn: '2026-04-01', endsOn: '2026-04-30', reason: '   ' })).rejects.toThrow(
      /reason is required/,
    );
    expect(await periodStatus(f.orgId, '2026-04-01')).toBeUndefined();
  });
});

describe('F10-F10b — Q3: activity in the hole refuses the action, in human terms, never an id', () => {
  it('F10 — a draft expense in the hole refuses; re-dating it into the open month lets the fill through', async () => {
    const f = await h3Shape('f10');
    const { invoiceId } = await aSupplierInvoice(f, 'Acme Supplies');
    const expenseId = await draftExpenseDated(f, '2026-04-10', invoiceId);

    await expect(create(f.admin, { startsOn: '2026-04-01', endsOn: '2026-04-30', reason: 'x' })).rejects.toThrow(
      /draft expense dated 2026-04-10.*Acme Supplies.*prior-period adjustment/s,
    );
    expect(await periodStatus(f.orgId, '2026-04-01')).toBeUndefined();

    await sql`update expenses set business_date = '2026-09-15' where id = ${expenseId}`;
    const result = await create(f.admin, { startsOn: '2026-04-01', endsOn: '2026-04-30', reason: 'x' });
    expect(result.status).toBe('closed');
  });

  it('F10b — a draft in a part-month hole (F7 shape) refuses and lists it', async () => {
    const f = await h7Shape('f10b');
    const { invoiceId } = await aSupplierInvoice(f, 'Beta Traders');
    await draftExpenseDated(f, '2026-05-25', invoiceId);

    await expect(create(f.admin, { startsOn: '2026-05-21', endsOn: '2026-05-31', reason: 'x' })).rejects.toThrow(
      /draft expense dated 2026-05-25.*Beta Traders/s,
    );
    expect(await periodStatus(f.orgId, '2026-05-21')).toBeUndefined();
  });
});

describe('F11 — an earlier open period refuses the action, same as closePeriod', () => {
  it('2026-02 open; 2026 closed via a posted year_close entry (R1.1), no period anywhere closed/locked; 2026-04 missing', async () => {
    // Reshaped post-0160 (orchestrator CHANGES, 2026-09-25): the original fixture ('03 closed,
    // 05 closed' around the Feb-open/April-missing shape) put an OPEN period (Feb) chronologically
    // BEFORE a CLOSED one (March) AT REST — exactly the shape R1.2's order guard now refuses
    // globally, in both directions, so the fixture's own setup inserts would be rejected before the
    // real assertion ever ran. Using R1.1's SECOND path to "year is closed" (a posted year_close
    // entry) makes April a class-B hole without any row anywhere being closed/locked, so Feb can
    // stay open with nothing to conflict with — the intent (an earlier open period refuses the
    // action) is unchanged; only how "the year is closed" is established changes.
    const f = await rolesFixture('f11');
    await insertMonths(f.orgId, 2026, 2, 2026, 2); // Feb open — the "earlier open period"
    await insertMonths(f.orgId, 2027, 1, 2027, 1); // holds the year_close entry's period_id FK
    await postYearCloseEntry(f, 2026);

    await expect(create(f.admin, { startsOn: '2026-04-01', endsOn: '2026-04-30', reason: 'x' })).rejects.toThrow(
      /earlier period .* still open/,
    );
    expect(await periodStatus(f.orgId, '2026-04-01')).toBeUndefined();
  });
});

describe('F13 — Q3: a hard finding (missed depreciation) refuses the action', () => {
  it('a depreciable asset in service, no depreciation run for 2026-04', async () => {
    const f = await h3Shape('f13');
    await activeFixedAsset(f);

    await expect(create(f.admin, { startsOn: '2026-04-01', endsOn: '2026-04-30', reason: 'x' })).rejects.toThrow(
      /depreciat/i,
    );
    expect(await periodStatus(f.orgId, '2026-04-01')).toBeUndefined();
  });
});

describe('F15 — R1.7: a draft delivery with no supplier names its kind, never an id', () => {
  it('a purchase delivery with no supplier, dated in the hole', async () => {
    const f = await h3Shape('f15');
    await draftDeliveryDated(f, '2026-04-12', 'purchase');

    await expect(create(f.admin, { startsOn: '2026-04-01', endsOn: '2026-04-30', reason: 'x' })).rejects.toThrow(
      /purchase delivery, no supplier/,
    );
    // NEGATIVE — no delivery id leaked into the message. Checked by re-running with the message
    // captured and confirming it never contains a uuid.
    try {
      await create(f.admin, { startsOn: '2026-04-01', endsOn: '2026-04-30', reason: 'x' });
      throw new Error('expected refusal');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    }
  });
});

describe('F14 — R1.5 regression: closePeriod keeps its three existing messages byte-for-byte', () => {
  it('drafts, not-ready and earlier-open messages are unchanged', async () => {
    const f = await rolesFixture('f14');
    await insertMonths(f.orgId, 2026, 1, 2026, 1);
    const { invoiceId } = await aSupplierInvoice(f, 'Gamma Co');
    await draftExpenseDated(f, '2026-01-15', invoiceId);

    await expect(
      withOrgPrincipal(f.orgId, (tx) => closePeriod(tx, f.admin, { period: '2026-01' })),
    ).rejects.toThrow(/cannot close — 1 draft expense still dated in it\. Post or void them first\./);
  });
});

describe('F12 — DB, APP role, raw SQL: audit shape is write-once and DELETE stays allowed', () => {
  it('a filled row can move closed -> locked; a plain row DELETE succeeds', async () => {
    // Reshaped post-builder-fix (orchestrator CHANGES, 2026-09-25): the builder's new locked-year
    // check correctly refuses a locked period coexisting with an OPEN one in the SAME calendar year
    // — h3Shape's own June-2027-08 tail is open, so locking April here (h3Shape's fill target) now
    // conflicts with that, unrelated to what this sub-test is actually about. Dedicated fixture:
    // March AND May 2026 closed (April sits between them as a genuine INTERIOR hole — coverage-hole
    // detection never invents anything before the org's first period, so April needs something
    // earlier too, not just May after it), April missing, and NOTHING ELSE in 2026 at all (no open
    // period anywhere in the year to conflict with the builder's new check).
    const f = await rolesFixture('f12-a');
    await insertMonths(f.orgId, 2026, 3, 2026, 3, { status: 'closed', closedAt: '2026-04-01T00:00:00Z', closedBy: f.adminId });
    await insertMonths(f.orgId, 2026, 5, 2026, 5, { status: 'closed', closedAt: '2026-06-01T00:00:00Z', closedBy: f.adminId });
    await create(f.admin, { startsOn: '2026-04-01', endsOn: '2026-04-30', reason: 'move me' });
    await asOrg(f.orgId, (tx) =>
      tx.execute(dsql`update fiscal_periods set status = 'locked' where org_id = ${f.orgId} and starts_on = '2026-04-01'`),
    );
    expect((await periodStatus(f.orgId, '2026-04-01'))?.status).toBe('locked');

    await asOrg(f.orgId, (tx) =>
      tx.execute(dsql`delete from fiscal_periods where org_id = ${f.orgId} and starts_on = '2026-05-01'`),
    );
    expect(await periodStatus(f.orgId, '2026-05-01')).toBeUndefined();
  });

  it('fill_reason on an INSERT must be non-blank when set (23514)', async () => {
    const f = await rolesFixture('f12-b');
    await expect(
      asOrg(f.orgId, (tx) =>
        tx.execute(
          dsql`insert into fiscal_periods (org_id, starts_on, ends_on, status, closed_at, closed_by, created_by, fill_reason)
               values (${f.orgId}, '2026-01-01', '2026-01-31', 'closed', now(), ${f.adminId}, ${f.adminId}, '  ')`,
        ),
      ),
    ).rejects.toThrow(/fiscal_periods_fill_shape_check/);
  });

  it('fill_reason on an open row is refused (23514)', async () => {
    const f = await rolesFixture('f12-c');
    await expect(
      asOrg(f.orgId, (tx) =>
        tx.execute(
          dsql`insert into fiscal_periods (org_id, starts_on, ends_on, status, created_by, fill_reason)
               values (${f.orgId}, '2026-01-01', '2026-01-31', 'open', ${f.adminId}, 'x')`,
        ),
      ),
    ).rejects.toThrow(/fiscal_periods_fill_shape_check/);
  });

  it('fill_reason/created_by are write-once — NULL to a value on UPDATE is refused', async () => {
    const f = await rolesFixture('f12-d');
    await insertMonths(f.orgId, 2026, 1, 2026, 1, { status: 'closed', closedAt: '2026-02-01T00:00:00Z', closedBy: f.adminId });
    await expect(
      asOrg(f.orgId, (tx) =>
        tx.execute(dsql`update fiscal_periods set fill_reason = 'x' where org_id = ${f.orgId} and starts_on = '2026-01-01'`),
      ),
    ).rejects.toThrow(/a filled period's creator and reason are set only when it is created/);
  });

  it('created_by is write-once — NULL to a value on UPDATE is refused, on a plain closed row', async () => {
    const f = await rolesFixture('f12-e');
    await insertMonths(f.orgId, 2026, 1, 2026, 1, { status: 'closed', closedAt: '2026-02-01T00:00:00Z', closedBy: f.adminId });
    await expect(
      asOrg(f.orgId, (tx) =>
        tx.execute(dsql`update fiscal_periods set created_by = ${f.adminId} where org_id = ${f.orgId} and starts_on = '2026-01-01'`),
      ),
    ).rejects.toThrow(/a filled period's creator and reason are set only when it is created/);
  });

  it('fill_reason/created_by are write-once — changing either on an already-filled row is refused', async () => {
    const f = await h3Shape('f12-f');
    await create(f.admin, { startsOn: '2026-04-01', endsOn: '2026-04-30', reason: 'original' });
    await expect(
      asOrg(f.orgId, (tx) =>
        tx.execute(dsql`update fiscal_periods set fill_reason = 'changed' where org_id = ${f.orgId} and starts_on = '2026-04-01'`),
      ),
    ).rejects.toThrow(/a filled period's creator and reason are set only when it is created/);
  });
});

describe('F16 — the action on a TAIL hole: a closed year with nothing after it, December missing', () => {
  it('2025-01..11 locked; 2025-12 missing; nothing exists past 2025 at all', async () => {
    const f = await rolesFixture('f16');
    await insertMonths(f.orgId, 2025, 1, 2025, 11, { status: 'locked', closedAt: '2025-12-01T00:00:00Z', closedBy: f.adminId });
    // Deliberately nothing in 2026+ — December 2025 is the tail: nothing bounds it from the right.

    await expect(
      create(f.admin, { startsOn: '2025-12-01', endsOn: '2025-12-15', reason: 'partial tail fill' }),
    ).rejects.toThrow(/would leave 2025-12-16\.\.2025-12-31 of 2025-12 still missing/);
    expect(await periodStatus(f.orgId, '2025-12-01')).toBeUndefined();

    const result = await create(f.admin, { startsOn: '2025-12-01', endsOn: '2025-12-31', reason: 'whole tail fill' });
    expect(result.status).toBe('locked');
    const row = await periodStatus(f.orgId, '2025-12-01');
    expect(row?.status).toBe('locked');
  });
});

describe('F17 — two separate holes inside one month, split by an existing closed piece', () => {
  /** 2026-04: 04-01..04-05 missing, 04-06..04-19 CLOSED (existing), 04-20..04-30 missing.
   *  March and May closed on either side so both holes are class C (missing in closed books). */
  async function twoHolesShape(hint: string): Promise<RolesFixture> {
    const f = await rolesFixture(hint);
    await insertMonths(f.orgId, 2026, 3, 2026, 3, { status: 'closed', closedAt: '2026-04-01T00:00:00Z', closedBy: f.adminId });
    await insertPeriod(f.orgId, '2026-04-06', '2026-04-19', { status: 'closed', closedAt: '2026-04-20T00:00:00Z', closedBy: f.adminId });
    await insertMonths(f.orgId, 2026, 5, 2026, 5, { status: 'closed', closedAt: '2026-06-01T00:00:00Z', closedBy: f.adminId });
    await insertMonths(f.orgId, 2026, 6, 2027, 8);
    return f;
  }

  it('a request for exactly the second hole (04-20..04-30) succeeds', async () => {
    const f = await twoHolesShape('f17-second');
    const result = await create(f.admin, { startsOn: '2026-04-20', endsOn: '2026-04-30', reason: 'second hole' });
    expect(result.status).toBe('closed');
    expect(result.startsOn).toBe('2026-04-20');
    expect(result.endsOn).toBe('2026-04-30');
    // NEGATIVE — the first hole (04-01..04-05) is untouched.
    expect(await periodStatus(f.orgId, '2026-04-01')).toBeUndefined();
  });

  it('a request spanning both holes (04-01..04-30) refuses — it overlaps the existing middle piece', async () => {
    const f = await twoHolesShape('f17-span');
    await expect(
      create(f.admin, { startsOn: '2026-04-01', endsOn: '2026-04-30', reason: 'spans both' }),
    ).rejects.toThrow(/is not missing — the period 2026-04-06 to 2026-04-19 covers it/);
    // NEGATIVE — neither hole was created.
    expect(await periodStatus(f.orgId, '2026-04-01')).toBeUndefined();
    expect(await periodStatus(f.orgId, '2026-04-20')).toBeUndefined();
  });
});

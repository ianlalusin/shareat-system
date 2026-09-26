import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-346 S1 — a store's opening date (DEF-428). `docs/tasks/346-store-opening-and-in-service-date.md`
 * §4 (cases O), Amendment R1 item 3 (the "has traded" definition), Amendment R2 items 1-3 (binding).
 *
 * ⛔ RED until the builder lands `stores.opening_date` (migration 0162), `CreateStoreInput.openingDate`,
 * `setStoreOpeningDate` and `storeReadiness`'s new `openingDate` check (`packages/domain/src/stores/service.ts`).
 * `setStoreOpeningDate` is imported from `@shareat/domain` even though it does not exist yet — same
 * posture as T-345's own `bookMissedMonth`: TS2305 at typecheck, `undefined` at runtime, so calling
 * it throws `TypeError: ... is not a function`.
 *
 * "Has traded" (R1.3, shared by O3 and M1's backfill): `least(min(business_date) of non-voided
 * sales_days, min(entry_date) of posted journal_entries with source_type='sale' and a line at the
 * store)`. A construction-period expense or a voided sales day is NOT trading.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, transaction, withOrgPrincipal, APP_ROLE, type Tx } from '@shareat/db';
import { type Actor } from '@shareat/auth';
import {
  createStore,
  storeReadiness,
  // ⛔ Not yet exported by `@shareat/domain` — TS2305 at typecheck, `undefined` at runtime (esbuild
  // strips types), so calling it throws `TypeError: ... is not a function` — same posture as
  // T-345's own `bookMissedMonth`.
  setStoreOpeningDate,
} from '@shareat/domain';
import * as storesRepo from '../../../db/src/repo/stores';

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

interface OrgFixture {
  orgId: string;
  adminId: string;
  admin: Actor;
  superAdmin: Actor;
  manager: Actor;
  staff: Actor;
}

/** One org, four people — no store yet (O1 creates its own; other cases create one each so a
 *  "has traded" fixture never leaks into another case). */
async function rolesFixture(hint: string): Promise<OrgFixture> {
  const code = uid(`t346-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
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
  return {
    orgId,
    adminId,
    admin: actor(orgId, adminId),
    superAdmin: actor(orgId, superAdminId),
    manager: actor(orgId, managerId),
    staff: actor(orgId, staffId),
  };
}

async function makeStore(f: OrgFixture, over: Record<string, unknown> = {}): Promise<string> {
  const result = await withOrgPrincipal(f.orgId, (tx) =>
    createStore(tx, f.admin, { code: uid('S'), name: 'Store', ...over } as Parameters<typeof createStore>[2]),
  );
  return result.storeId;
}

async function openingDateColumn(storeId: string): Promise<string | null> {
  const rows = await sql<{ opening_date: string | null }[]>`
    select opening_date::text as opening_date from stores where id = ${storeId}`;
  return rows[0]?.opening_date ?? null;
}

/** A real, non-voided sales day — the simplest "has traded" fixture, real column shape. */
async function realSalesDay(f: OrgFixture, storeId: string, businessDate: string): Promise<void> {
  await sql`
    insert into sales_days (org_id, store_id, business_date, status, total_sales, unli_sales, ala_carte_sales, created_by)
    values (${f.orgId}, ${storeId}, ${businessDate}, 'open', '0', '0', '0', ${f.adminId})`;
}
async function voidedSalesDay(f: OrgFixture, storeId: string, businessDate: string): Promise<void> {
  await sql`
    insert into sales_days (org_id, store_id, business_date, status, total_sales, unli_sales, ala_carte_sales, created_by, voided_by, voided_at, void_reason)
    values (${f.orgId}, ${storeId}, ${businessDate}, 'voided', '0', '0', '0', ${f.adminId}, ${f.adminId}, now(), 'fixture')`;
}

/** A posted journal entry at the store, any `sourceType` — used both for a genuine sale posting
 *  and for a NON-trading construction-period expense (R1.3: only `source_type='sale'` counts). */
async function postRawEntryAt(
  f: OrgFixture,
  storeId: string,
  entryDate: string,
  sourceType: string,
  debitCode: string,
  creditCode: string,
): Promise<void> {
  const accts = await sql<{ id: string; code: string }[]>`
    select id, code from accounts where org_id = ${f.orgId} and code in (${debitCode}, ${creditCode})`;
  const acctId = (code: string) => accts.find((a) => a.code === code)!.id;
  const [period] = await sql<{ id: string }[]>`select id from fiscal_periods where org_id = ${f.orgId} and starts_on <= ${entryDate} and ends_on >= ${entryDate}`;
  await sql.begin(async (tx) => {
    const [entry] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, idempotency_key, memo, posted_by, status)
      values (${f.orgId}, ${entryDate}, ${period?.id ?? null}, ${sourceType}, ${uid('src')}, ${uid('key')}, 'fixture', ${f.adminId}, 'draft')
      returning id`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, debit, credit, store_id) values (${entry!.id}, 1, ${acctId(debitCode)}, '100.00', 0, ${storeId})`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, debit, credit, store_id) values (${entry!.id}, 2, ${acctId(creditCode)}, 0, '100.00', ${storeId})`;
    await tx`update journal_entries set status = 'posted', posted_at = now() where id = ${entry!.id}`;
  });
}

async function ensureOpenPeriod(orgId: string, aroundDate: string): Promise<void> {
  const [y, m] = aroundDate.split('-').map(Number) as [number, number];
  const starts = `${y}-${String(m).padStart(2, '0')}-01`;
  const ends = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  await sql`
    insert into fiscal_periods (org_id, starts_on, ends_on, status)
    select ${orgId}, ${starts}, ${ends}, 'open'
    where not exists (select 1 from fiscal_periods where org_id = ${orgId} and starts_on = ${starts})`;
}

const setOpening = (
  actorArg: Actor,
  storeId: string,
  input: { openingDate: string | null; confirmReversal?: boolean },
) => withOrgPrincipal(actorArg.orgId, (tx) => setStoreOpeningDate(tx, actorArg, storeId, input));

// =================================================================================================
// O1 — S1: createStore with and without openingDate
// =================================================================================================

describe('O1 — createStore stores the opening date, or leaves it NULL', () => {
  it('a date is passed through to the column', async () => {
    const f = await rolesFixture('o1-date');
    const storeId = await makeStore(f, { openingDate: '2026-03-01' });
    expect(await openingDateColumn(storeId)).toBe('2026-03-01');
  });

  it('omitted — the column is NULL', async () => {
    const f = await rolesFixture('o1-null');
    const storeId = await makeStore(f);
    expect(await openingDateColumn(storeId)).toBeNull();
  });
});

// =================================================================================================
// O2 — S1: setStoreOpeningDate — admin and super_admin resolve; manager (even with
// manage_store_settings) and staff do not
// =================================================================================================

describe('O2 — only manage_stores (org, admin and up) may set a store\'s opening date', () => {
  it('admin resolves', async () => {
    const f = await rolesFixture('o2-admin');
    const storeId = await makeStore(f);
    await setOpening(f.admin, storeId, { openingDate: '2026-05-01' });
    expect(await openingDateColumn(storeId)).toBe('2026-05-01');
  });

  it('super_admin resolves', async () => {
    const f = await rolesFixture('o2-sa');
    const storeId = await makeStore(f);
    await setOpening(f.superAdmin, storeId, { openingDate: '2026-05-01' });
    expect(await openingDateColumn(storeId)).toBe('2026-05-01');
  });

  it('a manager holding manage_store_settings AT THE STORE may not — that capability is not manage_stores', async () => {
    const f = await rolesFixture('o2-manager');
    const storeId = await makeStore(f);
    // `person_grants_store_shape_check`: store_id is NOT NULL only for grant_source='position' —
    // an ordinary hand-grant is org-wide-shaped in the row itself; the store SCOPE that limits
    // which store the manager can act at lives in `person_store_scope`, a separate mechanism.
    await sql`insert into person_grants (person_id, grant_name, granted_by, grant_source)
      values (${f.manager.personId}, 'manage_store_settings', ${f.adminId}, 'grant')`;
    await sql`insert into person_store_scope (person_id, store_id) values (${f.manager.personId}, ${storeId})
      on conflict do nothing`;
    await expect(setOpening(f.manager, storeId, { openingDate: '2026-05-01' })).rejects.toThrow(
      /may not 'manage_stores'/,
    );
    expect(await openingDateColumn(storeId)).toBeNull();
  });

  it('staff may not', async () => {
    const f = await rolesFixture('o2-staff');
    const storeId = await makeStore(f);
    await expect(setOpening(f.staff, storeId, { openingDate: '2026-05-01' })).rejects.toThrow(
      /may not 'manage_stores'/,
    );
  });
});

// =================================================================================================
// O3 — S1: "has traded" (R1.3) caps the opening date at the first trading date (R3.6, replaces
// R2.1's narrower "cleared or moved into the future" wording — a PAST date later than first
// trading is refused too, not just NULL or a future one).
// =================================================================================================

describe('O3 — a store that has traded may only have its opening date moved to on-or-before first trade', () => {
  it('⛔ a real (non-voided) sales day blocks clearing to NULL', async () => {
    const f = await rolesFixture('o3-clear');
    const storeId = await makeStore(f, { openingDate: '2026-01-01' });
    await realSalesDay(f, storeId, '2026-02-10');
    await expect(setOpening(f.admin, storeId, { openingDate: null })).rejects.toThrow(
      /has traded since 2026-02-10; its opening date must be on or before that/,
    );
    expect(await openingDateColumn(storeId)).toBe('2026-01-01');
  });

  it('⛔ a future date is refused', async () => {
    const f = await rolesFixture('o3-future');
    const storeId = await makeStore(f, { openingDate: '2026-01-01' });
    await realSalesDay(f, storeId, '2026-02-10');
    await expect(setOpening(f.admin, storeId, { openingDate: '2099-01-01' })).rejects.toThrow(
      /has traded since 2026-02-10; its opening date must be on or before that/,
    );
    expect(await openingDateColumn(storeId)).toBe('2026-01-01');
  });

  it('⛔ R3.6: a PAST date, but LATER than first trading, is refused too', async () => {
    const f = await rolesFixture('o3-past-later');
    const storeId = await makeStore(f, { openingDate: '2026-01-01' });
    await realSalesDay(f, storeId, '2026-02-10');
    // '2026-02-15' is before "today" (2026-09-26) but after the store's own first trading date —
    // R2.1's old rule ("not null, not future") would have accepted this; R3.6 refuses it.
    await expect(setOpening(f.admin, storeId, { openingDate: '2026-02-15' })).rejects.toThrow(
      /has traded since 2026-02-10; its opening date must be on or before that/,
    );
    expect(await openingDateColumn(storeId)).toBe('2026-01-01');
  });

  it('R3.6: a date ON first trading is accepted', async () => {
    const f = await rolesFixture('o3-on-first-trade');
    const storeId = await makeStore(f, { openingDate: '2026-01-01' });
    await realSalesDay(f, storeId, '2026-02-10');
    await setOpening(f.admin, storeId, { openingDate: '2026-02-10' });
    expect(await openingDateColumn(storeId)).toBe('2026-02-10');
  });

  it('R3.6: a date BEFORE first trading is accepted', async () => {
    const f = await rolesFixture('o3-before-first-trade');
    const storeId = await makeStore(f, { openingDate: '2026-01-01' });
    await realSalesDay(f, storeId, '2026-02-10');
    await setOpening(f.admin, storeId, { openingDate: '2026-01-05' });
    expect(await openingDateColumn(storeId)).toBe('2026-01-05');
  });

  it('a voided sales day is NOT trading — clearing succeeds', async () => {
    const f = await rolesFixture('o3-voided');
    const storeId = await makeStore(f, { openingDate: '2026-01-01' });
    await voidedSalesDay(f, storeId, '2026-02-10');
    await setOpening(f.admin, storeId, { openingDate: null });
    expect(await openingDateColumn(storeId)).toBeNull();
  });

  it('a construction-period expense (non-sale posted entry) is NOT trading — future-dating succeeds', async () => {
    const f = await rolesFixture('o3-expense');
    const storeId = await makeStore(f, { openingDate: '2026-01-01' });
    await ensureOpenPeriod(f.orgId, '2026-02-15');
    await postRawEntryAt(f, storeId, '2026-02-15', 'expense', '6200', '1110');
    await setOpening(f.admin, storeId, { openingDate: '2027-01-01' });
    expect(await openingDateColumn(storeId)).toBe('2027-01-01');
  });

  it('a posted sale-sourced entry (no sales_days row at all) counts as trading too', async () => {
    const f = await rolesFixture('o3-sale-entry');
    const storeId = await makeStore(f, { openingDate: '2026-01-01' });
    await ensureOpenPeriod(f.orgId, '2026-02-20');
    await postRawEntryAt(f, storeId, '2026-02-20', 'sale', '1110', '4100');
    await expect(setOpening(f.admin, storeId, { openingDate: null })).rejects.toThrow(
      /has traded since 2026-02-20; its opening date must be on or before that/,
    );
  });
});

// =================================================================================================
// O5 — S1: R3.1 — the opening date is validated as a real YYYY-MM-DD date server-side, before any
// comparison ('01/01/2099' and '2026-3-1' were mis-compared as strings). Domain fn called directly
// — this is server-side validation, not the HTML `<input type="date">`'s own client format.
// =================================================================================================

/**
 * A bare `.rejects.toThrow()` would pass just as well on Postgres's own raw parse error
 * ("invalid input syntax for type date") if `setStoreOpeningDate` forwarded a malformed string to
 * a column comparison unvalidated — R3.1's whole point is that this is caught and reworded BEFORE
 * that ever happens. Asserts both a human-readable message AND the absence of the raw DB wording,
 * so the two failure modes can never look alike from this test's own perspective.
 */
async function expectHumanDateRefusal(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toThrow(/date/i);
  await expect(promise).rejects.not.toThrow(/invalid input syntax|date\/time field value out of range/i);
}

describe('O5 — R3.1: a malformed date string is refused with a human message, nothing written', () => {
  it('⛔ "01/01/2099" (wrong separator/order)', async () => {
    const f = await rolesFixture('o5-slash');
    const storeId = await makeStore(f);
    await expectHumanDateRefusal(setOpening(f.admin, storeId, { openingDate: '01/01/2099' }));
    expect(await openingDateColumn(storeId)).toBeNull();
  });

  it('⛔ "2026-3-1" (unpadded month/day)', async () => {
    const f = await rolesFixture('o5-unpadded');
    const storeId = await makeStore(f);
    await expectHumanDateRefusal(setOpening(f.admin, storeId, { openingDate: '2026-3-1' }));
    expect(await openingDateColumn(storeId)).toBeNull();
  });

  it('⛔ createStore itself with a malformed openingDate — nothing written, ONE transaction', async () => {
    const f = await rolesFixture('o5-createstore');
    const code = uid('S');
    await expectHumanDateRefusal(
      withOrgPrincipal(f.orgId, (tx) =>
        createStore(tx, f.admin, { code, name: 'Bad Date Store', openingDate: '01/01/2099' } as Parameters<
          typeof createStore
        >[2]),
      ),
    );
    const [row] = await sql<{ c: number }[]>`select count(*)::int as c from stores where org_id = ${f.orgId} and code = ${code}`;
    expect(row!.c).toBe(0);
  });
});

// =================================================================================================
// O4 — S1: storeReadiness gains a non-blocking `openingDate` check, three details (R2.2)
// =================================================================================================

describe('O4 — storeReadiness: openingDate is manual and non-blocking, three exact detail strings (R2.2)', () => {
  async function readinessFor(f: OrgFixture, storeId: string) {
    const store = await asOrg(f.orgId, (tx) => storesRepo.getById(tx, f.orgId, storeId));
    return withOrgPrincipal(f.orgId, (tx) => storeReadiness(tx, f.admin, store!));
  }
  function openingCheck(checks: Awaited<ReturnType<typeof readinessFor>>) {
    return checks.find((c) => c.key === 'openingDate');
  }

  it('no date set — "Not yet open — no opening date set", non-blocking', async () => {
    const f = await rolesFixture('o4-null');
    const storeId = await makeStore(f);
    const check = openingCheck(await readinessFor(f, storeId));
    expect(check?.blocking).toBe(false);
    expect(check?.kind).toBe('manual');
    expect(check?.detail).toBe('Not yet open — no opening date set');
  });

  it('a future date — "Opens {date}"', async () => {
    const f = await rolesFixture('o4-future');
    const storeId = await makeStore(f);
    await sql`update stores set opening_date = '2099-01-01' where id = ${storeId}`;
    const check = openingCheck(await readinessFor(f, storeId));
    expect(check?.blocking).toBe(false);
    expect(check?.detail).toBe('Opens 2099-01-01');
  });

  it('a past date — "Opened {date}"', async () => {
    const f = await rolesFixture('o4-past');
    const storeId = await makeStore(f);
    await sql`update stores set opening_date = '2020-01-01' where id = ${storeId}`;
    const check = openingCheck(await readinessFor(f, storeId));
    expect(check?.blocking).toBe(false);
    expect(check?.detail).toBe('Opened 2020-01-01');
  });
});

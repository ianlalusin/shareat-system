/**
 * T-435 (TESTER) - the shared fixture and page harness for the personal-data access gates.
 * Spec: docs/tasks/435-personal-data-access-gates.md ("Fixture (shared)" and the cases). Bible row 353.
 *
 * ONE org per test file (built lazily by `world()`), raw SQL for everything that is not the subject:
 *
 *   Stores   S1 "Alpha Lipa Branch", S2 "Bravo Tanauan Branch", S3 "Charlie Closed Branch" (RETIRED, is_active = false)
 *   People   A   admin, scope rows for S1 + S2 + S3
 *            P1  admin, scope row for S1 ONLY ("another store's payroll admin" and "an admin missing a scope row")
 *            M1  manager at S1 only          M2  manager at S2 only
 *            T1  holds ONLY manage_attendance at S1 (a position grant on a staff role)
 *            C   cashier at S1 (staff role, an employment, NO position grant of anything the gates look at)
 *   Staff    E1 (S1, rate 650)   E2 (S2, rate 720, phone set)   E3 (S3, resigned, on the separations worklist)
 *            F1 works BOTH S1 and S2 (the "other branch" warning)   Q: employed only at S2   U: no employment at all
 *            a posted pay run + payslip at S1 (E1) and at S2 (E2); a 13th-month run at S2 (E2)
 *   Customers X (charges only at S2)   Y (owes 1,000.00 at S1 and 9,500.00 at S2, limit 10,000.00, phone set)   Z (no AR rows)
 *            Y at S2: a 10,277.00 charge less a 777.00 collection (with a receipt photo) = 9,500.00
 *   Trade    a draft sale order for Y at S1, one for X at S2
 *
 * Names, references and amounts are chosen so that no value of one store is a substring of another's.
 * The marker values are exported in `M` so every test asserts on the same strings.
 *
 * HARNESS: pages are rendered with `renderToStaticMarkup` (the same way t401-s4-common does), the session mock is pointed at
 * `session.actor`, and `nextNavigationMock` makes `notFound()` throw 'NEXT_NOT_FOUND'. Test files own their own `vi.mock`s:
 *
 *   vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
 *   vi.mock('next/navigation', async () => (await import('../helpers/flash-jar-core')).nextNavigationMock());
 *   vi.mock('../../src/lib/session', async () => (await import('./t435-fixture')).sessionMock());
 *   vi.mock('@/components/shell/Page', () => ({ Page: ({ children }: { children: unknown }) => children }));
 */
import { config } from 'dotenv';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect } from 'vitest';

import { transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor, Capability } from '@shareat/auth';
import { recordCharge, recordCollection } from '@shareat/domain';
import { seedChartOfAccounts } from '../../../../packages/db/seed/chart-of-accounts';
import { grantEverydayPositionAccess } from '../../../../packages/domain/tests/integration/_fixtures/staff-everyday-access';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

export const sql = postgres(url, { max: 5 });
let seq = 0;
export const uid = (p: string) => `${p}-${Date.now()}-${++seq}-${Math.random().toString(36).slice(2, 6)}`;

/** The strings every test looks for (or looks to be absent). */
export const M = {
  s1Name: 'Alpha Lipa Branch',
  s2Name: 'Bravo Tanauan Branch',
  s3Name: 'Charlie Closed Branch',
  e1Name: 'Esperanza Alphaone',
  e2Name: 'Ernesto Bravotwo',
  e3Name: 'Eduardo Charliethree',
  f1Name: 'Fernanda Bothbranches',
  qName: 'Quintin Bravoonly',
  uName: 'Ulysses Nojobyet',
  e1Rate: '650.00',
  e2Rate: '720.00',
  e2Phone: '0917-555-0222',
  xName: 'Xavier Tradingco',
  yName: 'Yolanda Foodsco',
  zName: 'Zeta Cateringco',
  xPhone: '0917-111-0001',
  yPhone: '0917-222-0002',
  yS1Ref: 'YS1INVREF',
  yS2Ref: 'YS2INVREF',
  yS2ColRef: 'YS2COLREF',
  xRef: 'XS2INVREF',
  owesS1: '1,000.00',
  owesS2: '9,500.00',
  owesAll: '10,500.00',
  limit: '10,000.00',
  s2Charge: '10,277.00',
  refusedCard: 'You do not have access to this screen',
  notAvailable: 'This store is not available to you.',
} as const;

export interface World {
  orgId: string;
  s1: string;
  s2: string;
  s3: string;
  A: Actor;
  P1: Actor;
  M1: Actor;
  M2: Actor;
  T1: Actor;
  C: Actor;
  /** an admin with ZERO scope rows: holds run_payroll / record_ar_collection / enrol_staff, no store */
  G: Actor;
  /** holds enrol_staff at S1 (a position grant) and NOT manage_attendance */
  H1: Actor;
  /** staff holding ONLY create_wholesale_order at S1 */
  W1: Actor;
  /** staff holding ONLY view_financial_reports at S1 (no record_ar_collection) */
  V1: Actor;
  /** employments */
  e1Emp: string;
  e2Emp: string;
  e3Emp: string;
  /** F1's two employments (S1 / S2) and person */
  f1EmpS1: string;
  f1EmpS2: string;
  qEmp: string;
  /** pay runs and 13th-month run (S1 / S2) */
  runS1: string;
  runS2: string;
  thirteenthS2: string;
  /** customers */
  x: string;
  y: string;
  z: string;
  receiptFileId: string;
  orderYS1: string;
  orderXS2: string;
}

export const session = { actor: null as Actor | null };

export function sessionMock() {
  return {
    requireActor: async () => session.actor,
    requireSession: async () => ({
      actor: session.actor,
      sessionId: 'session-1',
      credentialKind: 'pin' as const,
      storeId: null,
      expiresAt: new Date('2099-01-01'),
    }),
  };
}

export async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

/** Text as a person reads it. */
export const plain = (html: string): string =>
  html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();

let cached: Promise<World> | null = null;
/** Builds the shared org once per test file (module state is per file in vitest). */
export function world(): Promise<World> {
  cached ??= buildWorld();
  return cached;
}

async function buildWorld(): Promise<World> {
  const code = uid('t435');
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open')`;

  const mkStore = async (name: string) => {
    const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('ST')}, ${name}) returning id`;
    return s!.id;
  };
  const s1 = await mkStore(M.s1Name);
  const s2 = await mkStore(M.s2Name);
  const s3 = await mkStore(M.s3Name);

  const mkPerson = async (name: string, role: string | null, stores: string[]) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    if (role) await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    for (const s of stores) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s})`;
    return p!.id;
  };
  const actorOf = (id: string): Actor => ({ personId: id, orgId });

  const aId = await mkPerson('Adrian Administrator', 'admin', [s1, s2, s3]);
  const p1Id = await mkPerson('Priscila Onestoreadmin', 'admin', [s1]);
  const m1Id = await mkPerson('Marco Managerone', 'manager', [s1]);
  const m2Id = await mkPerson('Mirasol Managertwo', 'manager', [s2]);
  const t1Id = await mkPerson('Tomas Attendanceonly', 'staff', [s1]);
  const cId = await mkPerson('Carla Cashierone', 'staff', [s1]);
  const gId = await mkPerson('Gideon Nostores', 'admin', []);
  const h1Id = await mkPerson('Hector Enrolonly', 'staff', [s1]);
  const w1Id = await mkPerson('Wilma Wholesaleonly', 'staff', [s1]);
  const v1Id = await mkPerson('Victor Reportsonly', 'staff', [s1]);

  const mkEmployment = async (personId: string, storeId: string, o: { status?: string; endedOn?: string | null; caps?: readonly Capability[] | null } = {}) => {
    const status = o.status ?? 'regular';
    const [e] = await sql<{ id: string }[]>`
      insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on, ended_on, created_by)
      values (${orgId}, ${storeId}, ${personId}, ${uid('SE')}, ${status}, '2025-01-01', ${o.endedOn ?? null}, ${aId}) returning id`;
    if (o.caps !== null && !o.endedOn) {
      await grantEverydayPositionAccess(sql, {
        orgId, storeId, employmentId: e!.id, personId, setBy: aId,
        capabilities: (o.caps ?? []) as readonly Capability[],
      });
    }
    return e!.id;
  };

  // C: a cashier - an employment with NO position grant (a refusal test: nothing grants what is denied).
  await mkEmployment(cId, s1, { caps: [] });
  // T1: ONLY manage_attendance at S1 (Ian Q2).
  await mkEmployment(t1Id, s1, { caps: ['manage_attendance' as Capability] });
  await mkEmployment(h1Id, s1, { caps: ['enrol_staff' as Capability] });
  await mkEmployment(w1Id, s1, { caps: ['create_wholesale_order' as Capability] });
  await mkEmployment(v1Id, s1, { caps: ['view_financial_reports' as Capability] });

  // Staff whose records the screens show. No role needed; they are subjects, not viewers.
  const e1Person = await mkPerson(M.e1Name, null, []);
  const e2Person = await mkPerson(M.e2Name, null, []);
  const e3Person = await mkPerson(M.e3Name, null, []);
  const f1Person = await mkPerson(M.f1Name, null, []);
  const qPerson = await mkPerson(M.qName, null, []);
  await mkPerson(M.uName, null, []);
  // The identity table is unique on (kind, value) across orgs and earlier runs leave their orgs behind: clear the old holder first.
  await sql`delete from person_identities where kind = 'phone' and value = ${M.e2Phone}`;
  await sql`insert into person_identities (person_id, kind, value) values (${e2Person}, 'phone', ${M.e2Phone})`;

  const e1Emp = await mkEmployment(e1Person, s1, { caps: null });
  const e2Emp = await mkEmployment(e2Person, s2, { caps: null });
  const f1EmpS1 = await mkEmployment(f1Person, s1, { caps: null });
  const f1EmpS2 = await mkEmployment(f1Person, s2, { caps: null });
  const qEmp = await mkEmployment(qPerson, s2, { caps: null });
  const e3Emp = await mkEmployment(e3Person, s3, { status: 'resigned', endedOn: '2026-06-30', caps: null });
  await sql`update stores set is_active = false where id = ${s3}`;

  const rate = async (emp: string, amount: string) => {
    const [r] = await sql<{ id: string }[]>`
      insert into pay_rates (org_id, employment_id, basis, amount, effective_from, created_by)
      values (${orgId}, ${emp}, 'daily', ${amount}, '2025-01-01', ${aId}) returning id`;
    return r!.id;
  };
  const r1 = await rate(e1Emp, '650.00');
  const r2 = await rate(e2Emp, '720.00');

  const anyAccount = async (storeId: string) => {
    const [a] = await sql<{ id: string }[]>`select id from money_accounts where store_id = ${storeId} order by is_foundation desc, id limit 1`;
    if (!a) throw new Error(`fixture: no money account at store ${storeId}`);
    return a.id;
  };
  const acc1 = await anyAccount(s1);
  const acc2 = await anyAccount(s2);

  const payRun = async (storeId: string, accountId: string, emp: string, person: string, rateId: string, amount: string) => {
    const [run] = await sql<{ id: string }[]>`
      insert into pay_runs (org_id, store_id, period_start, period_end, status, money_account_id, posted_at, posted_by, created_by)
      values (${orgId}, ${storeId}, '2026-01-01', '2026-01-15', 'posted', ${accountId}, now(), ${aId}, ${aId}) returning id`;
    await sql`
      insert into payslips (run_id, org_id, employment_id, person_id, pay_rate_id, days_worked, basic_pay, gross_pay, advance_recovered, net_pay)
      values (${run!.id}, ${orgId}, ${emp}, ${person}, ${rateId}, '1', ${amount}, ${amount}, '0', ${amount})`;
    return run!.id;
  };
  const runS1 = await payRun(s1, acc1, e1Emp, e1Person, r1, '650.00');
  const runS2 = await payRun(s2, acc2, e2Emp, e2Person, r2, '720.00');

  const [t13] = await sql<{ id: string }[]>`
    insert into thirteenth_month_runs (org_id, store_id, year, status, money_account_id, created_by)
    values (${orgId}, ${s2}, 2025, 'draft', ${acc2}, ${aId}) returning id`;
  await sql`
    insert into thirteenth_month_payouts (run_id, org_id, employment_id, person_id, basic_pay_earned, gross_pay, advance_recovered, net_pay)
    values (${t13!.id}, ${orgId}, ${e2Emp}, ${e2Person}, '720.00', '60.00', '0', '60.00')`;

  // ---- customers and their receivables (the domain posts them: balances are derived from the ledger) ----
  const mkCustomer = async (name: string, contactNo: string | null) => {
    const [c] = await sql<{ id: string }[]>`
      insert into customers (org_id, name, contact_no, created_by) values (${orgId}, ${name}, ${contactNo}, ${aId}) returning id`;
    return c!.id;
  };
  const x = await mkCustomer(M.xName, M.xPhone);
  const y = await mkCustomer(M.yName, M.yPhone);
  const z = await mkCustomer(M.zName, null);
  const A = actorOf(aId);
  const charge = (storeId: string, customerId: string, amount: string, ref: string) =>
    asOrg(orgId, (tx) =>
      recordCharge(tx, A, { storeId, customerId, chargeDate: '2026-01-10', totalAmount: amount, revenueAccountCode: '4150', referenceNo: ref }),
    );
  await charge(s2, x, '2345.00', M.xRef);
  await charge(s1, y, '1000.00', M.yS1Ref);
  const yS2 = await charge(s2, y, '10277.00', M.yS2Ref);
  const [file] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
    values (${orgId}, ${s2}, 'receipt_photo', ${`orgs/${orgId}/receipt_photo/${uid('f')}.jpg`}, 'image/jpeg', 1024, ${uid('sum')}, ${aId}) returning id`;
  await asOrg(orgId, (tx) =>
    recordCollection(tx, A, {
      storeId: s2, customerId: y, collectionDate: '2026-01-12', amount: '777.00', moneyAccountId: acc2,
      receiptFileId: file!.id, referenceNo: M.yS2ColRef,
      allocations: [{ chargeId: yS2.chargeId, amountApplied: '777.00' }],
    }),
  );
  // The limit is set AFTER the charges: recordCharge enforces it, and the point is a buyer already over it org-wide (10,500.00 > 10,000.00).
  await sql`update customers set credit_limit = '10000.00' where id = ${y}`;

  const order = async (storeId: string, customerId: string, amount: string) => {
    const [o] = await sql<{ id: string }[]>`
      insert into trade_orders (org_id, store_id, customer_id, order_date, status, total_amount, created_by)
      values (${orgId}, ${storeId}, ${customerId}, '2026-01-20', 'draft', ${amount}, ${aId}) returning id`;
    return o!.id;
  };
  const orderYS1 = await order(s1, y, '500.00');
  const orderXS2 = await order(s2, x, '400.00');

  return {
    orgId, s1, s2, s3,
    A, P1: actorOf(p1Id), M1: actorOf(m1Id), M2: actorOf(m2Id), T1: actorOf(t1Id), C: actorOf(cId), G: actorOf(gId), H1: actorOf(h1Id), W1: actorOf(w1Id), V1: actorOf(v1Id),
    e1Emp, e2Emp, e3Emp, f1EmpS1, f1EmpS2, qEmp,
    runS1, runS2, thirteenthS2: t13!.id,
    x, y, z, receiptFileId: file!.id, orderYS1, orderXS2,
  };
}

type PageModule = { default: (p: never) => Promise<unknown> | unknown };

/** Renders a page (default export) as `who`. Rejects with 'NEXT_NOT_FOUND' when the page calls notFound(). */
export async function render(
  load: () => Promise<PageModule>,
  who: Actor,
  props: { params?: Record<string, string>; search?: Record<string, string> } = {},
): Promise<string> {
  const mod = await load();
  session.actor = who;
  const el = await mod.default({ params: Promise.resolve(props.params ?? {}), searchParams: Promise.resolve(props.search ?? {}) } as never);
  return renderToStaticMarkup(el as never);
}

/** Every marker is absent from the page text AND the raw html (ids ride in hrefs). */
export function expectAbsent(html: string, what: string, ...needles: string[]): void {
  const t = plain(html);
  for (const n of needles) {
    expect(t.includes(n) || html.includes(n), `${what}: "${n}" must not be anywhere on the page`).toBe(false);
  }
}
export function expectPresent(html: string, what: string, ...needles: string[]): void {
  const t = plain(html);
  for (const n of needles) expect(t.includes(n) || html.includes(n), `${what}: "${n}" must be on the page`).toBe(true);
}
export function expectRefusalCard(html: string, what: string): void {
  expect(plain(html), `${what}: the access-refused card`).toContain(M.refusedCard);
}
export function expectNotAvailable(html: string, what: string): void {
  expect(plain(html), `${what}: the one sentence`).toContain(M.notAvailable);
}

/** A loader refused with the authorize() refusal, naming the capability. A missing export (TypeError) is NOT a refusal. */
export async function expectAuthRefusal(run: () => Promise<unknown>, capability: string, what: string): Promise<void> {
  let thrown: unknown = null;
  try {
    await run();
  } catch (e) {
    thrown = e;
  }
  expect(thrown, `${what}: the loader returned instead of refusing`).not.toBeNull();
  const e = thrown as { name?: string; capability?: string; message?: string };
  expect(e.name, `${what}: expected AuthorizationError, got ${e.name}: ${e.message}`).toBe('AuthorizationError');
  expect(e.capability, `${what}: refused for the wrong capability`).toBe(capability);
}

/** The error message a page throws (NEXT_NOT_FOUND for a notFound()). */
export async function pageError(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  return '';
}

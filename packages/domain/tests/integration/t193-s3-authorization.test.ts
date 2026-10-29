import { config } from 'dotenv';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';

/**
 * T-193 S3 (TESTER) - `remit_statutory`: who may record a statutory payment, and that the ✗ fires.
 * REFRESH.md s1 (capability `remit_statutory`, org scope, super_admin yes, admin yes, manager NO, staff NO), s4.1 step 1
 * (`authorize` FIRST, before field rules, the request id or any read), case 16 (domain leg) and case 18 (org isolation);
 * docs/decisions/CAPABILITY-MATRIX.md: "every ✅ has a test proving the ✗ fires". The cell itself is pinned in
 * packages/auth/tests/t193-s3-remit-statutory-cell.test.ts.
 *
 * RED TODAY: `recordStatutoryPayment` is not exported from @shareat/domain, so every leg fails with "is not a function" (and the
 * capability does not exist in capabilities.ts, so the refusals could not be the right ones even if it were).
 * MUTANTS: store-scoped capability (a store manager pays for everyone); `manage_payroll_rates` or `run_payroll` used as the gate;
 * validation before authorize (a manager learns what is wrong with the form); the capability row added but never called.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { closeDb } from '@shareat/db';
import { recordStatutoryPayment } from '@shareat/domain';
import { asOrg, count, entryCount, mkWorld, refusal, uid, type PayInput, type PayResult, type World } from './_fixtures/t193-s3-world';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
const sql = postgres(url, { max: 6 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

function input(w: World, over: Partial<PayInput> = {}): PayInput {
  return {
    paymentId: crypto.randomUUID(),
    agency: 'sss',
    month: '2026-10-01',
    paidOn: '2026-11-10',
    moneyAccountId: w.lipaOffice,
    referenceNo: uid('PRN'),
    lines: [{ storeId: w.lipa, amount: '3180.00' }],
    ...over,
  };
}
const pay = (w: World, inp: PayInput, who = w.admin): Promise<PayResult> =>
  asOrg(w.orgId, (tx) => (recordStatutoryPayment as (tx: unknown, a: unknown, i: unknown) => Promise<PayResult>)(tx, who, inp));

async function nothingWritten(w: World): Promise<void> {
  expect(await count(sql, w, 'statutory_payments'), 'payment rows').toBe(0);
  expect(await count(sql, w, 'statutory_payment_lines'), 'line rows').toBe(0);
  expect(await entryCount(sql, w), 'statutory_payment entries').toBe(0);
}

describe('case 16 (domain leg) - the ✗ fires for a manager and for staff', () => {
  it.each([
    ['manager', (w: World) => w.manager],
    ['staff', (w: World) => w.staff],
  ])('a %s is refused with AuthorizationError at every store, and nothing is written (kills: store-scoped capability; the cell added but never called)', async (_role, who) => {
    const w = await mkWorld(sql, 'authz');
    const e = await refusal(pay(w, input(w), who(w)), 'a payment recorded without the capability');
    expect(e.name).toBe('AuthorizationError');
    await nothingWritten(w);
  });

  it('the capability is checked FIRST: a manager sending a broken form (no request id, bad amount) still gets AuthorizationError, not "form out of date" (kills: validation before authorize)', async () => {
    const w = await mkWorld(sql, 'authzfirst');
    const e = await refusal(pay(w, input(w, { paymentId: 'junk', lines: [{ storeId: w.lipa, amount: '-1' }] }), w.manager), 'a manager with a broken form');
    expect(e.name).toBe('AuthorizationError');
    await nothingWritten(w);
  });

  it('a manager who holds run_payroll or manage_payroll_rates by GRANT is still refused: those are other doors (kills: wrong capability as the gate)', async () => {
    const w = await mkWorld(sql, 'authzgrant');
    for (const cap of ['run_payroll', 'manage_payroll_rates']) {
      await sql`insert into person_grants (person_id, grant_name, granted_by, grant_source) values (${w.managerId}, ${cap}, ${w.adminId}, 'grant')`;
    }
    const e = await refusal(pay(w, input(w), w.manager), 'a payment by a manager holding payroll grants');
    expect(e.name).toBe('AuthorizationError');
    await nothingWritten(w);
  });

  it('an admin and a super_admin are allowed (the ✅ cells)', async () => {
    const w = await mkWorld(sql, 'authzok');
    await expect(pay(w, input(w, { lines: [{ storeId: w.lipa, amount: '1000.00' }] }), w.admin)).resolves.toMatchObject({ created: true });
    await expect(pay(w, input(w, { lines: [{ storeId: w.lipa, amount: '1000.00' }] }), w.superAdmin)).resolves.toMatchObject({ created: true });
  });

  it('a person who is no one in this org (an unknown id) is refused and nothing is written', async () => {
    const w = await mkWorld(sql, 'authzghost');
    const e = await refusal(pay(w, input(w), { personId: crypto.randomUUID(), orgId: w.orgId }), 'a payment by a person with no role');
    expect(e.name).toBe('AuthorizationError');
    await nothingWritten(w);
  });
});

describe('case 18 - org isolation', () => {
  it("another organization's admin cannot pay this organization's months, stores or money accounts (RLS + the repo's own org filter), and nothing is written in either org", async () => {
    const mine = await mkWorld(sql, 'iso-a');
    const theirs = await mkWorld(sql, 'iso-b');
    // theirs.admin is a real admin of THEIR org; every id in the form belongs to MINE
    const e = await refusal(pay(theirs, input(mine), theirs.admin), "a payment aimed at another org's stores and money account");
    expect(['RefusalError', 'AuthorizationError']).toContain(e.name);
    await nothingWritten(mine);
    await nothingWritten(theirs);
  });

  it("a payment naming this org's store but ANOTHER org's money account is refused and nothing is written", async () => {
    const mine = await mkWorld(sql, 'iso-c');
    const theirs = await mkWorld(sql, 'iso-d');
    await refusal(pay(mine, input(mine, { moneyAccountId: theirs.lipaOffice })), "a money account from another org");
    await nothingWritten(mine);
    await nothingWritten(theirs);
  });

  it("a payment naming another org's STORE in its lines is refused and nothing is written (kills: line FK on store_id alone, no org filter on the owed read)", async () => {
    const mine = await mkWorld(sql, 'iso-e');
    const theirs = await mkWorld(sql, 'iso-f');
    await refusal(pay(mine, input(mine, { lines: [{ storeId: theirs.lipa, amount: '3180.00' }] })), "a line naming another org's store");
    await nothingWritten(mine);
    await nothingWritten(theirs);
  });

  it("the same request id used in two organizations is two independent payments (the id is unique per org, not global)", async () => {
    const a = await mkWorld(sql, 'iso-g');
    const b = await mkWorld(sql, 'iso-h');
    const id = crypto.randomUUID();
    const ra = await pay(a, input(a, { paymentId: id }));
    // the second org cannot re-use the first org's primary key: it is refused in words or posts independently - never replays org A's payment
    const rb = await pay(b, input(b, { paymentId: id })).catch((e: unknown) => e);
    if (rb instanceof Error) {
      expect((rb as { name?: string }).name).toBe('RefusalError');
      expect(await count(sql, b, 'statutory_payments')).toBe(0);
    } else {
      expect((rb as PayResult).entryId).not.toBe(ra.entryId);
      expect(await entryCount(sql, b)).toBe(1);
    }
    expect(await entryCount(sql, a)).toBe(1);
  });
});

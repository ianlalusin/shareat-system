import { config } from 'dotenv';
import postgres from 'postgres';
import { afterAll, describe, expect, it, vi } from 'vitest';

/**
 * T-500 (TESTER) M1-M4 + H5 - a regular admin of a SECOND company (Padre Garcia, made by the real onboardFranchiseOrganization from the MOCK file)
 * sets up its own payroll rates through the /payroll/rates server actions, and a payroll runs. docs/tasks/500-pg-hr-on-v2.md s6.
 * One PG for the file; tests run in order (M4 empty -> M2 owner -> M1 admin enters + confirms -> M3/H5 preview + post -> H5 refusal leg).
 *
 * MUTANTS: M1 - a rate/bracket/min-wage/employer number lands in the franchisor org; confirm leaves confirmed_at NULL; an action silently does
 *   nothing for a non-franchisor org.   M2 - the owner (manager) is allowed (matrix: admin-only), or is refused with a crash / blank page / raw SQL.
 *   M3/H5 - rows entered through the screen are not usable by applyStatutory / postPayRun; post allowed while a rate is unconfirmed.
 *   M4 - the empty page shows an error or says nothing about what to add; the preview refusal does not name the missing rate or the rates page.
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });
vi.mock('next/navigation', async () => (await import('../helpers/flash-jar-core')).nextNavigationMock());
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/components/shell/Page', () => ({ Page: ({ children }: { children: unknown }) => children }));
const h = vi.hoisted(() => ({ actor: null as null | { personId: string; orgId: string } }));
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => h.actor),
  requireSession: vi.fn(async () => ({ actor: h.actor, sessionId: 'session-1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01') })),
}));

import { closeDb } from '@shareat/db';
import { postPayRun, previewPayRun, setPayRate } from '@shareat/domain';
import { renderToStaticMarkup } from 'react-dom/server';
import { asOrg, mkPg, type Pg } from '../../../../packages/domain/tests/integration/_fixtures/t500-pg';
import { captureRedirect, outcomeOf } from '../helpers/flash-jar';
import { plain } from './t435-fixture';

const sql = postgres(url, { max: 5 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const ACTIONS = () => import('../../src/app/payroll/rates/actions');
const ratesPage = () => import('../../src/app/payroll/rates/page');
type Who = { personId: string; orgId: string };
const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
};
async function act(who: Who, name: string, fields: Record<string, string>) {
  h.actor = who;
  const m = (await ACTIONS()) as unknown as Record<string, (f: FormData) => Promise<void>>;
  if (typeof m[name] !== 'function') throw new Error(`${name} is not exported from payroll/rates/actions.ts`);
  try {
    const o = outcomeOf(await captureRedirect(() => m[name]!(form(fields))));
    return { error: o.flash.error, ok: o.flash.ok, threw: null as string | null };
  } catch (e) {
    return { error: undefined, ok: undefined, threw: e instanceof Error ? e.message : String(e) };
  }
}
async function ratesHtml(who: Who): Promise<string> {
  h.actor = who;
  const mod = await ratesPage();
  const el = await (mod.default as unknown as (p: unknown) => Promise<unknown>)({ params: Promise.resolve({}), searchParams: Promise.resolve({}) });
  return renderToStaticMarkup(el as never);
}
const RAW = /select |insert |update |violates|constraint|ERROR:|syntax|relation |SQLSTATE|\bat Object\.|statutory_rates|withholding_brackets|minimum_wages/i;

const YM = new Date().toISOString().slice(0, 7);
const FIRST = `${YM}-01`;
const P = { periodStart: `${YM}-01`, periodEnd: `${YM}-15` };

let pg: Pg;
const counts = async (orgId: string) => {
  const [r] = await sql<Record<string, number>[]>`
    select (select count(*) from statutory_rates where org_id = ${orgId})::int rates,
           (select count(*) from withholding_brackets where org_id = ${orgId})::int brackets,
           (select count(*) from minimum_wages where org_id = ${orgId})::int minwages,
           (select count(*) from statutory_employers where org_id = ${orgId})::int employers`;
  return r!;
};

async function prepareWorker(w: Pg) {
  await sql`update employments set started_on = '2026-01-01' where id = ${w.employmentId}`;
  await sql`update persons set sss_no = '1234567890', philhealth_no = '123456789012', pagibig_no = '210987654321', tin = '123456789' where id = ${w.workerId}`;
  const [cfg] = await sql<{ id: string; payroll_period_type: string }[]>`select id, payroll_period_type from store_attendance_config where org_id = ${w.pgOrgId} and store_id = ${w.storeId}`;
  await asOrg(w.pgOrgId, (tx) =>
    setPayRate(tx, w.pgAdmin, { employmentId: w.employmentId, storeId: w.storeId, basis: 'daily', amount: '800.00', effectiveFrom: '2026-01-01' }));
  await sql`insert into attendance_days (org_id, store_id, person_id, employment_id, shift_day, attendance_config_id, anchor_mode, status,
              computed_minutes, is_half_day, pending_ot_minutes, night_diff_minutes, holiday_minutes, is_holiday, holiday_type)
            values (${w.pgOrgId}, ${w.storeId}, ${w.workerId}, ${w.employmentId}, ${FIRST}, ${cfg!.id}, 'exact', 'verified', 540, false, 0, 0, 0, false, null)`;
}

const rate = (w: Pg, agency: string, extra: Record<string, string>) =>
  act(w.pgAdmin, 'addStatutoryRateAction', { agency, effectiveFrom: FIRST, sourceRef: 'T-500 test', ...extra });

describe('M4 - PG with nothing on file', () => {
  it('the rates page is an empty state that tells the admin what to add (not an error)', async () => {
    pg = await mkPg(sql);
    await prepareWorker(pg);
    const t = plain(await ratesHtml(pg.pgAdmin));
    expect(t, 'the page renders for a regular admin of a second company').toMatch(/Payroll rates/i);
    expect(t).not.toMatch(/do not have access|not found/i);
    // The empty state must say WHAT to add, not just "No contribution rates yet." (kills: bare empty sentence)
    expect(t, 'contributions empty state names the agencies to add').toMatch(/No contribution rates yet[^]{0,200}SSS[^]{0,80}PhilHealth[^]{0,80}Pag-IBIG/i);
    expect(t, 'withholding empty state says to add a table').toMatch(/No withholding tables yet[^]{0,200}(add|enter)/i);
    expect(t, 'minimum wage empty state says to add a wage per store').toMatch(/No minimum wages yet[^]{0,200}(add|enter)/i);
  });

  it('the preview refusal names the missing rate and points to the rates page', async () => {
    const err = await asOrg(pg.pgOrgId, (tx) => previewPayRun(tx, pg.pgAdmin, { storeId: pg.storeId, ...P })).then(
      () => null,
      (e: { message?: string; userMessage?: string }) => e,
    );
    expect(err, 'a preview with no rates is refused').not.toBeNull();
    const words = `${err!.userMessage ?? ''} ${err!.message ?? ''}`;
    expect(words, 'names the missing rate').toMatch(/SSS/);
    expect(words, 'points to the rates page').toMatch(/payroll rates|\/payroll\/rates/i);
    expect(err!.userMessage ?? '', 'in words, no SQL').not.toMatch(RAW);
  });
});

describe('M2 - PG owner (store-scoped manager)', () => {
  it('manage_payroll_rates is admin-only: every action is refused in words, nothing is written, the page says so in words', async () => {
    const before = await counts(pg.pgOrgId);
    const attempts: [string, Record<string, string>][] = [
      ['addStatutoryRateAction', { agency: 'sss', effectiveFrom: FIRST, eeRate: '0.05', erRate: '0.10', baseKind: 'gross', floor: '5000', ceiling: '35000', step: '500', sourceRef: 'owner try' }],
      ['addMinimumWageAction', { storeId: pg.storeId, effectiveFrom: FIRST, dailyRate: '695.00', wageOrderRef: 'owner try' }],
      ['saveStatutoryEmployerAction', { agency: 'sss', employerNo: '0300000009', dueDay: '10' }],
    ];
    for (const [name, fields] of attempts) {
      const r = await act(pg.owner, name, fields);
      expect(r.ok, `${name}: no success for the owner`).toBeFalsy();
      expect(r.threw, `${name}: refusal is a flash, not a thrown crash`).toBeNull();
      expect(r.error, `${name}: a refusal shows`).toBeTruthy();
      expect(r.error, `${name}: in words`).not.toMatch(RAW);
    }
    expect(await counts(pg.pgOrgId), 'nothing written').toEqual(before);
    expect(plain(await ratesHtml(pg.owner)), 'the page says so in words').toMatch(/You do not have access to this screen/i);
  });
});

describe('M1 - PG admin enters and confirms everything through the rates actions', () => {
  it('SSS, PhilHealth, Pag-IBIG, a semi-monthly withholding set, a minimum wage for the PG store, three employer numbers; all confirmed; all in PG, none in Ian org', async () => {
    const ianBefore = await counts(pg.franchisor.orgId);
    const adds = [
      await rate(pg, 'sss', { eeRate: '0.05', erRate: '0.10', baseKind: 'gross', floor: '5000', ceiling: '35000', step: '500', ecThreshold: '15000', ecLow: '10', ecHigh: '30' }),
      await rate(pg, 'philhealth', { eeRate: '0.025', erRate: '0.025', baseKind: 'basic', floor: '10000', ceiling: '100000' }),
      await rate(pg, 'pagibig', { eeRate: '0.02', erRate: '0.02', baseKind: 'basic', floor: '0', ceiling: '10000', lowThreshold: '1500', lowEeRate: '0.01' }),
      await act(pg.pgAdmin, 'addWithholdingBracketSetAction', {
        frequency: 'semi_monthly', effectiveFrom: FIRST, sourceRef: 'T-500 test',
        rows: '0, 0, 0\n10417, 0, 0.15\n16667, 937.50, 0.20\n33333, 4270.70, 0.25\n83333, 16770.70, 0.30\n333333, 91770.70, 0.35',
      }),
      await act(pg.pgAdmin, 'addMinimumWageAction', { storeId: pg.storeId, effectiveFrom: FIRST, dailyRate: '695.00', wageOrderRef: 'T-500 test wage order' }),
    ];
    adds.forEach((r, i) => {
      expect(r.threw, `add #${i}: no crash`).toBeNull();
      expect(r.error, `add #${i}: no refusal (${r.error})`).toBeUndefined();
      expect(r.ok, `add #${i}: success flash`).toBeTruthy();
    });
    const rows = await sql<{ id: string; agency: string; confirmed_at: Date | null }[]>`select id, agency, confirmed_at from statutory_rates where org_id = ${pg.pgOrgId} order by agency`;
    expect(rows.map((r) => r.agency)).toEqual(['pagibig', 'philhealth', 'sss']);
    expect(rows.every((r) => r.confirmed_at === null), 'new rows start UNCONFIRMED').toBe(true);

    for (const r of rows) {
      const c = await act(pg.pgAdmin, 'confirmStatutoryRateAction', { id: r.id });
      expect(c.error ?? c.threw, `confirm ${r.agency}`).toBeFalsy();
      expect(c.ok).toBeTruthy();
    }
    const cb = await act(pg.pgAdmin, 'confirmWithholdingBracketSetAction', { frequency: 'semi_monthly', effectiveFrom: FIRST });
    expect(cb.error ?? cb.threw, 'confirm brackets').toBeFalsy();
    const [mw] = await sql<{ id: string }[]>`select id from minimum_wages where org_id = ${pg.pgOrgId} and store_id = ${pg.storeId}`;
    const cm = await act(pg.pgAdmin, 'confirmMinimumWageAction', { id: mw!.id });
    expect(cm.error ?? cm.threw, 'confirm minimum wage').toBeFalsy();

    for (const [agency, no] of [['sss', '0300000011'], ['philhealth', '020000000011'], ['pagibig', '121000000011']] as const) {
      const e = await act(pg.pgAdmin, 'saveStatutoryEmployerAction', { agency, employerNo: no, dueDay: '10' });
      expect(e.error ?? e.threw, `employer ${agency}`).toBeFalsy();
      expect(e.ok).toBeTruthy();
    }

    const [c] = await sql<{ unconfirmed: string; rates: number; brackets: number; mw: number }[]>`
      select ((select count(*) from statutory_rates where org_id = ${pg.pgOrgId} and confirmed_at is null)
            + (select count(*) from withholding_brackets where org_id = ${pg.pgOrgId} and confirmed_at is null)
            + (select count(*) from minimum_wages where org_id = ${pg.pgOrgId} and confirmed_at is null))::text as unconfirmed,
             (select count(*) from statutory_rates where org_id = ${pg.pgOrgId} and confirmed_by = ${pg.pgAdminId})::int rates,
             (select count(*) from withholding_brackets where org_id = ${pg.pgOrgId})::int brackets,
             (select count(*) from minimum_wages where org_id = ${pg.pgOrgId} and store_id = ${pg.storeId})::int mw`;
    expect(Number(c!.unconfirmed), 'nothing left unconfirmed').toBe(0);
    expect(c!.rates).toBe(3);
    expect(c!.brackets).toBe(6);
    expect(c!.mw).toBe(1);
    const emp = await sql<{ agency: string; employer_no: string }[]>`select agency, employer_no from statutory_employers where org_id = ${pg.pgOrgId} and agency in ('sss','philhealth','pagibig') order by agency`;
    expect(emp.map((r) => `${r.agency}:${r.employer_no}`)).toEqual(['pagibig:121000000011', 'philhealth:020000000011', 'sss:0300000011']);
    expect(await counts(pg.franchisor.orgId), 'Ian org untouched').toEqual(ianBefore);
  });
});

describe('M3 / H5 - a payroll runs on the rows PG entered', () => {
  it('after M1: preview succeeds with nothing unconfirmed, and post succeeds', async () => {
    const pv = await asOrg(pg.pgOrgId, (tx) => previewPayRun(tx, pg.pgAdmin, { storeId: pg.storeId, ...P }));
    expect((pv as { unconfirmedRates: string[] }).unconfirmedRates, 'all confirmed on the screen').toEqual([]);
    expect((pv as { slips: unknown[] }).slips.length, 'one slip for the one worker').toBe(1);
    const [office] = await sql<{ id: string }[]>`select id from money_accounts where store_id = ${pg.storeId} and instrument = 'cash' and custodian = 'office' and is_foundation`;
    expect(office, 'PG store has its office cash account').toBeDefined();
    await asOrg(pg.pgOrgId, (tx) => postPayRun(tx, pg.pgAdmin, { storeId: pg.storeId, ...P, moneyAccountId: office!.id }));
    const [run] = await sql<{ n: number }[]>`select count(*)::int n from payslips where org_id = ${pg.pgOrgId}`;
    expect(run!.n).toBe(1);
  });

  it('H5 refusal leg: rates added but NOT confirmed -> preview lists them unconfirmed, post is refused naming them', async () => {
    const q = await mkPg(sql);
    await prepareWorker(q);
    await rate(q, 'sss', { eeRate: '0.05', erRate: '0.10', baseKind: 'gross', floor: '5000', ceiling: '35000', step: '500' });
    await rate(q, 'philhealth', { eeRate: '0.025', erRate: '0.025', baseKind: 'basic', floor: '10000', ceiling: '100000' });
    await rate(q, 'pagibig', { eeRate: '0.02', erRate: '0.02', baseKind: 'basic', floor: '0', ceiling: '10000' });
    await act(q.pgAdmin, 'addWithholdingBracketSetAction', { frequency: 'semi_monthly', effectiveFrom: FIRST, sourceRef: 't', rows: '0, 0, 0\n10417, 0, 0.15' });
    await act(q.pgAdmin, 'addMinimumWageAction', { storeId: q.storeId, effectiveFrom: FIRST, dailyRate: '695.00', wageOrderRef: 't' });
    const pv = await asOrg(q.pgOrgId, (tx) => previewPayRun(tx, q.pgAdmin, { storeId: q.storeId, ...P }));
    expect((pv as { unconfirmedRates: string[] }).unconfirmedRates.length, 'preview lists the unconfirmed rates').toBeGreaterThanOrEqual(3);
    const [office] = await sql<{ id: string }[]>`select id from money_accounts where store_id = ${q.storeId} and instrument = 'cash' and custodian = 'office' and is_foundation`;
    const err = await asOrg(q.pgOrgId, (tx) => postPayRun(tx, q.pgAdmin, { storeId: q.storeId, ...P, moneyAccountId: office!.id })).then(
      () => null,
      (e: { message?: string; userMessage?: string }) => e,
    );
    expect(err, 'post refused while unconfirmed').not.toBeNull();
    expect(`${err!.userMessage ?? ''} ${err!.message ?? ''}`).toMatch(/SSS/i);
  });
});

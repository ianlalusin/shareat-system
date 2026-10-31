import { config } from 'dotenv';
import postgres from 'postgres';
import { afterAll, describe, expect, it, vi } from 'vitest';

/**
 * T-193 S6 (TESTER) - employer numbers and due days on /payroll/rates, edited through the app's own action; and what they change.
 * Spec: old spec "Due dates and lateness" (:106-112), "Authorization" (manage_payroll_rates, audited), cases 13 and 16, REFRESH S6.
 *
 * NAMES FIXED BY THIS FILE:
 *   apps/erp/src/app/payroll/rates/actions.ts   saveStatutoryEmployerAction(formData) - fields agency (sss|philhealth|pagibig|bir),
 *       employerNo (digits; '' for bir), dueDay (1-31). Inserts the (org, agency) row when none exists, otherwise updates employer_no /
 *       due_day (+ updated_by / updated_at). Actor from requireActor(), never the form. The DOMAIN function it calls authorizes
 *       manage_payroll_rates first, writes one audit_log row (action 'statutory_employer.change', before/after carrying the old and new employer
 *       number and due day) and owns the sentences. Success redirects to /payroll/rates with a flash ok; a refusal redirects to
 *       /payroll/rates with a flash error that is a SENTENCE (no SQL, constraint or table names, no uuid).
 *   apps/erp/src/app/payroll/rates/page.tsx    an "Employer numbers" section: one entry per agency (SSS, PhilHealth, Pag-IBIG, BIR) showing the
 *       number on file (BIR: the organization's TIN) and the due day; per agency a form posting agency (hidden) + employerNo + dueDay.
 *       Refused for a manager (the page's existing gate) with none of the numbers on the page.
 *
 * MUTANTS (named per leg): manager (or any admin of another organization) edits employer numbers; no audit row; letters / blank / padded
 * number accepted for SSS; a number accepted for BIR; due day 0 / 32 / 10.5 / "ten" accepted; an error shown as SQL or as a raw uuid;
 * the edit not reaching the payment check (record still refused after saving, or still allowed after the number is cleared by
 * a different path); due date not following the saved due day; actor read from the form; a second row inserted instead of an update.
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });
vi.mock('next/navigation', async () => (await import('../helpers/flash-jar-core')).nextNavigationMock());
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/components/shell/Page', () => ({ Page: ({ children }: { children: unknown }) => children }));
const h = vi.hoisted(() => ({ actor: null as null | { personId: string; orgId: string } }));
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => h.actor),
  requireSession: vi.fn(async () => ({ actor: h.actor, sessionId: 'session-1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01') })),
}));

import { closeDb, type Tx } from '@shareat/db';
import { recordStatutoryPayment } from '@shareat/domain';
import { renderToStaticMarkup } from 'react-dom/server';
import { asOrg, mkWorld, uid, type World } from '../../../../packages/domain/tests/integration/_fixtures/t193-s3-world';
import { captureRedirect, outcomeOf } from '../helpers/flash-jar';
import { plain } from './t435-fixture';

const sql = postgres(url, { max: 5 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const ACTIONS = () => import('../../src/app/payroll/rates/actions');
const ratesPage = () => import('../../src/app/payroll/rates/page');
const monthLib = () => import('../../src/app/payroll/statutory-payments/lib');

type Who = { personId: string; orgId: string };
const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
};
async function save(who: Who, fields: Record<string, string>) {
  h.actor = who;
  const m = (await ACTIONS()) as unknown as Record<string, (f: FormData) => Promise<void>>;
  if (typeof m.saveStatutoryEmployerAction !== 'function') throw new Error('saveStatutoryEmployerAction is not exported from payroll/rates/actions.ts');
  try {
    const o = outcomeOf(await captureRedirect(() => m.saveStatutoryEmployerAction!(form(fields))));
    return { error: o.flash.error, ok: o.flash.ok, path: o.path, threw: null as string | null };
  } catch (e) {
    return { error: undefined, ok: undefined, path: '', threw: e instanceof Error ? e.message : String(e) };
  }
}
async function ratesHtml(who: Who): Promise<string> {
  h.actor = who;
  const mod = await ratesPage();
  const el = await (mod.default as unknown as (p: unknown) => Promise<unknown>)({ params: Promise.resolve({}), searchParams: Promise.resolve({}) });
  return renderToStaticMarkup(el as never);
}
const rows = async (w: World) =>
  sql<{ agency: string; employer_no: string | null; due_day: number; updated_by: string | null }[]>`
    select agency, employer_no, due_day, updated_by from statutory_employers where org_id = ${w.orgId} order by agency`;
const auditCount = async (w: World, like: string) =>
  Number((await sql<{ n: string }[]>`
    select count(*)::text as n from audit_log where org_id = ${w.orgId} and action = 'statutory_employer.change'
      and (coalesce(before::text, '') || ' ' || coalesce(after::text, '')) ilike ${like}`)[0]!.n);
const RAW = /select |insert |update |violates|constraint|statutory_employers|ERROR:|syntax|relation |SQLSTATE|\bat Object\./i;
const inWords = (e: string | undefined, what: string) => {
  expect(e, `${what}: a refusal is shown`).toBeTruthy();
  expect(e!, `${what}: in words, not SQL (got: ${e})`).not.toMatch(RAW);
  expect(e!, `${what}: no uuid`).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/);
};
const PAY = (w: World, over: Record<string, unknown> = {}) => ({
  paymentId: crypto.randomUUID(), agency: 'sss', month: '2026-10-01', paidOn: '2026-11-10', moneyAccountId: w.lipaOffice,
  referenceNo: uid('PRN'), lines: [{ storeId: w.lipa, amount: '1000.00' }], ...over,
});
const tryPay = (w: World, inp: Record<string, unknown>) =>
  asOrg(w.orgId, (tx: Tx) => (recordStatutoryPayment as unknown as (t: Tx, a: unknown, i: unknown) => Promise<{ id: string }>)(tx, w.admin, inp));

// -----------------------------------------------------------------------------------------------------------------
describe('an admin saves an employer number and a due day', () => {
  it('edits SSS in place: ok flash back on /payroll/rates, the same single row updated (not a second one), updated_by = the admin, one audit row carrying old and new (kills: second row inserted; no audit; actor from the form)', async () => {
    const w = await mkWorld(sql, 's6emp');
    const before = await rows(w);
    expect(before.map((r) => r.agency)).toEqual(['pagibig', 'philhealth', 'sss']);
    const r = await save(w.admin, { agency: 'sss', employerNo: '0399999999', dueDay: '15', actorPersonId: w.managerId });
    expect(r.threw).toBeNull();
    expect(r.error).toBeUndefined();
    expect(r.ok, 'a success message').toBeTruthy();
    expect(r.path).toBe('/payroll/rates');
    const after = await rows(w);
    expect(after.length, 'still one row per agency').toBe(3);
    const sss = after.find((x) => x.agency === 'sss')!;
    expect([sss.employer_no, sss.due_day, sss.updated_by]).toEqual(['0399999999', 15, w.adminId]);
    expect(after.find((x) => x.agency === 'philhealth')!.employer_no, 'other agencies untouched').toBe('020000000001');
    expect(await auditCount(w, '%0399999999%'), 'one audit row for the change').toBe(1);
    expect(await auditCount(w, '%0300000001%'), 'the old number is in the same audit row (before)').toBe(1);
  });

  it('adds a missing agency (BIR has no number, only a due day) and a first-time SSS number for an organization with none (kills: insert path missing; BIR given a number)', async () => {
    const w = await mkWorld(sql, 's6empnew');
    await sql`delete from statutory_employers where org_id = ${w.orgId}`;
    expect((await save(w.admin, { agency: 'bir', employerNo: '', dueDay: '10' })).ok).toBeTruthy();
    expect((await save(w.admin, { agency: 'sss', employerNo: '0311111111', dueDay: '10' })).ok).toBeTruthy();
    const got = (await rows(w)).map((r) => `${r.agency}|${r.employer_no}|${r.due_day}`);
    expect(got).toEqual(['bir|null|10', 'sss|0311111111|10']);
  });
});

describe('validation in words (nothing written, nothing audited)', () => {
  it.each([
    ['letters in the number', { agency: 'sss', employerNo: '03ABC12345', dueDay: '10' }],
    ['dots in the number', { agency: 'sss', employerNo: '03.0000.0001', dueDay: '10' }],
    ['a blank number for SSS', { agency: 'sss', employerNo: '', dueDay: '10' }],
    ['a number for BIR (BIR uses the company TIN)', { agency: 'bir', employerNo: '123456789', dueDay: '10' }],
    ['due day 0', { agency: 'sss', employerNo: '0300000001', dueDay: '0' }],
    ['due day 32', { agency: 'sss', employerNo: '0300000001', dueDay: '32' }],
    ['due day 10.5', { agency: 'sss', employerNo: '0300000001', dueDay: '10.5' }],
    ['due day -3', { agency: 'sss', employerNo: '0300000001', dueDay: '-3' }],
    ['due day "ten"', { agency: 'sss', employerNo: '0300000001', dueDay: 'ten' }],
    ['a blank due day', { agency: 'sss', employerNo: '0300000001', dueDay: '' }],
    ['an unknown agency', { agency: 'gsis', employerNo: '0300000001', dueDay: '10' }],
  ])('%s is refused in a sentence', async (what, fields) => {
    const w = await mkWorld(sql, 's6empbad');
    const snapshot = JSON.stringify(await rows(w));
    const audits = await auditCount(w, '%');
    const r = await save(w.admin, fields);
    if (r.threw) expect(r.threw, `${what}: a thrown refusal must not be raw SQL`).not.toMatch(RAW);
    else inWords(r.error, what);
    expect(r.ok, `${what}: no success message`).toBeFalsy();
    expect(JSON.stringify(await rows(w)), `${what}: nothing written`).toBe(snapshot);
    expect(await auditCount(w, '%'), `${what}: nothing audited`).toBe(audits);
  });

  it('T-500: the printed format "03-1234567-8" (dashes, spaces) is accepted and stored digits-only (kills: refused, or stored with dashes)', async () => {
    const w = await mkWorld(sql, 's6empdash');
    const r = await save(w.admin, { agency: 'sss', employerNo: '03-1234567-8', dueDay: '10' });
    expect(r.error, 'no refusal').toBeUndefined();
    expect(r.ok).toBeTruthy();
    expect((await rows(w)).find((x) => x.agency === 'sss')!.employer_no).toBe('0312345678');
    expect((await save(w.admin, { agency: 'philhealth', employerNo: '02 0000 000001', dueDay: '10' })).ok).toBeTruthy();
    expect((await rows(w)).find((x) => x.agency === 'philhealth')!.employer_no).toBe('020000000001');
  });

  it('the number is trimmed but never padded into something else: " 0300000002 " is saved as 0300000002 (kills: padded value stored)', async () => {
    const w = await mkWorld(sql, 's6emptrim');
    const r = await save(w.admin, { agency: 'sss', employerNo: ' 0300000002 ', dueDay: '10' });
    if (r.ok) expect((await rows(w)).find((x) => x.agency === 'sss')!.employer_no).toBe('0300000002');
    else inWords(r.error, 'padded number');
  });
});

describe('who may edit them (case 16; kills: manager edits employer numbers)', () => {
  it('a manager and staff are refused and nothing changes; another organization\'s admin cannot touch this organization\'s rows', async () => {
    const w = await mkWorld(sql, 's6empgate');
    const other = await mkWorld(sql, 's6empgateB');
    const snapshot = JSON.stringify(await rows(w));
    for (const who of [w.manager, w.staff]) {
      const r = await save(who, { agency: 'sss', employerNo: '0388888888', dueDay: '20' });
      expect(r.ok, 'no success for a non-holder').toBeFalsy();
      expect(r.error ?? r.threw, 'a refusal shows').toBeTruthy();
      if (r.error) inWords(r.error, 'non-holder');
    }
    expect(JSON.stringify(await rows(w)), 'unchanged').toBe(snapshot);
    expect(await auditCount(w, '%0388888888%')).toBe(0);
    // org B's admin edits ORG B only
    expect((await save(other.admin, { agency: 'sss', employerNo: '0377777777', dueDay: '12' })).ok).toBeTruthy();
    expect(JSON.stringify(await rows(w)), 'org A unchanged by org B\'s admin').toBe(snapshot);
    expect((await rows(other)).find((x) => x.agency === 'sss')!.employer_no).toBe('0377777777');
  });
});

describe('the section on /payroll/rates', () => {
  it('an admin sees each agency with its number and due day, BIR with the company TIN and the form fields; a manager sees none of it (kills: gate is the menu only; section missing)', async () => {
    const w = await mkWorld(sql, 's6emppage');
    const html = await ratesHtml(w.admin);
    const t = plain(html);
    expect(t).toMatch(/Employer numbers/i);
    for (const n of ['0300000001', '020000000001', '121000000001', '123456789000']) expect(t, `the number ${n} is shown`).toContain(n);
    for (const field of ['employerNo', 'dueDay']) expect(html, `the form has "${field}"`).toContain(`name="${field}"`);
    expect(html).toMatch(/<input[^>]*name="agency"[^>]*value="(sss|philhealth|pagibig|bir)"|<input[^>]*value="(sss|philhealth|pagibig|bir)"[^>]*name="agency"/);
    for (const who of [w.manager, w.staff]) {
      const m = plain(await ratesHtml(who));
      expect(m).toContain('You do not have access to this screen');
      for (const n of ['0300000001', '020000000001', '121000000001', '123456789000']) expect(m, `refused page must not show ${n}`).not.toContain(n);
    }
  });
});

describe('what saving changes (kills: the edit is decoration)', () => {
  it('SSS number cleared (no row): recording an SSS payment is refused in words; after the admin saves the number through the action, the same payment records (case 13)', async () => {
    const w = await mkWorld(sql, 's6empeffect');
    await sql`delete from statutory_employers where org_id = ${w.orgId} and agency = 'sss'`;
    const inp = PAY(w);
    let refused = '';
    try {
      await tryPay(w, inp);
    } catch (e) {
      refused = (e as { userMessage?: string; message?: string }).userMessage ?? (e as Error).message;
    }
    expect(refused, 'refused while no SSS employer number is on file').toMatch(/employer/i);
    expect((await save(w.admin, { agency: 'sss', employerNo: '0300000009', dueDay: '10' })).ok).toBeTruthy();
    const ok = await tryPay(w, inp);
    expect(ok.id).toBe(inp.paymentId);
  });

  it('the saved due day moves the month detail due date (SSS October: day 10 -> 2026-11-10; saved 20 -> 2026-11-20)', async () => {
    const w = await mkWorld(sql, 's6empdue');
    const f = (await monthLib())['monthDetailFor' as keyof Awaited<ReturnType<typeof monthLib>>] as unknown as (a: unknown, i: unknown) => Promise<{ dueDate: string | null }>;
    if (typeof f !== 'function') throw new Error('monthDetailFor is not exported from payroll/statutory-payments/lib.ts');
    h.actor = w.admin;
    expect((await f(w.admin, { agency: 'sss', month: '2026-10-01', today: '2026-10-29' })).dueDate).toBe('2026-11-10');
    expect((await save(w.admin, { agency: 'sss', employerNo: '0300000001', dueDay: '20' })).ok).toBeTruthy();
    expect((await f(w.admin, { agency: 'sss', month: '2026-10-01', today: '2026-10-29' })).dueDate).toBe('2026-11-20');
  });
});

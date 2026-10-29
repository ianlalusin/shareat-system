import { config } from 'dotenv';
import postgres from 'postgres';
import { afterAll, describe, expect, it, vi } from 'vitest';

/**
 * T-193 S5 (TESTER) - the record and void ACTIONS, called as the app calls them: the real server action, the session mocked to a real
 * actor, the database reached through the app's own `withOrgPrincipal` (which sets the org but not app.person_id unless the app
 * arranges it). The money moves through the app's action and the ledger is read back raw; no test-only helper stands in for the app.
 * The form's own `paymentId` is taken from the RENDERED /new page, exactly as a browser would submit it.
 *
 * NAMES FIXED BY THIS FILE (apps/erp/src/app/payroll/statutory-payments/actions.ts):
 *   recordStatutoryPaymentAction(formData) - fields paymentId, agency, month, paidOn, moneyAccountId, referenceNo, penalty, notes,
 *       repeated lineStoreId + lineAmount (same order), optional periodOverrideConfirm=on / periodOverrideReason / periodOverrideNote.
 *       Success redirects to /payroll/statutory-payments/<paymentId> with a flash ok; a refusal redirects (a path under
 *       /payroll/statutory-payments) with a flash error that is the domain's SENTENCE, never SQL, never a constraint or table name.
 *   voidStatutoryPaymentAction(formData) - fields paymentId, reason, optional on. Success redirects to the payment's page with a flash ok.
 *   Both take the actor from requireActor(), never from the form, and call the domain (which authorizes remit_statutory itself).
 *
 * MUTANTS: server-minted id (a re-submit pays twice); paymentId ignored; refusals swallowed or shown as raw text; actor read from the
 * form; void without a reason accepted; void leaves the month paid; override fields ignored; manager reaches the domain write.
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

import { closeDb } from '@shareat/db';
import { renderToStaticMarkup } from 'react-dom/server';
import { legsOf, mkWorld, D, C, uid, type World } from '../../../../packages/domain/tests/integration/_fixtures/t193-s3-world';
import { captureRedirect, outcomeOf, pageParamsOf } from '../helpers/flash-jar';
import { givePin } from '../helpers/approval-pin';

const sql = postgres(url, { max: 5 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const ACTIONS = () => import('../../src/app/payroll/statutory-payments/actions');
const newPage = () => import('../../src/app/payroll/statutory-payments/new/page');
const lib = () => import('../../src/app/payroll/statutory-payments/lib');

type Who = { personId: string; orgId: string };
async function act(who: Who, name: 'recordStatutoryPaymentAction' | 'voidStatutoryPaymentAction', fd: FormData) {
  h.actor = who;
  const m = (await ACTIONS()) as unknown as Record<string, (f: FormData) => Promise<void>>;
  if (typeof m[name] !== 'function') throw new Error(`${name} is not exported from payroll/statutory-payments/actions.ts`);
  try {
    const signal = await captureRedirect(() => m[name]!(fd));
    const o = outcomeOf(signal);
    return { error: o.flash.error, ok: o.flash.ok, path: o.path, threw: null as string | null };
  } catch (e) {
    // an action may let the domain's refusal through instead of redirecting; either way it must not have written (judged by the callers)
    return { error: undefined, ok: undefined, path: '', threw: e instanceof Error ? e.message : String(e) };
  }
}
const form = (fields: Record<string, string | string[]>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) for (const x of Array.isArray(v) ? v : [v]) fd.append(k, x);
  return fd;
};

/** The paymentId a browser would post: minted by the rendered /new page. */
async function mintedId(w: World): Promise<string> {
  h.actor = w.admin;
  const mod = await newPage();
  const el = await (mod.default as unknown as (p: unknown) => Promise<unknown>)({ params: Promise.resolve({}), searchParams: Promise.resolve({ agency: 'sss', month: '2026-10-01' }) });
  const html = renderToStaticMarkup(el as never);
  const tag = html.match(/<input[^>]*name="paymentId"[^>]*>/)?.[0] ?? '';
  const id = tag.match(/value="([^"]+)"/)?.[1] ?? '';
  expect(id, `the rendered form's paymentId: ${tag}`).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
  return id;
}

interface Over { [k: string]: string | string[] }
const recordForm = (w: World, paymentId: string, over: Over = {}) =>
  form({
    paymentId,
    agency: 'sss',
    month: '2026-10-01',
    paidOn: '2026-11-10',
    moneyAccountId: w.lipaOffice,
    referenceNo: uid('PRN'),
    penalty: '',
    notes: '',
    lineStoreId: [w.lipa],
    lineAmount: ['3180.00'],
    ...over,
  });

const counts = async (w: World) => {
  const [r] = await sql<{ p: string; l: string; e: string; o: string; a: string }[]>`
    select (select count(*) from statutory_payments where org_id = ${w.orgId})::text as p,
           (select count(*) from statutory_payment_lines where org_id = ${w.orgId})::text as l,
           (select count(*) from journal_entries where org_id = ${w.orgId} and source_type = 'statutory_payment')::text as e,
           (select count(*) from period_overrides where org_id = ${w.orgId})::text as o,
           (select count(*) from audit_log where org_id = ${w.orgId} and action like 'statutory_payment.%')::text as a`;
  return { payments: Number(r!.p), lines: Number(r!.l), entries: Number(r!.e), overrides: Number(r!.o), audit: Number(r!.a) };
};
const NOTHING = { payments: 0, lines: 0, entries: 0, overrides: 0, audit: 0 };
const RAW = /select |insert |update |violates|constraint|statutory_payments|statutory_payment_lines|journal_entries|ERROR:|syntax|relation |SQLSTATE|\bat Object\./i;
const inWords = (e: string | undefined, what: string) => {
  expect(e, `${what}: a refusal is shown`).toBeTruthy();
  expect(e!, `${what}: in words, not SQL (got: ${e})`).not.toMatch(RAW);
  expect(e!, `${what}: no uuid in the sentence a person reads`).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/);
};
const outstandingOf = async (w: World, storeId: string): Promise<string> => {
  const f = (await lib()).monthsFor as unknown as (a: unknown, filter: unknown) => Promise<{ agency: string; month: string; storeId: string; outstanding: string }[]>;
  const rows = await f(w.admin, { agency: 'sss', storeId });
  return rows.find((r) => r.month === '2026-10-01')?.outstanding ?? '0.00';
};
const closeNov = (w: World) => sql`update fiscal_periods set status = 'closed' where org_id = ${w.orgId} and starts_on <= '2026-11-01'`;

// -----------------------------------------------------------------------------------------------------------------
describe('record: the form posts through the app\'s own action', () => {
  it('a full SSS payment for Lipa: ok flash, lands on the payment page, one payment + one entry (Dr 2210 / Cr 1130), created_by the signed-in admin, the month is paid up (kills: paymentId ignored; actor from the form)', async () => {
    const w = await mkWorld(sql, 's5rec');
    const id = await mintedId(w);
    const ref = uid('PRN');
    const r = await act(w.admin, 'recordStatutoryPaymentAction', recordForm(w, id, { referenceNo: ref }));
    expect(r.error, `the action said: ${r.error ?? r.threw}`).toBeUndefined();
    expect(r.ok).toBeTruthy();
    expect(r.path).toBe(`/payroll/statutory-payments/${id}`);
    expect(await counts(w)).toEqual({ payments: 1, lines: 1, entries: 1, overrides: 0, audit: 1 });
    const [p] = await sql<{ id: string; reference_no: string; created_by: string; entry: string }[]>`select id, reference_no, created_by, journal_entry_id as entry from statutory_payments where org_id = ${w.orgId}`;
    expect([p!.id, p!.reference_no, p!.created_by]).toEqual([id, ref, w.adminId]);
    expect(await legsOf(sql, p!.entry)).toEqual([C('1130', 'Lipa', '3180.00'), D('2210', 'Lipa', '3180.00')].sort());
    expect(await outstandingOf(w, w.lipa)).toBe('0.00');
  });

  it('a payment across two stores with a penalty, lines as typed: both stores paid, penalty in 6810 only (kills: only the first line posted; penalty dropped)', async () => {
    const w = await mkWorld(sql, 's5rec2');
    const id = await mintedId(w);
    const r = await act(w.admin, 'recordStatutoryPaymentAction', recordForm(w, id, { lineStoreId: [w.lipa, w.malvar], lineAmount: ['1000.00', '3180.00'], penalty: '63.60' }));
    expect(r.error, `the action said: ${r.error ?? r.threw}`).toBeUndefined();
    expect(await counts(w)).toMatchObject({ payments: 1, lines: 2, entries: 1 });
    expect(await outstandingOf(w, w.lipa)).toBe('2180.00');
    expect(await outstandingOf(w, w.malvar)).toBe('0.00');
    const [pen] = await sql<{ b: string }[]>`
      select coalesce(sum(jl.debit), 0)::numeric(14,2)::text as b from journal_lines jl join journal_entries je on je.id = jl.entry_id
      join accounts a on a.id = jl.account_id where je.org_id = ${w.orgId} and je.source_type = 'statutory_payment' and a.code = '6810'`;
    expect(pen!.b).toBe('63.60');
  });

  it('the SAME form submitted twice (a double click, a back button): ONE payment, ONE entry, and the second answer is not an error (kills: server-minted id)', async () => {
    const w = await mkWorld(sql, 's5resend');
    const id = await mintedId(w);
    const fd = () => recordForm(w, id, { referenceNo: 'PRN-ONCE-1' });
    const first = await act(w.admin, 'recordStatutoryPaymentAction', fd());
    expect(first.error, `first said: ${first.error ?? first.threw}`).toBeUndefined();
    const second = await act(w.admin, 'recordStatutoryPaymentAction', fd());
    expect(second.error, `a re-send must not read as a failure; it said: ${second.error ?? second.threw}`).toBeUndefined();
    expect(second.path).toBe(`/payroll/statutory-payments/${id}`);
    expect(await counts(w)).toEqual({ payments: 1, lines: 1, entries: 1, overrides: 0, audit: 1 });
    expect(await outstandingOf(w, w.lipa), 'paid once, not twice').toBe('0.00');
  });

  it('two RENDERS of the form are two different payments: a second form for the same month is judged on the ceiling, not swallowed as a replay (kills: fixed form id)', async () => {
    const w = await mkWorld(sql, 's5two');
    const a = await mintedId(w);
    const b = await mintedId(w);
    expect(a).not.toBe(b);
    expect((await act(w.admin, 'recordStatutoryPaymentAction', recordForm(w, a))).error).toBeUndefined();
    const second = await act(w.admin, 'recordStatutoryPaymentAction', recordForm(w, b));
    inWords(second.error, 'a second full payment of an already paid month');
    expect(second.error).toMatch(/Lipa/);
    expect((await counts(w)).payments).toBe(1);
  });

  it('the same id with different figures is refused in words and writes nothing more', async () => {
    const w = await mkWorld(sql, 's5diff');
    const id = await mintedId(w);
    await act(w.admin, 'recordStatutoryPaymentAction', recordForm(w, id, { referenceNo: 'PRN-DIFF-1' }));
    const r = await act(w.admin, 'recordStatutoryPaymentAction', recordForm(w, id, { referenceNo: 'PRN-DIFF-1', lineAmount: ['1000.00'] }));
    inWords(r.error, 'same id, different amount');
    expect(r.error).toMatch(/different figures/i);
    expect((await counts(w)).payments).toBe(1);
  });
});

describe('record: refusals are sentences a person can act on, and nothing is written', () => {
  it('overpaying a store: names the store and the figure it owes (kills: ceiling dropped; raw error shown)', async () => {
    const w = await mkWorld(sql, 's5over');
    const r = await act(w.admin, 'recordStatutoryPaymentAction', recordForm(w, await mintedId(w), { lineAmount: ['3180.01'] }));
    inWords(r.error, 'overpay');
    expect(r.error).toMatch(/Lipa/);
    expect(r.error).toMatch(/3,180\.00/);
    expect(await counts(w)).toEqual(NOTHING);
  });

  it('a payment dated in a closed month: the closed-month sentence naming the month, no rows (kills: developer text from postEntry)', async () => {
    const w = await mkWorld(sql, 's5closed');
    await closeNov(w);
    const r = await act(w.admin, 'recordStatutoryPaymentAction', recordForm(w, await mintedId(w)));
    inWords(r.error, 'closed month');
    expect(r.error).toMatch(/November 2026 is closed/);
    expect(await counts(w)).toEqual(NOTHING);
  });

  it('...an administrator who ticks the override box and gives a reason posts it, with exactly one period_overrides row; an unfinished override (box ticked, no reason) is refused in words (kills: override fields ignored)', async () => {
    const w = await mkWorld(sql, 's5override');
    await closeNov(w);
    const half = await act(w.admin, 'recordStatutoryPaymentAction', recordForm(w, await mintedId(w), { periodOverrideConfirm: 'on' }));
    inWords(half.error, 'ticked box without a reason');
    expect(await counts(w)).toEqual(NOTHING);
    const ok = await act(w.admin, 'recordStatutoryPaymentAction', recordForm(w, await mintedId(w), { periodOverrideConfirm: 'on', periodOverrideReason: 'data_entry_error', periodOverrideNote: 'Receipt found after close' }));
    expect(ok.error, `the action said: ${ok.error ?? ok.threw}`).toBeUndefined();
    expect(await counts(w)).toMatchObject({ payments: 1, entries: 1, overrides: 1 });
  });

  it('paid from the Lipa staff float (GL 1120): the staff-float sentence, nothing written (kills: helper not called)', async () => {
    const w = await mkWorld(sql, 's5float');
    const r = await act(w.admin, 'recordStatutoryPaymentAction', recordForm(w, await mintedId(w), { moneyAccountId: w.lipaFloat }));
    inWords(r.error, 'staff float');
    expect(r.error).toMatch(/staff cash float/i);
    expect(await counts(w)).toEqual(NOTHING);
  });

  it('a forged or missing paymentId: "This form is out of date." and nothing written (kills: requireRequestId skipped)', async () => {
    const w = await mkWorld(sql, 's5baduuid');
    for (const bad of ['', 'not-a-uuid', '12345']) {
      const r = await act(w.admin, 'recordStatutoryPaymentAction', recordForm(w, bad));
      inWords(r.error, `paymentId "${bad}"`);
      expect(r.error).toMatch(/out of date/i);
    }
    expect(await counts(w)).toEqual(NOTHING);
  });

  it('a non-numeric amount and a missing reference are sentences too', async () => {
    const w = await mkWorld(sql, 's5words');
    const amount = await act(w.admin, 'recordStatutoryPaymentAction', recordForm(w, await mintedId(w), { lineAmount: ['abc'] }));
    inWords(amount.error, 'amount "abc"');
    const noRef = await act(w.admin, 'recordStatutoryPaymentAction', recordForm(w, await mintedId(w), { referenceNo: '' }));
    inWords(noRef.error, 'blank reference');
    expect(await counts(w)).toEqual(NOTHING);
  });

  it('T-193 S5 keepTyping: a refused record form reopens with the typed receipt no., amount, penalty, notes and paid-on - and none of it is in the address (kills: typing lost on refusal; typed values put in the URL)', async () => {
    const w = await mkWorld(sql, 's5keep');
    const id = await mintedId(w);
    h.actor = w.admin;
    const m = (await ACTIONS()) as unknown as Record<string, (f: FormData) => Promise<void>>;
    const signal = await captureRedirect(() =>
      m.recordStatutoryPaymentAction!(
        recordForm(w, id, { referenceNo: 'PRN-KEEP-7731', paidOn: '2026-11-12', lineAmount: ['3180.01'], penalty: '12.34', notes: 'Typed note keep-9' }),
      ),
    );
    const o = outcomeOf(signal);
    inWords(o.flash.error, 'the overpay that is refused');
    for (const typed of ['PRN-KEEP-7731', '2026-11-12', '3180.01', '12.34', 'keep-9', 'Typed%20note']) {
      expect(signal.url, `"${typed}" must never ride in the address`).not.toContain(typed);
    }
    expect(await counts(w)).toEqual(NOTHING);
    h.actor = w.admin;
    const mod = await newPage();
    const el = await (mod.default as unknown as (p: unknown) => Promise<unknown>)({ params: Promise.resolve({}), searchParams: Promise.resolve(pageParamsOf(signal.url)) });
    const html = renderToStaticMarkup(el as never);
    for (const typed of ['PRN-KEEP-7731', '2026-11-12', '3180.01', '12.34', 'Typed note keep-9']) {
      expect(html, `the reopened form still shows what was typed: "${typed}"`).toContain(typed);
    }
  });

  it('a manager and staff cannot record, whatever the form says (kills: the write reaches the domain without its gate)', async () => {
    const w = await mkWorld(sql, 's5mgr');
    for (const who of [w.manager, w.staff]) {
      const r = await act(who, 'recordStatutoryPaymentAction', recordForm(w, await mintedId(w)));
      expect(r.error !== undefined || r.threw !== null, 'refused, not silently ok').toBe(true);
      expect(r.ok).toBeUndefined();
    }
    expect(await counts(w)).toEqual(NOTHING);
  });
});

describe('void: through the app\'s own action', () => {
  async function paid(hint: string) {
    const w = await mkWorld(sql, hint);
    const id = await mintedId(w);
    const ok = await act(w.admin, 'recordStatutoryPaymentAction', recordForm(w, id, { referenceNo: uid('PRN') }));
    expect(ok.error, `setup: ${ok.error ?? ok.threw}`).toBeUndefined();
    // T-193 S5 ruling A: a void is Tier P - an administrator's PIN, verified on the server against the payment's store.
    const pin = await givePin(sql, { orgId: w.orgId, storeId: w.lipa, personId: w.adminId });
    return { w, id, pin };
  }
  const status = async (id: string) =>
    (await sql<{ status: string; void_reason: string | null }[]>`select status, void_reason from statutory_payments where id = ${id}`)[0]!;

  it('with a reason: ok flash, the payment is voided with that reason, the entry is reversed, and the month is owed again (kills: void leaves the month paid)', async () => {
    const { w, id, pin } = await paid('s5void');
    expect(await outstandingOf(w, w.lipa)).toBe('0.00');
    const r = await act(w.admin, 'voidStatutoryPaymentAction', form({ adminPin: pin, paymentId: id, reason: 'Wrong receipt number' }));
    expect(r.error, `the action said: ${r.error ?? r.threw}`).toBeUndefined();
    expect(r.ok).toBeTruthy();
    expect(r.path).toBe(`/payroll/statutory-payments/${id}`);
    expect(await status(id)).toEqual({ status: 'voided', void_reason: 'Wrong receipt number' });
    const [rev] = await sql<{ n: string }[]>`select count(*)::text as n from journal_entries where org_id = ${w.orgId} and reversal_of_entry_id is not null`;
    expect(Number(rev!.n), 'the payment entry has a reversal (the payroll accruals have none)').toBe(1);
    expect(await outstandingOf(w, w.lipa)).toBe('3180.00');
  });

  it('a blank reason is refused in words and the payment stays posted (kills: void without a reason accepted)', async () => {
    const { w, id, pin } = await paid('s5voidreason');
    for (const reason of ['', '   ']) {
      const r = await act(w.admin, 'voidStatutoryPaymentAction', form({ adminPin: pin, paymentId: id, reason }));
      inWords(r.error, `reason "${reason}"`);
      expect(r.error).toMatch(/reason/i);
    }
    expect((await status(id)).status).toBe('posted');
    expect(await outstandingOf(w, w.lipa)).toBe('0.00');
  });

  it('voiding twice, a non-uuid id and an unknown id are sentences; still exactly one reversal', async () => {
    const { w, id, pin } = await paid('s5void2');
    expect((await act(w.admin, 'voidStatutoryPaymentAction', form({ adminPin: pin, paymentId: id, reason: 'First' }))).error).toBeUndefined();
    const again = await act(w.admin, 'voidStatutoryPaymentAction', form({ adminPin: pin, paymentId: id, reason: 'Second' }));
    inWords(again.error, 'second void');
    expect(again.error).toMatch(/already voided/i);
    for (const bad of ['not-a-uuid', crypto.randomUUID()]) {
      const r = await act(w.admin, 'voidStatutoryPaymentAction', form({ adminPin: pin, paymentId: bad, reason: 'x' }));
      inWords(r.error, `void of ${bad}`);
    }
    const [rev] = await sql<{ n: string }[]>`select count(*)::text as n from journal_entries where org_id = ${w.orgId} and reversal_of_entry_id is not null`;
    expect(Number(rev!.n)).toBe(1);
  });

  it('the payment\'s month closed since: refused in words without `on`; with `on` in an open month it reverses on that date (kills: reversalDate always passed)', async () => {
    const { w, id, pin } = await paid('s5voidclosed');
    await closeNov(w);
    const refused = await act(w.admin, 'voidStatutoryPaymentAction', form({ adminPin: pin, paymentId: id, reason: 'Wrong receipt' }));
    inWords(refused.error, 'void into a closed month');
    expect(refused.error).toMatch(/closed/i);
    expect((await status(id)).status).toBe('posted');
    const ok = await act(w.admin, 'voidStatutoryPaymentAction', form({ adminPin: pin, paymentId: id, reason: 'Wrong receipt', on: '2026-12-05' }));
    expect(ok.error, `the action said: ${ok.error ?? ok.threw}`).toBeUndefined();
    const [rev] = await sql<{ d: string }[]>`select entry_date::text as d from journal_entries where org_id = ${w.orgId} and reversal_of_entry_id is not null`;
    expect(rev!.d).toBe('2026-12-05');
  });

  it('a manager and staff cannot void (kills: the write reaches the domain without its gate)', async () => {
    const { w, id, pin } = await paid('s5voidmgr');
    const mgrPin = await givePin(sql, { orgId: w.orgId, storeId: w.lipa, personId: w.managerId });
    for (const who of [w.manager, w.staff]) {
      const r = await act(who, 'voidStatutoryPaymentAction', form({ adminPin: mgrPin, paymentId: id, reason: 'I do not like it' }));
      expect(r.error !== undefined || r.threw !== null, 'refused, not silently ok').toBe(true);
      expect(r.ok).toBeUndefined();
    }
    expect((await status(id)).status).toBe('posted');
  });

  it('Tier P: the correct admin PIN voids; a missing or wrong PIN is refused in words and writes nothing; a manager PIN is not an administrator PIN (kills: PIN not verified; verified against a form field)', async () => {
    const { w, id, pin } = await paid('s5voidpin');
    const mgrPin = await givePin(sql, { orgId: w.orgId, storeId: w.lipa, personId: w.managerId });
    const wrong = String((Number(pin) % 600000) + 300001).slice(0, 6);
    const reversals = async () => Number((await sql<{ n: string }[]>`select count(*)::text as n from journal_entries where org_id = ${w.orgId} and reversal_of_entry_id is not null`)[0]!.n);
    for (const [what, fields] of [
      ['no PIN', { paymentId: id, reason: 'Wrong receipt' }],
      ['a blank PIN', { adminPin: '', paymentId: id, reason: 'Wrong receipt' }],
      ['a wrong PIN', { adminPin: wrong === pin ? '123456' : wrong, paymentId: id, reason: 'Wrong receipt' }],
      ["a manager's PIN", { adminPin: mgrPin, paymentId: id, reason: 'Wrong receipt' }],
    ] as const) {
      const r = await act(w.admin, 'voidStatutoryPaymentAction', form({ ...fields }));
      inWords(r.error, what);
      expect(r.ok, `${what}: not voided`).toBeUndefined();
      expect((await status(id)).status, `${what}: still posted`).toBe('posted');
      expect(await reversals(), `${what}: nothing written`).toBe(0);
    }
    const ok = await act(w.admin, 'voidStatutoryPaymentAction', form({ adminPin: pin, paymentId: id, reason: 'Wrong receipt' }));
    expect(ok.error, `the correct PIN: ${ok.error ?? ok.threw}`).toBeUndefined();
    expect((await status(id)).status).toBe('voided');
  });
});

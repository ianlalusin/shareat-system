import { config } from 'dotenv';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-193 S4 (TESTER) - `voidStatutoryPayment`: take back a payment to SSS / PhilHealth / Pag-IBIG / BIR.
 * REFRESH.md s4.2 (lock the payment FOR UPDATE, posted only, reverse ONLY its own stored `journal_entry_id`, `reversalDate`
 * only when `on` is given, conditional UPDATE, audit), s5 S4 (cases 8, 20, K4), s1 (`remit_statutory`), old spec "Voiding".
 *
 * NAMES FIXED BY THIS FILE (the builder implements them):
 *   voidStatutoryPayment(tx, actor, { paymentId: string; reason: string; on?: 'YYYY-MM-DD' }) -> { id: string; reversalEntryId: string }
 *   exported from @shareat/domain; audit action 'statutory_payment.void' (entity statutory_payments, entity_id = the payment id,
 *   catalogue: money / high / org / admin-readable / not reserved, owner T-193, exactly like 'statutory_payment.record');
 *   every refusal is a RefusalError with the sentence on `userMessage`, or an AuthorizationError for the capability, and writes NOTHING.
 *   Second void of one payment is REFUSED (not replayed): the spec has no request id on a void.
 *
 * RED TODAY: `voidStatutoryPayment` is not exported from @shareat/domain - every leg fails with "is not a function".
 * MUTANTS (named per leg): voided lines still counted as paid; the reversal copied from the wrong entry / a sibling payment's;
 * reversalDate always passed (moves an open-period reversal off its date); `on` ignored; no reason check; no already-voided check;
 * no payment lock (two reversals); validation before authorize; status flipped without the reversal; audit action reused.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { closeDb, catalogueEntry, statutoryPaymentsRepo, type Tx } from '@shareat/db';
import { recordStatutoryPayment, reverseEntry, voidStatutoryPayment } from '@shareat/domain';
import {
  asOrg, balance, C, count, D, legsOf, mkWorld, paidLines, refusal, uid,
  type PayInput, type PayResult, type World,
} from './_fixtures/t193-s3-world';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });
const sql = postgres(url, { max: 10 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

interface VoidInput {
  paymentId: string;
  reason: string;
  on?: string;
}
interface VoidResult {
  id: string;
  reversalEntryId: string;
}
type VoidFn = (tx: Tx, a: unknown, i: VoidInput) => Promise<VoidResult>;

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
const voidIt = (w: World, v: VoidInput, who = w.admin): Promise<VoidResult> =>
  asOrg(w.orgId, (tx) => (voidStatutoryPayment as unknown as VoidFn)(tx, who, v));
const REASON = 'Wrong reference number on the receipt';

/** `code|store|debit|credit|party` with debit and credit swapped: the exact opposite of a posted entry. */
const mirror = (legs: string[]): string[] =>
  legs
    .map((l) => {
      const [code, store, debit, credit, party] = l.split('|');
      return `${code}|${store}|${credit}|${debit}|${party}`;
    })
    .sort();

interface Snapshot {
  payments: number;
  paymentLines: number;
  entries: number;
  allEntries: number;
  auditRows: number;
  posted: number;
  voided: number;
}
async function snap(w: World): Promise<Snapshot> {
  const [r] = await sql<{ n: string; a: string; au: string; p: string; v: string }[]>`
    select (select count(*) from journal_entries where org_id = ${w.orgId} and source_type = 'statutory_payment')::text as n,
           (select count(*) from journal_entries where org_id = ${w.orgId})::text as a,
           (select count(*) from audit_log where org_id = ${w.orgId} and action like 'statutory_payment.%')::text as au,
           (select count(*) from statutory_payments where org_id = ${w.orgId} and status = 'posted')::text as p,
           (select count(*) from statutory_payments where org_id = ${w.orgId} and status = 'voided')::text as v`;
  return {
    payments: await count(sql, w, 'statutory_payments'),
    paymentLines: await count(sql, w, 'statutory_payment_lines'),
    entries: Number(r!.n),
    allEntries: Number(r!.a),
    auditRows: Number(r!.au),
    posted: Number(r!.p),
    voided: Number(r!.v),
  };
}

async function paymentRow(paymentId: string) {
  const [r] = await sql<{ status: string; void_reason: string | null; voided_by: string | null; voided_at: Date | null; journal_entry_id: string }[]>`
    select status, void_reason, voided_by, voided_at, journal_entry_id from statutory_payments where id = ${paymentId}`;
  return r!;
}
async function entryRow(entryId: string) {
  const [r] = await sql<{ status: string; entry_date: string; reversal_of_entry_id: string | null }[]>`
    select status, entry_date::text, reversal_of_entry_id from journal_entries where id = ${entryId}`;
  return r!;
}
async function reversalsOf(entryId: string): Promise<number> {
  const [r] = await sql<{ n: string }[]>`select count(*)::text as n from journal_entries where reversal_of_entry_id = ${entryId}`;
  return Number(r!.n);
}
async function outstanding(w: World, agency: 'sss' | 'philhealth' | 'pagibig' | 'bir', storeId: string): Promise<{ owed: string; paid: string; outstanding: string }> {
  const rows = await asOrg(w.orgId, (tx) => statutoryPaymentsRepo.monthTotals(tx, w.orgId, { agency, storeId }));
  const row = rows.find((x) => x.month === '2026-10-01' && x.storeId === storeId);
  return { owed: row?.owed ?? '0.00', paid: row?.paid ?? '0.00', outstanding: row?.outstanding ?? '0.00' };
}
/** A refused void left every row exactly as it was. */
async function unchanged(w: World, before: Snapshot): Promise<void> {
  expect(await snap(w), 'a refused void writes nothing: no entry, no audit row, no status change').toEqual(before);
}
const closeMonths = (w: World, through: string, lock?: string) =>
  (async () => {
    await sql`update fiscal_periods set status = 'closed' where org_id = ${w.orgId} and starts_on <= ${through}`;
    if (lock) {
      await sql`update fiscal_periods set status = 'closed' where org_id = ${w.orgId} and starts_on < '2027-01-01'`;
      await sql`update fiscal_periods set status = 'locked' where org_id = ${w.orgId} and starts_on = ${lock}`;
    }
  })();

// -----------------------------------------------------------------------------------------------------------------
describe('case 8 - void a payment: the entry is reversed exactly, the month is owed again', () => {
  it('Lipa pays SSS October 3,180.00 then it is voided: reversal is the exact mirror, original reversed, payment voided with reason/by/at, month owed again (kills: voided lines still counted as paid; reversal not the mirror)', async () => {
    const w = await mkWorld(sql, 'v8');
    const inp = input(w);
    const p = await pay(w, inp);
    expect(await outstanding(w, 'sss', w.lipa), 'paid in full before the void').toEqual({ owed: '3180.00', paid: '3180.00', outstanding: '0.00' });
    const original = await legsOf(sql, p.entryId);

    const v = await voidIt(w, { paymentId: inp.paymentId, reason: REASON });
    expect(v.id).toBe(inp.paymentId);
    expect(v.reversalEntryId).not.toBe(p.entryId);

    expect(await legsOf(sql, v.reversalEntryId), 'the reversal is the exact mirror of the payment entry').toEqual(mirror(original));
    expect(await entryRow(p.entryId)).toMatchObject({ status: 'reversed' });
    expect(await entryRow(v.reversalEntryId)).toMatchObject({ status: 'posted', reversal_of_entry_id: p.entryId });
    expect(await reversalsOf(p.entryId)).toBe(1);

    const row = await paymentRow(inp.paymentId);
    expect(row.status).toBe('voided');
    expect(row.void_reason).toBe(REASON);
    expect(row.voided_by).toBe(w.adminId);
    expect(row.voided_at).not.toBeNull();
    expect(row.journal_entry_id, 'the link to the original entry is kept').toBe(p.entryId);

    // the books are back where payroll left them, and so is what is owed
    expect(await balance(sql, w, '2210', w.lipa)).toBe('-3180.00');
    expect(await balance(sql, w, '1130', w.lipa)).toBe('100000.00');
    expect(await paidLines(sql, w, 'sss', w.lipa), 'a voided payment pays nothing').toBe('0.00');
    expect(await outstanding(w, 'sss', w.lipa), 'the month is owed again').toEqual({ owed: '3180.00', paid: '0.00', outstanding: '3180.00' });
  });

  it('the reversal carries the ORIGINAL entry date when no `on` is given (kills: reversalDate always passed - today / period end moves an open-period reversal off its date)', async () => {
    const w = await mkWorld(sql, 'v8date');
    const inp = input(w, { paidOn: '2026-11-10' });
    const p = await pay(w, inp);
    const v = await voidIt(w, { paymentId: inp.paymentId, reason: REASON });
    expect((await entryRow(v.reversalEntryId)).entry_date).toBe('2026-11-10');
    expect((await entryRow(p.entryId)).entry_date).toBe('2026-11-10');
  });

  it('with `on` in an OPEN month the reversal is dated `on` (kills: `on` ignored)', async () => {
    const w = await mkWorld(sql, 'v8on');
    const inp = input(w);
    await pay(w, inp);
    const v = await voidIt(w, { paymentId: inp.paymentId, reason: REASON, on: '2026-12-05' });
    expect((await entryRow(v.reversalEntryId)).entry_date).toBe('2026-12-05');
  });

  it('cross-store with a penalty: Lipa safe pays MALVAR SSS 3,180.00 + 63.60 penalty; the void mirrors all five legs and every store ends where it started (kills: only the line legs reversed; penalty left in 6810; the 1250/2150 pair left up)', async () => {
    const w = await mkWorld(sql, 'v8cross');
    const inp = input(w, { lines: [{ storeId: w.malvar, amount: '3180.00' }], penalty: '63.60' });
    const p = await pay(w, inp);
    const original = await legsOf(sql, p.entryId);
    expect(original).toEqual(
      [
        D('2210', 'Malvar', '3180.00'),
        C('2150', 'Malvar', '3180.00', `store:${w.codes.lipa}`),
        D('1250', 'Lipa', '3180.00', `store:${w.codes.malvar}`),
        D('6810', 'Lipa', '63.60'),
        C('1130', 'Lipa', '3243.60'),
      ].sort(),
    );
    const v = await voidIt(w, { paymentId: inp.paymentId, reason: REASON });
    expect(await legsOf(sql, v.reversalEntryId)).toEqual(mirror(original));
    expect(await balance(sql, w, '2210', w.malvar)).toBe('-3180.00');
    expect(await balance(sql, w, '2150', w.malvar)).toBe('0.00');
    expect(await balance(sql, w, '1250', w.lipa)).toBe('0.00');
    expect(await balance(sql, w, '6810', w.lipa)).toBe('0.00');
    expect(await balance(sql, w, '1130', w.lipa)).toBe('100000.00');
    expect(await outstanding(w, 'sss', w.malvar)).toEqual({ owed: '3180.00', paid: '0.00', outstanding: '3180.00' });
  });

  it('three stores in one payment from Lipa (K2 shape): each store gets its own mirrored 1250/2150 pair and all three months are owed again (kills: only the first line reversed)', async () => {
    const w = await mkWorld(sql, 'v8three');
    const inp = input(w, { lines: [{ storeId: w.lipa, amount: '3180.00' }, { storeId: w.malvar, amount: '3180.00' }, { storeId: w.rosario, amount: '1000.00' }] });
    const p = await pay(w, inp);
    const original = await legsOf(sql, p.entryId);
    const v = await voidIt(w, { paymentId: inp.paymentId, reason: REASON });
    expect(await legsOf(sql, v.reversalEntryId)).toEqual(mirror(original));
    for (const [store, owed] of [[w.lipa, '3180.00'], [w.malvar, '3180.00'], [w.rosario, '1000.00']] as const) {
      expect(await outstanding(w, 'sss', store), 'owed again').toEqual({ owed, paid: '0.00', outstanding: owed });
    }
    expect(await balance(sql, w, '1130', w.lipa)).toBe('100000.00');
  });

  it("voiding ONE of two partial payments reverses ONLY its own entry and leaves the other standing (DEF-534; kills: the month's payments all voided, or the wrong entry reversed)", async () => {
    const w = await mkWorld(sql, 'v8two');
    const a = input(w, { lines: [{ storeId: w.lipa, amount: '2000.00' }] });
    const b = input(w, { lines: [{ storeId: w.lipa, amount: '1180.00' }] });
    const pa = await pay(w, a);
    const pb = await pay(w, b);
    const v = await voidIt(w, { paymentId: a.paymentId, reason: REASON });
    expect(await legsOf(sql, v.reversalEntryId)).toEqual(mirror(await legsOf(sql, pa.entryId)));
    expect((await entryRow(pa.entryId)).status).toBe('reversed');
    expect((await entryRow(pb.entryId)).status, "the sibling payment's entry is untouched").toBe('posted');
    expect((await paymentRow(b.paymentId)).status).toBe('posted');
    expect(await reversalsOf(pb.entryId)).toBe(0);
    expect(await outstanding(w, 'sss', w.lipa)).toEqual({ owed: '3180.00', paid: '1180.00', outstanding: '2000.00' });
    expect(await balance(sql, w, '2210', w.lipa)).toBe('-2000.00');
  });

  it('after a void the same agency receipt number may be used again, and the month can be paid in full again (case 21 / owed-again; kills: void leaving the receipt or the amount blocked)', async () => {
    const w = await mkWorld(sql, 'v8reuse');
    const a = input(w, { referenceNo: 'PRN-0001' });
    await pay(w, a);
    await voidIt(w, { paymentId: a.paymentId, reason: REASON });
    const again = await pay(w, input(w, { referenceNo: 'PRN-0001' }));
    expect(again.created).toBe(true);
    expect(await outstanding(w, 'sss', w.lipa)).toEqual({ owed: '3180.00', paid: '3180.00', outstanding: '0.00' });
    expect(await balance(sql, w, '2210', w.lipa)).toBe('0.00');
  });

  it("the audit row: action 'statutory_payment.void' on the payment, carrying the reason, next to the record row (kills: record action reused; reason left out)", async () => {
    const w = await mkWorld(sql, 'v8audit');
    const inp = input(w);
    await pay(w, inp);
    await voidIt(w, { paymentId: inp.paymentId, reason: REASON });
    const rows = await sql<{ action: string; entity_id: string; actor_person_id: string; after: Record<string, unknown> | null; store_id: string | null }[]>`
      select action, entity_id, actor_person_id, after, store_id from audit_log where org_id = ${w.orgId} and entity_id = ${inp.paymentId} order by action`;
    expect(rows.map((r) => r.action)).toEqual(['statutory_payment.record', 'statutory_payment.void']);
    const row = rows.find((r) => r.action === 'statutory_payment.void')!;
    expect(row.actor_person_id).toBe(w.adminId);
    expect(row.store_id, 'org-scoped like the record row').toBeNull();
    expect(JSON.stringify(row.after), 'the reason is in the log').toContain(REASON);
  });

  it("the catalogue knows 'statutory_payment.void': money, high, org-scoped, admin-readable, not reserved - the same shape as the record entry (kills: entry missing - append would refuse an unknown action)", () => {
    const rec = catalogueEntry('statutory_payment.record');
    const voided = catalogueEntry('statutory_payment.void');
    expect(voided).toBeDefined();
    expect(voided).toMatchObject({
      category: 'money', sensitivity: 'high', scope: 'org', viewers: 'admin', entity: 'statutory_payments', owner: 'T-193', reserved: false,
    });
    expect(voided?.actor).toBe(rec?.actor);
  });
});

// -----------------------------------------------------------------------------------------------------------------
describe('refusals - in words, and nothing is written', () => {
  async function paid(hint: string) {
    const w = await mkWorld(sql, hint);
    const inp = input(w);
    const p = await pay(w, inp);
    return { w, inp, p, before: await snap(w) };
  }

  it.each([['empty', ''], ['spaces', '   ']])('a %s reason is refused in words: a void needs a reason (kills: no reason check)', async (_n, reason) => {
    const { w, inp, p, before } = await paid(`vr-${_n}`);
    const e = await refusal(voidIt(w, { paymentId: inp.paymentId, reason }), 'a void without a reason');
    expect(e.name).toBe('RefusalError');
    expect(e.userMessage).toMatch(/reason/i);
    expect(e.userMessage).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    await unchanged(w, before);
    expect((await entryRow(p.entryId)).status).toBe('posted');
    expect((await paymentRow(inp.paymentId)).status).toBe('posted');
  });

  it('a second void of the same payment is refused in words, and there is still exactly ONE reversal (kills: no already-voided check; a replay that writes again)', async () => {
    const { w, inp, p } = await paid('vtwice');
    await voidIt(w, { paymentId: inp.paymentId, reason: REASON });
    const before = await snap(w);
    const e = await refusal(voidIt(w, { paymentId: inp.paymentId, reason: 'Again' }), 'a second void');
    expect(e.name).toBe('RefusalError');
    expect(e.userMessage).toMatch(/voided/i);
    await unchanged(w, before);
    expect(await reversalsOf(p.entryId)).toBe(1);
    expect((await paymentRow(inp.paymentId)).void_reason, 'the first reason stands').toBe(REASON);
    expect(await balance(sql, w, '2210', w.lipa)).toBe('-3180.00');
  });

  it("the payment's entry was already reversed by another route: refused in words as a RefusalError (not a plain Error), nothing written, payment stays posted, no second reversal (kills: pre-check removed - reverseEntry throws a plain Error)", async () => {
    const { w, inp, p } = await paid('valready');
    await asOrg(w.orgId, (tx) => reverseEntry(tx, { orgId: w.orgId, entryId: p.entryId, reason: 'Reversed straight in the journal', reversedBy: w.adminId }));
    const before = await snap(w);
    const e = await refusal(voidIt(w, { paymentId: inp.paymentId, reason: REASON }), 'a void of a payment whose entry is already reversed');
    expect(e.name).toBe('RefusalError');
    expect(e.userMessage).toMatch(/already reversed/i);
    expect(e.userMessage).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    await unchanged(w, before);
    expect((await paymentRow(inp.paymentId)).status).toBe('posted');
    expect(await reversalsOf(p.entryId)).toBe(1);
  });

  it('a payment that does not exist is refused in words (no id in the sentence), nothing written', async () => {
    const { w, before } = await paid('vnone');
    const e = await refusal(voidIt(w, { paymentId: crypto.randomUUID(), reason: REASON }), 'a void of a payment that is not there');
    expect(e.name).toBe('RefusalError');
    expect(e.userMessage.length).toBeGreaterThan(0);
    expect(e.userMessage).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    await unchanged(w, before);
  });

  it("another organization's admin cannot void this organization's payment by id: not found, nothing written in either org (case 18; kills: the lookup by id alone)", async () => {
    const { w, inp, before } = await paid('viso-a');
    const other = await mkWorld(sql, 'viso-b');
    const otherBefore = await snap(other);
    const e = await refusal(voidIt(other, { paymentId: inp.paymentId, reason: REASON }), "another org's payment");
    expect(['RefusalError', 'AuthorizationError']).toContain(e.name);
    await unchanged(w, before);
    await unchanged(other, otherBefore);
    expect((await paymentRow(inp.paymentId)).status).toBe('posted');
  });

  it.each([
    ['manager', (w: World) => w.manager],
    ['staff', (w: World) => w.staff],
  ])('a %s is refused with AuthorizationError and nothing is written (case 16; kills: store-scoped capability)', async (_r, who) => {
    const { w, inp, before } = await paid(`vauthz-${_r}`);
    const e = await refusal(voidIt(w, { paymentId: inp.paymentId, reason: REASON }, who(w)), 'a void without the capability');
    expect(e.name).toBe('AuthorizationError');
    await unchanged(w, before);
  });

  it('the capability is checked FIRST: a manager with a blank reason and a junk id still gets AuthorizationError (kills: validation before authorize)', async () => {
    const { w, before } = await paid('vauthzfirst');
    const e = await refusal(voidIt(w, { paymentId: 'junk', reason: '  ' }, w.manager), 'a manager with a broken form');
    expect(e.name).toBe('AuthorizationError');
    await unchanged(w, before);
  });

  it('a manager holding run_payroll or manage_payroll_rates by GRANT is still refused: those are other doors (kills: wrong capability as the gate)', async () => {
    const { w, inp, before } = await paid('vauthzgrant');
    for (const cap of ['run_payroll', 'manage_payroll_rates']) {
      await sql`insert into person_grants (person_id, grant_name, granted_by, grant_source) values (${w.managerId}, ${cap}, ${w.adminId}, 'grant')`;
    }
    const e = await refusal(voidIt(w, { paymentId: inp.paymentId, reason: REASON }, w.manager), 'a void by a manager holding payroll grants');
    expect(e.name).toBe('AuthorizationError');
    await unchanged(w, before);
  });

  it('an admin and a super_admin may void (the cells)', async () => {
    const w = await mkWorld(sql, 'vauthzok');
    const a = input(w, { lines: [{ storeId: w.lipa, amount: '1000.00' }] });
    const b = input(w, { lines: [{ storeId: w.lipa, amount: '1000.00' }] });
    await pay(w, a);
    await pay(w, b);
    await expect(voidIt(w, { paymentId: a.paymentId, reason: REASON }, w.admin)).resolves.toMatchObject({ id: a.paymentId });
    await expect(voidIt(w, { paymentId: b.paymentId, reason: REASON }, w.superAdmin)).resolves.toMatchObject({ id: b.paymentId });
  });
});

// -----------------------------------------------------------------------------------------------------------------
describe('K4 - the month of the payment has closed', () => {
  async function paidNov(hint: string) {
    const w = await mkWorld(sql, hint);
    const inp = input(w, { paidOn: '2026-11-10' });
    const p = await pay(w, inp);
    await closeMonths(w, '2026-11-01');
    return { w, inp, p, before: await snap(w) };
  }

  it('closed month, no `on`: refused in plain words naming the month, nothing written, payment still posted (kills: developer text from reverseEntry; status flipped without the reversal)', async () => {
    const { w, inp, p, before } = await paidNov('k4closed');
    const e = await refusal(voidIt(w, { paymentId: inp.paymentId, reason: REASON }), 'a void into a closed month');
    expect(e.name).toBe('RefusalError');
    expect(e.userMessage).toMatch(/November 2026 is closed/);
    expect(e.userMessage).not.toMatch(/reverseEntry|[0-9a-f]{8}-[0-9a-f]{4}-/);
    await unchanged(w, before);
    expect((await entryRow(p.entryId)).status).toBe('posted');
    expect((await paymentRow(inp.paymentId)).status).toBe('posted');
  });

  it('closed month, `on` in an OPEN month: reversal dated `on`, original reversed, payment voided, month owed again (the replacement for the old closed-month rule)', async () => {
    const { w, inp, p } = await paidNov('k4on');
    const v = await voidIt(w, { paymentId: inp.paymentId, reason: REASON, on: '2026-12-05' });
    expect(await entryRow(v.reversalEntryId)).toMatchObject({ entry_date: '2026-12-05', status: 'posted', reversal_of_entry_id: p.entryId });
    expect((await entryRow(p.entryId)).status).toBe('reversed');
    expect((await paymentRow(inp.paymentId)).status).toBe('voided');
    expect(await outstanding(w, 'sss', w.lipa)).toEqual({ owed: '3180.00', paid: '0.00', outstanding: '3180.00' });
    expect(await balance(sql, w, '2210', w.lipa)).toBe('-3180.00');
  });

  it('`on` itself in a closed month is refused in words, nothing written (same period rules as posting; kills: `on` not checked against the period)', async () => {
    const { w, inp, before } = await paidNov('k4onclosed');
    const e = await refusal(voidIt(w, { paymentId: inp.paymentId, reason: REASON, on: '2026-11-20' }), 'a reversal dated in a closed month');
    expect(e.name).toBe('RefusalError');
    expect(e.userMessage).toMatch(/November 2026 is closed/);
    await unchanged(w, before);
  });

  it('a LOCKED month: refused in words with or without `on` in that month, nothing written', async () => {
    const w = await mkWorld(sql, 'k4locked');
    const inp = input(w, { paidOn: '2026-11-10' });
    await pay(w, inp);
    await closeMonths(w, '2026-11-01', '2026-11-01');
    const before = await snap(w);
    const e1 = await refusal(voidIt(w, { paymentId: inp.paymentId, reason: REASON }), 'a void of a payment in a locked month');
    expect(e1.name).toBe('RefusalError');
    expect(e1.userMessage).toMatch(/November 2026 is (locked|closed)/);
    const e2 = await refusal(voidIt(w, { paymentId: inp.paymentId, reason: REASON, on: '2026-11-25' }), 'a reversal dated in a locked month');
    expect(e2.name).toBe('RefusalError');
    expect(e2.userMessage).toMatch(/November 2026 is (locked|closed)/);
    await unchanged(w, before);
  });

  it('an OPEN payment month with a later month closed needs no `on` and keeps the original date (kills: `on` demanded always)', async () => {
    const w = await mkWorld(sql, 'k4open');
    const inp = input(w, { paidOn: '2026-11-10' });
    await pay(w, inp);
    await closeMonths(w, '2026-10-01'); // October closed, November still open
    const v = await voidIt(w, { paymentId: inp.paymentId, reason: REASON });
    expect((await entryRow(v.reversalEntryId)).entry_date).toBe('2026-11-10');
  });
});

// -----------------------------------------------------------------------------------------------------------------
// Concurrency. A gated two-connection harness (shape of t369-s0 / t366-s1): A does its work and HOLDS its transaction open;
// B starts; we wait until B is parked on a lock; only then A commits. B must wait, then judge what A left behind.
// -----------------------------------------------------------------------------------------------------------------
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
type Settled<T> = { status: 'fulfilled'; value: T } | { status: 'rejected'; reason: unknown };
async function gated<TA, TB>(
  orgId: string,
  opA: (tx: Tx) => Promise<TA>,
  opB: (tx: Tx) => Promise<TB>,
): Promise<{ a: Settled<TA>; b: Settled<TB>; bWaited: boolean }> {
  const aReady = deferred<void>();
  const gate = deferred<void>();
  const aP: Promise<Settled<TA>> = asOrg(orgId, async (tx) => {
    try {
      const value = await opA(tx);
      aReady.resolve();
      await gate.promise;
      return value;
    } catch (err) {
      aReady.resolve();
      throw err;
    }
  }).then((value) => ({ status: 'fulfilled', value }) as const, (reason) => ({ status: 'rejected', reason }) as const);
  await aReady.promise;
  const bPid = deferred<number>();
  const bP: Promise<Settled<TB>> = asOrg(orgId, async (tx) => {
    const rows = await tx.execute(dsql`select pg_backend_pid() as pid`);
    bPid.resolve(Number((rows as unknown as { pid: number }[])[0]?.pid));
    return opB(tx);
  }).then((value) => ({ status: 'fulfilled', value }) as const, (reason) => ({ status: 'rejected', reason }) as const);
  const settled = bP.then(() => true);
  let waited = false;
  const pid = await Promise.race([bPid.promise, settled.then(() => 0)]);
  if (pid) {
    const deadline = Date.now() + 8000;
    while (!waited && Date.now() < deadline) {
      const rows = await sql<{ pid: number }[]>`
        select pid from pg_stat_activity where datname = current_database() and pid = ${pid} and wait_event_type = 'Lock'`;
      if (rows[0]) waited = true;
      else if (await Promise.race([settled, new Promise<boolean>((r) => setTimeout(() => r(false), 20))])) break;
    }
  }
  gate.resolve();
  const [a, b] = await Promise.all([aP, bP]);
  return { a, b, bWaited: waited };
}

describe('case 20 - two voids of one payment at once', () => {
  it('B waits while A holds the payment, then is refused in words: exactly ONE reversal, 2210 Lipa back to -3,180.00 once, not -6,360.00 (kills: no payment lock - two reversals)', async () => {
    const w = await mkWorld(sql, 'v20');
    const inp = input(w);
    const p = await pay(w, inp);
    const run = (tx: Tx) => (voidStatutoryPayment as unknown as VoidFn)(tx, w.admin, { paymentId: inp.paymentId, reason: REASON });
    const { a, b, bWaited } = await gated(w.orgId, run, run);
    expect(a.status, 'A voids').toBe('fulfilled');
    expect(b.status, 'B is refused').toBe('rejected');
    expect((b as { reason: { name?: string } }).reason.name).toBe('RefusalError');
    expect(bWaited, 'B was parked on A\'s lock, not racing past it').toBe(true);
    expect(await reversalsOf(p.entryId)).toBe(1);
    expect(await balance(sql, w, '2210', w.lipa)).toBe('-3180.00');
    expect(await balance(sql, w, '1130', w.lipa)).toBe('100000.00');
    expect((await snap(w)).auditRows, 'record + ONE void').toBe(2);
  });

  it('unsynchronised: two voids fired together give one winner and one refusal, never two reversals', async () => {
    for (let i = 0; i < 3; i++) {
      const w = await mkWorld(sql, `v20b${i}`);
      const inp = input(w);
      const p = await pay(w, inp);
      const results = await Promise.allSettled([
        voidIt(w, { paymentId: inp.paymentId, reason: 'first' }),
        voidIt(w, { paymentId: inp.paymentId, reason: 'second' }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const bad = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')!;
      expect((bad.reason as { name?: string }).name, 'a refusal in words, never a deadlock or a raw database error').toBe('RefusalError');
      expect(await reversalsOf(p.entryId)).toBe(1);
      expect(await balance(sql, w, '2210', w.lipa)).toBe('-3180.00');
    }
  });
});

describe('a void racing a NEW payment for the same month', () => {
  it('the void always lands; the new payment either posts after it or is refused as overpaying - never a deadlock, and paid / the books always agree (kills: lock order that deadlocks; a stale paid figure)', async () => {
    for (let i = 0; i < 4; i++) {
      const w = await mkWorld(sql, `vrace${i}`);
      const first = input(w);
      await pay(w, first);
      const second = input(w);
      const results = await Promise.allSettled([voidIt(w, { paymentId: first.paymentId, reason: REASON }), pay(w, second)]);
      expect(results[0].status, 'the void succeeds').toBe('fulfilled');
      if (results[1].status === 'rejected') {
        expect((results[1].reason as { name?: string }).name, 'a loser is a refusal in words').toBe('RefusalError');
      }
      const paidNow = await paidLines(sql, w, 'sss', w.lipa);
      expect(['0.00', '3180.00'], 'never more than owed').toContain(paidNow);
      expect(paidNow === '3180.00', 'the new payment is posted iff it is the paid amount').toBe(results[1].status === 'fulfilled');
      expect(await balance(sql, w, '2210', w.lipa), 'the books equal owed less paid').toBe(paidNow === '3180.00' ? '0.00' : '-3180.00');
      expect(await balance(sql, w, '1130', w.lipa)).toBe(paidNow === '3180.00' ? '96820.00' : '100000.00');
      expect((await paymentRow(first.paymentId)).status).toBe('voided');
    }
  });
});

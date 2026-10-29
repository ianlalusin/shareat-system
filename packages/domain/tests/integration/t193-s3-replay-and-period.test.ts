import { config } from 'dotenv';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';

/**
 * T-193 S3 (TESTER) - `recordStatutoryPayment`: the form's own request id (safe re-send), the closed-month rule, and the race.
 * REFRESH.md C2 (request id = `statutory_payments.id`, posted through `postEntryOnce`, replay looked up BEFORE the ceiling),
 * C3 (a closed month is refused in plain words BEFORE `postEntry`, as T-487 / T-492; an admin override posts, a locked month
 * never), s4.1 steps 1, 5, 6, 7 and the cases R1-R4, K3, 10, 21 of s5 S3. Precedent: t488-request-id-keys.test.ts,
 * t369-s5-closed-month-override.test.ts, `money-transfers/settle.ts` (replay before the ceiling).
 *
 * RED TODAY: `recordStatutoryPayment` is not exported from @shareat/domain - every leg fails with "is not a function".
 * Names as fixed in t193-s3-posting-legs.test.ts. `periodOverride` is `{ actor, reason, note? }`, the postEntry shape, passed through.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { closeDb } from '@shareat/db';
import { recordStatutoryPayment } from '@shareat/domain';
import {
  asOrg, balance, count, entryCount, legsOf, mkWorld, paidLines, refusal, uid,
  type PayInput, type PayResult, type World,
} from './_fixtures/t193-s3-world';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
const sql = postgres(url, { max: 8 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const DIFFERENT = /already recorded with different figures\. Reload the page and try again\./;
const VOIDED = /This payment was voided\. Reload the page and start a new one\./;
const STALE = /This form is out of date\. Reload the page and try again\./;

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

describe('R1 - the same request id twice is one payment', () => {
  it('same paymentId, same inputs: one payment, one line set, ONE entry; the second call returns the first and writes nothing (kills: server-minted id)', async () => {
    const w = await mkWorld(sql, 'r1');
    const inp = input(w);
    const first = await pay(w, inp);
    const second = await pay(w, { ...inp, lines: [...inp.lines] });
    expect(first.created).toBe(true);
    expect(second).toEqual({ id: first.id, entryId: first.entryId, created: false });
    expect(await count(sql, w, 'statutory_payments')).toBe(1);
    expect(await count(sql, w, 'statutory_payment_lines')).toBe(1);
    expect(await entryCount(sql, w)).toBe(1);
    expect(await balance(sql, w, '1130', w.lipa), 'the safe fell once').toBe('96820.00');
  });

  it('a replay with the lines in another order is still the same payment (compared as a set of store + amount)', async () => {
    const w = await mkWorld(sql, 'r1set');
    const lines = [{ storeId: w.lipa, amount: '3180.00' }, { storeId: w.malvar, amount: '3180.00' }];
    const inp = input(w, { lines });
    const first = await pay(w, inp);
    const second = await pay(w, { ...inp, lines: [...lines].reverse() });
    expect(second).toEqual({ id: first.id, entryId: first.entryId, created: false });
    expect(await entryCount(sql, w)).toBe(1);
  });

  it('an amount sent as 3180 and as 3180.00 is the same figure (kills: string comparison of amounts)', async () => {
    const w = await mkWorld(sql, 'r1fmt');
    const inp = input(w);
    const first = await pay(w, inp);
    const second = await pay(w, { ...inp, lines: [{ storeId: w.lipa, amount: '3180' }] });
    expect(second).toEqual({ id: first.id, entryId: first.entryId, created: false });
  });
});

describe('R3 - a replay after the month is fully paid returns the original, not "overpaying"', () => {
  it('paying the whole month, then re-sending the same form, hands back the first result (kills: replay checked after the ceiling)', async () => {
    const w = await mkWorld(sql, 'r3');
    const inp = input(w);
    const first = await pay(w, inp); // outstanding is now 0.00: a fresh 3,180.00 would be refused as overpaying
    const second = await pay(w, inp);
    expect(second.created).toBe(false);
    expect(second.entryId).toBe(first.entryId);
    expect(await entryCount(sql, w)).toBe(1);
  });

  it('...while a DIFFERENT form for the same, now paid, month is refused as overpaying (the ceiling still stands)', async () => {
    const w = await mkWorld(sql, 'r3b');
    await pay(w, input(w));
    const e = await refusal(pay(w, input(w)), 'a second full payment of a paid month');
    expect(e.name).toBe('RefusalError');
    expect(e.userMessage).toMatch(/Lipa/);
    expect(await entryCount(sql, w)).toBe(1);
  });
});

describe('R2 - the same request id with different figures is refused, nothing new is written', () => {
  type Variant = [name: string, over: (w: World) => Partial<PayInput>];
  // each variant first records `base`, then re-sends the SAME paymentId with ONE field changed
  const variants: Variant[] = [
    ['a different amount', (w) => ({ lines: [{ storeId: w.lipa, amount: '2000.00' }] })],
    ['a different paid_on', () => ({ paidOn: '2026-11-12' })],
    ['a different reference no.', () => ({ referenceNo: 'PRN-OTHER' })],
    ['a different penalty', () => ({ penalty: '63.60' })],
    ['a different money account', (w) => ({ moneyAccountId: w.lipaEwallet })],
    ['a different agency', (w) => ({ agency: 'philhealth', lines: [{ storeId: w.lipa, amount: '1040.00' }] })],
    ['a different month', () => ({ month: '2026-09-01' })],
    ['a different store', (w) => ({ lines: [{ storeId: w.malvar, amount: '3180.00' }] })],
    ['an extra store line', (w) => ({ lines: [{ storeId: w.lipa, amount: '3180.00' }, { storeId: w.rosario, amount: '1000.00' }] })],
  ];
  it.each(variants)('%s (kills: comparison skipped for that field; bare postEntry)', async (_name, over) => {
    const w = await mkWorld(sql, 'r2');
    const base = input(w, { referenceNo: 'PRN-BASE' });
    const first = await pay(w, base);
    const e = await refusal(pay(w, { ...base, ...over(w) }), 'a re-send with different figures');
    expect(e.name).toBe('RefusalError');
    expect(e.userMessage).toMatch(DIFFERENT);
    // nothing new: still the one payment, its original figures, the one entry with its original lines
    expect(await count(sql, w, 'statutory_payments')).toBe(1);
    expect(await count(sql, w, 'statutory_payment_lines')).toBe(1);
    expect(await entryCount(sql, w)).toBe(1);
    const [p] = await sql<{ reference_no: string; paid_on: string; penalty: string; agency: string }[]>`
      select reference_no, paid_on::text, penalty::text, agency from statutory_payments where org_id = ${w.orgId}`;
    expect(p).toEqual({ reference_no: 'PRN-BASE', paid_on: '2026-11-10', penalty: '0.00', agency: 'sss' });
    expect((await legsOf(sql, first.entryId)).length).toBe(2);
  });

  it('a voided payment re-sent is refused with its own sentence, not replayed (it cannot be revived by re-sending the form)', async () => {
    const w = await mkWorld(sql, 'r2void');
    const inp = input(w);
    await pay(w, inp);
    await sql`update statutory_payments set status = 'voided', void_reason = 'test', voided_by = ${w.adminId}, voided_at = now() where id = ${inp.paymentId}`;
    const e = await refusal(pay(w, inp), 'a re-send of a voided payment');
    expect(e.name).toBe('RefusalError');
    expect(e.userMessage).toMatch(VOIDED);
    expect(await entryCount(sql, w)).toBe(1);
  });
});

describe('R4 - a missing or non-uuid request id is "out of date"', () => {
  it.each([
    [undefined, 'missing'],
    [null, 'null'],
    ['', 'empty'],
    ['not-a-uuid', 'garbage'],
    ['12345678-1234-1234-1234-12345678901', 'one character short'],
  ])('paymentId %j (%s) is refused and nothing is written (kills: requireRequestId skipped)', async (id, _why) => {
    const w = await mkWorld(sql, 'r4');
    const e = await refusal(pay(w, input(w, { paymentId: id as never })), 'a form with no request id');
    expect(e.name).toBe('RefusalError');
    expect(e.userMessage).toMatch(STALE);
    await nothingWritten(w);
  });
});

describe('different forms are different payments (the key is the form id, not the figures)', () => {
  it('two payments of 1,000.00 on the same day for the same store, with different ids and different receipts, are TWO entries (kills: key built from document + date + amount)', async () => {
    const w = await mkWorld(sql, 'two');
    const a = await pay(w, input(w, { lines: [{ storeId: w.lipa, amount: '1000.00' }] }));
    const b = await pay(w, input(w, { lines: [{ storeId: w.lipa, amount: '1000.00' }] }));
    expect(a.entryId).not.toBe(b.entryId);
    expect(a.created && b.created).toBe(true);
    expect(await entryCount(sql, w)).toBe(2);
    expect(await paidLines(sql, w, 'sss', w.lipa)).toBe('2000.00');
  });
});

describe('case 21 - the agency receipt is unique to one payment', () => {
  it('a second payment with the same agency and reference no. is refused, nothing new is written (kills: no double-submit guard)', async () => {
    const w = await mkWorld(sql, 'refdup');
    await pay(w, input(w, { referenceNo: 'PRN-0001', lines: [{ storeId: w.lipa, amount: '1000.00' }] }));
    await refusal(pay(w, input(w, { referenceNo: 'PRN-0001', lines: [{ storeId: w.lipa, amount: '500.00' }] })), 'the same receipt twice');
    expect(await count(sql, w, 'statutory_payments')).toBe(1);
    expect(await entryCount(sql, w)).toBe(1);
    expect(await paidLines(sql, w, 'sss', w.lipa)).toBe('1000.00');
  });

  it('the same reference no. at ANOTHER agency is a different receipt and is allowed', async () => {
    const w = await mkWorld(sql, 'refother');
    await pay(w, input(w, { referenceNo: 'REF-1', lines: [{ storeId: w.lipa, amount: '1000.00' }] }));
    await expect(pay(w, input(w, { agency: 'philhealth', referenceNo: 'REF-1', lines: [{ storeId: w.lipa, amount: '1040.00' }] }))).resolves.toMatchObject({ created: true });
  });

  it('after the first is voided, the reference no. may be used again (the unique index is partial on posted payments)', async () => {
    const w = await mkWorld(sql, 'refvoid');
    const first = await pay(w, input(w, { referenceNo: 'PRN-0001' }));
    await sql`update statutory_payments set status = 'voided', void_reason = 'test', voided_by = ${w.adminId}, voided_at = now() where id = ${first.id}`;
    await expect(pay(w, input(w, { referenceNo: 'PRN-0001' }))).resolves.toMatchObject({ created: true });
  });
});

describe('K3 - the month the payment is dated in', () => {
  // periods close in order: every earlier month is closed first, then the named one takes its status
  const closeMonth = async (w: World, starts: string, status: 'closed' | 'locked') => {
    if (status === 'closed') {
      await sql`update fiscal_periods set status = 'closed' where org_id = ${w.orgId} and starts_on <= ${starts}`;
    } else {
      // a locked month needs the whole year closed (the database refuses an open period in a locked year)
      await sql`update fiscal_periods set status = 'closed' where org_id = ${w.orgId} and starts_on < '2027-01-01'`;
      await sql`update fiscal_periods set status = 'locked' where org_id = ${w.orgId} and starts_on = ${starts}`;
    }
  };
  const OVERRIDE = (w: World) => ({ actor: w.admin, reason: 'data_entry_error' as const, note: 'Agency receipt found after the books closed' });

  it("paid_on in a CLOSED month: refused in plain words naming the month, no rows at all (kills: developer text from postEntry; a payment row left outside the transaction)", async () => {
    const w = await mkWorld(sql, 'closed');
    await closeMonth(w, '2026-11-01', 'closed');
    const e = await refusal(pay(w, input(w)), 'a payment dated in a closed month');
    expect(e.name).toBe('RefusalError');
    expect(e.userMessage).toMatch(/November 2026 is closed\. Ask an administrator to post this one entry into it\./);
    expect(e.userMessage).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/); // no ids in the sentence a person reads
    await nothingWritten(w);
    expect(await count(sql, w, 'period_overrides')).toBe(0);
  });

  it('...an administrator posts it with a typed reason: it posts, exactly ONE period_overrides row (actor, reason, note, period_status_at_post = closed)', async () => {
    const w = await mkWorld(sql, 'override');
    await closeMonth(w, '2026-11-01', 'closed');
    const inp = input(w, { periodOverride: OVERRIDE(w) });
    const r = await pay(w, inp);
    expect(r.created).toBe(true);
    expect(await entryCount(sql, w)).toBe(1);
    const rows = await sql<{ entry_id: string; actor_person_id: string; reason: string; note: string | null; period_status_at_post: string }[]>`
      select entry_id, actor_person_id, reason, note, period_status_at_post from period_overrides where org_id = ${w.orgId}`;
    expect(rows).toEqual([
      { entry_id: r.entryId, actor_person_id: w.adminId, reason: 'data_entry_error', note: 'Agency receipt found after the books closed', period_status_at_post: 'closed' },
    ]);
    expect(await legsOf(sql, r.entryId)).toHaveLength(2);
  });

  it('...an override on an OPEN month is not needed and writes no period_overrides row (kills: override recorded on every call)', async () => {
    const w = await mkWorld(sql, 'override-open');
    const r = await pay(w, input(w, { periodOverride: OVERRIDE(w) }));
    expect(r.created).toBe(true);
    expect(await count(sql, w, 'period_overrides')).toBe(0);
  });

  it('a LOCKED month is refused even with the override, in words, no rows (a locked month never takes a posting)', async () => {
    const w = await mkWorld(sql, 'locked');
    await closeMonth(w, '2026-11-01', 'locked');
    const e = await refusal(pay(w, input(w, { periodOverride: OVERRIDE(w) })), 'a payment dated in a locked month');
    expect(e.name).toBe('RefusalError');
    expect(e.userMessage).toMatch(/November 2026 is locked\. Nothing can be posted into it, not even with the closed-month override\./);
    await nothingWritten(w);
    expect(await count(sql, w, 'period_overrides')).toBe(0);
  });

  it('no fiscal period for the date: refused in words, no rows (the period check runs before anything is written)', async () => {
    const w = await mkWorld(sql, 'noperiod');
    const e = await refusal(pay(w, input(w, { paidOn: '2027-06-10' })), 'a payment dated where no period exists');
    expect(e.name).toBe('RefusalError');
    expect(e.userMessage).toMatch(/There is no fiscal period for/);
    await nothingWritten(w);
  });

  it("the closed-month refusal comes BEFORE the ceiling and the money checks: a closed month with an over-the-ceiling line still says 'closed'", async () => {
    const w = await mkWorld(sql, 'closedfirst');
    await closeMonth(w, '2026-11-01', 'closed');
    const e = await refusal(pay(w, input(w, { lines: [{ storeId: w.lipa, amount: '9999.00' }] })), 'a closed month and an overpayment');
    expect(e.userMessage).toMatch(/November 2026 is closed/);
  });

  it('the override needs the capability: a manager (who cannot record at all) cannot smuggle one in as someone else (the override actor is checked, not trusted)', async () => {
    const w = await mkWorld(sql, 'override-mgr');
    await closeMonth(w, '2026-11-01', 'closed');
    // the admin records, but names the MANAGER as the override actor: authorize(override_period_lock) must refuse it
    const e = await refusal(pay(w, input(w, { periodOverride: { actor: w.manager, reason: 'data_entry_error', note: 'x' } })), 'an override by a manager');
    expect(e.name === 'AuthorizationError' || e.name === 'RefusalError').toBe(true);
    await nothingWritten(w);
  });
});

describe('ruling (coordinator, 29 Oct) - REPLAY FIRST, then the closed-month check, then the ceiling', () => {
  const closeNov = async (w: World) => {
    await sql`update fiscal_periods set status = 'closed' where org_id = ${w.orgId} and starts_on <= '2026-11-01'`;
  };

  it('post, close the month, re-send the same form: the original { id, entryId, created: false } comes back and nothing is written (kills: period check before the replay lookup)', async () => {
    const w = await mkWorld(sql, 'replay-closed');
    const inp = input(w);
    const first = await pay(w, inp);
    await closeNov(w);
    const again = await pay(w, inp);
    expect(again).toEqual({ id: first.id, entryId: first.entryId, created: false });
    expect(await count(sql, w, 'statutory_payments')).toBe(1);
    expect(await entryCount(sql, w)).toBe(1);
    expect(await count(sql, w, 'period_overrides')).toBe(0);
  });

  it('...the same id with a DIFFERENT payload after the close is refused in words as different figures, not as a closed month, and nothing is written (kills: comparison skipped when the month is closed)', async () => {
    const w = await mkWorld(sql, 'replay-closed-diff');
    const inp = input(w);
    await pay(w, inp);
    await closeNov(w);
    const e = await refusal(pay(w, { ...inp, lines: [{ storeId: w.lipa, amount: '2000.00' }] }), 're-send with other figures into a closed month');
    expect(e.name).toBe('RefusalError');
    expect(e.userMessage).toMatch(DIFFERENT);
    expect(await count(sql, w, 'statutory_payments')).toBe(1);
    expect(await entryCount(sql, w)).toBe(1);
  });

  it('...while a NEW form dated into that closed month is still refused as closed (the month rule stands for everything that is not a replay)', async () => {
    const w = await mkWorld(sql, 'replay-closed-new');
    await pay(w, input(w, { lines: [{ storeId: w.lipa, amount: '1000.00' }] }));
    await closeNov(w);
    const e = await refusal(pay(w, input(w, { lines: [{ storeId: w.lipa, amount: '1000.00' }] })), 'a new form into a closed month');
    expect(e.userMessage).toMatch(/November 2026 is closed/);
    expect(await entryCount(sql, w)).toBe(1);
  });
});

describe('case 10 - two simultaneous full payments for one store and month', () => {
  it('both try to pay Lipa SSS October 3,180.00 at once: exactly one posts, the other is refused as overpaying; paid is 3,180.00, one entry (kills: run lock removed - paid 6,360.00)', async () => {
    const w = await mkWorld(sql, 'race');
    const results = await Promise.allSettled([pay(w, input(w)), pay(w, input(w))]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const bad = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect((bad[0]!.reason as { name?: string }).name).toBe('RefusalError');
    expect(await paidLines(sql, w, 'sss', w.lipa)).toBe('3180.00');
    expect(await entryCount(sql, w)).toBe(1);
    expect(await count(sql, w, 'statutory_payments')).toBe(1);
    expect(await balance(sql, w, '2210', w.lipa)).toBe('0.00');
  });

  it('the same form sent twice at once (a double click) is one payment, both calls answer with it (kills: ON CONFLICT without the comparison; two entries)', async () => {
    const w = await mkWorld(sql, 'dbl');
    const inp = input(w);
    const results = await Promise.allSettled([pay(w, inp), pay(w, inp)]);
    const ok = results.filter((r): r is PromiseFulfilledResult<PayResult> => r.status === 'fulfilled');
    expect(ok.length, 'at least one succeeds, and a loser is a refusal in words, never a raw database error').toBeGreaterThanOrEqual(1);
    for (const r of results) if (r.status === 'rejected') expect((r.reason as { name?: string }).name).toBe('RefusalError');
    if (ok.length === 2) expect(ok[0]!.value.entryId).toBe(ok[1]!.value.entryId);
    expect(await entryCount(sql, w)).toBe(1);
    expect(await count(sql, w, 'statutory_payments')).toBe(1);
    expect(await balance(sql, w, '1130', w.lipa)).toBe('96820.00');
  });
});

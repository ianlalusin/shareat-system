import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-511 S5b (TESTER, 2026-11-05) - the review domain on a REAL Postgres (a `_test` database via TEST_DATABASE_URL): `rejectDay`, `reopenDay`,
 * `overrideLoanAllocation`, `listReviewDays`. docs/tasks/511-settlement-upload-s5-spec.md "S5b" item 4 and "Tests"; design Components F and G, decision 13.
 *
 * RED today, for one reason: `packages/domain/src/settlement-intake/review.ts` does not exist (the import below cannot resolve).
 *
 * CONTRACT (tester's choices where the spec leaves a signature open; the builder must meet these or ask BOSS to change the tests):
 *  R1  `rejectDay(tx, actor, { lineId, reason }): Promise<{ lineId: string }>`. Order: read the line, `authorize` at the LINE's store, THEN the field rules on the
 *      reason (T-364: nothing about the data is said before the gate), then the compare-and-set `update ... where id = ? and is_current and review_state = 'pending'`
 *      (a refused decision changes nothing and writes no audit row). Capability: the existing record-settlement one (`record_ar_collection`); NO new capability.
 *      A manager of another store and a staff member are refused by `authorize` (AuthorizationError); an unknown or another org's line, a non-current line and a
 *      line that is not pending are a RefusalError with a plain sentence (no UUID, no store name). Decision columns: decision_reason (trimmed), decided_by = actor,
 *      decided_at = now, settlement_id stays null. Audit: 'settlement_day.rejected', entity_id = the line, store_id = the line's store, before/after state. Posts NOTHING.
 *  R2  `reopenDay(tx, actor, { lineId })`: admin only (the existing admin-level gate, no new capability). A manager, even of that store, is refused. Only a CURRENT
 *      REJECTED line reopens (a pending, booked or non-current line is a RefusalError); the update is compare-and-set on those; it sets review_state 'pending' and
 *      nulls decision_reason, decided_by, decided_at (the review-shape CHECK holds). Audit 'settlement_day.reopened' (entity_id = the line, store_id = the line's store).
 *  R3  `overrideLoanAllocation(tx, actor, { lineId, allocations: { loanId: string; amount: string }[] })`: admin only. Only a CURRENT GRAB line that has deduction
 *      loan lines; amounts must be positive, every loan must exist in the org, and they must add up to the line's loan deduction (else RefusalError, nothing changes).
 *      Effect: every ACTIVE deduction loan line of the day line is flipped is_active = false (never deleted, `is_active` is the only updatable column); one NEW active
 *      deduction line per allocation is inserted with loan_id, allocation_source 'admin' and the next row ordinals; disbursal lines are untouched. Audit
 *      'settlement_loan.allocation_overridden' (entity_id = the line id, store_id = the line's store).
 *  R4  `listReviewDays(tx, actor, filters?): Promise<{ days: ReviewDayRow[]; pandagoOnly: PandagoOnlyInvoice[] }>`. filters = { needsAttention?: boolean; storeId?: string;
 *      platform?: 'grab' | 'foodpanda'; period?: 'YYYY-MM' (the month of the sales date) }. Scoping: a channel's rows are visible when `can(tx, actor, 'record_ar_collection',
 *      { storeId })` for the channel's store (admin: every store of the org); staff: nothing (an empty list or an AuthorizationError). Never another org's rows.
 *      Row (ReviewDayRow) = { lineId, storeId, storeName, platform, salesDate, invoiceNumber: string | null (Foodpanda: the invoice; Grab: null), fileFigure: string (the
 *      file's order value), staffFigure: string | null, difference: string | null (file minus staff; BOTH re-read FRESH from the sales day, never the line's snapshot),
 *      reviewState, paidState, changedSinceBooked, loanCheck: { status, sentence } | null (Grab only; null for Foodpanda), blockers: string[] (sentences, from dayBlockers),
 *      needsAttention: boolean (any blocker, or a difference that is not zero, or changedSinceBooked) }. Sorted by salesDate then store name; rows of one Foodpanda
 *      invoice are contiguous.
 *      `pandagoOnly` = invoices that hold only PandaGO items (no sales day, no row, no review state): { uploadId, storeId, storeName, invoiceNumber, workbookDate
 *      (the invoice date the workbook carries, YYYY-MM-DD), pandagoNetTotal, pandagoReceivable (both from the stored file), sentence } in the same store scope.
 *  R5  A current-line version is a row; superseded versions are never listed.
 *
 * Expected figures come from the fixtures and the S4 oracle, never from the code under test. Real Postgres on a scratch database whose name contains "_test".
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { closeDb, RefusalError } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import { inMemoryDriver, setStorageDriver } from '@shareat/domain';
import { ingestSettlementFile } from '../../src/settlement-intake/ingest';
import { listReviewDays, overrideLoanAllocation, rejectDay, reopenDay } from '../../src/settlement-intake/review';
import {
  LIPA_FP, MALVAR_FP, UUID_RE, asOrg, attempt, auditRows, bookLine, ledgerCount, lineOn, lineRows, loanLineRows, mkLoan, postedSalesDay as salesDay, settlementCount,
  setDestination, stageGrabOctober, synthFoodpanda, upload, world3, type World3,
} from './_fixtures/t511-s5-world';

const sql = postgres(url, { max: 8 });
beforeEach(() => setStorageDriver(inMemoryDriver()));
afterAll(async () => {
  setStorageDriver(null);
  await closeDb();
  await sql.end({ timeout: 5 });
});

type File = { bytes: Buffer; contentType: string };
const ingest = (w: World3, actor: Actor, f: File) => asOrg(w.orgId, (tx) => ingestSettlementFile(tx, actor, { bytes: f.bytes, contentType: f.contentType }));
const zip = (b: Buffer): File => ({ bytes: b, contentType: 'application/zip' });
let tagSeq = 0;
const tag = (): string => `s5b-${Date.now()}-${++tagSeq}`;

/** One Foodpanda day, staged by the store's own manager: a one-order synthetic invoice (real vendor code, controllable revenue). */
async function stageFpDay(w: World3, who: Actor, vendor: string, channelId: string, date: string, revenue: number) {
  await ingest(w, who, zip(synthFoodpanda([{ date, revenue }], vendor, tag())));
  return lineOn(sql, w.orgId, channelId, date);
}

const reject = (w: World3, who: Actor, lineId: string, reason: string) => asOrg(w.orgId, (tx) => rejectDay(tx, who, { lineId, reason }));
const reopen = (w: World3, who: Actor, lineId: string) => asOrg(w.orgId, (tx) => reopenDay(tx, who, { lineId }));
const list = (w: World3, who: Actor, filters?: Parameters<typeof listReviewDays>[2]) => asOrg(w.orgId, (tx) => listReviewDays(tx, who, filters));

/* ================================================================== rejectDay */

describe('T-511 S5b rejectDay', () => {
  it('happy path: the line is rejected with the trimmed reason, who and when are recorded, no figure moves, the audit row is written, and NOTHING is posted [kills: money moved; decision columns missing; no audit; settlement id set]', async () => {
    const w = await world3(sql, 'rej-happy');
    const before = await stageFpDay(w, w.managerA, LIPA_FP, w.fpA, '2026-10-12', 1000);
    const ledger = await ledgerCount(sql, w.orgId);
    const settlements = await settlementCount(sql, w.orgId);
    await reject(w, w.managerA, before.id, '  Payout does not match the statement  ');
    const after = await lineOn(sql, w.orgId, w.fpA, '2026-10-12');
    expect(after).toMatchObject({
      id: before.id, review_state: 'rejected', decision_reason: 'Payout does not match the statement', decided_by: w.managerA.personId, settlement_id: null, is_current: true,
      order_value: before.order_value, net_payout: before.net_payout, version: before.version,
    });
    expect(after.decided_at).toBeInstanceOf(Date);
    expect(await ledgerCount(sql, w.orgId)).toBe(ledger);
    expect(await settlementCount(sql, w.orgId)).toBe(settlements);
    const a = await auditRows(sql, w.orgId, 'settlement_day.rejected');
    expect(a.length).toBe(1);
    expect(a[0]).toMatchObject({ entity_id: before.id, store_id: w.storeA, actor_person_id: w.managerA.personId, source: 'web' });
  });

  it('a reason is required: empty and blank are refused with a sentence about the reason; the line stays pending and no audit row exists [kills: reject without a reason]', async () => {
    const w = await world3(sql, 'rej-reason');
    const line = await stageFpDay(w, w.managerA, LIPA_FP, w.fpA, '2026-10-12', 1000);
    for (const reason of ['', '   ', '\n\t']) {
      const r = await attempt(() => reject(w, w.managerA, line.id, reason));
      expect(r.ok, JSON.stringify(reason)).toBe(false);
      if (r.ok) continue;
      expect(r.error).toBeInstanceOf(RefusalError);
      expect((r.error as RefusalError).userMessage).toMatch(/reason/i);
      expect((r.error as RefusalError).userMessage).not.toMatch(UUID_RE);
    }
    expect((await lineOn(sql, w.orgId, w.fpA, '2026-10-12')).review_state).toBe('pending');
    expect((await auditRows(sql, w.orgId, 'settlement_day.rejected')).length).toBe(0);
  });

  it('the gate comes before the data: a staff member with a blank reason gets the permission refusal, not a sentence about the reason [kills: field rules before authorize]', async () => {
    const w = await world3(sql, 'rej-gate');
    const line = await stageFpDay(w, w.managerA, LIPA_FP, w.fpA, '2026-10-12', 1000);
    const r = await attempt(() => reject(w, w.staff, line.id, ''));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(AuthorizationError);
  });

  it('a second reject is refused: the first reason and decision stay, one audit row [kills: compare-and-set missing; second decision overwrites the first]', async () => {
    const w = await world3(sql, 'rej-twice');
    const line = await stageFpDay(w, w.managerA, LIPA_FP, w.fpA, '2026-10-12', 1000);
    await reject(w, w.managerA, line.id, 'First reason');
    const r = await attempt(() => reject(w, w.admin, line.id, 'Second reason'));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(RefusalError);
      expect((r.error as RefusalError).userMessage).not.toMatch(UUID_RE);
    }
    expect(await lineOn(sql, w.orgId, w.fpA, '2026-10-12')).toMatchObject({ decision_reason: 'First reason', decided_by: w.managerA.personId });
    expect((await auditRows(sql, w.orgId, 'settlement_day.rejected')).length).toBe(1);
  });

  it('two people rejecting the same day at the same moment: exactly one wins, the other is refused with a sentence, one audit row [kills: a race that records two decisions]', async () => {
    const w = await world3(sql, 'rej-race');
    const line = await stageFpDay(w, w.managerA, LIPA_FP, w.fpA, '2026-10-12', 1000);
    const [a, b] = await Promise.allSettled([reject(w, w.managerA, line.id, 'Manager says no'), reject(w, w.admin, line.id, 'Admin says no')]);
    const won = [a, b].filter((x) => x.status === 'fulfilled');
    const lost = [a, b].filter((x) => x.status === 'rejected') as PromiseRejectedResult[];
    expect(won.length).toBe(1);
    expect(lost.length).toBe(1);
    expect(lost[0]!.reason).toBeInstanceOf(RefusalError);
    expect((await auditRows(sql, w.orgId, 'settlement_day.rejected')).length).toBe(1);
  });

  it('a line replaced by a newer file cannot be rejected; the new version stays pending [kills: deciding a stale line]', async () => {
    const w = await world3(sql, 'rej-stale');
    const v1 = await stageFpDay(w, w.managerA, LIPA_FP, w.fpA, '2026-10-12', 1000);
    const v2 = await stageFpDay(w, w.managerA, LIPA_FP, w.fpA, '2026-10-12', 1100);
    expect(v2.id).not.toBe(v1.id);
    expect(v2.version).toBe(2);
    const r = await attempt(() => reject(w, w.managerA, v1.id, 'Too late'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(RefusalError);
    expect((await lineRows(sql, w.orgId, w.fpA)).map((l) => [l.version, l.review_state])).toEqual([[1, 'pending'], [2, 'pending']]);
    expect((await auditRows(sql, w.orgId, 'settlement_day.rejected')).length).toBe(0);
  });

  it('a booked line cannot be rejected [kills: rejecting a day that is already in the books]', async () => {
    const w = await world3(sql, 'rej-booked');
    const line = await stageFpDay(w, w.managerA, LIPA_FP, w.fpA, '2026-10-12', 1000);
    await bookLine(sql, w, line.id);
    const r = await attempt(() => reject(w, w.admin, line.id, 'Changed my mind'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(RefusalError);
    expect((await lineOn(sql, w.orgId, w.fpA, '2026-10-12')).review_state).toBe('booked');
  });

  it('a manager of another store, and another org\'s admin, cannot reject: refused, nothing changes, the sentence names no store [kills: store scope missing; cross-org write]', async () => {
    const w = await world3(sql, 'rej-scope');
    const other = await world3(sql, 'rej-scope-other');
    const line = await stageFpDay(w, w.managerA, LIPA_FP, w.fpA, '2026-10-12', 1000);
    for (const who of [{ w, actor: w.managerB }, { w: other, actor: other.admin }]) {
      const r = await attempt(() => reject(who.w, who.actor, line.id, 'Not mine'));
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.error instanceof AuthorizationError || r.error instanceof RefusalError).toBe(true);
      expect(`${r.error.message} ${(r.error as RefusalError).userMessage ?? ''}`).not.toMatch(/Lipa|Malvar|Banay/);
      expect(`${r.error.message} ${(r.error as RefusalError).userMessage ?? ''}`).not.toMatch(/violates|constraint|relation "/i);
    }
    expect((await lineOn(sql, w.orgId, w.fpA, '2026-10-12')).review_state).toBe('pending');
  });

  it('an id that does not exist is a plain refusal, never a database error [kills: raw error]', async () => {
    const w = await world3(sql, 'rej-unknown');
    const r = await attempt(() => reject(w, w.admin, '00000000-0000-4000-8000-0000000000ff', 'Nothing here'));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(RefusalError);
      expect((r.error as RefusalError).userMessage).not.toMatch(UUID_RE);
    }
  });
});

/* ================================================================== reopenDay */

describe('T-511 S5b reopenDay (admin only, owner decision 13)', () => {
  async function rejected(hint: string) {
    const w = await world3(sql, hint);
    const line = await stageFpDay(w, w.managerA, LIPA_FP, w.fpA, '2026-10-12', 1000);
    await reject(w, w.managerA, line.id, 'Wrong payout');
    return { w, line };
  }

  it('an admin reopens a rejected day: pending again, reason, who and when cleared (the review-shape CHECK holds), audited [kills: a decision left behind; no audit]', async () => {
    const { w, line } = await rejected('reopen-happy');
    await reopen(w, w.admin, line.id);
    const after = await lineOn(sql, w.orgId, w.fpA, '2026-10-12');
    expect(after).toMatchObject({ id: line.id, review_state: 'pending', decision_reason: null, decided_by: null, decided_at: null, settlement_id: null, is_current: true });
    const a = await auditRows(sql, w.orgId, 'settlement_day.reopened');
    expect(a.length).toBe(1);
    expect(a[0]).toMatchObject({ entity_id: line.id, store_id: w.storeA, actor_person_id: w.admin.personId, source: 'web' });
  });

  it('a manager - even of that very store - is refused; the day stays rejected [kills: reopen open to managers]', async () => {
    const { w, line } = await rejected('reopen-manager');
    const r = await attempt(() => reopen(w, w.managerA, line.id));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(AuthorizationError);
    expect((await lineOn(sql, w.orgId, w.fpA, '2026-10-12')).review_state).toBe('rejected');
    expect((await auditRows(sql, w.orgId, 'settlement_day.reopened')).length).toBe(0);
  });

  it('only a rejected day reopens: a pending day and a booked day are refused with a sentence [kills: reopen on any state]', async () => {
    const w = await world3(sql, 'reopen-state');
    const pending = await stageFpDay(w, w.managerA, LIPA_FP, w.fpA, '2026-10-12', 1000);
    const booked = await stageFpDay(w, w.managerB, MALVAR_FP, w.fpB, '2026-10-12', 900);
    await bookLine(sql, w, booked.id);
    for (const id of [pending.id, booked.id]) {
      const r = await attempt(() => reopen(w, w.admin, id));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBeInstanceOf(RefusalError);
    }
    expect((await lineOn(sql, w.orgId, w.fpB, '2026-10-12')).review_state).toBe('booked');
  });

  it('a rejected line that a newer file already replaced cannot be reopened [kills: reopening a stale version]', async () => {
    const { w, line } = await rejected('reopen-stale');
    await stageFpDay(w, w.managerA, LIPA_FP, w.fpA, '2026-10-12', 1100);
    const r = await attempt(() => reopen(w, w.admin, line.id));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(RefusalError);
  });

  it('the whole cycle: reject, reopen, reject again with a new reason works; two reject audits and one reopen audit [kills: a state that cannot be decided twice]', async () => {
    const { w, line } = await rejected('reopen-cycle');
    await reopen(w, w.admin, line.id);
    await reject(w, w.managerA, line.id, 'Second look: still wrong');
    expect(await lineOn(sql, w.orgId, w.fpA, '2026-10-12')).toMatchObject({ review_state: 'rejected', decision_reason: 'Second look: still wrong' });
    expect((await auditRows(sql, w.orgId, 'settlement_day.rejected')).length).toBe(2);
    expect((await auditRows(sql, w.orgId, 'settlement_day.reopened')).length).toBe(1);
  });
});

/* ================================================================== overrideLoanAllocation */

describe('T-511 S5b overrideLoanAllocation (admin only)', () => {
  /** Lipa's October Grab files staged, two Lipa-owned loans, and the 13 Oct line (deductions 49.87 + 1,771.88 = 1,821.75). */
  async function lipaOct(hint: string) {
    const w = await world3(sql, hint);
    await stageGrabOctober((a, b, c) => ingest(a as World3, b, c), w, w.managerA, 'lipa');
    const l1 = await mkLoan(sql, w, { storeId: w.storeA, name: 'Grab loan 1', startDate: '2026-05-11', principal: '200000.00', repayment: '591.24' });
    const l2 = await mkLoan(sql, w, { storeId: w.storeA, name: 'Grab loan 2', startDate: '2026-10-12', principal: '150000.00', repayment: '1771.88' });
    const line = await lineOn(sql, w.orgId, w.grabA, '2026-10-13');
    return { w, l1, l2, line };
  }
  const override = (w: World3, who: Actor, lineId: string, allocations: { loanId: string; amount: string }[]) =>
    asOrg(w.orgId, (tx) => overrideLoanAllocation(tx, who, { lineId, allocations }));

  it('an admin pins the 13 Oct deductions to two loans: the old lines go inactive (kept), new active lines carry the loan and source admin, the total is unchanged, audited [kills: lines deleted; override not stored; wrong source]', async () => {
    const { w, l1, l2, line } = await lipaOct('ovr-happy');
    const before = await loanLineRows(sql, line.id);
    expect(before.filter((l) => l.kind === 'deduction').map((l) => l.amount).sort()).toEqual(['1771.88', '49.87']);
    const ledger = await ledgerCount(sql, w.orgId);
    await override(w, w.admin, line.id, [{ loanId: l1, amount: '591.24' }, { loanId: l2, amount: '1230.51' }]);
    const after = await loanLineRows(sql, line.id);
    expect(after.length).toBe(before.length + 2);
    for (const old of before) expect(after.find((l) => l.id === old.id)).toMatchObject({ amount: old.amount, is_active: old.kind === 'deduction' ? false : true });
    const active = after.filter((l) => l.is_active && l.kind === 'deduction');
    expect(active.map((l) => [l.loan_id, l.amount, l.allocation_source]).sort()).toEqual([[l1, '591.24', 'admin'], [l2, '1230.51', 'admin']].sort());
    const maxOld = Math.max(...before.map((l) => l.row_ordinal));
    for (const n of active) expect(n.row_ordinal).toBeGreaterThan(maxOld);
    const a = await auditRows(sql, w.orgId, 'settlement_loan.allocation_overridden');
    expect(a.length).toBe(1);
    expect(a[0]).toMatchObject({ entity_id: line.id, store_id: w.storeA, actor_person_id: w.admin.personId, source: 'web' });
    expect(await ledgerCount(sql, w.orgId), 'an override posts nothing').toBe(ledger);
  });

  it('a second override flips the first override\'s lines inactive: the active deductions always add up to the day\'s loan deduction [kills: two overrides both active]', async () => {
    const { w, l1, l2, line } = await lipaOct('ovr-twice');
    await override(w, w.admin, line.id, [{ loanId: l1, amount: '591.24' }, { loanId: l2, amount: '1230.51' }]);
    await override(w, w.admin, line.id, [{ loanId: l2, amount: '1821.75' }]);
    const rows = await loanLineRows(sql, line.id);
    const active = rows.filter((l) => l.is_active && l.kind === 'deduction');
    expect(active.map((l) => [l.loan_id, l.amount])).toEqual([[l2, '1821.75']]);
    expect(rows.filter((l) => l.kind === 'deduction').length).toBe(2 + 2 + 1);
    expect((await auditRows(sql, w.orgId, 'settlement_loan.allocation_overridden')).length).toBe(2);
  });

  it('a disbursal on the day is never touched by an override (12 Oct: 150,000.00 in, 591.24 out) [kills: disbursal flipped inactive]', async () => {
    const { w, l1, line } = await lipaOct('ovr-disbursal');
    const d12 = await lineOn(sql, w.orgId, w.grabA, '2026-10-12');
    await override(w, w.admin, d12.id, [{ loanId: l1, amount: '591.24' }]);
    const rows = await loanLineRows(sql, d12.id);
    expect(rows.filter((l) => l.kind === 'disbursal').map((l) => [l.amount, l.is_active, l.loan_id])).toEqual([['150000.00', true, null]]);
    expect(rows.filter((l) => l.is_active && l.kind === 'deduction').map((l) => [l.loan_id, l.amount])).toEqual([[l1, '591.24']]);
    expect(line.id).not.toBe(d12.id);
  });

  it('a manager is refused (even of the store); nothing changes, no audit row [kills: override open to managers]', async () => {
    const { w, l1, l2, line } = await lipaOct('ovr-manager');
    const before = await loanLineRows(sql, line.id);
    const r = await attempt(() => override(w, w.managerA, line.id, [{ loanId: l1, amount: '591.24' }, { loanId: l2, amount: '1230.51' }]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(AuthorizationError);
    expect(await loanLineRows(sql, line.id)).toEqual(before);
    expect((await auditRows(sql, w.orgId, 'settlement_loan.allocation_overridden')).length).toBe(0);
  });

  it('amounts that do not add up to the day\'s deduction, a zero or negative amount, and a loan that is not in the org are refused with a sentence; nothing changes [kills: partial override; foreign loan]', async () => {
    const { w, l1, l2, line } = await lipaOct('ovr-bad');
    const foreign = await world3(sql, 'ovr-bad-other');
    const foreignLoan = await mkLoan(sql, foreign, { storeId: foreign.storeA, name: 'Other org loan', startDate: '2026-05-11', principal: '1000.00', repayment: '10.00' });
    const before = await loanLineRows(sql, line.id);
    const bad: { loanId: string; amount: string }[][] = [
      [{ loanId: l1, amount: '591.24' }, { loanId: l2, amount: '1230.50' }],
      [{ loanId: l1, amount: '0.00' }, { loanId: l2, amount: '1821.75' }],
      [{ loanId: l1, amount: '-1.00' }, { loanId: l2, amount: '1822.75' }],
      [{ loanId: foreignLoan, amount: '1821.75' }],
      [{ loanId: '00000000-0000-4000-8000-0000000000ff', amount: '1821.75' }],
      [],
    ];
    for (const allocations of bad) {
      const r = await attempt(() => override(w, w.admin, line.id, allocations));
      expect(r.ok, JSON.stringify(allocations)).toBe(false);
      if (r.ok) continue;
      expect(r.error).toBeInstanceOf(RefusalError);
      expect((r.error as RefusalError).userMessage).not.toMatch(UUID_RE);
    }
    expect(await loanLineRows(sql, line.id)).toEqual(before);
  });

  it('a Foodpanda day has no loan lines: the override is refused with a sentence [kills: override on a platform with no loans]', async () => {
    const w = await world3(sql, 'ovr-fp');
    const loan = await mkLoan(sql, w, { storeId: w.storeA, name: 'Grab loan 1', startDate: '2026-05-11', principal: '1000.00', repayment: '10.00' });
    const line = await stageFpDay(w, w.managerA, LIPA_FP, w.fpA, '2026-10-12', 1000);
    const r = await attempt(() => override(w, w.admin, line.id, [{ loanId: loan, amount: '10.00' }]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(RefusalError);
  });
});

/* ================================================================== listReviewDays */

describe('T-511 S5b listReviewDays - scoping and filters', () => {
  async function twoStores(hint: string) {
    const w = await world3(sql, hint);
    const a = await stageFpDay(w, w.managerA, LIPA_FP, w.fpA, '2026-10-12', 1000);
    const b = await stageFpDay(w, w.managerB, MALVAR_FP, w.fpB, '2026-10-13', 900);
    return { w, a, b };
  }

  it('store scoping: a manager of A sees A\'s day and none of B\'s, a manager of B the reverse, an admin both; staff see nothing [kills: every store visible to a manager]', async () => {
    const { w, a, b } = await twoStores('list-scope');
    const ids = async (who: Actor) => (await list(w, who)).days.map((d) => d.lineId).sort();
    expect(await ids(w.managerA)).toEqual([a.id]);
    expect(await ids(w.managerB)).toEqual([b.id]);
    expect(await ids(w.admin)).toEqual([a.id, b.id].sort());
    const staff = await attempt(() => ids(w.staff));
    if (staff.ok) expect(staff.value).toEqual([]);
    else expect(staff.error).toBeInstanceOf(AuthorizationError);
  });

  it('a manager\'s rows say their own store name and carry no other store\'s name or id anywhere in the object [kills: other stores leaked inside a row]', async () => {
    const { w } = await twoStores('list-leak');
    const out = await list(w, w.managerA);
    expect(out.days[0]).toMatchObject({ storeId: w.storeA, storeName: 'Lipa', platform: 'foodpanda', salesDate: '2026-10-12' });
    const text = JSON.stringify(out);
    expect(text).not.toContain('Malvar');
    expect(text).not.toContain(w.storeB);
    expect(text).not.toContain(w.fpB);
  });

  it('org isolation: another org\'s admin lists none of these rows, and these rows do not appear in theirs [kills: a cross-org read]', async () => {
    const { w, a } = await twoStores('list-org');
    const other = await world3(sql, 'list-org-other');
    const theirs = await stageFpDay(other, other.managerA, LIPA_FP, other.fpA, '2026-10-12', 700);
    expect((await list(other, other.admin)).days.map((d) => d.lineId)).toEqual([theirs.id]);
    expect((await list(w, w.admin)).days.map((d) => d.lineId)).toContain(a.id);
    expect((await list(w, w.admin)).days.map((d) => d.lineId)).not.toContain(theirs.id);
  });

  it('filters: store, platform and period each narrow the list; the superseded version of a day is never listed [kills: a filter ignored; stale versions listed]', async () => {
    const { w, a, b } = await twoStores('list-filters');
    const v2 = await stageFpDay(w, w.managerA, LIPA_FP, w.fpA, '2026-10-12', 1100);
    expect((await list(w, w.admin)).days.map((d) => d.lineId).sort()).toEqual([v2.id, b.id].sort());
    expect((await list(w, w.admin)).days.map((d) => d.lineId)).not.toContain(a.id);
    expect((await list(w, w.admin, { storeId: w.storeB })).days.map((d) => d.lineId)).toEqual([b.id]);
    expect((await list(w, w.admin, { platform: 'grab' })).days).toEqual([]);
    expect((await list(w, w.admin, { platform: 'foodpanda' })).days.length).toBe(2);
    expect((await list(w, w.admin, { period: '2026-10' })).days.length).toBe(2);
    expect((await list(w, w.admin, { period: '2026-09' })).days).toEqual([]);
  });

  it('needs attention: a day with no blocker and no difference is left out; a day whose recorded figure differs from the file is in [kills: the filter returning everything or nothing]', async () => {
    const w = await world3(sql, 'list-attention');
    const clean = await stageFpDay(w, w.managerA, LIPA_FP, w.fpA, '2026-10-12', 1000);
    const off = await stageFpDay(w, w.managerB, MALVAR_FP, w.fpB, '2026-10-12', 900);
    for (const channel of [w.fpA, w.fpB]) {
      await setDestination(sql, w, channel);
      await sql`update settlement_day_lines set paid_state = 'paid' where org_id = ${w.orgId} and channel_id = ${channel}`;
    }
    await salesDay(sql, w, w.storeA, w.fpA, '2026-10-12', '1000.00', { verified: true });
    await salesDay(sql, w, w.storeB, w.fpB, '2026-10-12', '850.00', { verified: true });
    const needs = await list(w, w.admin, { needsAttention: true });
    expect(needs.days.map((d) => d.lineId)).toEqual([off.id]);
    const row = needs.days[0]!;
    expect(row).toMatchObject({ fileFigure: '900.00', staffFigure: '850.00', difference: '50.00', needsAttention: true });
    const all = await list(w, w.admin);
    expect(all.days.find((d) => d.lineId === clean.id)).toMatchObject({ staffFigure: '1000.00', difference: '0.00', needsAttention: false, blockers: [] });
  });

  it('the staff figure and difference are re-read FRESH: a sales day verified AFTER staging shows up, though the line\'s snapshot is still null [kills: the list trusting the snapshot]', async () => {
    const w = await world3(sql, 'list-fresh');
    const line = await stageFpDay(w, w.managerA, LIPA_FP, w.fpA, '2026-10-12', 1000);
    expect(line.recorded_figure).toBeNull();
    const waiting = (await list(w, w.admin)).days[0]!;
    expect(waiting).toMatchObject({ staffFigure: null, difference: null });
    expect(waiting.blockers.join(' | ')).toMatch(/waiting for the sales day to be verified/i);
    await salesDay(sql, w, w.storeA, w.fpA, '2026-10-12', '940.00', { verified: true });
    const now = (await list(w, w.admin)).days[0]!;
    expect(now).toMatchObject({ staffFigure: '940.00', difference: '60.00' });
    expect(now.blockers.join(' | ')).not.toMatch(/waiting for the sales day to be verified/i);
  });

  it('the state shows after a decision: a rejected day is listed as rejected, with its paid state and no loan check for Foodpanda [kills: decided days vanishing]', async () => {
    const w = await world3(sql, 'list-state');
    const line = await stageFpDay(w, w.managerA, LIPA_FP, w.fpA, '2026-10-12', 1000);
    await reject(w, w.managerA, line.id, 'Does not match');
    const row = (await list(w, w.managerA)).days[0]!;
    expect(row).toMatchObject({ lineId: line.id, reviewState: 'rejected', platform: 'foodpanda', loanCheck: null });
  });
});

describe('T-511 S5b listReviewDays - Grab and Foodpanda rows', () => {
  it('Lipa October Grab: 30 days listed, each with a loan check and no invoice number; the 13 Oct row carries the sentence for its status and no UUID [kills: Grab days without a loan check; ids in sentences]', async () => {
    const w = await world3(sql, 'list-grab');
    await stageGrabOctober((a, b, c) => ingest(a as World3, b, c), w, w.managerA, 'lipa');
    const rows = (await list(w, w.admin, { platform: 'grab' })).days;
    expect(rows.length).toBe(30);
    for (const r of rows) {
      expect(r.invoiceNumber).toBeNull();
      expect(r.loanCheck).not.toBeNull();
      expect(r.loanCheck!.sentence).not.toMatch(UUID_RE);
      for (const b of r.blockers) expect(b).not.toMatch(UUID_RE);
    }
    expect(rows.map((r) => r.salesDate)).toEqual([...rows.map((r) => r.salesDate)].sort());
  });

  it('Foodpanda rows carry their invoice number (12 digits); two real invoices of one store are listed with their own numbers, each invoice\'s days together [kills: invoice grouping missing]', async () => {
    const w = await world3(sql, 'list-fp-invoice');
    await ingest(w, w.managerA, zip(upload('foodpanda-lipa-oct5-34col.zip').bytes));
    await ingest(w, w.managerA, zip(upload('foodpanda-lipa-oct19-34col-feerow.zip').bytes));
    const rows = (await list(w, w.admin, { platform: 'foodpanda' })).days;
    // 9 + 9 order dates, but 2026-09-27 is on both invoices and a channel holds ONE current line per date (the newer invoice's), so 17 days (tester count error, builder 1, 5 Nov)
    expect(rows.length).toBe(17);
    const numbers = rows.map((r) => r.invoiceNumber);
    for (const n of numbers) expect(n).toMatch(/^\d{12}$/);
    expect(new Set(numbers).size).toBe(2);
    const changes = numbers.filter((n, i) => i > 0 && n !== numbers[i - 1]).length;
    expect(changes, 'rows of one invoice are contiguous').toBe(1);
  });

  it('the Appendix-B-only invoice has no sales day and so no row; it is listed apart, with its PandaGO figures, and is never rejectable [kills: a day invented for PandaGO]', async () => {
    const w = await world3(sql, 'list-pandago');
    await ingest(w, w.managerA, zip(upload('foodpanda-lipa-oct5a-appendix-b-only-pandago.zip').bytes));
    const out = await list(w, w.admin);
    expect(out.days).toEqual([]);
    expect(out.pandagoOnly.length).toBe(1);
    expect(out.pandagoOnly[0]).toMatchObject({ storeId: w.storeA, storeName: 'Lipa', pandagoNetTotal: '-385.03', pandagoReceivable: '374.32', workbookDate: '2026-10-02' });
    expect((await list(w, w.managerB)).pandagoOnly).toEqual([]);
  });
});

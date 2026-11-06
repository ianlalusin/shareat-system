import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';

/**
 * T-511 S5b FIXER (2026-11-05), on a REAL Postgres (a `_test` database via TEST_DATABASE_URL). Audit findings:
 *  P2-3  the day detail and the PandaGO list re-read the stored file; when the reader refuses (too slow, malformed, unavailable) or throws, the READ-ONLY screens say
 *        "could not be read again" instead of crashing the whole page. A write path never swallows anything.
 *  P2-4  `overrideLoanAllocation` accepts only ACTIVE loans, and one loan only once per override.
 *  P3-13 a reject reason over the limit says it is too long (not "needs a reason").
 * Expected sentences are worked by hand; nothing here reads an expectation from the code under test.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

// The stored-file reader, switchable per test: a plain Error, a typed refusal, or the real reader.
const reader = vi.hoisted(() => ({ mode: 'real' as 'real' | 'throws' | 'refuses' }));
vi.mock('../../src/settlement-intake/stored-upload', async (orig) => {
  const real = await orig<typeof import('../../src/settlement-intake/stored-upload')>();
  const { intakeRefusal } = await import('../../src/settlement-intake/refusal');
  return {
    ...real,
    readStoredUpload: (...args: Parameters<typeof real.readStoredUpload>) => {
      if (reader.mode === 'throws') return Promise.reject(new Error('the reader blew up'));
      if (reader.mode === 'refuses') return Promise.reject(intakeRefusal('XLSX_TOO_SLOW', 'The workbook took too long to read.'));
      return real.readStoredUpload(...args);
    },
  };
});

import { closeDb, RefusalError } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { inMemoryDriver, setStorageDriver } from '@shareat/domain';
import { ingestSettlementFile } from '../../src/settlement-intake/ingest';
import { getReviewDayDetail, listReviewDays, overrideLoanAllocation, rejectDay } from '../../src/settlement-intake/review';
import { readFpFixture } from '../unit/t511-s4-helpers';
import { LIPA_FP, UUID_RE, asOrg, attempt, auditRows, lineOn, loanLineRows, mkLoan, salesDay, stageGrabOctober, synthFoodpanda, upload, world3, type World3 } from './_fixtures/t511-s5-world';

const sql = postgres(url, { max: 8 });
beforeEach(() => {
  reader.mode = 'real';
  setStorageDriver(inMemoryDriver());
});
afterAll(async () => {
  setStorageDriver(null);
  await closeDb();
  await sql.end({ timeout: 5 });
});

type File = { bytes: Buffer; contentType: string };
const ingest = (w: World3, actor: Actor, f: File) => asOrg(w.orgId, (tx) => ingestSettlementFile(tx, actor, { bytes: f.bytes, contentType: f.contentType }));
const TODAY = '2026-11-05';
const detailOf = (w: World3, who: Actor, lineId: string) => asOrg(w.orgId, (tx) => getReviewDayDetail(tx, who, { lineId }, { today: TODAY }));
const list = (w: World3, who: Actor) => asOrg(w.orgId, (tx) => listReviewDays(tx, who, {}));

/* ================================================================== P2-3 */

describe('P2-3 a stored file that cannot be read again never crashes a read-only screen', () => {
  for (const mode of ['throws', 'refuses'] as const) {
    it(`Foodpanda day detail, reader ${mode}: the page still opens, the orders list is empty (the screen says it could not be read again), VAT on fees is marked unreadable and is NOT shown as 0.00 [kills: one XLSX_TOO_SLOW takes the whole page down]`, async () => {
      const w = await world3(sql, `fix-p23-fp-${mode}`);
      await ingest(w, w.managerA, { bytes: upload('foodpanda-lipa-oct5-34col.zip').bytes, contentType: 'application/zip' });
      const inv = await readFpFixture('foodpanda-lipa-oct5-34col.zip');
      const date = inv.orders[0]!.orderDate;
      const line = await lineOn(sql, w.orgId, w.fpA, date);
      await salesDay(sql, w, w.storeA, w.fpA, date, '1.00', { verified: true });
      // sanity: the real reader gives the figure and the orders
      const ok = (await detailOf(w, w.managerA, line.id))!;
      expect(ok.orders.length).toBeGreaterThan(0);
      expect(ok.vatOnFees).not.toBeNull();
      expect(ok.vatOnFeesUnreadable).toBe(false);

      reader.mode = mode;
      const d = (await detailOf(w, w.managerA, line.id))!;
      expect(d).not.toBeNull();
      expect(d.orders).toEqual([]);
      expect(d.vatOnFees).toBeNull();
      expect(d.vatOnFeesUnreadable).toBe(true);
      expect(d.fileFigure).toBe(ok.fileFigure);
      expect(d.difference).toBe(ok.difference);
    });
  }

  it('Grab day detail with a gap, reader throws: the page opens with no orders [kills: the Grab order list crashing the page]', async () => {
    const w = await world3(sql, 'fix-p23-grab');
    await stageGrabOctober((a, b, c) => ingest(a as World3, b, c), w, w.managerA, 'lipa');
    await salesDay(sql, w, w.storeA, w.grabA, '2026-10-20', '9474.00', { verified: true });
    const line = await lineOn(sql, w.orgId, w.grabA, '2026-10-20');
    expect((await detailOf(w, w.managerA, line.id))!.orders.length).toBeGreaterThan(0);
    reader.mode = 'throws';
    const d = (await detailOf(w, w.managerA, line.id))!;
    expect(d.orders).toEqual([]);
    expect(d.vatOnFeesUnreadable).toBe(false); // Grab has no VAT on fees to read
    expect(d.vatOnFees).toBeNull();
  });

  it('the PandaGO-only list, reader throws: the list still comes back, the invoice is listed with a plain "could not be read again" sentence and no figure, and the day table is untouched [kills: a PandaGO invoice taking down the whole list]', async () => {
    const w = await world3(sql, 'fix-p23-pandago');
    await ingest(w, w.managerA, { bytes: upload('foodpanda-lipa-oct5a-appendix-b-only-pandago.zip').bytes, contentType: 'application/zip' });
    await ingest(w, w.managerA, { bytes: upload('foodpanda-lipa-oct5-34col.zip').bytes, contentType: 'application/zip' });
    const fine = await list(w, w.managerA);
    expect(fine.pandagoOnly.length).toBe(1);
    expect(fine.pandagoOnly[0]!.unreadable).toBe(false);
    reader.mode = 'refuses';
    const broken = await list(w, w.managerA);
    expect(broken.days.length).toBe(fine.days.length);
    expect(broken.pandagoOnly.length).toBe(1);
    const p = broken.pandagoOnly[0]!;
    expect(p.unreadable).toBe(true);
    expect(p.sentence).toMatch(/could not be read again/i);
    expect(p.sentence).not.toMatch(UUID_RE);
    expect(p.storeName).toBe(fine.pandagoOnly[0]!.storeName);
  });

  it('the real reader refusing (storage hands back bytes that are not a workbook): same answer as a thrown reader [kills: only a mocked failure handled]', async () => {
    const w = await world3(sql, 'fix-p23-garbage');
    await ingest(w, w.managerA, { bytes: upload('foodpanda-lipa-oct5a-appendix-b-only-pandago.zip').bytes, contentType: 'application/zip' });
    const kept = (await import('../../src/files/driver')).resolveStorageDriver();
    setStorageDriver({ ...kept, get: async () => Buffer.from('this is not a zip') });
    const out = await list(w, w.managerA);
    expect(out.pandagoOnly[0]!.unreadable).toBe(true);
  });
});

/* ================================================================== P2-4 */

describe('P2-4 overrideLoanAllocation: active loans only, each loan once', () => {
  async function lipaOct(hint: string) {
    const w = await world3(sql, hint);
    await stageGrabOctober((a, b, c) => ingest(a as World3, b, c), w, w.managerA, 'lipa');
    const l1 = await mkLoan(sql, w, { storeId: w.storeA, name: 'Grab loan 1', startDate: '2026-05-11', principal: '200000.00', repayment: '591.24' });
    const l2 = await mkLoan(sql, w, { storeId: w.storeA, name: 'Grab loan 2', startDate: '2026-10-12', principal: '150000.00', repayment: '1771.88' });
    const line = await lineOn(sql, w.orgId, w.grabA, '2026-10-13');
    return { w, l1, l2, line };
  }
  const override = (w: World3, who: Actor, lineId: string, allocations: { loanId: string; amount: string }[]) => asOrg(w.orgId, (tx) => overrideLoanAllocation(tx, who, { lineId, allocations }));

  it('a loan that is paid off is refused with a plain sentence; the day\'s lines and the audit log are unchanged [kills: a closed loan saved as the destination]', async () => {
    const { w, l1, l2, line } = await lipaOct('fix-p24-paid');
    await sql`update loans set status = 'paid_off' where id = ${l2}`;
    const before = await loanLineRows(sql, line.id);
    const r = await attempt(() => override(w, w.admin, line.id, [{ loanId: l1, amount: '591.24' }, { loanId: l2, amount: '1230.51' }]));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBeInstanceOf(RefusalError);
    expect((r.error as RefusalError).userMessage).toMatch(/not active|paid off|still open/i);
    expect((r.error as RefusalError).userMessage).not.toMatch(UUID_RE);
    expect(await loanLineRows(sql, line.id)).toEqual(before);
    expect((await auditRows(sql, w.orgId, 'settlement_loan.allocation_overridden')).length).toBe(0);
  });

  it('the same loan twice in one override is refused; the active loan still works [kills: duplicate loan ids]', async () => {
    const { w, l1, l2, line } = await lipaOct('fix-p24-dup');
    const before = await loanLineRows(sql, line.id);
    const dup = await attempt(() => override(w, w.admin, line.id, [{ loanId: l1, amount: '100.00' }, { loanId: l1, amount: '1721.75' }]));
    expect(dup.ok).toBe(false);
    if (!dup.ok) {
      expect(dup.error).toBeInstanceOf(RefusalError);
      expect((dup.error as RefusalError).userMessage).toMatch(/more than once|same loan/i);
    }
    expect(await loanLineRows(sql, line.id)).toEqual(before);
    await override(w, w.admin, line.id, [{ loanId: l1, amount: '591.24' }, { loanId: l2, amount: '1230.51' }]);
    expect((await auditRows(sql, w.orgId, 'settlement_loan.allocation_overridden')).length).toBe(1);
  });
});

/* ================================================================== P3-13 */

describe('P3-13 a reject reason that is too long says so', () => {
  let n = 0;
  async function pendingLine(w: World3) {
    await ingest(w, w.managerA, { bytes: synthFoodpanda([{ date: '2026-10-12', revenue: 1000 }], LIPA_FP, `fix-${Date.now()}-${++n}`), contentType: 'application/zip' });
    return lineOn(sql, w.orgId, w.fpA, '2026-10-12');
  }
  const reject = (w: World3, who: Actor, lineId: string, reason: string) => asOrg(w.orgId, (tx) => rejectDay(tx, who, { lineId, reason }));

  it('501 characters: "too long" with the limit, not "needs a reason"; the line stays pending; 500 characters is accepted [kills: the wrong sentence for a long reason]', async () => {
    const w = await world3(sql, 'fix-p313');
    const line = await pendingLine(w);
    const long = await attempt(() => reject(w, w.managerA, line.id, 'x'.repeat(501)));
    expect(long.ok).toBe(false);
    if (!long.ok) {
      expect(long.error).toBeInstanceOf(RefusalError);
      const m = (long.error as RefusalError).userMessage;
      expect(m).toMatch(/too long/i);
      expect(m).toMatch(/500/);
      expect(m).not.toMatch(/needs a reason/i);
    }
    expect((await lineOn(sql, w.orgId, w.fpA, '2026-10-12')).review_state).toBe('pending');
    const blank = await attempt(() => reject(w, w.managerA, line.id, '  '));
    if (!blank.ok) expect((blank.error as RefusalError).userMessage).toMatch(/needs a reason/i);
    await reject(w, w.managerA, line.id, 'y'.repeat(500));
    expect((await lineOn(sql, w.orgId, w.fpA, '2026-10-12')).review_state).toBe('rejected');
  });

  it('the length is judged after trimming: 500 characters padded with spaces are fine [kills: spaces counted]', async () => {
    const w = await world3(sql, 'fix-p313-trim');
    const line = await pendingLine(w);
    await reject(w, w.managerA, line.id, `   ${'z'.repeat(500)}   `);
    expect((await lineOn(sql, w.orgId, w.fpA, '2026-10-12')).review_state).toBe('rejected');
  });
});

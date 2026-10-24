import { config } from 'dotenv';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * T-475 S1 (TESTER) - the approveExpense split (spec 4.1): `gatherApprovalFacts` (reads; locks only when asked) + the pure
 * `approvalVerdict`, so the verify-form preview can never disagree with the real posting.
 *
 * CONTRACT PINNED HERE (packages/domain/src/expenses/approve.ts exports both; the spec gives the shape):
 *   gatherApprovalFacts(tx, actor, expenseId, { lock: boolean }): Promise<facts>        reads; locks ONLY when lock is true
 *   approvalVerdict(facts, opts?: { invoiceVerifiedInThisTx?: boolean; periodOverride?: { reason; note? } })
 *       -> null | { raw: string; sentence: string }          the FIRST blocker, or null when the draft would post
 *   approveExpense = gather(lock) + verdict + throw refuse(raw, sentence) + post.
 * For every blocker below the test asserts: sentence === the userMessage the REAL approveExpense refuses with, for the same
 * data (agreement), and a null verdict <=> the real approval posts.
 *
 * MUTANTS: gather skips a check (the unmapped category, the period, the cash-request balance, the invoice status); the verdict
 * lets a LOCKED month through when an override is given; the override ignored for a CLOSED month; the preview's
 * `invoiceVerifiedInThisTx` ignored (a pending invoice always blocks the verify preview) or applied too widely; `lock:false`
 * still locking (the verify page would queue behind a posting); `lock:true` not locking (a double approve); the preview writing.
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

import { apRepo, closeDb } from '@shareat/db';
import { flushSecurityEvents } from '@shareat/auth';
import { approveExpense, createCashRequest, decideCashRequest, releaseCashRequest } from '@shareat/domain';
import * as approveModule from '../../src/expenses/approve';
import { ap475Fixture, asOrg, uid, type Fixture } from './_fixtures/t475-ap';

const sql = postgres(url, { max: 6 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

type Verdict = null | { raw: string; sentence: string };
const mod = approveModule as unknown as {
  gatherApprovalFacts(tx: unknown, actor: unknown, id: string, o: { lock: boolean }): Promise<unknown>;
  approvalVerdict(facts: unknown, o?: { invoiceVerifiedInThisTx?: boolean; periodOverride?: { reason: string; note?: string | null } }): Verdict;
};
const OVERRIDE = { reason: 'late_supplier_invoice' as const, note: null };

const preview = (f: Fixture, expenseId: string, o?: Parameters<typeof mod.approvalVerdict>[1]) =>
  asOrg(f.orgId, async (tx) => mod.approvalVerdict(await mod.gatherApprovalFacts(tx, f.manager, expenseId, { lock: false }), o));

/** What the REAL approval says: the refusal's userMessage, or null when it posted. (Runs in a transaction that is rolled back by throwing.) */
async function real(f: Fixture, expenseId: string, options?: { periodOverride?: typeof OVERRIDE }): Promise<string | null> {
  try {
    await asOrg(f.orgId, (tx) => approveExpense(tx, f.admin, expenseId, options));
    return null;
  } catch (err) {
    return (err as { userMessage?: string }).userMessage ?? `RAW: ${(err as Error).message}`;
  }
}
const statusOf = async (id: string) => (await sql<{ status: string }[]>`select status from expenses where id = ${id}`)[0]!.status;

describe('T-475 S1 - the split exists', () => {
  it('approve.ts exports gatherApprovalFacts and approvalVerdict', () => {
    expect(typeof mod.gatherApprovalFacts).toBe('function');
    expect(typeof mod.approvalVerdict).toBe('function');
  });
  it('approveExpense is gather + verdict + throw (it calls both; mutant: a second copy of the checks left inline)', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'expenses', 'approve.ts'), 'utf8');
    const body = src.slice(src.indexOf('async function runApproveExpense'));
    expect(body).toMatch(/gatherApprovalFacts\(/);
    expect(body).toMatch(/approvalVerdict\(/);
    // the inline period refusal is gone from the run function: it lives in the verdict now
    const run = body.slice(0, body.indexOf('\n}\n'));
    expect(run).not.toMatch(/is locked\. Nothing can be posted into it/);
  });
});

describe('T-475 S1 - the verdict agrees with the real approval, case by case', () => {
  it('a clean draft: verdict null, and the real approval posts', async () => {
    const f = await ap475Fixture(sql, 'clean');
    const inv = await f.invoice({ status: 'verified' });
    const id = await f.draft(inv);
    expect(await preview(f, id)).toBeNull();
    expect(await real(f, id)).toBeNull();
    expect(await statusOf(id)).toBe('posted');
  });

  it('an UNMAPPED category: same sentence as the real refusal; nothing posts (mutant: gather skips the category)', async () => {
    const f = await ap475Fixture(sql, 'unmapped');
    const inv = await f.invoice({ status: 'verified' });
    const id = await f.draft(inv, { categoryId: await f.unmappedCategory() });
    const v = await preview(f, id);
    expect(v, 'no verdict for an unmapped category').not.toBeNull();
    expect(v!.raw.length).toBeGreaterThan(0);
    expect(await real(f, id)).toBe(v!.sentence);
    expect(await statusOf(id)).toBe('draft');
  });

  it('a LOCKED month: same sentence; an override does NOT lift it, in the verdict or in the real approval (mutant: override lifts a lock)', async () => {
    const f = await ap475Fixture(sql, 'locked');
    const inv = await f.invoice({ status: 'verified' });
    const id = await f.draft(inv, { on: '2026-01-10' });
    await f.setPeriod('2026-01-01', 'locked');
    const plain = await preview(f, id);
    expect(plain!.sentence).toMatch(/is locked\. Nothing can be posted into it, not even with the closed-month override\.$/);
    expect(await real(f, id)).toBe(plain!.sentence);
    const withOverride = await preview(f, id, { periodOverride: OVERRIDE });
    expect(withOverride!.sentence).toBe(plain!.sentence);
    expect(await real(f, id, { periodOverride: OVERRIDE })).toBe(plain!.sentence);
    expect(await statusOf(id)).toBe('draft');
  });

  it('a CLOSED month: blocks without the override with the real sentence; passes with it, and the real approval then posts (mutant: override ignored)', async () => {
    const f = await ap475Fixture(sql, 'closed');
    const inv = await f.invoice({ status: 'verified' });
    const id = await f.draft(inv, { on: '2026-01-10' });
    await f.setPeriod('2026-01-01', 'closed');
    const plain = await preview(f, id);
    expect(plain!.sentence).toMatch(/is closed\. Ask an administrator to post this one entry into it\.$/);
    expect(await real(f, id)).toBe(plain!.sentence);
    expect(await statusOf(id)).toBe('draft');
    expect(await preview(f, id, { periodOverride: OVERRIDE })).toBeNull();
    expect(await real(f, id, { periodOverride: OVERRIDE })).toBeNull();
    expect(await statusOf(id)).toBe('posted');
  });

  it('a PENDING invoice: same sentence as the real refusal; with invoiceVerifiedInThisTx the preview passes (mutant: option ignored / always on)', async () => {
    const f = await ap475Fixture(sql, 'pending');
    const inv = await f.invoice({ status: 'pending' });
    const id = await f.draft(inv);
    const v = await preview(f, id);
    expect(v, 'a draft on a pending invoice must be blocked by the verdict (P1)').not.toBeNull();
    expect(v!.sentence).toMatch(/hasn't been verified yet, so this can't post against it\.$/);
    expect(await real(f, id)).toBe(v!.sentence);
    expect(await preview(f, id, { invoiceVerifiedInThisTx: true })).toBeNull();
    // ...and the option lifts ONLY the pending-invoice blocker: a locked month still blocks.
    await f.setPeriod('2026-01-01', 'locked');
    expect((await preview(f, id, { invoiceVerifiedInThisTx: true }))!.sentence).toMatch(/is locked/);
  });

  it('an OVERDRAWN cash request: the second draft cannot draw what the first already spent; same sentence as the real refusal (mutant: gather skips the float)', async () => {
    const f = await ap475Fixture(sql, 'float');
    const [staffFloat] = await sql<{ id: string }[]>`select id from money_accounts where store_id = ${f.storeId} and custodian = 'staff' and instrument = 'cash'`;
    const [office] = await sql<{ id: string }[]>`select id from money_accounts where store_id = ${f.storeId} and custodian = 'office' and instrument = 'cash'`;
    // fund the office safe so the float can be released
    const [period] = await sql<{ id: string }[]>`select id from fiscal_periods where org_id = ${f.orgId} limit 1`;
    await sql.begin(async (t) => {
      const [e] = await t<{ id: string }[]>`insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status) values (${f.orgId}, '2026-01-02', ${period!.id}, 'opening_balance', ${uid('open')}, 'draft') returning id`;
      const [target] = await t<{ id: string }[]>`select id from accounts where org_id = ${f.orgId} and code = '1130'`;
      const [equity] = await t<{ id: string }[]>`select id from accounts where org_id = ${f.orgId} and code = '3900'`;
      await t`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit) values (${e!.id}, 1, ${target!.id}, ${f.storeId}, '50000.00', '0')`;
      await t`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit) values (${e!.id}, 2, ${equity!.id}, ${f.storeId}, '0', '50000.00')`;
      await t`update journal_entries set status = 'posted' where id = ${e!.id}`;
    });
    const { id: requestId } = await asOrg(f.orgId, (tx) =>
      createCashRequest(tx, f.admin, { storeId: f.storeId, requestedFor: f.adminId, purpose: 'Market run', amount: '1000.00', on: '2026-01-05' }),
    );
    await asOrg(f.orgId, (tx) => decideCashRequest(tx, f.verifier, { requestId, decision: 'approve', amount: '1000.00', on: '2026-01-05' }));
    await asOrg(f.orgId, (tx) => releaseCashRequest(tx, f.verifier, { requestId, amount: '1000.00', fromMoneyAccountId: office!.id, on: '2026-01-05' }));
    const inv = await f.invoice({ status: 'verified' });
    const draw = { method: 'cash' as const, amount: '800.00', moneyAccountId: staffFloat!.id, cashRequestId: requestId };
    const first = await f.draft(inv, { payments: [draw] });
    const second = await f.draft(inv, { payments: [draw] });
    expect(await preview(f, second)).toBeNull(); // 800 of 1000 is fine while nothing has been spent
    expect(await real(f, first)).toBeNull(); // spends 800
    const v = await preview(f, second);
    expect(v, 'the float now has 200 left; the verdict must see it').not.toBeNull();
    expect(await real(f, second)).toBe(v!.sentence);
    expect(await statusOf(second)).toBe('draft');
  });
});

describe('T-475 S1 - the preview writes nothing and locks only when asked', () => {
  it('gather + verdict leave the draft, the ledger and the audit log untouched (mutant: a dry-run that posts then rolls back would burn a sequence)', async () => {
    const f = await ap475Fixture(sql, 'nowrite');
    const inv = await f.invoice({ status: 'verified' });
    const id = await f.draft(inv);
    const count = async () =>
      (await sql<{ je: string; al: string }[]>`
        select (select count(*) from journal_entries where org_id = ${f.orgId})::text as je,
               (select count(*) from audit_log where org_id = ${f.orgId})::text as al`)[0]!;
    const before = await count();
    await preview(f, id);
    await preview(f, id, { periodOverride: OVERRIDE });
    expect(await count()).toEqual(before);
    expect(await statusOf(id)).toBe('draft');
  });

  it('lock:false does not wait on a held invoice lock; lock:true does (mutants: lock ignored in either direction)', async () => {
    const f = await ap475Fixture(sql, 'lock');
    const inv = await f.invoice({ status: 'verified' });
    const id = await f.draft(inv);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let acquired!: () => void;
    const gotLock = new Promise<void>((r) => (acquired = r));
    const holder = asOrg(f.orgId, async (tx) => {
      await apRepo.lockInvoiceForRecording(tx, f.orgId, inv);
      acquired();
      await held;
    });
    await gotLock;
    const timeout = <T>(ms: number, v: T) => new Promise<T>((r) => setTimeout(() => r(v), ms));
    try {
      const free = await Promise.race([preview(f, id).then(() => 'done'), timeout(4000, 'timeout')]);
      expect(free, 'lock:false queued behind a held lock').toBe('done');
      const locking = asOrg(f.orgId, async (tx) => {
        await mod.gatherApprovalFacts(tx, f.manager, id, { lock: true });
        return 'done';
      });
      const blocked = await Promise.race([locking, timeout(1500, 'timeout')]);
      expect(blocked, 'lock:true did not wait for the held invoice lock').toBe('timeout');
      release();
      await holder;
      expect(await locking).toBe('done');
    } finally {
      release();
      await holder.catch(() => {});
    }
  });
});

describe('T-475 S1 - the verdict keeps the first-refusal order of approveExpense (Opus review 2)', () => {
  // order today: authorize, capacity/invoice status, category, money account, transfer_funds, checkDraw, routing, period.
  it('a draft with THREE faults shows them one at a time, in order: pending invoice, then unmapped category, then locked month (mutant: wrong refusal shown)', async () => {
    const f = await ap475Fixture(sql, 'order');
    const inv = await f.invoice({ status: 'pending' });
    const id = await f.draft(inv, { categoryId: await f.unmappedCategory(), on: '2026-01-10' });
    await f.setPeriod('2026-01-01', 'locked');
    const first = await preview(f, id);
    expect(first!.sentence).toMatch(/hasn't been verified yet/);
    expect(await real(f, id)).toBe(first!.sentence);
    const second = await preview(f, id, { invoiceVerifiedInThisTx: true });
    expect(second!.sentence).not.toMatch(/locked|hasn't been verified/); // the category, ahead of the period
    const [cat] = await sql<{ category: string }[]>`select category from expense_categories where id = (select category_id from expenses where id = ${id})`;
    expect(second!.raw + second!.sentence).toContain(cat!.category);
    await sql`update expenses set category_id = ${f.categoryId} where id = ${id}`;
    const third = await preview(f, id, { invoiceVerifiedInThisTx: true });
    expect(third!.sentence).toMatch(/is locked/);
  });
});

describe('T-475 S1 - previews use can(), never authorize() (Opus review 3, 4)', () => {
  it('previewing as someone who may not approve writes NO denial row or counter, and still yields facts; the real approval by that person is still refused with the original authorization error (mutant: preview calls authorize)', async () => {
    const f = await ap475Fixture(sql, 'nodenial');
    const inv = await f.invoice({ status: 'verified' });
    const id = await f.draft(inv);
    const counts = async () =>
      (await sql<{ a: string; c: string }[]>`
        select (select count(*) from audit_log where org_id = ${f.orgId})::text as a,
               (select count(*) from authz_denial_counts where org_id = ${f.orgId})::text as c`)[0]!;
    await flushSecurityEvents();
    const before = await counts();
    await asOrg(f.orgId, async (tx) => {
      const facts = await mod.gatherApprovalFacts(tx, f.staff, id, { lock: false });
      expect(facts).toBeTruthy();
      mod.approvalVerdict(facts);
    });
    await flushSecurityEvents();
    expect(await counts()).toEqual(before);
    await expect(asOrg(f.orgId, (tx) => approveExpense(tx, f.staff, id))).rejects.toMatchObject({ name: 'AuthorizationError' });
  });

  it('the locked-month refusal reaching verifyInvoice keeps its userMessage through the rewrap (ap/index.ts:875 depends on it)', async () => {
    const f = await ap475Fixture(sql, 'rewrap');
    const inv = await f.invoice({ on: '2026-01-10' });
    await f.draft(inv, { on: '2026-01-10', particulars: 'Jan' });
    await f.setPeriod('2026-01-01', 'locked');
    const { verifyInvoice } = await import('@shareat/domain');
    let msg = '';
    try {
      await asOrg(f.orgId, (tx) => verifyInvoice(tx, f.verifier, inv, { supplier: true, invoice: true, items: true, price: true }));
    } catch (e) {
      msg = (e as { userMessage?: string }).userMessage ?? `RAW ${(e as Error).message}`;
    }
    expect(msg).toMatch(/is locked\. Nothing can be posted into it/);
  });
});

describe('T-475 S1 - draws are summed per money account across ALL drafts of the invoice (Opus review 6)', () => {
  it('two drafts that each fit the drawer but together overdraw it: the verify preview (all drafts, invoice verified in this tx) shows a blocker (mutant: drafts judged one at a time)', async () => {
    const f = await ap475Fixture(sql, 'sum');
    const [office] = await sql<{ id: string }[]>`select id from money_accounts where store_id = ${f.storeId} and custodian = 'office' and instrument = 'cash'`;
    const inv = await f.invoice({ status: 'pending' });
    const pay = [{ method: 'cash' as const, amount: '600.00', moneyAccountId: office!.id }];
    const a = await f.draft(inv, { payments: pay });
    const b = await f.draft(inv, { payments: pay });
    // office safe holds 1000: each draft fits alone, the pair (1200) does not.
    const [period] = await sql<{ id: string }[]>`select id from fiscal_periods where org_id = ${f.orgId} limit 1`;
    await sql.begin(async (t) => {
      const [e] = await t<{ id: string }[]>`insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status) values (${f.orgId}, '2026-01-02', ${period!.id}, 'opening_balance', ${uid('open')}, 'draft') returning id`;
      const [target] = await t<{ id: string }[]>`select id from accounts where org_id = ${f.orgId} and code = '1130'`;
      const [equity] = await t<{ id: string }[]>`select id from accounts where org_id = ${f.orgId} and code = '3900'`;
      await t`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit) values (${e!.id}, 1, ${target!.id}, ${f.storeId}, '1000.00', '0')`;
      await t`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit) values (${e!.id}, 2, ${equity!.id}, ${f.storeId}, '0', '1000.00')`;
      await t`update journal_entries set status = 'posted' where id = ${e!.id}`;
    });
    // singly each passes the preview...
    expect(await preview(f, a, { invoiceVerifiedInThisTx: true })).toBeNull();
    // ...the page-level preview over the whole invoice must catch the pair:
    const over = (mod as unknown as { previewInvoiceDrafts?: (tx: unknown, actor: unknown, invoiceId: string) => Promise<Array<{ draftId: string; verdict: Verdict }>> }).previewInvoiceDrafts;
    expect(typeof over, 'approve.ts must export previewInvoiceDrafts(tx, actor, invoiceId) -> [{draftId, verdict}] that sums draws across drafts (PINNED name)').toBe('function');
    const rows = await asOrg(f.orgId, (tx) => over!(tx, f.verifier, inv));
    expect(rows.some((r) => r.verdict !== null), 'the pair overdraws the drawer but no draft shows a blocker').toBe(true);
    // and the real verify agrees: it refuses
    const { verifyInvoice } = await import('@shareat/domain');
    await expect(asOrg(f.orgId, (tx) => verifyInvoice(tx, f.verifier, inv, { supplier: true, invoice: true, items: true, price: true }))).rejects.toThrow();
    expect(b).toBeTruthy();
  });
});

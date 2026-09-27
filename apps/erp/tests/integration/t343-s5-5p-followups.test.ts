import { config } from 'dotenv';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-343 S5.5p — follow-ups from the S5.5n post-commit review (DEF-460, DEF-461).
 * `docs/tasks/343-def-417-human-readable-refusals.md` §S5.5p. Committed as `d072356`; every leg
 * below is green, and each "was red before d072356" note records the pre-fix failure it pinned.
 *
 * ⛔ TESTER, not BUILDER.
 * - P1/P1n/P2/P3/P4 (DEF-460): before `d072356`, `apps/erp/src/app/prepaid/actions.ts`'s
 *   `writeOffAction` spread `refundAmount`/`refundAccountCode` only when `refund && Number(refund) >
 *   0`. `Number('1,000')` is `NaN` (comma), so a comma-typed refund was silently DROPPED and the
 *   write-off proceeded with no refund at all — the whole remaining balance expensed, no refusal
 *   naming the refund (P1). An empty refund box stayed green (P1n). P2-P4 drive the SAME gate with
 *   values that already pass `Number(x) > 0` (so they DID reach `writeOffPrepaidItem` before the
 *   fix) to pin the three plain, `writeOffPrepaidItem:`-prefixed `Error`s `errorMessage`'s
 *   fall-through stripped to a lowercase sentence — the developer-worded text DEF-460 item 1 asked
 *   the builder to convert with `refuse()`.
 * - N1 (DEF-461): `packages/domain/src/ar/index.ts`'s `recordCollection` threw a plain
 *   `Error('recordCollection: creditApplied cannot be negative.')` for a negative credit. Reached
 *   the domain unfiltered before this fix — DEF-457/S5.5n already fixed the app-layer gate that used
 *   to drop it (`customers/actions.ts:227`, `creditApplied ? { creditApplied } : {}` — no
 *   `Number(...) > 0` test left to intercept a negative value).
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

class RedirectSignal extends Error {
  constructor(public to: string) {
    super(`redirect:${to}`);
  }
}

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to);
  },
}));

const ACTOR_HOLDER: { actor: { orgId: string; personId: string } | null } = { actor: null };
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => ACTOR_HOLDER.actor!),
}));

// ⛔ NOT a stub — forwards to the real module (the bare `@/...` specifier the root
// `vitest.config.mts` never resolves; S5.5n/S7 precedent).
vi.mock('@/lib/constraint-messages', async () => {
  return await import('../../src/lib/constraint-messages');
});

import { transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { createCustomer, createPrepaidItem, recordCharge, writeOffPrepaidItem } from '@shareat/domain';
import { seedChartOfAccounts } from '../../../../packages/db/seed/chart-of-accounts';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}
const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

async function orgFixture(hint: string) {
  const code = uid(`s55p-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const storeId = store!.id;
  await sql`
    insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open')`;
  const [admin] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  const adminId = admin!.id;
  await sql`insert into person_roles (person_id, org_id, role) values (${adminId}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${adminId}, ${storeId})`;
  return { orgId, storeId, admin: actor(orgId, adminId) };
}

async function prepaidFixture(hint: string) {
  const f = await orgFixture(hint);
  const item = await asOrg(f.orgId, (tx) =>
    createPrepaidItem(tx, f.admin, {
      storeId: f.storeId,
      name: 'Fire insurance 2026',
      category: 'insurance',
      coverageStartDate: '2026-01-01',
      coverageMonths: 12,
      totalCost: '24000.00',
    }),
  );
  return { ...f, itemId: item.id };
}

async function prepaidStatus(itemId: string): Promise<string> {
  const [row] = await sql<{ status: string }[]>`select status from prepaid_items where id = ${itemId}`;
  return row!.status;
}

/** P-file hygiene (S5.5r) — a "nothing was written" leg should prove no JOURNAL ENTRY posted for
 *  this item, not merely that `prepaid_items.status` didn't flip; `postEntry`'s own `sourceId` is
 *  the write-off's real footprint (`prepaid/index.ts`'s `runWriteOff`, `sourceType:
 *  'prepaid_write_off'`). */
async function journalEntryCountFor(itemId: string): Promise<number> {
  const [row] = await sql<{ count: string }[]>`
    select count(*)::text as count from journal_entries where source_type = 'prepaid_write_off' and source_id = ${itemId}`;
  return Number(row!.count);
}

function writeOffFormData(f: { itemId: string }, overrides: { refundAmount?: string; refundAccountCode?: string } = {}): FormData {
  const fd = new FormData();
  fd.set('prepaidItemId', f.itemId);
  fd.set('writtenOffOn', '2026-01-15');
  fd.set('reason', 'Cancelled');
  if (overrides.refundAmount !== undefined) fd.set('refundAmount', overrides.refundAmount);
  if (overrides.refundAccountCode !== undefined) fd.set('refundAccountCode', overrides.refundAccountCode);
  return fd;
}

async function expectRedirectTo(action: () => Promise<void>): Promise<string> {
  try {
    await action();
  } catch (err) {
    if (err instanceof RedirectSignal) return err.to;
    throw err;
  }
  throw new Error('expected the action to redirect');
}

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

describe('P1 (DEF-460) — a comma-typed refund is silently dropped, never reaches parseMoneyInput', () => {
  it(
    'refundAmount "1,000": was red before d072356 — the write-off used to SUCCEED, whole balance expensed, no refusal naming the refund',
    async () => {
      const f = await prepaidFixture('p1');
      ACTOR_HOLDER.actor = f.admin;
      const { writeOffAction } = await import('../../src/app/prepaid/actions');

      const to = await expectRedirectTo(() =>
        writeOffAction(writeOffFormData(f, { refundAmount: '1,000', refundAccountCode: '1110' })),
      );
      const params = new URL(to, 'http://localhost').searchParams;

      expect(params.get('error'), `redirect URL was: ${to}`).toBe(
        'The refund amount — "1,000" is not a valid amount. Use at most two decimal places.',
      );
      expect(await journalEntryCountFor(f.itemId), 'no journal entry should have been posted').toBe(0);
    },
    30000,
  );

  it(
    'P1n (⛔ green now) — an empty refund box: the write-off succeeds with no refund leg',
    async () => {
      const f = await prepaidFixture('p1n');
      ACTOR_HOLDER.actor = f.admin;
      const { writeOffAction } = await import('../../src/app/prepaid/actions');

      const to = await expectRedirectTo(() => writeOffAction(writeOffFormData(f)));
      const params = new URL(to, 'http://localhost').searchParams;
      expect(params.get('error'), `redirect URL was: ${to}`).toBeNull();
      expect(params.get('ok')).toContain('Written off');
      expect(await prepaidStatus(f.itemId)).toBe('written_off');
    },
    30000,
  );
});

describe('P2 (DEF-460) — a negative refund, at the DOMAIN layer, is still a plain, developer-worded Error', () => {
  /**
   * ⚠️ Measured, not assumed: `-5` fails the SAME `Number(refund) > 0` app-layer gate P1 exploited
   * — `Number('-5') > 0` is `false` — so `writeOffAction` silently dropped it too, and a form-level
   * P2 would only re-prove P1 (succeeds, no refund leg), never reach this sentence at all. Calling
   * `writeOffPrepaidItem` directly was the only way to observe the pre-fix text; item 1's `refuse()`
   * conversion is what turned it from a plain `Error` into a `RefusalError`.
   */
  it(
    'refundAmount "-5": wanted — a RefusalError whose raw message stays byte-identical and whose userMessage is "The refund amount cannot be negative." — was red before d072356: no userMessage at all (a plain Error)',
    async () => {
      const f = await prepaidFixture('p2');
      let caught: unknown;
      try {
        await asOrg(f.orgId, (tx) =>
          writeOffPrepaidItem(tx, f.admin, {
            prepaidItemId: f.itemId,
            writtenOffOn: '2026-01-15',
            reason: 'Cancelled',
            refundAmount: '-5',
            refundAccountCode: '1110',
          }),
        );
      } catch (err) {
        caught = err;
      }
      expect(caught, 'expected a negative refund to be refused at all').toBeInstanceOf(Error);
      const err = caught as Error & { userMessage?: string };
      // `refuse(raw, sentence)`'s own Invariant 1 — `message` stays `raw`, byte-identical, whether
      // or not the conversion has landed yet.
      expect(err.message).toBe('writeOffPrepaidItem: a refund cannot be negative.');
      expect(err.userMessage, 'was red before d072356: no userMessage — a plain Error, not yet a RefusalError').toBe(
        'The refund amount cannot be negative.',
      );
      expect(await journalEntryCountFor(f.itemId), 'no journal entry should have been posted').toBe(0);
    },
    30000,
  );
});

describe('P3 (DEF-460) — a positive refund with no account refuses by name', () => {
  it(
    'refundAmount "100", no refundAccountCode: wanted "Say which account the refund landed in." — was red before d072356: it was not shown',
    async () => {
      const f = await prepaidFixture('p3');
      ACTOR_HOLDER.actor = f.admin;
      const { writeOffAction } = await import('../../src/app/prepaid/actions');

      const to = await expectRedirectTo(() => writeOffAction(writeOffFormData(f, { refundAmount: '100' })));
      const params = new URL(to, 'http://localhost').searchParams;
      expect(params.get('error'), `redirect URL was: ${to}`).toBe('Say which account the refund landed in.');
      expect(await journalEntryCountFor(f.itemId), 'no journal entry should have been posted').toBe(0);
    },
    30000,
  );
});

describe('P4 (DEF-460) — a refund above what is left refuses by name', () => {
  it(
    'refundAmount above the ₱24,000 remaining: wanted the sentence starting "The refund can\'t be more than what\'s left on this item." — was red before d072356: it did not',
    async () => {
      const f = await prepaidFixture('p4');
      ACTOR_HOLDER.actor = f.admin;
      const { writeOffAction } = await import('../../src/app/prepaid/actions');

      const to = await expectRedirectTo(() =>
        writeOffAction(writeOffFormData(f, { refundAmount: '30000.00', refundAccountCode: '1110' })),
      );
      const params = new URL(to, 'http://localhost').searchParams;
      expect(params.get('error'), `redirect URL was: ${to}`).toMatch(
        /^The refund can.t be more than what.s left on this item\./,
      );
      expect(await journalEntryCountFor(f.itemId), 'no journal entry should have been posted').toBe(0);
    },
    30000,
  );
});

// =================================================================================================
// N1 — recordCollectionAction, negative store credit
// =================================================================================================

async function arFixture(hint: string) {
  const f = await orgFixture(hint);
  const [drawer] = await sql<{ id: string }[]>`
    select id from money_accounts where store_id = ${f.storeId} and instrument = 'cash' and custodian = 'cashier' and is_foundation`;
  const customer = await asOrg(f.orgId, (tx) => createCustomer(tx, f.admin, { name: `Resto ${uid('cust')}` }));
  const { chargeId } = await asOrg(f.orgId, (tx) =>
    recordCharge(tx, f.admin, {
      storeId: f.storeId,
      customerId: customer.id,
      chargeDate: '2026-01-10',
      dueDate: null,
      totalAmount: '1000.00',
      revenueAccountCode: '4150',
    }),
  );
  return { ...f, customerId: customer.id, drawerId: drawer!.id, chargeId };
}

function collectionFormData(f: Awaited<ReturnType<typeof arFixture>>, creditApplied: string): FormData {
  const fd = new FormData();
  fd.set('customerId', f.customerId);
  fd.set('storeId', f.storeId);
  fd.set('collectionDate', '2026-01-20');
  fd.set('amount', '1000.00');
  fd.set('platformFee', '0');
  fd.set('moneyAccountId', f.drawerId);
  fd.append('allocateChargeId', f.chargeId);
  fd.set(`allocateAmount_${f.chargeId}`, '1000.00');
  if (creditApplied) fd.set('creditApplied', creditApplied);
  return fd;
}

async function collectionCountFor(customerId: string): Promise<number> {
  const [row] = await sql<{ count: string }[]>`
    select count(*)::text as count from ar_collections where customer_id = ${customerId}`;
  return Number(row!.count);
}

describe('N1 (DEF-461) — a negative store credit refuses by name', () => {
  it(
    'creditApplied "-5": wanted "The store credit applied cannot be negative." — was red before d072356: the screen showed "creditApplied cannot be negative." instead',
    async () => {
      const f = await arFixture('n1');
      ACTOR_HOLDER.actor = f.admin;
      const { recordCollectionAction } = await import('../../src/app/customers/actions');

      const before = await collectionCountFor(f.customerId);
      const to = await expectRedirectTo(() => recordCollectionAction(collectionFormData(f, '-5')));
      const params = new URL(to, 'http://localhost').searchParams;
      expect(params.get('error'), `redirect URL was: ${to}`).toBe('The store credit applied cannot be negative.');
      const after = await collectionCountFor(f.customerId);
      expect(after, 'no collection row should have been written').toBe(before);
    },
    30000,
  );
});

import { config } from 'dotenv';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-343 S5.5n — follow-ups from the S5.5m post-commit review (DEF-457, DEF-458 R1 lives in
 * `packages/domain/src/shared/money-input.test.ts`; this file is C1/C1n and L1).
 * `docs/tasks/343-def-417-human-readable-refusals.md` §S5.5n.
 *
 * ⛔ TESTER, not BUILDER.
 * - C1/C1n (DEF-457): before eb40f35, `apps/erp/src/app/customers/actions.ts`'s
 *   `recordCollectionAction` spread `creditApplied` only when `Number(creditApplied) > 0` —
 *   `Number('1,000')` is `NaN`, so a comma-typed credit was silently DROPPED (never reached the
 *   domain's own already-correct `parseMoneyInput` call at `packages/domain/src/ar/index.ts:245-247`),
 *   and the collection proceeded as if no credit was applied at all: it succeeded, and the money
 *   account was debited the full (un-netted) amount. Verified directly (`Number('1,000') > 0` is
 *   `false` in Node) before writing this file. Real Postgres throughout (bible §9 rule 3) — the app
 *   action itself, not the domain function, was red: the domain's own parse was already correct.
 *   eb40f35 fixed the app-layer gate; both legs below are green now.
 * - L1 (DEF-459): before eb40f35, `packages/domain/src/ap/index.ts`'s allocation-for-expense
 *   `parseMoneyInput` call had no logger wrap — zero `logger.info` calls. eb40f35 wired it; green
 *   now.
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
// `vitest.config.mts` never resolves; S5.5m/S7 precedent).
vi.mock('@/lib/constraint-messages', async () => {
  return await import('../../src/lib/constraint-messages');
});

import { transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { createCustomer, recordCharge, recordPayment, createSupplier } from '@shareat/domain';
import { seedChartOfAccounts } from '../../../../packages/db/seed/chart-of-accounts';
import { COLLECTION_RECORD_RULES } from '@shareat/domain/field-rules';
import { expectRuleSentence } from '../helpers/rule-sentence';
import { paramsOf } from '../helpers/flash-jar';

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

async function arFixture(hint: string) {
  const code = uid(`s55n-${hint}`);
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
  const [drawer] = await sql<{ id: string }[]>`
    select id from money_accounts where store_id = ${storeId} and instrument = 'cash' and custodian = 'cashier' and is_foundation`;
  const adminActor = actor(orgId, adminId);
  const customer = await asOrg(orgId, (tx) => createCustomer(tx, adminActor, { name: `Resto ${code}` }));
  const { chargeId } = await asOrg(orgId, (tx) =>
    recordCharge(tx, adminActor, {
      storeId,
      customerId: customer.id,
      chargeDate: '2026-01-10',
      dueDate: null,
      totalAmount: '1000.00',
      revenueAccountCode: '4150',
    }),
  );
  return { orgId, storeId, admin: adminActor, customerId: customer.id, drawerId: drawer!.id, chargeId };
}

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

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

async function expectRedirectTo(action: () => Promise<void>): Promise<string> {
  try {
    await action();
  } catch (err) {
    if (err instanceof RedirectSignal) return err.to;
    throw err;
  }
  throw new Error('expected the action to redirect');
}

async function collectionCountFor(customerId: string): Promise<number> {
  const [row] = await sql<{ count: string }[]>`
    select count(*)::text as count from ar_collections where customer_id = ${customerId}`;
  return Number(row!.count);
}

describe('C1 (DEF-457) — a comma-typed store credit is silently dropped, never reaches parseMoneyInput', () => {
  it(
    'creditApplied "1,000": was red before eb40f35 — the collection used to SUCCEED, full amount debited, no refusal naming the credit',
    async () => {
      const f = await arFixture('c1');
      ACTOR_HOLDER.actor = f.admin;
      const { recordCollectionAction } = await import('../../src/app/customers/actions');

      const before = await collectionCountFor(f.customerId);
      const to = await expectRedirectTo(() => recordCollectionAction(collectionFormData(f, '1,000')));
      const params = paramsOf(to);

      // Was asserted directly against the pre-fix behaviour (no `error` param — the action
      // redirected with `ok` instead — and a collection row was written); green since eb40f35.
      expectRuleSentence(params.get('error'), COLLECTION_RECORD_RULES.creditApplied, '1,000');
      const after = await collectionCountFor(f.customerId);
      expect(after, 'no collection row should have been written').toBe(before);
    },
    30000,
  );

  it(
    'C1n (⛔ green now) — an empty credit box: the collection succeeds, credit 0',
    async () => {
      const f = await arFixture('c1n');
      ACTOR_HOLDER.actor = f.admin;
      const { recordCollectionAction } = await import('../../src/app/customers/actions');

      const before = await collectionCountFor(f.customerId);
      const to = await expectRedirectTo(() => recordCollectionAction(collectionFormData(f, '')));
      const params = paramsOf(to);
      expect(params.get('error'), `redirect URL was: ${to}`).toBeNull();
      expect(params.get('ok')).toContain('Collected');
      const after = await collectionCountFor(f.customerId);
      expect(after).toBe(before + 1);
    },
    30000,
  );
});

describe('L1 (DEF-459) — the AP allocation-for-expense site logs a malformed amount before rethrowing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it(
    'was red before eb40f35 (zero logger.info calls, no wrap); the thrown userMessage was already correct and unchanged. S5.5p strengthening: the logged err.message names the expense id',
    async () => {
      const { logger } = await import('@shareat/core');
      const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => logger as never);

      const f = await arFixture('l1');
      const supplier = await asOrg(f.orgId, (tx) => createSupplier(tx, f.admin, { name: `${uid('sup')}` }));
      const fakeExpenseId = '01a0db2b-f5da-759b-a288-d3803c68dcf6';

      let caught: unknown;
      try {
        await asOrg(f.orgId, (tx) =>
          recordPayment(tx, f.admin, { requestId: crypto.randomUUID(),
            storeId: f.storeId,
            supplierId: supplier.id,
            businessDate: '2026-01-15',
            amount: '500.00',
            moneyAccountId: uid('acct'), // never reached — the allocation parse throws first
            allocations: [{ expenseId: fakeExpenseId, amountApplied: 'abc' }],
          }),
        );
      } catch (err) {
        caught = err;
      }

      expect(caught, 'the malformed allocation amount was not refused at all').toBeInstanceOf(Error);
      const userMessage = (caught as Error & { userMessage?: string }).userMessage;
      expect(userMessage, 'the parseMoneyInput sentence is already correct — DEF-459 only adds a log line').toBe(
        'An amount applied to an invoice — "abc" is not a valid amount. Use at most two decimal places.',
      );

      // Was red before eb40f35: nothing logged this. Green since.
      expect(infoSpy, 'expected the DEF-459 log line').toHaveBeenCalledTimes(1);

      // S5.5p strengthening — not just A call, but one whose logged error actually names THIS
      // expense (`rawLabel` embeds `a.expenseId` at the parseMoneyInput call site,
      // packages/domain/src/ap/index.ts:782), so a reader of the log can tell which allocation
      // failed without cross-referencing a separate id.
      const loggedErr = (infoSpy.mock.calls[0]?.[0] as { err?: Error } | undefined)?.err;
      expect(loggedErr?.message, 'the logged error should name the expense id').toContain(fakeExpenseId);
    },
    30000,
  );
});

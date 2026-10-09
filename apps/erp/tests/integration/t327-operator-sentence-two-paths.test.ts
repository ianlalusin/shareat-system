import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-327 test 3 — docs/tasks/327-a-poison-value-that-passes-every-guard.md §Tests item 3, as
 * strengthened by the orchestrator 2026-09-19 (3a/3b) after the auditor read the spec cold.
 *
 * ⭐⭐ T-328 — PATH 1 REPOINTED TWICE, 2026-09-20. THE FIRST REPOINTING WAS ITSELF WRONG.
 * The original path 1 was `createTradeOrder({ deliveryFee: 'abc' })` — chosen when this file was
 * written because `deliveryFee` was, at the time, unguarded at the app layer. T-327 and T-328 were
 * specced the same week, and T-328's own spec names `deliveryFee` explicitly as a site it would
 * convert. T-328 Contract §4a did exactly that: `deliveryFee` now goes through `parseMoneyInput`
 * before it ever reaches `trade_orders`, so `'abc'` is refused by the APP, no row is attempted, no
 * constraint fires. Invariant 4 of T-328's spec says this in so many words: "T-327's constraints
 * never fire from an enumerated path. If one does, the conversion at that site is wrong." The old
 * test failing was that invariant holding, not breaking. **A test built on a path scheduled for
 * its own closure is a real category, worth recording where the next person reads it.**
 *
 * ⛔ THE FIRST REPAIR REPEATED THE SAME MISTAKE ONE STEP OUT, AND IT IS WORTH SAYING WHY IT LOOKED
 * SAFE: `renameMoneyAccount({ overdraftLimit: 'NaN' })` → `money_accounts.overdraft_limit` was
 * verified, correctly, to be unguarded at the app layer — `Number('NaN') < 0` is `false`, the raw
 * string reaches the column verbatim. **What was wrong was the conclusion that it was therefore
 * SAFE, on the reasoning "not a FormData-reading app action, so T-328 will never touch it."**
 * `renameMoneyAccount` is not itself a FormData reader, but its caller is:
 * `apps/erp/src/app/money-accounts/actions.ts:71` reads `str(formData, 'overdraftLimit')` and
 * passes it straight through. It is a live, user-typed money path T-328's own enumeration never
 * listed (filed DEF-395) — a real defect, not a safe test fixture, and a path just as eligible for
 * closure as `deliveryFee` was. **"Not called from FormData" has to mean the ENTIRE call chain,
 * traced to an actual UI form, not just the one function being read.**
 *
 * ⭐ THE ACTUAL FIX: pick a column NO FormData path can EVER reach, not merely one that happens to
 * be unguarded today. `postEntry({ lines: [{ debit: 'NaN', ... }] })` → `journal_lines.debit`.
 * `postEntry` (`packages/domain/src/ledger/post-entry.ts`) is, by its own header, "the ONLY way
 * anything writes to journal_entries / journal_lines" — every poster (expenses, sales, payroll,
 * the ETL) goes through it, and it is "deliberately thin... does not re-check" any of T-103's
 * DB-enforced invariants, `debit`/`credit` included; they are typed `string`, passed straight into
 * the insert. Verified this is genuinely unreachable from any UI form, not merely from this one
 * function: `grep -rl "postEntry(" apps/erp/src` returns NOTHING — every one of `postEntry`'s 27
 * callers is a domain function, none is an `actions.ts`. A raw ledger primitive with no FormData
 * path to it at all, ever, is not "currently unguarded" the way `deliveryFee` and `overdraftLimit`
 * were — there is no conversion that could ever close it, because there is no typed box behind it
 * to convert. This is what T-327's backstop is actually FOR: the case where the app layer, by
 * construction, has no opinion at all.
 *
 * ⭐ Two REAL domain paths, two DIFFERENT tables, neither needing a source change — proving §2's
 * suffix rule rather than letting one exact-name `CONSTRAINT_MESSAGES` entry pass this green:
 *
 *   1. `postEntry({ lines: [{ debit: 'NaN', credit: '0', accountCode: '6200' }] })` — `postEntry`
 *      performs no validation of its own on `debit`/`credit`; the raw string reaches
 *      `journal_lines.debit` verbatim, on a function no FormData reader ever calls.
 *   2. `setPrice({ ..., rate: 'NaN' })` — `Number('NaN') < 0` is false, and `input.rate` is
 *      inserted VERBATIM (no `.toFixed`) into `price_list_items.rate`. A different mechanism, a
 *      different table, the same poison shape.
 *
 * ⛔ THE ACTUAL side (the message a cashier sees) MUST come from the real code, so `errorMessage`
 * is imported and called on the real caught error — that function *is* the code under test.
 * ⛔ THE EXPECTED side is a HAND-WRITTEN LITERAL, never read from `CONSTRAINT_MESSAGES` or any
 * helper that consults it — importing only `errorMessage`, never `CONSTRAINT_MESSAGES` itself, is
 * what keeps this test able to fail. If both sides came from the map, the map would define its own
 * correctness (`money-positivity-guard.test.ts`'s and this repo's own recurring lesson: a control
 * that computes its own expectation controls nothing).
 * ⛔ The constraint NAME is derived from the real driver's `err.constraint_name` field — the same
 * technique `constraint-message-lookup.test.ts` already uses — never from the map either.
 *
 * ⭐ RED TODAY, for a PRIOR reason: no `_finite_check` constraint exists yet (lane DB is at 0154,
 * deliberately not migrated — that is what makes this red real), so `provoke()` itself fails with
 * "expected a real constraint violation, but the call succeeded" before either assertion below is
 * ever reached. A wrong literal and a right literal produce the identical red right now. The
 * literal-mutation check ("change a word, watch it go red") is only meaningful once migration
 * `0155` and the `constraint-messages.ts` suffix rule both exist — done and reported separately
 * once the builder ships them, not claimed here.
 *
 * ⛔ CLEANUP — orchestrator, 2026-09-19: a red run before the migration lands means the call
 * actually SUCCEEDS, which means it actually WRITES a real row — measured live, this is precisely
 * what left 7 poisoned `trade_orders` rows and 3 poisoned `price_list_items` rows in the lane DB
 * and blocked migration `0155` when it was finally applied. `provoke()` below deletes whatever the
 * successful call created, by explicit primary/natural key, strictly AFTER capturing proof it was
 * really written (its own returned id, or the natural key `setPrice` upserts on) — never before,
 * so the red this test exists to produce stays exactly as real as it was.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(
    `Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`,
  );
}

import { transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { createItem, createPriceList, postEntry } from '@shareat/domain';
import { seedChartOfAccounts } from '../../../../packages/db/seed/chart-of-accounts';
import { errorMessage } from '../../src/lib/constraint-messages';
import { testItemCode } from '../../../../packages/domain/tests/integration/_fixtures/item-code';

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

async function fixture() {
  const code = uid('t327-op');
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid('store')}, 'Store') returning id`;
  const storeId = store!.id;

  const mkPerson = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
    return p!.id;
  };
  const superAdminId = await mkPerson('Super', 'super_admin');
  const adminId = await mkPerson('Admin', 'admin');
  const managerId = await mkPerson('Manager', 'manager');

  return {
    orgId,
    storeId,
    superAdmin: actor(orgId, superAdminId),
    admin: actor(orgId, adminId),
    manager: actor(orgId, managerId),
  };
}

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

/**
 * Runs `fn`, expecting it to throw a real error. Fails loudly if it does not — but first, if
 * `cleanupOnSuccess` is given, hands it the real result so the row(s) the call actually wrote can
 * be deleted by explicit key before this throws. The write already happened and is fully
 * observable (the caller has `ok`, proof it was real) before cleanup ever runs.
 */
async function provoke<T>(fn: () => Promise<T>, cleanupOnSuccess?: (ok: T) => Promise<void>): Promise<unknown> {
  let ok: T;
  try {
    ok = await fn();
  } catch (err) {
    return err;
  }
  if (cleanupOnSuccess) {
    try {
      await cleanupOnSuccess(ok);
    } catch (cleanupErr) {
      throw new Error(`expected a real constraint violation, but the call succeeded (cleanup also failed: ${cleanupErr})`);
    }
  }
  throw new Error('expected a real constraint violation, but the call succeeded');
}

/**
 * T-371 S2: `postEntry` now refuses 'NaN' in the domain parser before the database, so the journal_lines CHECK is reached by a RAW insert (a draft entry + one
 * 'NaN' debit line) — the constraint, not the parser, is what these two paths test. The parser's own refusal has its own leg below.
 */
const nanJournalLine = async (tx: Tx, orgId: string) => {
  // two statements, not one CTE: the journal_lines RLS policy reads the entry, which a same-statement CTE insert is not yet visible to
  const entry = await tx.execute(dsql`insert into journal_entries (org_id, entry_date, period_id, source_type, source_id)
    select ${orgId}, '2026-01-10'::date, p.id, 'test', ${uid('src')} from fiscal_periods p where p.org_id = ${orgId} and p.starts_on = '2026-01-01' returning id`);
  const entryId = (entry as unknown as { id: string }[])[0]!.id;
  await tx.execute(dsql`insert into journal_lines (entry_id, line_no, account_id, debit, credit)
    select ${entryId}::uuid, 1, a.id, 'NaN', '0' from accounts a where a.org_id = ${orgId} and a.code = '6200'`);
};

/** The raw driver's own structured field — never CONSTRAINT_MESSAGES, never a parse of prose. */
function constraintNameOf(err: unknown): string | null {
  const name = (err as { constraint_name?: unknown } | null)?.constraint_name;
  return typeof name === 'string' && name.length > 0 ? name : null;
}

// ⛔ Hand-typed, verbatim from spec §2's own house-style example. Never read from
// CONSTRAINT_MESSAGES — that is the whole point of this file.
const EXPECTED_SENTENCE = 'That is not a valid amount. Enter a figure like 1234.50.';

describe('T-327 test 3 — the cashier reads a sentence, on two different constraints', () => {
  it("⛔ path 1 — postEntry, debit: 'NaN' → journal_lines.debit (a ledger primitive no FormData reaches)", async () => {
    const f = await fixture();
    await seedChartOfAccounts(sql, f.orgId);
    await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) select ${f.orgId}, m::date, (m + interval '1 month - 1 day')::date, 'open' from generate_series('2026-01-01'::date, '2026-12-01'::date, interval '1 month') m`;

    const err = await provoke(() =>
      asOrg(f.orgId, (tx) =>
        nanJournalLine(tx, f.orgId),
      ),
    );

    const constraintName = constraintNameOf(err);
    expect(constraintName).toMatch(/^journal_lines_.*_finite_check$/);
    expect(errorMessage(err)).toBe(EXPECTED_SENTENCE);
  });

  it('⛔ path 2 — setPrice, rate: \'NaN\' → price_list_items.rate (a different table, a different mechanism)', async () => {
    const f = await fixture();
    const item = await asOrg(f.orgId, (tx) =>
      createItem(tx, f.superAdmin, {
        code: testItemCode(),
        name: `Item ${uid('n')}`,
        kind: 'raw_material',
        baseUnit: 'kg',
        sellableWholesale: true,
      }),
    );
    const list = await asOrg(f.orgId, (tx) => createPriceList(tx, f.admin, { name: `List ${uid('l')}` }));

    // T-343 S5.5v item 6 — `setPrice` now routes `rate` through `parseMoneyInput` first, which
    // refuses 'NaN' before it ever reaches this constraint (that path is closed by the parser).
    // Repointed to a raw INSERT (after T-371 S2 no repo writer accepts a plain string; the DB CHECK is what this leg tests) — the same table, the same raw-string-to-numeric
    // mechanism, just without the domain function that would now intercept it.
    const err = await provoke(
      () =>
        asOrg(f.orgId, (tx) =>
          tx.execute(dsql`insert into price_list_items (org_id, price_list_id, item_id, rate) values (${f.orgId}, ${list.id}, ${item.id}, 'NaN')`),
        ),
      // `upsertPriceListItem` upserts on the (priceListId, itemId) natural key, so that pair is
      // what identifies the row it wrote.
      async () => {
        await sql`delete from price_list_items where price_list_id = ${list.id} and item_id = ${item.id}`;
      },
    );

    const constraintName = constraintNameOf(err);
    expect(constraintName).toMatch(/^price_list_items_.*_finite_check$/);
    expect(errorMessage(err)).toBe(EXPECTED_SENTENCE);
  });

  it("postEntry refuses debit 'NaN' with the plain sentence before the database (T-371's intended behaviour; no constraint is reached)", async () => {
    const f = await fixture();
    await seedChartOfAccounts(sql, f.orgId);
    await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) select ${f.orgId}, m::date, (m + interval '1 month - 1 day')::date, 'open' from generate_series('2026-01-01'::date, '2026-12-01'::date, interval '1 month') m`;
    let thrown: unknown = null;
    try {
      await asOrg(f.orgId, (tx) =>
        postEntry(tx, { orgId: f.orgId, entryDate: '2026-01-10', sourceType: 'test', sourceId: uid('src'), idempotencyKey: uid('idem'), lines: [{ accountCode: '6200', debit: 'NaN', credit: '0' }] }),
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown, 'postEntry accepted a NaN debit').not.toBeNull();
    expect(constraintNameOf(thrown), 'it reached a database constraint instead of being refused first').toBeNull();
    expect((thrown as { userMessage?: string }).userMessage ?? (thrown as Error).message).toContain('"NaN" is not a valid amount');
    const [n] = await sql<{ n: number }[]>`select count(*)::int as n from journal_entries where org_id = ${f.orgId}`;
    expect(n!.n, 'a refused entry left a row').toBe(0);
  });

  it('the two paths trip two DIFFERENT constraint names — proving a suffix rule, not one exact-name entry', async () => {
    const f = await fixture();
    const item = await asOrg(f.orgId, (tx) =>
      createItem(tx, f.superAdmin, {
        code: testItemCode(),
        name: `Item ${uid('n')}`,
        kind: 'raw_material',
        baseUnit: 'kg',
        sellableWholesale: true,
      }),
    );
    const list = await asOrg(f.orgId, (tx) => createPriceList(tx, f.admin, { name: `List ${uid('l')}` }));
    await seedChartOfAccounts(sql, f.orgId);
    await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) select ${f.orgId}, m::date, (m + interval '1 month - 1 day')::date, 'open' from generate_series('2026-01-01'::date, '2026-12-01'::date, interval '1 month') m`;

    const err1 = await provoke(() =>
      asOrg(f.orgId, (tx) =>
        nanJournalLine(tx, f.orgId),
      ),
    );
    // T-343 S5.5v item 6 — same re-point as path 2: `setPrice` now closes this path via
    // `parseMoneyInput`, so this leg calls the repo directly to still reach the constraint.
    const err2 = await provoke(
      () =>
        asOrg(f.orgId, (tx) =>
          tx.execute(dsql`insert into price_list_items (org_id, price_list_id, item_id, rate) values (${f.orgId}, ${list.id}, ${item.id}, 'NaN')`),
        ),
      async () => {
        await sql`delete from price_list_items where price_list_id = ${list.id} and item_id = ${item.id}`;
      },
    );

    const name1 = constraintNameOf(err1);
    const name2 = constraintNameOf(err2);
    expect(name1).not.toBeNull();
    expect(name2).not.toBeNull();
    expect(name1).not.toBe(name2);
    // Same sentence from two different constraint names is exactly what a suffix rule produces —
    // and exactly what N exact-name entries with copied wording would also produce. This test
    // cannot by itself distinguish the two mechanisms (the orchestrator's own note); it raises the
    // price of faking it. Reading constraint-messages.ts settles which one shipped.
    expect(errorMessage(err1)).toBe(EXPECTED_SENTENCE);
    expect(errorMessage(err2)).toBe(EXPECTED_SENTENCE);
  });
});

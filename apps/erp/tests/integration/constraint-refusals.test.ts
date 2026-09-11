/**
 * T-261 — DEF-274, bible §13 row 189. `docs/tasks/261-def-274-counter-reaches-money-screens.md`
 * §B7.1 / §B4.1.
 *
 * ⛔ **Lives here, not in `packages/domain/tests/integration/constraint-refusals.test.ts`.**
 * The subject under test is the actual APP-LAYER wrapper (`withOrgPrincipal` /
 * `recordingRefusalsFor`, both in `../../src/app/expenses/lib.ts`), and a `packages/` test may
 * never import from an app (`tests/unit/app-boundaries.test.ts`, bible §8). Precedent for this
 * exact shape: `apps/erp/tests/integration/sign-out-action.test.ts` dynamically imports a real
 * app-layer action to integration-test it against real Postgres.
 *
 * ⛔ **T-245's original bug, restated exactly, because this is the property that matters:** a
 * recorder that writes inside the transaction the refusal aborts records NOTHING, for ever, with
 * NOTHING RED. `recordConstraintRefusal` (packages/domain) is already immune to that specific shape
 * — it always opens its own independent connection via `@shareat/db`'s `withOrgPrincipal`, so a
 * caller's rollback can never take its write with it. The failure mode THIS wrapper can still
 * reproduce is different and easy to write by accident: `return dbWithOrgPrincipal(orgId, fn)`
 * (no `await`) inside a `try` never enters that `try`'s own `catch` at all — the rejection
 * propagates straight to the caller, so the outer `await expect(...).rejects.toThrow(...)` below
 * would still pass, and the ONLY visible symptom is that `prerequisite_refusals` never gains a row.
 * **That is what was run red before this file was trusted** — see the READY report for the actual
 * zero-rows output, captured by temporarily deleting the `await` in `expenses/lib.ts`, then restored.
 */
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(
    `Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`,
  );
}

// ⭐ The DB-level helper, deliberately NOT the app's same-named one — see the null-tx case below.
import { withOrgPrincipal as dbWithOrgPrincipal } from '@shareat/db';
import { withOrgPrincipal, recordingRefusalsFor } from '../../src/app/expenses/lib';
import { seedChartOfAccounts } from '../../../../packages/db/seed/chart-of-accounts';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

/** Minimal fixture: an org/store/person, plus the employment + session rows §B7.1(b)'s
 *  `attendance_adjustments` insert needs for its own NOT NULL foreign keys. */
async function fixture(hint: string) {
  const code = uid(`t261-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const storeId = store!.id;
  const [person] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Actor') returning id`;
  const personId = person!.id;
  const [emp] = await sql<{ id: string }[]>`
    insert into employments (org_id, person_id, store_id, staff_code, started_on, employment_status, created_by)
    values (${orgId}, ${personId}, ${storeId}, ${uid('sc')}, '2026-01-01', 'regular', ${personId}) returning id`;
  const employmentId = emp!.id;
  const [cred] = await sql<{ id: string }[]>`
    insert into person_credentials (person_id, kind, store_id, secret_hash, lookup_hash)
    values (${personId}, 'pin', ${storeId}, ${uid('h')}, ${uid('l')}) returning id`;
  const [session] = await sql<{ id: string }[]>`
    insert into sessions (token_hash, person_id, credential_id, credential_kind, store_id, expires_at)
    values (${uid('tok')}, ${personId}, ${cred!.id}, 'pin', ${storeId}, now() + interval '12 hours')
    returning id`;
  return { orgId, storeId, personId, employmentId, sessionId: session!.id };
}

afterAll(async () => {
  await sql.end();
});

describe('T-261 — §B7.1(a) immediate CHECK violation, through the real app-layer wrapper', () => {
  it('is recorded with the constraint name and both context fields null (Ian’s ruling)', async () => {
    const f = await fixture('immediate');

    // money_accounts_name_not_blank_check — unmapped in both CONSTRAINT_MESSAGES and
    // LOCALLY_MAPPED_CONSTRAINT_NAMES, and trivial to reach with a raw insert.
    await expect(
      withOrgPrincipal(f.orgId, (tx) =>
        tx.execute(dsql`
          insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian)
          values (${f.orgId}, ${f.storeId}, '', 'cash', '1100', 'cashier')
        `),
      ),
    ).rejects.toThrow(/money_accounts_name_not_blank_check/);

    const rows = await sql`
      select reason_code, domain, store_id, actor_person_id from prerequisite_refusals
      where org_id = ${f.orgId} and reason_code = 'money_accounts_name_not_blank_check'
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]!.domain).toBe('constraint');
    expect(rows[0]!.store_id).toBeNull();
    expect(rows[0]!.actor_person_id).toBeNull();
  });
});

describe('T-261 — §B7.1(b) deferred violation, raised at COMMIT', () => {
  it('the deferrable self-referencing FK on attendance_adjustments is recorded even though it fires after the callback returns', async () => {
    const f = await fixture('deferred');
    const nonExistentId = '00000000-0000-0000-0000-000000000000';

    // packages/db/migrations/0084_t158_attendance_adjustments.sql:38-39. Reached by direct insert,
    // not a domain function — the write order is deliberately arranged so this FK never fires in
    // normal operation (migration comment, lines 32-37).
    await expect(
      withOrgPrincipal(f.orgId, (tx) =>
        tx.execute(dsql`
          insert into attendance_adjustments
            (org_id, store_id, employment_id, shift_day, kind,
             decided_by_session_id, decided_by_person_id, superseded_by_adjustment_id)
          values
            (${f.orgId}, ${f.storeId}, ${f.employmentId}, '2026-01-01', 'verify',
             ${f.sessionId}, ${f.personId}, ${nonExistentId})
        `),
      ),
    ).rejects.toThrow(/attendance_adjustments/);

    const rows = await sql`
      select reason_code, domain, store_id, actor_person_id from prerequisite_refusals
      where org_id = ${f.orgId} and domain = 'constraint'
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]!.reason_code).toMatch(/superseded_by_adjustment_id/);
    expect(rows[0]!.store_id).toBeNull();
    expect(rows[0]!.actor_person_id).toBeNull();
  });
});

describe('T-261 — §B7.1(c) / §B4.1 a refusal on a null-tx path is recorded', () => {
  it('recordingRefusalsFor catches a refusal from a call that opens its own transaction, same shape as the six wrapped F8 call sites', async () => {
    const f = await fixture('nulltx');

    // ⭐ WHAT THIS PROVES, and it is narrower than it used to claim: `recordingRefusalsFor` wraps
    // a CALL rather than a transaction, so it still catches a refusal when the CALLEE opens the
    // transaction itself and the wrapper never sees it. That is the mechanism, and the callee
    // below still opens its own transaction.
    //
    // ⛔ It used to open that transaction with the raw `transaction()` — no principal — because
    // it was imitating §B4.1's six null-tx call sites (DEF-282). **That imitation was removed
    // 2026-09-11 and the reason is worth keeping.** Armed against a non-bypass role, the bare
    // form never reaches this CHECK at all: RLS refuses the INSERT first, with `new row violates
    // row-level security policy for table "money_accounts"`. So the old shape stopped testing
    // refusal-recording and started testing DEF-282 — which is real, is filed, and is measured on
    // that row using exactly this observation. It is not this test's subject, and the shape it
    // copied is being deleted by DEF-282's own fix.
    //
    // ⚠️ One consequence of that RLS-first refusal is worth knowing, because it bites on the
    // production switch: an RLS error carries no `constraint "..."` clause, so
    // `parseConstraintName` (a regex over the message — DEF-286) returns null and NOTHING is
    // filed. The refusal happens and no row records it.
    // ⛔ `dbWithOrgPrincipal` — @shareat/db's — and NOT this app's same-named wrapper, which is
    // itself the refusal-counter chokepoint (`lib.ts:157`) and would file a second row. Using it
    // here records the refusal TWICE and the count below goes to 2, which is how this was caught.
    // ⭐ That double-count is worth keeping in mind rather than merely avoiding: it is the proof
    // that `recordingRefusalsFor` really is the recorder on this path, which is the whole claim.
    await expect(
      recordingRefusalsFor(f.orgId, () =>
        dbWithOrgPrincipal(f.orgId, (tx) =>
          tx.execute(dsql`
            insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian)
            values (${f.orgId}, ${f.storeId}, '', 'cash', '1100', 'cashier')
          `),
        ),
      ),
    ).rejects.toThrow(/money_accounts_name_not_blank_check/);

    const rows = await sql`
      select reason_code, domain, store_id, actor_person_id from prerequisite_refusals
      where org_id = ${f.orgId} and reason_code = 'money_accounts_name_not_blank_check'
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]!.domain).toBe('constraint');
    expect(rows[0]!.store_id).toBeNull();
    expect(rows[0]!.actor_person_id).toBeNull();
  });
});

/**
 * T-270 — DEF-279. Before migration 0142 these two constraint triggers raised bare
 * `RAISE EXCEPTION` text with no `USING CONSTRAINT`, so `recordIfUnmappedConstraint` recorded
 * NOTHING for either — the exact structural zero DEF-279 exists to close. Run against `HEAD`
 * (pre-migration) first: both assertions below on `prerequisite_refusals` failed with 0 rows,
 * confirmed by temporarily reverting migration 0142 and `constraint-messages.ts`'s resolver
 * (`git diff` saved, reverted via the same non-git-checkout round-trip as T-267/T-269, reapplied).
 *
 * ⭐ The assertion that matters most (spec §SPEC CORRECTION 1): `journal_entries_balance_check` and
 * `journal_lines_balance_check` share ONE underlying function (`journal_check_entry_balance`), so a
 * naive fix could easily attribute every refusal to whichever trigger the author had in mind, not
 * whichever one actually fired. The two tests below provoke each trigger SEPARATELY — one by editing
 * an EXISTING entry's lines only, the other by inserting entry+lines unbalanced together — and each
 * asserts the OTHER trigger's name is NOT what got recorded.
 */
describe('T-270 — DEF-279: the shared balance-check function records the CORRECT trigger name', () => {
  it('a line-only edit on an EXISTING draft entry records journal_lines_balance_check, never the entries one', async () => {
    const f = await fixture('t270-lines');
    await seedChartOfAccounts(sql, f.orgId);
    const [period] = await sql<{ id: string }[]>`
      insert into fiscal_periods (org_id, starts_on, ends_on, status)
      values (${f.orgId}, '2026-01-01', '2026-01-31', 'open') returning id`;
    const [cash] = await sql<{ id: string }[]>`select id from accounts where org_id = ${f.orgId} and code = '1110'`;
    const [opex] = await sql<{ id: string }[]>`select id from accounts where org_id = ${f.orgId} and code = '6900'`;

    // A genuinely valid, already-COMMITTED, balanced two-line draft entry — its own transaction,
    // entry + both lines together, so it exists durably before the app-layer write below ever runs.
    const entryId = crypto.randomUUID();
    await sql.begin(async (trx) => {
      await trx`
        insert into journal_entries (id, org_id, entry_date, period_id, source_type, source_id, status)
        values (${entryId}, ${f.orgId}, '2026-01-15', ${period!.id}, 'test', ${uid('src')}, 'draft')`;
      await trx`insert into journal_lines (entry_id, line_no, account_id, debit, credit) values (${entryId}, 1, ${opex!.id}, '100.00', '0')`;
      await trx`insert into journal_lines (entry_id, line_no, account_id, debit, credit) values (${entryId}, 2, ${cash!.id}, '0', '100.00')`;
    });

    // Through the APP-LAYER wrapper: a THIRD line, alone, as its own single autocommitted
    // statement. No journal_entries row is written in THIS transaction — journal_entries_balance_check
    // never fires — only journal_lines_balance_check's deferred trigger does, at the end of this
    // one INSERT's implicit commit.
    await expect(
      withOrgPrincipal(f.orgId, (tx) =>
        tx.execute(dsql`
          insert into journal_lines (entry_id, line_no, account_id, debit, credit)
          values (${entryId}, 3, ${opex!.id}, '999.00', '0')
        `),
      ),
    ).rejects.toThrow(/unbalanced/);

    const rows = await sql`
      select reason_code from prerequisite_refusals where org_id = ${f.orgId} and domain = 'constraint'
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]!.reason_code).toBe('journal_lines_balance_check');
  });

  it('an unbalanced entry inserted WITH its lines, together, records journal_entries_balance_check', async () => {
    const f = await fixture('t270-entries');
    await seedChartOfAccounts(sql, f.orgId);
    const [period] = await sql<{ id: string }[]>`
      insert into fiscal_periods (org_id, starts_on, ends_on, status)
      values (${f.orgId}, '2026-01-01', '2026-01-31', 'open') returning id`;
    const [cash] = await sql<{ id: string }[]>`select id from accounts where org_id = ${f.orgId} and code = '1110'`;
    const [opex] = await sql<{ id: string }[]>`select id from accounts where org_id = ${f.orgId} and code = '6900'`;
    const entryId = crypto.randomUUID();

    // Entry AND its (unbalanced) lines in the SAME transaction as the app-layer wrapper's tx — both
    // deferred triggers are pending at commit; journal_entries' fires first (queued first, since the
    // entry row is inserted before its lines, which every legitimate write already requires via the
    // entry_id FK) and raises before journal_lines' queued event gets a chance to.
    await expect(
      withOrgPrincipal(f.orgId, async (tx) => {
        await tx.execute(dsql`
          insert into journal_entries (id, org_id, entry_date, period_id, source_type, source_id, status)
          values (${entryId}, ${f.orgId}, '2026-01-15', ${period!.id}, 'test', ${uid('src')}, 'draft')
        `);
        await tx.execute(dsql`
          insert into journal_lines (entry_id, line_no, account_id, debit, credit)
          values (${entryId}, 1, ${opex!.id}, '50.00', '0')
        `);
        await tx.execute(dsql`
          insert into journal_lines (entry_id, line_no, account_id, debit, credit)
          values (${entryId}, 2, ${cash!.id}, '0', '30.00')
        `);
      }),
    ).rejects.toThrow(/unbalanced/);

    const rows = await sql`
      select reason_code from prerequisite_refusals where org_id = ${f.orgId} and domain = 'constraint'
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]!.reason_code).toBe('journal_entries_balance_check');
  });
});

/**
 * T-270 — DEF-279, the inventory half. `stock_movements_no_negative_on_hand_trg` raised the same
 * bare, unparseable text; same structural zero, same fix.
 */
describe('T-270 — DEF-279: a negative-on-hand refusal is recorded under its own constraint name', () => {
  it('a movement that would drive on-hand negative is recorded as stock_movements_no_negative_on_hand_trg', async () => {
    const f = await fixture('t270-stock');
    const [locType] = await sql<{ id: string }[]>`
      insert into location_types (org_id, code, name) values (${f.orgId}, ${uid('LT')}, 'Stockroom') returning id`;
    const [location] = await sql<{ id: string }[]>`
      insert into stock_locations (org_id, store_id, code, name, type_id, created_by)
      values (${f.orgId}, ${f.storeId}, ${uid('LOC')}, 'Main', ${locType!.id}, ${f.personId}) returning id`;
    const [item] = await sql<{ id: string }[]>`
      insert into items (org_id, code, name, kind, base_unit, created_by)
      values (${f.orgId}, ${uid('ITEM')}, 'Test Item', 'raw_material', 'kg', ${f.personId}) returning id`;

    // A real receipt first, as the OWNER connection — pure fixture setup, no refusal expected.
    await sql`
      insert into stock_movements
        (org_id, store_id, location_id, item_id, moved_at, quantity, kind, source_type, source_id, created_by)
      values (${f.orgId}, ${f.storeId}, ${location!.id}, ${item!.id}, '2026-01-20T02:00:00Z', '5',
              'receipt', 'delivery', ${crypto.randomUUID()}, ${f.personId})
    `;

    // Through the APP-LAYER wrapper: a usage movement that overdraws it.
    await expect(
      withOrgPrincipal(f.orgId, (tx) =>
        tx.execute(dsql`
          insert into stock_movements
            (org_id, store_id, location_id, item_id, moved_at, quantity, kind, source_type, source_id, created_by)
          values (${f.orgId}, ${f.storeId}, ${location!.id}, ${item!.id}, '2026-01-20T03:00:00Z', '-6',
                  'usage', 'usage', ${crypto.randomUUID()}, ${f.personId})
        `),
      ),
    ).rejects.toThrow(/negative/);

    const rows = await sql`
      select reason_code from prerequisite_refusals where org_id = ${f.orgId} and domain = 'constraint'
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]!.reason_code).toBe('stock_movements_no_negative_on_hand_trg');
  });
});

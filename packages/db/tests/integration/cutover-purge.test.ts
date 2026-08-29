import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * DEF-079 — the cutover purge could never have run.
 *
 * ⛔ `scripts/cutover-purge.ts` used to `DELETE` the purge-class tables, and `journal_entries`
 * carries a BEFORE DELETE trigger that raises on any POSTED row (bible invariant 5). Every real
 * ledger is posted rows, so the purge failed on the first one and rolled the whole thing back.
 *
 * ⚠️ **The gap was the test, not the trigger.** T-119's tests cover the classification and the
 * ordering — both correct — and nothing ever ran the purge against a POSTED ledger. This is that
 * test.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

const sql = postgres(url, { max: 2 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

/**
 * A posted entry, in its own org, left behind for the assertions to work against.
 *
 * ⚠️ ONE transaction for the whole fixture. The balance and minimum-two-lines checks are DEFERRED
 * constraint triggers, so they fire at COMMIT — inserting the header in its own statement commits
 * it alone, with zero lines, and the check fails there.
 */
async function aPostedEntry(): Promise<{ orgId: string; entryId: string }> {
  const code = uid('purge');
  return sql.begin(async (tx) => {
    const [org] = await tx<{ id: string }[]>`
      insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
    const orgId = org!.id;
    const [period] = await tx<{ id: string }[]>`
      insert into fiscal_periods (org_id, starts_on, ends_on, status)
      values (${orgId}, '2026-01-01', '2026-01-31', 'open') returning id`;
    const [debit] = await tx<{ id: string }[]>`
      insert into accounts (org_id, code, name, type, normal_balance, is_postable, is_system, status)
      values (${orgId}, '9001', 'Probe debit', 'expense', 'debit', true, true, 'active') returning id`;
    const [credit] = await tx<{ id: string }[]>`
      insert into accounts (org_id, code, name, type, normal_balance, is_postable, is_system, status)
      values (${orgId}, '9002', 'Probe credit', 'asset', 'debit', true, true, 'active') returning id`;
    const [entry] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, period_id, entry_date, source_type, source_id,
                                   idempotency_key, memo, status)
      values (${orgId}, ${period!.id}, '2026-01-10', 'manual_journal', ${uid('src')},
              ${uid('idem')}, 'purge probe', 'draft')
      returning id`;
    await tx`
      insert into journal_lines (entry_id, account_id, line_no, debit, credit)
      values (${entry!.id}, ${debit!.id}, 1, 100, 0), (${entry!.id}, ${credit!.id}, 2, 0, 100)`;
    await tx`update journal_entries set status = 'posted', posted_at = now() where id = ${entry!.id}`;
    return { orgId, entryId: entry!.id };
  });
}

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

describe('DEF-079 — the purge against a POSTED ledger', () => {
  it('⛔ DELETE is refused by the posted-immutability trigger — the bug, reproduced', async () => {
    const { entryId } = await aPostedEntry();
    await expect(
      sql.begin(async (tx) => {
        await tx`delete from journal_entries where id = ${entryId}`;
      }),
    ).rejects.toThrow(/posted journal entry .* cannot be deleted/);
  });

  it('⭐ TRUNCATE succeeds where DELETE cannot — and that is DEFINED behaviour, not a loophole', async () => {
    await aPostedEntry();
    // ⚠️ Rolled back deliberately: TRUNCATE is transactional in PostgreSQL, so this proves the
    // statement is ACCEPTED without emptying the ledger every other test in this suite is using.
    let truncated = false;
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe('truncate table "journal_lines", "journal_entries" cascade');
        truncated = true;
        throw new Error('ROLLBACK_ON_PURPOSE');
      });
    } catch (err) {
      if (!(err instanceof Error) || !err.message.includes('ROLLBACK_ON_PURPOSE')) throw err;
    }
    expect(truncated).toBe(true);

    // ...and the ledger is still there, because the transaction rolled back.
    const [row] = await sql<{ n: string }[]>`select count(*)::text as n from journal_entries`;
    expect(Number(row!.n)).toBeGreaterThan(0);
  });

  it('⚠️ the invariant stays armed for ordinary writes — an UPDATE to a posted entry still fails', async () => {
    const { entryId } = await aPostedEntry();
    await expect(
      sql.begin(async (tx) => {
        await tx`update journal_entries set memo = 'edited' where id = ${entryId}`;
      }),
    ).rejects.toThrow(/immutable/);
  });

  it('the purge script uses TRUNCATE for the purge class, not DELETE', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..');
    const src = readFileSync(join(root, 'scripts', 'cutover-purge.ts'), 'utf8');
    // ⚠️ Asserts the SHAPE, because the behaviour itself cannot be asserted without emptying a
    // shared database. Narrow on purpose: it fails if someone reverts to a bare delete loop.
    expect(src).toMatch(/truncate table/i);
    expect(src).not.toMatch(/for \(const t of order\) await tx`delete from/);
  });
});

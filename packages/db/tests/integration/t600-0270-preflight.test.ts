import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * T-600 S6 - migration 0270's pre-flight must FAIL CLOSED. journal_entries is FORCE ROW LEVEL SECURITY, so a role that RLS can
 * filter (no app.org_id set) counts 0 dirty rows and would let the migration pass; `SET LOCAL row_security = off` (as 0162/0163) makes that
 * role error instead. This runs the migration's OWN pre-flight statements (read from the file) against a dirty row.
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) throw new Error(`Refusing to run against ${redactDbUrl(url)} - name must contain "_test".`);

const MIGRATION = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'migrations', '0270_t600_journal_entry_date_in_period.sql');
const sql = postgres(url, { max: 2 });
afterAll(async () => {
  await sql.end({ timeout: 5 });
});

/** The migration's pre-flight: its row_security statements and its DO block, in file order. */
const preflight = (): string[] =>
  readFileSync(MIGRATION, 'utf8')
    .split('--> statement-breakpoint')
    .map((x) => x.replace(/^(\s*--.*\n)+/gm, '').trim())
    .filter((x) => /^SET LOCAL row_security/i.test(x) || /^DO \$\$/.test(x));

class Rollback extends Error {}
/** Plants one entry dated outside its period (trigger left off: the transaction is rolled back), then runs the pre-flight as `role`; always rolls back. */
async function runPreflightOnDirtyData(role: string | null): Promise<unknown> {
  try {
    await sql.begin(async (q) => {
      const [org] = await q<{ id: string }[]>`insert into organizations (name, code) values ('P0270 org', ${`p0270-${Date.now()}`}) returning id`;
      const [per] = await q<{ id: string }[]>`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${org!.id}, '2026-08-01', '2026-08-31', 'open') returning id`;
      await q.unsafe('alter table journal_entries disable trigger journal_entries_entry_date_in_period');
      await q`insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status) values (${org!.id}, '2026-09-15', ${per!.id}, 'opening_balance', 'p0270', 'draft')`;
      if (role) await q.unsafe(`set local role ${role}`);
      for (const stmt of preflight()) await q.unsafe(stmt);
      throw new Rollback();
    });
  } catch (e) {
    if (e instanceof Rollback) return null;
    return e;
  }
  return null;
}

describe('0270 pre-flight fails closed', () => {
  it('finds the statements it is supposed to run', () => {
    expect(preflight().length).toBe(3); // SET off, DO, SET on
  });

  it('a role that bypasses RLS counts the dirty row and refuses', async () => {
    const err = await runPreflightOnDirtyData(null);
    expect(String((err as Error | null)?.message)).toMatch(/journal entries are dated outside their period/);
  });

  it('a role RLS can filter fails loudly (never counts 0 and passes)', async () => {
    const err = await runPreflightOnDirtyData('shareat_app');
    expect(String((err as Error | null)?.message), 'the pre-flight must not pass silently against dirty data').toMatch(/row-level security/i);
  });
});

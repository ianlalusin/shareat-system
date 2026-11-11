/**
 * T-512 (T-511 S5c) TESTER - the seed in migration 0239 equals the registry defaults. docs/tasks/512-business-rules-s5c-spec.md "Table": "Seed: one row per existing org per key,
 * effective_from 2000-01-01, reason 'Starting value'. The reader still falls back to the registry default when a row is absent (new org, tests). A test pins
 * that the seed values in the SQL equal the registry defaults."
 *
 * RED today: there is no migration 0239 and no registry.
 *
 * ASSUMPTIONS beyond the agreed list (builders must follow them):
 *   - the seed is an INSERT INTO business_rule_values statement inside packages/db/migrations/0239_*.sql (statements split by `--> statement-breakpoint`), one row per
 *     existing org per key. This test replays those statements inside a transaction it rolls back, against a fresh org, so the VALUES in the SQL are checked, not a copy;
 *   - seed rows carry set_by null, effective_from 2000-01-01 and the reason "Starting value".
 * In a fresh CI database no org exists when the migration runs, so the seed inserts nothing there; the reader's registry fallback is what such an org uses, and the
 * resolution tests prove it. Replaying the SQL here is how the SQL itself stays tested.
 */
import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { config } from 'dotenv';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { RULE_REGISTRY } from '../../src/business-rules/registry';

const sql = postgres(url, { max: 3 });
afterAll(async () => {
  await sql.end({ timeout: 5 });
});
// Narrowed by T-539: the registry grew by two POS keys, seeded by 0241 (pinned in t539-seed-matches-registry). 0239 still seeds exactly these five.
const T512_KEYS = ['settlement.variance_floor_amount', 'settlement.variance_percent', 'settlement.loan_final_tolerance', 'tax.withholding_rate_percent', 'tax.vat_percent'];
const MIGRATIONS = join(__dirname, '..', '..', '..', 'db', 'migrations');

describe('T-512 seed - one row per existing org per key at 2000-01-01, equal to the registry defaults', () => {
  it('replaying the migration seed statement(s) for a fresh org writes exactly the five T-512 rows whose values ARE the registry defaults (0241 seeds the two POS keys; t539-seed-matches-registry pins every key) (the SQL is pinned to the code, then rolled back) [kills: a seed value that drifted from the registry]', async () => {
    const file = readdirSync(MIGRATIONS).find((n) => n.startsWith('0239_'));
    expect(file, 'no 0239 migration file').toBeDefined();
    const statements = readFileSync(join(MIGRATIONS, file!), 'utf8')
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter((s) => /insert\s+into\s+"?business_rule_values"?/i.test(s));
    expect(statements.length, 'the migration holds no INSERT INTO business_rule_values seed').toBeGreaterThanOrEqual(1);

    const code = `t512seed-${Date.now()}`;
    const rollback = new Error('rollback');
    let rows: { key: string; value: string; effective_from: string; set_by: string | null; reason: string }[] = [];
    await sql
      .begin(async (tx) => {
        const [o] = await tx<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
        for (const s of statements) await tx.unsafe(s);
        rows = await tx`select key, value::text, effective_from::text, set_by::text, reason from business_rule_values where org_id = ${o!.id} order by key`;
        throw rollback;
      })
      .catch((e) => {
        if (e !== rollback) throw e;
      });

    expect(rows.map((r) => r.key).sort()).toEqual(T512_KEYS.slice().sort());
    for (const r of rows) {
      const want = (RULE_REGISTRY as Record<string, { default: unknown }>)[r.key]!.default;
      expect(Number(r.value), r.key).toBe(Number(want));
      expect(r.effective_from, r.key).toBe('2000-01-01');
      expect(r.set_by, `${r.key}: the seed has no person`).toBeNull();
      expect(r.reason, r.key).toBe('Starting value');
    }
  });

  it('the seed SQL names no key outside the registry and no value the registry does not hold (a typo in a key would seed a row nobody reads) [kills: a seeded key that is not a rule]', () => {
    const file = readdirSync(MIGRATIONS).find((n) => n.startsWith('0239_'));
    expect(file, 'no 0239 migration file').toBeDefined();
    const text = readFileSync(join(MIGRATIONS, file!), 'utf8');
    const keys = new Set([...text.matchAll(/'((?:settlement|tax|payroll)\.[a-z_]+)'/g)].map((m) => m[1]!));
    expect([...keys].sort()).toEqual(T512_KEYS.slice().sort());
  });
});

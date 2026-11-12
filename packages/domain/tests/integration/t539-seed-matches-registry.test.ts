/**
 * T-539 S1 TESTER - the seed pin, widened. docs/tasks/539-pos-business-rule-keys.md R3 and R5: "0239's rows and 0241's rows together equal EVERY registry default.
 * A key with no seed row anywhere fails the test. Narrow the existing assertion to: 0239 seeds the five T-512 keys."
 *
 * RED today: there is no migration 0241 and the registry has no POS keys. Mirrors t512-seed-matches-registry.test.ts (replays the INSERT statements of the SQL files
 * for a fresh org inside a transaction it rolls back, so the VALUES in the SQL are checked, not a copy).
 *
 * NOTE for the builder: t512-seed-matches-registry.test.ts asserts `rows.map(key) == Object.keys(RULE_REGISTRY)` and that 0239 names exactly the registry's keys. Both
 * count EVERY registry key, so they fail the moment the two POS keys join the registry. Narrow both to the five T-512 keys (this file carries the "every key" pin instead).
 * Not edited here.
 *
 * ASSUMED: the 0241 file is packages/db/migrations/0241_*.sql, its seed is an INSERT INTO business_rule_values (statements split by `--> statement-breakpoint`),
 * seed rows carry set_by null, effective_from 2000-01-01 and reason "Starting value" (the 0239 pattern).
 */
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}

import { RULE_REGISTRY } from '../../src/business-rules/registry';

const sql = postgres(url, { max: 3 });
afterAll(async () => {
  await sql.end({ timeout: 5 });
});
const MIGRATIONS = join(__dirname, '..', '..', '..', 'db', 'migrations');

const T512_KEYS = ['settlement.variance_floor_amount', 'settlement.variance_percent', 'settlement.loan_final_tolerance', 'tax.withholding_rate_percent', 'tax.vat_percent'];
const POS_KEYS = ['pos.business_day_start_hour', 'pos.senior_pwd_discount_percent'];
const TABLE_KEYS = ['pos.table_warn_minutes'];

const fileOf = (prefix: string): string => {
  const f = readdirSync(MIGRATIONS).find((n) => n.startsWith(prefix));
  expect(f, `no ${prefix}* migration file`).toBeDefined();
  return join(MIGRATIONS, f!);
};
const seedStatements = (path: string): string[] =>
  readFileSync(path, 'utf8')
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => /insert\s+into\s+"?business_rule_values"?/i.test(s));

type Row = { key: string; value: string; effective_from: string; set_by: string | null; reason: string };

/** Replays the given seed statements for a fresh org, in order, and rolls back. */
async function replay(paths: string[]): Promise<Row[]> {
  const code = `t539seed-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const rollback = new Error('rollback');
  let rows: Row[] = [];
  await sql
    .begin(async (tx) => {
      const [o] = await tx<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
      for (const p of paths) {
        const stmts = seedStatements(p);
        expect(stmts.length, `${p} holds no INSERT INTO business_rule_values seed`).toBeGreaterThanOrEqual(1);
        for (const s of stmts) await tx.unsafe(s);
      }
      rows = await tx<Row[]>`select key, value::text, effective_from::text, set_by::text, reason from business_rule_values where org_id = ${o!.id} order by key`;
      throw rollback;
    })
    .catch((e) => {
      if (e !== rollback) throw e;
    });
  return rows;
}

const text = (path: string): string => readFileSync(path, 'utf8');
const namedKeys = (t: string): string[] => [...new Set([...t.matchAll(/'((?:settlement|tax|payroll|pos)\.[a-z_]+)'/g)].map((m) => m[1]!))].sort();

describe('T-539 seed pin - 0239, 0241 and 0245 together equal every registry default', () => {
  it('0239 on its own still seeds exactly the five T-512 keys (the old assertion, narrowed, not weakened) [kills: 0239 edited after it was applied]', async () => {
    const rows = await replay([fileOf('0239_')]);
    expect(rows.map((r) => r.key)).toEqual([...T512_KEYS].sort());
  });

  it('0241 on its own seeds exactly the two POS keys [kills: a POS key missing; an old key seeded twice]', async () => {
    const rows = await replay([fileOf('0241_')]);
    expect(rows.map((r) => r.key)).toEqual([...POS_KEYS].sort());
  });

  it('0241 seeds 20 and 4, at 2000-01-01, set_by null, reason "Starting value" [kills: a wrong value, date or reason in the SQL]', async () => {
    const rows = await replay([fileOf('0241_')]);
    const by = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(Number(by['pos.senior_pwd_discount_percent']!.value)).toBe(20);
    expect(Number(by['pos.business_day_start_hour']!.value)).toBe(4);
    for (const r of rows) {
      expect(r.effective_from, r.key).toBe('2000-01-01');
      expect(r.set_by, `${r.key}: the seed has no person`).toBeNull();
      expect(r.reason, r.key).toBe('Starting value');
    }
  });

  it('0245 on its own seeds exactly pos.table_warn_minutes: 90, at 2000-01-01, set_by null, reason "Starting value" [kills: a wrong value, date or reason; an old key seeded twice]', async () => {
    const rows = await replay([fileOf('0245_')]);
    expect(rows.map((r) => r.key)).toEqual(TABLE_KEYS);
    expect(Number(rows[0]!.value)).toBe(90);
    expect(rows[0]!.effective_from).toBe('2000-01-01');
    expect(rows[0]!.set_by).toBeNull();
    expect(rows[0]!.reason).toBe('Starting value');
  });

  it('0239, 0241, 0245 and 0248 for one org write exactly one row per registry key, and every value IS the registry default [kills: a seed value that drifted from the registry; a registry key with no seed row anywhere]', async () => {
    const rows = await replay([fileOf('0239_'), fileOf('0241_'), fileOf('0245_'), fileOf('0248_')]);
    expect(rows.map((r) => r.key)).toEqual(Object.keys(RULE_REGISTRY).sort());
    for (const r of rows) {
      const want = (RULE_REGISTRY as Record<string, { default: unknown }>)[r.key]!.default;
      expect(Number(r.value), r.key).toBe(Number(want));
      expect(r.effective_from, r.key).toBe('2000-01-01');
      expect(r.set_by, r.key).toBeNull();
      expect(r.reason, r.key).toBe('Starting value');
    }
  });

  it('the four files name no key outside the registry, and between them name every registry key [kills: a typo in a seeded key; a key nobody seeds]', () => {
    const named = [...new Set([...namedKeys(text(fileOf('0239_'))), ...namedKeys(text(fileOf('0241_'))), ...namedKeys(text(fileOf('0245_'))), ...namedKeys(text(fileOf('0248_')))])].sort();
    expect(named).toEqual(Object.keys(RULE_REGISTRY).sort());
  });

  it('0241 and 0245 are data only: no table, trigger, policy or grant [kills: schema work smuggled into a seed migration]', () => {
    for (const prefix of ['0241_', '0245_']) {
      const t = text(fileOf(prefix)).replace(/--[^\n]*/g, '');
      expect(t, prefix).not.toMatch(/\b(create|alter|drop)\s+(table|trigger|policy|function|index)\b/i);
      expect(t, prefix).not.toMatch(/\b(grant|revoke)\b/i);
    }
  });
});

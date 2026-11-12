import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
/**
 * T-558 R1 (TESTER) - the seed pin for migration 0248, and every key. docs/tasks/558-pos-sale-variance-tolerance.md R1: "Migration 0248_t558_pos_sale_variance_tolerance.sql: data only,
 * following the 0241/0245 seed pattern. It inserts 0.01 per org. Its journal entry is idx 248, with `when` = 0247's + 86400000."; "the seed pin, covering every key".
 *
 * Mirrors t539-seed-matches-registry.test.ts (replays the INSERT statements of the SQL files for a fresh org inside a transaction it rolls back, so the VALUES in the SQL are checked).
 * NOTE for the builder: t539-seed-matches-registry.test.ts asserts that 0239 + 0241 + 0245 equal EVERY registry key; the moment the registry gains pos.sale_variance_tolerance that
 * assertion (and the "three files name every key" one) fail. Widen both with 0248 (this file carries the four-file pin); also t539-pos-rules.test.ts's key-set assertions
 * (it asserts the EXACT four keys readPosRules returns) and t512-registry.test.ts's "T-539 adds three POS keys" assertion. Not edited here.
 *
 * RED NOW: there is no 0248 migration and no registry key.
 */
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
const KEY = 'pos.sale_variance_tolerance';
const FILE = '0248_t558_pos_sale_variance_tolerance.sql';

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

async function replay(paths: string[]): Promise<Row[]> {
  const code = `t558seed-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
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

describe('T-558 seed pin - migration 0248', () => {
  it('the file is named 0248_t558_pos_sale_variance_tolerance.sql', () => {
    expect(readdirSync(MIGRATIONS).filter((n) => n.startsWith('0248_'))).toEqual([FILE]);
  });

  it('the journal entry is idx 248, tag 0248_t558_pos_sale_variance_tolerance, with `when` = 0247 + 86400000 [kills: a journal entry out of order, which drizzle skips]', () => {
    const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as { entries: { idx: number; when: number; tag: string }[] };
    const e247 = journal.entries.find((e) => e.idx === 247);
    const e248 = journal.entries.find((e) => e.idx === 248);
    expect(e247, '0247 is in the journal').toBeDefined();
    expect(e248, '0248 is in the journal').toBeDefined();
    expect(e248!.tag).toBe(FILE.replace(/\.sql$/, ''));
    expect(e248!.when).toBe(e247!.when + 86_400_000);
    expect(journal.entries.at(-1)!.idx, '0248 is the last entry, or is followed only by later ones (0249 = T-557)').toBeGreaterThanOrEqual(248);
  });

  it('0248 on its own seeds exactly pos.sale_variance_tolerance: 0.01, at 2000-01-01, set_by null, reason "Starting value" [kills: a wrong value, date or reason; another key seeded twice]', async () => {
    const rows = await replay([fileOf('0248_')]);
    expect(rows.map((r) => r.key)).toEqual([KEY]);
    expect(Number(rows[0]!.value)).toBe(0.01);
    expect(rows[0]!.effective_from).toBe('2000-01-01');
    expect(rows[0]!.set_by).toBeNull();
    expect(rows[0]!.reason).toBe('Starting value');
  });

  it('0239, 0241, 0245 and 0248 for one org write exactly one row per registry key, and every value IS the registry default [kills: drift between the seed and the registry; a registry key with no seed row anywhere]', async () => {
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

  it('the four files name no key outside the registry, and between them name every registry key [kills: a typo in a seeded key]', () => {
    const named = [...new Set(['0239_', '0241_', '0245_', '0248_'].flatMap((p) => namedKeys(text(fileOf(p)))))].sort();
    expect(named).toEqual(Object.keys(RULE_REGISTRY).sort());
  });

  it('0248 is data only: no table, trigger, policy, function, index, constraint or grant [kills: schema work smuggled into a seed migration]', () => {
    const t = text(fileOf('0248_')).replace(/--[^\n]*/g, '');
    expect(t).not.toMatch(/\b(create|alter|drop)\s+(table|trigger|policy|function|index|constraint)\b/i);
    expect(t).not.toMatch(/\b(grant|revoke)\b/i);
  });
});

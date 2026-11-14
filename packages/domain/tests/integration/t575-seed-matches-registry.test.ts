import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
/**
 * T-575 (TESTER) - the seed pin for migration 0255, and every key. docs/tasks/575-pos-repeat-senior-id-warning.md as amended 13 Nov 2026: data only, the 0248 pattern, one row
 * per org with value 1 (pos.senior_id_repeat_days). Journal entry idx 255 (253 and 254 are reserved by other lanes), `when` = 0252's + 3 x 86400000
 * (ADR-012 s5: previous.when + 86400000 x (idx - previous.idx)).
 *
 * Mirrors t558-seed-matches-registry.test.ts (replays the INSERT statements of the SQL files for a fresh org inside a transaction it rolls back, so the VALUES in the SQL are checked).
 *
 * RED NOW: there is no 0255 migration and no registry key.
 */
import { config } from 'dotenv';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}

import { RULE_REGISTRY } from '../../src/business-rules/registry';

const sql = postgres(url, { max: 3 });
afterAll(async () => {
  await sql.end({ timeout: 5 });
});
const MIGRATIONS = join(__dirname, '..', '..', '..', 'db', 'migrations');
const KEY = 'pos.senior_id_repeat_days';
const FILE = '0255_t575_pos_senior_id_repeat_days.sql';
const SEEDS = ['0239_', '0241_', '0245_', '0248_', '0255_', '0256_'];

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
  const code = `t575seed-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
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

describe('T-575 seed pin - migration 0255', () => {
  it('the file is named 0255_t575_pos_senior_id_repeat_days.sql', () => {
    expect(readdirSync(MIGRATIONS).filter((n) => n.startsWith('0255_'))).toEqual([FILE]);
  });

  it('the journal entry is idx 255, tag 0255_t575_pos_senior_id_repeat_days, with `when` = 0252 + 3 x 86400000 [kills: a journal entry out of order, which drizzle skips]', () => {
    const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as { entries: { idx: number; when: number; tag: string }[] };
    const e252 = journal.entries.find((e) => e.idx === 252);
    const e255 = journal.entries.find((e) => e.idx === 255);
    expect(e252, '0252 is in the journal').toBeDefined();
    expect(e255, '0255 is in the journal').toBeDefined();
    expect(e255!.tag).toBe(FILE.replace(/\.sql$/, ''));
    expect(e255!.when).toBe(e252!.when + 3 * 86_400_000);
    expect(journal.entries.at(-1)!.idx, '0255 is the last entry, or is followed only by later ones').toBeGreaterThanOrEqual(255);
  });

  it('0255 on its own seeds exactly pos.senior_id_repeat_days: 1, at 2000-01-01, set_by null, reason "Starting value" [kills: a wrong value, date or reason; another key seeded twice]', async () => {
    const rows = await replay([fileOf('0255_')]);
    expect(rows.map((r) => r.key)).toEqual([KEY]);
    expect(Number(rows[0]!.value)).toBe(1);
    expect(rows[0]!.effective_from).toBe('2000-01-01');
    expect(rows[0]!.set_by).toBeNull();
    expect(rows[0]!.reason).toBe('Starting value');
  });

  it('0239, 0241, 0245, 0248, 0255 and 0256 (T-576) for one org write exactly one row per registry key, and every value IS the registry default [kills: drift between the seed and the registry; a registry key with no seed row anywhere]', async () => {
    const rows = await replay(SEEDS.map(fileOf));
    expect(rows.map((r) => r.key)).toEqual(Object.keys(RULE_REGISTRY).sort());
    for (const r of rows) {
      const want = (RULE_REGISTRY as Record<string, { default: unknown }>)[r.key]!.default;
      expect(Number(r.value), r.key).toBe(Number(want));
      expect(r.effective_from, r.key).toBe('2000-01-01');
      expect(r.set_by, r.key).toBeNull();
      expect(r.reason, r.key).toBe('Starting value');
    }
  });

  it('the six files (0256 = T-576) name no key outside the registry, and between them name every registry key [kills: a typo in a seeded key]', () => {
    const named = [...new Set(SEEDS.flatMap((p) => namedKeys(text(fileOf(p)))))].sort();
    expect(named).toEqual(Object.keys(RULE_REGISTRY).sort());
  });

  it('0255 is data only: no table, trigger, policy, function, index, constraint or grant [kills: schema work smuggled into a seed migration]', () => {
    const t = text(fileOf('0255_')).replace(/--[^\n]*/g, '');
    expect(t).not.toMatch(/\b(create|alter|drop)\s+(table|trigger|policy|function|index|constraint)\b/i);
    expect(t).not.toMatch(/\b(grant|revoke)\b/i);
  });
});

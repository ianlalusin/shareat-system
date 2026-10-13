import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * T-402 S1a audit - ACTION COVERAGE. `append` refuses an action it has no label for (UNKNOWN_AUDIT_ACTION) and
 * migration 0197 RAISEs on an unlisted action, so every action string the code writes must be in BOTH lists, and the
 * two lists must be the same set (a row written today must be labelled exactly like the row the migration copies).
 *
 * Writers found by source scan (no test files, no node_modules): `action: '...'` (incl. ternaries) in any file that
 * calls auditLogRepo.append, and menu's `audit(trx, actor, '<action>', ...)` helper (menu/shared.ts).
 * A writer whose action is a variable the scan cannot see is itself a failure ("dynamic action"), not a skip.
 */
const ROOT = join(__dirname, '..', '..');
const SKIP = new Set(['node_modules', '.next', 'dist', 'tests', 'migrations', '.git']);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

function writtenActions(): { actions: Map<string, string[]>; dynamic: string[] } {
  const files = [join(ROOT, 'packages'), join(ROOT, 'apps'), join(ROOT, 'scripts')].flatMap((d) => walk(d));
  const actions = new Map<string, string[]>();
  const dynamic: string[] = [];
  const add = (a: string, f: string) => actions.set(a, [...(actions.get(a) ?? []), relative(ROOT, f)]);
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    if (/auditLogRepo\.append\(/.test(text)) {
      for (const m of text.matchAll(/^\s*action:\s*([^\n]*)$/gm)) {
        const expr = m[1]!.includes('?') ? m[1]!.slice(m[1]!.indexOf('?')) : m[1]!;
        const quoted = [...expr.matchAll(/'([a-z][a-z0-9_.]*)'/g)].map((q) => q[1]!);
        if (quoted.length === 0 && !/^string[,\s]/.test(m[1]!.trim())) dynamic.push(`${relative(ROOT, f)}: action: ${m[1]}`);
        for (const q of quoted) add(q, f);
      }
    }
    for (const m of text.matchAll(/\baudit\(\s*\w+\s*,\s*\w+\s*,\s*'([a-z][a-z0-9_.]*)'/g)) add(m[1]!, f);
  }
  return { actions, dynamic };
}

function legacyLabelKeys(): Map<string, string> {
  const src = readFileSync(join(ROOT, 'packages/db/src/repo/audit-log.ts'), 'utf8');
  const start = src.indexOf('const LEGACY_LABELS');
  expect(start, 'LEGACY_LABELS exists in repo/audit-log.ts').toBeGreaterThan(-1);
  const block = src.slice(start, src.indexOf('};', start));
  const out = new Map<string, string>();
  for (const m of block.matchAll(/^\s*'?([a-z][a-z0-9_.]*)'?:\s*\{\s*category:\s*'(\w+)',\s*sensitivity:\s*'(\w+)'/gm)) out.set(m[1]!, `${m[2]}/${m[3]}`);
  return out;
}

function migrationLabels(): Map<string, string> {
  const dir = join(ROOT, 'packages/db/migrations');
  const file = readdirSync(dir).find((f) => /^\d+_t402_.*\.sql$/.test(f));
  expect(file, 'the t402 storage migration exists').toBeDefined();
  const sql = readFileSync(join(dir, file!), 'utf8');
  const start = sql.indexOf('INSERT INTO t402_labels');
  expect(start, 'migration has its VALUES list').toBeGreaterThan(-1);
  const block = sql.slice(start, sql.indexOf(';', start));
  const out = new Map<string, string>();
  for (const m of block.matchAll(/\(\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*'([^']+)'\s*\)/g)) out.set(m[1]!, `${m[2]}/${m[3]}`);
  return out;
}

describe('T-402 S1a - every audit action the code writes is labelled, in both places', () => {
  const { actions, dynamic } = writtenActions();

  it('the scan is not vacuous: it finds the 22 known actions, the menu_* actions and dual_run.compare', () => {
    expect(actions.size).toBeGreaterThanOrEqual(22 + 23);
    expect(actions.has('dual_run.compare')).toBe(true);
    expect(actions.has('menu_item_create')).toBe(true);
    expect(actions.has('master_data_load')).toBe(true);
    expect(actions.has('retire_item'), 'ternary action in items/index.ts').toBe(true);
    expect(actions.has('restore_item')).toBe(true);
  });

  it('no writer passes an action the scan cannot read', () => {
    expect(dynamic).toEqual([]);
  });

  it('every written action is in LEGACY_LABELS (repo/audit-log.ts) - else append throws UNKNOWN_AUDIT_ACTION in production', () => {
    const legacy = legacyLabelKeys();
    const missing = [...actions.keys()].filter((a) => !legacy.has(a)).sort();
    expect(missing, `written but unlabelled in LEGACY_LABELS: ${missing.join(', ')}`).toEqual([]);
  });

  it('every written action is in migration 0197\'s VALUES list - else the migration RAISEs on production rows', () => {
    const mig = migrationLabels();
    const missing = [...actions.keys()].filter((a) => !mig.has(a)).sort();
    expect(missing, `written but not in the migration list: ${missing.join(', ')}`).toEqual([]);
  });

  it('LEGACY_LABELS and the migration list are the SAME set with the SAME labels (a row written today is labelled like a copied one)', () => {
    const legacy = legacyLabelKeys();
    const mig = migrationLabels();
    expect([...legacy.keys()].sort()).toEqual([...mig.keys()].sort());
    expect(Object.fromEntries(legacy)).toEqual(Object.fromEntries(mig));
  });

  it('no label is listed for an action nothing writes (a stale label hides a rename)', () => {
    const stale = [...legacyLabelKeys().keys()].filter((a) => !actions.has(a)).sort();
    expect(stale).toEqual([]);
  });

  it('set_staff_code is security/high (it changes a credential) in both lists; reopen_pin_sign_in stays security/high', () => {
    for (const [name, m] of [['LEGACY_LABELS', legacyLabelKeys()], ['migration', migrationLabels()]] as const) {
      expect({ list: name, staff: m.get('set_staff_code') }).toEqual({ list: name, staff: 'security/high' });
      expect({ list: name, reopen: m.get('reopen_pin_sign_in') }).toEqual({ list: name, reopen: 'security/high' });
    }
  });
});

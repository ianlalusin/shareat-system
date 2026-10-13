import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUDIT_CATALOGUE, catalogueEntry } from '../../packages/db/src/audit/catalogue';

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
    expect(actions.has('master_data.items_load'), 'master_data_load was split by the T-402 ruling').toBe(true);
    expect(actions.has('retire_item'), 'ternary action in items/index.ts').toBe(true);
    expect(actions.has('restore_item')).toBe(true);
  });

  it('no writer passes an action the scan cannot read', () => {
    expect(dynamic).toEqual([]);
  });

  it('every action the code writes resolves to a NON-reserved catalogue entry - else append throws UNKNOWN_AUDIT_ACTION / AUDIT_ACTION_RESERVED in production', () => {
    const bad = [...actions.keys()].filter((a) => !catalogueEntry(a) || catalogueEntry(a)!.reserved).sort();
    expect(bad, `written but not live in the catalogue: ${bad.join(', ')}`).toEqual([]);
  });

  it('every action in migration 0197 list is catalogued (a legacy one may be reserved), with the SAME category/sensitivity (a copied row is labelled like a written one)', () => {
    const mig = migrationLabels();
    const missing = [...mig.keys()].filter((a) => !catalogueEntry(a)).sort();
    expect(missing, `in the migration but not catalogued: ${missing.join(', ')}`).toEqual([]);
    const diff = [...mig].filter(([a, l]) => `${catalogueEntry(a)!.category}/${catalogueEntry(a)!.sensitivity}` !== l).map(([a]) => a);
    expect(diff, 'labels differ between 0197 and the catalogue').toEqual([]);
  });

  it('no live (non-reserved) catalogue entry is unwritten - a stale entry hides a rename', () => {
    const stale = AUDIT_CATALOGUE.filter((e) => !e.reserved && !actions.has(e.action)).map((e) => e.action).sort();
    expect(stale).toEqual([]);
  });

  it('set_staff_code is security/high (it changes a credential) in both lists; reopen_pin_sign_in stays security/high', () => {
    for (const [name, m] of [['catalogue', new Map(AUDIT_CATALOGUE.map((e) => [e.action, `${e.category}/${e.sensitivity}`]))], ['migration', migrationLabels()]] as const) {
      expect({ list: name, staff: m.get('set_staff_code') }).toEqual({ list: name, staff: 'security/high' });
      expect({ list: name, reopen: m.get('reopen_pin_sign_in') }).toEqual({ list: name, reopen: 'security/high' });
    }
  });
});

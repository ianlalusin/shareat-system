/**
 * T-398 S2a - the DEF-421 ratchet (B2). `docs/tasks/398-padre-garcia-franchise-org.md` R4, S2a, B2.
 *
 * Spec, S2a: "T1 ceiling: 206 occurrences of the literal `Tx | null` across 55 files under
 * packages/domain/src; T2 ceiling: 188 occurrences of `\btransaction\(` across 60 files ... The test
 * fails if any count rises above its pin, and also fails (stale pin) if a count falls without the pin
 * being lowered in the same commit, so the number only ever goes down."
 *
 * Final form (S2b replaces these ceilings), R4 / B2: "Allowed to keep `Tx | null`. In
 * packages/domain/src: only `runDepreciation`" (A9 - NOT the six-function list the earlier T1 text
 * carried; B2 aligned T1 to A9). No `transaction(` call remains in packages/domain/src. The auth door
 * (sessions.ts and the two PIN verifiers) is outside the scan root. Mutant for S2b: add a SECOND name.
 *
 * Measured on branch lane/t398 HEAD cd25f9b (2026-10-17), identical to main c6b16cf:
 *   `Tx | null` 206 in 55 files; `\btransaction\(` 188 in 60 files; 38 import lines naming `transaction`.
 *
 * Pure `fs` traversal (Windows, no shelled grep). Scans packages/domain/src only, so the .claude/ tree
 * and nested worktrees (DEF-669) are never reached. Skips node_modules, `tests` dirs and *.test.ts.
 * Mutant: add one `Tx | null` to any domain file -> T1 reds; add one `transaction(` -> T2 reds.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const DOMAIN_SRC = resolve(here, '..', '..', 'packages', 'domain', 'src');
const LOOSE = '*'; // .ts files directly at packages/domain/src

/** Per-directory `Tx | null` counts at cd25f9b. LOWER on reduction; never raise. */
const TX_NULL: Record<string, number> = {
  ap: 12, ar: 8, budgets: 2, 'cash-requests': 5, 'channel-settlements': 6, commissary: 16,
  customers: 5, cutover: 7, 'dual-run': 1, expenses: 7, files: 2, findings: 1, 'fixed-assets': 7,
  items: 18, leave: 21, ledger: 2, liabilities: 5, loans: 4, 'money-accounts': 3,
  'money-transfers': 3, owners: 9, payroll: 19, prepaid: 6, 'recurring-expenses': 4, remittance: 3,
  'sales-days': 8, 'service-charge': 1, 'statutory-discounts': 4, till: 4, trade: 9, wastage: 4,
};
/** Per-directory `\btransaction\(` counts at cd25f9b. LOWER on reduction; never raise. */
const TRANSACTION_CALLS: Record<string, number> = {
  ap: 13, ar: 8, budgets: 2, 'cash-requests': 5, 'channel-settlements': 6, commissary: 17,
  customers: 5, cutover: 7, expenses: 10, files: 2, findings: 1, 'fixed-assets': 3, items: 18,
  leave: 2, ledger: 2, liabilities: 5, loans: 4, menu: 1, 'money-accounts': 3,
  'money-transfers': 3, organizations: 2, owners: 9, payroll: 9, pos: 1, prepaid: 6,
  'recurring-expenses': 4, remittance: 3, reports: 1, 'sales-days': 8, 'service-charge': 1,
  'statutory-discounts': 4, stock: 1, sync: 4, till: 4, trade: 10, wastage: 4,
};
const TX_NULL_TOTAL = 206;
const TRANSACTION_TOTAL = 188;

function collect(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'tests') continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) collect(full, out);
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

function measure(re: RegExp): Record<string, number> {
  const by: Record<string, number> = {};
  for (const f of collect(DOMAIN_SRC)) {
    const n = (readFileSync(f, 'utf8').match(re) ?? []).length;
    if (!n) continue;
    const parts = relative(DOMAIN_SRC, f).split(sep);
    const key = parts.length > 1 ? (parts[0] as string) : LOOSE;
    by[key] = (by[key] ?? 0) + n;
  }
  return by;
}

function check(label: string, actual: Record<string, number>, pins: Record<string, number>, total: number) {
  const problems: string[] = [];
  for (const k of new Set([...Object.keys(actual), ...Object.keys(pins)])) {
    const a = actual[k] ?? 0;
    const p = pins[k] ?? 0;
    if (a > p) problems.push(`${k}: ${a} > pinned ${p} (rose; DEF-421 may only fall - remove the new ${label})`);
    if (a < p) problems.push(`${k}: ${a} < pinned ${p} (stale pin - lower the ceiling to ${a} in this commit)`);
  }
  const sum = Object.values(actual).reduce((x, y) => x + y, 0);
  if (sum > total) problems.push(`TOTAL ${sum} > ${total}`);
  if (sum < total) problems.push(`TOTAL ${sum} < ${total}: lower the total ceiling to ${sum}`);
  expect(problems, `${label} ratchet (T-398 S2a):\n${problems.join('\n')}`).toEqual([]);
}

describe('T-398 S2a: DEF-421 ratchet over packages/domain/src', () => {
  it('T1: `Tx | null` never rises above the pin (final form: runDepreciation only)', () => {
    check('`Tx | null`', measure(/Tx \| null/g), TX_NULL, TX_NULL_TOTAL);
  });
  it('T2: `transaction(` calls never rise above the pin (final form: zero)', () => {
    check('`transaction(` call', measure(/\btransaction\(/g), TRANSACTION_CALLS, TRANSACTION_TOTAL);
  });
});

/**
 * T-398 S5 audit finding 6 (TESTER) -- migration 0218 must not scan live tables under ACCESS EXCLUSIVE.
 * Static, reads the SQL file only. Every ADD CONSTRAINT that 0218 puts on a table that ALREADY EXISTS (deliveries,
 * trade_discrepancies, suppliers, customers, scheduler_runs) must be ADD ... NOT VALID followed, later in the file, by
 * VALIDATE CONSTRAINT of the same name on the same table (the scan then runs under a weaker lock). DROP CONSTRAINT must be
 * plain (the names are certain: they exist in 0066 / 0071 / 0179 / 0209 / 0216), so drift fails loudly. docs/ops/README.md
 * gains a 0218 row.
 * MUTANTS: one ADD CONSTRAINT without NOT VALID -> A1; NOT VALID with no VALIDATE -> A2; DROP CONSTRAINT IF EXISTS -> A3;
 * no README row -> A4.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATIONS = join(__dirname, '..', 'migrations');
const file = readdirSync(MIGRATIONS).find((f) => /^0218_.*\.sql$/.test(f));
const sqlText = file ? readFileSync(join(MIGRATIONS, file), 'utf8') : '';
const statements = sqlText
  .split('--> statement-breakpoint')
  .map((s) =>
    s
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n')
      .trim()
      .replace(/;\s*$/, ''),
  )
  .filter((s) => s.length > 0);

const created = new Set(statements.map((s) => /^CREATE TABLE "(\w+)"/.exec(s)?.[1]).filter((x): x is string => !!x));
const adds = statements
  .map((s, i) => ({ s, i, m: /^ALTER TABLE "(\w+)" ADD CONSTRAINT "(\w+)"/.exec(s) }))
  .filter((x) => x.m && !created.has(x.m[1]!))
  .map((x) => ({ i: x.i, s: x.s, table: x.m![1]!, name: x.m![2]! }));

describe('0218 migration shape (audit finding 6)', () => {
  it('the 0218 file exists and adds constraints to the five live tables', () => {
    expect(file, 'migration 0218 file').toBeDefined();
    const tables = new Set(adds.map((a) => a.table));
    for (const t of ['deliveries', 'trade_discrepancies', 'suppliers', 'customers', 'scheduler_runs']) {
      expect(tables.has(t), `0218 should add a constraint to ${t}`).toBe(true);
    }
    expect(adds.length, 'ADD CONSTRAINT statements on existing tables').toBeGreaterThanOrEqual(6);
  });

  it('A1 every ADD CONSTRAINT on an existing table ends with NOT VALID (kills: a plain ADD that scans the live table under ACCESS EXCLUSIVE)', () => {
    const plain = adds.filter((a) => !/\bNOT VALID\s*$/i.test(a.s)).map((a) => `${a.table}.${a.name}`);
    expect(plain, 'these ADD CONSTRAINTs are not NOT VALID').toEqual([]);
  });

  it('A2 each of them is followed LATER by VALIDATE CONSTRAINT of the same name on the same table (kills: NOT VALID left unvalidated)', () => {
    // T-398 S5 (orchestrator ruling 26 Oct): this one restated constraint stays NOT VALID on purpose - legacy production
    // rows would fail validation (same as 0046/0217). Exempt by exact table.name only.
    const NOT_VALID_ON_PURPOSE = new Set(['supplier_invoices.supplier_invoices_two_person_verification_check']);
    const missing = adds
      .filter((a) => !NOT_VALID_ON_PURPOSE.has(`${a.table}.${a.name}`))
      .filter(
        (a) =>
          !statements.some(
            (s, j) => j > a.i && new RegExp(`^ALTER TABLE "${a.table}" VALIDATE CONSTRAINT "${a.name}"$`, 'i').test(s),
          ),
      )
      .map((a) => `${a.table}.${a.name}`);
    expect(missing, 'no later VALIDATE CONSTRAINT for').toEqual([]);
  });

  it('A3 DROP CONSTRAINT is plain, never IF EXISTS (the constraint names are certain, drift must fail loudly)', () => {
    const drops = statements.filter((s) => /DROP CONSTRAINT/i.test(s));
    expect(drops.length, 'control: 0218 does drop constraints it replaces').toBeGreaterThan(0);
    expect(drops.filter((s) => /IF EXISTS/i.test(s)), 'DROP CONSTRAINT IF EXISTS found').toEqual([]);
  });

  it('A4 docs/ops/README.md carries a 0218 row', () => {
    const readme = readFileSync(join(__dirname, '..', '..', '..', 'docs', 'ops', 'README.md'), 'utf8');
    expect(readme, 'docs/ops/README.md has no 0218 row').toMatch(/\|\s*0218\b/);
  });
});

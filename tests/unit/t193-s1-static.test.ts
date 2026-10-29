/**
 * T-193 S1 (TESTER) - migration 0222 as a FILE, the schema mirror, the registries, the 6810 seed and the GLOSSARY row.
 * docs/tasks/193-statutory-remittance/REFRESH.md s3 + s5 (S1). No database needed: it fails on a laptop the moment a piece is missing.
 *
 * RED TODAY: no 0222 journal entry / file, no tables in the schema mirror, no registry / classification / trigger entries,
 * no 6810 in the seed, no GLOSSARY row.
 *
 * MUTANTS: journal `when` off the grid -> J1; file CRLF/BOM/0x08 -> M1; GRANT UPDATE on all columns -> M3; missing btrim CHECK -> M2;
 *   history guard left ENABLE ORIGIN -> M5; no line-freeze trigger -> M5; non-partial unique -> M2; FK on store_id alone or
 *   journal_entry_id without its twin -> M2; seed-only 6810 (old orgs lack it) -> M6; registry / classification entry missing or
 *   wrong class -> R1-R3; STATUTORY_AGENCIES widened -> S1; GLOSSARY row missing -> G1.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';

import * as schema from '../../packages/db/schema';
import * as statutorySchema from '../../packages/db/schema/statutory';
import { STATUTORY_AGENCIES } from '../../packages/db/schema/statutory';
import { RLS_REGISTRY } from '../../packages/db/src/rls/registry';
import { CUTOVER_CLASSIFICATION } from '../../packages/db/src/cutover/classification';
import { TRIGGER_REGISTRY } from '../../packages/db/src/triggers/registry';
import { CHART_OF_ACCOUNTS } from '../../packages/db/seed/chart-of-accounts';

const root = join(import.meta.dirname, '..', '..');
const MIGRATIONS = join(root, 'packages', 'db', 'migrations');
const WHEN_0222 = 1805254307084; // 0221's 1805167907084 + 86 400 000
const TABLES = ['statutory_employers', 'statutory_payments', 'statutory_payment_lines'] as const;

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}
const journal = () => (JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as { entries: JournalEntry[] }).entries;
const entry = () => journal().find((e) => e.tag.startsWith('0222_'));
function text(): string {
  const e = entry();
  expect(e, 'RED today: no journal entry numbered 0222').toBeDefined();
  const f = join(MIGRATIONS, `${e!.tag}.sql`);
  expect(existsSync(f), `${f} missing`).toBe(true);
  return readFileSync(f, 'utf8');
}
const flat = (t: string) => t.replace(/\s+/g, ' ');

describe('J1 - journal entry', () => {
  it('exactly one 0222 entry: idx 222, tag 0222_t193_statutory_payments, version 7, breakpoints true, when = 1805254307084 (the day grid)', () => {
    const all = journal().filter((e) => e.tag.startsWith('0222_'));
    expect(all.length, 'RED today: no 0222 entry').toBe(1);
    expect(all[0]).toMatchObject({ idx: 222, version: '7', breakpoints: true, when: WHEN_0222, tag: '0222_t193_statutory_payments' });
  });

  it('the file list and the journal agree, and the journal stays strictly ordered by when', () => {
    expect(entry(), 'RED today: no 0222 entry').toBeDefined();
    const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).map((f) => f.slice(0, -4)).sort();
    expect(journal().map((e) => e.tag).sort()).toEqual(files);
    const j = journal();
    for (let i = 1; i < j.length; i++) expect(j[i]!.when, `${j[i]!.tag} when`).toBeGreaterThan(j[i - 1]!.when);
  });
});

describe('M1 - the 0222 file (ADR-012 s5)', () => {
  it('LF only, no BOM, no 0x08 byte, ends with a newline, statements separated by --> statement-breakpoint', () => {
    const t = text();
    expect(t.includes('\r'), 'CRLF').toBe(false);
    expect(t.charCodeAt(0), 'BOM').not.toBe(0xfeff);
    expect(t.includes(String.fromCharCode(8)), 'a backspace byte').toBe(false);
    expect(t.endsWith('\n')).toBe(true);
    expect((t.match(/-->\s*statement-breakpoint/g) ?? []).length, 'breakpoints between the many statements').toBeGreaterThan(40);
  });

  it('the header comment names T-193, the WHY (2210) and the journal head when it was written (0219)', () => {
    const header = text().split('\n').filter((l) => l.trim().startsWith('--')).join('\n');
    expect(header).toMatch(/T-193/);
    expect(header).toMatch(/2210/);
    expect(header).toMatch(/0219/);
  });

  it('it is additive: no DROP TABLE / DROP COLUMN; it alters only the three new tables; no float types', () => {
    const t = text();
    expect(t).not.toMatch(/DROP\s+(TABLE|COLUMN)/i);
    const altered = [...t.matchAll(/ALTER TABLE\s+(?:ONLY\s+)?"?([a-z_]+)"?/gi)].map((m) => m[1]!.toLowerCase());
    expect([...new Set(altered)].filter((x) => !(TABLES as readonly string[]).includes(x)), 'a table the plan does not touch').toEqual([]);
    expect(t).not.toMatch(/\b(double precision|float4|float8)\b/i);
  });
});

describe('M2 - the three tables, constraints and indexes are in the file', () => {
  it.each(TABLES)('%s is created, RLS ENABLEd + FORCEd, with one org_isolation policy (USING and WITH CHECK)', (tbl) => {
    const t = flat(text());
    expect(t).toMatch(new RegExp(`CREATE TABLE "${tbl}"`));
    expect(t).toMatch(new RegExp(`ALTER TABLE "${tbl}" ENABLE ROW LEVEL SECURITY`));
    expect(t).toMatch(new RegExp(`ALTER TABLE "${tbl}" FORCE ROW LEVEL SECURITY`));
    expect(t).toMatch(new RegExp(`CREATE POLICY "${tbl}_org_isolation" ON "${tbl}" USING \\("org_id" = app_current_org\\(\\)\\) WITH CHECK \\("org_id" = app_current_org\\(\\)\\)`));
  });

  it('same-org twins exist for every cross-table FK incl. journal_entry_id (0213) - kills a single-column FK and the missing journal twin', () => {
    const t = flat(text());
    for (const [tbl, col, parent] of [
      ['statutory_payments', 'money_account_id', 'money_accounts'],
      ['statutory_payments', 'journal_entry_id', 'journal_entries'],
      ['statutory_payments', 'created_by', 'persons'],
      ['statutory_payments', 'voided_by', 'persons'],
      ['statutory_payment_lines', 'payment_id', 'statutory_payments'],
      ['statutory_payment_lines', 'store_id', 'stores'],
      ['statutory_employers', 'created_by', 'persons'],
      ['statutory_employers', 'updated_by', 'persons'],
    ] as const) {
      expect(t, `${tbl}.${col} same-org FK`).toMatch(
        new RegExp(`CONSTRAINT "${tbl}_${col}_same_org_fk" FOREIGN KEY \\("org_id", "${col}"\\) REFERENCES "public"\\."${parent}"\\("org_id", "id"\\)`),
      );
    }
    expect(t).toMatch(/ADD CONSTRAINT "statutory_payments_org_id_id_unique" UNIQUE \("org_id", "id"\)/);
  });

  it('the posted-reference unique is PARTIAL (WHERE status = posted) and the other uniques are present', () => {
    const t = flat(text());
    expect(t).toMatch(/CREATE UNIQUE INDEX "statutory_payments_posted_reference_unique" ON "statutory_payments" \("org_id", "agency", "reference_no"\) WHERE "status" = 'posted'/);
    expect(t).toMatch(/CREATE UNIQUE INDEX "statutory_payment_lines_payment_store_unique" ON "statutory_payment_lines" \("payment_id", "store_id"\)/);
    expect(t).toMatch(/CREATE UNIQUE INDEX "statutory_employers_org_agency_unique" ON "statutory_employers" \("org_id", "agency"\)/);
  });

  it('the payments id has no default on purpose (it is the form-minted paymentId) and a btrim reference CHECK exists', () => {
    const t = flat(text());
    const payments = t.slice(t.indexOf('CREATE TABLE "statutory_payments"'), t.indexOf('CREATE TABLE "statutory_payment_lines"'));
    expect(payments).toMatch(/"id" uuid PRIMARY KEY NOT NULL/);
    expect(payments).not.toMatch(/"id" uuid PRIMARY KEY DEFAULT/);
    expect(payments).toMatch(/"reference_no" = btrim\("reference_no"\)/);
  });
});

describe('M3 - grants are narrow (ADR-012 s5 4a)', () => {
  it('GRANT SELECT, INSERT only; UPDATE only on the named columns; never a table-level UPDATE or any DELETE', () => {
    const t = flat(text());
    expect(t).toMatch(/GRANT SELECT, INSERT ON "statutory_employers", "statutory_payments", "statutory_payment_lines" TO "shareat_app"/);
    expect(t).toMatch(/GRANT UPDATE \("journal_entry_id", "status", "void_reason", "voided_by", "voided_at"\) ON "statutory_payments" TO "shareat_app"/);
    expect(t).toMatch(/GRANT UPDATE \("employer_no", "due_day", "updated_by", "updated_at"\) ON "statutory_employers" TO "shareat_app"/);
    expect(t, 'a table-level UPDATE/ALL grant').not.toMatch(/GRANT (ALL|UPDATE)\s+ON/i);
    expect(t).not.toMatch(/GRANT[^;]*\bDELETE\b/i);
  });
});

describe('M5 - the two triggers', () => {
  it('history guard: BEFORE UPDATE OR DELETE on statutory_payments, ENABLE ALWAYS, check_violation under its own constraint name, EXECUTE revoked from PUBLIC', () => {
    const t = flat(text());
    expect(t).toMatch(/CREATE TRIGGER "statutory_payments_history_guard" BEFORE UPDATE OR DELETE ON "statutory_payments"/);
    expect(t).toMatch(/ALTER TABLE "statutory_payments" ENABLE ALWAYS TRIGGER "statutory_payments_history_guard"/);
    expect(t).toMatch(/CONSTRAINT = 'statutory_payments_history_guard'/);
    expect(t).toMatch(/REVOKE EXECUTE ON FUNCTION "statutory_payments_guard_history"\(\) FROM PUBLIC/);
  });

  it('line freeze: BEFORE INSERT on statutory_payment_lines, left ENABLE ORIGIN (a validator), constraint statutory_payment_lines_parent_open', () => {
    const t = flat(text());
    expect(t).toMatch(/CREATE TRIGGER "statutory_payment_lines_parent_open_trg" BEFORE INSERT ON "statutory_payment_lines"/);
    expect(t).not.toMatch(/ENABLE ALWAYS TRIGGER "statutory_payment_lines_parent_open_trg"/);
    expect(t).toMatch(/CONSTRAINT = 'statutory_payment_lines_parent_open'/);
    expect(t).toMatch(/REVOKE EXECUTE ON FUNCTION "statutory_payment_lines_check_parent_open"\(\) FROM PUBLIC/);
  });
});

describe('M6 - account 6810 reaches EXISTING orgs through the migration, not only through the seed file', () => {
  it('the migration INSERTs 6810 for every org that has a 6000 header and no 6810 yet (so a re-run adds nothing)', () => {
    const t = flat(text());
    expect(t).toMatch(/INSERT INTO "accounts"/);
    expect(t).toMatch(/'6810', 'Penalties and surcharges', 'expense', 'debit'/);
    expect(t).toMatch(/h\.code = '6000'/);
    expect(t).toMatch(/NOT EXISTS/);
  });

  it('the seed file carries 6810 as a postable expense leaf under 6000, between 6800 and 6850, exactly once', () => {
    const a = CHART_OF_ACCOUNTS.find((x) => x.code === '6810');
    expect(a, 'RED today: 6810 is not in CHART_OF_ACCOUNTS').toBeDefined();
    expect(a).toMatchObject({ name: 'Penalties and surcharges', type: 'expense', normalBalance: 'debit', parentCode: '6000', isPostable: true });
    const codes = CHART_OF_ACCOUNTS.map((x) => x.code);
    expect(codes.indexOf('6810')).toBeGreaterThan(codes.indexOf('6800'));
    expect(codes.indexOf('6810')).toBeLessThan(codes.indexOf('6850'));
    expect(codes.filter((c) => c === '6810')).toHaveLength(1);
  });
});

describe('S1 - the schema mirror', () => {
  const tableNames = () => Object.values(schema).filter((v) => is(v, PgTable)).map((v) => getTableName(v as PgTable));

  it('the three tables are exported from the schema barrel', () => {
    const names = tableNames();
    for (const t of TABLES) expect(names, `RED today: ${t} is not in the schema`).toContain(t);
  });

  it('STATUTORY_PAYMENT_AGENCIES = sss, philhealth, pagibig, bir beside an UNCHANGED STATUTORY_AGENCIES (no bir)', () => {
    expect([...STATUTORY_AGENCIES]).toEqual(['sss', 'philhealth', 'pagibig']);
    expect((statutorySchema as Record<string, unknown>).STATUTORY_PAYMENT_AGENCIES, 'RED today: not exported').toEqual(['sss', 'philhealth', 'pagibig', 'bir']);
  });

  it('no statutory table is named with the word "remittance" (the cashier handover owns it)', () => {
    expect(tableNames().filter((n) => /statutory/.test(n) && /remit/i.test(n))).toEqual([]);
  });
});

describe('R1-R3 - registries', () => {
  it('R1 RLS registry: all three are org_column', () => {
    for (const t of TABLES) expect((RLS_REGISTRY as Record<string, unknown>)[t], `RED today: ${t} not in RLS_REGISTRY`).toMatchObject({ scope: 'org_column' });
  });

  it('R2 cutover classification: payments and lines are purge, employers are keep, each with a reason', () => {
    const c = CUTOVER_CLASSIFICATION as Record<string, { class: string; reason: string } | undefined>;
    expect(c.statutory_payments, 'RED today').toMatchObject({ class: 'purge' });
    expect(c.statutory_payment_lines, 'RED today').toMatchObject({ class: 'purge' });
    expect(c.statutory_employers, 'RED today').toMatchObject({ class: 'keep' });
    for (const t of TABLES) expect(c[t]?.reason?.trim().length ?? 0, `${t} reason`).toBeGreaterThanOrEqual(10);
  });

  it('R3 trigger registry: the guard is always/history_guard, the line freeze is origin/validator, each on its own table', () => {
    const r = TRIGGER_REGISTRY as Record<string, unknown>;
    expect(r.statutory_payments_history_guard, 'RED today').toMatchObject({ table: 'statutory_payments', mode: 'always', kind: 'history_guard' });
    expect(r.statutory_payment_lines_parent_open_trg, 'RED today').toMatchObject({ table: 'statutory_payment_lines', mode: 'origin', kind: 'validator' });
  });
});

describe('G1 - GLOSSARY.md', () => {
  it('has a "statutory payment" row that says it is NOT a remittance, naming statutory_payments and 2210', () => {
    const g = readFileSync(join(root, 'docs', 'GLOSSARY.md'), 'utf8');
    const row = g.split('\n').find((l) => /^\|\s*\*\*statutory payment/i.test(l));
    expect(row, 'RED today: no "statutory payment" row').toBeDefined();
    expect(row).toMatch(/remittance/i);
    expect(row).toMatch(/statutory_payments/);
    expect(row).toMatch(/2210/);
  });
});

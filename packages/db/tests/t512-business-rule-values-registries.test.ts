import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
// Pure modules (no connection): these run in the unit project, before any migration.
import { TRIGGER_REGISTRY } from '../src/triggers/registry';
import { RLS_REGISTRY } from '../src/rls/registry';
import { CUTOVER_CLASSIFICATION } from '../src/cutover/classification';
import { AUDIT_CATALOGUE, catalogueEntry } from '../src/audit/catalogue';
import * as schema from '../schema/index';

/**
 * T-512 (T-511 S5c) TESTER - the new table `business_rule_values` is declared everywhere the build requires, and its audit action exists.
 * docs/tasks/512-business-rules-s5c-spec.md "Table" (registry entries, schema NOTE) and "Capability, audit, screen" (audit catalogue +1).
 *
 * RED today: no table in the schema, no registry entry, no catalogue entry, no migration file.
 *
 * ASSUMPTIONS beyond the agreed list (builders must follow them):
 *   - the schema export is `businessRuleValues` from packages/db/schema/business-rules.ts, re-exported by schema/index.ts, SQL table name `business_rule_values`;
 *   - the audit entity is `business_rule_values`; owner is not pinned (T-511 or T-512, whichever the builder uses);
 *   - the catalogue entry is `business_rule.changed`: category settings, sensitivity high, scope org, person actor, live (not reserved), server-only.
 * EXPECTED CEILING MOVES (builders re-measure, dated comment, measured number only): t402-s1b-catalogue and t453-item-audit-catalogue (+1 entry),
 * the trigger-registry / classification / RLS-registry counts if any guard pins them, and the schema table/column census if one exists.
 */
const ROOT = join(__dirname, '..', '..', '..');

describe('T-512 - the table is declared in the schema', () => {
  it('schema/index exports businessRuleValues with exactly the spec columns (id, org_id, key, value, effective_from, set_by, reason, created_at)', () => {
    const t = (schema as Record<string, unknown>)['businessRuleValues'];
    expect(t, 'businessRuleValues is not exported from packages/db/schema').toBeDefined();
    const cfg = getTableConfig(t as Parameters<typeof getTableConfig>[0]);
    expect(cfg.name).toBe('business_rule_values');
    expect(cfg.columns.map((c) => c.name).sort()).toEqual(['created_at', 'effective_from', 'id', 'key', 'org_id', 'reason', 'set_by', 'value']);
    const col = (n: string) => cfg.columns.find((c) => c.name === n)!;
    expect(col('value').columnType, 'value is numeric(18,6)').toMatch(/Numeric/i);
    expect(col('effective_from').columnType).toMatch(/Date/i);
    expect(col('org_id').notNull).toBe(true);
    expect(col('key').notNull).toBe(true);
    expect(col('value').notNull).toBe(true);
    expect(col('effective_from').notNull).toBe(true);
    expect(col('reason').notNull).toBe(true);
    expect(col('set_by').notNull, 'set_by is null only for the seed, so the column is nullable').toBe(false);
  });

  it('the schema file says what the migration hand-adds: a NOTE naming migration 0239 [kills: a trigger or grant the schema never mentions]', () => {
    const text = readFileSync(join(ROOT, 'packages/db/schema/business-rules.ts'), 'utf8');
    expect(text).toMatch(/NOTE:[\s\S]*hand-added in migration 0239/);
  });
});

describe('T-512 - the table is classified in the three registries the build enforces', () => {
  it('trigger registry: an append-only history_guard in mode always on business_rule_values (the ENABLE ALWAYS trigger the migration creates)', () => {
    const entries = Object.entries(TRIGGER_REGISTRY).filter(([, e]) => e.table === 'business_rule_values');
    expect(entries.length, 'no trigger registered for business_rule_values').toBeGreaterThanOrEqual(1);
    for (const [name, e] of entries) {
      expect(e.kind, name).toBe('history_guard');
      expect(e.mode, name).toBe('always');
      expect(e.reason.length, name).toBeGreaterThan(20);
    }
  });

  it('RLS registry: org_column scope with a reason', () => {
    const e = RLS_REGISTRY['business_rule_values'];
    expect(e, 'business_rule_values is not in RLS_REGISTRY').toBeDefined();
    expect(e!.scope).toBe('org_column');
    expect(e!.reason.length).toBeGreaterThan(20);
  });

  it('cutover classification: keep (a rule in force at cutover is still in force in January), with a reason', () => {
    const e = CUTOVER_CLASSIFICATION['business_rule_values'];
    expect(e, 'business_rule_values is not in CUTOVER_CLASSIFICATION').toBeDefined();
    expect(e!.class).toBe('keep');
    expect(e!.reason.length).toBeGreaterThan(20);
  });
});

describe('T-512 - the audit action business_rule.changed', () => {
  it('is catalogued: dotted, settings, high, org scope, person actor, live, server-only, retention ten years', () => {
    const e = catalogueEntry('business_rule.changed');
    expect(e, 'business_rule.changed missing from AUDIT_CATALOGUE').toBeDefined();
    expect(e!.category).toBe('settings');
    expect(e!.sensitivity).toBe('high');
    expect(e!.retention).toBe('r10y');
    expect(e!.scope, 'a rule belongs to the organisation: no store id').toBe('org');
    expect(e!.entity).toBe('business_rule_values');
    expect(e!.actor).toBe('person');
    expect(e!.reserved).toBe(false);
    expect(e!.clientSources).toEqual([]);
    expect(AUDIT_CATALOGUE.filter((x) => x.action === 'business_rule.changed')).toHaveLength(1);
  });

  it('the writer sits in the domain, one line starting `action: \'business_rule.changed\'`, in a file that calls auditLogRepo.append( and authorize( first (the shape the coverage scan reads)', () => {
    const dir = join(ROOT, 'packages/domain/src/business-rules');
    const files = readdirSync(dir).filter((n) => n.endsWith('.ts'));
    const hits = files.filter((n) => /^\s*action:\s*'business_rule\.changed'/m.test(readFileSync(join(dir, n), 'utf8')));
    expect(hits.length, 'no domain file under business-rules/ writes action: \'business_rule.changed\' on its own line').toBe(1);
    const text = readFileSync(join(dir, hits[0]!), 'utf8');
    expect(text).toMatch(/auditLogRepo\.append\(/);
    const at = text.search(/^\s*action:\s*'business_rule\.changed'/m);
    expect(text.slice(0, at).lastIndexOf('authorize(') , 'authorize( must come before the audit write').toBeGreaterThan(-1);
  });
});

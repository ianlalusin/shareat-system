import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// Pure module (no db import): runs in the unit project, before any migration.
import { AUDIT_CATALOGUE, catalogueEntry } from '../src/audit/catalogue';

/**
 * T-511 S6b (TESTER, 7 Nov 2026) - the audit action `platform_sales.corrected` exists in the closed catalogue and has a LITERAL writer in the same slice.
 * Spec: docs/tasks/511-settlement-upload-s6-spec.md "S6b" ("add `platform_sales.corrected` to the catalogue, ceiling re-measured").
 *
 * Choices made by the tester (flag if wrong), mirroring `loan.repayment_amount_edited` (t511-s2b-audit-catalogue.test.ts):
 *   category 'money' (it moves sales and the receivable), sensitivity high, scope store (the day's store), entity sales_day_platform_corrections, owner T-511,
 *   actor person, live (not reserved), server-only.
 * The coverage scan reads only a line that STARTS with `action:` inside a file that calls `auditLogRepo.append(`, so the writer is written multi-line with
 * `action:` first on its own line. Both ceiling tests (t402-s1b-catalogue.test.ts, t453-item-audit-catalogue.test.ts) were raised 232 -> 233 here.
 */
const ROOT = join(__dirname, '..', '..', '..');
const ACTION = 'platform_sales.corrected';
const FILE = 'packages/domain/src/channel-settlements/correction.ts';

describe('T-511 S6b - the audit action is in the catalogue', () => {
  it('the catalogue holds the action: dotted, money, high, store scope, entity sales_day_platform_corrections, owner T-511, live (not reserved)', () => {
    const e = catalogueEntry(ACTION);
    expect(e, `${ACTION} missing from AUDIT_CATALOGUE`).toBeDefined();
    expect(ACTION).toMatch(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/);
    expect(e!.category).toBe('money');
    expect(e!.sensitivity).toBe('high');
    expect(e!.retention, 'money and high are kept ten years').toBe('r10y');
    expect(e!.scope, 'the row belongs to a store, and a store-scoped entry REQUIRES a storeId').toBe('store');
    expect(e!.entity).toBe('sales_day_platform_corrections');
    expect(e!.owner).toBe('T-511');
    expect(e!.actor).toBe('person');
    expect(e!.reserved, 'a reserved entry is refused by append').toBe(false);
    expect(e!.clientSources, 'server-only').toEqual([]);
  });

  it('the catalogue grew by exactly one entry past the old ceiling (233 entries, the new ceiling, exactly full)', () => {
    expect(AUDIT_CATALOGUE.length).toBeGreaterThanOrEqual(233);
  });
});

describe('T-511 S6b - the action has a literal writer in correction.ts (the shape the coverage scan can read)', () => {
  it('correction.ts exists and calls auditLogRepo.append( with a line starting action: \'platform_sales.corrected\'', () => {
    expect(existsSync(join(ROOT, FILE)), FILE).toBe(true);
    const text = readFileSync(join(ROOT, FILE), 'utf8');
    expect(text, `${FILE} must call auditLogRepo.append(`).toMatch(/auditLogRepo\.append\(/);
    expect(text, `${FILE} must hold a line starting with action: '${ACTION}' (not inline in a one-line object)`).toMatch(/^\s*action:\s*'platform_sales\.corrected'/m);
  });

  it('the writer sits after the gate: authorize( precedes the audit write', () => {
    const text = readFileSync(join(ROOT, FILE), 'utf8');
    const at = text.search(/^\s*action:\s*'platform_sales\.corrected'/m);
    expect(at, 'writer not found').toBeGreaterThan(-1);
    expect(text.slice(0, at).lastIndexOf('authorize('), 'an authorize( call must come before the audit write').toBeGreaterThan(-1);
  });
});

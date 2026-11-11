import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// Pure module (no db import): runs in the unit project, before any migration.
import { AUDIT_CATALOGUE, catalogueEntry } from '../src/audit/catalogue';

/**
 * T-511 S6c (TESTER, 7 Nov 2026) - the audit action `channel_charge.posted` exists in the closed catalogue and has a LITERAL writer in the same slice.
 * Spec: docs/tasks/511-settlement-upload-s6c-spec.md Design B ("audit `channel_charge.posted` (money, high, store scope, owner T-511)").
 *
 * Choices made by the tester (flag if wrong), mirroring `platform_sales.corrected` (t511-s6b-audit-catalogue.test.ts): entity `channel_period_charges`, actor person, live
 * (not reserved), server-only. The coverage scan reads only a line that STARTS with `action:` inside a file that calls `auditLogRepo.append(`. Both ceiling tests
 * (t402-s1b-catalogue.test.ts, t453-item-audit-catalogue.test.ts) were raised 233 -> 234 here.
 */
const ROOT = join(__dirname, '..', '..', '..');
const ACTION = 'channel_charge.posted';
const FILE = 'packages/domain/src/channel-settlements/charge.ts';

describe('T-511 S6c - the audit action is in the catalogue', () => {
  it('the catalogue holds the action: dotted, money, high, store scope, entity channel_period_charges, owner T-511, live (not reserved)', () => {
    const e = catalogueEntry(ACTION);
    expect(e, `${ACTION} missing from AUDIT_CATALOGUE`).toBeDefined();
    expect(ACTION).toMatch(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/);
    expect(e!.category).toBe('money');
    expect(e!.sensitivity).toBe('high');
    expect(e!.retention, 'money and high are kept ten years').toBe('r10y');
    expect(e!.scope, 'the row belongs to a store, and a store-scoped entry REQUIRES a storeId').toBe('store');
    expect(e!.entity).toBe('channel_period_charges');
    expect(e!.owner).toBe('T-511');
    expect(e!.actor).toBe('person');
    expect(e!.reserved, 'a reserved entry is refused by append').toBe(false);
    expect(e!.clientSources, 'server-only').toEqual([]);
  });

  it('the catalogue grew by exactly one entry past the old ceiling (234 entries, the new ceiling, exactly full)', () => {
    expect(AUDIT_CATALOGUE.length).toBeGreaterThanOrEqual(234);
  });
});

describe('T-511 S6c - the action has a literal writer in charge.ts (the shape the coverage scan can read)', () => {
  it('charge.ts exists and calls auditLogRepo.append( with a line starting action: \'channel_charge.posted\'', () => {
    expect(existsSync(join(ROOT, FILE)), FILE).toBe(true);
    const text = readFileSync(join(ROOT, FILE), 'utf8');
    expect(text, `${FILE} must call auditLogRepo.append(`).toMatch(/auditLogRepo\.append\(/);
    expect(text, `${FILE} must hold a line starting with action: '${ACTION}' (not inline in a one-line object)`).toMatch(/^\s*action:\s*'channel_charge\.posted'/m);
  });

  it('the writer sits after the gate: authorize( precedes the audit write', () => {
    const text = readFileSync(join(ROOT, FILE), 'utf8');
    const at = text.search(/^\s*action:\s*'channel_charge\.posted'/m);
    expect(at, 'writer not found').toBeGreaterThan(-1);
    expect(text.slice(0, at).lastIndexOf('authorize('), 'an authorize( call must come before the audit write').toBeGreaterThan(-1);
  });
});

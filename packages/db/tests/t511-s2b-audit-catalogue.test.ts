import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// Pure module (no db import): runs in the unit project, before any migration.
import { AUDIT_CATALOGUE, catalogueEntry } from '../src/audit/catalogue';

/**
 * T-511 S2b (TESTER) - the two new audit actions exist in the closed catalogue and have a LITERAL writer in the same slice.
 * Spec: docs/tasks/511-settlement-upload-s2-spec.md "Capabilities and audit (2a)" last bullet and "The two admin edits (2b)".
 *
 * Choices made by the tester (flag if wrong):
 *   sales_channel.platform_code_edited  category 'settings' (a channel setting; 'settings' exists), sensitivity high, scope store,
 *                                       entity sales_channels, owner T-511
 *   loan.repayment_amount_edited        category 'money' (a figure the loan check compares deductions against), sensitivity high,
 *                                       scope store, entity loans, owner T-511
 * 'high' because the platform code decides which store a settlement file books to, and the amount decides whether a payout is
 * blocked; both are admin-only edits (retention r10y follows from 'high').
 *
 * HOW THE EXISTING COVERAGE GUARDS READ THEIR RULE (verified in t402-s1a-action-coverage.test.ts and t402-s1b-catalogue.test.ts:314):
 *   - the scan looks only at packages/, apps/ and scripts/ (not tests/, migrations/, node_modules);
 *   - in a file that contains `auditLogRepo.append(`, it takes every line that STARTS with `action:` (a leading-whitespace-only
 *     match: `^\s*action:`), so an inline `{ ..., action: 'x', ... }` on one line is NOT seen and would leave the entry "non-reserved
 *     with no caller" (red) - the object must be written multi-line with `action:` first on its own line;
 *   - the quoted value must be a literal; a variable is flagged "dynamic" (red);
 *   - both directions are enforced together: an entry with no writer is red AND a writer with no entry is red, so the two
 *     catalogue entries and the two writers MUST land in the same commit (they do: both are 2b).
 * The ceiling tests (t402-s1b-catalogue.test.ts:95, t453-item-audit-catalogue.test.ts:23) were raised 218 -> 220 here.
 */
const ROOT = join(__dirname, '..', '..', '..');

const NEW = [
  { action: 'sales_channel.platform_code_edited', category: 'settings', entity: 'sales_channels', file: 'packages/domain/src/sales-channels/index.ts' },
  { action: 'loan.repayment_amount_edited', category: 'money', entity: 'loans', file: 'packages/domain/src/loans/index.ts' },
] as const;

describe('T-511 S2b - the two audit actions are in the catalogue', () => {
  it('the catalogue holds at least 220 entries (218 before this slice, the old ceiling, exactly full)', () => {
    expect(AUDIT_CATALOGUE.length).toBeGreaterThanOrEqual(220);
  });

  it.each(NEW)('$action is catalogued: dotted, $category, high, store scope, entity $entity, owner T-511, live (not reserved)', ({ action, category, entity }) => {
    const e = catalogueEntry(action);
    expect(e, `${action} missing from AUDIT_CATALOGUE`).toBeDefined();
    expect(action).toMatch(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/);
    expect(e!.category).toBe(category);
    expect(e!.sensitivity).toBe('high');
    expect(e!.retention, 'a high-sensitivity record is kept ten years').toBe('r10y');
    expect(e!.scope, 'both rows belong to a store (channel.storeId, loan.storeId); a store-scoped entry REQUIRES a storeId').toBe('store');
    expect(e!.entity).toBe(entity);
    expect(e!.owner).toBe('T-511');
    expect(e!.actor).toBe('person');
    expect(e!.reserved, 'a reserved entry is refused by append (AUDIT_ACTION_RESERVED)').toBe(false);
    expect(e!.clientSources, 'server-only').toEqual([]);
  });
});

describe('T-511 S2b - each action has a literal writer in its domain file (the shape the coverage scan can read)', () => {
  it.each(NEW)('$file writes action: \'$action\' on its own line, in a file that calls auditLogRepo.append(', ({ action, file }) => {
    const text = readFileSync(join(ROOT, file), 'utf8');
    expect(text, `${file} must call auditLogRepo.append(`).toMatch(/auditLogRepo\.append\(/);
    const own = new RegExp(`^\\s*action:\\s*'${action.replace(/\./g, '\\.')}'`, 'm');
    expect(text, `${file} must hold a line starting with action: '${action}' (not inline in a one-line object)`).toMatch(own);
  });

  it('the writer sits after the gate and the write: authorize( precedes auditLogRepo.append( in each file\'s new function', () => {
    for (const { file, action } of NEW) {
      const text = readFileSync(join(ROOT, file), 'utf8');
      const at = text.search(new RegExp(`^\\s*action:\\s*'${action.replace(/\./g, '\\.')}'`, 'm'));
      expect(at, `${file} writer not found`).toBeGreaterThan(-1);
      const before = text.slice(0, at);
      expect(before.lastIndexOf('authorize('), `${file}: an authorize( call must come before the audit write`).toBeGreaterThan(-1);
    }
  });
});

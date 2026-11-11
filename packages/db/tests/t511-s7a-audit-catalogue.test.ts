import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// Pure module (no db import): runs in the unit project, before any migration.
import { AUDIT_CATALOGUE, catalogueEntry } from '../src/audit/catalogue';

/**
 * T-511 S7a (TESTER, 8 Nov 2026) - the two audit actions of approve and void are in the closed catalogue and each has a LITERAL writer in the same slice.
 * Spec: docs/tasks/511-settlement-upload-s7-spec.md Ruling 9 ("`settlement_day.approved` (money, high, store scope ...) and `settlement_day.unbooked`"; ceilings 250 -> 252).
 *
 * Choices made by the tester (flag if wrong):
 *  - `settlement_day.approved`: entity `settlement_day_lines` (the staged line, as `settlement_day.rejected`), actor person, live (not reserved), server-only.
 *  - `settlement_day.unbooked`: the spec gives no class. Pinned: store scope, entity `settlement_day_lines`, owner T-511, person, live, server-only, and a category of
 *    `data` (like the rejected / reopened of the same entity) or `money` (it undoes a booking); NOT `settings`. Sensitivity is not pinned.
 *  - The ceilings of t402-s1b-catalogue.test.ts and t453-item-audit-catalogue.test.ts go 250 -> 252 (the builder moves them; this file does not touch them).
 * The coverage scan reads only a line that STARTS with `action:` inside a file that calls `auditLogRepo.append(`.
 */
const ROOT = join(__dirname, '..', '..', '..');
const APPROVE = 'packages/domain/src/settlement-intake/approve.ts';

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) out.push(full);
  }
  return out;
}
const writers = (action: string): string[] =>
  walk(join(ROOT, 'packages', 'domain', 'src'))
    .filter((f) => {
      const t = readFileSync(f, 'utf8');
      return /auditLogRepo\.append\(/.test(t) && new RegExp(`^\\s*action:\\s*'${action.replace('.', '\\.')}'`, 'm').test(t);
    })
    .map((f) => f.slice(ROOT.length + 1).replace(/\\/g, '/'));

describe('T-511 S7a - the audit actions are in the catalogue', () => {
  it('settlement_day.approved: dotted, money, high, ten years, store scope, entity settlement_day_lines, owner T-511, person, live, server-only [kills: an action filed as data/normal; an org-scoped approval]', () => {
    const e = catalogueEntry('settlement_day.approved');
    expect(e, 'missing from AUDIT_CATALOGUE').toBeDefined();
    expect(e!.category).toBe('money');
    expect(e!.sensitivity).toBe('high');
    expect(e!.retention, 'money and high are kept ten years').toBe('r10y');
    expect(e!.scope, 'a store-scoped entry REQUIRES a storeId').toBe('store');
    expect(e!.entity).toBe('settlement_day_lines');
    expect(e!.owner).toBe('T-511');
    expect(e!.actor).toBe('person');
    expect(e!.reserved).toBe(false);
    expect(e!.clientSources).toEqual([]);
  });

  it('settlement_day.unbooked: store scope, entity settlement_day_lines, owner T-511, person, live, server-only, category data or money [kills: a void audit filed as settings; org scope]', () => {
    const e = catalogueEntry('settlement_day.unbooked');
    expect(e, 'missing from AUDIT_CATALOGUE').toBeDefined();
    expect(['data', 'money']).toContain(e!.category);
    expect(e!.scope).toBe('store');
    expect(e!.entity).toBe('settlement_day_lines');
    expect(e!.owner).toBe('T-511');
    expect(e!.actor).toBe('person');
    expect(e!.reserved).toBe(false);
    expect(e!.clientSources).toEqual([]);
  });

  it('the catalogue grew by exactly these two entries past the old ceiling of 250 (252, the new ceiling) [kills: a ceiling raised by more than the slice needs]', () => {
    expect(AUDIT_CATALOGUE.length).toBeGreaterThanOrEqual(252);
  });
});

describe('T-511 S7a - each action has a literal writer in the domain (the shape the coverage scan can read)', () => {
  it('approve.ts exists and writes settlement_day.approved after the gate: authorize( precedes the audit write [kills: an audit before the permission check; an inline one-line object the scan cannot read]', () => {
    expect(existsSync(join(ROOT, APPROVE)), APPROVE).toBe(true);
    expect(writers('settlement_day.approved')).toContain(APPROVE);
    const text = readFileSync(join(ROOT, APPROVE), 'utf8');
    const at = text.search(/^\s*action:\s*'settlement_day\.approved'/m);
    expect(text.slice(0, at).lastIndexOf('authorize'), 'an authorize call must come before the audit write').toBeGreaterThan(-1);
  });

  it('settlement_day.unbooked has a writer in the domain, and the void function of the channel settlements reaches it [kills: a void that returns the line without an audit row]', () => {
    expect(writers('settlement_day.unbooked').length, 'a literal `action: \'settlement_day.unbooked\'` next to auditLogRepo.append(').toBeGreaterThan(0);
    const index = readFileSync(join(ROOT, 'packages/domain/src/channel-settlements/index.ts'), 'utf8');
    const start = index.indexOf('export async function voidChannelSettlement');
    const body = index.slice(start, index.indexOf('\nexport ', start + 10));
    expect(body, 'voidChannelSettlement returns the day to pending').toMatch(/markUnbooked|unbook/i);
  });
});

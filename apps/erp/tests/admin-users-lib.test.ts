import { describe, expect, it } from 'vitest';
import {
  canRevokeHere,
  grantSourceLabel,
  grantSummaryLine,
  requireRevokeReason,
} from '../src/app/admin/users/lib';

/**
 * T-256 / DEF-247 — the two pure decisions this task adds: how a `grant_source` reads on screen,
 * and what counts as a real revoke reason.
 *
 * T-291 extends this: `'position'` joins the four known sources (§C1), a pure predicate decides
 * whether a row is offered a revoke control here (§C2), and a pure splitter counts inherited vs.
 * granted for the summary line (§C4) — all kept in this file, testable without rendering.
 */
describe('grantSourceLabel — never guesses a NULL source', () => {
  it('names the four known sources distinctly', () => {
    expect(grantSourceLabel('elevation')).toBe(
      'auto-elevated — clears when this org gains an active administrator',
    );
    expect(grantSourceLabel('owner')).toBe('owner-equivalent grant');
    expect(grantSourceLabel('grant')).toBe('hand-granted');
    expect(grantSourceLabel('position')).toBe(
      'via a position default — clears when the position or the default does',
    );
  });

  it('⛔ a NULL source says "not recorded" — never one of the four known labels (DEF-237 residue)', () => {
    const label = grantSourceLabel(null);
    expect(label).toMatch(/not recorded/);
    expect(label).not.toBe(grantSourceLabel('elevation'));
    expect(label).not.toBe(grantSourceLabel('owner'));
    expect(label).not.toBe(grantSourceLabel('grant'));
    expect(label).not.toBe(grantSourceLabel('position'));
  });
});

describe('canRevokeHere — T-291 §C2: a position row offers no revoke control here', () => {
  it('refuses a revoke control on a position-sourced grant', () => {
    expect(canRevokeHere({ grantSource: 'position' })).toBe(false);
  });

  it('offers a revoke control on every other known source, and on an unrecorded one', () => {
    expect(canRevokeHere({ grantSource: 'elevation' })).toBe(true);
    expect(canRevokeHere({ grantSource: 'owner' })).toBe(true);
    expect(canRevokeHere({ grantSource: 'grant' })).toBe(true);
    expect(canRevokeHere({ grantSource: null })).toBe(true);
  });
});

describe('grantSummaryLine — T-291 §C4: counts honestly, split by source', () => {
  it('separates inherited-from-position rows from every other source', () => {
    const grants = [
      { grantSource: 'position' as const },
      { grantSource: 'position' as const },
      { grantSource: 'position' as const },
      { grantSource: 'grant' as const },
    ];
    expect(grantSummaryLine(grants)).toBe('3 inherited from positions · 1 granted');
  });

  it('zero granted, some inherited', () => {
    expect(grantSummaryLine([{ grantSource: 'position' as const }])).toBe(
      '1 inherited from positions · 0 granted',
    );
  });

  it('zero inherited, some granted', () => {
    expect(grantSummaryLine([{ grantSource: 'grant' as const }])).toBe(
      '0 inherited from positions · 1 granted',
    );
  });

  it('both zero — no extra grants at all', () => {
    expect(grantSummaryLine([])).toBe('0 inherited from positions · 0 granted');
  });
});

describe('requireRevokeReason — mirrors unlinkCredential\'s own trim-and-refuse', () => {
  it('refuses an empty string', () => {
    expect(() => requireRevokeReason('')).toThrow(/needs a reason/);
  });

  it('refuses a whitespace-only string', () => {
    expect(() => requireRevokeReason('   ')).toThrow(/needs a reason/);
  });

  it('trims and returns a real reason', () => {
    expect(requireRevokeReason('  because reasons  ')).toBe('because reasons');
  });
});

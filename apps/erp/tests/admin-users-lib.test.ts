import { describe, expect, it } from 'vitest';
import { grantSourceLabel, requireRevokeReason } from '../src/app/admin/users/lib';

/**
 * T-256 / DEF-247 — the two pure decisions this task adds: how a `grant_source` reads on screen,
 * and what counts as a real revoke reason.
 */
describe('grantSourceLabel — never guesses a NULL source', () => {
  it('names the three known sources distinctly', () => {
    expect(grantSourceLabel('elevation')).toBe(
      'auto-elevated — clears when this org gains an active administrator',
    );
    expect(grantSourceLabel('owner')).toBe('owner-equivalent grant');
    expect(grantSourceLabel('grant')).toBe('hand-granted');
  });

  it('⛔ a NULL source says "not recorded" — never one of the three known labels (DEF-237 residue)', () => {
    const label = grantSourceLabel(null);
    expect(label).toMatch(/not recorded/);
    expect(label).not.toBe(grantSourceLabel('elevation'));
    expect(label).not.toBe(grantSourceLabel('owner'));
    expect(label).not.toBe(grantSourceLabel('grant'));
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

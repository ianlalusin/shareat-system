import { describe, expect, it } from 'vitest';
import { claimRowView, validateClaimForm } from '../lobby-view';

/** T-455 S7a - the discount screen's pure helpers: the same bounds as the server, and a claim row that never shows more than the last four. */
describe('validateClaimForm', () => {
  const ok = { kind: 'senior' as const, holderName: ' Ana Reyes ', idNumber: ' 0042-5566-1187 ' };
  it('accepts a typed claim and trims both fields', () => {
    expect(validateClaimForm(ok)).toEqual({ ok: true, value: { kind: 'senior', holderName: 'Ana Reyes', idNumber: '0042-5566-1187' } });
  });
  it('refuses no kind, a blank or 41-character name, and an ID that is too short once spaces and hyphens are ignored or over 40', () => {
    for (const bad of [{ ...ok, kind: '' as const }, { ...ok, holderName: '  ' }, { ...ok, holderName: 'x'.repeat(41) }, { ...ok, idNumber: '1-2 3' }, { ...ok, idNumber: '9'.repeat(41) }]) {
      expect(validateClaimForm(bad).ok, JSON.stringify(bad)).toBe(false);
    }
    expect(validateClaimForm({ ...ok, holderName: 'x'.repeat(40), idNumber: '8'.repeat(40) }).ok).toBe(true);
  });
});

describe('claimRowView', () => {
  const base = { claimId: 'c1', kind: 'pwd' as const, idMasked: '****1187', rejectReason: null, ocrAssisted: false };
  it('shows kind, the masked ID and one sentence per status; only a pending claim can be removed', () => {
    const pending = claimRowView({ ...base, status: 'pending' });
    expect(pending).toMatchObject({ kindLabel: 'PWD', idMasked: '****1187', canCancel: true });
    expect(claimRowView({ ...base, status: 'approved' }).canCancel).toBe(false);
    expect(claimRowView({ ...base, status: 'rejected', rejectReason: 'The card has expired.' }).message).toBe('Not approved: The card has expired.');
    expect(claimRowView({ ...base, status: 'expired' }).canCancel).toBe(false);
  });
});

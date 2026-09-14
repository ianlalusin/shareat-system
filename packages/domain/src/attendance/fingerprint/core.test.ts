import { describe, it, expect } from 'vitest';
import {
  MAX_FINGERS,
  hasFingerprint,
  validateFingerprintTemplates,
  buildReaderEntries,
  resolveFingerprintMatchToken,
} from './core';

// Carried across from v1's fingerprint-core.test.ts (T-314 slice A, 2026-09-14). Only
// `buildFingerprintDbEntries` is renamed, to `buildReaderEntries`, per the slice A contract —
// the assertions and invariants are unchanged.

describe('hasFingerprint', () => {
  it('is false for null/undefined/empty', () => {
    expect(hasFingerprint(null)).toBe(false);
    expect(hasFingerprint(undefined)).toBe(false);
    expect(hasFingerprint([])).toBe(false);
  });
  it('is true when at least one template exists', () => {
    expect(hasFingerprint(['t1'])).toBe(true);
  });
});

describe('validateFingerprintTemplates', () => {
  it('accepts 1 non-empty template', () => {
    const r = validateFingerprintTemplates(['abc']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.templates).toEqual(['abc']);
  });
  it(`accepts up to ${MAX_FINGERS} templates and trims them`, () => {
    const r = validateFingerprintTemplates([' a ', 'b']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.templates).toEqual(['a', 'b']);
  });
  it('rejects empty list', () => {
    expect(validateFingerprintTemplates([]).ok).toBe(false);
  });
  it('rejects more than the max', () => {
    expect(validateFingerprintTemplates(['a', 'b', 'c']).ok).toBe(false);
  });
  it('rejects non-array / blank / non-string entries', () => {
    expect(validateFingerprintTemplates('a' as unknown).ok).toBe(false);
    expect(validateFingerprintTemplates(['  ']).ok).toBe(false);
    expect(validateFingerprintTemplates([123 as unknown as string]).ok).toBe(false);
  });
});

describe('buildReaderEntries', () => {
  it('flattens each token to one entry per template, with a unique per-slot id', () => {
    // The native 1:N matcher (ZKFingerService.save) registers one template per
    // id — a second save() under the SAME id overwrites the first rather than
    // adding a second matchable template. Two fingers must get two distinct
    // ids or the first-enrolled finger silently stops matching.
    const entries = buildReaderEntries([
      { matchToken: 'tokA', templates: ['t1', 't2'] },
      { matchToken: 'tokB', templates: ['t3'] },
    ]);
    expect(entries).toEqual([
      { id: 'tokA#0', template: 't1' },
      { id: 'tokA#1', template: 't2' },
      { id: 'tokB#0', template: 't3' },
    ]);
  });
  it('skips rows with no token or no templates', () => {
    const entries = buildReaderEntries([
      { matchToken: null, templates: ['t1'] },
      { matchToken: 'tokB', templates: [] },
      { matchToken: 'tokC', templates: null },
    ]);
    expect(entries).toEqual([]);
  });
});

describe('resolveFingerprintMatchToken', () => {
  it('strips the per-slot suffix off a matched native-DB id', () => {
    expect(resolveFingerprintMatchToken('tokA#0')).toBe('tokA');
    expect(resolveFingerprintMatchToken('tokA#1')).toBe('tokA');
    expect(resolveFingerprintMatchToken('tokB#0')).toBe('tokB');
  });
  it('round-trips every id buildReaderEntries produces back to its matchToken', () => {
    const entries = buildReaderEntries([
      { matchToken: 'tokA', templates: ['t1', 't2'] },
      { matchToken: 'tokB', templates: ['t3'] },
    ]);
    for (const e of entries) {
      const expectedToken = e.id.startsWith('tokA') ? 'tokA' : 'tokB';
      expect(resolveFingerprintMatchToken(e.id)).toBe(expectedToken);
    }
  });
  it('returns an id unchanged if it has no slot suffix (defensive)', () => {
    expect(resolveFingerprintMatchToken('bareToken')).toBe('bareToken');
  });
});

import { describe, it, expect } from 'vitest';
import {
  loggedOutPool,
  soloPool,
  poolEntries,
  poolKey,
  poolFor,
  type FingerprintCredential,
} from './pool';

// Carried across from v1's fingerprint-pool.test.ts (T-314 slice A, 2026-09-14). v1's
// `localUserId` is renamed `employmentId` throughout — v2's actual domain concept
// (`MirroredCredential.employmentId`, `attendance_credentials.employment_id`); a v1-only
// Firestore local-user id has no v2 equivalent. The invariants under test are unchanged.
// `poolFor` is new, added for the slice A contract's single dispatch entry point.

const cred = (id: string, tokens = 1): FingerprintCredential => ({
  employmentId: id,
  matchToken: `tok-${id}`,
  templates: Array.from({ length: tokens }, (_, i) => `tpl-${id}-${i}`),
});

const ALL = [cred('ana'), cred('ben'), cred('cid'), cred('dee')];

describe('loggedOutPool', () => {
  it('is everyone when nobody is on shift', () => {
    expect(loggedOutPool(ALL, []).map((c) => c.employmentId)).toEqual(['ana', 'ben', 'cid', 'dee']);
  });

  it('shrinks as the shift fills — the point of partitioning', () => {
    expect(loggedOutPool(ALL, ['ana', 'ben']).map((c) => c.employmentId)).toEqual(['cid', 'dee']);
  });

  it('is empty once everyone is on shift, so a stray press matches nobody', () => {
    // Correct: with the whole team clocked in there is no legitimate clock-IN to
    // make, and a press should not silently resolve to someone.
    expect(loggedOutPool(ALL, ['ana', 'ben', 'cid', 'dee'])).toEqual([]);
  });

  it('ignores on-shift ids that have no enrolled fingerprint', () => {
    expect(loggedOutPool(ALL, ['nobody']).map((c) => c.employmentId)).toHaveLength(4);
  });
});

describe('soloPool', () => {
  it('narrows to exactly one candidate — this is what makes it a 1:1 verify', () => {
    const p = soloPool(ALL, 'cid');
    expect(p).toHaveLength(1);
    const [only] = p ?? [];
    expect(only?.employmentId).toBe('cid');
  });

  it('returns null when that staffer has no fingerprint enrolled', () => {
    // The row must then fall back to passcode/NFC rather than arming an empty
    // matcher, which would reject every press with no explanation.
    expect(soloPool(ALL, 'not-enrolled')).toBeNull();
  });
});

describe('poolEntries', () => {
  it('emits one entry per finger, not per person', () => {
    expect(poolEntries([cred('ana', 2)])).toHaveLength(2);
  });

  it('is empty for an empty pool', () => {
    expect(poolEntries([])).toEqual([]);
  });
});

describe('poolKey', () => {
  it('is stable regardless of order', () => {
    expect(poolKey([cred('b'), cred('a')])).toBe(poolKey([cred('a'), cred('b')]));
  });

  it('changes when membership changes, so a stale pool is reloaded', () => {
    expect(poolKey([cred('a')])).not.toBe(poolKey([cred('a'), cred('b')]));
  });

  it('distinguishes the solo pool from the full pool', () => {
    // 'ana' is one of ALL's own entries with a template enrolled, so soloPool cannot return null here.
    expect(poolKey(soloPool(ALL, 'ana')!)).not.toBe(poolKey(ALL));
  });
});

describe('poolFor', () => {
  it('dispatches to loggedOutPool for the "loggedOut" mode', () => {
    const result = poolFor({ kind: 'loggedOut', onShiftEmploymentIds: ['ana'] }, ALL);
    expect(result?.map((c) => c.employmentId)).toEqual(['ben', 'cid', 'dee']);
  });

  it('dispatches to soloPool for the "solo" mode', () => {
    const result = poolFor({ kind: 'solo', employmentId: 'cid' }, ALL);
    expect(result?.map((c) => c.employmentId)).toEqual(['cid']);
  });

  it('returns null for a solo mode naming someone with no fingerprint enrolled', () => {
    expect(poolFor({ kind: 'solo', employmentId: 'not-enrolled' }, ALL)).toBeNull();
  });
});

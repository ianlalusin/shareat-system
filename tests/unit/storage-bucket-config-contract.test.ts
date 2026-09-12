import { describe, it, expect } from 'vitest';
import {
  checkValueAgainstDocs,
  checkValuesDiffer,
  STORAGE_BUCKET_EXPECTATION,
} from '../../scripts/lib/config-contract';

/**
 * T-280 / DEF-311. `checkValueAgainstDocs` and `checkValuesDiffer` are pure — no Firebase
 * credentials, no network — so every state below is EXECUTED, not reasoned about.
 *
 * ⚠️ What this file does NOT prove, named per the briefing's own rule: it does not re-run the
 * OLD, pre-T-280 `storage-smoke` checks (1,2,4,5) against a live wrong-but-reachable bucket to
 * watch them pass. That state already happened for real, in production, for the deployment's
 * entire life (DEF-311's register row) — this task cites that incident rather than re-deriving
 * it, because there is no second real bucket to plant against safely and a live `storage-smoke`
 * run is gated behind asking system32-85 first. What IS proven here, executably, is that the NEW
 * check this task adds actually distinguishes the wrong value from the right one.
 */
describe('checkValueAgainstDocs — DEF-311, FIREBASE_STORAGE_BUCKET', () => {
  it('State 1 — fails on the ACTUAL historical wrong value (v1\'s bucket)', () => {
    const result = checkValueAgainstDocs(
      'shareat-hub-v2.firebasestorage.app',
      STORAGE_BUCKET_EXPECTATION,
    );
    expect(result.ok).toBe(false);
  });

  it('State 2 — fails on the other documented-wrong variant (.appspot.com)', () => {
    const result = checkValueAgainstDocs('shareat-hub-v2.appspot.com', STORAGE_BUCKET_EXPECTATION);
    expect(result.ok).toBe(false);
  });

  it('State 3 — passes on the correct, documented value', () => {
    const result = checkValueAgainstDocs('shareat-hub-v2', STORAGE_BUCKET_EXPECTATION);
    expect(result.ok).toBe(true);
  });

  it('a wrong value never silently matches by substring or case', () => {
    expect(checkValueAgainstDocs('Shareat-Hub-V2', STORAGE_BUCKET_EXPECTATION).ok).toBe(false);
    expect(checkValueAgainstDocs('shareat-hub-v2 ', STORAGE_BUCKET_EXPECTATION).ok).toBe(false);
    expect(checkValueAgainstDocs('prefix-shareat-hub-v2', STORAGE_BUCKET_EXPECTATION).ok).toBe(
      false,
    );
  });

  it('message content — the failure names both documented citations, not just that it failed', () => {
    const result = checkValueAgainstDocs(
      'shareat-hub-v2.firebasestorage.app',
      STORAGE_BUCKET_EXPECTATION,
    );
    expect(result.message).toContain('.env.example:55-60');
    expect(result.message).toContain('docs/reference/private-bucket-storage-rules.md:62-63');
    expect(result.message).toContain('FIREBASE_STORAGE_BUCKET');
  });

  it('a passing result also names the env var and the actual value, for the smoke test\'s own ✓ line', () => {
    const result = checkValueAgainstDocs('shareat-hub-v2', STORAGE_BUCKET_EXPECTATION);
    expect(result.envVar).toBe('FIREBASE_STORAGE_BUCKET');
    expect(result.actual).toBe('shareat-hub-v2');
  });
});

describe('checkValuesDiffer — .env.example:56,71-73, FIREBASE_STORAGE_BUCKET vs NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET', () => {
  const CITATION = '.env.example:56,71-73';

  it('State 4a — fails when both variables hold the same string', () => {
    const result = checkValuesDiffer(
      { envVar: 'FIREBASE_STORAGE_BUCKET', value: 'shareat-hub-v2' },
      { envVar: 'NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET', value: 'shareat-hub-v2' },
      CITATION,
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain(CITATION);
  });

  it('State 4b — passes when the two values differ', () => {
    const result = checkValuesDiffer(
      { envVar: 'FIREBASE_STORAGE_BUCKET', value: 'shareat-hub-v2' },
      {
        envVar: 'NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET',
        value: 'shareat-hub-v2.firebasestorage.app',
      },
      CITATION,
    );
    expect(result.ok).toBe(true);
  });

  it('State 4c — passes when the public bucket is unset (undefined)', () => {
    const result = checkValuesDiffer(
      { envVar: 'FIREBASE_STORAGE_BUCKET', value: 'shareat-hub-v2' },
      { envVar: 'NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET', value: undefined },
      CITATION,
    );
    expect(result.ok).toBe(true);
  });
});

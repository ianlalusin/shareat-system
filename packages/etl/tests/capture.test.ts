import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadCaptureCredentials,
  runCapture,
  sampleCandidates,
  type CaptureCandidate,
} from '../src/capture';

const packageRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');

/**
 * This is a UNIT test (packages/etl/tests/, not tests/integration/) — vitest's unit
 * project never runs tests/integration/setup.ts, so `process.env` here would otherwise
 * NOT reflect .env.local at all, and a test claiming to check "the real .env.local" would
 * actually just be checking a blank environment, which passes for the wrong reason. Load
 * .env.local explicitly, into its own object (never mutating `process.env`), so the one
 * test below that claims to check it actually does.
 */
const dotenvResult = loadDotenv({ path: join(packageRoot, '..', '..', '.env.local'), processEnv: {} as Record<string, string> });
const realDotEnvLocal: Record<string, string | undefined> = dotenvResult.parsed ?? {};

describe('invariant 10 — capture skips cleanly without credentials', () => {
  it('skips with all three variables listed as missing when none are set', () => {
    const result = loadCaptureCredentials({});
    expect('skipped' in result && result.skipped).toBe(true);
    if ('skipped' in result) {
      expect(result.missing).toEqual(['CAPTURE_HUB_SA_KEY', 'CAPTURE_ERP_SA_KEY', 'CAPTURE_SALT']);
      expect(result.reason).toMatch(/CAPTURE_HUB_SA_KEY/);
    }
  });

  it('lists only the variables actually missing when some are set', () => {
    const result = loadCaptureCredentials({ CAPTURE_HUB_SA_KEY: 'x', CAPTURE_SALT: '' });
    expect('skipped' in result && result.skipped).toBe(true);
    if ('skipped' in result) {
      expect(result.missing).toEqual(['CAPTURE_ERP_SA_KEY', 'CAPTURE_SALT']); // blank counts as missing
    }
  });

  it('never falls back to FIREBASE_SERVICE_ACCOUNT_KEY — a different credential for a different purpose', () => {
    const result = loadCaptureCredentials({
      FIREBASE_SERVICE_ACCOUNT_KEY: '{"type":"service_account","project_id":"prod"}',
      FIREBASE_PROJECT_ID: 'prod-project',
    });
    expect('skipped' in result && result.skipped).toBe(true);
    if ('skipped' in result) {
      expect(result.missing).toEqual(['CAPTURE_HUB_SA_KEY', 'CAPTURE_ERP_SA_KEY', 'CAPTURE_SALT']);
    }
  });

  it('resolves real credentials when all three are present and non-blank', () => {
    const result = loadCaptureCredentials({
      CAPTURE_HUB_SA_KEY: 'hub-key',
      CAPTURE_ERP_SA_KEY: 'erp-key',
      CAPTURE_SALT: 'a-real-salt',
    });
    expect('skipped' in result).toBe(false);
    if (!('skipped' in result)) {
      expect(result.hubSaKey).toBe('hub-key');
      expect(result.erpSaKey).toBe('erp-key');
      expect(result.salt).toBe('a-real-salt');
    }
  });
});

describe('runCapture — the actual path this environment takes', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns the skip result and warns, without throwing, when credentials are absent', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await runCapture({});
    expect(result.skipped).toBe(true);
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it("this repo's actual .env.local has no capture credentials set — runCapture(realDotEnvLocal) skips", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Proves the REAL path this environment takes, against the REAL .env.local file (read
    // directly above, not process.env — see the file-level comment for why process.env
    // alone would prove nothing in a unit test). If this ever starts failing because
    // someone adds CAPTURE_* to .env.local, that is expected — Part 2 stops being
    // guard-only at that point, which is a real environment change, not a broken test.
    const result = await runCapture(realDotEnvLocal);
    expect(result.skipped).toBe(true);
    if (result.skipped) {
      expect(result.missing).toEqual(['CAPTURE_HUB_SA_KEY', 'CAPTURE_ERP_SA_KEY', 'CAPTURE_SALT']);
    }
  });

  it('throws (does not silently no-op) if credentials WERE present, because Part 2 execution is not implemented', async () => {
    await expect(
      runCapture({ CAPTURE_HUB_SA_KEY: 'x', CAPTURE_ERP_SA_KEY: 'y', CAPTURE_SALT: 'z' }),
    ).rejects.toThrow(/not implemented/);
  });
});

describe('capture.ts touches no live credential or network client', () => {
  it('does not import firebase-admin or any other Firestore client', () => {
    // Checks actual import/require specifiers only — the header comment legitimately
    // NAMES "firebase-admin" in prose to explain why it is deliberately absent, so a
    // bare substring match would misfire on the explanation itself.
    const source = readFileSync(join(packageRoot, 'src', 'capture.ts'), 'utf8');
    const specifiers = [...source.matchAll(/\b(?:from|require)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
    expect(specifiers.some((s) => s?.includes('firebase'))).toBe(false);
  });

  it('@shareat/etl declares no firebase-admin dependency', () => {
    const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
    const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    expect(allDeps['firebase-admin']).toBeUndefined();
  });
});

describe('sampleCandidates — the coverage-driven sampler (invariants 1–2 wired to a real loop)', () => {
  function candidate(businessDate: string): CaptureCandidate {
    return { docKind: 'salesDay', storeCode: 'STORE-A', businessDate, doc: { id: businessDate, submittedByName: 'Real Name' } };
  }

  it('captures up to target and stops for a capped class', () => {
    const candidates = Array.from({ length: 6 }, (_, i) => candidate(`2026-01-0${i + 1}`));
    const result = sampleCandidates(candidates, () => 'expense.cash', 'salt', new Map());
    expect(result.sampled).toHaveLength(3); // expense.cash target is 3
    expect(result.skippedCandidates).toHaveLength(3);
  });

  it('never caps an anomaly class', () => {
    const candidates = Array.from({ length: 10 }, (_, i) => candidate(`2026-01-${10 + i}`));
    const result = sampleCandidates(candidates, () => 'anomaly.negative', 'salt', new Map());
    expect(result.sampled).toHaveLength(10);
    expect(result.skippedCandidates).toHaveLength(0);
  });

  it('respects a starting count already at target (idempotent re-run for the same day)', () => {
    const candidates = [candidate('2026-01-20')];
    const result = sampleCandidates(candidates, () => 'expense.cash', 'salt', new Map([['expense.cash', 3]]));
    expect(result.sampled).toHaveLength(0);
    expect(result.skippedCandidates).toHaveLength(1);
  });

  it('redacts every sampled candidate\'s document', () => {
    const candidates = [candidate('2026-01-21')];
    const result = sampleCandidates(candidates, () => 'expense.cash', 'salt', new Map());
    expect(result.sampled).toHaveLength(1);
    expect(JSON.stringify(result.sampled[0]!.redactedDoc)).not.toContain('Real Name');
  });
});

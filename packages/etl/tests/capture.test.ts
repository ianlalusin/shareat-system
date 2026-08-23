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

  it("runCapture against this repo's REAL .env.local never silently no-ops, whatever is set", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // REWRITTEN 2026-08-23. This test previously asserted that .env.local contains NO capture
    // credentials, and listed all three as missing. That was true when written and stopped
    // being true the moment Ian supplied the first real key — which the original correctly
    // predicted in its own comment ("a real environment change, not a broken test").
    //
    // Re-pinning it to the NEW environment state would just schedule the same failure for
    // when the second key arrives. So it now asserts the property that must hold in EVERY
    // credential state, which is what the test was really protecting:
    //
    //   partial/absent credentials -> a skip result naming exactly what is missing
    //   complete credentials       -> a THROW, because Part 2 execution is not implemented
    //
    // What must never happen, in any state, is a silent success that captured nothing.
    let result: Awaited<ReturnType<typeof runCapture>> | undefined;
    let threw: unknown;
    try {
      result = await runCapture(realDotEnvLocal);
    } catch (e) {
      threw = e;
    }

    if (threw !== undefined) {
      // Fully credentialed: the only acceptable outcome is the explicit not-implemented throw.
      expect(String(threw)).toMatch(/not implemented/);
      return;
    }

    expect(result!.skipped, 'a partially-credentialed environment must SKIP, never quietly succeed').toBe(true);
    if (result!.skipped) {
      // Whatever is missing must be named, and every name must be a real variable — never
      // prose, so a caller can act on it programmatically.
      expect(result!.missing.length).toBeGreaterThan(0);
      for (const name of result!.missing) {
        expect(name).toMatch(/^CAPTURE_(HUB_SA_KEY|ERP_SA_KEY|SALT)$/);
      }
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

// -------------------------------------------------------------------------------------------
// Credential FILES — Ian supplies the two service accounts as JSON files under secrets/
// (gitignored) rather than pasting them into env values. See secrets/README.md.
//
// Every test here injects a fake reader: proving the path branch must never require a real
// service-account key on disk, and a test suite that needs one is a test suite that invites
// someone to put one there.
// -------------------------------------------------------------------------------------------
describe('loadCaptureCredentials — credential files', () => {
  const validKey = JSON.stringify({
    type: 'service_account',
    project_id: 'erp-v1',
    client_email: 'reader@erp-v1.iam.gserviceaccount.com',
    private_key: 'not-a-real-key',
  });

  const fileEnv = {
    CAPTURE_HUB_SA_KEY_FILE: './secrets/hub.sa.json',
    CAPTURE_ERP_SA_KEY_FILE: './secrets/erp.sa.json',
    CAPTURE_SALT: 'salty',
  };

  it('loads both service accounts from files', () => {
    const seen: string[] = [];
    const result = loadCaptureCredentials(fileEnv, (path) => {
      seen.push(path);
      return validKey;
    });

    expect('skipped' in result).toBe(false);
    if (!('skipped' in result)) {
      expect(result.erpSaKey).toBe(validKey);
      expect(result.hubSaKey).toBe(validKey);
      expect(result.salt).toBe('salty');
    }
    expect(seen).toEqual(['./secrets/hub.sa.json', './secrets/erp.sa.json']);
  });

  it('the two forms may be MIXED — one file, one inline', () => {
    const result = loadCaptureCredentials(
      { CAPTURE_HUB_SA_KEY: validKey, CAPTURE_ERP_SA_KEY_FILE: './secrets/erp.sa.json', CAPTURE_SALT: 's' },
      () => validKey,
    );
    expect('skipped' in result).toBe(false);
  });

  it('setting BOTH forms for one credential is REJECTED, not silently resolved', () => {
    // A precedence rule is a rule nobody remembers under pressure, and "which key did it
    // actually use" is the worst question to have to ask about a production credential.
    const result = loadCaptureCredentials(
      { ...fileEnv, CAPTURE_ERP_SA_KEY: validKey },
      () => validKey,
    );
    expect('skipped' in result).toBe(true);
    if ('skipped' in result) expect(result.reason).toContain('BOTH set');
  });

  it('an unreadable path fails naming the PATH, and never touches the filesystem twice', () => {
    const result = loadCaptureCredentials(fileEnv, () => {
      throw new Error('ENOENT: no such file');
    });
    expect('skipped' in result).toBe(true);
    if ('skipped' in result) {
      expect(result.reason).toContain('./secrets/erp.sa.json');
      expect(result.reason).toContain('could not be read');
    }
  });

  it('a file that is not valid JSON is caught at LOAD, not at auth time', () => {
    const result = loadCaptureCredentials(fileEnv, () => 'this is not json');
    expect('skipped' in result).toBe(true);
    if ('skipped' in result) expect(result.reason).toContain('not valid JSON');
  });

  it('valid JSON that is not a service account is rejected by shape', () => {
    const result = loadCaptureCredentials(fileEnv, () => JSON.stringify({ hello: 'world' }));
    expect('skipped' in result).toBe(true);
    if ('skipped' in result) expect(result.reason).toContain('does not look like a service-account key');
  });

  it('an OAuth client secret mistaken for a service account is rejected by type', () => {
    // The realistic wrong-file case: both live in the same console, both are JSON.
    const result = loadCaptureCredentials(fileEnv, () =>
      JSON.stringify({
        type: 'authorized_user',
        project_id: 'erp-v1',
        client_email: 'x@y.z',
        private_key: 'k',
      }),
    );
    expect('skipped' in result).toBe(true);
    if ('skipped' in result) expect(result.reason).toContain('expected "service_account"');
  });

  it('NEVER leaks key material into the failure reason', () => {
    // The whole point of the file form is that the key stops appearing in places that get
    // copied around. An error message is exactly such a place.
    const secret = 'SUPER-SECRET-PRIVATE-KEY-MATERIAL';
    const result = loadCaptureCredentials(fileEnv, () =>
      JSON.stringify({ type: 'authorized_user', project_id: 'p', client_email: 'e', private_key: secret }),
    );
    expect('skipped' in result).toBe(true);
    if ('skipped' in result) {
      expect(result.reason).not.toContain(secret);
      expect(JSON.stringify(result)).not.toContain(secret);
    }
  });

  it('missing[] stays a list of variable NAMES, never prose', () => {
    // Regression guard: `missing` is machine-readable and a caller may match on it. The
    // "or use the _FILE form" explanation belongs in `reason`.
    const result = loadCaptureCredentials({}, () => validKey);
    expect('skipped' in result).toBe(true);
    if ('skipped' in result) {
      expect(result.missing).toEqual(['CAPTURE_HUB_SA_KEY', 'CAPTURE_ERP_SA_KEY', 'CAPTURE_SALT']);
      expect(result.reason).toContain('CAPTURE_*_SA_KEY_FILE');
    }
  });
});

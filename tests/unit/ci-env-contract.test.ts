import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T-307 / DEF-329 — nothing else in this repo checks that `.github/workflows/ci.yml`'s `verify`
 * job's `env:` block is a startup-valid example of the contract `packages/core/src/env.ts`
 * enforces. DEF-328 was a one-character mismatch between two of those hand-maintained placeholders
 * that took CI red for a day, invisible to typecheck and to the unit suite (neither loads server
 * env) — this reads the real file and boots the real `env()` against it, so the next such mismatch
 * fails here in seconds instead of surfacing as a red integration run a day later.
 *
 * `tests/unit/env.test.ts` already exercises both contracts `checkValueContracts` enforces
 * (APP_TIMEZONE/BUSINESS_TIMEZONE, FIREBASE_PROJECT_ID/NEXT_PUBLIC_FIREBASE_PROJECT_ID) — but only
 * against hand-typed literals it constructs itself. This file is the first thing in the repo that
 * reads ci.yml and asserts on it.
 */

const repoRoot = join(import.meta.dirname, '..', '..');
const workflow = readFileSync(join(repoRoot, '.github/workflows/ci.yml'), 'utf8');

/**
 * Dependency-free, matching `tests/unit/deploy-migrate-uses-system-db-url.test.ts`'s own
 * precedent: no yaml/js-yaml parser added for one flat mapping. Indentation-scoped (six spaces)
 * so the workflow's OTHER `env:` blocks — the top-level one (`NODE_VERSION` only) and the
 * `services.postgres.env` block, eight spaces — can never be picked up by accident.
 */
function extractJobEnvBlock(yaml: string, jobKey: string): Record<string, string> {
  const jobHeaderIdx = yaml.indexOf(`\n  ${jobKey}:\n`);
  expect(jobHeaderIdx, `job "${jobKey}" not found in ci.yml`).toBeGreaterThan(-1);
  const afterJob = yaml.slice(jobHeaderIdx);
  const envBlockMarker = '\n    env:\n';
  const envIdx = afterJob.indexOf(envBlockMarker);
  expect(envIdx, `no env: block found under job "${jobKey}"`).toBeGreaterThan(-1);
  const body = afterJob.slice(envIdx + envBlockMarker.length);

  const result: Record<string, string> = {};
  for (const line of body.split('\n')) {
    if (!line.startsWith('      ')) break; // dedent (blank line or next key) ends the block
    const content = line.slice(6);
    if (content.startsWith('#') || content.trim() === '') continue;
    const match = content.match(/^([A-Z0-9_]+):\s?(.*)$/);
    if (!match) continue;
    // Both groups are mandatory in the pattern above (no `?`), so a successful match guarantees
    // both are defined — `.*` matches even an empty string, it never fails to capture.
    const key = match[1]!;
    let value = match[2]!;
    if (
      (value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"'))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

describe("ci.yml verify-job env: block satisfies @shareat/core/env's startup contract (T-307 / DEF-329)", () => {
  let saved: NodeJS.ProcessEnv;
  let ciEnv: Record<string, string>;

  beforeEach(() => {
    saved = process.env;
    vi.resetModules();
    ciEnv = extractJobEnvBlock(workflow, 'verify');
  });

  afterEach(() => {
    process.env = saved;
  });

  it('parsed a real, non-trivial set of fields — guards against the extractor silently returning {}', () => {
    expect(Object.keys(ciEnv).length).toBeGreaterThanOrEqual(10);
    expect(ciEnv.DATABASE_URL).toBeTruthy();
    expect(ciEnv.SESSION_SECRET).toBeTruthy();
  });

  it('boots @shareat/core/env() cleanly against the real block — zero contract failures', async () => {
    // Replaced wholesale, never merged with the ambient environment: merging would let a variable
    // set only on this machine stand in for one missing from ci.yml, so the test could pass
    // locally while the CI run it is modelling would still fail. The strict object is what makes
    // this assertion mean "these values, alone, boot the app."
    process.env = { ...ciEnv } as unknown as NodeJS.ProcessEnv;
    const mod = await import('@shareat/core/env');
    expect(() => mod.env()).not.toThrow();
  });

  it("⛔ CONTROL — catches DEF-328's exact shape: FIREBASE_PROJECT_ID vs NEXT_PUBLIC_FIREBASE_PROJECT_ID disagreeing", async () => {
    process.env = {
      ...ciEnv,
      NEXT_PUBLIC_FIREBASE_PROJECT_ID: `${ciEnv.NEXT_PUBLIC_FIREBASE_PROJECT_ID}-mismatch`,
    } as unknown as NodeJS.ProcessEnv;
    const mod = await import('@shareat/core/env');
    // Not /FIREBASE_PROJECT_ID/ — that substring also occurs inside
    // NEXT_PUBLIC_FIREBASE_PROJECT_ID, so it would match this failure for the wrong reason (or an
    // unrelated one naming either variable). Match the consequence sentence unique to this branch
    // of checkValueContracts instead.
    expect(() => mod.env()).toThrow(/rejected as unverifiable/);
  });

  it('⛔ CONTROL — catches an APP_TIMEZONE that disagrees with BUSINESS_TIMEZONE', async () => {
    process.env = { ...ciEnv, APP_TIMEZONE: 'UTC' } as unknown as NodeJS.ProcessEnv;
    const mod = await import('@shareat/core/env');
    expect(() => mod.env()).toThrow(/BUSINESS_TIMEZONE/);
  });
});

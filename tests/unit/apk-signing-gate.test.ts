/**
 * T-417 case 10 / slice B4 - `scripts/apk-signing-gate.mjs`. A missing keystore must SKIP (green),
 * a half-set one must FAIL (a half-set key is a mistake), and no secret value may ever be echoed.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const script = path.resolve(__dirname, '..', '..', 'scripts', 'apk-signing-gate.mjs');
const VARS = ['ANDROID_KEYSTORE_BASE64', 'ANDROID_KEYSTORE_PASSWORD', 'ANDROID_KEY_ALIAS', 'ANDROID_KEY_PASSWORD'] as const;
// Distinctive sentinels so "no value is echoed" is a real substring check.
const VALUE: Record<(typeof VARS)[number], string> = {
  ANDROID_KEYSTORE_BASE64: 'SENTINEL-b64-Zm9vYmFy-1111',
  ANDROID_KEYSTORE_PASSWORD: 'SENTINEL-storepw-2222',
  ANDROID_KEY_ALIAS: 'SENTINEL-alias-3333',
  ANDROID_KEY_PASSWORD: 'SENTINEL-keypw-4444',
};

const tmp = mkdtempSync(path.join(os.tmpdir(), 'apk-gate-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;
function run(set: readonly (typeof VARS)[number][]) {
  const outFile = path.join(tmp, `gh-output-${n++}.txt`);
  writeFileSync(outFile, '');
  const env: NodeJS.ProcessEnv = { ...process.env, GITHUB_OUTPUT: outFile };
  for (const v of VARS) delete env[v];
  for (const v of set) env[v] = VALUE[v];
  const r = spawnSync(process.execPath, [script], { env, encoding: 'utf8', timeout: 20_000 });
  const stdout = r.stdout ?? '';
  const stderr = r.stderr ?? '';
  const output = readFileSync(outFile, 'utf8');
  return { status: r.status, stdout, stderr, output, all: stdout + stderr + output };
}

const NOTICE =
  '::notice::Release APK skipped: the ANDROID_KEYSTORE secrets are not set yet. Ian adds them in GitHub Settings > Secrets. Web build and typecheck above still ran.';

describe('T-417 apk-signing-gate', () => {
  it('no vars -> exit 0, signing=skip, the plain notice. Mutant: missing secret failing main', () => {
    const r = run([]);
    expect(r.status).toBe(0);
    expect(r.output).toMatch(/^signing=skip$/m);
    expect(r.stdout).toContain(NOTICE);
  });

  it('all four vars -> exit 0, signing=release', () => {
    const r = run(VARS);
    expect(r.status).toBe(0);
    expect(r.output).toMatch(/^signing=release$/m);
    expect(r.output).not.toMatch(/signing=skip/);
  });

  it('two vars -> exit 1, ::error:: names exactly the two missing, writes no signing=release. Mutant: partial key passing', () => {
    const r = run(['ANDROID_KEYSTORE_BASE64', 'ANDROID_KEYSTORE_PASSWORD']);
    expect(r.status).toBe(1);
    expect(r.all).toMatch(/::error::/);
    expect(r.all).toContain('ANDROID_KEY_ALIAS');
    expect(r.all).toContain('ANDROID_KEY_PASSWORD');
    expect(r.output).not.toMatch(/signing=release/);
  });

  it.each([
    [['ANDROID_KEY_PASSWORD'] as const, ['ANDROID_KEYSTORE_BASE64', 'ANDROID_KEYSTORE_PASSWORD', 'ANDROID_KEY_ALIAS']],
    [['ANDROID_KEYSTORE_BASE64', 'ANDROID_KEYSTORE_PASSWORD', 'ANDROID_KEY_ALIAS'] as const, ['ANDROID_KEY_PASSWORD']],
  ])('1 or 3 vars set (%j) -> exit 1 and names the missing ones', (set, missing) => {
    const r = run(set);
    expect(r.status).toBe(1);
    for (const m of missing) expect(r.all).toContain(m);
    for (const s of set) {
      // A SET variable is not reported as missing.
      const errLine = r.all.split(/\r?\n/).find((l) => l.startsWith('::error::')) ?? '';
      expect(errLine).not.toContain(s);
    }
  });

  it('a set-but-empty var counts as not set (GitHub passes unset secrets as empty strings)', () => {
    const outFile = path.join(tmp, 'gh-output-empty.txt');
    writeFileSync(outFile, '');
    const env: NodeJS.ProcessEnv = { ...process.env, GITHUB_OUTPUT: outFile };
    for (const v of VARS) env[v] = '';
    const r = spawnSync(process.execPath, [script], { env, encoding: 'utf8', timeout: 20_000 });
    expect(r.status).toBe(0);
    expect(readFileSync(outFile, 'utf8')).toMatch(/^signing=skip$/m);
  });

  it.each([[[]], [['ANDROID_KEYSTORE_BASE64', 'ANDROID_KEYSTORE_PASSWORD']], [[...VARS]]] as const)(
    'never echoes a secret value (set: %j)',
    (set) => {
      const r = run(set);
      for (const v of VARS) expect(r.all, v).not.toContain(VALUE[v]);
    },
  );
});

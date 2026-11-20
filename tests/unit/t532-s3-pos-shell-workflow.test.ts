/** T-532 S3 — the POS shell workflow: triggers, secrets gate, artifact name, and that apps/pos and ci.yml are not what it builds. Text-level (no YAML parser in the repo). */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const text = readFileSync(path.resolve(__dirname, '..', '..', '.github', 'workflows', 'pos-shell-build.yml'), 'utf8').replace(/\r\n/g, '\n');

describe('pos-shell-build.yml (T-532 S3)', () => {
  it('runs on apps/pos-shell changes and on manual dispatch, nothing wider', () => {
    expect(text).toContain("- 'apps/pos-shell/**'");
    expect(text).toContain('workflow_dispatch:');
    expect(text).not.toContain("- 'apps/pos/**'");
  });
  it('builds apps/pos-shell only and gates signing through apk-signing-gate with all four secrets', () => {
    expect(text).not.toMatch(/apps\/pos\/|apps\/pos-shell\/\.\.\//);
    expect(text).toContain('node scripts/apk-signing-gate.mjs');
    for (const s of ['ANDROID_KEYSTORE_BASE64', 'ANDROID_KEYSTORE_PASSWORD', 'ANDROID_KEY_ALIAS', 'ANDROID_KEY_PASSWORD']) expect(text).toContain(`secrets.${s}`);
  });
  it('the release steps need signing == release; the artifact is pos-shell-<run>.apk', () => {
    expect(text).toMatch(/Assemble release APK\n\s+if: steps\.gate\.outputs\.signing == 'release'/);
    expect(text).toContain('name: pos-shell-${{ github.run_number }}.apk');
  });
  it('runs on a GitHub-hosted runner, never the self-hosted one', () => {
    expect(text).toContain('runs-on: ubuntu-latest');
    expect(text).not.toContain('CI_RUNNER');
  });
});

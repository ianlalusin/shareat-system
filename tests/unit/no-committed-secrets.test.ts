import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Fails the build if a credential is ever committed.
 *
 * `.gitignore` is the first line of defence and it is not enough on its own: it protects the
 * paths someone thought of in advance. A service-account JSON downloaded to the repo root under
 * an unfamiliar name, or pasted into a doc as an "example", is ignored by nothing — and a pushed
 * secret is a ROTATED secret, never a deleted one.
 *
 * This runs in CI on every push, which is the reason it is a test rather than a pre-commit hook:
 * a hook is bypassed with `--no-verify` and only exists on the machine that installed it. A test
 * guards the repository itself.
 *
 * It scans only GIT-TRACKED files. An uncommitted key sitting in `secrets/` is fine and expected
 * — that directory exists precisely so a credential has an ignored place to live.
 */

const repoRoot = join(import.meta.dirname, '..', '..');

/**
 * Built by concatenation on purpose. Written as plain literals, the markers below would appear
 * verbatim in this file, which is itself tracked — so the guard would flag itself on its first
 * run and the only available fix would be to exempt it. A guard with an exemption for the one
 * file that is easiest to edit is not much of a guard.
 */
const MARKERS: readonly { label: string; needle: string }[] = [
  { label: 'PEM private key block', needle: '-----BEGIN' + ' PRIVATE KEY-----' },
  { label: 'RSA private key block', needle: '-----BEGIN' + ' RSA PRIVATE KEY-----' },
  { label: 'service-account JSON', needle: '"type"' + ': "service_account"' },
  { label: 'service-account private_key field', needle: '"private' + '_key":' },
];

/** Binary and lockfile noise: never credential carriers, frequently enormous. */
const SKIP_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svg', '.pdf',
  '.woff', '.woff2', '.ttf', '.otf', '.eot', '.zip', '.gz', '.mp4', '.webm',
]);
const SKIP_FILES = new Set(['package-lock.json']);

const MAX_BYTES = 2 * 1024 * 1024;

function trackedFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out.split('\0').filter((f) => f.length > 0);
}

describe('no committed secrets', () => {
  it('no git-tracked file contains a service-account or private-key marker', () => {
    const offenders: string[] = [];

    for (const rel of trackedFiles()) {
      const base = rel.slice(rel.lastIndexOf('/') + 1);
      if (SKIP_FILES.has(base)) continue;

      const dot = base.lastIndexOf('.');
      if (dot > 0 && SKIP_EXTENSIONS.has(base.slice(dot).toLowerCase())) continue;

      const abs = join(repoRoot, rel);
      let content: string;
      try {
        // A tracked path can be absent from the working tree (a partial checkout, a
        // sparse-checkout cone). Skipping is correct: the guard runs on every push, so the
        // file is scanned wherever it IS present rather than failing the run here.
        if (statSync(abs).size > MAX_BYTES) continue;
        content = readFileSync(abs, 'utf8');
      } catch {
        continue;
      }

      for (const { label, needle } of MARKERS) {
        if (content.includes(needle)) offenders.push(`${rel} — ${label}`);
      }
    }

    expect(
      offenders,
      offenders.length === 0
        ? ''
        : `A credential appears to be COMMITTED:\n  ${offenders.join('\n  ')}\n\n` +
            'Do not simply delete it and commit again — it is in the history and must be treated ' +
            'as leaked. ROTATE the key in the Google Cloud console first, then remove the file, ' +
            'and put the replacement in secrets/ (gitignored) referenced by path from .env.local.',
    ).toEqual([]);
  });

  it('the secrets directory is ignored, and its README is not', () => {
    const ignored = (path: string): boolean => {
      try {
        execFileSync('git', ['check-ignore', '-q', path], { cwd: repoRoot });
        return true;
      } catch {
        return false;
      }
    };

    // Guards the exact mistake made while writing this: `secrets/` as a directory-level ignore
    // silently defeats `!secrets/README.md`, because git never descends into an ignored
    // directory. `secrets/*` is what makes the negation work. Both halves are asserted so a
    // future tidy-up of .gitignore cannot quietly break either one.
    expect(ignored('secrets/erp.sa.json'), 'a key file under secrets/ MUST be ignored').toBe(true);
    expect(ignored('secrets/README.md'), 'secrets/README.md must stay trackable').toBe(false);
  });
});

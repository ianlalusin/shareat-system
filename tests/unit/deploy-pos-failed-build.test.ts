/**
 * DEF-753 (T-473): a failed optional POS build must never replace a working POS release.
 * The POS build step leaves a success marker only on exit 0; packaging is gated on the marker; the
 * server keeps the previous release's POS when the new one has none and then does not restart it.
 * The server-side blocks are EXECUTED with bash against a temp dir standing in for /srv and /etc.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const deploy = readFileSync(path.resolve(__dirname, '..', '..', '.github', 'workflows', 'deploy.yml'), 'utf8').replace(/\r\n/g, '\n');

/** The `# >>> POS v2` block whose opening line contains `needle`, markers excluded, dedented. */
function posBlock(needle: string): string {
  const lines = deploy.split('\n');
  const s = lines.findIndex((l) => l.includes('# >>> POS v2') && l.includes(needle));
  expect(s, `POS v2 block containing "${needle}" exists`).toBeGreaterThanOrEqual(0);
  const e = lines.findIndex((l, i) => i > s && l.includes('# <<< POS v2'));
  const body = lines.slice(s + 1, e);
  const indent = Math.min(...body.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
  return body.map((l) => l.slice(indent)).join('\n');
}

const p = (s: string) => s.split(path.sep).join('/');

describe('deploy.yml: a failed POS build keeps the last good POS (DEF-753)', () => {
  it('the POS build step writes the marker only after a successful build', () => {
    expect(deploy).toMatch(/rm -f apps\/pos\/\.pos-build-ok && npm run build -w @shareat\/pos && touch apps\/pos\/\.pos-build-ok/);
    expect(deploy).toMatch(/- name: Build POS v2 \(web\)\n\s+continue-on-error: true/);
  });

  it('packaging is gated on the marker, not on .next existing, and ships the marker', () => {
    expect(deploy).toMatch(/if \[ -f apps\/pos\/\.pos-build-ok \]; then/);
    expect(deploy).not.toMatch(/if \[ -d apps\/pos\/\.next \]; then/);
    expect(deploy).toMatch(/PATHS="\$PATHS apps\/pos\/\.next[^"]*apps\/pos\/\.pos-build-ok/);
  });

  // ---- execute the server-side blocks ----
  const carry = () => posBlock('DEF-753');
  const restart = () => posBlock('restarts only once');

  function run(opts: { newHasMarker: boolean; prevPos: 'marker' | 'legacy' | 'none'; cpFails?: boolean }) {
    const root = mkdtempSync(path.join(tmpdir(), 'deploy-pos-'));
    try {
      const rel = path.join(root, 'srv', 'shareat-releases', 'new');
      const prev = path.join(root, 'srv', 'shareat-releases', 'prev');
      mkdirSync(path.join(rel, 'apps', 'erp'), { recursive: true });
      mkdirSync(path.join(prev, 'apps', 'erp'), { recursive: true });
      if (opts.newHasMarker) {
        mkdirSync(path.join(rel, 'apps', 'pos', '.next'), { recursive: true });
        writeFileSync(path.join(rel, 'apps', 'pos', '.pos-build-ok'), '');
        writeFileSync(path.join(rel, 'apps', 'pos', '.next', 'id'), 'NEW');
      }
      if (opts.prevPos !== 'none') {
        mkdirSync(path.join(prev, 'apps', 'pos', '.next'), { recursive: true });
        writeFileSync(path.join(prev, 'apps', 'pos', '.next', 'id'), 'PREV');
        if (opts.prevPos === 'marker') writeFileSync(path.join(prev, 'apps', 'pos', '.pos-build-ok'), '');
      }
      // /srv/shareat is a symlink to the previous release (Git Bash may make a copy; both work)
      spawnSync('bash', ['-c', `ln -s "${p(prev)}" "${p(root)}/srv/shareat"`]);
      mkdirSync(path.join(root, 'etc', 'systemd', 'system'), { recursive: true });
      writeFileSync(path.join(root, 'etc', 'systemd', 'system', 'shareat-pos.service'), '');
      const swap = (s: string) => s.replace(/\/srv\/shareat/g, `${p(root)}/srv/shareat`).replace(/\/etc\/systemd/g, `${p(root)}/etc/systemd`);
      const script = [
        'set -euo pipefail',
        `RELEASE="${p(rel)}"`,
        `sudo() { echo "sudo $*" >> "${p(root)}/calls.log"; }`,
        ...(opts.cpFails ? ['cp() { return 1; }'] : []),
        swap(carry()),
        'echo ERP_SWAP_REACHED',
        swap(restart()),
      ].join('\n');
      const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
      const calls = existsSync(path.join(root, 'calls.log')) ? readFileSync(path.join(root, 'calls.log'), 'utf8') : '';
      const idFile = path.join(rel, 'apps', 'pos', '.next', 'id');
      return {
        status: r.status, out: `${r.stdout}${r.stderr}`, calls,
        restarted: /systemctl restart shareat-pos\.service/.test(calls),
        reached: r.stdout.includes('ERP_SWAP_REACHED'),
        partial: existsSync(path.join(rel, 'apps', 'pos')),
        copied: existsSync(idFile) ? readFileSync(idFile, 'utf8') : null,
      };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it('(a) new release without the marker + previous with a POS: previous POS copied in, no restart, warning printed', () => {
    const r = run({ newHasMarker: false, prevPos: 'marker' });
    expect(r.status, r.out).toBe(0);
    expect(r.copied).toBe('PREV');
    expect(r.restarted).toBe(false);
    expect(r.out).toContain('::warning::');
  });

  it('(a2) a previous release from before the marker existed (only apps/pos/.next) is carried forward too', () => {
    const r = run({ newHasMarker: false, prevPos: 'legacy' });
    expect(r.status, r.out).toBe(0);
    expect(r.copied).toBe('PREV');
    expect(r.restarted).toBe(false);
  });

  it('(b) new release with the marker: nothing copied over it, POS restarted', () => {
    const r = run({ newHasMarker: true, prevPos: 'marker' });
    expect(r.status, r.out).toBe(0);
    expect(r.copied).toBe('NEW');
    expect(r.restarted).toBe(true);
  });

  it('(c) neither release has a POS: nothing copied, no restart, the reason is printed', () => {
    const r = run({ newHasMarker: false, prevPos: 'none' });
    expect(r.status, r.out).toBe(0);
    expect(r.copied).toBeNull();
    expect(r.restarted).toBe(false);
    expect(r.out).toMatch(/POS/);
  });

  it('(d) the carry-forward copy fails: warning, no partial POS left, script continues to the ERP swap, POS not restarted', () => {
    const r = run({ newHasMarker: false, prevPos: 'marker', cpFails: true });
    expect(r.status, r.out).toBe(0);
    expect(r.reached).toBe(true);
    expect(r.out).toContain('::warning::POS v2 carry-forward failed');
    expect(r.partial).toBe(false);
    expect(r.restarted).toBe(false);
  });
});

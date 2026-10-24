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

describe('deploy.yml: the cleanup never deletes the release the running POS lives in (DEF-770)', () => {
  const carry = () => posBlock('DEF-753');
  const restart = () => posBlock('restarts only once');
  const keep = () => posBlock('DEF-770');
  const cleanupLine = () => {
    const l = deploy.split('\n').find((x) => x.includes('tail -n +4 | xargs -r rm -rf'));
    expect(l, 'ERP cleanup line exists').toBeTruthy();
    return l!.trim();
  };

  /** A temp /srv; each deploy runs carry + (swap) + restart + retention + the real cleanup line. */
  function sandbox(opts: { touchFails?: boolean } = {}) {
    const root = mkdtempSync(path.join(tmpdir(), 'deploy-ret-'));
    const srv = `${p(root)}/srv`;
    mkdirSync(path.join(root, 'srv', 'shareat-releases'), { recursive: true });
    mkdirSync(path.join(root, 'etc', 'systemd', 'system'), { recursive: true });
    writeFileSync(path.join(root, 'etc', 'systemd', 'system', 'shareat-pos.service'), '');
    const swap = (s: string) => s.replace(/\/srv\/shareat/g, `${srv}/shareat`).replace(/\/etc\/systemd/g, `${p(root)}/etc/systemd`);
    let t = 100;
    const rels = path.join(root, 'srv', 'shareat-releases');
    const marker = path.join(rels, '.pos-running');
    function deploy_(name: string, posBuilds: boolean, mtimeBase: number) {
      const rel = path.join(rels, name);
      mkdirSync(path.join(rel, 'apps', 'erp'), { recursive: true });
      if (posBuilds) {
        mkdirSync(path.join(rel, 'apps', 'pos', '.next'), { recursive: true });
        writeFileSync(path.join(rel, 'apps', 'pos', '.pos-build-ok'), '');
      }
      const script = [
        'set -euo pipefail',
        `RELEASE="${p(rel)}"`,
        `sudo() { echo "sudo $*" >> "${p(root)}/calls.log"; }`,
        `readlink() { cat "${p(root)}/current.txt" 2>/dev/null; }`,
        // simulated clock: `touch -m X` stamps X just after this deploy's release was created
        ...(opts.touchFails ? ['touch() { return 1; }'] : [`touch() { shift; command touch -d @${mtimeBase + 50} "$@"; }`]),
        swap(carry()),
        `echo "$RELEASE" > "${p(root)}/current.txt"`, // stands in for the symlink swap (Git Bash cannot make real symlinks)
        'echo ERP_SWAP_REACHED',
        swap(restart()),
        swap(keep()),
        swap(cleanupLine()),
        'echo CLEANUP_REACHED',
      ].join('\n');
      // release dirs get increasing mtimes so `ls -1dt` orders them oldest..newest as deployed
      spawnSync('bash', ['-c', `touch -d @${mtimeBase} "${p(rel)}"`]);
      const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
      return { status: r.status, out: `${r.stdout}${r.stderr}` };
    }
    const deployNext = (name: string, posBuilds: boolean) => {
      t += 100;
      // new release is the newest at cleanup time (as in real life: just unpacked); older ones keep their older mtime
      return deploy_(name, posBuilds, Math.floor(Date.now() / 1000) - 100000 + t);
    };
    return {
      deployNext,
      exists: (n: string) => existsSync(path.join(rels, n)),
      marker: () => (existsSync(marker) ? readFileSync(marker, 'utf8').trim() : null),
      relPath: (n: string) => p(path.join(rels, n)),
      cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
  }

  it('(a) good A, then three deploys with failed POS builds: A survives the keep-last-3 cleanup, marker stays A', () => {
    const sb = sandbox();
    try {
      expect(sb.deployNext('A', true).status).toBe(0);
      expect(sb.marker()).toBe(sb.relPath('A'));
      for (const n of ['B', 'C', 'D']) {
        const r = sb.deployNext(n, false);
        expect(r.status, r.out).toBe(0);
      }
      expect(sb.exists('A'), 'release the running POS lives in must survive').toBe(true);
      expect(sb.marker()).toBe(sb.relPath('A'));
      expect(sb.exists('D') && sb.exists('C')).toBe(true);
    } finally { sb.cleanup(); }
  });

  it('(b) a later good deploy E restarts POS, moves the marker to E, and A may then be pruned', () => {
    const sb = sandbox();
    try {
      sb.deployNext('A', true);
      for (const n of ['B', 'C', 'D']) sb.deployNext(n, false);
      const r = sb.deployNext('E', true);
      expect(r.status, r.out).toBe(0);
      expect(sb.marker()).toBe(sb.relPath('E'));
      // A kept its touched (newer) mtime, so it ages out of the newest 3 over the next deploys
      sb.deployNext('F', true);
      sb.deployNext('G', true);
      expect(sb.marker()).toBe(sb.relPath('G'));
      expect(sb.exists('A'), 'unprotected A is pruned again').toBe(false);
    } finally { sb.cleanup(); }
  });

  it('(c) first carry-forward with no marker file records the previous release', () => {
    const sb = sandbox();
    try {
      // A shipped before the marker existed: it has a POS but no .pos-running file
      sb.deployNext('A', true);
      rmSync(path.join(path.dirname(sb.relPath('A')), '.pos-running'), { force: true });
      expect(sb.marker()).toBeNull();
      const r = sb.deployNext('B', false);
      expect(r.status, r.out).toBe(0);
      expect(sb.marker()).toBe(sb.relPath('A'));
    } finally { sb.cleanup(); }
  });

  it('(d) a failing touch/write prints a warning and the script still reaches the swap and cleanup', () => {
    const sb = sandbox({ touchFails: true });
    try {
      sb.deployNext('A', true);
      const r = sb.deployNext('B', false);
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain('ERP_SWAP_REACHED');
      expect(r.out).toContain('CLEANUP_REACHED');
      expect(r.out).toContain('::warning::');
    } finally { sb.cleanup(); }
  });
});

describe('deploy.yml run blocks stay valid block scalars (DEF-770 review)', () => {
  const lines = deploy.split('\n');
  const ind = (l: string) => l.length - l.trimStart().length;
  /** Every `run: |` block: its lines, and the line (if any) that ended it. */
  function runBlocks() {
    const out: Array<{ start: number; body: string[]; ender: string | null }> = [];
    for (let i = 0; i < lines.length; i++) {
      const m = /^(\s*)(?:- )?run: \|\s*$/.exec(lines[i]);
      if (!m) continue;
      const keyIndent = m[1].length;
      let n = -1;
      const body: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const l = lines[j];
        if (!l.trim()) { body.push(l); continue; }
        if (n < 0) n = ind(l);
        if (ind(l) < n) break;
        body.push(l);
      }
      out.push({ start: i + 1, body, ender: j < lines.length ? lines[j] : null });
      void keyIndent;
    }
    return out;
  }

  it('every run block ends only at real YAML structure, never at a stray column-0 line', () => {
    const blocks = runBlocks();
    expect(blocks.length).toBeGreaterThan(5);
    for (const b of blocks) {
      if (b.ender === null) continue;
      expect(b.ender, `run block at line ${b.start} was ended by a stray line`).toMatch(/^\s*(?:#|- [\w-]+:|[\w-]+:)/);
    }
  });

  it('the "Unpack, migrate, restart" block holds the DEF-770 lines and its closing REMOTE', () => {
    const at = lines.findIndex((l) => l.includes('name: Unpack, migrate, restart'));
    expect(at).toBeGreaterThan(0);
    const b = runBlocks().find((x) => x.start > at)!;
    const text = b.body.join('\n');
    expect(text).toContain('.pos-running');
    expect(text).toContain('touch -m "$POS_KEEP"');
    expect(text).toContain('tail -n +4 | xargs -r rm -rf');
    expect(b.body.filter((l) => l.trim()).pop()!.trim()).toBe('REMOTE');
  });
});

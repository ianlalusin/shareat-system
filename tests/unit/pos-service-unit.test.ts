/**
 * T-417 case 11 / slice B5 - `docs/ops/shareat-pos.service`: POS v2's web process, a second
 * long-running `next start` beside `shareat-erp.service` on the production droplet. Written as a
 * file only; installing and enabling it is a later task plus ops steps.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');
const unitPath = path.join(repoRoot, 'docs', 'ops', 'shareat-pos.service');
const unit = () => readFileSync(unitPath, 'utf8');
/** Directive lines only: not comments, not blanks. */
const directives = () =>
  unit()
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !l.startsWith(';'));

describe('T-417 shareat-pos.service', () => {
  it('exists', () => {
    expect(existsSync(unitPath)).toBe(true);
  });

  it('runs `npm run start` from apps/pos, whose start script binds 127.0.0.1:9009', () => {
    const d = directives();
    expect(d).toContain('Type=simple');
    expect(d).toContain('WorkingDirectory=/srv/shareat/apps/pos');
    expect(d).toContain('ExecStart=/usr/bin/npm run start');
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'apps', 'pos', 'package.json'), 'utf8'));
    expect(pkg.scripts.start).toMatch(/(?:-p|--port)[ =]9009\b/);
    expect(pkg.scripts.start).toMatch(/127\.0\.0\.1/);
  });

  it('runs as the shareat user and group, never root. Mutant: root user', () => {
    const d = directives();
    expect(d).toContain('User=shareat');
    expect(d).toContain('Group=shareat');
    expect(d.some((l) => /^User=root\b/.test(l))).toBe(false);
  });

  it('restarts always after 5 s, in production mode', () => {
    const d = directives();
    expect(d).toContain('Restart=always');
    expect(d).toContain('RestartSec=5');
    expect(d).toContain('Environment=NODE_ENV=production');
  });

  it('is memory-capped at 768M so it cannot starve the ERP on the 4 GB box (risk R6)', () => {
    expect(directives()).toContain('MemoryMax=768M');
  });

  it('logs to /var/log/shareat/pos.log', () => {
    const d = directives();
    expect(d).toContain('StandardOutput=append:/var/log/shareat/pos.log');
    expect(d).toContain('StandardError=append:/var/log/shareat/pos.log');
  });

  it('no ExecStart* line builds or installs. Mutant: a build on the droplet', () => {
    const exec = directives().filter((l) => /^ExecStart\w*=/.test(l));
    expect(exec.length).toBeGreaterThan(0);
    for (const l of exec) {
      expect(l, l).not.toMatch(/\bbuild\b|npm\s+ci\b|npm\s+install\b|npm\s+i\b|next\s+build/);
    }
  });

  it('does not wait on a local Postgres (the database is off-box)', () => {
    expect(directives().some((l) => /^(After|Requires|Wants|BindsTo)=.*postgres/i.test(l))).toBe(false);
  });

  it('the header says NEVER build here', () => {
    const comments = unit()
      .split(/\r?\n/)
      .filter((l) => l.trim().startsWith('#'))
      .join('\n');
    expect(comments).toMatch(/NEVER build/);
  });

  it('is installed WantedBy multi-user.target like the ERP unit, and docs/ops/README.md documents it', () => {
    expect(directives()).toContain('WantedBy=multi-user.target');
    const readme = readFileSync(path.join(repoRoot, 'docs', 'ops', 'README.md'), 'utf8');
    expect(readme).toContain('shareat-pos.service');
  });

  it('provision.sh is untouched in spirit: it does not enable shareat-pos', () => {
    const prov = readFileSync(path.join(repoRoot, 'docs', 'ops', 'provision.sh'), 'utf8');
    expect(prov).not.toMatch(/enable[^\n]*shareat-pos/);
  });
});

describe('POS v2 switch-on prep (7 Nov)', () => {
  it('the unit loads /srv/shareat-shared/pos2.env. Mutant: EnvironmentFile removed, every pos2 route answers 503', () => {
    expect(directives()).toContain('EnvironmentFile=/srv/shareat-shared/pos2.env');
  });

  it('provision.sh lets the deploy user restart shareat-pos.service (exact command), the ERP rule intact. Mutant: sudoers lists only shareat-erp', () => {
    const sh = readFileSync(path.join(repoRoot, 'docs', 'ops', 'provision.sh'), 'utf8');
    expect(sh).toContain('shareat ALL=(root) NOPASSWD: /usr/bin/systemctl restart shareat-pos.service');
    expect(sh).toContain('shareat ALL=(root) NOPASSWD: /usr/bin/systemctl restart shareat-erp.service');
  });

  it('provision.sh writes the pos2.shareat.net Caddy block to 127.0.0.1:9009 and creates pos.log owned by shareat. Mutant: block or log missing', () => {
    const sh = readFileSync(path.join(repoRoot, 'docs', 'ops', 'provision.sh'), 'utf8');
    expect(sh).toMatch(/pos2\.shareat\.net \{[\s\S]*reverse_proxy 127\.0\.0\.1:9009/);
    expect(sh).toContain('chown shareat:shareat /var/log/shareat/pos.log');
  });
});

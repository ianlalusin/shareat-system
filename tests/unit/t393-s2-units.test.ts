import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * T-393 S2 - the restore-drill units, the "not armed by anything" guarantee, and the short runbook.
 * `docs/tasks/393-nightly-backup-and-restore.md` Units, R8, R14 and the S2 file list. Written TESTER-FIRST: red
 * until the builder adds `docs/ops/shareat-restore-drill.{service,timer}`, the provision.sh skip and the README
 * section.
 */
const root = path.resolve(__dirname, '..', '..');
const ops = (f: string) => path.join(root, 'docs', 'ops', f);
const read = (f: string) => readFileSync(f, 'utf8');

describe('T-393 S2 - shareat-restore-drill units', () => {
  it('both units exist', () => {
    expect(existsSync(ops('shareat-restore-drill.service'))).toBe(true);
    expect(existsSync(ops('shareat-restore-drill.timer'))).toBe(true);
  });

  it('the timer fires Sunday 05:30 Asia/Manila, Persistent, and installs into timers.target', () => {
    const t = read(ops('shareat-restore-drill.timer'));
    expect(t).toMatch(/^OnCalendar=Sun \*-\*-\* 05:30:00 Asia\/Manila\s*$/m);
    expect(t).toMatch(/^Persistent=true\s*$/m);
    expect(t).toMatch(/^WantedBy=timers\.target\s*$/m);
  });

  it('the service is the house shape: oneshot as shareat, runs `npm run restore-drill -- --production`, resource-capped', () => {
    const s = read(ops('shareat-restore-drill.service'));
    expect(s).toMatch(/^Type=oneshot\s*$/m);
    expect(s).toMatch(/^User=shareat\s*$/m);
    expect(s).toMatch(/^ExecStart=.*npm run restore-drill -- --production\s*$/m);
    expect(s).toMatch(/^Nice=10\s*$/m);
    expect(s).toMatch(/^IOSchedulingClass=idle\s*$/m);
    expect(s).toMatch(/^MemoryMax=1G\s*$/m);
    expect(s).toMatch(/^TimeoutStartSec=2h\s*$/m);
    expect(s).toMatch(/\/var\/log\/shareat\/restore-drill\.log/);
    expect(s).not.toMatch(/^After=.*postgresql\.service/m); // the database is off-box (ADR-002 s1)
    expect(s).not.toMatch(/\bnext build\b|npm run build/);
  });

  it('the service header says NOT ARMED, and no unit file arms itself by any other route', () => {
    const s = read(ops('shareat-restore-drill.service'));
    expect(s).toMatch(/not armed/i);
    expect(read(ops('shareat-restore-drill.timer'))).not.toMatch(/^(Requires|BindsTo)=/m);
  });
});

describe('T-393 S2 - nothing arms the drill by accident (Ian: not switched on)', () => {
  it('provision.sh skips shareat-restore-drill.timer in its derived enable list, next to db-backup', () => {
    const p = read(ops('provision.sh'));
    expect(p).toMatch(/shareat-db-backup\.timer/);
    expect(p).toMatch(/shareat-restore-drill\.timer/);
    // The skip is a `continue`, not a mention in a comment.
    expect(p).toMatch(/shareat-restore-drill\.timer\s*\]\s*&&\s*continue/);
  });

  it('provision.sh never runs `systemctl enable` on the drill timer', () => {
    const lines = read(ops('provision.sh')).split('\n').filter((l) => !/^\s*#/.test(l));
    expect(lines.filter((l) => /systemctl\s+enable[^\n]*restore-drill/.test(l))).toEqual([]);
  });

  it('README: every arm-all loop skips the drill timer too, and the drill has its own "switching on" step', () => {
    const r = read(ops('README.md'));
    expect(r).toMatch(/shareat-restore-drill\.timer/);
    expect(r).toMatch(/enable --now shareat-restore-drill\.timer/);
  });
});

describe('T-393 S2 - "Restoring for real" runbook (fifteen lines or fewer)', () => {
  const r = read(ops('README.md'));
  const m = /^#{2,3} Restoring for real[^\n]*\n([\s\S]*?)(?=^#{1,3} |(?![\s\S]))/m.exec(r);

  it('the section exists', () => {
    expect(m, 'docs/ops/README.md has no "Restoring for real" heading').not.toBeNull();
  });

  it('is fifteen non-blank lines or fewer', () => {
    const body = (m?.[1] ?? '').split('\n').filter((l) => l.trim() !== '');
    expect(body.length).toBeGreaterThan(4);
    expect(body.length).toBeLessThanOrEqual(15);
  });

  it('covers: which dump, the roles file replay then passwords by hand, the pg_restore flags, grants (T-355), env, verify with the drill', () => {
    const b = m?.[1] ?? '';
    expect(b).toMatch(/manifest/i);
    expect(b).toMatch(/\.roles\.sql/);
    expect(b).toMatch(/password/i);
    expect(b).toMatch(/--no-owner/);
    expect(b).toMatch(/--no-acl/);
    expect(b).toMatch(/--exit-on-error/);
    expect(b).toMatch(/--single-transaction/);
    expect(b).toMatch(/shareat_app_prod/);
    expect(b).toMatch(/T-355|default privileges/i);
    expect(b).toMatch(/SYSTEM_DATABASE_URL|DATABASE_URL/);
    expect(b).toMatch(/restore-drill/);
  });
});

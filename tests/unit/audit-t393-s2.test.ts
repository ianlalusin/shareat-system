import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * T-393 S2 audit legs (round 2), text-level: every arm/enable loop skips BOTH backup timers (scanned generically,
 * not by line number), .env.example carries the drill variables, and the "Restoring for real" runbook says the
 * dangerous things plainly. Written TESTER-FIRST.
 */
const root = path.resolve(__dirname, '..', '..');
const read = (...p: string[]) => readFileSync(path.join(root, ...p), 'utf8');

/** Every place a loop walks the shareat timers: the glob `shareat-*.timer` (or `shareat-*.service`'s arming sibling). */
function loopWindows(text: string): { line: number; window: string }[] {
  const lines = text.split('\n');
  const out: { line: number; window: string }[] = [];
  lines.forEach((l, i) => {
    if (/for\s+\w+\s+in\b[^\n]*shareat-\*\.timer/.test(l)) {
      out.push({ line: i + 1, window: lines.slice(i, i + 9).join('\n') });
    }
  });
  return out;
}

describe('T-393 S2 audit - every arm/enable loop skips both backup timers', () => {
  for (const file of [['docs', 'ops', 'README.md'], ['docs', 'ops', 'provision.sh']]) {
    const name = file.join('/');
    it(`${name}: finds the loops at all (a scan of nothing must not pass)`, () => {
      expect(loopWindows(read(...file)).length).toBeGreaterThan(0);
    });
    it(`${name}: every "for f in ...shareat-*.timer" loop that arms or runs units skips db-backup AND restore-drill with a continue`, () => {
      const bad: string[] = [];
      for (const { line, window } of loopWindows(read(...file))) {
        const arms = /systemctl\s+(enable|start)|echo[^\n]*systemctl enable/.test(window);
        if (!arms) continue; // a loop that only lists is harmless
        for (const unit of ['db-backup', 'restore-drill']) {
          const skipped = window.split('\n').some((l) => l.includes(unit) && /continue/.test(l));
          if (!skipped) bad.push(`${name}:${line} loop does not skip shareat-${unit} with a continue`);
        }
      }
      expect(bad).toEqual([]);
    });
  }
});

describe('T-393 S2 audit - .env.example', () => {
  const env = read('.env.example');
  for (const v of ['RESTORE_DRILL_DATABASE_URL', 'RESTORE_DRILL_MAINTENANCE_DB', 'DRILL_HEARTBEAT_URL']) {
    it(`contains ${v}`, () => {
      expect(env).toMatch(new RegExp(`^#?\\s*${v}=`, 'm'));
    });
  }
});

describe('T-393 S2 audit - "Restoring for real" is safe to follow at 3 a.m.', () => {
  const r = read('docs', 'ops', 'README.md');
  const m = /^#{2,3} Restoring for real[^\n]*\n([\s\S]*?)(?=^#{1,3} |(?![\s\S]))/m.exec(r);
  const b = m?.[1] ?? '';

  it('the section exists and is still fifteen non-blank lines or fewer', () => {
    expect(m).not.toBeNull();
    expect(b.split('\n').filter((l) => l.trim() !== '').length).toBeLessThanOrEqual(15);
  });
  it('says never to restore over the live database: not the database SYSTEM_DATABASE_URL points at, and never --clean', () => {
    expect(b).toMatch(/never[^\n]*(over|onto|into)[^\n]*(live|current|running|production)/i);
    expect(b).toMatch(/never[^\n]*SYSTEM_DATABASE_URL|SYSTEM_DATABASE_URL[^\n]*never/i);
    expect(b).toMatch(/never[^\n]*--clean|--clean[^\n]*never/i);
  });
  it('has a sha256sum command to check the dump against the manifest', () => {
    expect(b).toMatch(/sha256sum\s+\S+/);
  });
  it('has a fingerprint compare step against the NEW database', () => {
    expect(b).toMatch(/fingerprint/i);
    expect(b).toMatch(/(new|restored)\s+(database|db)/i);
  });
});

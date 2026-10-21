/**
 * T-436 S3/S4 - the screens are wired to the domain and do not leak. Source-text guards (the same technique as
 * `readiness-remedy-routes.test.ts`): importing the pages would drag in `@shareat/auth` and a database.
 *
 * RED REASON today: `apps/erp/src/app/attendance/leave/` and the settings leave section do not exist.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const appSrc = resolve(here, '..', 'src', 'app');
const attendanceDir = join(appSrc, 'attendance');
const leaveDir = join(attendanceDir, 'leave');
const settingsDir = join(appSrc, 'settings', 'attendance');

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? sourceFiles(p) : /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}
const read = (p: string) => readFileSync(p, 'utf8');

describe('T-436 - the leave screens exist and call the domain', () => {
  it('attendance/leave has a page and an actions file; the actions call the request/approve/reject/cancel/void/record functions', () => {
    expect(existsSync(join(leaveDir, 'page.tsx')), 'attendance/leave/page.tsx').toBe(true);
    const actions = sourceFiles(leaveDir).filter((p) => /actions\.ts$/.test(p));
    expect(actions.length).toBeGreaterThan(0);
    const text = actions.map(read).join('\n');
    for (const fn of ['requestLeave', 'approveLeave', 'rejectLeave', 'cancelLeave', 'voidLeave', 'recordLeave']) {
      expect(text, fn).toContain(fn);
    }
    expect(text).toMatch(/from '@shareat\/domain'/);
  });

  it('the settings page manages leave kinds and caps through the domain (setLeaveCap)', () => {
    const text = sourceFiles(settingsDir).map(read).join('\n');
    expect(text).toContain('setLeaveCap');
  });

  it('the attendance grid renders a Paid / Unpaid badge and a clash flag', () => {
    const text = sourceFiles(attendanceDir).map(read).join('\n');
    expect(text).toContain('leaveGrid');
    expect(text).toMatch(/Unpaid/);
    expect(text).toMatch(/\bPaid\b/);
    expect(text).toMatch(/clash/i);
  });
});

describe('T-436 - the screens never put the note or the proof file where everyone can see it', () => {
  it('the grid / list / export code does not read `.note`, and nothing outside the detail view reads the proof file id', () => {
    const files = sourceFiles(attendanceDir).filter((p) => !/[\\/]lane[\\/]|terminals|\[dayId\]/.test(p));
    const listy = files.filter((p) => /grid|list|export|csv/i.test(p));
    for (const p of listy) {
      expect(read(p), `${p} must not read the request note`).not.toMatch(/\.note\b|\bnote:/);
    }
    for (const p of files) {
      expect(read(p), `${p} must not expose a proof file id`).not.toMatch(/proofFileId|documentFileId|fileId.*leave|leave.*fileId/);
    }
  });

  it('the proof is opened only through the openLeaveDocument action (no direct /files link built from an id)', () => {
    const text = sourceFiles(leaveDir).map(read).join('\n');
    expect(text).not.toMatch(/\/files\/\$\{/);
    expect(text).not.toMatch(/readFileUrl/);
  });
});

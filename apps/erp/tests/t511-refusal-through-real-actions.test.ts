import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T-511 (BOSS-approved fix, 2026-11-04) - the REAL server actions, run with no database: a settlement refusal (hostile zip) and a leave refusal reach the
 * screen as their own plain sentence. Mocked: the session, the transaction wrapper (hands the callback an empty tx), the flash, and the capability read.
 * Not mocked: the action bodies, `ingestSettlementFile` up to its first read (the zip is refused before any query), `errorMessage`.
 */
const redirectWithFlash = vi.fn(async (..._a: unknown[]): Promise<never> => {
  throw new Error('redirected');
});
const requestLeave = vi.fn();

vi.mock('@shareat/auth', async (orig) => ({
  ...(await orig<object>()),
  heldCapabilities: vi.fn(async () => new Set(['upload_settlement_files'])),
}));
vi.mock('@/lib/flash', () => ({ redirectWithFlash: (...a: unknown[]) => redirectWithFlash(...a) }));
vi.mock('../src/lib/session', () => ({
  requireActor: vi.fn(async () => ({ orgId: 'org-1', personId: 'p1' })),
  requireSession: vi.fn(async () => ({ actor: { orgId: 'org-1', personId: 'p1' } })),
}));
vi.mock('../src/app/channel-settlements/lib', () => ({
  withOrgPrincipal: vi.fn(async (_o: string, fn: (tx: unknown) => Promise<unknown>) => fn({})),
}));
vi.mock('../src/app/attendance/leave/lib', async (orig) => ({
  ...(await orig<object>()),
  withOrgPrincipal: vi.fn(async (_o: string, fn: (tx: unknown) => Promise<unknown>) => fn({})),
}));
vi.mock('@shareat/domain', async (orig) => ({
  ...(await orig<typeof import('@shareat/domain')>()),
  requestLeave: (...a: unknown[]) => requestLeave(...a),
}));

const FIXTURES = resolve(__dirname, '..', '..', '..', 'packages', 'domain', 'tests', 'fixtures', 'settlement-intake');
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function uploadOf(name: string): FormData {
  const fd = new FormData();
  fd.set('files', new File([readFileSync(join(FIXTURES, name))], name, { type: 'application/zip' }));
  return fd;
}

beforeAll(async () => {
  await import('../src/app/channel-settlements/upload/actions');
  await import('../src/app/attendance/leave/actions');
}, 60_000);
beforeEach(() => {
  redirectWithFlash.mockClear();
});

describe('uploadSettlementFilesAction: a hostile zip is refused in plain words', () => {
  for (const [file, sentence] of [
    ['hostile-zip-nested-archive.zip', /zip/i],
    ['hostile-zip-path-traversal.zip', /zip|name|file/i],
  ] as const) {
    it(`${file}: its own sentence, no database text, no id`, async () => {
      const { uploadSettlementFilesAction } = await import('../src/app/channel-settlements/upload/actions');
      const report = await uploadSettlementFilesAction(uploadOf(file));
      expect(report.ok).toBe(true);
      if (!report.ok) return;
      const line = report.lines[0]!;
      expect(line.ok).toBe(false);
      expect(line.message).not.toMatch(/database/i);
      expect(line.message).not.toMatch(UUID);
      expect(line.message).toMatch(sentence);
    });
  }
});

describe('requestLeaveAction: a leave refusal shows its own sentence', () => {
  it('the flash carries the refusal sentence, not the database one', async () => {
    const { leaveRefusal } = await import('@shareat/domain');
    requestLeave.mockRejectedValueOnce(leaveRefusal('LEAVE_NO_DAYS', 'Pick at least one day of leave.'));
    const { requestLeaveAction } = await import('../src/app/attendance/leave/actions');
    const fd = new FormData();
    fd.set('employmentId', 'e1');
    fd.set('leaveType', 'sick');
    fd.set('from', '2026-11-03');
    await requestLeaveAction(fd).catch(() => undefined);
    const flash = redirectWithFlash.mock.calls[0]?.[2] as { error?: string } | undefined;
    expect(flash?.error).toBe('Pick at least one day of leave.');
  });
});

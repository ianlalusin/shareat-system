/**
 * T-396 S2 row 6 - `scripts/pos-day-import.ts` pings a dead-man's-switch URL after each run.
 *
 * TESTER. The script runs `main()` at import and calls `process.exit`, so each case re-imports it fresh with the sweep, dotenv,
 * the db handle, `fetch`, `process.exit` and the console all faked. Nothing touches a network or a database.
 *
 * ASSUMED CONTRACT for the builder:
 *  - The URL is `process.env.POS_IMPORT_HEARTBEAT_URL`, populated by `dotenv.config({ path: '.env.local' })` (faked here).
 *  - Clean run (notices are not failures): ONE `fetch` to exactly that URL. Failed run (`hadFailures` or an outright `error`):
 *    ONE `fetch` to `<url>/fail`, body holding the failure lines (store, date, sentence). Never both.
 *  - The ping is awaited BEFORE `process.exit`. A rejecting `fetch` changes neither the exit code (0 clean / 1 failed) nor leaks.
 *  - Unset URL: no `fetch` at all, exactly ONE console line that mentions "heartbeat", exit code unchanged.
 *  - The URL (it carries a secret token) never appears in anything written to stdout/stderr/console - including a fetch error.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SECRET = 'https://hc.example.test/ping/3f9a-SECRET-TOKEN-8c21';

interface FakeOutcome {
  orgId: string;
  orgName: string;
  job: 'pos_day_import';
  period: string;
  posted: number;
  skipped: number;
  failed: number;
  failures: unknown[];
  error?: string;
}

const BASE: FakeOutcome = { orgId: 'o1', orgName: 'SharEat', job: 'pos_day_import', period: '2026-10', posted: 2, skipped: 0, failed: 0, failures: [] };
const CLEAN = { outcomes: [BASE], hadFailures: false };
const LINE = { subjectId: 's1', subjectName: 'SharEat A, 14 Oct', reason: 'POS took Maya but no wallet is set up for it.' };
const FAILED = { outcomes: [{ ...BASE, posted: 1, failed: 1, failures: [LINE] }], hadFailures: true };

let sweep: ReturnType<typeof vi.fn>;
let fetchMock: ReturnType<typeof vi.fn>;
let written: string[];

beforeEach(() => {
  vi.resetModules();
  written = [];
  const sink = (...a: unknown[]) => void written.push(a.map((x) => (typeof x === 'string' ? x : String((x as Error)?.stack ?? x))).join(' '));
  for (const m of ['log', 'error', 'warn', 'info', 'debug'] as const) vi.spyOn(console, m).mockImplementation(sink);
  vi.spyOn(process.stdout, 'write').mockImplementation(((s: unknown) => (sink(String(s)), true)) as never);
  vi.spyOn(process.stderr, 'write').mockImplementation(((s: unknown) => (sink(String(s)), true)) as never);
  fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => '' }));
  vi.stubGlobal('fetch', fetchMock);
  sweep = vi.fn();
  vi.doMock('@shareat/domain', () => ({ posDayImportSweep: sweep }));
  vi.doMock('@shareat/db', () => ({ closeDb: async () => undefined }));
  process.argv = ['node', 'pos-day-import.ts'];
  delete process.env['POS_IMPORT_HEARTBEAT_URL'];
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.doUnmock('@shareat/domain');
  vi.doUnmock('@shareat/db');
  vi.doUnmock('dotenv');
  delete process.env['POS_IMPORT_HEARTBEAT_URL'];
});

/** Runs the script once; resolves to the exit code and the `fetch` calls as they stood AT exit (so the ping must be awaited first). */
async function run(result: unknown, opts: { url?: string; fetchThrows?: Error } = {}) {
  sweep.mockResolvedValue(result);
  if (opts.fetchThrows) fetchMock.mockRejectedValue(opts.fetchThrows);
  vi.doMock('dotenv', () => ({
    config: () => {
      if (opts.url) process.env['POS_IMPORT_HEARTBEAT_URL'] = opts.url;
    },
  }));
  let atExit: unknown[][] = [];
  const exited = new Promise<number>((resolve) => {
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      atExit = fetchMock.mock.calls.map((c) => [...c]);
      resolve(code ?? 0);
    }) as never);
  });
  await import('../../scripts/pos-day-import');
  const code = await exited;
  return { code, calls: atExit };
}
const urlOf = (c: unknown[]) => String(c[0]);
const bodyOf = (c: unknown[]) => String((c[1] as { body?: unknown } | undefined)?.body);

describe('S2-6 the heartbeat ping', () => {
  it('a failed run pings <url>/fail once with the failure lines, never the ok URL - kills: pings ok on a failed run', async () => {
    const { code, calls } = await run(FAILED, { url: SECRET });
    expect(code).toBe(1);
    expect(calls.map(urlOf)).toEqual([`${SECRET}/fail`]);
    expect(bodyOf(calls[0]!)).toContain('SharEat A, 14 Oct');
    expect(bodyOf(calls[0]!)).toContain('no wallet is set up for it');
  });

  it('an outright org failure also pings /fail - kills: ignores o.error', async () => {
    const r = { outcomes: [{ ...BASE, posted: 0, error: 'db is down' }], hadFailures: true };
    const { code, calls } = await run(r, { url: SECRET });
    expect(code).toBe(1);
    expect(calls.map(urlOf)).toEqual([`${SECRET}/fail`]);
  });

  it('a clean run pings the ok URL once; notices are not failures - kills: pings /fail on notices / skips the ok ping', async () => {
    const withNotice = { outcomes: [{ ...BASE, failures: [{ ...LINE, kind: 'notice' }] }], hadFailures: false };
    const { code, calls } = await run(withNotice, { url: SECRET });
    expect(code).toBe(0);
    expect(calls.map(urlOf)).toEqual([SECRET]);
  });

  it('unset URL: no request, one heartbeat line, exit code unchanged either way - kills: crashes / nags per org / changes the exit code', async () => {
    const clean = await run(CLEAN);
    expect(clean.code).toBe(0);
    expect(clean.calls).toEqual([]);
    expect(written.filter((l) => /heartbeat/i.test(l))).toHaveLength(1);

    vi.resetModules();
    written.length = 0;
    const failed = await run(FAILED);
    expect(failed.code).toBe(1);
    expect(failed.calls).toEqual([]);
    expect(written.filter((l) => /heartbeat/i.test(l))).toHaveLength(1);
  });

  it('the configured URL never reaches the console or stdout/stderr, on ok, on fail, or when fetch throws with it in the message - kills: prints the secret', async () => {
    await run(CLEAN, { url: SECRET });
    vi.resetModules();
    await run(FAILED, { url: SECRET });
    vi.resetModules();
    const boom = await run(CLEAN, { url: SECRET, fetchThrows: new Error(`connect ECONNREFUSED ${SECRET}`) });
    expect(boom.code).toBe(0);
    const out = written.join('\n');
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain('SECRET-TOKEN');
  });

  it('a failed ping on a failed run still exits 1 - kills: exit code follows the ping', async () => {
    const { code } = await run(FAILED, { url: SECRET, fetchThrows: new Error('network down') });
    expect(code).toBe(1);
  });
});

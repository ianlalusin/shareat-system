/**
 * T-497 S2 / DEF-795 — a drill whose required report cannot be saved must FAIL, not signal success.
 * Unit only: a fake object store, a fake heartbeat, no Postgres, no network.
 */
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Heartbeat } from '../../scripts/lib/backup/heartbeat';
import type { ObjectStore } from '../../scripts/lib/backup/object-store';
import { drillExitCode, settleDrill, type DrillResult, type SettleInput } from '../../scripts/lib/backup/run-drill';

const REPORT_KEY = 'postgres/drills/2026-10-28.json';
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 't497s2-'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

function fakeStore(rejectReport: boolean) {
  const puts: string[] = [];
  const store: ObjectStore = {
    put: async (key) => {
      puts.push(key);
      if (rejectReport && key === REPORT_KEY) throw new Error('403 AccessDenied (token secret-xyz)');
    },
    head: async () => null,
    list: async () => [],
    get: async () => {},
    delete: async () => {},
  };
  return { store, puts };
}

function build(opts: { rejectReport: boolean; mismatches?: string[]; failure?: Error; beatThrows?: boolean }) {
  const { store, puts } = fakeStore(opts.rejectReport);
  const beats: string[] = [];
  const heartbeat: Heartbeat = {
    start: async () => {},
    ok: async () => {
      beats.push('ok');
      if (opts.beatThrows) throw new Error('beat down');
    },
    fail: async (r) => {
      beats.push(`fail:${r}`);
      if (opts.beatThrows) throw new Error('beat down');
    },
  };
  const local = path.join(dir, 'drill-report.json');
  const files = [local];
  const mismatches = opts.mismatches ?? [];
  const durations = { downloadMs: 11, restoreMs: 22, checkMs: 33 };
  const result: DrillResult | undefined = opts.failure
    ? undefined
    : { ok: mismatches.length === 0, dumpKey: 'postgres/daily/d.dump', reportKey: null, mismatches, restoredBytes: 123, durations };
  const input: SettleInput = {
    result,
    failure: opts.failure,
    target: 'shareat_restore_drill',
    refusedUpFront: false,
    reportKey: REPORT_KEY,
    dumpKey: 'postgres/daily/d.dump',
    durations,
    files,
    clean: (s) => s.replace(/secret-xyz/g, '***'),
    log: () => {},
    writeReport: async () => {
      try {
        await writeFile(local, '{}');
        await store.put(REPORT_KEY, local, {});
        return null;
      } catch (e) {
        return (e as Error).message.replace(/secret-xyz/g, '***');
      }
    },
    safeBeat: async (what, reason) => {
      try {
        if (what === 'fail') await heartbeat.fail(reason ?? 'failed');
        else await heartbeat[what]();
      } catch {
        /* best-effort, as in runDrill */
      }
    },
  };
  return { input, beats, puts, local };
}

describe('T-497 S2 / DEF-795 drill report persistence', () => {
  it('happy path: report saved, ok:true, ok heartbeat, reportKey set, exit 0', async () => {
    const t = build({ rejectReport: false });
    const r = await settleDrill(t.input);
    expect(r.ok).toBe(true);
    expect(r.reportKey).toBe(REPORT_KEY);
    expect(r.error).toBeUndefined();
    expect(t.beats).toEqual(['ok']);
    expect(drillExitCode(r)).toBe(0);
  });

  it('restore passed but the report cannot be saved: ok:false, failure heartbeat naming the report, data check kept, exit 1', async () => {
    const t = build({ rejectReport: true });
    const r = await settleDrill(t.input);
    expect(r.ok).toBe(false);
    expect(r.reportKey).toBeNull();
    expect(r.mismatches).toEqual([]);
    expect(r.durations).toEqual({ downloadMs: 11, restoreMs: 22, checkMs: 33 });
    expect(r.restoredBytes).toBe(123);
    expect(r.error).toContain('restore checks passed but the drill report could not be saved');
    expect(r.error).toContain('AccessDenied');
    expect(r.error).not.toContain('secret-xyz');
    expect(t.beats).toHaveLength(1);
    expect(t.beats[0]).toMatch(/^fail:restore checks passed but the drill report could not be saved: /);
    expect(drillExitCode(r)).toBe(1);
  });

  it('data mismatch AND report save failure: stays failed, mismatches kept, the failure names both', async () => {
    const t = build({ rejectReport: true, mismatches: ['trial balance differs'] });
    const r = await settleDrill(t.input);
    expect(r.ok).toBe(false);
    expect(r.mismatches).toEqual(['trial balance differs']);
    expect(t.beats).toHaveLength(1);
    expect(t.beats[0]).toContain('trial balance differs');
    expect(t.beats[0]).toContain('drill report could not be saved');
    expect(drillExitCode(r)).toBe(1);
  });

  it('operational failure AND report save failure: still rejects, naming both reasons; failure heartbeat sent', async () => {
    const t = build({ rejectReport: true, failure: new Error('pg_restore exited 1') });
    await expect(settleDrill(t.input)).rejects.toThrow(/pg_restore exited 1; the drill report could not be saved: .*AccessDenied/);
    expect(t.beats).toHaveLength(1);
    expect(t.beats[0]).toMatch(/^fail:pg_restore exited 1; the drill report could not be saved/);
  });

  it('operational failure with a savable report: message unchanged', async () => {
    const t = build({ rejectReport: false, failure: new Error('no complete dump in the store') });
    await expect(settleDrill(t.input)).rejects.toThrow(/^no complete dump in the store$/);
    expect(t.puts).toEqual([REPORT_KEY]);
  });

  it('heartbeat delivery stays best-effort: a dead heartbeat does not change the outcome', async () => {
    const t = build({ rejectReport: true, beatThrows: true });
    const r = await settleDrill(t.input);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('drill report could not be saved');
  });

  it('cleanup still runs: local temp files are removed even when the report save fails', async () => {
    const t = build({ rejectReport: true });
    await settleDrill(t.input);
    expect(existsSync(t.local)).toBe(false);
  });
});

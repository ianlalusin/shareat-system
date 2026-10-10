import { describe, expect, it } from 'vitest';
import { planPrune } from '../../scripts/lib/backup/retention';

/**
 * T-393 S1 - the pure retention planner. `docs/tasks/393-nightly-backup-and-restore.md` R5, I2-I5, tests 1-6.
 * Written TESTER-FIRST: red with "Cannot find module scripts/lib/backup/retention" until the builder lands it.
 *
 * Key shape is the I5 form: `postgres/daily/<YYYY-MM-DD>/shareat-<YYYYMMDD>T<HHMMSS>Z.dump` and, beside it,
 * `...Z.manifest.json` (a dump is COMPLETE only when its manifest key exists, I2). `planPrune(keys, todayManila)`
 * is pure; the caller deletes whatever lands in `delete`.
 *
 * The planner caps a run at 10 dumps (I4), so a test that needs an EXACT delete set keeps its eligible set under 10.
 * Where the spec's own example would collide with the cap (test 1: 60 dailies leave 23 eligible), the exact-set check
 * uses 45 dailies and the 60-daily case checks the protected set and the cap instead. Said plainly in the hand-back.
 */

const TODAY = '2026-10-10';
const DAY_MS = 86_400_000;
const addDays = (ymd: string, n: number): string =>
  new Date(Date.parse(`${ymd}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const stamp = (d: string) => `${d.replace(/-/g, '')}T193000Z`;
const dumpKey = (d: string) => `postgres/daily/${d}/shareat-${stamp(d)}.dump`;
const manifestKey = (d: string) => `postgres/daily/${d}/shareat-${stamp(d)}.manifest.json`;
const rolesKey = (d: string) => `postgres/daily/${d}/shareat-${stamp(d)}.roles.sql`;
const complete = (d: string) => [dumpKey(d), manifestKey(d), rolesKey(d)];
const completeAll = (dates: string[]) => dates.flatMap(complete);
const bare = (d: string) => [dumpKey(d)];

const I5 = /^postgres\/daily\/\d{4}-\d{2}-\d{2}\/shareat-\d{8}T\d{6}Z\.(dump|manifest\.json|roles\.sql)$/;

/** The dates of every dump (`.dump` key) in a key list. */
const datesOf = (keys: string[]): string[] =>
  keys
    .filter((k) => k.endsWith('.dump'))
    .map((k) => /postgres\/daily\/(\d{4}-\d{2}-\d{2})\//.exec(k)?.[1] ?? k)
    .sort();

const range = (endYmd: string, count: number): string[] =>
  Array.from({ length: count }, (_, i) => addDays(endYmd, -i)).sort();

describe('T-393 S1 - retention planPrune', () => {
  it('1a. 45 dailies: keeps the last 35 and the earliest of each older month, deletes the rest (exact set)', () => {
    // ages 0..44 = 2026-08-27 .. 2026-10-10. Older than 35 days: Aug 27-31 and Sep 1-5.
    // Protected: ages 0..34, the earliest of August (Aug 27) and the earliest of September (Sep 1).
    const dates = range(TODAY, 45);
    const plan = planPrune(completeAll(dates), TODAY);
    expect(datesOf(plan.delete)).toEqual([
      '2026-08-28', '2026-08-29', '2026-08-30', '2026-08-31',
      '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05',
    ]);
    // Each deleted dump goes WITH its manifest (I4: "each with its manifest").
    for (const d of datesOf(plan.delete)) {
      expect(plan.delete).toContain(manifestKey(d));
      expect(plan.delete).toContain(rolesKey(d)); // a pruned stem takes its roles file too
    }
    // Age 34 (2026-09-06) is the 35th daily and survives; age 35 (2026-09-05) does not. Kills `>` for `>=`.
    expect(plan.delete).not.toContain(dumpKey('2026-09-06'));
    expect(plan.delete).toContain(dumpKey('2026-09-05'));
  });

  it('1b. 60 dailies: the protected set is never deleted and the run is capped at 10 dumps', () => {
    const dates = range(TODAY, 60); // 2026-08-12 .. 2026-10-10
    const plan = planPrune(completeAll(dates), TODAY);
    const deleted = datesOf(plan.delete);
    const protectedDates = [
      ...range(TODAY, 35), // the last 35 days, ages 0..34
      '2026-08-12', // earliest of August in the set
      '2026-09-01', // earliest of September
    ];
    for (const d of protectedDates) expect(deleted, `${d} must be kept`).not.toContain(d);
    // 60 - 37 protected = 23 eligible, so the cap is what binds.
    expect(deleted).toHaveLength(10);
    for (const d of deleted) expect(dates).toContain(d);
  });

  it('2. three years of dailies thinned: one per month for 13 months, the earliest of EACH year forever', () => {
    // Sparse on purpose: the whole eligible set stays under the 10-dump cap, so the delete set is exact.
    const dates = [
      '2023-10-11', '2023-12-20', // 2023: earliest kept (yearly tier), later one is eligible
      '2024-01-05', '2024-01-20', '2024-06-03', // 2024: earliest kept; June 2024 is outside 13 months and not a year-earliest
      '2025-01-02', '2025-01-15', // 2025: earliest kept
      '2025-11-04', '2025-11-20', // Nov 2025 is inside the 13-month window: the earliest is kept, the second is eligible
      '2026-01-03', '2026-01-20', // 2026 earliest = Jan 3
      '2026-09-20', // inside the last 35 days
      ...range(TODAY, 7),
    ];
    const plan = planPrune(completeAll(dates), TODAY);
    expect(datesOf(plan.delete)).toEqual([
      '2023-12-20', '2024-01-20', '2024-06-03', '2025-01-15', '2025-11-20', '2026-01-20',
    ]);
    // The yearly keepers specifically (kills "yearly tier dropped").
    for (const d of ['2023-10-11', '2024-01-05', '2025-01-02', '2026-01-03']) {
      expect(plan.delete, `${d} is the earliest of its year and must survive forever`).not.toContain(dumpKey(d));
    }
  });

  it('3. a dump with no manifest is not complete: not kept as one, not counted toward the floor, deleted only once 2+ days old', () => {
    // 8 complete dumps in July 2026 (Jul 2 is the earliest complete one). Floor 7 => at most ONE may be deleted.
    const july = Array.from({ length: 8 }, (_, i) => `2026-07-${String(2 + i).padStart(2, '0')}`);
    const bareOld = ['2026-07-01', '2026-06-10', '2026-06-11', '2026-06-12', '2026-09-01']; // all >= 2 days old
    const bareYoung = ['2026-10-09', '2026-10-10']; // age 1 and 0: a night still in progress / just crashed
    const keys = [...completeAll(july), ...bareOld.flatMap(bare), ...bareYoung.flatMap(bare)];
    const plan = planPrune(keys, TODAY);

    const deletedDumps = datesOf(plan.delete);
    // (a) old orphans go; young orphans stay.
    for (const d of bareOld) expect(deletedDumps, `old orphan ${d} should be deleted`).toContain(d);
    for (const d of bareYoung) expect(deletedDumps, `young orphan ${d} must not be deleted yet`).not.toContain(d);
    // (b) the bare Jul 1 dump must not stand in as "the earliest of July": Jul 2 (earliest COMPLETE) survives.
    expect(plan.delete).not.toContain(dumpKey('2026-07-02'));
    // (c) the floor counts COMPLETE dumps only: 8 complete, floor 7 => at most 1 complete dump deleted.
    const completeDeleted = deletedDumps.filter((d) => july.includes(d));
    expect(completeDeleted.length).toBeLessThanOrEqual(1);
  });

  it('4. 200 eligible old dumps: at most 10 dumps are deleted in one run', () => {
    const old = Array.from({ length: 200 }, (_, i) => addDays('2025-02-01', i)); // Feb-Aug 2025: beyond the monthly window
    const dates = [...old, ...range(TODAY, 8)];
    const plan = planPrune(completeAll(dates), TODAY);
    const deleted = datesOf(plan.delete);
    expect(deleted).toHaveLength(10);
    expect(plan.delete.length).toBeLessThanOrEqual(30); // 10 stems x (dump + manifest + roles)
    expect(deleted).not.toContain('2025-02-01'); // the earliest of 2025 stays forever
  });

  it('5. "today" ten years ahead (a clock bug) still leaves at least 7 complete dumps', () => {
    const dates = Array.from({ length: 12 }, (_, i) => addDays('2026-09-20', i));
    const plan = planPrune(completeAll(dates), '2036-10-10');
    const remaining = dates.length - datesOf(plan.delete).length;
    expect(remaining).toBeGreaterThanOrEqual(7);
  });

  it('6. pinned, Frappe-looking, malformed and drill keys are never in delete (full I5 regex, not a prefix test)', () => {
    const junk = [
      'postgres/pinned/2026-10-09/shareat-20261009T000000Z.dump',
      'postgres/pinned/2026-10-09/shareat-20261009T000000Z.manifest.json',
      'postgres/pinned/2026-10-09/shareat-20261009T000000Z.roles.sql',
      'postgres/daily/2020-01-01/shareat-20200101T000000Z.roles.sql.bak',
      'postgres/pinned/cutover-eve.dump',
      'backups/site-20240101_000000-shareat-database.sql.gz',
      'backups/site-20240101_000000-shareat-files.tar.gz',
      'postgres/daily/24-1-1/shareat-20240101T000000Z.dump', // malformed date directory
      'postgres/daily/2020-01-01/shareat-2020.dump', // malformed stamp
      'postgres/daily/2020-01-01/other-20200101T000000Z.dump', // wrong file stem
      'postgres/daily/2020-01-01/shareat-20200101T000000Z.dump.partial', // old-looking, wrong suffix
      'postgres/daily/2020-01-01/shareat-20200101T000000Z.dump.tmp',
      'postgres/daily/notes.txt',
      'postgres/drills/2020-01-01.json',
      'postgres/drills/2026-10-04.json',
    ];
    const eligibleOld = Array.from({ length: 6 }, (_, i) => addDays('2025-03-02', i));
    const dates = [...eligibleOld, '2025-03-01', ...range(TODAY, 8)];
    const plan = planPrune([...junk, ...completeAll(dates)], TODAY);

    // Not vacuous: a legitimate prune does happen alongside the junk.
    expect(datesOf(plan.delete).length).toBeGreaterThan(0);
    for (const k of junk) expect(plan.delete, `${k} must never be deleted`).not.toContain(k);
    for (const k of plan.delete) {
      expect(I5.test(k), `${k} does not match the I5 pattern`).toBe(true);
      expect(k.startsWith('postgres/daily/')).toBe(true);
    }
    // Every pruned stem's roles file goes with it.
    for (const k of plan.delete.filter((x) => x.endsWith('.dump'))) {
      expect(plan.delete).toContain(k.replace(/\.dump$/, '.roles.sql'));
    }
    // Every dump it deletes states a reason.
    for (const k of plan.delete.filter((x) => x.endsWith('.dump'))) {
      expect(typeof plan.reasons[k]).toBe('string');
      expect(plan.reasons[k]!.length).toBeGreaterThan(0);
    }
  });
});

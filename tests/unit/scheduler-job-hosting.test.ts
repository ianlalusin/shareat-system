/**
 * T-273 — DEF-303/DEF-299: nothing compares the scheduler's own job list against the
 * `.service`/`.timer` pairs in `docs/ops/`, so a registered job with nothing to run it is found by
 * eye or not at all. `docs/tasks/273-def-303-job-hosting-guard.md`.
 *
 * ⭐ Two instances of exactly this shape are now on the register: DEF-299 (`sweepOrphanedFiles`,
 * found 2026-09-11) and DEF-303 (`budget_reissue`, found 2026-09-12) — both by a person happening to
 * look, both mechanically detectable from two lists that already exist. This is that comparison,
 * made permanent.
 *
 * ## ⛔ The naming rule in the task spec was wrong, verified against the six that exist, not assumed
 *
 * The spec proposed `shareat-<job with underscores turned to hyphens>.{service,timer}`. It holds for
 * exactly three of the nine `SCHEDULER_JOBS` entries (`attendance_sweep`, `order_wastage_backstop`,
 * `finding_observation`) and breaks for the rest:
 *   - `depreciation` and `amortisation` share ONE script and ONE unit pair, `month-end` — not
 *     `shareat-depreciation.*` / `shareat-amortisation.*`.
 *   - `mirror_publish` and `inbox_relay` share ONE script and ONE unit pair, `firestore-relay`.
 *   - `recurring_expenses`'s unit pair is `recurring-expense-draft` (singular, `-draft` suffix) —
 *     not a literal hyphenation of the job name.
 * So the real rule is: **one unit pair per RUNNER SCRIPT, and a script may cover more than one
 * scheduler job.** `JOB_SCRIPT` below states that correspondence explicitly, because nothing else in
 * the codebase declares it as data — it is implicit in which job names `scheduler/index.ts` and
 * `recurring-expenses/job.ts` pass to `runJobForOrg` inside each script's own runner function.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SCHEDULER_JOBS, type SchedulerJob } from '@shareat/db';

const repoRoot = path.resolve(__dirname, '..', '..');
const OPS_DIR = path.join(repoRoot, 'docs', 'ops');

/**
 * Every scheduler job mapped to the npm script (== `docs/ops/shareat-<script>.*` basename) whose
 * timer is the one thing that runs it.
 *
 * ⭐ **Typed as `Record<SchedulerJob, string>` on purpose.** If `SCHEDULER_JOBS` ever gains a tenth
 * member, this object literal is immediately missing a required key and `npm run typecheck` fails —
 * a second, independent gate alongside the runtime check below (§ "exhaustive against the imported
 * constant"), so losing one does not lose both.
 */
const JOB_SCRIPT: Record<SchedulerJob, string> = {
  depreciation: 'month-end',
  amortisation: 'month-end',
  attendance_sweep: 'attendance-sweep',
  mirror_publish: 'firestore-relay',
  inbox_relay: 'firestore-relay',
  order_wastage_backstop: 'order-wastage-backstop',
  finding_observation: 'finding-observation',
  budget_reissue: 'budget-reissue',
  recurring_expenses: 'recurring-expense-draft',
  orphan_file_sweep: 'orphan-file-sweep',
  // T-276/DEF-305 — the monthly fiscal-period coverage top-up.
  fiscal_period_seed: 'fiscal-period-seed',
  // T-401 S6 audit ruling A1: the next-afternoon auto-post of POS-pull usage drafts.
  usage_auto_post: 'usage-auto-post',
};

/** The unique scripts `JOB_SCRIPT` names — `docs/ops/shareat-<name>.{service,timer}` basenames. */
function knownScripts(): string[] {
  return [...new Set(Object.values(JOB_SCRIPT))].sort();
}

/**
 * `docs/ops/` files that exist and are NOT a job's unit pair, named so invariant 2 (nothing
 * unexplained) does not have to guess at them.
 *
 * - `erp` — `shareat-erp.service` is the ERP web app itself, not a scheduled job. It has no timer,
 *   so it is listed only in the `.service` allowance.
 * - `month-end-retry` — a SECOND timer firing the SAME `shareat-month-end.service` (its own
 *   `[Timer] Unit=shareat-month-end.service` line, not derived from its filename). It has no
 *   `.service` of its own by design (Ian's 03:00 retry, `docs/ops/shareat-month-end-retry.timer`'s
 *   own header) — listed only in the `.timer` allowance.
 */
const NAMED_NON_JOB_SERVICE = ['erp'];
const NAMED_SECONDARY_TIMER_ONLY = ['month-end-retry'];

/**
 * T-393 S1 - platform jobs: a unit pair that runs a script which is NOT a per-org `SCHEDULER_JOBS`
 * entry. `scheduler_runs.org_id` is NOT NULL, so a cluster-wide run (a whole-database dump) cannot be
 * recorded there, and widening it needs a migration (`docs/tasks/393-nightly-backup-and-restore.md`
 * R11). Each entry needs BOTH units and a reason citing a T-/DEF- number. S1 named `db-backup`;
 * S2 adds `restore-drill` with its units.
 */
const NAMED_PLATFORM_JOB: Record<string, string> = {
  'db-backup':
    'T-393: the nightly whole-database pg_dump to Spaces is cluster-wide, so it cannot be a per-org ' +
    'SCHEDULER_JOBS entry (scheduler_runs.org_id is NOT NULL); its run record is the object in Spaces ' +
    'plus its manifest and the heartbeat.',
  'restore-drill':
    'T-393 S2: the weekly restore of the newest complete dump into a scratch database, with the trial-balance ' +
    'tie check, is cluster-wide, so it cannot be a per-org SCHEDULER_JOBS entry (scheduler_runs.org_id is NOT ' +
    'NULL); its run record is the drill report in Spaces and the heartbeat.',
};

/**
 * Scripts with no unit pair today, and why — a confession, not a config knob (same discipline as
 * `tests/unit/scheduler-jobs-have-callers.test.ts`'s `EXEMPT`).
 *
 * ⛔ **DEF-296 is the failure this guard exists to avoid on its OWN exemption list**: a staleness
 * check that could only notice a file being deleted, never that it had been fixed. So this file's
 * own test suite checks BOTH directions — an entry here must currently be true (no units exist) AND
 * an entry NOT here must currently be false (units DO exist) — rather than trusting whoever edits
 * this object to keep it honest.
 */
// ⛔ DEF-303's row lived here until T-272 (2026-09-12) built shareat-budget-reissue.{service,timer}
// alongside DEF-299's own new unit pair — deleted per this file's own "no exemption outlives its
// reason" test below, exactly as T-273's commit message said it would be: "that is the whole point
// of the exemption being a confession rather than a setting."
const EXEMPT_FROM_UNITS: Record<string, string> = {};

function unitBasenames(ext: 'service' | 'timer'): string[] {
  return readdirSync(OPS_DIR)
    .filter((f) => f.endsWith(`.${ext}`))
    .map((f) => f.slice(0, -('.' + ext).length).replace(/^shareat-/, ''));
}

describe('T-273 — every scheduler job is hosted by a docs/ops/ unit pair, or a written exemption', () => {
  it('⭐ finds SCHEDULER_JOBS and docs/ops at all (a scan of nothing must not pass)', () => {
    expect(SCHEDULER_JOBS.length).toBeGreaterThanOrEqual(9);
    expect(readdirSync(OPS_DIR).length).toBeGreaterThan(5);
  });

  it('JOB_SCRIPT is exhaustive against the imported SCHEDULER_JOBS — a runtime check beside the type', () => {
    // ⚠️ Deliberately NOT relying on the `Record<SchedulerJob, string>` annotation alone: that is a
    // typecheck-time gate, this is the `npm run test` gate the spec asks for, so losing one does not
    // silently lose both.
    const jobKeys = Object.keys(JOB_SCRIPT).sort();
    const knownJobs = [...SCHEDULER_JOBS].sort();
    expect(jobKeys).toEqual(knownJobs);
  });

  it('⛔ every non-exempt script has BOTH a .service and a .timer in docs/ops', () => {
    const missing = knownScripts()
      .filter((script) => EXEMPT_FROM_UNITS[script] === undefined)
      .flatMap((script) => {
        const problems: string[] = [];
        if (!existsSync(path.join(OPS_DIR, `shareat-${script}.service`))) {
          problems.push(`shareat-${script}.service is missing`);
        }
        if (!existsSync(path.join(OPS_DIR, `shareat-${script}.timer`))) {
          problems.push(`shareat-${script}.timer is missing`);
        }
        return problems;
      });
    expect(missing).toEqual([]);
  });

  it('⛔ no exemption outlives its reason — a script that IS exempt but now HAS both units must fail', () => {
    // The DEF-296 direction: an exemption that silently keeps reading as "still missing" after the
    // gap it named has actually been closed.
    const stale = Object.keys(EXEMPT_FROM_UNITS)
      .filter((script) => !knownScripts().includes(script) || (
        existsSync(path.join(OPS_DIR, `shareat-${script}.service`)) &&
        existsSync(path.join(OPS_DIR, `shareat-${script}.timer`))
      ))
      .map((script) =>
        !knownScripts().includes(script)
          ? `${script} — exempted but no longer named in JOB_SCRIPT. Delete the row.`
          : `${script} — exempted as having no units, and both now exist. Delete the row; that is ` +
            'the whole point of the exemption being a confession rather than a setting.',
      );
    expect(stale).toEqual([]);
  });

  it('⚠️ every exemption reason cites a defect/task number and says something', () => {
    const weak = Object.entries(EXEMPT_FROM_UNITS)
      .filter(([, reason]) => !/DEF-\d+|T-\d+/.test(reason) || reason.trim().length < 40)
      .map(([script]) => `${script} — the reason must cite a DEF-/T- number and say why`);
    expect(weak).toEqual([]);
  });

  it('⛔ no .service file in docs/ops is unexplained — either a known job script or a named exception', () => {
    const known = new Set([...knownScripts(), ...NAMED_NON_JOB_SERVICE, ...Object.keys(NAMED_PLATFORM_JOB)]);
    const unexplained = unitBasenames('service').filter((name) => !known.has(name));
    expect(unexplained).toEqual([]);
  });

  it('⛔ no .timer file in docs/ops is unexplained — either a known job script or a named exception', () => {
    const known = new Set([...knownScripts(), ...NAMED_SECONDARY_TIMER_ONLY, ...Object.keys(NAMED_PLATFORM_JOB)]);
    const unexplained = unitBasenames('timer').filter((name) => !known.has(name));
    expect(unexplained).toEqual([]);
  });

  it('T-393 S2: the named platform jobs are exactly db-backup and restore-drill and none is a SCHEDULER_JOBS script', () => {
    expect(Object.keys(NAMED_PLATFORM_JOB)).toEqual(['db-backup', 'restore-drill']);
    for (const name of Object.keys(NAMED_PLATFORM_JOB)) {
      expect(knownScripts(), `${name} is a per-org job script; it does not belong in NAMED_PLATFORM_JOB`).not.toContain(name);
    }
  });

  it('T-393 S1: every named platform job has BOTH a .service and a .timer in docs/ops (red until the units exist)', () => {
    const missing = Object.keys(NAMED_PLATFORM_JOB).flatMap((name) => [
      ...(existsSync(path.join(OPS_DIR, `shareat-${name}.service`)) ? [] : [`shareat-${name}.service is missing`]),
      ...(existsSync(path.join(OPS_DIR, `shareat-${name}.timer`)) ? [] : [`shareat-${name}.timer is missing`]),
    ]);
    expect(missing).toEqual([]);
  });

  it('T-393 S1: every named platform job reason cites a T-/DEF- number and says something', () => {
    const weak = Object.entries(NAMED_PLATFORM_JOB)
      .filter(([, reason]) => !/DEF-\d+|T-\d+/.test(reason) || reason.trim().length < 40)
      .map(([name]) => `${name} - the reason must cite a DEF-/T- number and say why`);
    expect(weak).toEqual([]);
  });
});

describe('T-401 S6 A1 - the usage auto-post is a registered, hosted job (red until built)', () => {
  it('usage_auto_post is in SCHEDULER_JOBS (so it writes a scheduler_runs row). Mutant: left out of the registry', () => {
    expect(SCHEDULER_JOBS as readonly string[]).toContain('usage_auto_post');
  });

  it('shareat-usage-auto-post.service runs `npm run usage-auto-post`; the .timer fires daily at 14:05 Asia/Manila (after the 14:00 deadline), persistent', () => {
    const service = path.join(OPS_DIR, 'shareat-usage-auto-post.service');
    const timer = path.join(OPS_DIR, 'shareat-usage-auto-post.timer');
    expect(existsSync(service), 'shareat-usage-auto-post.service exists').toBe(true);
    expect(existsSync(timer), 'shareat-usage-auto-post.timer exists').toBe(true);
    expect(readFileSync(service, 'utf8')).toMatch(/^ExecStart=.*npm run usage-auto-post\s*$/m);
    const t = readFileSync(timer, 'utf8');
    expect(t, 'daily at 14:05 Manila').toMatch(/^OnCalendar=\*-\*-\* 14:05:00 Asia\/Manila\s*$/m);
    expect(t).toMatch(/^Persistent=true\s*$/m);
  });
});

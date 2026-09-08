# T-236 — DEF-226: give `runOrderWastageBackstopSweep` a caller

> **Status**: APPROVED — slice 1 built, lane C + Opus review round complete, all findings fixed.
> Defect: `docs/DEFECTS-REGISTER.md` DEF-226 (slice 1), DEF-225 + DEF-227 (slice 2).
> Task number corrected from 235 to 236 on the orchestrator's instruction (lane B took 235 for
> DEF-222 first); no 235-named file was ever created here.
> **Review round 1**: lane C failed the guard, Opus said APPROVE WITH FIXES, both found the same
> hole (BLOCKER 1) and Opus found a second (BLOCKER 2); three SHOULD-FIX items plus nits. All
> fixed — see the guard's own header comment (BLOCKER 1/2) and the script/README/provision.sh
> diffs. The cadence decision from the SPEC round was separately confirmed correct by the
> orchestrator, reading task 178 §11 in full: it names no cadence at all.
> **Slice 2**: GO received; built. Two notes from the Opus re-check, recorded here rather than as
> code (see "Slice 2 notes" below): the caller-exists guard's population is declaration-shaped
> (now stated as a limit in the guard's own header — `export const runX = async` or a re-export
> would escape it, currently a real-but-empty gap); T-216's recurring-expense units are still
> missing from `provision.sh`'s install loop — filed as **DEF-231**, not this task's to fix.

---

## Evidence the sweep has no caller today

Control first (`reference_sweep_needs_nonzero_control` — a check that matches nothing proves
nothing), grepping the same six top-level scheduler entry points across `scripts/`:

```
$ grep -rl "runMonthEnd\|runAttendanceSweep\|runFirestoreRelay\|runOrderWastageBackstopSweep\|runFindingObservation\|runBudgetReissue" scripts
scripts/budget-reissue.ts
scripts/finding-observation.ts
scripts/firestore-relay.ts
scripts/attendance-sweep.ts
scripts/month-end.ts
```

Five of six job entry points have a `scripts/` caller. `runOrderWastageBackstopSweep` is the one
missing — the control proves the grep methodology finds callers when they exist.

Repo-wide, not just `scripts/`:

```
$ grep -rn "runOrderWastageBackstopSweep" .
./packages/domain/src/scheduler/index.ts:585:export async function runOrderWastageBackstopSweep(
```

One hit — its own declaration. No `scripts/*.ts`, no `package.json` line (`grep -n "order-wastage"
package.json` — no output), no import anywhere in `apps/`. The function's own docstring
(`scheduler/index.ts:574`) already says *"This is the ONLY thing that fires
`runOrderWastageBackstop` — there is no separate cron path (task §11)"* — true and irrelevant: it
names the only thing that fires the domain function, not the thing that fires *this* function.
Nothing does.

## Why `tests/unit/domain-actions-have-callers.test.ts` did not catch it

That guard's population is exports shaped `(tx, ..., actor: Actor, ...)` — a function that
**authorizes** a human act (header comment, lines 11–19). `runOrderWastageBackstopSweep`'s
signature is `(options: { orgId?: string; trigger?: 'cron' | 'manual'; nowMs?: number })` — no
`tx` first parameter, no `actor`. It is explicitly out of that guard's stated population (lines
22–26): *"a state-moving function with no `actor` is out of this guard's population. Those are
either called by one that does take an actor, or are scheduler entry points with their own
registration guard."*

That second clause is the gap. The only thing resembling a "registration guard" for a scheduler
job is `scheduler_runs_job_check`, the DB CHECK constraint listing valid job names —
`packages/db/schema/scheduler.ts:52,148` does list `'order_wastage_backstop'`. But that constraint
proves the job is registered to **write a run row if invoked**; it says nothing about whether
anything **invokes** it. A `select * from tests/unit` grep for `"scheduler"` outside
`domain-actions-have-callers.test.ts` returns nothing — there is no test anywhere asserting that
every exported scheduler job entry point has a script/systemd caller. That is exactly DEF-226's
shape, and per the register row it is the second time (DEF-186 was the first, a different module).
The fix closes the hole at its actual location: a new guard scoped to `scheduler/index.ts`'s
exported job entries, not a change to the existing actor-shaped guard (which would be the wrong
population for it).

---

## Goal

**Slice 1 (DEF-226).** `runOrderWastageBackstopSweep` gets the same reachability its five siblings
already have: a `scripts/order-wastage-backstop.ts` entry point, a `package.json` line, an
installable-but-not-self-arming systemd `.service`/`.timer` pair in `docs/ops` (Ian arms it,
`docs/ops/README.md`'s own rule — arming is never an agent's job), and a caller-exists guard that
would have failed on this defect and now prevents the next one, for any of the six job entries.

**Slice 2 (DEF-225 + DEF-227), after slice 1 is READY.** Three sibling scripts print a bare
"finished cleanly"/no summary at all, with no zero-org guard (DEF-225); `runInboxRelayJobs`'s
pre-loop `orgIdsForStoreIds` read is still awaited outside any try, so a refused read there rejects
`runFirestoreRelay` wholesale before any org gets a row (DEF-227).

---

## Scope — the exact files this task may create or modify

| Path | Slice | Why |
|---|---|---|
| `docs/tasks/236-def-226-order-wastage-backstop-caller.md` | — | this spec |
| `scripts/order-wastage-backstop.ts` | 1 | new — the missing caller |
| `package.json` | 1 | one line in `"scripts"`, beside `"finding-observation"`; nothing else in the file |
| `docs/ops/shareat-order-wastage-backstop.service` | 1 | new — systemd unit, template `shareat-finding-observation.service` |
| `docs/ops/shareat-order-wastage-backstop.timer` | 1 | new — systemd timer |
| `docs/ops/README.md` | 1 | add the job to "The jobs" table; note it ships unarmed like its siblings did |
| `docs/ops/provision.sh` (lines 88–92 only) | 1 | added to scope by the orchestrator after review — the install loop is an explicit filename list that never installs a unit not named in it; add the new pair, touch nothing else in the file (the older drift — `recurring-expense-draft` also missing from this list — is DEF-194 territory, not this task's) |
| `tests/unit/scheduler-jobs-have-callers.test.ts` | 1 | new — the caller-exists guard for scheduler job entries |
| `scripts/month-end.ts` | 2 | count line + zero-org guard |
| `scripts/attendance-sweep.ts` | 2 | summary line + zero-org guard (currently prints nothing) |
| `scripts/firestore-relay.ts` | 2 | summary line + zero-org guard (currently prints nothing) |
| `packages/domain/src/scheduler/index.ts` | 2 | `runInboxRelayJobs`'s pre-loop read (DEF-227), `runOrderWastageBackstopForOrg` NOT touched |
| existing tests under `packages/domain/tests/integration/` and `tests/integration/` | 2 | whichever already cover `runFirestoreRelay`'s pre-loop failure path, plus one new case for DEF-227 |

**Not touched — described here, the orchestrator makes the change:** `docs/DEFECTS-REGISTER.md`
(DEF-226/225/227 disposition at commit) · `PROJECT_BIBLE.md` · `docs/ROADMAP.html` ·
`tests/unit/domain-actions-have-callers.test.ts` (wrong population for this gap — reasoned above;
if the orchestrator wants a row there anyway, describe it and I don't touch the file myself) · any
barrel `index.ts` · migrations.

**No migration.** My migration slot is none (lane D holds it). Nothing here changes a schema.

---

## Contract

### 1. `scripts/order-wastage-backstop.ts` — same shape as `scripts/finding-observation.ts`

```ts
/**
 * `npm run order-wastage-backstop` — T-178's 15-day auto-charge/absorb backstop for tracked order
 * wastage.
 *
 * Invoked by the host's systemd timer, daily:
 *
 *   docs/ops/shareat-order-wastage-backstop.timer
 *
 * ⛔ Registering this job is not the finish line. Arming its timer is. See docs/ops/README.md.
 * ⚠️ Exit code is load-bearing — non-zero when anything failed, the same reason DEF-044 exists.
 */
import { config } from 'dotenv';
import { closeDb } from '@shareat/db';
import { runOrderWastageBackstopSweep } from '@shareat/domain';

config({ path: '.env.local' });

function arg(name: string): string | undefined { /* identical to the sibling scripts */ }

async function main(): Promise<number> {
  const orgId = arg('org');
  const trigger = process.argv.includes('--manual') ? 'manual' : 'cron';

  console.log(`order-wastage-backstop: running (${trigger})${orgId ? ` for org ${orgId}` : ''}`);

  const result = await runOrderWastageBackstopSweep({ orgId, trigger });

  for (const o of result.outcomes) {
    const head = `  ${o.orgName}`;
    if (o.error) console.error(`${head}: FAILED OUTRIGHT — ${o.error}`);
    // Printed unconditionally — no `continue`. T-233 guard C can leave `o.error` set with the work
    // already committed, so the counts can be real even on a FAILED OUTRIGHT line.
    console.log(`${head}: posted ${o.posted}, skipped ${o.skipped}, failed ${o.failed}`);
    for (const f of o.failures) console.error(`      ⛔ ${f.subjectName}: ${f.reason}`);
  }

  if (result.hadFailures) {
    console.error('order-wastage-backstop: finished WITH FAILURES — see above.');
    return 1;
  }
  if (result.outcomes.length === 0) {
    console.error('order-wastage-backstop: no orgs were processed — nothing to observe?');
    return 1;
  }
  const closed = result.outcomes.reduce((sum, o) => sum + o.posted, 0);
  console.log(`order-wastage-backstop: ok — closed ${closed} · ${result.outcomes.length} orgs`);
  return 0;
}

main()
  .then(async (code) => { await closeDb(); process.exit(code); })
  .catch(async (err) => {
    console.error('order-wastage-backstop: crashed —', err);
    await closeDb();
    process.exit(1);
  });
```

`posted`/`skipped`/`failed` are `JobOutcome`'s generic fields (`scheduler/index.ts:54`);
`runOrderWastageBackstopForOrg` (`:600`) always sets `skipped: 0` today, kept in the print line
for the same reason `month-end.ts` and `firestore-relay.ts` keep it — one shared shape across
scripts, not a bespoke one per job. `result.outcomes.reduce(...)` sums `posted`, i.e. wastages
closed (charged or absorbed) — `runOrderWastageBackstop`'s `outcomes.length`
(`packages/domain/src/wastage/orders.ts:562`–`:619`).

**Zero-org guard included from the start** — this script is written new, so it gets the pattern
T-233 retrofitted onto the other three rather than needing DEF-225 filed against a fourth one.

### 2. `package.json`

One line, immediately after the `"finding-observation"` entry (`package.json:36`):

```json
"order-wastage-backstop": "tsx scripts/order-wastage-backstop.ts",
```

### 3. Systemd pair — cadence decision, flagged for review

Template: `docs/ops/shareat-finding-observation.{service,timer}` (read in full). The `.service`
file is a mechanical copy — `oneshot`, `WorkingDirectory=/srv/shareat`,
`ExecStart=/usr/bin/npm run order-wastage-backstop`, `User=shareat`, log path
`/var/log/shareat/order-wastage-backstop.log`.

**⚠️ The `.timer`'s cadence is a decision I'm making, not copying, and it wants a second look at
SPEC review.** `scheduler/index.ts:576` calls the sweep *"Hourly-shaped like `attendance_sweep`,
not monthly"* — but reading that comment in full, it is about `period`'s **semantic convention**
(*"`period` records the `YYYY-MM` this run happened IN... never a period being closed"*, contrasted
with `month-end`/`budget-reissue`'s period-CLOSING convention), not a cadence instruction.
`attendance_sweep` is hourly for a reason that does not apply here — a wall-clock cutoff that
differs **per store**, which a daily timer cannot serve (`docs/ops/shareat-attendance-sweep.timer`,
its own header). A 15-day threshold has no per-store wall-clock component and enormous slack;
polling hourly buys nothing a daily run does not, at the cost of 24× the writes for the same
outcome. I am setting `OnCalendar=*-*-* 02:30:00 Asia/Manila`, Persistent=true,
AccuracySec=5min — daily, after `finding-observation` (01:30) and before `recurring-expense-draft`
(02:00 already, so actually straight after both; 02:30 clears both). **If the orchestrator or the
Opus reviewer reads the "hourly-shaped" comment as a cadence instruction rather than a `period`-
convention note, that is a spec defect to correct before I build, not something to silently
resolve either way.**

`docs/ops/README.md`: add a row to "The jobs" table (cadence + one-sentence why, matching the
existing five rows' shape) and fold it into the existing "N jobs have shipped unarmed" sentence —
this becomes the sixth, joining `budget-reissue` and `recurring-expense-draft` as of this task
(README's 2026-09-06 status section is already stale on the count; not touching that section's
history, only the live table and the unarmed-count sentence).

### 4. The guard — `tests/unit/scheduler-jobs-have-callers.test.ts`

New file. Does not modify `domain-actions-have-callers.test.ts` — different population, reasoned
above. Shape:

- `trackedFiles()` / `codeOnly()` — same two helpers as the existing guard (`git ls-files -z
  --cached --others --exclude-standard`, comments stripped, CRLF normalised first per
  `reference_js_dot_does_not_match_cr` / DEF-179). Duplicated rather than imported: the existing
  file exports nothing, and the two guards' populations are different enough that sharing helpers
  through a change to that file would be an edit outside scope.
- From `packages/domain/src/scheduler/index.ts`, extract every `export async function run<Name>(`
  whose first parameter is **not** `org`/`tx`/`trx` — a shape check, not a name check, because
  `runFirestoreRelay(drivers, options)` takes `drivers` first: a filter keyed on the literal name
  `options` silently drops it. This is what distinguishes the six top-level job entries
  (`runMonthEnd`, `runAttendanceSweep`, `runFirestoreRelay`, `runOrderWastageBackstopSweep`,
  `runFindingObservation`, `runBudgetReissue`) from `runJobForOrg` (first param `org`) and from
  `lastCompletedPeriod` (not `async`).
- **Non-zero control on the guard itself, and the set is PINNED, not just floored**: a
  `KNOWN_JOB_NAMES` constant lists the six names, and one test asserts the extraction matches it
  exactly — a floor alone can equal a broken count by coincidence and stay blind to the exact hole
  it exists to catch (`reference_sweep_needs_nonzero_control`).
- For each extracted name, assert it is both imported **and invoked** — `\b${name}\s*\(`, not a
  bare word-boundary match — by at least one tracked, non-test file under `scripts/`. A predicate
  that only checks the name is *mentioned* would pass on an import with no call.
- `EXEMPT: Record<string, string>` scaffold, same discipline as the existing guard (a reason must
  name its kind and be a confession, not a config knob) — empty today. A stale-exemption check
  mirrors the existing guard's second `it()` if the scaffold is ever used.
- Watched to fail RED first: run against the tree as it stands **before**
  `scripts/order-wastage-backstop.ts` exists, and the failure must name
  `runOrderWastageBackstopSweep` specifically, not just "1 failure".

---

## Invariants

1. **`runOrderWastageBackstopSweep` is reachable in production the same way its five siblings are**
   — a `scripts/*.ts` entry, a `package.json` line, an installable systemd pair. *(The property
   this whole slice rests on.)*
2. **The script never throws past `main()`.** Same `.then`/`.catch` shape as every sibling —
   `closeDb()` runs on every path, non-zero exit on any failure, a crash before any run row is
   written is still loud (`finding-observation.ts:77`–`:86`).
3. **Zero orgs processed is a failure, not a quiet success** — `outcomes.length === 0` exits 1,
   built in from the start rather than retrofitted (DEF-225's shape, not repeated here).
4. **Installing the unit never arms it.** `docs/ops/README.md`'s own rule — `provision.sh` installs,
   `systemctl enable --now` arms, and arming is Ian's, on the droplet, never an agent's (same
   out-of-scope line T-233 used for DEF-194).
5. **The new guard's population is scheduler job entries, not actor-shaped domain actions** — it
   must not touch or duplicate the meaning of `domain-actions-have-callers.test.ts`, only its two
   small helper patterns.
6. **No behaviour change to `runOrderWastageBackstopSweep` or `runOrderWastageBackstopForOrg`.**
   This slice adds a caller; it does not touch the domain function, its transaction boundary, or
   its fallback order (task 178 invariant 5).

---

## Tests — written first, watched to fail for the right reason

### T1 — the guard fails RED today, naming the right function

`tests/unit/scheduler-jobs-have-callers.test.ts`, run against the tree as it stands right now
(`npm test` / `vitest run --project unit` — unit, no DB, no lane needed):

- The extracted job-entry set has ≥ 5 members (control).
- `runOrderWastageBackstopSweep` is reported as having no `scripts/` caller — the assertion fails,
  and the failure message names that function.
- The other five job entries each report a caller and pass.

### T2 — the guard goes GREEN once the script exists

After `scripts/order-wastage-backstop.ts` is written and imports + calls
`runOrderWastageBackstopSweep`, T1 re-run is green for all six.

### T3 — the guard's own control is honest

A mutation check (asserted in-file, not a separate run): if the extraction regex is changed to
match nothing, the "≥ 5" assertion fails before the per-function assertions get a chance to report
a false "0 problems".

### Running them

Unit only, no lane DB:

```
npm test -- scheduler-jobs-have-callers
npx tsc --noEmit
```

Slice 2's DEF-227 fix needs its lane's integration DB:

```
node ~/.claude/skills/orchestrator/tools/it.mjs shareat_test_def219 <the affected integration test files>
```

⛔ Never `npm run test:integration`.

---

## Out of scope

- **Arming the timer** (DEF-194) — installing and enabling on the droplet is Ian's, via
  `provision.sh`; this task ships the unit files, nothing more.
- **`packages/db/src/repo/scheduler.ts`** and **`runOrderWastageBackstopForOrg`/
  `runOrderWastageBackstop`** — no behaviour change, invariant 6.
- **Retrofitting `domain-actions-have-callers.test.ts`'s population** to cover scheduler jobs —
  wrong file for this shape, reasoned above; a new, narrow guard instead.
- **Slice 2's actual edits** — described above at spec level so slice 1's approval covers the
  shape, but not built until slice 1 is READY.
- **The `/scheduler` screen** — no UI change.

---

## Done when

**Slice 1:**
- [ ] T1 written first and watched to fail for the right reason (names
      `runOrderWastageBackstopSweep`), then T2 green.
- [ ] `scripts/order-wastage-backstop.ts` exists, matches the contract, zero-org guard included.
- [ ] `package.json` gains exactly one line.
- [ ] `docs/ops/shareat-order-wastage-backstop.service` + `.timer` exist; `docs/ops/README.md`
      updated (job table row + unarmed-count sentence).
- [ ] `npx tsc --noEmit` clean; `npm test` green — real output, exit codes quoted in the READY.
- [ ] `grep -rn "runOrderWastageBackstopSweep" .` returns real CODE hits at exactly two sites —
      the declaration (`scheduler/index.ts:585`, unchanged) and the new script's import + call
      (`scripts/order-wastage-backstop.ts`) — excluding doc-comment prose mentions in the new
      files themselves, which the grep also picks up and which are not additional callers. Control
      run first (`runFindingObservation`, a known-wired sibling), per
      `reference_sweep_needs_nonzero_control`.
- [x] Verified by the orchestrator on a throwaway DB: the script exits 1 with the zero-org
      sentence against an empty database, and exits 0 against a one-org database, printing
      `posted 0, skipped 0, failed 0` per org and `order-wastage-backstop: ok — closed 0 · 1 orgs`,
      writing one `scheduler_runs` row (`job='order_wastage_backstop'`, `trigger='manual'`,
      `period='2026-09'`, finished).
- [x] Self-reviewed line by line.
- [x] ⛔ Not done by me: commit, bible, roadmap, register disposition, board, arming the timer.
      Described in the READY for the orchestrator. (Slice 1 landed on `main` as `807ce1b`.)

**Slice 2** (after slice 1 READY and re-approved to proceed):
- [x] `month-end.ts`, `attendance-sweep.ts`, `firestore-relay.ts` each print counts + carry the
      zero-org guard, in the shape of the three T-233-fixed siblings — including the guard-C-aware
      error branch (counts print unconditionally, no `continue`), the same fix round 1's review
      applied to `order-wastage-backstop.ts`.
- [x] `runInboxRelayJobs`'s pre-loop `orgIdsForStoreIds` read no longer rejects the whole
      `Promise.all`/loop on failure — wrapped the way `runJobForOrg` wraps `startRun`, one outcome
      per org via the existing `failedInboxRun` helper on refusal. `scheduler/index.ts` diff is
      exactly this one try/catch, 16 lines, nothing else in the file touched.
- [x] Existing integration tests for `runFirestoreRelay` stay green unmodified (3 of 4 in the
      file); one new test proves DEF-227's fix — watched RED first against the real defect (a
      malformed-UUID `storeId`, no migration needed: `PostgresError: invalid input syntax for type
      uuid: "not-a-valid-uuid"`, an uncaught rejection), then GREEN after the fix. `scheduler.test.ts`
      (20 tests) and `recurring-expenses-job.test.ts` re-run clean for regression, since both
      exercise the same file.
- [x] Both Opus re-check notes recorded — the guard's declaration-shaped limit in its own header
      comment, and DEF-231 (provision.sh's missing recurring-expense-draft lines) named as not this
      task's.
- [x] `npx tsc --noEmit` clean; `npm test` (full unit project) green — 73 files, 1138 passed, 1
      pre-existing skip, real output in the READY.

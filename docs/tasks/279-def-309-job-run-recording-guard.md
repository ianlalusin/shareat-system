# T-279 — DEF-309: a scheduled job that records no run must fail the build

> **Status: READY 2026-09-12 — built by lane B (webapps-65), awaiting system32-85's own gate
> re-run before commit.** typecheck clean; `npm run test` (unit project) — one unrelated
> pre-existing failure in `apps/erp/tests/action-link-sweep.test.ts` from another lane's in-flight,
> uncommitted edit to `apps/erp/src/app/admin/users/[personId]/page.tsx` (not touched by this
> task; reported, not fixed); this task's own file, all 10 tests (7 Pass A + 3 Pass B) green.
> All three additions from the approval applied: the `schedulerRepo`/`etlRepo` `startRun`
> qualification, Pass B reported as its own 10/10 count, and the depth-cap-fails-closed pin
> (State 7), each with executed output below.

Source defect: `docs/DEFECTS-REGISTER.md` DEF-309.
Sequencing: T-275 (DEF-304) has landed; this is the third guard in that family.

## The trace, first, per instruction — executed by reading and by `grep`, not reasoned about

**Correction to the premise: there are eight `run*` job-entry exports today, not seven, covering
ten `SCHEDULER_JOBS` kinds — T-275 added the eighth (`runRecurringExpenses`) the same day DEF-309
was filed, and the register row's "seven" predates that landing.** Verified against
`tests/unit/scheduler-jobs-have-callers.test.ts`'s own pinned `KNOWN_JOB_NAMES` (8 entries) and
`packages/db`'s `SCHEDULER_JOBS` (10 kinds, confirmed via `tests/unit/scheduler-job-hosting.test.ts`'s
`JOB_SCRIPT` map, which is typed `Record<SchedulerJob, string>` and lists all ten).

`grep -n "runJobForOrg(" packages/domain/src -r` returns exactly 11 call sites in exactly 2 files
(`packages/domain/src/scheduler/index.ts`, `packages/domain/src/recurring-expenses/job.ts`) — no
job's chain ever leaves its own declaring file. Traced by reading each entry's body and following
every private helper it calls:

| Job entry (exported `run*`) | Declaring file | `SCHEDULER_JOBS` kind | Hops to `runJobForOrg` | Intermediate function(s) |
|---|---|---|---|---|
| `runMonthEnd` | `scheduler/index.ts` | `depreciation` | 2 | `runDepreciationJob` (private, same file) |
| `runMonthEnd` | `scheduler/index.ts` | `amortisation` | 2 | `runAmortisationJob` (private, same file) |
| `runAttendanceSweep` | `scheduler/index.ts` | `attendance_sweep` | 2 | `runSweepForOrg` (private, same file) |
| `runFirestoreRelay` | `scheduler/index.ts` | `mirror_publish` | 2 | `runMirrorPublishJob` (private, same file) |
| `runFirestoreRelay` | `scheduler/index.ts` | `inbox_relay` | **3** | `runInboxRelayJobs` (private) → `runInboxRelayForOrg` (private) — or, on the read/lookup-failure early-return path, → `failedInboxRun` (private) |
| `runOrderWastageBackstopSweep` | `scheduler/index.ts` | `order_wastage_backstop` | 2 | `runOrderWastageBackstopForOrg` (private, same file) |
| `runFindingObservation` | `scheduler/index.ts` | `finding_observation` | **1** | none — `runJobForOrg` called inline, directly inside the entry's own `for` loop |
| `runBudgetReissue` | `scheduler/index.ts` | `budget_reissue` | **1** | none — same direct-inline shape as `finding_observation` |
| `runOrphanFileSweep` | `scheduler/index.ts` | `orphan_file_sweep` | 2 | `runOrphanFileSweepForOrg` (private, same file) |
| `runRecurringExpenses` | `recurring-expenses/job.ts` | `recurring_expenses` | **1** | none — direct inline call; `runJobForOrg` is *imported* from `../scheduler` but the call site is local to this file |

**Hops range 1-3, and the shape is not uniform.** Three kinds call it directly with no
intermediate function at all (`finding_observation`, `budget_reissue`, `recurring_expenses`); six
go through exactly one private per-org helper; one (`inbox_relay`) goes through two, chained.

⭐ **Confirmed separately, by `grep`, not assumed: reaching `runJobForOrg` IS reaching the row —
qualified to `schedulerRepo`, and only to it.** `schedulerRepo.startRun`/`finishRun`/`failRun`
(`packages/db/src/repo/scheduler.ts:47` and neighbours) are called from exactly one place each in
the whole of `packages/`: inside `runJobForOrg` itself and its own private `closeFailedRun` helper
(`scheduler/index.ts:134,163,186`). No other code path opens or closes a `scheduler_runs` row.

⛔ **`startRun`/`finishRun` are two namespaces that look like one, and the equivalence above holds
for exactly one of them.** `packages/db/src/repo/etl.ts:96` exports an UNRELATED
`export async function startRun` — an ETL capture-run lifecycle function, imported and called as
`etlRepo.startRun` from `packages/etl/src/run.ts:52` and `packages/etl/tests/integration/
etl-run.test.ts:242,244`. Verified by `grep`, not assumed, per system32-85's own DEF-301 caution:
two same-named functions in two different repo modules are exactly the shape that bites a reader
who assumes a bare name means one thing. **Every claim in this spec about "`startRun` has one
caller" means `schedulerRepo.startRun` specifically** — `etlRepo.startRun` is a different function
for a different table and this guard has no opinion about it.

So "this job's call graph reaches `runJobForOrg`" and "this job records a `scheduler_runs` row" are
the same fact today — checking reachability is checking the real thing, not a proxy for it. But
the guard's own frontier-extraction (§ Contract below) matches called identifiers by BARE name,
with no namespace/qualifier — harmless for `runJobForOrg` itself (verified unique: exactly one
function in the repo has that name), but named explicitly as a stated limitation in case the
guard's target name is ever changed to something that, like `startRun`, exists in more than one
namespace. See "What this check CANNOT see" below.

## What the trace decides — and where it overturns the register's OWN proposed remedy

⛔ **DEF-309's own remedy text — "assert its declaring file's source contains a `runJobForOrg(`
call... directly, or transitively through a private per-org helper in the same file" — is itself
a false-positive generator, and the trace above is what shows it, not reasoning.** `scheduler/
index.ts` is not one job per file; it holds **seven** of the eight entries. A check that asks
"does the WHOLE FILE's text contain the string `runJobForOrg(` anywhere" cannot tell "this specific
entry's own call graph reaches it" apart from "some OTHER entry sharing this file reaches it, and
this one might not." **It passes today only because, empirically, every one of the seven entries
in this file happens to reach it — a fact about today's code, not something the whole-file check
itself verifies.** Add a ninth entry to `scheduler/index.ts` tomorrow that never calls
`runJobForOrg` anywhere in its own reachable functions, and a whole-file-contains check would still
see the other six calls already in the file and pass it. That is exactly DEF-295/304's shape —
a guard whose claimed scope (this job records a run) exceeds what it actually verifies (something
in this file does) — and it is the fifth instance of that family this week. **Not built this way.**

**Proposed instead: a same-file, PER-ENTRY, bounded-depth call-graph reachability walk** — not a
bigger regex with the same blindness, because it does per-export attribution rather than a single
substring test over an ever-larger haystack:

1. Discover job entries the same way `scheduler-jobs-have-callers.test.ts` already does (same
   shape filter, same `git ls-files` scan of `packages/domain/src/**`) — duplicated, not imported,
   per that file's own stated convention for why its extraction helpers are copied rather than
   shared.
2. For each entry's declaring file, extract every top-level `(async )?function <name>(...) { ... }`
   declaration (exported or private) into a `name -> body` map, using the same paren-balancing
   technique `paramsFrom()` already uses for parameter lists, extended to find the matching closing
   brace for the body.
3. From the entry's own body, extract the set of called identifiers (`\b(\w+)\s*\(`) as the initial
   frontier.
4. BFS: if `runJobForOrg` is in the frontier, reached — record the hop count. Otherwise, for every
   frontier name that resolves to a LOCAL function in the same file's map and has not yet been
   visited, add it to `visited` and fold its own called identifiers into the next frontier. Repeat,
   capped at depth 6 (today's observed maximum is 3; the cap exists only to terminate on a mutual
   recursion, not because 6 is a meaningful number).
5. An entry whose BFS exhausts without reaching `runJobForOrg` is a **finding** — the guard's whole
   point.

This directly closes the gap the whole-file check has: it can tell "this entry's own reachable
functions include `runJobForOrg`" from "some unrelated sibling entry's do," because each entry gets
its own BFS from its own name, not one shared substring test over the file.

⭐ **Also pinned, not just floored** — same discipline as `KNOWN_JOB_NAMES` in the sibling file, for
the same stated reason (a regex/BFS can silently start matching fewer OR more without a fixed
comparison set catching either direction): the hop count and intermediate-function path for each of
the ten kinds in the table above is asserted literally, not merely "greater than zero."

## Scope

Only:
- `tests/unit/scheduler-job-run-recording.test.ts` — new. The guard.
- `docs/tasks/279-def-309-job-run-recording-guard.md` — this file.

Not touched: `tests/unit/scheduler-jobs-have-callers.test.ts` (T-275's file — reused as a read-only
pattern reference, extraction helpers duplicated per its own stated convention, not edited),
`tests/unit/scheduler-job-hosting.test.ts`, everything under `packages/**` and `scripts/**` (read
for verification only), `docs/DEFECTS-REGISTER.md`, `docs/ops/README.md`, `PROJECT_BIBLE.md`.
Nothing from the frozen T-280 file list is touched.

## Contract

Pure, parameterised functions — so the SAME logic backs both the real-repo assertions and the
synthetic-source plant tests below, without needing a second implementation for the tests to
"test the test" against (the pattern `scheduler-jobs-have-callers.test.ts`'s own "requires an
invocation, not just an import" test already uses for `isCalled()`).

```ts
interface CallGraphResult {
  entry: string;
  reached: boolean;
  hops: number | null;       // null when not reached
  path: string[];             // intermediate function names, entry-to-target order, [] if direct
}

/** Extracts name -> body for every top-level (async )?function declaration in one file's source. */
function functionBodies(src: string): Map<string, string>;

/** BFS from `entryName` through `bodies`' local call graph, looking for `targetName`. Depth-capped. */
function reachesLocally(
  entryName: string,
  targetName: string,
  bodies: Map<string, string>,
  maxDepth?: number, // default 6
): CallGraphResult;
```

The real guard: for each job entry discovered by the (duplicated) T-275-style scan, call
`reachesLocally(entryName, 'runJobForOrg', functionBodies(readFile(entry.file)))` and assert
`reached === true`, then compare `hops`/`path` against the pinned table above.

## Invariants, with citations

1. **Every exported job entry's OWN call graph — not merely its declaring file's text — reaches
   `runJobForOrg`.** (DEF-309, this trace.)
2. **The extracted hop count and path for each of the ten kinds matches the pinned table above.**
   A silent change in either direction (a job that used to be 2 hops becoming unreachable, or the
   BFS starting to over-match) fails the build.
3. **`reachesLocally` never resolves an import** — it only follows same-file function-name
   references. This is deliberate (§ "what this cannot see" below), not an oversight.

## ⛔ What this check CANNOT see, named explicitly

- **A genuinely cross-file hop.** If a future job's chain called a helper defined in a DIFFERENT
  file, which itself called `runJobForOrg`, this guard's same-file BFS would report it as
  UNREACHED — a false negative in the "gap" sense, which is the safe failure direction (it forces a
  human to look, rather than silently passing a job that may or may not actually record). Today
  this never happens: `grep`-verified, all 11 call sites resolve within the entry's own declaring
  file.
- **Whether `reaches runJobForOrg` really still equals `records a scheduler_runs row`.** That
  equivalence is a structural fact about today's code (`startRun`/`finishRun`/`failRun` have
  exactly one caller each, both inside `scheduler/index.ts`), verified by `grep` for this spec but
  not re-verified by the guard itself on every run. If a future change calls `schedulerRepo.
  startRun` from somewhere else, this guard would not notice that the proxy had stopped holding.
- **Dynamic dispatch, `.call()`/`.apply()`, or a call routed through a variable holding a function
  reference.** The frontier extraction is a name-identifier regex; a job that reached
  `runJobForOrg` only through indirection would not be found. No job does this today.
- **A bare name that exists in more than one namespace.** `functionBodies`/`reachesLocally` match
  called identifiers by BARE name (`\b(\w+)\s*\(`), with no `object.` qualifier attached. This is
  harmless for THIS guard's actual target, `runJobForOrg` — `grep`-confirmed exactly one function
  in the repo has that name — but `startRun`/`finishRun` are the proof this class of collision is
  real here (`schedulerRepo.startRun` vs. the unrelated `etlRepo.startRun`, DEF-301's own shape).
  If this guard's target name is ever changed to something that also exists in another namespace,
  the bare-name match would silently conflate them. Named here so nobody assumes the technique is
  namespace-aware; it is not.
- **Whether the depth cap was ever actually the limiting factor for a genuine, wired job** — the
  cap fails CLOSED (§ Tests, State 7): exceeding it reports `reached: false`, the same as never
  finding the target at all. This guard cannot distinguish "genuinely unreachable" from "reachable
  at hop 7 with a cap of 6" — both read as a violation requiring a human to look, which is the
  point, but it means raising the cap is a manual, deliberate act when a real job someday needs it,
  not something the guard will explain on its own.
- **Anything about WHETHER the job is armed, wired, or hosted** — `scheduler-job-hosting.test.ts`
  and `scheduler-jobs-have-callers.test.ts` already cover those two questions; this guard adds only
  the third: does the reachable code actually open a run row.

## Tests — two passes, reported SEPARATELY, per the approval ("one without the other is half a proof")

### Pass A — synthetic-source plant proof, entirely inside the test file (no `packages/**` edit needed)

Because this task's scope is `tests/unit/` only, the plant proof uses fabricated source STRINGS
passed directly to `functionBodies`/`reachesLocally` — the same technique the sibling guard's own
"requires an invocation, not just an import" test already uses. All states below are EXECUTED.

- **State 1 — a direct call (depth 1) is found.** Synthetic source: one function whose body calls
  `runJobForOrg(...)` inline. `reachesLocally` → `reached: true, hops: 1`.
- **State 2 — a two-hop chain (depth 2) is found**, matching `runMonthEnd`'s real shape: entry
  calls `helperA`, `helperA`'s body calls `runJobForOrg(...)`. → `reached: true, hops: 2, path:
  ['helperA']`.
- **State 3 — a three-hop chain (depth 3) is found**, matching `inbox_relay`'s real shape: entry →
  `helperA` → `helperB` → `runJobForOrg`. → `reached: true, hops: 3`.
- **State 4 — RED, the guard's whole point: an entry whose reachable functions never call
  `runJobForOrg` is reported unreached, not silently passed.** Synthetic source: entry calls
  `helperA`, `helperA` does something else entirely and never calls the target. →
  `reached: false`.
- **State 5 — the per-entry attribution proof, i.e. proving the whole-file-contains check's exact
  blindness does NOT survive in this design.** Synthetic source with TWO sibling top-level
  functions in ONE file: `entryGood` calls `helperGood`, which calls `runJobForOrg(...)`;
  `entryBad` calls `helperBad`, which does NOT. Both `entryGood` and `entryBad` share the same file
  (the same `bodies` map). Assert `reachesLocally('entryGood', ...).reached === true` AND
  `reachesLocally('entryBad', ...).reached === false` — proving the check attributes reachability
  per-entry even when a sibling in the same synthetic file DOES reach the target. This is the
  concrete, executed counter-example to "a whole-file-contains check would have passed `entryBad`
  too" — run, not argued.
- **State 6 — the depth cap terminates on mutual recursion rather than hanging or false-reaching.**
  Synthetic source: `helperA` calls `helperB`, `helperB` calls `helperA`, neither calls the target.
  → `reached: false`, and the test asserts it returns rather than timing out.
- **State 7 — PINNED per the approval: the depth cap fails CLOSED, never open.** Synthetic source:
  a straight-line chain 8 functions deep (`entry → h1 → h2 → ... → h7 → runJobForOrg`), genuinely
  reaching the target if depth were unlimited, run with `maxDepth: 6`. Assert `reached: false` —
  NOT `true`. This is the executed proof that exceeding the cap reports a violation rather than a
  silent pass; a cap that failed open here would be the same bug DEF-309 is about, with a number
  attached instead of a missing call.

### Pass B — the real-repo positive control, executed against the actual files, reported as its own number

For all ten pinned `SCHEDULER_JOBS` kinds, run `reachesLocally` against the real, current source of
`packages/domain/src/scheduler/index.ts` and `packages/domain/src/recurring-expenses/job.ts`.
Assert `reached === true` for every one, and report the count as **10/10** — not folded into Pass
A's pass/fail count, because this is the only pass that says anything about TODAY'S actual jobs
rather than about the checking logic itself. Also assert `hops`/`path` for each kind matches the
table in "The trace" above literally (a pin, per the sibling guard's own discipline — catches the
extraction silently matching fewer or more, in either direction).

## Out of scope

- Any change to `packages/domain/src/scheduler/index.ts` or `recurring-expenses/job.ts` — read
  only, to trace the table above.
- `tests/unit/scheduler-jobs-have-callers.test.ts`, `tests/unit/scheduler-job-hosting.test.ts` —
  untouched; any disagreement between guards is reported, not fixed here.
- Amending DEF-309's own remedy text in `docs/DEFECTS-REGISTER.md` to reflect the whole-file-check
  flaw this trace found — reported to system32-85, not edited by this task.
- Cross-file call-graph resolution — named above as a stated limitation, not built.

## Done-when

typecheck clean · `npm run test` (unit project) green, including all seven Pass A synthetic states
executed and reported with literal output, AND Pass B's 10/10 real-repo count reported separately
from Pass A · self-reviewed · this file's status line updated to READY. The whole-file-check
finding is system32-85's own amendment to DEF-309 (done, per the approval) — not re-reported by
this task.

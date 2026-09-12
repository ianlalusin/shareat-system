# T-277 — DEF-308 (make the storage-driver trap self-explaining) + DEF-307 (correct the stranded-bytes sentence)

> **Status: ✅ COMPLETE — shipped 2026-09-12, `c74eba5`, lane A.** DEF-308 and DEF-307 both closed. The new guard’s population is ONE FILE today and its header says so.

## Implementation spec, lane A

### Part 1 — DEF-308

#### (a) The refusal message names the cure

`resolveStorageDriver()` (`packages/domain/src/files/driver.ts:101-114`) throws a true, unactionable
sentence today: *"FIREBASE_STORAGE_BUCKET is set but no driver is installed. Call
setStorageDriver()..."* — correct for a reader who already knows this is a standalone-process
problem, useless for one who doesn't (which is exactly the state I was in when I hit it building
T-272). **One added sentence**, appended to the existing message, not replacing it:

> *"A standalone script must install its own, since it never runs the app's boot hook — call
> `installScriptStorageDriver()` from `scripts/lib/storage-bootstrap.ts`, as
> `scripts/orphan-file-sweep.ts` does."*

Names the cause (no boot hook in a standalone process), the cure (a named function), and a concrete
working example — the three things DEF-308's own text asked for.

#### (b) Shared helper — building it, and the measured reasoning why

**Measured, not assumed, before deciding:** `git grep` for `setStorageDriver(` (the actual
"install into the global slot" idiom) finds exactly **two** call sites —
`apps/erp/src/instrumentation.ts:32` and `scripts/orphan-file-sweep.ts:43`. `scripts/storage-smoke.ts`
is **not** a third copy of that idiom, despite sharing the `firebaseConfigFromEnv()`/
`firebaseStorageDriver()` construction step with both: it never calls `setStorageDriver()` at all,
because it talks to the driver instance directly (`driver.put`/`get`/`remove`) to prove bucket
reachability and privacy, deliberately bypassing `resolveStorageDriver()`'s global slot — installing
one globally there would change what the script tests for no benefit. So the real count of "install
idiom" copies is **two**, not three, and `storage-smoke.ts` is correctly left alone in this task.

**Building the helper anyway**, for a reason narrower than "three copies exist" — DEF-211's actual
lesson: *the idiom being copyable is what let two of five jobs ship with no principal at all*.
`orphan-file-sweep.ts`'s 6-line inline block is exactly that shape: correct today, and the next
storage-touching script author's most likely move is copying it by hand (or, worse, not knowing to
copy anything at all, DEF-308's own finding). A one-line call is far harder to get wrong than a
6-line block re-typed under time pressure. `instrumentation.ts` genuinely cannot use it — dynamic
`import()` to dodge edge-runtime bundling, a `NEXT_RUNTIME` gate, no `dotenv` (Next.js loads env
itself) — and is correctly left untouched (out of scope, per the briefing, and structurally
different regardless).

**Contract:**
- New `scripts/lib/storage-bootstrap.ts`, exporting
  `installScriptStorageDriver(scriptName: string): void` — the exact body already proven working in
  `orphan-file-sweep.ts`: `firebaseConfigFromEnv()` → null means dev/test (log and return, the
  in-memory default is correct) → else `setStorageDriver(firebaseStorageDriver(config))` and log the
  bucket name, prefixed with `scriptName` so the log line still says which job is running.
- `scripts/orphan-file-sweep.ts` calls it in one line instead of carrying the block inline.
- `scripts/storage-smoke.ts` is **not** changed — different question, different mechanism, noted
  above so the choice reads as deliberate rather than incomplete.

#### Guard — proposed, not assumed either way

The scope grant offers `tests/unit/<a guard, if you conclude one is warranted>`. I conclude one is
warranted, narrowly: a future SECOND storage-touching script forgetting to call
`installScriptStorageDriver()` is exactly DEF-308 recurring, and nothing but a human remembering
would catch it otherwise — the same shape as DEF-186/DEF-226/DEF-299/DEF-303's whole family
("built, registered, nothing calls the part that arms it").

⛔ **Checked before writing the guard, not assumed:** `scripts/orphan-file-sweep.ts` does NOT call
`sweepOrphanedFiles` directly — it calls the scheduler-level `runOrphanFileSweep`, which calls
`sweepOrphanedFiles` internally. A population built from the three low-level domain exports
(`uploadFile`, `readFileUrl`, `sweepOrphanedFiles`) would be EMPTY for `scripts/*.ts` today — a
scan-of-nothing, exactly bible §13 row 181's own landmine, in a guard written to close a defect about
guards scanning the wrong thing. **This guard's population is therefore a hand-maintained list of
storage-touching CALL NAMES reachable from scripts** — `uploadFile`, `readFileUrl`,
`sweepOrphanedFiles`, `runOrphanFileSweep` — the same declaration-list convention
`KNOWN_JOB_NAMES`/`JOB_SCRIPT` already use, extended by hand the day a second job entry reaches
storage. Proposed file: `tests/unit/scripts-install-storage-driver.test.ts`. Today's real population
is exactly one file (`scripts/orphan-file-sweep.ts`, matching on `runOrphanFileSweep`), already
compliant — its own doc comment will say so in the first paragraph, per the approval condition. If
this is judged too much for a task framed as small, I will do only (a) and (b) instead.

### Part 2 — DEF-307, the sentence only

`sweepOrphanedFiles`'s doc comment (`packages/domain/src/files/index.ts:215-220`) currently reads:

> *"if the row-delete commits and `driver.remove` then fails, the row is gone and the bytes are
> stranded — wasted storage, detectable and recoverable by a later sweep against the bucket."*

Established by `git grep` (T-272's Q3, DEF-307's own filing): no such sweep exists anywhere in this
repo, and the storage driver interface (`driver.ts`) has no `list` method at all — the sentence
describes something not merely unbuilt but unbuildable against today's driver contract. Corrected to
defend the residual on its real merits, not an aspirational one:

> *"if the row-delete commits and `driver.remove` then fails, the row is gone and the bytes are
> stranded — wasted storage. ⛔ **DEF-307 — NOT currently detectable or recoverable**: that would
> need bucket enumeration compared against `stored_files`, and the storage driver interface has no
> `list` method at all, so nothing today can find these bytes. Accepted anyway because it is
> preferred over the alternative (a live row pointing at deleted bytes, which is silent,
> unrecoverable data loss)..."*

⛔ Not building bucket enumeration — out of scope, per instruction, and it would be a design
decision (a new driver method, on every adapter) far bigger than a sentence.

### The question — is there a mechanical substitute for planting a violation?

**Partially, for one of the three shapes this week actually took, not for the other two.**

Three distinct failure shapes have shown up, and they are not the same defect wearing different
clothes:

1. **Missing scan ROOTS** (DEF-295, and — found while answering this question, see below —
   `auth-transaction-callers.test.ts` today). The "correct" set of roots is a STRUCTURAL fact
   independently derivable from the repo (every top-level source directory that exists), so a
   mechanical, automatable check is genuinely possible: assert the guard's declared root list
   equals (or is a superset of) `packages/*/src` + `apps` + `scripts`, derived fresh from
   `git ls-files`/the workspace glob, on every run. This would have caught DEF-295 and would catch
   the finding below, cheaply, with no plant needed — because there IS a ground truth to diff
   against that isn't the guard's own code.
2. **A hardcoded single FILE standing in for a directory scan** (DEF-304). This is really case 1 in
   its most extreme form — one "root" that is a file, not a directory — and the same structural
   check generalizes: if a guard's population is described as "every X under `packages/domain/src`"
   but its extraction reads one named path, that mismatch between the DOC COMMENT's claimed scope
   and the CODE's actual scan target is, in principle, greppable (a guard whose doc comment says
   "across" or "every" but whose scan constant is a `.ts` file rather than a directory prefix) —
   weaker than case 1's check because it depends on the doc comment being honest, which is the exact
   thing already in question, but a plausible lint rule nonetheless.
3. **A classification/shape bug WITHIN a correctly-scoped scan** (the `orgId` exclusion-filter false
   positive, found while measuring T-275, never shipped). **No structural cross-check catches this**,
   because there is no independent ground truth for "which functions are per-org helpers" — that is
   a semantic judgment about the codebase's own conventions, not a fact derivable from file layout.
   The only way to find it is to either enumerate every real match by hand against the filter (what
   T-275's spec actually did) or construct a concrete instance and watch the guard decide — which is
   the plant, done once in the head instead of once in a file.

**What the plant specifically establishes that a size floor or a passing suite does not:** a green
result before a fix proves nothing about the fix's target — it only proves the guard didn't
regress on what it ALREADY checked. Only exhibiting a concrete violator and watching the verdict
flip from green to red proves the guard's population is what it claims, and only removing that same
violator and watching it flip back proves the fix didn't just widen the assertion into something
permanently red or accidentally trivial. A `size > N` control (already present in every guard named
this week) catches "scanning nothing"; it cannot catch "scanning the wrong, non-empty set," because
wrong-but-non-empty and right both satisfy `size > N`. That is the whole reason DEF-295's SCAN_ROOTS
sat wrong for as long as it did with a working positive control already in place.

**One real finding from asking this question, named per instruction, not fixed:**

⛔ **`tests/unit/auth-transaction-callers.test.ts:32`** — `SCAN_ROOTS = ['apps',
'packages/auth/src', 'packages/domain/src']`, three roots. Its own doc comment (line 20) says *"this
is deliberately the SAME shape as the systemTransaction guard"* — but `system-transaction-callers
.test.ts`'s `SCAN_ROOTS` (line 65-76, post-DEF-295) has **ten**: `apps`, `scripts`,
`packages/auth/src`, `packages/core/src`, `packages/db/src`, `packages/domain/src`,
`packages/etl/src`, `packages/etl-firestore/src`, `packages/storage-firebase/src`,
`packages/sync-firestore/src`. `authTransaction` is exported from the SAME public barrel as
`systemTransaction` (`packages/db/src/index.ts:42`, confirmed by `git grep`), so nothing structural
stops `scripts/`, `packages/etl/src`, `packages/etl-firestore/src`, `packages/storage-firebase/src`,
`packages/sync-firestore/src`, `packages/core/src`, or any other file under `packages/db/src` besides
its own definer from calling it today with zero test failure. This guard also has no `DEFINER_FILES`
exemption at all — it excludes the whole `packages/db` root rather than scanning it and exempting
the one definer file, which is narrower than necessary in a second way. Same defect class as
DEF-295, in the sibling guard DEF-295 did not touch. Not fixed here — outside this task's scope
(the file isn't in my grant), reported per instruction.

I checked every other `SCAN_ROOTS`/`*_ROOT`-shaped constant across `tests/unit/*.test.ts` for the
same shape (`DOMAIN_ROOT`, `APP_ROOT`, `SHELL_ROOT`, `DOMAIN_SRC_ROOT`) and found no other instance —
each of those is a single root that genuinely matches its guard's single-tree claim (e.g.
`domain-actions-have-callers.test.ts` scans all of `packages/domain/src`, matching its own stated
population).

### ⭐ Revised, after `system32-85`'s pushback — the sharper lesson

Asked directly: is the real lesson *"plant when there is no ground truth"*, or *"the diff has to be
a TEST rather than something a careful reader could do"*? **The second, and it is a correction, not
a restatement.** DEF-295 and DEF-310 are BOTH shape 1 — a missing scan root, with the repo's real
directory layout sitting there the whole time as independent, structurally-derivable ground truth —
and both survived anyway, for weeks in DEF-295's case, because nobody had encoded *"declared roots
== actual roots"* as a running assertion. A check that COULD be mechanical and never gets written
down as a test is, from outside a green suite, indistinguishable from one that structurally cannot
exist. Careful reading was available for both defects and did not catch either; the RLS census that
found DEF-295 and the tightened-role reading that found DEF-310 both happened as side effects of
someone doing something else, not as a standing check anyone could point to and trust.

So the three-way split (structural ground truth / degenerate single-file case / no ground truth at
all) is still the right map of WHERE a mechanical check is *possible* — that part stands. What it is
not is a safety ranking. **Possibility of a mechanical check is not protection; only an actually-
running assertion is, and the only way to know a specific guard's assertion is both present and
correct is to plant a violator against it and watch the verdict flip — for all three shapes, not
only the one with no ground truth.** A structural cross-check (declared roots vs. `git ls-files`
grouped by top-level directory, e.g.) is worth building where ground truth exists, because it is
cheaper to run forever than a human noticing — but its existence is not the finish line any more
than `sweepOrphanedFiles` existing was DEF-299's finish line. The finish line, every time this week,
was the plant: something failing, then something passing, both watched, not inferred.

### Out of scope

- `apps/**`, including reading-not-editing `instrumentation.ts` — read for pattern reference only.
- `packages/domain/src/fiscal-periods/**`, `packages/domain/src/scheduler/index.ts` — untouched.
- Fixing `auth-transaction-callers.test.ts`'s stale `SCAN_ROOTS` — named, not built.
- Building bucket enumeration for DEF-307 — the sentence is corrected, the capability is not built.
- `docs/DEFECTS-REGISTER.md`, `PROJECT_BIBLE.md` — reporting, not editing.

### Tests / Done-when

Unit-only; no integration DB involved. typecheck clean · `npm run test` green, including the new
guard if approved · self-reviewed line by line · this file's status line updated at the end.

# T-294 — DEF-307: correct the sentence, then decide whether the sweep it promises is worth building

> **Status: ACCEPTED 2026-09-12 by system32-85 — assessment complete, no build. Lane B
> (webapps-65).** Piece 1 confirmed already fixed (T-277/`c74eba5`); DEF-307's register
> disposition to be corrected by system32-85, attributed to T-277, not this task. Piece 2's
> recommendation (do not build bucket enumeration/reconciliation) adopted as written, including
> the mechanical wake-up trigger in §"Recommendation" below.

Source: `docs/DEFECTS-REGISTER.md` DEF-307. Two separable pieces per the briefing; this spec
measures both before proposing anything, per instruction.

## ⛔ Piece 1, measured first: it is already fixed. The register row is stale, not the code.

Read `packages/domain/src/files/index.ts:214-224` (the current, live doc comment) before assuming
DEF-307's row describes today's file. It does not.

```
⚠️ The accepted residual, named rather than hidden: if the row-delete commits and
`driver.remove` then fails, the row is gone and the bytes are stranded — wasted storage.
⛔ DEF-307 — NOT currently detectable or recoverable. That would need bucket enumeration
compared against `stored_files`, and the storage driver interface (`./driver`) has no `list`
method at all, so nothing today can find these bytes. Accepted anyway because it is preferred
over the alternative (a live row pointing at deleted bytes, which is silent, unrecoverable data
loss), and is why the transaction is not held open across the `driver.remove` call to "fix" it —
that would trade a benign, if currently unrecoverable, failure for the worse one this task exists
to remove.
```

**This already says exactly what the briefing asked for** — *"preferred over the worse failure,
and currently not recoverable"* — not the sentence DEF-307's row quotes (*"detectable and
recoverable by a later sweep against the bucket"*).

Checked by `git log`, not assumed: `git log --oneline -- packages/domain/src/files/index.ts`
shows `c74eba5` — **"T-277/DEF-308 + DEF-307: the storage-driver trap names its own cure, and a
guard catches the next one"** — and its diff (`git log -p`) replaces the exact old sentence with
the exact current one:

```diff
- * `driver.remove` then fails, the row is gone and the bytes are stranded — wasted storage,
- * detectable and recoverable by a later sweep against the bucket. That is preferred over the
+ * `driver.remove` then fails, the row is gone and the bytes are stranded — wasted storage.
+ * ⛔ **DEF-307 — NOT currently detectable or recoverable.** That would need bucket enumeration
```

**T-277 already shipped piece 1**, as a small inclusion alongside its main DEF-308 fix — its own
commit message says so ("+ DEF-307"). `docs/DEFECTS-REGISTER.md`'s DEF-307 row (disposition:
`verified`, i.e. open) was written during T-272's spec, BEFORE T-277 landed, and was never updated
afterward — the row's remedy column still reads "(1) correct the sentence... nearly free" as
pending work, and its description column still quotes the old sentence as if it were current.

⛔ **So there is no sentence for this task to correct, and no edit to `packages/domain/src/files/
index.ts` in this task.** Writing a "corrected" version would either duplicate what is already
there or, worse, drift from it. **Recommended: system32-85 marks DEF-307 piece 1 `FIXED` in the
register, attributed to T-277/`c74eba5`**, the same way DEF-303's row was corrected when T-272's
own units closed it (`tests/unit/scheduler-job-hosting.test.ts`'s own history). Not filed by this
task — reported.

## Piece 2 — the assessment, per `/research-evaluate-propose` (RULES §4, bible row 163)

### The number the question asked for: **zero**, measured, not estimated

**How often has `driver.remove` failed after a committed row-delete, for real? Zero times, because
the job has never had a real organisation to run it against.**

Measured, not assumed:
- `docs/ops/README.md`'s own most recent status section (2026-09-12, "second cycle" — the newest
  dated entry in the file, which is the one that ARMS `shareat-orphan-file-sweep.timer` for the
  first time) states in terms: *"BOTH WILL EXIT 1 TODAY — zero organisations — and that is the
  correct answer"* (`docs/ops/README.md:469`), and *"Both scripts treat zero organisations as a
  FAILURE, by design"* (`:429`).
- `sweepOrphanedFiles(orgId, ...)` is per-org (T-272/DEF-299) and is reached only via
  `listOrgsToRun()`, which returns nothing when there are no organisations. **Zero orgs means the
  loop body that could ever call `driver.remove` against a real object has never executed once in
  production.** Not "the failure is rare" — the whole code path is unexercised against real data,
  full stop.
- So `scheduler_runs.failures` for `job = 'orphan_file_sweep'` in production is empty not because
  the mechanism is safe, but because there is nothing yet for it to have failed against. **The
  measured answer is genuinely "zero, and unmeasurable-as-a-rate until at least one real org
  exists,"** not "zero, therefore safe forever."

### What IS already proven, separately from the production count

`packages/domain/tests/integration/files.test.ts` (~line 380-407) injects exactly this failure —
`driver.remove` throwing `'bucket: object locked'` after the row-delete already committed — and
asserts the row is gone, the bytes remain, and the failure is `findable here by \`path\`, not
silent` (the doc comment's own words): `result.failed` carries `{ path, error }`, which
`runJobForOrg` writes into `scheduler_runs.failures` (T-233/DEF-219) for every real run too. **So
the EVENT is never silent — an operator who looks at a run's `failures` array today already sees
the exact path.** What bucket enumeration would add is not "notice it happened" (already covered)
but "audit the bucket independently of whether anyone looked at that run's row" — a narrower gap
than DEF-307's own framing suggests.

### The cost, named rather than left an afterthought

Building bucket enumeration plus a reconciliation job means:
1. **A new `list`/enumerate method on the `StorageDriver` interface** (`packages/domain/src/files/
   driver.ts`) — every implementation must add it: the in-memory dev/test driver (trivial, iterate
   a `Map`) AND the real Firebase driver (`packages/storage-firebase/src/index.ts`), which means
   real, paginated `bucket.getFiles()` calls against Google Cloud Storage — a genuinely different
   API shape from the four methods `StorageDriver` has today (`put`/`get`/`signedUrl`/`remove`),
   each of which touches ONE object; `list` touches an unbounded, growing collection and needs its
   own paging loop, retry policy, and cost accounting (Cloud Storage lists are billed operations).
2. **A reconciliation job**: enumerate the bucket (paginated, potentially large — this bucket holds
   every receipt, payment proof and export for the life of the business), enumerate `stored_files`
   for the same org, diff the two sets, and decide what a "found in bucket, no row" object even
   means (T-141 §8's own three-way ambiguity: a genuine DEF-307 residual, an in-flight upload whose
   row insert has not committed yet, or an object from BEFORE this scheme existed) — each needs a
   different disposition, and getting the in-flight case wrong risks deleting a file mid-upload.
3. **A new scheduled job, its own `scheduler_runs` entries, its own timer, its own place in
   `docs/ops/README.md`** — the exact ceremony T-272/T-273/T-279 already exist to make cheap for a
   job that has real work to do; this one would have processed zero real findings for the entire
   time production has existed, by the measurement above.

### Recommendation: do not build it now. Revisit when there is a real incident to weigh it against.

**Say the number, not the adjective, per RULES §4: expected utilisation today is zero, cost is
real (a driver-contract change touching every implementation plus a new job with its own
operational surface), and the thing the residual is traded against — a live row pointing at
deleted bytes — is already avoided by the existing delete-then-remove ordering (T-267/DEF-298).**
Recommending against is the sanctioned answer here, not a fallback: building bucket enumeration
today would be inventing a remedy for a failure this project has not yet had the opportunity to
observe once, in exchange for a real, ongoing engineering and operational cost.

**The trigger that should reopen this, named so it is not lost:** the first time a real
organisation's `orphan_file_sweep` run shows a non-empty `failures` array whose error text
indicates `driver.remove` failed (not `deleteFile` failing first, which is a different, harmless,
retryable case) — at that point there is a REAL incident, a real bucket, and a real rate to design
against, instead of a hypothetical one. Nothing needs to be built to make that trigger visible:
`scheduler_runs.failures` already carries it, per the mechanism proven above.

## Scope

Only:
- `docs/tasks/294-def-307-bucket-reconciliation-assessment.md` — this file.

`packages/domain/src/files/index.ts` is in the briefing's named scope but **not edited** — Piece 1
is already correct (see above); an edit here would be a change with nothing to fix.

Not touched: the storage driver contract or any driver implementation (`packages/domain/src/files/
driver.ts`, `packages/storage-firebase/src/index.ts`) — assessed, not built, per the briefing.
`vitest.config.mts`, `tests/unit/scheduler-*` (lane A) · `apps/erp/**` (`webapps-f7`) ·
`packages/db/schema/access.ts`, `packages/domain/src/people/**` (`f2`, live) ·
`docs/DEFECTS-REGISTER.md` (piece 1's stale disposition — reported, not corrected here).

## Done-when

Self-reviewed · the piece-1 staleness finding and its exact citations (`c74eba5`, the diff, the
current file's matching text) reported to system32-85 · the piece-2 assessment's number (zero,
measured) and its citations (`docs/ops/README.md:429,469`, `listOrgsToRun`, the integration test)
reported · no code changed anywhere, per the task's own framing as an assessment · this file's
status line updated to READY once acknowledged.

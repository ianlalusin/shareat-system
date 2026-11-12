# T-561: an outage kitchen ticket is never marked printed unless it was printed or saved for reprint (audit P-005)

**Status:** SPEC 2026-11-11 (AUDIT). Number from the orchestrator (BOARD). Source: `shareat-audits/OPEN/2026-11-09-pos-domain.md`,
P-005. No migration (browser IndexedDB meta only). Branch `audit/t561-outage-print-recovery`, worktree `wt-audit-t561`.

## 1. Problem (apps/erp/src/app/pos/_kitchen/outage-replay.ts `printUnprinted`)

While offline, each new order event gets kitchen tickets. Today `printUnprinted` writes every fresh event seq into
`app.outagePrinted` FIRST (inside `locked`), then calls `printOutageForEvent`. Two failures follow:
- If `printOutageForEvent` throws before a PrintJob exists (for example, the kitchen-counter write fails), the callers in
  `use-outage-replay.ts` swallow the error (`.catch(() => undefined)`). The seq stays marked printed, later replays skip it,
  and the kitchen never gets the order. Nothing tells staff.
- If the tab closes or crashes between the mark and the print, the same silent loss happens.

## 2. Rule

Once per event, and never silently lost:
- A seq is marked printed only after `printOutageForEvent` returned normally. Its failed jobs already go to the existing
  failed/reprint path; keep that.
- While an event is being printed, its seq is recorded as **in flight** in its own meta key, next to `OUTAGE_PRINTED_KEY`,
  for example `app.outageInflight`. It is written before printing and cleared after.
- If `printOutageForEvent` throws, clear the seq from in flight and do NOT mark it printed, so the next replay retries it.
  Return a non-null `message`, using the existing failed-print wording or a plain new sentence, so the screen can show that
  something did not print. The hook must surface that message rather than swallow it. Use the existing message path; read
  how `PRINT_FAILED_NOTE` reaches the screen.
- A seq still in flight at the start of a replay was interrupted by a crash or tab close, so it is UNCERTAIN. Do not print
  it again automatically. Mark it printed, and put it in front of staff for an explicit reprint through the existing
  reprint list (`OUTAGE_REPRINT_KEY`, `readReprintJobs`/`writeReprintJobs`), with a visible message. If building a reprint
  job for it would need the counter or other state that is not available, a clear message naming the table or event is
  enough. Choose the smallest option that uses the existing reprint UI, and say which one you chose.
- Keep the `locked` queue so overlapping calls never lose an update to either set. Keep `pruneOutagePrinted*` working, and
  prune in flight the same way.

## 3. Tests (first, red on the old code)

Extend `apps/erp/tests/t529-outage-replay.test.ts` (fake meta and fake printer, as it does today):
- (a) `printOutageForEvent` throws for event 2 of 3. Events 1 and 3 are printed and marked; 2 is NOT marked; the message is
  non-null. A second replay retries 2.
- (b) A leftover in-flight seq from a "crash": the next replay does not print it again, it reaches the reprint list or the
  message, and it ends up marked so it is not offered forever.
- (c) The normal path is unchanged: every event is printed once, and a second replay prints nothing.
- (d) If the hook test file covers the swallowed catch (`t529-shell-hooks.test.ts`), add a case showing the message now
  reaches state.

## 4. Checks

The t529 test files pass, as do all `apps/erp/tests/*pos*`, `*outage*` and `*kitchen*` unit tests. Root `npm run typecheck`
is clean. Unit guard and census files pass. No CR or control bytes. The diff touches only `_kitchen` files, their tests and
this spec.

## 5. Acceptance

No outage kitchen ticket can be silently lost. Either it printed, or staff see that it did not and can reprint it. Nothing
prints twice without staff choosing to. P-005 closes after merge.

## 6. Built note (builder, 2026-11-11)

Leftover-in-flight option chosen: **rebuild the paper and put it on the existing Reprint list.** A crash leftover whose event is still pending is run through
`printOutageForEvent` with a capture printer (prints nothing, returns the jobs as `failed`), so staff see the normal "Kitchen ticket did not print. Tap Reprint."
banner with the real ticket behind it. Then the seq is marked printed and cleared from in flight, so it is offered once. Why: the counter and menu are in `deps`
at that point, so no new job format or message-only dead end was needed. If the paper cannot be built, the seq stays in flight and is offered next replay.
A print that throws returns `PRINT_RETRY_NOTE`; `outage-jobs.tsx` gained a small notice (`reportOutage`, `outageNotice`) so a message with no job still shows
on the banner. Both hooks now call `reportOutage` and `reportOutageError` instead of swallowing. In-flight seqs of the current page are tracked in a module `active` set so
two overlapping replays never mistake each other for a crash. Known limit (commented in code): two tabs of one till would see each other's in-flight seq as a leftover;
that goes to Reprint, never prints twice.

## 7. Revision 1 - audit follow-up on c633ba7 (AUDIT, 2026-11-12; Codex F1 + F2, both confirmed from source)

No new number: same task, same PR. Files: `apps/erp/src/app/pos/_kitchen/outage-replay.ts`, `outage-jobs.tsx`, `apps/erp/tests/t529-outage-replay.test.ts`, `apps/erp/tests/t529-shell-hooks.test.ts` (only if it covers `reportOutage`), this spec. No migration.

**F1 - the printed mark must not run ahead of the saved Reprint job.** Today a failed job (a crash leftover's captured ticket, or a ticket the printer refused) is only in `total.failed`; the seq is marked printed first, and the job is saved later by `reportOutage` -> `set` -> a fire-and-forget `writeReprintJobs` that swallows failure. A close or crash between the mark and that write loses the paper silently.
Rule: inside `printUnprinted`, for each event whose result has `failed` jobs, append those jobs to `OUTAGE_REPRINT_KEY` (read the saved list, add, write) inside `locked`, and `await` it BEFORE the seq is added to `app.outagePrinted`. If that append throws:
- crash-leftover path: the seq stays in flight, is not marked printed, and the replay returns the new `RECOVERY_FAILED_NOTE` message (see F2); the next replay tries again.
- normal path: the seq stays in flight (NOT cleared, NOT marked printed; remove it from the module `active` set only), so the next replay treats it as a crash leftover and offers it to Reprint rather than printing again (some jobs may already be on paper); `threw = true` so `PRINT_RETRY_NOTE` is returned.
Events with no failed jobs are unchanged (mark after print). `reportOutage` must not be the first place a job becomes durable: since the jobs are now already saved, have `reportOutage` refresh the in-memory list FROM the saved list (`readReprintJobs`, made to run inside `locked`) instead of appending `r.failed` again (appending would duplicate after `restore()`); if that read throws, fall back to appending `r.failed` in memory. `set(next, persist)` for the refreshed list must pass `persist = false`. Do not de-duplicate by content: two identical tickets are two tickets.

**F2 - a failed crash recovery must warn.** In the leftover loop, the `catch` that `continue`s must set a local `recoveryFailed = true`. Export `RECOVERY_FAILED_NOTE = 'A kitchen ticket from before the restart could not be rebuilt. It will retry; tell the kitchen.'`. Message precedence: `threw` -> `PRINT_RETRY_NOTE`; else `recoveryFailed` -> `RECOVERY_FAILED_NOTE`; else `total.failed.length > 0` -> `PRINT_FAILED_NOTE`; else null. The event stays in flight (already so). Skipped on purpose: naming the table in the message (the leftover may have no label); say so in the built note.

**Tests first (red on c633ba7), in `t529-outage-replay.test.ts`:**
- (d) F1 crash leftover: seeded in-flight seq 4 + a `setMeta` wrapper that throws when the key is `OUTAGE_REPRINT_KEY` -> seq 4 is NOT in `app.outagePrinted`, IS still in flight, message is `RECOVERY_FAILED_NOTE`; with a working `setMeta` the next replay saves the job to `OUTAGE_REPRINT_KEY`, marks 4 printed, clears in flight.
- (e) F1 normal path: a printer returning `'failed'` -> after `printUnprinted` returns, `meta.store.get(OUTAGE_REPRINT_KEY)` already holds the failed job(s) AND the seq is in `app.outagePrinted`; and with a `setMeta` that throws for `OUTAGE_REPRINT_KEY` the seq is in flight, NOT printed, message `PRINT_RETRY_NOTE`, and the next replay (storage fixed) does not print it again but saves its job.
- (f) F2: seeded in-flight seq + a `setMeta` that throws on `KITCHEN_TICKET_SEQ_KEY` -> `res.message === RECOVERY_FAILED_NOTE`, `res.failed` empty, seq still in flight, not printed.
- hook/state case in `t529-shell-hooks.test.ts` if it already drives `reportOutage`: with the saved list holding the job, `reportOutage` shows it once, not twice.
Old tests (a)(b)(c) stay green; (b) must now also see the job in `OUTAGE_REPRINT_KEY`.

## 8. Built note (revision 1)

F1: `printUnprinted` now saves failed jobs to `OUTAGE_REPRINT_KEY` inside `locked` (private `addReprint`, using `readJobs`; `readReprintJobs` is now the locked read) before the seq is marked printed. A save failure on the normal path leaves the seq in flight (only dropped from `active`) and returns `PRINT_RETRY_NOTE`; on the crash-leftover path it leaves the seq in flight and sets `recoveryFailed`. A failed save does not put the jobs in `res.failed` (the next replay rebuilds them). `reportOutage` re-reads the saved list into memory with `persist = false`, falling back to appending `r.failed` in memory if the read throws; `addFailedPrintJobs` is now unused. F2: `RECOVERY_FAILED_NOTE` exported, with the precedence from section 7. Naming the table in the warning was skipped on purpose (the leftover may have no label). The hook test file does not drive `reportOutage`, so no hook case was added.

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

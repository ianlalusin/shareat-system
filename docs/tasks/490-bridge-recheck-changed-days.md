# T-490 — The nightly POS bridge re-checks a day when a late receipt, void or day feed changes it

**Status:** spec written 2026-10-26 (Opus planner, AUDIT session). Source: Codex audit tenth pass, finding F13
(`C:\Users\ianla\shareat-audits\OPEN\audit-2026-10-25-tenth-pass.md`) and the draft plan
`C:\Users\ianla\shareat-audits\DRAFT-F13-F14-fix-plan.md`; re-verified on origin/main 26605d1. Branch
`audit/t490-bridge-recheck-days`. Defect DEF-781. Numbers from the orchestrator (BOARD.md).

## Finding — DEF-781 (P2, money control: a day check can stay "match" or "pending" after the day changed)
`packages/domain/src/pos/receipt-bridge-job.ts`:
- `:276-282` the days to check are `yesterday` plus window days that have NO check row yet
  (`posBridgeRepo.datesWithChecks`, `packages/db/src/repo/pos-bridge.ts:298`).
- `:358-371` step 2 reads change-time queries (`voidedAt` / `editedAt` / `createdAt` since `since`) and writes those
  receipts for ANY date via `writeAll`, but adds no date to the check set.
- `:376-414` step 3 recomputes and upserts a day check only `for (const date of dates)` with `readOk.has(date)`.
So once a day older than yesterday has a check (`match`, `mismatch` or `pending`), a late offline receipt, an in-place
void or edit, or a day feed that arrives later never updates it. Result values (`schema/pos-bridge.ts:54,205`):
`match` | `mismatch` | `pending` (pending ⇔ no day feed yet).

## Rulings
1. `writeAll` (`:296-313`) returns the set of `posCalendarDate`s of receipts it actually wrote (`res === 'written'`);
   `writeOne` (`:430-445`) already knows each receipt's date at `:438`.
2. After step 2, a **refresh set** = (dates written by step 2, at or after `POS_BRIDGE_WRITE_FLOOR`, not already in
   `dates`) ∪ (window dates whose existing check is `pending`).
3. For each refresh date, recompute from local Postgres only — `dayNet`, `dayFeedTotalCentavos`, the same
   match/mismatch/pending rule as `:384-385` — and `upsertDayCheck`. A refresh date never calls `markGone` (change-time
   reads are not a full inventory of the day) and never triggers a Firestore day read: the read budget (header
   `:11-20`, test B1 `t472-s2-receipt-bridge.test.ts:427-435`) stays exactly as it is.
4. A mismatch found on a refresh date adds the same notice line as `:401-409`. Run counters and the run record are
   unchanged except a count of refreshed days if the run record already has a natural place for it (do not add a
   column).
5. Keep the existing helper names; extract the day-check computation into one local function used by both step 3 and
   the refresh, rather than copying it.

## Tests (red first, real Postgres, dedicated fresh *_test DB) — extend `t472-s2-receipt-bridge.test.ts` (new section)
Using `_fixtures/pos-bridge.ts` (FakePort, receipt, YESTERDAY, NOW):
(1) night 1 checks day D (older than yesterday) as `match`; night 2's change-time query returns a late receipt dated D
→ D's check is recomputed (net changes; `mismatch` if the feed no longer agrees). (2) day D `pending`; its day feed
lands in Postgres before night 2, no receipt changes → D becomes `match`/`mismatch`. (3) a refresh date never mints a
`gone` receipt version. (4) B1/B2/B3 read counts unchanged (FakePort listDay/cross/listMissing still called only for the
same dates). (5) a change-time receipt dated before the write floor does not create a check.

## Files
`packages/domain/src/pos/receipt-bridge-job.ts`, `packages/domain/tests/integration/t472-s2-receipt-bridge.test.ts`,
`_fixtures/pos-bridge.ts` only if a FakePort hook is missing, `packages/db/src/repo/pos-bridge.ts` only if a read helper
for existing pending checks is missing, `docs/DEFECTS-REGISTER.md` (section E, DEF-781). Nothing else.

## Acceptance
New tests red on 26605d1 for the stated reasons, then green; the whole `t472-s2-receipt-bridge.test.ts` and other
`pos-bridge`/T-472 tests green; root typecheck clean; guard/census unit files green.

## Revision 2026-10-26 (after the PR #76 review, Sonnet auditor via the orchestrator)
Rulings 2 and 3 are replaced by a simpler, wider rule that also closes review points 1-3:
- **Refresh set** = every window date (`windowStart`..`yesterday`) at or after the floor, PLUS every date a change-time
  receipt was written onto (at or after the floor), MINUS every date in tonight's `dates` (read in full or not).
  ⚠️ Correction (planner, same day): do NOT re-check a partly-read day. Such a day has no check row, which is exactly what
  makes the next night re-read it in full (`!have.has(d)`); writing a check for it would stop that re-read, and its missing
  receipts would never be fetched. Point 1's residual case (a partly-read day that already had a check) is covered from
  the next night by the whole-window re-check. A day feed revised after a `match`/`mismatch` is caught within the window
  (point 2); an `unchanged`/`raced` write after a crash no longer matters, because the whole window is recomputed
  (point 3). `pendingCheckDates` is no longer needed: remove it if unused.
- Still Postgres only: no `markGone`, no Firestore day read; B1-B3 unchanged. Cost: at most 7 Postgres recomputes per
  store per night.
- A `--date` run refreshes nothing beyond its own date (unchanged behaviour), and a dry run refreshes nothing.
- Point 4 (last-writer-wins `upsertDayCheck`): if the job already serialises runs per org (check the existing run lock /
  concurrency tests, section C), no change; say so in the PR. Only if two runs can really overlap, keep the newer result
  by comparing `checked_at` in the upsert.
- Tests to add (point 5): a partly-read day is NOT given a check tonight (so it is re-read in full next night); a `match` day whose feed is
  revised later is re-checked to `mismatch`; a window day with no change is re-checked and unchanged (no new notice);
  a date older than `windowStart` with no change is NOT re-checked; a `--date` run refreshes nothing else.

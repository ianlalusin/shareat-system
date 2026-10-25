# T-478 — The POS bridge cross-check finds receipts that really lack client time

**Status:** spec written 2026-10-25 (Opus planner, AUDIT session). Source: Codex audit sixth pass (2026-10-24,
`C:\Users\ianla\shareat-audits\OPEN\audit-2026-10-24-sixth-pass.md`, finding 11, P2), re-verified on
`claude/pos-t472-bridge` 7e2c334 (POS session; local only, not pushed). Branch `audit/t478-pos-missing-client-time`
stacks on it. Defect DEF-775. Numbers from the AUDIT block. No spec defect: T-472 Ruling 2 asks for "docs missing
`createdAtClientMs`"; the implementation measured something else.

## Finding — DEF-775 (P2, completeness check)
`packages/etl-firestore/src/pos-receipts.ts` `crossCheckDay` (:101-120) returns
`missingClientMs = max(0, countByServerDay - countByClientDay)`. The two counts are different sets, not a set and its
subset: an offline receipt sold on day D and uploaded on D+1 is in D's client count and D+1's server count. Example:
receipt A client-time D, server-time D+1; receipt B no client time, server-time D. For D both counts are 1, so the
check says 0 missing while `listDay(D)` cannot see B. A receipt from D-1 uploaded on D instead reports a false gap.
The test (`tests/pos-receipts.test.ts:223-240`) puts every timestamped receipt on the same day, so it cannot see this.

## Rulings
1. **Count the real subset.** Keep `byClientMs` and `byServerCreatedAt` (aggregate counts, drift information only).
   Compute `missingClientMs` by enumerating the server-day documents (`createdAt` in the day) with the existing
   `page()` helper ordered by `createdAt`, and counting those whose `createdAtClientMs` is absent or not a finite number.
2. **Name them.** Add `missingClientMsIds: readonly string[]` (document ids, in page order) so the later job slice can
   read exactly those receipts; the doc comment says the job must import them, because `listDay` never returns them.
3. Doc comments on `PosDayCrossCheck` stop describing `missingClientMs` as a subtraction. Read-only as before: no
   write call (the existing guard test must stay green).

## Tests (red first) — `packages/etl-firestore/tests/pos-receipts.test.ts`, fake Firestore, no live Firebase
- the auditor's case: A (client D, server D+1) and B (no client time, server D) → for D `missingClientMs = 1`,
  `missingClientMsIds = ['B']` (old code returns 0);
- a receipt with client time D-1 uploaded on D and no missing docs → `missingClientMs = 0` (old code returns 1);
- `createdAtClientMs` present but not a number (string / null) counts as missing;
- the existing same-day case keeps its counts and now lists `['b','c']`;
- more than one page of server-day docs (e.g. 1203) is fully enumerated.

## Files
`packages/etl-firestore/src/pos-receipts.ts`, `packages/etl-firestore/tests/pos-receipts.test.ts`,
`docs/tasks/472-*.md` (one line under Ruling 2 pointing here), `docs/DEFECTS-REGISTER.md` (DEF-775). Nothing else.

## Acceptance
New tests red on 7e2c334 for the stated reason, then green; `packages/etl-firestore` tests and typecheck green;
`tests/unit/*guard*`, `*census*`, `app-boundaries` green.

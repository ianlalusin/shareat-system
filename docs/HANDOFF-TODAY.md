# Handoff — 2026-10-02 (orchestrator, money-defect push day 3)

## Where things stand
Goal (Ian): close every open money defect in v2; NOT launched. T-369 (unwired money screens) is mostly shipped: S0–S4,
S5a, S6a and S7 are on `main` (8 commits, `ad08751`…`5b8aeb7`, plus today's gate fixes). Lane work in progress is
**not on `main`**. It is saved on the pushed branch **`wip/2026-10-02`** (`809ca57`): T-368 S2+S3 built and green
on the lane but NOT audited, plus red tests for eight more slices. The What's Left board shows **22 open money
defects**. Closed today: DEF-550, 479, 302. New: DEF-551 (being fixed), 553, 555, 556, 557, 558, 559 (money), and
552 and 554 (not money).

## Gates at the wrap-up commit (`main`, after today's fixes)
See the commit message of the wrap-up commit for the final numbers. As run: typecheck **0** · unit **3666/3674**
in the full run; the 2 real reds were caused today and are fixed in the wrap-up commit (13/13 solo); the rest were
load timeouts that pass solo (61/63 → 63/63) · integration: full suite on a FRESH `shareat_test_gate` (see the commit)
· build **skipped — dev server live on 9008**.

## What happened (themes; every ruling recorded)
- **T-369 shipped:**
  - S0: void a supplier payment from the bill page, DEF-550.
  - S1: reimbursement payout screen, half of DEF-198.
  - S2: "View photo" plus the /files route, the other DEF-198 half.
  - S3: edit or withdraw an unverified sales day, DEF-479.
  - S4: closed-month stock refused in words, DEF-302.
  - S5a: admin late payout into a closed month, half of DEF-314.
  - S6a: transfer pickers scoped, half of DEF-291.
  - S7: a withdrawn day frees its date; manager-only re-entry; migration **0177**, applied to the smoke DB.
- **Ian's rulings: bible §13 rows 263–268.**
  - Supplier-payment void date is picked by the person.
  - **15th/30th paydays supported**, T-370 A3/S3b; both defaults OK.
  - **Cross-store draws allowed with 1250/2150 legs** (DEF-551, S8); the same for collections and loans (DEF-556, S8b).
  - A **"settle between stores"** transfer (DEF-557, S9).
  - **Commissary receipt mismatches** (T-372 S6 amendment 2):
    - short → charge or loss;
    - over → `extra_dispatch`;
    - miscount → recount `return`, initiated by the manager of the store initiating the return.
  - **The auditor stays Sonnet.** A GPT-6 trial is recorded in `docs/reviews/external-audit-t369-s4.md`.
  - **Dev uses in-memory storage.** `FIREBASE_STORAGE_BUCKET` is commented out in `.env.local`, and the one test
    photo in `shareat-hub-v2` is deleted.
- **Specs written or amended today (Opus planner):**
  - T-369 S0, S8, S8b, S9;
  - T-370 Amendment A3 (S3b);
  - T-372 S6 amendments 1 and 2 (migration **0178**, reserved).
  - The next free migration index after 0178 is **0179**.

## Pick up here
1. **Restore and audit T-368 S2+S3.** Run `git checkout wip/2026-10-02 -- <paths>` (the builder's file list is in
   the WIP commit). Two of its tests are tester defects to fix first:
   - `t368-asset-terms-store` T9a expects 666.67, but the first month is 666.66;
   - `t346-in-service-date` I8 needs `acquiredOn <= 2026-01-01`.

   Then audit and commit.
2. **Build queue, in order.** Every one has its red tests on the WIP branch:
   1. T-369 S4 follow-up: the voidReturn sentence, and a single `now` for voidTradeOrder/voidCustomerReturn.
   2. T-370 S3b, then S3: the constraint key brings the count to 28 with S7's.
   3. T-367 S3/S4.
   4. T-368 S4.
   5. T-369 S8, then S8b and S9. The S8b and S9 test drafts were never run, so finish them first.
   6. T-372 S6, migration 0178. Gate it on the FULL suite on a fresh gate DB.
   7. T-372 S5: guard tests, green. Commit them.
3. **Before any push that deploys 0177/0178,** run the prechecks in `docs/ops/README.md` with Ian. Use SSH to root@159.223.46.224
   with `SYSTEM_DATABASE_URL`.

## Do not decide these alone — they are Ian's
- **HR statutory data:** SSS, PhilHealth, Pag-IBIG and TIN for 126 staff. Ian's to collect, due end of October.
- Nothing else is open on the Open Questions page
  (https://claude.ai/artifact/LMQCEXDZqHyAJz69FCy7FN). Read it at start anyway.

## Traps that bit today
- **Never share a lane's test DB.** Running regression on the tester's DB deadlocked it. Make your own
  (`make-test-dbs.mjs <name>`).
- **Shared count tests:** `constraint-messages` (key count) and `action-link-sweep` (census) are bumped by several
  slices. When committing one slice, stage only that slice's delta. Build the blob with `git show HEAD:<f> | … |
  git hash-object -w --path=<f> --stdin` (bytes, not Python text mode, which writes CRLF), then
  `git update-index --cacheinfo`.
- **Paths with `[id]` are globs** to git. Use `git --literal-pathspecs`. To snapshot WIP without touching `main`,
  copy `.git/index` to a temp `GIT_INDEX_FILE`, add, run `write-tree` and `commit-tree -p HEAD`, then `update-ref`.
- **Syntax errors hide type errors.** A tester file mid-edit made `tsc` stop early twice, and "typecheck clean" was
  claimed falsely once.
- **The machine runs low on memory** with three lanes, the dev server and a wide regression. Run regression in
  small batches.

## Sessions — all three SAFE TO CLEAR (re-brief from this file)
Tester `webapps-a2` · Builder `webapps-02` · Auditor `system32-2f`. All are stopped. None holds uncommitted work
of its own: everything is on `main` or on `wip/2026-10-02`. Lane DBs survive by name:
- `shareat_test_t369_s{0..8,8b,9}`
- `shareat_test_t368_s2`, `_s4`
- `shareat_test_t370_s3`
- `shareat_test_t367_s3`
- `shareat_test_t372_s5`, `_s6`
- `shareat_test_orch_reg`
- `shareat_test_gate` (fresh)

Smoke DB `shareat_test_setup` has migrations through 0177. Port 9008 runs on it with in-memory storage.

## The paste-ready prompt
```
You are the orchestrator for shareat-system (C:\Users\ianla\webapps\shareat-system). Run the global
/orchestrator skill. You are starting COLD. Read docs/HANDOFF-TODAY.md (all), docs/RULES.md, and
docs/plans/money-defects-2026-09-30.md. Read the Open Questions page (bible row 252) with ArtifactData
before building anything gated on Ian. GREP the register and bible, never Read them whole. Goal (Ian):
close all open money defects in v2; NOT launched. Queue: HANDOFF "Pick up here" 1→3; lane WIP is on
branch wip/2026-10-02 (restore with git checkout wip/2026-10-02 -- <paths>).
STANDING: lanes run Sonnet (auditor too — Ian 2026-10-01); Opus only via subagents for specs and
judgement. Commit slices locally; push ONLY at wrap-up; republish the What's Left board after every
commit that closes a DEF; every wrap-up updates "what's left", ROADMAP.html and the board. Reds assert
the target; every "not" gets a positive control. Each tester/helper gets its own _test DB — never run
on a lane's DB. Gate any CHECK/trigger migration on the FULL suite on a fresh gate DB. No git stash, no
lane dev servers, no mutants in the shared tree. Freeze lanes during gates. Messages are short. Render
before deciding. Ian runs this terminal on Opus 5.5 at medium effort; do not ask him to switch.
```

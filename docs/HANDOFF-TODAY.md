# Handoff — 2026-10-02 evening (orchestrator, money-defect push day 3, second session)

## Where things stand
Goal (Ian): close every open money defect in v2. **Not launched.** This session shipped 5 slices to `main`:

| Commit | Slice | Defects |
|---|---|---|
| `df05467` | T-368 S2+S3 | DEF-435, 436, 441, 442 |
| `cadf17d` | T-369 S4 follow-up | DEF-560 |
| `7edd8e2` | T-370 S3b | DEF-553, payout half |
| `59eb88e` | T-370 S3, migration **0178** | DEF-409, DEF-553 |
| wrap-up commit | T-367 S4 pin tests | DEF-395, overdraftLimit leg |

The What's Left board (https://claude.ai/artifact/7uvWzSMRGikq4P7PRmCQTf) shows **16 open money defects**.
**T-367 S3 is built but NOT on `main`.** It is saved on the pushed branch **`wip/2026-10-03`** (`5a3fa3e`). Older reds are still on
`wip/2026-10-02`.

## Gates at the wrap-up commit
typecheck **0** · unit **3736/3739** (1 skipped). The 2 reds are load timeouts that pass solo 45/45: `no-committed-secrets` ("Test timed out in 5000ms") and `t343-s7-wrapper-refusals` · integration: FULL suite on a fresh `shareat_test_orch_wrap1002`, **254 files, 4477/4477** · build **OK**. T-367 S3 is not in this tree; it is on `wip/2026-10-03`.

## What happened (themes; the record of each is where it lives)
- **T-368 S2+S3.**
  - Reversed depreciation re-books under `#N`.
  - The in-service and store-opening confirms are pinned by a `planToken`.
  - Asset terms lock once a month is booked.
  - No asset can be added at a deactivated store.
  - Audit follow-ups:
    - A month still owed in a CLOSED or locked period is skipped by the run. It is counted as `skippedClosed`, shown in the manual-run message, and recorded as a **notice** entry on the scheduler run row. A notice never counts as a failure, and it lives in the `failures` jsonb, so no migration was needed. T-345's list books the month.
    - Terms edits validate interval, category and salvage.
- **T-369 S4 follow-up.**
  - One clock per void.
  - DEF-560: a void refused part-way now rolls back.
  - The supplier- and customer-return void actions redirect with the sentence, with ids redacted, instead of throwing. Production shows a thrown action error as a digest.
- **T-370 S3b + S3.**
  - Ian's 15/30 payday (A3).
  - Semi-monthly cycles are refused on save, with CHECK 0178 behind it.
  - **Amendment A4 (R11)**, written by the Opus planner after an audit BLOCKER: `maxPayoutGapDays` was start-month dependent. It is now measured over a fixed horizon (2027-11..2032-03, gaps anchored on the earlier payday in 2028–2031). The planner checked it against all 26,937 configs and the auditor against 9,746, both against an independent truth, with 0 mismatches.
- **Orchestrator decisions** (recorded in specs and commits; none needed a bible row):
  - Migration **0178 → T-370 S3**, so **T-372 S6 is now 0179**; its spec was renumbered. **The next free index is 0180.**
  - The T-367 S3 malformed-date sentences were added.
  - The board was refreshed at the start of the session, because the last wrap-up had not done it (Ian asked).
- **Register:**
  - Fixed: DEF-409, 435, 436, 441, 442, 553, 560. DEF-395's overdraftLimit leg is noted.
  - New: DEF-561 to DEF-567. 563 and 564 are follow-ups. **566** (an invalid cash-flow date shows the generic 500 page in production) and **567** (the `t343-scheduler-status` unit test times out in every full run but passes solo) are the two to know.
- **Ian's input this session:** "update the whatsleft artifact first" (done), and approvals in the tester window. **No new rulings.** The Open Questions page has only HR statutory data open.

## Pick up here
1. **T-367 S3** (DEF-420, 499, 500). Restore it with `git checkout wip/2026-10-03 -- <the 5 paths in 5a3fa3e>`. Then:
   - **Tester:**
     - `t367-s3-invoice-total-due-date` T2 at :144 and :164: the regex `/S/` should be `/₱/`.
     - `ap-auto-allocate.test.ts`: the fixture's due dates (2026-01-05/-10) come before its invoice date (2026-01-10). R9 now refuses that, so move the invoice date earlier.
   - **Decide:** the builder added `assertLinesMatchGoods` in `ap/index.ts`. The root cause is `validateInvoiceLines`' 0.01 **float** epsilon in `items/index.ts`, which lets a whole centavo pass. The orchestrator leans to the root fix in `items` (centavo integers), because it covers every caller.
   - Then audit (the auditor has not seen S3), gates, and the §9.4 smoke from the spec.
2. **Queue, as before:**
   1. T-368 S4 (DEF-434; reds on `wip/2026-10-02`).
   2. T-369 S8, then S8b and S9. The S8b and S9 test drafts were never run, so finish them first.
   3. T-372 S6, now on **migration 0179**, gated on the FULL suite on a fresh gate DB.
   4. T-372 S5 guard tests (green; commit them).
3. **Prod, with Ian, before any push that DEPLOYS 0177/0178/0179:**
   - the prechecks in `docs/ops/README.md`;
   - **0178's precheck A**, which is in the migration header: live semi-monthly rows without two distinct days must be 0. Run it on `159.223.46.224`, never `.78.207`.
4. Low follow-ups worth a slice:
   - DEF-566: cash-flow page catches the refusal.
   - DEF-567: the scheduler-status timeout.
   - DEF-564: record/apply-credit actions show a digest.
   - T-370 S1 has **never been screen-tested** (owner cap). It needs payroll seeding.

## Do not decide these alone — they are Ian's
- HR statutory data (SSS, PhilHealth, Pag-IBIG, TIN for 126 staff). Ian is collecting it, due end of October.
- If 0178's precheck A returns rows on prod, Ian picks each store's two pay days. They are saved through `/settings/attendance` before deploy. No data surgery.

## Traps that bit this session
- **Lane DB collisions.** The tester ran once on the builder's `_s3b` DB, and `make-test-dbs` silently says "exists" for a name in use. Name DBs `<task>_<role>`.
- **0178 failed to migrate on a lane DB** that held one-day rows saved before the refusal existed. That is the precheck's case, live. `shareat_test_t370_s3` is left polluted on purpose.
- **A test that copies production code as its "reference"** shares the bug. T-370 P1 did, and only the auditor's brute force caught it.
- **Production redacts thrown errors** in server actions and server components to a digest (DEF-564, 566). Redirect with `?error=`; never `throw new Error(reason)`.
- **The forged session cookie expires after 1 h.** Re-mint it (`docs/SMOKETEST.md` §3).
- **Gates run on the working tree.** Snapshot unaudited WIP to a branch and restore the tree before gating `main` (done for T-367 S3).

## Sessions — all three SAFE TO CLEAR (re-brief from this file)
| Role | Session |
|---|---|
| Tester | `webapps-a2` |
| Builder | `webapps-02` |
| Auditor | `system32-2f` |

None holds uncommitted work. Lane DBs survive by name:

| Owner | DBs |
|---|---|
| Builder | `shareat_test_t368_s2b`, `shareat_test_t369_s4`, `shareat_test_t370_s3b`, `shareat_test_t367_s3b` |
| Tester | `shareat_test_t368_s2`, `shareat_test_t369_s4b_tester`, `shareat_test_t370_tester2`, `shareat_test_t367_tester` |
| Smoke | `shareat_test_t368_smoke`: migrated to 0178, seeded through the screens; SMK live policy [15,30] |

`.claude/launch.json` gained `erp-start-t368-smoke` (`npm run start` against that DB on 9008).

## The paste-ready prompt
```
You are the orchestrator for shareat-system (C:\Users\ianla\webapps\shareat-system). Run the global
/orchestrator skill. You are starting COLD. Read docs/HANDOFF-TODAY.md (all), docs/RULES.md, and
docs/plans/money-defects-2026-09-30.md. Read the Open Questions page (bible row 252) with ArtifactData
before building anything gated on Ian. GREP the register and bible, never Read them whole. Goal (Ian):
close all open money defects in v2; NOT launched. Queue: HANDOFF "Pick up here" 1→4; T-367 S3 is on
branch wip/2026-10-03, older reds on wip/2026-10-02 (restore with git checkout <branch> -- <paths>).
Next free migration index: 0180 (0179 = T-372 S6).
STANDING: lanes run Sonnet (auditor too — Ian 2026-10-01); Opus only via subagents for specs and
judgement. Commit slices locally; push ONLY at wrap-up; republish the What's Left board after every
commit that closes a DEF; every wrap-up updates "what's left", ROADMAP.html and the board. Reds assert
the target; every "not" gets a positive control. Each tester/helper gets its own _test DB — never run
on a lane's DB. Gate any CHECK/trigger migration on the FULL suite on a fresh gate DB. No git stash, no
lane dev servers, no mutants in the shared tree. Freeze lanes during gates. Messages are short. Render
before deciding. Ian runs this terminal on Opus 5.5 at medium effort; do not ask him to switch.
```

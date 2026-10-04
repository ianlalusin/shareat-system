# Handoff — 2026-10-04 (orchestrator, money-defect push day 5)

## Where things stand
Goal (Ian): close every open money defect in v2. **Not launched.** This session shipped T-371 (the NaN sweep),
T-373, the rest of T-369 and six of seven T-374 slices. **One money defect is open: DEF-054**, and it waits on the
T-367 count of old "other"/"AR collection" payments that only Ian can run on production. DEF-491 and DEF-421 stay
deferred by Ian's ruling. `main` is at the commit that carries this file; migrations on `main` run through **0181**,
production is still at **0176**. Next free migration: **0182**.

## Gates at 17616fc (main, before the docs commit)
typecheck **0** · unit **4082/4084** (1 skipped; 1 load timeout, `t343-s7-wrapper-refusals` passes alone 43/43) ·
integration FULL on fresh `shareat_test_orch_t374gate2` (0180, 0181 applied) **291 files, 4894/4894** · build **OK**.

## What happened (themes; each record lives where it says)
- **Roadmap and What's Left rewritten whole** (Ian: one current plan, no accreted notes). Both state current
  position only; history lives in git and this file. Sources: `docs/ROADMAP.html`, `docs/WHATS-LEFT.html` (new: the
  board's repo source). Artifacts: roadmap https://claude.ai/artifact/CXHPh1sKHbeSNr5muaKzFq, board
  https://claude.ai/artifact/7uvWzSMRGikq4P7PRmCQTf. Ian's rule is recorded in memory and in each page's header comment.
- **T-371 shipped** (`3558e52`): DEF-382, DEF-395 (constrained part) fixed. Every write to a finite-checked numeric
  column takes a `Decimal` brand; every NaN-blind money comparison is `compare()`/`isZero()` or EXEMPT; exact
  `multiplyToMoney`/`divideMoney` replace float `toFixed` (a posted 13th-month/separation/return can move ₱0.01, the
  correct way). DEF-579 split out (integer fields). Screen smoke: 4/4 after the low-stock fix (`0844788`).
- **T-373 shipped** (`5e676c1`, `c03851b`, `79043f8`, `d00d0c9`): DEF-547, 552, 555, 559. Migration **0180** (stock
  period = Manila day). Screen smoke S1–S4 PASS. R7 re-keyed on a finalized section (audit).
- **T-369 complete** (`db04bfc`): S5b/S6b — closed-month override on expense approval (DEF-314), other branches'
  accounts in the money lines (DEF-291); DEF-198 closed out. Orchestrator ruling: built ahead of T-367 S5 (blocked);
  T-367 S5 rebases on it. Recorded in the T-369 status line.
- **T-374 specced, reviewed, built** (spec `docs/tasks/374-money-push-follow-ups.md`, independent Opus review ✎R1–R8):
  S1 `92541f9` + S2 `17616fc` (DEF-577: Manila dates, guard over apps and packages), S3 `7b2175f` (DEF-580), S4
  `cec40bf` (DEF-576), S6 `1bfb46d` (DEF-574), S7 `a87b178` (DEF-578, migration **0181**: void a POS usage pull). The
  S7 audit caught a refresh-then-void double count and then a stale-snapshot dead end; both fixed and re-audited.
- **New defects:** DEF-579 (integer fields), 580 (fixed), 581 (no override on bill verification), 582 (supplier
  return shows no message), 583 (remittance banner stale after redirect), 584 (`0x10` accepted as a whole number).
- **Ian's decisions this session:** "rewrite the pages as one current plan" (memory + page headers); "go ahead with
  T-371, then T-373, keep going". No bible row needed. Open Questions page: added `t374-q1-pull-void-who`.

## Pick up here
1. **Production session with Ian on erp2 (`159.223.46.224`, never `.78.207`)**: the read-only prechecks for
   **0177–0181** in the table at the top of `docs/ops/README.md` (incl. the two new T-373 inter-store findings and
   0181's "0 void pulls"), the **T-367 count** of old "other"/"AR collection" payments, the 1115 balance for T-316,
   and confirm the fiscal-period timer is armed. Then push/deploy is Ian's call.
2. **T-374 S5** (DEF-579 + DEF-584, whole-number inputs): tester first, then builder. Its wait on `expenses/actions.ts`
   is cleared (`db04bfc`). Then the T-374 S6/S7 screen smoke on 9008 (not run yet).
3. **T-367 S5/S6 (DEF-054)** as soon as the count is in. Then DEF-581 (spec first), DEF-582/583, then Phase 7.

## Do not decide these alone — they are Ian's
- **Open Questions page** (bible row 252): `t371-blank-on-edit` (built as recommended (a)); `t374-q1-pull-void-who`
  (built as (a): managers/admins who can void a usage record — re-check S7 if he answers otherwise);
  `hr-statutory-data` (due 31 Oct).
- Any deploy of 0177–0181: only after the prechecks with Ian.

## Traps that bit this session
- **A census nominates; running settles** held again: the full suite caught two old-behaviour pins (T-371), a fixture
  CHECK (0181) and a pinned control count; per-slice runs did not.
- **Audits found three real money holes the slice tests passed over** (R7 planned-only pull; refresh wiping
  pull→usage links; the stale-snapshot dead end the first fix created). Keep the audit-then-re-audit loop.
- **Python on Windows writes CRLF unless `newline=''`**; the pre-commit hook refuses CR in docs. LF everything.
- Kill the full-suite run when an audit confirms a defect — fix first, then one gate run (saves an hour).
- The orchestrator's roadmap generator lived in a session scratchpad; next wrap-ups edit `docs/ROADMAP.html` by hand
  (the skill's `t-done`/chip conventions are intact).

## Sessions — all SAFE TO CLEAR (re-brief from this file)
| Role | Session | Note |
|---|---|---|
| Tester | `webapps-a2` | idle all session; no state |
| Builder | `webapps-02` | held all session; no edits |
| Auditor | `system32-2f` | read-only; audited T-371, T-373, T-369, T-374 |
All work was done by orchestrator subagents; none holds uncommitted work. Lane DBs `shareat_test_t371*`,
`shareat_test_t373*`, `shareat_test_t374*`, `shareat_test_t369_s5b*`, `shareat_test_orch_*` can be dropped.
`shareat_test_setup` now has 0178–0180 applied and T-373 smoke data in it.

## The paste-ready prompt
```
You are the orchestrator for shareat-system (C:\Users\ianla\webapps\shareat-system). Run the global
/orchestrator skill. You are starting COLD. Read docs/HANDOFF-TODAY.md (all), docs/RULES.md and
docs/tasks/374-money-push-follow-ups.md (status line + S5). Read the Open Questions page (bible row 252)
with ArtifactData before building anything gated on Ian. GREP the register and bible, never Read them whole.
Goal (Ian): close all open money defects in v2; NOT launched. One is left: DEF-054 (T-367 S5/S6), blocked on
Ian's production count. Queue: HANDOFF "Pick up here" 1→3 — first offer Ian the erp2 session (prechecks
0177–0181 in docs/ops/README.md + the T-367 count), then T-374 S5 tester-first. Next free migration: 0182.
STANDING: lanes run Sonnet (auditor too); Opus only via subagents for specs and judgement. Commit slices
locally; push ONLY at wrap-up; republish the What's Left board (source docs/WHATS-LEFT.html) after every
commit that closes a DEF; ROADMAP.html and the board state current position only, never appended history.
Reds assert the target; every "not" gets a positive control. Each tester/helper gets its own _test DB.
Gate any migration on the FULL suite on a fresh gate DB. No git stash, no lane dev servers, no mutants in
the shared tree. Freeze lanes during gates. Messages are short. Ian runs this terminal on Opus 5.5 at medium
effort; do not ask him to switch.
```

# Handoff — 2026-10-05 (orchestrator, money push closed; Phase 2 closers in flight)

## Where things stand
**The money push is closed: 0 open money defects** (DEF-054 fixed; DEF-491/421 stay deferred by Ian's ruling). Phase 2's
last work is in flight: **T-316** (till float on the cashier's drawer) S1+S2 shipped, **S3 left**; **T-375** (POS v1 day
feed, sales days never typed) S1+S2 shipped, S3–S6 left; **T-376** (AP closed-month + screen nits) S1+S2 shipped, S3 left.
`main` is at the commit carrying this file, through migration **0184**. ⛔ **It was pushed to branch `wrapup/2026-10-05`,
NOT to `main`** — Ian: "push to main later". **A push to `main` deploys to production** (row 278); production is at **0181**.
Next free migration **0186** (0185 reserved for T-375 S4).

## Gates at 040e572 (code; docs commits since)
typecheck **0** · unit **4163/4164** (1 skipped; rerun — the gate run had two load timeouts that pass alone) ·
integration FULL on fresh `shareat_test_orch_gate4` **307 files, 5097/5097** · build **0**.

## What happened (since 49234bf)
- **Production session with Ian (2026-10-04):** production was already at 0181 (auto-deployed by the previous wrap-up's
  push); every precheck 0; no 1115 float accounts; the fiscal-period timer was NOT installed — Ian armed it (first run
  seeded Oct 2026–Sep 2027; no earlier periods → DEF-585). Recorded in `docs/ops/README.md`.
- **Money push closed:** T-374 S5 (DEF-579, 584), T-367 S5 (DEF-054: 'other' and 'ar_collection' retired, migration 0182;
  v1 data showed both were system copies), T-376 S1 (DEF-581 bill override), T-376 S2 (DEF-582).
- **Ian's big decisions (bible rows 269–278, ADR-015, all recorded):** POS v1 and CUSTOMER v1 are copied into this monorepo
  and moved onto one Postgres + one auth; sales are never typed or edited in the ERP (POS refunds fix mistakes); one
  Postgres (no hot/cold split); 24-hour offline POS on device storage; Firebase is not the system of record (exit scope
  PROVISIONAL (b) — `firebase-exit-scope` open); a push is a deploy. Discovery: `docs/discovery/pos-*-proposal.md`.
- **New tasks:** T-375 (POS v1 day feed, three Opus reviews), T-376, T-316 refreshed (its arithmetic rewritten twice by
  review → final rule: at a float store a handover above verified owed is refused).
- **Lanes now run as Sonnet subagents inside the orchestrator** (Ian; memory `lanes-as-subagents`). No worker terminals.
- **Branches:** the four stale `wip/*` branches were superseded and deleted (by Ian). Every branch is merged or deleted.
- **Defects logged:** DEF-585..594 (see register). Notable: DEF-591 (v2 POS pulls send the wrong store id — fixed by
  T-375's link), DEF-593 (inbox-ingestor invariant 8 times out under full-suite load; passes alone).

## Pick up here
1. **T-316 S3** (the float detector + T-375 guard) — the Phase 2 closer, and required before `main` can be pushed
   (S1+S2 alone make the old detector read a drawer's takings as "over"). Spec: `docs/tasks/316-*.md` "## S3"; re-cover
   the `tillFloatOffTarget` assertion removed from `expenses.test.ts` (A-note in the spec). Tester first.
2. **T-375 S3** (import + derived sales day) — carries the ✎ 2026-10-05 note: re-check each wallet tender's account is
   active at import. Then S4 (lock, migration **0185**), S5, S6. Then **T-376 S3** (DEF-583: reproduce on 9008 first).
3. **The push to `main`, with Ian:** P5 (0182) on production, re-run T-316 §5's query (0184), T-316 S3 on `main` —
   checklist in `docs/ops/README.md` deploy gate. Then screen smoke on 9008 for T-374 S5–S7, T-367 S5, T-375, T-376, T-316.

## Do not decide these alone — they are Ian's (Open Questions page, bible row 252)
- `t316-early-handover` (built as (a): today's cash waits for verification) · `t316-overspend-refill` (built: office
  transfer) · `t375-q1` POS API key on production (blocks linking a store) · `t375-q2` charges · `t375-q3` refunds as cash ·
  `t375-q4` VAT-exclusive stores · `firebase-exit-scope` (provisional (b)) · `hr-statutory-data` (due 31 Oct).
- T-136 §2 (revolving fund): in Phase 2 or after cutover? Assess first.
- Tender management is org-scoped by `manage_chart_of_accounts` (a single-store admin can manage another store's tenders)
  — recorded in T-375, not changed; tell Ian if he wants store-scoped.

## Traps that bit this session
- **Subagents' edit tools wrote CRLF** into many files (whole-file churn). Scan every changed file before committing:
  `perl -ne '$c++ if /\r/; END{print "CR $ARGV\n" if $c}' <file>` — `grep -c $'\r'` in a loop gave false positives.
- **Migration order:** drizzle orders by `when`; never build a higher index before a lower reserved one is committed.
- **Push = deploy.** Prechecks before the push, not after.
- Full-suite runs under load time out a handful of unit tests and inbox-ingestor invariant 8; rerun alone before calling red.
- Specs touching money went through 2–3 independent Opus reviews each and every round found real holes — keep doing it.

## Lane DBs
Drop when convenient: `shareat_test_t316_*`, `shareat_test_t375*`, `shareat_test_t376*`, `shareat_test_orch_gate4`.

## The paste-ready prompt
```
You are the orchestrator for shareat-system (C:\Users\ianla\webapps\shareat-system). Run the global
/orchestrator skill. You are starting COLD. Read docs/HANDOFF-TODAY.md (all) and docs/RULES.md, then the
"## S3" section and status line of docs/tasks/316-till-floor-on-the-cashier-account.md. Read the Open
Questions page (bible row 252) with ArtifactData before building anything gated on Ian. GREP the register
and bible, never Read them whole.
State: money push CLOSED; main through migration 0184 is on branch wrapup/2026-10-05, NOT pushed to main
(a push to main deploys; Ian pushes later after the ops/README deploy-gate checklist). Next: T-316 S3
(tester first), then T-375 S3, then T-376 S3. Next free migration 0186 (0185 = T-375 S4).
STANDING: lanes are Sonnet subagents in this session (tester/builder/auditor separate, each its own _test DB);
Opus only via subagents for specs and judgement; independent Opus review for every money spec; commit slices
locally; never push to main without Ian; scan every changed file for CRLF before committing; republish the
What's Left board (docs/WHATS-LEFT.html) after every commit that closes a DEF; ROADMAP.html and the board state
current position only. Reds assert the target; every "not" gets a positive control. Gate any migration on the
FULL suite on a fresh gate DB; freeze edits during gates. Messages are short. Ian runs this terminal on Opus
5.5 at medium effort; do not ask him to switch.
```

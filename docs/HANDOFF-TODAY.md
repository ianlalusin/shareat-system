# Handoff — 2026-10-06 (orchestrator; Phase 2 closed; T-375 built through S6)

## Where things stand
**Phase 2 is closed** (T-316 done) and **T-376 is done**. **T-375 (the POS v1 day feed) is built end to end**:
S3 import, S4 the database figure lock (migration **0185**), S5-lite usage from stored POS data (Ian's pull
redesign), S6 rechecks, drift findings and the correcting entry. All of it is committed **locally on `main`**
and pushed to branch **`wrapup/2026-10-06`**, **not to `main`** — a push to `main` deploys to production (row 278),
and production is still at **0181**. Next free migration **0186**.

## Gates at 543661f (code; docs-only commits since)
typecheck **0** · unit **4248/4253** in the loaded run (1 skipped; the three failing files pass alone: glossary
trap names, committed secrets, position-defaults callers — load timeouts) · integration **FULL on fresh
`shareat_test_orch_gate8`: 320 files, 5297/5297** · build **0**.
Screen smoke (§9.4) on 9008: T-316 ✅, T-375 S3 ✅, **S4–S6 ✅** (fake POS: platform sales posted 1220/4150; usage planned from the stored feed with no POS call; drift finding → correction Dr 4150 / Cr 1110 ₱50 → finding cleared; void reversed day and correction).

## What happened (since 77cbd81)
- **Ian's rulings, all recorded:** row 279 (T-316 (a) + transfer, as built; T-375 new POS key, charges → 4500,
  refunds from cash, VAT a label only); row 280 (**Firebase: completely off**, incl. push — supersedes 275; my
  reading of his free-text answer, flagged to him); row 281 (t374-q1 was answered but unrecorded: **redesign the
  POS pulls**); row 282 (pull-qa..qd: usage posts after verify; **refunded/voided items float for a manager
  decision**; void as built; typed days refused).
- **T-316 S3** (`c5b0eac`): the float detector reads the books' float position. Smoked. **T-316 DONE.**
- **T-376 S3**: DEF-583 did **not reproduce** in dev or production builds → closed, nothing built (R7).
- **T-375 S3** (`7a33eea`), **S4** (`7de5232`, 0185), **S5-lite** (`cad42a6`), **S6** (`543661f`). Every slice:
  tester-first, audited, mutants **run** (S3 11/11, S4 17/17, S5 17/17 + 4 race guards review-verified only,
  S6 18/18). Orchestrator rulings recorded in the spec (✎S5L-R, ✎S6-A). A builder renamed a parameter to dodge a
  guard (`actor` → `who`); reverted and exempted honestly.
- **POS pull redesign** (`docs/discovery/pos-pull-redesign-proposal.md`): no pull at the end state; S5-lite for now.
- **Defects:** DEF-583 closed (not reproduced); **DEF-591 fixed**; **DEF-595 logged** (POS v1 never depletes what a
  package table eats); **DEF-596, 597 logged** from the smoke.

## Pick up here
1. **The push to `main`, with Ian** — the checklist in `docs/ops/README.md` (Deploy gate): P5 (0182) on
   production, re-run T-316 §5's query (0184), then 0185 goes too. Prechecks BEFORE the push.
2. **The new POS key** (Ian chose a store-scoped key, row 279): give Ian the steps; nothing can be linked on
   production without it. Then link stores one by one (DEF-586 closes store by store).
3. Small follow-ups from the smoke: **DEF-596** (T-210 "At import" shows the corrected basis) and **DEF-597** (posUsagePullNotRun fires after a fully handled day). Then T-374 / T-367 screen smoke.

## Do not decide these alone — they are Ian's
- The Open Questions page is clear. Tell Ian (told-not-asked): remapping a tender to a **different** money account
  after a day is verified makes the next correction move that wallet's whole amount (✎S6-A).
- T-136 §2 (revolving fund) phase; tender management is org-scoped (ask if he wants store-scoped).

## Traps that bit this session
- **Tests written after the fix are never red** — only a real mutant run proves them. Two vacuous tests were caught
  only that way (T-316 MX, T-375 S4 K11: postgres.js reports a transaction's FIRST error, hiding a 25P02).
- Mutant agents can stall mid-run: hash files before, log after every mutant, sha-check after.
- Subagents' tools can truncate a file (S5 usage-pull.ts rebuilt from memory; audited against HEAD).
- `next build` rewrites `apps/erp/next-env.d.ts` — restore it, never commit it.
- Smoke: forge the session cookie with stdout straight into a scratch file; Playwright reads it (Ian approved).

## Lane DBs
Drop when convenient: `shareat_test_t316*`, `shareat_test_t375*`, `shareat_test_t376*`, `shareat_test_orch_gate5..8`.

## The paste-ready prompt
```
You are the orchestrator for shareat-system (C:\Users\ianla\webapps\shareat-system). Run the global
/orchestrator skill. You are starting COLD. Read docs/HANDOFF-TODAY.md (all) and docs/RULES.md. Read the
Open Questions page (bible row 252) with ArtifactData before building anything gated on Ian. GREP the
register and bible, never Read them whole.
State: Phase 2 closed; T-375 built S1-S6 (migration 0185); local main is pushed to wrapup/2026-10-06, NOT
to main (a push to main deploys; production is at 0181). Next: the push to main with Ian per the
docs/ops/README.md deploy gate, then the POS key steps for Ian. Next free migration 0186.
STANDING: lanes are Sonnet subagents in this session (tester/builder/auditor separate, each its own _test
DB); Opus only via subagents for specs and judgement; independent Opus review for every money spec; RUN
mutants (a test written after its fix proves nothing until a mutant turns it red); commit slices locally;
never push to main without Ian; scan every changed file for CRLF before committing; republish the What's
Left board (docs/WHATS-LEFT.html) after every commit that closes a DEF. Gate any migration on the FULL
suite on a fresh gate DB; freeze edits during gates. Messages are short. Ian runs this terminal on Opus
5.5 at medium effort; do not ask him to switch.
```

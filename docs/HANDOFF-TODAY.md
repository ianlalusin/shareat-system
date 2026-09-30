# Handoff — 2026-10-01 (after the 30 Sep money-defect day)

> ⚠️ NOT LAUNCHED. A green push to `main` runs CI, and a green CI **deploys** (`.github/workflows/deploy.yml`).
> This push carries **migration 0172** (T-366 S2). The `pg_default_acl` check for 0169 (`docs/ops/README.md`) is
> still unrun on prod — Ian asked the orchestrator to run it with him.
>
> ⚠️ Integration was **not clean in the full run**: 13 failures ("column `source` does not exist") in two files that
> pass solo 77/77 — DEF-545. Item 2 below.

## Where things stand
Money-defect push (Ian: "close all open money defects in v2"): census 34 → **29 open**; 12 closed on 30 Sep
(DEF-108, 374, 494, 496, 497, 498, 506, 516, 529, 534, 535, 541). Specs T-364..T-372 all APPROVED after independent
Opus review (`docs/plans/money-defects-2026-09-30.md` is the map). T-364, T-365 done; T-366 S1/S1b/S1c done and **S2
committed (`94f38e2`, DEF-386) pending its live-charge screen test**; T-370 S1+S2 done. Red tests for T-367 S1,
T-368 S0/S1, T-372 S1 and T-367 S1 step-1 code are parked on branch **`wip/2026-09-30-reds`** (pushed), off `main` so
typecheck stays green.

## Gates at `3f326c8` (main tree, `shareat_test`)
typecheck **0** · unit **3623/3627** (3 memory timeouts, pass solo 48/48; 1 skipped) · docs unit re-run after the
last commit **1162/1162** · integration **4054/4068** (13 fail in the full run only — DEF-545; 1 todo) · build
**skipped — dev server live on 9008**.

## What happened (decisions and where they are recorded)
- Rulings in chat → bible rows **253–259** (shortage always charged, write-off retired; overage manager-confirmed;
  commissary ready-is-final, blocked until received/cancelled, freight on receiving branch; closed-month stock fixed;
  bad pay cycle refused on save, oldest owner debt first; period cleanup + asset-term reverse/rebook; payment
  methods; uniform refusal).
- **Open Questions page** (row 252): https://claude.ai/artifact/LMQCEXDZqHyAJz69FCy7FN — Ian answered 24 there;
  recorded as **row 260** and in the plan file. Still open: DEF-539 charge scope, T-370 monthly floor, HR data owner,
  new **T-367 Q3b** (only 2900 void-cash suspense exists), Firebase credentials (told: `.env.local`
  DEV_TERMINAL_EMAIL/PASSWORD/UID, then "saved").
- What's Left board: https://claude.ai/artifact/7uvWzSMRGikq4P7PRmCQTf (republished at this wrap-up).
- Roadmap: T-348 done; T-364..T-372 rows added.

## Pick up here
1. **T-366 S2 screen test → close DEF-386.** Tester needs 2026-09 reopened in `shareat_test_setup`; the permission
   check blocked that and it's waiting on Ian. Or date the smoke ≥ 2027-02 (all of 2026 is closed there).
2. **DEF-545** — find which file leaves `shareat_test` without 0172 mid-run; re-run the full suite on a fresh gate DB.
3. `git restore --source=wip/2026-09-30-reds -- <paths>` then: builder T-372 S1 (DEF-511); builder T-367 S1 step 2
   (migration **0173**, unique `ar_write_offs(journal_entry_id)`); tester T-368 S0 red check (next free index).
4. Then T-366 S3/S5/S6, T-367 S2–S6, T-368, T-369, T-370 S3 (DEF-409), T-372 S2–S6, T-371 last.
5. Ops Ian handed to the orchestrator (run WITH him): fiscal-period timer on erp2, 0169 `pg_default_acl` check,
   T-367 Q0 count of v1 "other"/"ar_collection" payments; apply 0169–0171 to `shareat_dev` (he said yes).

## Do not decide these alone — they are Ian's
DEF-539 (reco: only that person's handover days) · T-370 monthly floor (reco: never below zero) · T-367 Q3b
(reco: new "Unclassified payments" account) · HR statutory data owner. All on the Open Questions page.

## Traps that have actually bitten
- **Integration full run ≠ solo** (DEF-545, DEF-502 timeouts): re-run failing files solo before believing either way.
- **`shareat_test_setup` has every period Jan 2026 – Jan 2027 CLOSED**; the smoke flow for charges hits it.
- **Edit tool writes CRLF** — `file <path>` before every commit; `sed -i 's/\r$//'`.
- **Don't reset `wt-audit` while the auditor uses it** — ask first. Both worktrees (`wt-audit`, `wt-audit2`) have
  their own `npm ci`; scan for links before deleting (`cmd /c dir /AL /S /B <wt>`).
- A bible row shifts the TOC → `npm run toc`; §13 rows need 5 cells (Rationale, Reversible) or the facts guard fails.

## Sessions (safe to clear; re-brief from this file)
Tester `webapps-30` · Builder `system32-19` · Auditor `auto-assign-staff-role-on-hire` — all frozen, no uncommitted
work in the tree (everything is on `main` or `wip/2026-09-30-reds`). Lane DBs survive by name
(`shareat_test_t366_*`, `shareat_test_t367_*`, `shareat_test_t372_builder`, `shareat_test_auditor`); smoke
`shareat_test_setup` on 9008 (`erp-smoke`).

## The paste-ready prompt
```
You are the orchestrator for shareat-system (C:\Users\ianla\webapps\shareat-system). Run the global
/orchestrator skill. You are starting COLD. Read docs/HANDOFF-TODAY.md (all), docs/RULES.md, and
docs/plans/money-defects-2026-09-30.md. Read the Open Questions page (bible row 252) with ArtifactData
before building anything gated on Ian. GREP the register and bible, never Read them whole. Goal (Ian):
close all open money defects in v2; NOT launched. Queue: HANDOFF "Pick up here" 1→5.
STANDING: commit slices locally; push ONLY at wrap-up; republish the What's Left board after every commit
that closes a DEF; every wrap-up updates "what's left", ROADMAP.html and the board. Reds assert the target;
every "not" gets a positive control. Each tester/helper gets its own _test DB. No node_modules junctions;
mutants only in a worktree with its own install; scan a worktree for links before deleting it. `file`
every edited file (no CRLF). Freeze lanes during gates. Messages are short. Render before deciding. Ian
runs this terminal on Opus 5.5 at medium effort; do not ask him to switch.
```

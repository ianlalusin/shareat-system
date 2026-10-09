# Handoff — 2026-10-09 (orchestrator; four PRs live: T-383 S1, T-384, T-385, T-386 S1-S4)

## Where things stand
**Production (`159.223.46.224`, erp2.shareat.net) runs `7489bba`, migration 0189**, deployed 9 Oct through PRs
#1-#4: item rename (super-admin), the POS link redesign, every page full width with saved records locked behind
Edit, verify & post only after submit (no self-verify except a super-admin), and item codes suggested from the name
(`CHWN-001`, never reused). Every PR's CI ran the full suite (bible row 291) and every deploy was healthy on the first
attempt. **Lipa is linked to POS**; Ian set up its tenders. **Nothing is half-built on a branch**: `main` = production.
Next free migration **0190**.

## Gates
PR CIs green: #1 25m44s, #2 20m44s, #3 (after one missed test conversion, fixed `d1df5b2`), #4 25m10s (after two CI
fixes: the client-bundle guard's item-code entry `src/item-code.ts`, and a customers fixture's conflict target).
Browser smoke 6 rounds on 9008 (forged session). Production health OK, sign-in 200 after each deploy.

## What happened this session
- **Rulings recorded** (bible §13): 287 item unit lock · 288 full width everywhere (sign-in/setup/clock stay narrow
  centred cards) · 289 Edit/Save lock, adds end in Save, commands keep their verb · 290 rename super-admin only, retire
  warns then allows until used up · 291 full suite in CI on a PR · 292 POS "collected" is a cash sale (second cash
  tender) · 293 verify only after submit, no self-verify except super-admin · 294 item codes `CHWN-001`, super-admin
  override, recode existing once, rename keeps the code. Sweep rulings: spec 384 Amendment A6.
- **Defects** DEF-610..617 logged; 610-616 fixed; 617 (a refused save keeps the typing) fixed for tenders only.
- **Specs on disk**: 383 (S2 not started), 384 (done), 385 (done), 386 (S5, S6 not started).
- **Process incidents, both recovered, both now memories**: lane worktree removal with junctions in place deleted the
  main tree's packages and 1,481 files (restored from git + `npm ci`); a `\b` in a test regex had become a literal
  backspace byte, making a check vacuous (fixed).

## Pick up here
1. **T-386 S5 — recode existing items** (`scripts/recode-items.ts`, dry run by default, `--apply`, logged, re-runnable).
   Production has 1 item. **Ian must see the dry run before `--apply`.** Then S6 (database shape CHECK) once the
   post-check reads 0 unconverted codes.
2. **T-383 S2 — retire/restore an item** with the stock warning (Amendment B1: usable until its stock is used up; no
   new orders, receipts, prices or POS maps).
3. **DEF-617 for other forms** — a refused save reloads locked and drops the typing everywhere except tenders.

## Do not decide these alone — they are Ian's
- POS "collected": does the owner usually keep it (drawing) or hold it for the business (remittance); who at Lipa
  records it daily (`pos-collected-lipa`, answered a, follow-ups open).
- Automatic morning POS import (not built; imports are by button).

## Traps that have actually bitten
- **Lane worktrees hold junctions into the main tree**: remove links first (memory `worktree-node-modules-junction`);
  dev servers cannot run from a lane worktree — serve from the main tree on a release branch.
- **Never commit a lane while its agent has background work**; grep diffs for `false as boolean`.
- **A `\x08` byte in a .ts file is a broken `\b`**, not noise (memory `backslash-b-becomes-backspace`).
- **Merged lanes break each other's guards** (census counts, ratchet baselines, mocks missing a new export, a fixture
  conflict target after an index change) — run guards after every merge; CI on the PR is the backstop.
- **An auto-fix CI event can name an already-fixed run** — check the run's head sha before acting.

## Lane DBs (drop when convenient)
`shareat_test_t383`, `t384*`, `384*`, `intfix`, `t385`, `t386`, `t386b`, `smoke384`, `tender_repro`, `orch_gate13..15`.
Worktree `wt-t386` (lane/t386, merged) and the stuck empty folder `wt-t384-s1a` can be removed (links first).

## The paste-ready prompt
```
You are the orchestrator for shareat-system (C:\Users\ianla\webapps\shareat-system). Run the global
/orchestrator skill. You are starting COLD. Read docs/HANDOFF-TODAY.md (all) and docs/RULES.md. Read the
Open Questions page (bible row 252) with ArtifactData before building anything gated on Ian. GREP the
register and bible, never Read them whole.
State: production at 0189 (7489bba) = main. Next: T-386 S5 recode (dry run with Ian before --apply), then
T-383 S2 retire/restore. Next free migration 0190.
STANDING: full suite runs in CI on a PR (row 291), merge only when green and with Ian's go; migration
prechecks run with Ian before the merge; lanes are Sonnet subagents (tester/builder/auditor separate, own
_test DB, worktrees); Opus for specs, reviews, money audits; never commit a lane while its agent has
background work; remove worktrees only after deleting their junctions; byte-check every changed file for
\r and \x08; republish docs/WHATS-LEFT.html after every DEF close. Messages are short.
```

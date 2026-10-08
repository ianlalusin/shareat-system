# Handoff — 2026-10-09 (orchestrator; T-383 S1 and T-384 live; T-385 in PR #3)

## Where things stand
**Production (`159.223.46.224`, erp2.shareat.net) runs `daea634`, migration 0187**, deployed 9 Oct through two merged
PRs: #1 (T-383 S1 item rename, T-384 S1a/S1b-min/S2a/S3a) and #2 (T-384 S1b POS link redesign + the full width and
Edit/Save sweep). **PR #3 (T-385, migration 0188) is open on branch `release/t385`**: verify & post only after
submit, no self-verify except a super-admin. It merges when its CI is green AND Ian has run the 0188 prechecks.
**Lipa is linked to POS on production** (since 8 Oct) but cannot import yet: its Cash and "Collected" tenders are
not created. Next free migration **0189** (item codes, if Ian approves).

## Gates (bible row 291: the full suite runs in CI on a PR, not locally)
PR #1 CI green (25m44s) → deployed `e2451ad`; PR #2 CI green (20m44s) → deployed `daea634`, health OK, sign-in 200.
PR #3 CI pending at handoff (auto-fix is on for it). Locally at `95a84bf`: typecheck 0; the T-385 lane's own files
green (31/31 new, 28 converted files pass alone); browser smoke 5 rounds on 9008 (forged session).

## What happened this session
- **Rulings, all recorded:** bible rows 287 (item unit lock), 288 (every page full width; sign-in/setup/clock stay
  narrow centred cards), 289 (saved records locked behind Edit, adds end in Save, commands keep their verb), 290
  (rename super-admin only; retire with stock warns then allows until used up), 291 (full suite in CI on a PR),
  292 (POS "collected" = a cash sale, second cash tender), 293 (verify only after submit; no self-verify except
  super-admin). Sweep rulings: spec 384 Amendment A6. Open Questions page holds every answer.
- **Defects:** DEF-610..617 logged; 610-616 fixed; 617 fixed for tenders only. DEF-605 is live on production.
- **The tender "overwrite" Ian saw was not an overwrite:** the production audit log showed 3 wallet creates and 2
  no-op saves; the Cash create was refused and the message was hidden at the top of the page (DEF-612, now fixed).
- **Process incident (fixed, no data lost):** removing merged lane worktrees with their junctions still in place
  deleted the main tree's `node_modules` and 1,481 tracked files; restored from git + `npm ci`. Memory
  `worktree-node-modules-junction` now carries the safe removal procedure. One folder, `wt-t384-s1a`, could not be
  deleted (a process holds it); its links are already removed — delete the folder when free.

## Pick up here
1. **PR #3**: when Ian sends the 0188 precheck output (P0188c must be 0; P0188f must list only Ian, admin, 5) and CI
   is green, merge it (`gh pr merge 3 --merge`), watch the deploy, expect **169** rows in
   `drizzle.__drizzle_migrations`, then record the precheck results in docs/ops/README.md's 0188 row.
2. **Lipa**: Ian adds tenders Cash (Kind Cash, no account, POS name `Cash`) and "Collected off the till" (Kind Cash,
   no account, POS name `collected`), then imports the closed day; Submit, then a *different* person verifies.
3. **T-383 S2** (retire/restore with the stock warning, Amendment B1) — spec on disk, not started.

## Do not decide these alone — they are Ian's
- Item codes: four questions on the Open Questions page (`item-code-q1..q4`; recommended RM-CHWN-01, super-admin
  override only, recode existing once, code stays on rename). Proposal: the scratchpad's item-code-proposal.md was
  not committed — re-run the research if needed; the questions carry the substance.
- POS "collected": does the owner usually keep it (drawing) or hold it for the business (remittance); who at Lipa
  records it daily (question `pos-collected-lipa`, answered a, follow-ups open).
- Automatic morning import (not built; Ian asked "when will I see it" — he imports by button today).

## Traps that have actually bitten
- **Lane worktrees hold junctions into the main tree** — never `git worktree remove --force`/`rm -rf` one; remove
  the links first (memory `worktree-node-modules-junction`). A dev server cannot run from a lane worktree.
- **Never commit a lane while its agent still has background work** — a mutation run committed two disabled guards
  once (memory `no-commit-while-lane-running`); grep the diff for `false as boolean` before every commit.
- **Agents report "CRLF preserved"** — byte-check; one L3 file was CRLF.
- **Merged lanes break each other's guards** (census counts, ratchet baselines, a mocked module missing a new
  export) even when every lane was green alone — run the guard and census files after every merge.
- **A refusal on a long page is invisible** if it renders only in the top banner — show it where the user acted.

## Lane DBs (drop when convenient)
`shareat_test_t383`, `t384s1a/s2a/s3a/s1b`, `384s1b`, `384l1..l6`, `intfix`, `t385`, `smoke384`, `tender_repro`,
`orch_gate13..15`.

## The paste-ready prompt
```
You are the orchestrator for shareat-system (C:\Users\ianla\webapps\shareat-system). Run the global
/orchestrator skill. You are starting COLD. Read docs/HANDOFF-TODAY.md (all) and docs/RULES.md. Read the
Open Questions page (bible row 252) with ArtifactData before building anything gated on Ian. GREP the
register and bible, never Read them whole.
State: production at 0187 (daea634). PR #3 (T-385, migration 0188, branch release/t385) waits on Ian's 0188
prechecks and its CI; then merge, watch deploy, expect 169 migration rows. Lipa needs its Cash and Collected
tenders before importing. Next free migration 0189.
STANDING: full suite runs in CI on a PR (row 291) — locally run affected tests only; lanes are Sonnet
subagents (tester/builder/auditor separate, own _test DB, worktrees); Opus for specs, reviews, money audits;
never commit a lane while its agent has background work; remove worktrees only after deleting their
junctions; byte-check every changed file for \r and \x08; never merge to main without Ian; republish
docs/WHATS-LEFT.html after every DEF close. Messages are short.
```

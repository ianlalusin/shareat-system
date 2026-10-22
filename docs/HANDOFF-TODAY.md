# Handoff — 2026-10-22 (covers 18–22 Oct)

## Where things stand
PRODUCTION: **7949b6f LIVE** (PR #45; health check 22 Oct: ok, database reachable). Migrations live through **0211**.
Everything merged to `main` is live: T-396 S1+S2, T-440 complete (live field checks + authorization-first), T-441 S1 +
lightbox fix L1, T-443 item families, T-444..T-446/T-448 compact workspaces and forms, T-450 phone cards, T-451/T-452
role-first staff. Two PRs are OPEN and fixed, waiting only on green CI and Ian's go: **#43** (T-442 file-link backfill +
part of T-441 S2) and **#44** (POS v2: T-425 offline, T-426 senior/PWD, T-427 Convert). This wrap-up's PR (branch
`lane/t453-audit-followups`) carries T-453 + bible rows 373-375 + DEF-727..729 + roadmap.

## Gates
Local, on `lane/t453-audit-followups`: typecheck clean · T-453 unit 20/20 + guards 134/134 · T-453 integration 9 files
160/160 (lane DB `shareat_t453_test`). Full unit + integration suite: runs in the wrap-up PR's CI (row 296). Build: CI.
#43 and #44 re-run their CI after the 22 Oct pushes (5b1d780, d6f610f).

## What happened (18–22 Oct)
- **18 Oct (this orchestrator):** Ian's 17 Oct answers recorded (bible 365-372); POS store ids recorded
  (`docs/ops/pos-v1-key.md`; Ian set POS secret v3 with all five stores); T-440 S9 (auth-first guard G6) and part B;
  T-442 S1; lightbox L1. The session was cut off by a network drop mid-sweep.
- **19-21 Oct (another agent, Codex):** finished T-440 (#40), T-442/T-441 S2 pieces (#43, open), POS v2 (#44, open),
  T-443 + migrations 0210/0211 (#37), compact UI (#38 #41 #42), role-first staff (#45); deployed through 7949b6f.
- **22 Oct audit of that work (6 reviewers):** no blocker in anything merged. Fixed today:
  - **#44 money bug:** senior/PWD "whichever is higher" compared a promo on the VAT-inclusive price with 20% of the
    VAT-free price, so an 18-20% promo overcharged (₱112/19%: ₱81 instead of ₱80). Ruling (orchestrator, recorded in
    `docs/tasks/426-*.md` on that branch): compare what the diner PAYS, unrounded; tie = 20% statutory. Also removed an
    unapproved permission allow-list from `.claude/settings.json` on that branch; Convert warning names the method
    that went negative.
  - **#43:** `--check` exits 1 only for a LINKABLE unlinked file (ruling in `docs/tasks/442-*.md`).
  - **T-453** (this PR): cutover direction refuses anything but debit/credit (DEF-727); audit rows for item
    variant/dismiss/undo (DEF-728); legacy manager/admin position holders shown flagged on Staff (DEF-729);
    scroll-save throttled; L2a test oracle.
  - **Bible 373-375:** role-first staffing (21 Oct), T-443 R-A (each size its own item under a parent), R-B (wholesale label).

## Pick up here
1. **Merge order once CI is green and Ian says go:** this wrap-up PR → #43 → #44 (#44 has no migrations; none of the
   three conflict). Then a release + deploy script for Ian.
2. **T-441 S3-S7** (staff photo, leave documents, signature, thumbnails, guard): S3/S4/S6 in parallel, then S5, then S7.
3. **T-398 S2b-S6** (Padre Garcia), plus the new PG HR-on-v2 task (bible 369: needs PG's own statutory rates and an
   approver above the PG manager) — before 1 Jan.

## Do not decide these alone — they are Ian's
- **Shared online accounts** (Open Questions `q-t396-shared-accounts`): recommended **A** — each store gets its own
  "share" of each real GCash/BDO/foodpanda account; the daily sweep is one money transfer inside the store; no code.
  Also needs: which account gets QRPH and bank transfer; foodpanda account per store; Davao; is Ian's wife an owner at
  Banay-Banay (personal use from her account must be an owner drawing). **Needed by Fri 23 Oct for the 2 Nov start.**
- **POS key check:** after the POS rollout, run the five-store curl in `docs/ops/pos-v1-key.md` §4 (expect 200 ×5).
- **Repo visibility (DEF-680):** GitHub was public on 19 Oct, private now. Secret scan of main found nothing. Confirm private.
- **Uncommitted in the main checkout** (not ours; the main checkout is on Codex's branch `codex/compact-form-fields`
  with an unpushed doc commit 31ecf0d): `CLAUDE.md` deletes the old-droplet / never-build-on-the-server warning, and
  `docs/operations/inventory-monitoring-responsibilities.docx` is new. Ian: keep or revert each.
- Count, on production, managers/admins who still hold staff positions (T-451 left them; they keep position grants).
- Phone check: on a phone, look at AP bills and customer balances — only two columns show until a row is tapped.

## Traps that have actually bitten
- **Two agents, one repo:** Codex used the main checkout and its own worktrees under `C:\Users\ianla\.codex\worktrees`.
  Check `git worktree list` and `gh pr list` before assuming the tree is yours.
- **Git Bash mangles `rev:path`** (`origin/main:.claude/settings.json` becomes a Windows path): set `MSYS_NO_PATHCONV=1`.
- Agents cannot read or write production (blocked): scripts Ian runs; reading the public `/api/health` is fine.
- A tester's `npm install` in a lane worktree drifted versions (vitest 4.1.12, duplicate drizzle); `npm ci` there fixed it.
  Lane worktrees now hold their own `node_modules` (no junctions) — still never `git worktree remove --force`.
- CRLF and cp1252 bytes from agents: the pre-commit hook catches CR; a 0x97 em dash broke a test silently.

## The paste-ready prompt
```
You are the orchestrator for shareat-system (C:\Users\ianla\webapps\shareat-system). Run the global /orchestrator
skill. Start COLD: read docs/HANDOFF-TODAY.md (all) and docs/RULES.md. GREP the bible and register, never Read them
whole. Production = 7949b6f (migrations through 0211). Open PRs: the 22 Oct wrap-up PR (lane/t453-audit-followups),
#43 (T-442), #44 (POS v2) — check CI; merge+deploy only when Ian says so, in that order. First ask Ian for the
shared-accounts answer (Open Questions q-t396-shared-accounts, needed for 2 Nov) and the five-store POS key check.
Then T-441 S3-S7, T-398 S2b-S6 + PG HR task. Another agent (Codex) also works in this repo: check git worktree list
and gh pr list first; the main checkout may be on its branch. Next free: migration 0212, task T-454, DEF-730.
STANDING: lanes are subagents (tester/builder/auditor separate, own _test DB, worktree per lane, workers never run
git, LF only); every wait = plan + Opus-audit the next slices; Sonnet/Haiku for work, Opus for specs and reviews;
production steps are scripts Ian runs; talk to Ian in plain language; messages are short.
```

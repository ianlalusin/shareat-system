# Handoff: 2026-10-13 (orchestrator, cold start)

## Where things stand
**Production (`159.223.46.224`, erp2.shareat.net) runs `c7cf55a`, migrations through 0197.** Deployed today, all green:
- PR #20: same-org FKs (0194), DEF-640, T-391 S4-S6.
- PR #21: T-392 S3+S4, the dual-run comparator (0195).
- PR #22: T-401 S1+S2, the menu/price master (0196), plus T-403, admin-only recipes.
- PRs #23 and #24: T-402 S1a+S1b, the activity log storage and writer (0197).

The first 0197 deploy refused safely on an unlabelled `recode_item`, rolled back, and was fixed in PR #24.

⚠️ **Ian made the GitHub repo PUBLIC on 13 Oct.** Read "Do not decide these alone" before anything else.

## Gates at `c7cf55a` (+ the count-sheet cleanup committed in this wrap-up)
- **typecheck:** exit 0.
- **unit:** 6,226 passed / 22 failed / 4 skipped across 6,252 in one local run. Every failing file passes when run on its own: these are load timeouts on this laptop.
- **integration:** the full suite is green on CI main for `c7cf55a` (run 38384157014). Locally, t390 count-sheet + t390-s5 passed 52/52 on a fresh DB (`shareat_test_wrap1013`).
- **build:** not run locally. CI built it, and Deploy 38388276602 shipped it.

## What happened this session (decisions are recorded in bible §13 rows 313-318)
- **Repo tidy.**
  - Old handoffs moved to `docs/archive/`.
  - The home backup tooling moved to `docs/ops/home-backup/`.
  - 282 test DBs dropped.
  - ⛔ A worktree removal deleted main's source through the node_modules junctions (3rd time). Everything was restored from git. Read memory `worktree-node-modules-junction` before ANY worktree removal.
- **T-392 dual-run.** S4 went through two audit rounds: channel keys, `other`=none gives NOT_DOUBLE_ENTERED, staff-cash parties, warnings. S3+S4 are live.
- **T-401 menu master.** Specced, then re-specced after Ian answered Q1-Q6 (row 316). S1 had 4 audit rounds and S2 had 2. Live.
  - Ian's rulings: managers price their own store; only super admin adds items; recipes are Shareat standards, admin-only and never grantable; stores and the franchise only suggest; ±10% usage tolerance; Padre Garcia's recipes are controlled by Shareat (row 315). They are in the spec sections "Ian ruling …".
- **T-403.** `manage_recipes` (new) and `manage_pos_map` are admin-only. Live.
- **T-402 activity log.** Ian asked for it ("build now"); it went through research-evaluate-propose. The spec was Opus-reviewed. S1a+S1b are live (row 317).
  - One real bug was caught before ship: client events would never save (ms vs µs FK).
- **T-394 purge rehearsal.** Spec approved with changes. The production DB host is pinned (`shareat-system-db-do-user-39783702-0.m.db.ondigitalocean.com`).
- **POS v2 / customer v2 plan.** Published at https://claude.ai/artifact/FjvbQ9xibxBFqeoEoMRHgX. Ian answered all 29 decisions and 120 features; read them with ArtifactData, collection `answers`. Rulings in rows 313, 314, 318:
  - one tablet per store;
  - sign-up SMS code only, manager-only password reset;
  - store orders shown on the POS screen;
  - usage drafts queued from many staff, posted by the manager.
- **Research.**
  - The running bill showed no measurable add-on lift (Lipa about flat, Malvar −12%; the control is weak).
  - Customer logins are about 20-25 a month.
- **Defects logged:** DEF-641..648. DEF-643 (Firestore mirror reset after purge) is unowned.

## Pick up here
1. **T-392 S1b, S4b, S5 before the 2 Nov dual run.** S1b reads v1 `channel_sales`; S4b is document matching (R9); S5 is the screens. Spec `docs/tasks/392-dual-run-comparator.md`, rulings at the end.
2. **T-391 rollout with Ian:** extract, sheets, dry run, apply per store, Lipa first. Then T-390 S4.
3. **T-394 S1 build (due 28 Oct)** and **T-401 S3 / S4 / S5**. S5 is the v1 usage switch with ±10% tolerance; the queue + manager-post ruling is row 318. **T-402 S2-S5** runs in parallel.

Only one lane may add a migration at a time. The next free number is **0198**.

## Lanes and worktrees (all idle; nothing in flight)
| Worktree | Branch | State |
|---|---|---|
| `wt-t385` | lane/t392-s4 | merged (PR #21) |
| `wt-t386` | lane/t398-s1 | merged (PR #20) |
| `wt-t390` | lane/t392-s3 | merged via #21 |
| `wt-t400` | lane/t400-parallel-integration | **PR #18 still open**: rebase + fill Outcome, or close |
| `wt-t401` | lane/t401-s1 | merged (PR #22) |
| `wt-t402` | fix/0197-recode-item | merged (PR #24) |
| `wt-t403` | lane/t403 | merged (via #22) |

Leftover folders `wt-t387-s3` and `wt-t384-s1a` remain.

Remove merged worktrees ONLY by the reparse-point method in memory `worktree-node-modules-junction`: delete every junction first, verify none remain, then delete. **Never** use `git worktree remove --force` or `rm -rf`.

Every lane DB belongs to merged work. They are safe to drop with `drop-test-db.mjs` from the main tree.

## Do not decide these alone: they are Ian's
- **Public repo (13 Oct).** No real secret was found in the files or history (scanned 13 Oct): `.env*` and `secrets/` were never committed, the test private key is a dummy, and DB URLs are placeholders. But anyone can now read:
  - production hostnames and IPs (droplet `159.223.46.224`, the DO DB host);
  - `docs/ops/` runbooks;
  - `docs/DEFECTS-REGISTER.md`, which describes security weaknesses;
  - business rules and money flows.

  **Recommend making it private again** unless it must be public. If it stays public, no key needs rotating (nothing leaked), but tighten the DB trusted sources and droplet SSH. A public repo does get free GitHub Actions minutes.
- **`FB_DEV_TERMINAL_PASSWORD` is a 10-digit number.** It is not leaked (the digits are common test data), but it is guessable. Recommend changing that Firebase dev terminal account's password.
- **Recipe capabilities:** make them non-offerable to positions (Ian chose "lock") and build the suggestion queue. Follow-up task after T-401.
- **Franchise recipes:** how Padre Garcia receives Shareat's standards read-only. A design is needed before it uses recipes (T-401 spec).
- **T-393 backups:** switch them on before 1 Nov (the 13 Nov rehearsal needs them).
- **T-396:** Ian supplies POS ids, keys and tenders for Malvar, Banay-Banay and Davao.

## Traps that have actually bitten
- **Worktree removal follows node_modules junctions into main's source.** This happened 3 times; the memory file has the only safe method.
- **A migration that labels or validates existing rows must be checked against production's real data.** 0197 refused on `recode_item`. Its regression test now scans git history.
- **Lanes' full unit runs time out under load on this laptop.** Re-run failing files alone before believing them. CI is the full-suite gate.
- **Watch scripts must survive network drops.** Poll `gh run view` in a loop; one `gh run watch` died mid-run today.
- **Pushing main deploys.** Ship through a PR.

## The paste-ready prompt
```
You are the orchestrator for shareat-system (C:\Users\ianla\webapps\shareat-system). Run the global
/orchestrator skill. You are starting COLD. Read docs/HANDOFF-TODAY.md (all) and docs/RULES.md, then the spec
of the lane you start (docs/tasks/392-*, 401-*, 402-*, 394-*). GREP the bible and register, never Read them whole.
State: production runs c7cf55a (migrations through 0197). Next free migration 0198, one migration lane at a time.
FIRST: give Ian the public-repo recommendation in the handoff and get his answer.
Next work: T-392 S1b/S4b/S5 before the 2 Nov dual run; T-391 rollout with Ian; T-394 S1 (28 Oct); T-401 S3-S5;
T-402 S2-S5. NEVER push main directly (it deploys); ship via PR and merge only when CI is green.
STANDING: lanes are Sonnet subagents (tester/builder/auditor separate, own _test DB, worktree per lane, workers
never run git, LF only); Opus for specs and their fresh reviews; never remove a worktree except by the
junction-safe method in memory; talk to Ian in plain language (global CLAUDE.md). Messages are short.
```

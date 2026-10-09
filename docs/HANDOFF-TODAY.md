# Handoff — 2026-10-10 (orchestrator; one PR carries the day: T-383 S2, T-386 S5, T-388, T-389 S1, T-395 S1 + 0190)

## Where things stand
**Production (`159.223.46.224`, erp2.shareat.net) runs `7489bba`, migration 0189.** Everything since is on branch
**`release/2026-10-10`** in **one PR** (bible row 296: GitHub CI runs once a day, at wrap-up). It merges (= deploys) only
when its CI is green **and** Ian says go, and **after Ian runs the 0190 READ ONLY precheck** (row 296 exception 2;
SQL in `docs/ops/README.md`, row 0190). Next free migration **0191**. The ERP v2 cutover plan is written:
`docs/plans/remaining-build-plan.md` (10 gaps for cutover, waves to 15 Nov go/no-go and 1 Jan).

## Gates at the PR head
typecheck 0 errors · unit 4917/4921 (1 failed: `t375-s0-census-script` crashed with a Windows process abort under load,
exit 3221226505; 4/4 alone; 3 skipped) · integration: in CI on the PR (row 291) — locally, every slice ran its affected
files on its own lane DB (T-388 nine pull suites 182/182; T-383 S2b 48 files 688/688; T-389 23 files 283/283; T-395 on a
fresh DB 332/333, the one fail `inbox-ingestor` flaky, passes alone) · build: skipped, dev server live on 9008 ·
browser smoke on 9008 for T-383 S2a/S2b, T-388, T-389 S1 (forged sessions).

## What happened this session
- **Shipped to main (in the PR):** T-386 S5 `npm run recode-items` (dry run by default); T-383 S2a retire/restore +
  S2b a retired item stays usable until its stock is used up, refused in words for order/receive/price/map/new recipe;
  T-388 a POS usage pull posts what has stock and holds back only the short item (DEF-618..622 fixed); T-389 S1 a refused
  save keeps your typing (mechanism + 4 forms + guard G10, bound to the signed-in person; DEF-617 partly); T-395 S1 PIN
  attempts charged before the check, 50 wrong PINs/day stop a store (DEF-626 fixed; migration 0190).
- **Ian's rulings, all recorded:** row 296 (CI once a day at wrap-up; exceptions: early PR to unblock Ian, migrations
  own PR or prechecked); row 297 (a pull section is finalized only when every confirmed line posted); DEF-618 = a;
  t388-q1 = a (old finalized days stay); t389-q1 = a (supplier bank number not kept). Open Questions page holds each.
- **Defects:** DEF-618..627 logged; 618-622, 626 fixed; 624 not a defect; 623 (opening stock never posted → T-390),
  625 (POSTING-PATTERNS opening example contradicts row 109), 627 (duplicate supplier name gets the generic refusal →
  T-343) open. DEF-063 corrected: T-303 already had a basic lockout.
- **Specs written and reviewed by a fresh Opus:** T-388 (built), T-389, T-390 (money review applied; S2 waits on
  t390-q2), T-395. T-390..T-397 reserved. UI session merged PR #6 (T-387 theme docs) and opened PR #7 (T-387 build plan).

## Pick up here
1. **The PR:** when its CI is green, run the 0190 precheck with Ian (as `doadmin`, READ ONLY), then merge on his go;
   watch the deploy; expect one more row in `drizzle.__drizzle_migrations` than after 0189; record results in
   `docs/ops/README.md`. Then **T-386 S5 recode dry run on production with Ian** before `--apply`.
2. **T-389 S2–S4** (29 forms in 21 pages; baseline `apps/erp/tests/typed-baseline.json`) — three lanes on disjoint
   pages, or one Workflow sweep if Ian approves (speed proposal 5).
3. **T-395 S2** (findings + reopen panel + smoke script) and **T-390 S1/S3/S4** (S2 waits on t390-q2).

## Do not decide these alone — they are Ian's (Open Questions page)
- `plan-q1`..`plan-q13` — the cutover plan; **Q1 decides what v2 runs on 1 Jan** (recommended b: books, sales, expenses,
  AP/AR, inventory; payroll/attendance stay on v1 to 1 Mar). Q7 needs Ian to place a Spaces key on the droplet.
- `t390-q2` opening-stock cost basis (bible says weighted average; recommended last v1 delivery price) — holds T-390 S2.
- `t390-q1` cost for items with no v1 delivery · `t395-q1` 50-a-day stop (a needs an email-capable manager per store).
- Speed proposals (chat 10 Oct): 1,3,4,6,7 in use; **5 (Workflow sweeps) needs Ian's opt-in**. PR #7 merge; t387-q4..q7.
- POS "collected" follow-ups (`pos-collected-lipa`); automatic morning import (plan Q6).

## Traps that have actually bitten
- **Two agents on one lane DB truncate each other's fixtures** — tester and builder never run integration at the same
  time on the same DB; give each its own when parallel.
- **Testers ran `git stash`/`git status` in shared worktrees** — briefings say "never run any git command".
- **Heavy unit guards time out under parallel load** — rerun alone with `--testTimeout=60000` before calling red.
- **Lane worktrees hold junctions** (`wt-t385`, `wt-t386` are live and reusable): never `git worktree remove --force`;
  remove links first (memory `worktree-node-modules-junction`). Dev server runs from the main tree only.
- **Smoke fixtures need a stock layer, not only a movement** ("only 0.000 available"); stock never goes below zero.

## Lane DBs (drop when convenient)
`shareat_test_t386s5`, `t383s2a`, `t383s2b`, `t388`, `t388s2`, `t389`, `t395`, `t395b`, `t395c`, `t395d`, `smoke383`
(the 9008 smoke DB: SMOKE_ORG, SmokeAdmin super-admin, SmokeManager), plus the older ones in git history.

## The paste-ready prompt
```
You are the orchestrator for shareat-system (C:\Users\ianla\webapps\shareat-system). Run the global
/orchestrator skill. You are starting COLD. Read docs/HANDOFF-TODAY.md (all), docs/RULES.md and
docs/plans/remaining-build-plan.md §0-§3. Read the Open Questions page (bible row 252) with ArtifactData
before building anything gated on Ian. GREP the register and bible, never Read them whole.
State: production at 0189 (7489bba). PR for branch release/2026-10-10 carries T-383 S2, T-386 S5, T-388,
T-389 S1, T-395 S1 + migration 0190: merge only when CI is green, after the 0190 precheck with Ian, on his go;
then the T-386 recode dry run with Ian. Next: T-389 S2-S4, T-395 S2, T-390 S1/S3/S4. Next free migration 0191.
STANDING: GitHub CI once a day at wrap-up (row 296; exceptions: early PR to unblock Ian, migrations prechecked);
lanes are Sonnet subagents (tester/builder/auditor separate, own _test DB, worktrees wt-t385/wt-t386; never two
agents on one DB at once; workers never run git); Opus for specs and a fresh Opus review of every money/auth spec;
never commit a lane while its agent has background work; byte-check every changed file for \r and \x08;
republish docs/WHATS-LEFT.html after every DEF close. Messages are short.
```

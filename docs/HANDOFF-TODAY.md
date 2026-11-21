# Handoff: 2026-11-22

## Where things stand

**31 PRs merged and deployed between 19 and 22 Nov.** erp2 runs main `8cf5b6f`, with migrations through **0273** applied. The merge queue is **empty**: only #171 is open, an old parked work order.

- **POS v2:** money-complete for go-live.
  - Convert, wrong-payment correction, refunds, the refund-excess entry, Find a receipt, TEST slips, one receipt number, offline cold start, and the live-switch safety checks.
  - **Still to do:** the printing check on a real Lipa tablet (T-532 S5), then go-live.
- **Other big pieces:** staff access (T-609, T-612), every route gated (T-603, T-616, T-617), five money batches, the whole defect sweep (T-598), loan interest split, copy-between-stores, and CI that's twice as fast (~17 min).

## Gates at `8cf5b6f` (main CI, split jobs)

typecheck ✅ · unit ✅ · integration 1 ✅ · integration 2 ✅ · build ✅ · customer and pos builds ✅ · required check "typecheck, test, build" ✅. Deploy ✅.

Local gates were **not** re-run at wrap-up: the laptop has a 90% memory cap and a whole-repo tsc takes 3.4 GB. CI on main is the record (bible row 296).

## What happened (by theme), with where each decision is recorded

- **POS go-live money:**
  - T-534 (Convert, correction, refund), T-601 S4-S6, T-613, T-614.
  - Bible rows **488** (managers approve corrections) and **489** (Convert first; refunds the way they were paid; refund excess is permanent).
- **Printing:** T-532 S1-S4. The printer screen, the Android shell `net.shareat.erppos` (signed APK artifact from `pos-shell-build.yml`) and the offline service worker.
- **Staff and access:**
  - T-609 (row **490**), T-612 account status (row **494**, supersedes 340).
  - T-603 S2-S5, T-616 and T-617 (row **495**).
  - T-619 PIN reset on promotion (row **496**; **building**, see below).
- **Money:**
  - T-593..T-597, T-600, T-602, T-608 (rows **485-487**), T-613, T-615, T-618.
  - DEF register rows were updated by each PR.
- **Settings:** T-610 overlapping hours (row **492**) and T-611 copy from another store (row **493**).
- **Business documents:** they left the public repo for the local `shareat-knowledge/` folder (row **484**). The folder now holds every AI's work, with a register, an index and a 6 AM tidy bot that backs up to Google Drive (row **491**).
- **Working practice:**
  - BOSS pushes builders' branches; the DELL PC is a second builder host (row **497**).
  - CI is split into jobs (T-604).
  - `npm run census:write` re-measures every census pin.

## Pick up here

1. **T-619** (PIN reset on promotion) is being built on the laptop (worktree `wt-t619`). Finish it, push it, audit it (Sonnet, auth), then queue it.
2. **T-599** (long pages redesign) is on the DELL PC, branch `t599-long-pages`: S0-S3 done, E2/E3 in progress. When the DELL session reports, push from there (`ssh dell@192.168.1.2`, clone `C:\shareat\shareat-system`) and open the PR.
3. **Lipa go-live path:**
   - Ian installs the `pos-shell` APK beside the old app.
   - He pairs the Bluetooth printer and runs `docs/runbooks/pos-lipa-switch.md` §B. Record the result in `pos-go-no-go.md`.

## Do not decide these alone (Ian's)

- **DEF-923:** a pre-T-594 remittance whose leg was voided can't be reversed. It needs a production check and a one-off repair, with Ian.
- **DEF-943:** the inter-store pair lock for the AP/AR/loans/expenses/payroll/trade-returns writers. They take draw locks first, so adding the pair lock means a lock-order redesign. It needs a spec and Ian's OK on the risk.
- **T-607 Xlice:** waits for Ian's data.
- **Make the GitHub repo private.** It is public, and old commits still hold the business documents. That's Ian's setting.
- **Google Drive for desktop:** not installed on the laptop yet, so the knowledge tidy bot can't back up until it is.

## Traps that have actually bitten (19-22 Nov)

- **Squash merges mean every dependent PR conflicts with main.** Merge main into the dependent branch (never rebase). Re-measure pins with `npm run census:write`, never by hand.
- **Raw `journal_entries` fixtures** must use the fiscal period that contains the entry date (trigger 0270).
- **Builders' leftover vitest processes** hold files and block worktree removal. Kill them by PID (filter on the worktree path).
- **Subagent `git push` is refused**; BOSS pushes.
- **Production DB access:** the managed DB only trusts the droplet. Run read-only pre-checks from `159.223.46.224` with `psql` as doadmin. Ian types the password.
- **A migration on a test DB that already has a later migration applied** gets skipped by drizzle. Recreate the test DB.

## The paste-ready prompt

```
You are BOSS for C:\Users\ianla\webapps\shareat-system. Read docs/HANDOFF-TODAY.md, then docs/RULES.md.
First: finish T-619 (worktree wt-t619; spec docs/tasks/619-pin-reset-on-promotion.md), audit, push, queue with TESTER & MERGER.
Then: check the DELL PC session for T-599 (branch t599-long-pages on the DELL clone) and push/PR it.
Keep both PCs busy, one builder each, under 90% memory. Merge queue rules: shareat-coord/BOARD.md.
```

# T-454: Drop Banay-Banay from v2 (the store closes 31 Dec 2026; Lipa buys it back)

**Status:** S1, S2, S4 live (PRs #95, #99); S3 docs done; S5 not built (Ian's Q4). Spec written 2026-10-29 by the Opus planner, measured on `origin/main` `b3ace76`.
**Rulings:** bible row **377** (Ian, 22 Oct: drop Banay-Banay completely from v2) and row **384** (Ian, 24 Oct: it
closes at the end of 2026, Lipa buys it back, its closing stock, cash and equipment pass to Lipa **in v1 before
cutover**, nothing of Banay-Banay is opened in v2). **New, Ian 29 Oct: the closing date is 31 Dec 2026** (needs its
bible row; orchestrator only).
**Model:** S1, S2, S4 Sonnet (tester first, then builder). S3 is a docs sweep (Haiku). S5 only if §9 Q4 needs it.
**Migration:** **none.** No table, no CHECK, no definer.
**Size:** ≈ 2.0 lane-days (S5 +0.5 if needed).

## 1. Goal in plain words

Banay-Banay keeps trading in v1 until it closes on 31 Dec. v2 never learns it existed as a live store: no POS link,
no imported sales days, no place in the dual run, no items, suppliers, customers or staff loaded for it, no opening
balance on 1 Jan. Before cutover, everything it still holds (stock, cash, equipment, and anything it owes or is owed)
is moved to Lipa **in v1**, so Lipa's v1 closing figures already contain it and Lipa's v2 opening picks it up with no
special step. A check proves Banay-Banay's v1 balances are zero at the close of 31 Dec; if any are not, the cutover
stops and names them. Its history stays in v1 for good.

v1's goal here (row 283) is only bookkeeping continuity; v1 has no "close a store" process at all, so v2 adds none
either. The one thing v2 adds is the **zero-balance proof**, because a closing store's last balances are exactly the
kind of money that disappears silently (see `docs/plans/phase-3-inventory.md:295`: ₱12,184.71 of Banay-Banay AP was
once never booked).

## 2. What v2 must NOT do

1. Create, link or import anything for POS store `zZM9TfGqSyA5eDg2kyrv` (Banay-Banay's POS v1 id). The POS key map
   gets Lipa, Malvar, Davao (and later Padre Garcia), never Banay-Banay.
2. Compare Banay-Banay in the dual run (T-392), or refuse a run because Banay-Banay's keys-sheet row is unticked.
3. Load any master data for v1 store `iGOW7q2pZbeHWV832UNh` (T-391): no items, suppliers, customers, staff, and it
   no longer counts in the org-wide unit and kind majorities (R5).
4. Give it an organisation, a v2 store row that is active on 1 Jan, a room, a count sheet, an opening entry, a fixed
   asset, a money account, a clock terminal or a POS v2 tablet.
5. Delete anything. If a Banay-Banay store row exists in v2 production, it is **deactivated**, never deleted
   (`deactivateStore`, `packages/domain/src/stores/service.ts:545`).
6. Touch v1 or POS v1 (read-only, CLAUDE.md). The moves to Lipa are done in v1 by Ian's team.

What stays, on purpose: the v1 **audit** tool keeps Banay-Banay (`packages/etl/src/audit/balances.ts:51-56`) because
it reads v1 history and is the tool that proves the zero balances (S4). Historical text that describes the past
(golden attendance fixtures, `scripts/capture-attendance-golden.ts:33`, migration 0111's comment, DEF-087/114/170/173/
256, discovery files, the 24 Aug v1 audit review, CAPABILITY-MATRIX line 215, T-114a, T-173, T-197, T-314) is left
alone: it is true about the past.

## 3. Measured on `origin/main` (b3ace76, 29 Oct)

| # | Where | What it does today | Effect if left |
|---|---|---|---|
| M1 | `packages/etl/src/dual-run/snapshot.ts:54-59` | `OPERATING` lists Banay-Banay; `domain/src/dual-run/index.ts:172` calls `assertStoresTicked(rows, snapshot.stores…)` | ⛔ **The dual run starting Mon 2 Nov refuses** ("v1 stores not mapped") unless someone ticks a Banay-Banay row with a v2 key, and Banay-Banay has no v2 store. Urgent: S1 |
| M2 | `packages/etl/src/master-data/snapshot.ts:44-55` | `roleOf` pre-fills Banay-Banay as `own` in the `stores.csv` skeleton | A fresh extract proposes loading it |
| M3 | `packages/etl/src/master-data/store-map.ts` | No closed-store guard; Ian's server `stores.csv` (filled ~15 Oct, Q1) very likely has `BNBN` as `own` | Malvar/Davao runs still count Banay-Banay in the unit majorities (R5); a `--stores BNBN` run would load it |
| M4 | `docs/tasks/391-production-master-data-load.md:436,469` | Rollout `--stores MLVR,BNBN,DVO`; Q1 names four stores | Runbook would load it |
| M5 | `docs/tasks/396-link-remaining-stores-and-morning-import.md:1,3,24,231,263` | Title, status, S4 runbook and Q3 list Banay-Banay | Runbook would link it |
| M6 | `docs/ops/pos-v1-key.md:11` | Lists its POS id with no note | Key map could be widened to include it |
| M7 | `docs/STORE-ROSTER.md:10` | "operating" | Wrong after 31 Dec |
| M8 | `docs/tasks/392-dual-run-comparator.md:320` (t392-q4) | "Malvar, Banay-Banay and Davao start 2 Nov" | Per-store day count would include it |
| M9 | `docs/plans/pos-customer-v2-phase-plan.md:85` | "1 Feb Banay-Banay" in the P0 rollout | Contradicts its own line 28 |
| M10 | `docs/plans/remaining-build-plan.md:89,196`; `docs/ROADMAP.html:239`; `docs/decisions/ADR-015…md:231` | Name it in the link/rollout plans | Stale plan text |
| M11 | `docs/ops/cutover-runbook.md` | No Banay-Banay step; E5 says "scale Lipa's time by four stores" | Count and zero-check not planned |
| M12 | `docs/tasks/472-pos-nightly-receipt-bridge.md:72,92` | Already excludes it ("after T-454") | No change |
| M13 | Production v2 | Unknown whether a Banay-Banay store row exists (T-391 applied Lipa only, 17 Oct; stores can be added at `/admin/stores`) | An active row would put it in the opening wizard and the store pickers |

Tests that use Banay-Banay's id as a generic "third own store" (`packages/etl/tests/t391-s2-*.test.ts`,
`t391-s4-parties-plan.test.ts`, `packages/domain/tests/integration/t391-s3..s6-*.test.ts`) stay as they are: S2's
guard sits in the CLI path, not in `parseStoreMap`, so those fixtures need no churn (see S2).

## 4. Changes, by slice

### S1 — dual run leaves Banay-Banay out (0.5 day, Sonnet; ⛔ before the first weekly dual-run report)

- `packages/etl/src/dual-run/snapshot.ts`: move `iGOW7q2pZbeHWV832UNh` from `OPERATING` to `EXCLUDED` with reason
  `'closing 31 Dec 2026; dropped from v2 (rows 377, 384)'`. Its documents then classify as `drop`; the unknown-store
  refusal stays for any id in neither list.
- `packages/domain/src/dual-run/index.ts`: no code change expected (it already feeds `snapshot.stores`, which no longer
  holds Banay-Banay). The report already prints `excluded` (`:364`); the tester confirms the reason text shows.
- Tests re-ruled: `packages/etl/tests/t392-s1-v1-figures.test.ts:415-417` ("Banay-Banay present, hasData false")
  becomes "Banay-Banay excluded, with its reason"; `:536-568` keep the refusal shape using Malvar as the unticked
  store; fixtures `packages/etl/tests/fixtures/t392-keys.csv:4` (row removed) and `t392-v1-snapshot.json` (unchanged:
  the store stays in the raw roster, which is exactly what proves the exclusion).
- Ops note (Ian, on the server): delete or untick the Banay-Banay row in the dual-run `keys.csv`; it is now ignored
  either way.

### S2 — master data never loads it (0.5 day, Sonnet)

- `packages/etl/src/master-data/snapshot.ts`: `roleOf` returns `'exclude'` for Banay-Banay (a named constant with a
  comment citing rows 377/384), so a fresh `stores.csv` skeleton proposes `exclude`.
- `packages/etl/src/master-data/store-map.ts`: export `CLOSED_V1_STORES = { iGOW7q2pZbeHWV832UNh: 'SharEat
  Banay-Banay (closes 31 Dec 2026, rows 377, 384)' }` and `assertClosedStoresExcluded(rows)`: any row for a closed id
  whose role is not `exclude` is refused in one plain sentence ("Banay-Banay closes on 31 Dec 2026 and is not loaded
  into v2 (bible row 377). Set its role to exclude in stores.csv."). Called from **both** CLI entry points that read a
  map: `scripts/lib/master-data-apply.ts` (beside `assertRunTarget`, `:117` and `:230`) and the readiness path
  (`scripts/lib/master-data-readiness.ts`) if it reads the map. Not called from `parseStoreMap`, so test fixtures
  that use the id as a generic store keep working.
- Ops (Ian, on the server, before the Malvar/Davao loads): edit `/srv/shareat-shared/master-data/stores.csv`,
  Banay-Banay's role → `exclude`. Then re-run the Malvar and Davao **dry runs** and compare their held counts with the
  last dry run: dropping a store from the majorities can flip an item's unit (R5, e.g. tomato `pcs` at Malvar and
  Banay-Banay). T-391's I-i rule already protects the Lipa items applied on 17 Oct (an existing item is never
  changed; a unit clash is held for a factor on `items-units.csv`). Any new held rows go to Ian with the run.

### S3 — documents say it is closed (0.5 day, Haiku; orchestrator reviews)

| File | Change |
|---|---|
| `docs/STORE-ROSTER.md:10` | Status "operating; **closes 31 Dec 2026**, bought back by Lipa; not in v2 (rows 377, 384)"; the "four operating stores" sentence gets "(three in v2)" |
| `docs/ops/pos-v1-key.md:11` | Row stays (the id is a fact); add "never added to the v2 key map (T-454)" |
| `docs/tasks/396-…md` | Title "Link Malvar and Davao…"; status, `:24`, `:231` runbook list and Q3 drop Banay-Banay; one line citing row 377 |
| `docs/tasks/391-…md` | `:436` `--stores MLVR,DVO`; `:469` Q1 note "Banay-Banay: `exclude` (row 377, T-454)" |
| `docs/tasks/392-…md:320` | t392-q4 note: Banay-Banay is out of the dual run (row 377) |
| `docs/plans/pos-customer-v2-phase-plan.md:85` | "25 Jan Malvar · 1 Feb Davao" (matches its line 28) |
| `docs/plans/remaining-build-plan.md:89,196`; `docs/ROADMAP.html:239` | "Malvar, Davao" with "(Banay-Banay dropped, row 377)" |
| `docs/decisions/ADR-015-…md:231` | Not rewritten (an ADR records a past decision): add a dated note under the table "Banay-Banay dropped, row 377" |
| `docs/ops/cutover-runbook.md` | New steps from §5 (B0-B4); E5's "four stores" → "three stores" |
| `docs/tasks/454-drop-banay-banay.md` | Status line as slices land |

The bible row for the 31 Dec date and any answer in §9 is the orchestrator's to write.

### S4 — the zero-balance proof and the production check (0.5 day, Sonnet)

- **Zero-balance check (v1, read-only).** Add `--expect-zero` to the existing v1 audit CLI (the one that calls
  `packages/etl/src/audit/balances.ts`, `storeIds` param at `:310`). With `--stores iGOW7q2pZbeHWV832UNh --as-of
  2026-12-31 --expect-zero`: exit 0 only when **every** account's balance for that store is exactly ₱0.00 (each
  account on its own, never a net total); otherwise exit 1 and print one line per non-zero account (code, name,
  amount) plus every open party balance (supplier, customer) by name. Stock on hand in v1 counts as a balance (1310-
  1330 lines). It writes nothing.
- **Production v2 check (read-only SQL, Ian runs it).** New `docs/ops/P454-precheck.sql`, in the shape of
  `P0214-precheck.sql`: lists any `stores` row whose name matches `banay` or whose code is `BNBN`, with `is_active`,
  and counts rows pointing at it in `journal_lines`, `stock_movements`, `sales_days`, `employments`,
  `pos_v1_store_links`, `clock_terminals`. Expected result: no row. If a row exists: Ian deactivates it on
  `/admin/stores/<id>` (existing, `deactivateStoreAction`); any pilot rows on it are purged by the 1 Jan purge like
  every other pilot row (T-394), so nothing else is done.
- **Opening wizard with an inactive store.** The tester checks (green-as-guard if already true) that the cutover
  `verify` and tie-out (`packages/domain/src/cutover/tie-out.ts`, `packages/db/src/repo/cutover.ts:484`
  `storeNamesOf`) neither demand a count nor an opening for an **inactive** store with no rows. If either does,
  the builder filters on `is_active` there, in that one query.

### S5 — only if needed (0.5 day, Sonnet; after §9 Q4)

If Ian's answer to Q4 records the buy-back in v1 **inside a week the dual run still reports** (any week before the
cutover), Lipa's last-week v1 legs from it have no v2 twin and would show as `NOT_DOUBLE_ENTERED` (encoder blame).
Then: add class `CLOSED_STORE_BUYBACK` (family `scope`, authority rows 377/384) to
`packages/etl/src/dual-run/classes.ts`, assigned to a Lipa v1 leg only when its source document names Banay-Banay as
the other store. The tester first measures (Haiku) how v1 records a store-to-store transfer of stock and cash and
which field names the other store; the class matches on that field, never on text. If the move is recorded after the
last reported week, S5 is not built.

## 5. Sequence around 31 Dec and the 1 Jan cutover

| When | Who | Step |
|---|---|---|
| **by Fri 30 Oct** | lane | **S1 merged** (dual run starts Mon 2 Nov; the first weekly report must not refuse) |
| by Fri 6 Nov | lane, Ian | S2 merged; Ian edits the server `stores.csv` (Banay-Banay → `exclude`), re-runs Malvar/Davao dry runs |
| by Fri 6 Nov | Haiku, orchestrator | S3 docs; S4 merged |
| before the 13 Nov rehearsal | Ian | Runs `P454-precheck.sql` on production; deactivates a Banay-Banay row if one exists. The rehearsal expects **no** active Banay-Banay store, count or opening |
| by Tue 15 Dec | Ian | Answers Q1 (staff list) |
| by 23 Dec | Ian's team, in v1 | Movers' employment moved to Lipa effective 1 Jan (if Q1 = move); open bills and customer balances settled or moved to Lipa (Q3) |
| **31 Dec** | Banay-Banay | Last trading day. After close (Q2): stock counted, cash handed over, equipment listed; each recorded in v1 as moving to Lipa, dated 31 Dec |
| 31 Dec, night (runbook B1) | counter, encoder | Banay-Banay's counted stock is added to **Lipa's** opening count (Q2 a) |
| 31 Dec, before E-steps end (runbook B2) | Ian | `--expect-zero` audit for Banay-Banay as of 31 Dec → **exit 0**. Any line not zero: fix it in v1 (move it to Lipa) and run again. ⛔ No cutover purge until it passes |
| 1-2 Jan (C3) | encoder | Lipa's opening figures include what came from Banay-Banay (it is in Lipa's v1 balances already). Nothing is entered for Banay-Banay |
| After cutover | Ian | Website and CUSTOMER app stop listing Banay-Banay (those are live v1-side apps, not this repo); POS v1 store left alone (history) |

Runbook steps B0-B4 for `docs/ops/cutover-runbook.md`: B0 precheck run (13 Nov rehearsal); B1 count added to Lipa;
B2 zero check; B3 confirm no Banay-Banay store is active in v2 (`P454-precheck.sql` again); B4 the rehearsal report
lists no Banay-Banay row.

## 6. Tests (tester writes them first; each names the mutant it kills)

| # | Slice | Case | Expect | Mutant it kills |
|---|---|---|---|---|
| T1 | S1 | `buildSnapshot` with the full v1 roster incl. Banay-Banay and Banay-Banay journal/expense/salesDay docs in the window | Banay-Banay in `excludedStores` with the row-377 reason; not in `stores`; none of its docs in `journal`/`expenses`/`salesDays` | Banay-Banay left in `OPERATING` |
| T2 | S1 | Dual-run `run` with a keys sheet that has **no** Banay-Banay row (Lipa, Malvar, Davao ticked) | Runs; no "not mapped" refusal | `assertStoresTicked` fed the raw roster instead of `snapshot.stores` |
| T3 | S1 | Same run's report | Prints the exclusion line naming Banay-Banay and its reason | Reason dropped / exclusion silent |
| T4 | S1 | Roster with an unknown store id | Still refused, naming the id | `classify` defaulting unknown ids to `drop` |
| T5 | S2 | `extract` skeleton `stores.csv` | Banay-Banay row has role `exclude`; Lipa/Malvar/Davao `own`; Padre Garcia `franchise` | `roleOf` returning `own` for Banay-Banay |
| T6 | S2 | `assertClosedStoresExcluded` with Banay-Banay `own` / `franchise` / `exclude` / absent | Refused, refused (both naming Banay-Banay and row 377), passes, passes | Guard removed; guard checking only `own` |
| T7 | S2 | The CLI `run` path (dry run and `--apply`) with a map that has Banay-Banay `own` | Refused before any database read or write | Guard called from `extract` only, not from `run`/apply |
| T8 | S2 | Unit majority with Banay-Banay `exclude`: an item that is `pcs` at Malvar and Banay-Banay, `kg` at Lipa and Davao | Banay-Banay's record is not counted (tie rule of R5 applies to the three own stores only) | Majority computed over every non-`franchise` row, incl. `exclude` |
| T9 | S4 | `--expect-zero` on a v1 fixture where Banay-Banay is all zero | Exit 0, prints "Banay-Banay: every balance is zero at 2026-12-31" | — (the passing case) |
| T10 | S4 | Same with +₱100.00 in 1110 and −₱100.00 in 2110 | Exit 1, two lines naming both accounts and amounts | Check on the net total instead of each account |
| T11 | S4 | Same with a supplier balance of ₱1.00 open | Exit 1, names the supplier | Party balances not checked |
| T12 | S4 | `--expect-zero` writes nothing | No file other than stdout; no Firestore write (read-only client) | Writer client used |
| T13 | S4 | Cutover verify + tie-out with an **inactive** store that has no rows | Passes, does not name the store | Inactive store demanded (only if the builder adds the filter; else green-as-guard) |
| T14 | S5 | (only if built) A Lipa v1 transfer leg whose other store is Banay-Banay | Classed `CLOSED_STORE_BUYBACK`; any other Lipa transfer leg is not | Class matched on description text / on any transfer |

Guards that must stay green: `packages/etl/tests/t392-*`, `packages/etl/tests/t391-*`, `packages/domain/tests/
integration/t391-*`, `packages/etl/tests/audit/balances.test.ts` (it still names four stores: the audit keeps
Banay-Banay on purpose).

## 7. Fences

- No migration, no schema change, no change to `parseStoreMap`'s signature, no edit to v1, POS or CUSTOMER.
- No deletion of any v2 row, anywhere. Deactivate only, by Ian, through `/admin/stores`.
- No edit to historical text (§2 last paragraph), the bible or the defect register (orchestrator only).
- The audit tool keeps Banay-Banay in `OPERATING_STORES`.

## 8. Done when

S1-S4 merged with T1-T13 red→green (or green-as-guard where stated) and each mutant reds its leg; typecheck clean;
the dual run's first weekly report runs without a Banay-Banay refusal; Ian's server `stores.csv` says `exclude`;
`P454-precheck.sql` returns no active row; the cutover runbook carries B0-B4; on 31 Dec the zero check exits 0 before
the purge.

## 9. Questions for Ian (plain words)

**Q1. Do Banay-Banay's staff move to Lipa?** *(blocks nothing until 15 Dec)*
- (a) All of them move to Lipa from 1 Jan.
- (b) None move; each gets final pay in v1 in December.
- (c) Some move: you send the list of names by 15 Dec.

What changes: anyone who moves is added to Lipa in v2 with their **original hire date**, and gets a **new Lipa
badge number** (numbers are per store and issued automatically, row 381). Their December pay, and any pay still owed
on 31 Dec, stays in v1 and passes to Lipa like the other balances. Anyone who does not move never appears in v2.
**Recommended: (c)**, because it covers both cases and you only decide once. For movers, the simplest path is that
your team changes their store to Lipa in v1 before 23 Dec; then Lipa's normal staff load picks them up.

**Q2. Banay-Banay's stock on the night of 31 Dec.** *(needed by 13 Nov for the rehearsal)*
- (a) It trades all day on 31 Dec. That night its own staff count what is left, and the count is added to Lipa's
  opening count. The goods move to Lipa on 1 Jan.
- (b) It closes on 30 Dec. On 31 Dec everything is driven to Lipa before Lipa counts.

**Recommended: (a)**: you keep New Year's Eve sales, and adding a count sheet is easy. (b) loses one busy day.

**Q3. Bills Banay-Banay still owes, and money owed to it, on 31 Dec.**
- (a) Your team pays and collects everything in v1 before 31 Dec.
- (b) Whatever is still open moves to Lipa in v1, so Lipa pays or collects it from January.

**Recommended: (b)** for anything not settled in time. Either way the zero check on 31 Dec proves nothing is left
under Banay-Banay. Without it, an unpaid bill could simply vanish.

**Q4. How will your team record the buy-back in v1, and on what date?** *(information; decides whether S5 is built)*
For example: stock moved to Lipa, cash handed to Lipa, equipment listed under Lipa, all dated 31 Dec. If someone
else owns part of Banay-Banay and Lipa pays them, your accountant records that payment in v1 too. v2 needs nothing
from it, because it only sees Lipa's balances afterwards. **Recommended:** everything dated 31 Dec, after closing.
Then the dual run never reports it and S5 is not needed.

## 10. Ian's answers (2026-10-29, orchestrator session) — these bind

- **Q1 = (a).** All Banay-Banay staff move to Lipa from 1 Jan (no list needed).
- **Q2 = (a), done offline.** No count is recorded in any system for Banay-Banay. It closes manually; what is left is
  simply included in **Lipa's own opening count**. Everything is closed within 2026.
- **Q3 = (a).** Everything is paid and collected before 31 Dec; nothing open moves to Lipa.
- **Q4: manual and offline.** The buy-back is not recorded store-to-store in v1; Lipa's opening figures carry it.
  **S5 is not built** (no v1 transfer legs to classify).

### Planner ruling on S4 (follows from Q2/Q4)
Banay-Banay's v1 cash, stock and equipment balances will **not** be zero on 31 Dec, because the hand-over is offline
and nothing moves them in v1. So `--expect-zero` checks **party balances only** (every supplier and customer at ₱0.00,
by name, which proves Q3) and exits 1 on any open party balance. Account balances (cash, stock 1310-1330, equipment)
are **printed as information** under the heading "Handled offline, carried in Lipa's opening" and never fail the
check. T10 becomes: a ₱100.00 cash balance alone → exit 0 with the information line; T11 unchanged (an open
supplier balance → exit 1). Timeline rows for 23 Dec and 31 Dec read accordingly: no v1 entries for the move.

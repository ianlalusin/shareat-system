# The POS sales and usage pulls on one backend: redesign proposal

> Opus planner, 2026-10-05, using `/research-evaluate-propose`. Answers Open Question **t374-q1** and bible §13
> **row 281**. Research only: it decides nothing and amends nothing. Ian (verbatim): *"need to redesign this pull from
> pos. this sales and inventory/usage pull from pos exist because v1 backend are separate/different now in v2 we have
> unified backend so this can be improved, changed, replaced with. plan this and suggest using research evaluate
> propose skill"*.
> **Status: PROPOSED. Waiting for Ian's answers to §9.** T-375 S5 is not built until then (row 281).

## Summary (read this alone)

1. **Verdict: build something smaller now, and something different later.** In the end state there is no pull at all.
   Stock usage becomes one more thing the **sales-day closing** derives from POS receipts that already sit in our
   Postgres, the same way the sales figures are derived. Until then, keep T-375 S4 and S6 as written, and build a
   **cut-down S5** that reads the sold items the import already stores. No new migration is needed for the interim.
2. **Ian's reason holds, but only from P2.** Today POS v1 is still a separate system on `shareat-hub-v2`, reached over
   its key-protected API. So something still has to fetch from it until each store's receipts reach Postgres (ADR-015
   P2, Q1–Q2 2027). What changes is how that fetch is shaped: one stored source document, read many times, and never a
   second live call.
3. **Most of what is built survives.** The planner (`plan.ts`), the finalize engine and the pull void (T-374 S7) are
   the **usage engine**. Only its input changes: POS's stored sold items now, receipt lines at P2. What is thrown away at
   P2 is small: the HTTP fetcher, the recheck, the store link, and the T-210 comparison screen.
4. **"Void a pull" stops being an everyday tool.** At the end state receipts are immutable, and a refund is a new
   receipt dated on its own day (row 272). So a closed day's usage never needs to be undone because POS changed. The
   void (T-374 S7) stays only as an escape hatch for a wrong recipe or a wrong location, and stays with managers and up.
5. **Four questions for Ian (§9):** when usage posts in the end state; whether a refund puts stock back; who may void a
   day's usage (t374-q1, both phases); and dropping POS usage for days typed before a store was linked.

## 1. Verdict

**Build a smaller version now; build something different at P2.**

| Phase | Build | Do not build |
|---|---|---|
| **Interim (now to P2, per store)** | T-375 S4 as written. **S5-lite:** usage reads the sold items stored with the day's own import, pinned on the pull, with no live call and no separate capture. T-375 S6 as written | S5's "usage" capture path (`purpose = 'usage'`), usage on typed days, any polish of the live fetch |
| **End state (P2 onwards, per store)** | Usage derived from receipt lines × each menu item's depletion rule, posted automatically when the sales day closes. Late receipts are caught up by a delta. A void-and-redo only as an escape hatch | Any pull, button or fetch. CDC, a message broker, per-receipt stock posting |

## 2. The stated reason, and whether it holds

- **"The pull exists because v1's backends were separate."** True. v1 ERP calls POS over HTTP
  (`ERP-rebuild/src/lib/server/pos-api.ts:143-168`, per T-375 §v1). v1 also caches the sold-items response in Firestore,
  so the plan does not move between preview and post (`ERP-rebuild/src/lib/server/pos-sold-items-cache.ts:1-13`).
  That cache is v1 working around the separation.
- **"In v2 we have a unified backend."** True for the ERP. **Not yet true for POS.** The till stays on Firebase until P2
  reaches each store (ADR-015 §2, the phases table). P0 (the copy) goes live after 1 Jan 2027 and is still on
  `shareat-hub-v2`. So in 2026, and for each store until its P2 flip, the only way to know what POS sold is still the
  HTTP API.
- **So the reason supports a redesign of the end state, and a slimmer interim.** It does not support skipping the
  interim. Without one, a linked store's stock would never be depleted by sales until Q1–Q2 2027.
- **A second reason Ian did not state, and it is the stronger one:** the interim live fetch is the bug factory.
  Today's usage pull calls POS twice for one plan: once at plan (`packages/domain/src/pos/usage-pull.ts:187`) and again
  at finalize (`:272`). It calls POS with our own store uuid (`:70-71`, ✎N1), so POS answers "not found" and the plan
  is silently empty (`:79`). And it needs a one-hour staleness guard (`:88`, `:264-267`) only because the source can
  move under it. A stored source document removes all three.

## 3. What already exists

### Here (shareat-system)

| Piece | Where | Survives to the end state? |
|---|---|---|
| Pure explosion: sold quantities × maps × recipes → lines; "no Firestore, no Postgres, no fetch" | `packages/domain/src/pos/plan.ts:4`, `explodePosSales` `:150` | **Yes, unchanged.** Its input is already a plain array of sold items. That array is the seam |
| Finalize: per-location savepoints, frozen room refuses its lines and not the pull, one-shot per section | `usage-pull.ts:250-379` (savepoint `:340`, skip ≤ 0 `:329`) | **Yes.** It becomes the posting step of the usage closing |
| Pull void as a document, all or none, dated on the sales day if that stock month is open (T-374 S7, 0181) | `usage-pull.ts:402`; `voidPullUsageRecord`; `sales-days/verify.ts:205-208` | **Yes, as the escape hatch** |
| Live sold-items fetch with the v2 uuid (✎N1) | `usage-pull.ts:63-85` | **No.** S5 deletes it |
| Live sales fetch for T-210 | `pos/sales-pull.ts:26-45` | **No.** S6 deletes it |
| POS v1 fetcher with timeout and named failures, called with POS's own store id | `pos/v1-feed.ts:21-33`, `:100` | Until P2 per store |
| ⭐ **The import already stores BOTH kinds**, sales and sold items, in one batch | `sales-days/import.ts:113-123` (`fetchBoth`), `:200-212` (`insertBatch` with `sold_items`) | The table freezes at P2 as archived source documents (ADR-015 §7) |
| `pos_usage_pulls.pos_v1_day_feed_id` already exists (0183) | `packages/db/schema/pos-mapping.ts:190` | Yes. S5-lite needs **no migration** |
| Feed purposes `import`, `recheck`, `usage` | `schema/pos-v1.ts:105,124` | `usage` stays in the CHECK but is never written (harmless) |
| Depletion rules: `pos_item_maps` direct, recipe or no-stock | `schema/pos-mapping.ts:65-109`; `pos/item-map.ts:41` | Yes. At P1 it becomes the menu item's depletion rule (ADR-015 §2 entity table) |
| The sales-day lock, the derived-closing contract, tenders | T-375 R6, S2–S4 | Yes. This is the end state (ADR-015 §7) |
| Capabilities: `finalize_pos_usage_pull` and `void_usage_record`, both manager, admin and super admin | `docs/decisions/CAPABILITY-MATRIX.md:80,90` | Yes (§8) |

### In the systems the business runs today

- **v1 ERP's pull is a reconciler, not a poster.** It diffs each demand line against what earlier pulls wrote, and
  picks create, update, revise (void and recreate) or void-only per line
  (`ERP-rebuild/src/lib/financial/posUsagePull.ts:1-25`, `pos-usage-pull.actions.ts:468-488`). A revise needs a manager
  with void rights (`pos-usage-pull.actions.ts:399`, `actorCanVoid`). **The goal v1 serves:** *"fix a mapping and
  re-pull"* cheaply, without a void permission for every correction (`posUsagePull.ts:19-25`).
- **POS computes sold items live from receipts on every call.** It reads the day's receipts by the CLIENT clock
  (`POS/src/app/api/external/sold-items/route.ts:37-47`). It nets refunds as negative quantities and skips voided
  receipts (`POS/src/lib/analytics/sold-items-core.ts:100-109`). And **it counts only `type: 'addon'` lines**
  (`sold-items-core.ts:113`). So the pull depletes à-la-carte items and add-ons. **It never depletes what a package
  (unli) table ate**: refills carry no quantity a sale can see. Package meat is measured by counts and usage records.
  This bounds what any redesign of "sales-driven usage" can deliver.
- **What POS returns can change after the day.** In v1 a closed receipt can be edited or voided (row 272 removes this
  in the P0 copy), and a refund lands on the day it is rung. So a v1 sold-items response is not stable. That is why
  S6's recheck exists.

## 4. What the industry does

| Pattern | Who | Fit here |
|---|---|---|
| **Stock and cost posted in one batch at session or day close, from the sale documents** | Odoo POS, "update quantities at the session closing" ([Odoo forum, real time vs at closing](https://www.odoo.com/forum/help-1/pos-what-is-the-configuration-inventory-real-time-vs-at-closing-of-the-session-and-how-to-use-it-198659); [Odoo 16 POS docs](https://www.odoo.com/documentation/16.0/applications/sales/point_of_sale.html)). ERPNext POS Closing Entry consolidates POS invoices into one posting ([ERPNext](https://docs.erpnext.com/docs/user/manual/en/pos_invoice_consolidation)) | ⭐ **The end state.** Our sales day is already a closing over a source (row 270). Usage joins it |
| **Recipe depletion and "actual vs theoretical"** | Restaurant365: theoretical cost = the recipe cost of what sold; the gap to counts is waste, theft and price drift ([R365 menu item analysis](https://docs.restaurant365.com/docs/menu-item-analysis); [AvT](https://www.restaurant365.com/blog/recipe-costing-vs-food-costing/)) | A wrong recipe shows up as count variance. **It is fixed going forward, not by rewriting past days** (§6, told-not-asked T2) |
| **Refunds are reversing documents dated when they happen** | Every POS (row 272) | No closed day ever changes because of a refund |
| **Transactional outbox / store-and-forward** | [microservices.io](https://microservices.io/patterns/data/transactional-outbox.html); the device outbox (ADR-015 §5) | Already chosen for the till. Inside one Postgres nothing more is needed: the receipt INSERT and the read are in the same database |
| **Derived read models** | Event sourcing / CQRS | The sales day and usage are derived. They are **posted and frozen**, not live views, because the ledger needs a fixed document |

## 5. Open source

**Nothing worth adopting.**
- Odoo `point_of_sale` (LGPL-3) and ERPNext POS (GPL-3) prove the closing pattern, but both are bound to their own ORM.
  The pattern is copied, not the code.
- Debezium (Apache-2) and Postgres logical replication solve change data capture *between* databases. With one Postgres
  (row 274) there is no second database to feed, so they are not adopted (§7).
- The pure planner we already have (`plan.ts`) is about 280 lines and tested. No library does recipe explosion with our
  units and location overrides.

## 6. Effort against use

**Use, in numbers.**
- 4 stores × 1 closing a day ≈ **1,460 store-days a year** that need usage. About 130 receipts a day across the chain
  (`pos-offline-and-data-tiers-proposal.md:57-59`).
- **v2 production has never produced a non-empty usage plan.** Every call sends our uuid (✎N1, `usage-pull.ts:70-71`),
  and production holds no v2 POS key yet (row 279, t375-q1). So the T-374 S7 void has had **zero real uses**. Nothing
  live depends on today's pull shape, and changing it costs no migration of live data.
- ⚠️ **A number I could not reach:** how often v1 staff revise or void a usage pull. It lives in v1's Firestore
  (`studio-7300228488-a394e`): `inventoryUsageRecords` with `usedBy = 'sold'` and `status = 'voided'`, the last 90 days.
  It would size how often the escape hatch is used. The proposal does not depend on it. At the end state, refunds and
  POS edits no longer cause re-pulls; only mapping mistakes do.

**Effort.**

| Item | Size | Migration |
|---|---|---|
| S5-lite (interim) | ~0.6 of the written S5: the capture path (U3) and the "latest of any purpose" rule go | none |
| S4, S6 | as written | 0185 (S4 only) |
| End state (P1/P2 specs) | Mandatory depletion rule on menu items (P1); usage closing over receipt lines (P2), reusing `plan.ts` and finalize | P1: 1; P2: 1–2 (take the next free index at build time, ≥ 0186) |

**What gets worse if the redesign is never done?** At P2 a store would run two derivations from two sources for one
day: receipts for sales, a pulled snapshot for usage. They would drift. And the pull button and its void would live on
as daily manual work that the closing makes unnecessary.

## 7. The design

### 7a. End state (per store, from P2)

1. **One source: receipts in Postgres.** A receipt, its lines, payments and refunds are immutable (row 272). A refund is
   a new receipt with `parent_receipt_id`, dated on the day it is rung.
2. **One closing per (store, business date).** The sales day (`source = pos_receipts`) is derived from the receipts
   (T-375 R4's table, right-hand column). **Usage is derived in the same pass** from the receipt lines × each menu
   item's depletion rule (`explodePosSales`, unchanged), and posted through the existing finalize engine, one usage
   record per location.
3. **When usage posts.** Recommended (Q-A): **automatically, right after the sales day is verified**, in its own
   transaction after the verify commits (the S6 recheck precedent: run after, so it never blocks revenue). A frozen room
   (an open count) leaves that location "usage waiting" with a finding, posted by a **Post usage again** action once the
   count closes. Revenue never waits on stock.
4. **Orphans disappear by construction.** At P1 the menu is ERP reference data. A menu item cannot be made active
   without a depletion rule (direct, recipe or no stock). So the plan's `orphan` section (`plan.ts:12`) cannot occur for
   P2 receipts.
5. **Corrections, and what replaces "void a pull":**

| What happened | What flows | Who |
|---|---|---|
| A wrong sale | Refunded on POS: a new receipt dated today. Today's closing carries it (4950; stock per Q-B) | The cashier, with a manager PIN (ADR-015 §5) |
| An offline receipt syncs after its day was verified | A late-receipt finding. Revenue: a correcting entry in an open month (T-375 S6's `postPosCorrection`, basis = receipts at verify). Usage: a **delta** usage record for the late lines, dated on the sales day if that stock month is open, else today (T-374 R12's rule) | Verifier (`verify_sales_day`) for revenue; the delta posts automatically |
| A wrong recipe or map, found later | Fixed going forward. The past gap shows in the next count as variance (AvT). **Escape hatch for a gross error:** void the day's usage and re-derive (T-374 S7, unchanged) | `void_usage_record` (Q-C) |
| A wrong location | Same escape hatch | `void_usage_record` |

   **No "void a pull" for POS changes.** At the end state POS cannot change a closed day. The only change after
   verify is an addition (a late receipt), and an addition is posted as a delta, never by undoing.

### 7b. Interim (now, until a store reaches P2)

- **S4: unchanged.** The lock is the end state.
- **S5-lite, "usage reads the day's own sold items":**
  - `buildPlan` reads the `sold_items` feed from the **day's own import batch**: the same batch as
    `sales_days.pos_v1_day_feed_id` (`import.ts:200-212`). It pins that feed on `pos_usage_pulls.pos_v1_day_feed_id`.
    No HTTP, no capture.
  - A **typed day refuses** usage (Q-D): *"{Store}'s sales for {date} were typed in before it was linked to POS, so
    there are no POS sold items to pull."* An unlinked store refuses as R9 says.
  - `finalizeSections` re-reads the pinned feed. It refuses when the day has been **re-imported** since the plan (the
    day's current import feed is not the pinned one): *"This day was re-imported from POS after the plan was built.
    Build the plan again."* `PLAN_CHANGED` stays (it guards mapping changes). `SNAPSHOT_MAX_AGE_MS` goes: a stored
    document does not go stale.
  - Deleted: `fetchPosSoldItemsLive` (`usage-pull.ts:63-85`) and the 4th fetch parameter of `buildPlan` and
    `finalizeSections`.
  - Tests kept from S5: U1 (zero fetches), U2 recast as "re-imported → refuse; same feed → posts", U4. U3 is replaced by
    "typed day refuses" and "unlinked refuses".
- **S6: unchanged in scope.** The recheck is interim-only cost, but it is the only way to see a POS v1 edit or void
  after verify until P0 removes them. `posDaySoldItemsDrift` stays. Its fix is the S7 void plus a re-pull, which
  S5-lite then reads from the newer basis.
  - ⚠️ **S6 must say what S5-lite reads after a recheck.** Recommended: after a drift, the re-pull reads the
    **newest `sold_items` feed for the day** (recheck included), not only the import's. It is one line in S5-lite's
    feed lookup: "the newest `sold_items` feed whose batch is `import` or `recheck`".
- **Known interim limitations (POS v1's, told, not fixed):** a refund rung on a later day gives that day a negative
  quantity, and finalize drops it (`usage-pull.ts:329`), so stock is not put back. A same-day refund nets
  (`sold-items-core.ts:107-108`). Package (unli) consumption is never in sold items (`:113`).

### 7c. What survives, what is thrown away

| Piece | Interim | At P2 |
|---|---|---|
| `plan.ts`, finalize engine, S7 void, capabilities | used | **kept**: the usage engine |
| `pos_usage_pulls` / lines | the pull document | kept, renamed in words only ("the day's usage"). Gains a source marker at P2 (P2 spec) |
| `pos_item_maps` | depletion rules by POS item key | migrated onto the menu item at P1 |
| Sales-day lock, derived contract, tenders, correction (S6) | used | kept. The correction's basis becomes "receipts at verify" |
| `pos_v1_day_feeds` | the source | **frozen** as archived source documents |
| `v1-feed.ts` fetcher, recheck, `pos_v1_store_links`, T-210 comparison | used | **deleted** (the link dissolves when the store records merge at P1) |
| `purpose = 'usage'` capture, live usage fetch, staleness guard | **never built / deleted now** | none |

## 8. Who may void or correct (t374-q1)

| Act | Interim | End state |
|---|---|---|
| Plan a day's usage | `record_stock_movement` (as built, `usage-pull.ts:162`) | no person: derived |
| Post (finalize) | `finalize_pos_usage_pull`: manager and up | automatic after verify. **Post usage again** after a frozen room: `finalize_pos_usage_pull` |
| Void a day's usage and redo it | `void_usage_record`: manager and up (built, T-374 R8) | same (escape hatch only) |
| Revenue correction after verify | `verify_sales_day` (T-375 R7) | same |

Recommended: **(a) as built, in both phases**: managers, admins and super admins. The void reverses only what was
recorded, and the next count measures the store, so a second pair of eyes adds little (the row 261 reasoning). Since
the end state removes the routine reasons to void, the remaining voids are rare and supervisory.

## 9. Questions for Ian (for the Open Questions page)

- **Q-A (medium; end state). When should a day's stock usage post once POS writes receipts into our database?**
  Example: Lipa's 12 March sales day is verified at 10 pm. (a) **Recommended:** usage posts by itself right after
  verify. If the meat room is being counted, that room's usage waits and posts with one click after the count.
  (b) Keep a manager's "post usage" button every day, as now.
- **Q-B (medium; end state, P2 spec). Does a refund put stock back?** Example: a table returns an unopened Coke and a
  grilled pork plate. (a) **Recommended:** no by default (the food was made). The cashier ticks "back to stock" for a
  sealed item like the Coke. (b) Every refund puts stock back (what POS v1's sold items do on the same day). (c) Never.
- **Q-C (t374-q1, both phases). Who may void a day's usage and redo it?** (a) **Recommended:** managers, admins and
  super admins, as built. (b) Admins and super admins only.
- **Q-D (low; interim). Days typed in before a store was linked to POS get no POS usage pull.** Example: Lipa linked
  on 20 Nov; its 15 Nov day was typed. (a) **Recommended:** refuse, and record such a day's usage by hand. Today's v2
  pull returns nothing for any store anyway (✎N1). (b) Fetch POS's sold items for typed days too (adds S5's capture
  path back, about 0.4 of a slice).
- **Told, not asked:**
  - T1. The interim needs no new migration. 0186 stays free.
  - T2. A recipe change is never applied to past days automatically. The count variance shows the past, and the void
    is there for a gross error.

## 10. Slice plan

| Slice | What | Migration | When |
|---|---|---|---|
| T-375 S4 | lock, platform seam, report modes, as written | **0185** (reserved) | next |
| **T-375 S5-lite** | §7b. Replaces S5 in the spec (amended in plan mode by the planner) | none | after S3, parallel with S4 as specced |
| T-375 S6 | as written, plus the one-line feed lookup in §7b | none | after S4 and S5-lite |
| P1 (ADR-015) | menu items with a mandatory depletion rule; `pos_item_maps` migrated onto them | next free at build (≥ 0186) | Q1 2027 |
| P2-a | receipts tables; `sales_days.source` gains `pos_receipts`; the derivation over receipts | next free | Q1–Q2 2027 |
| P2-b | usage closing after verify (Q-A); a source marker on the pull; late-receipt delta; refund stock rule (Q-B) | next free | with P2-a |
| P2-c | per store at the flip: stop calling `v1-feed.ts`, stop rechecks, freeze feeds, delete the fetcher after the last store | none | per store |

## 11. Not adopting, and why

- **Per-receipt stock posting (Odoo "real time").** About 1,000 stock movements and FIFO layer splits a day across the
  chain instead of a handful of usage records. An offline receipt arriving hours late makes "real time" order
  meaningless. And it contradicts the closing pattern the sales day uses (proposal §11: per-receipt ledger posting).
- **CDC, Debezium, logical replication, a message broker.** One Postgres (row 274): the receipt and its reader share a
  database and a transaction. Nothing crosses a boundary.
- **Live views for the sales day or usage.** The ledger needs a fixed, posted document. A view would change under a
  verified day.
- **v1's per-line reconciler ("revise" = void and recreate in one step).** Its goal was cheap re-pulls while POS could
  change a closed day. At the end state POS cannot. Void then redo stays two auditable steps (T-374, "Not in S7").
- **Re-deriving past usage when a recipe changes.** It would move cost in closed months, and counts already measure
  the gap.
- **S5's `usage` capture path and usage on typed days.** It is built only to be thrown away, for days that v2 has never
  been able to pull (Q-D).
- **Reading POS's Firestore directly, or ingesting v1 receipts now.** Already rejected
  (`pos-sales-usage-integration-proposal.md` §11; T-375 §"Not v1").
- **Depleting package (unli) consumption from refills.** It is not possible from POS v1 (refills carry no quantity a
  sale sees, `sold-items-core.ts:113`). It may become possible at P3, when kitchen tickets are in Postgres. Out of
  scope here; worth a CAPABILITY-GAPS row if Ian wants it.

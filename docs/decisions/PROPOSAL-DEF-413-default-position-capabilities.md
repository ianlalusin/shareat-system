# PROPOSAL — what each canonical position may do by default (DEF-413)

> ⭐ **Status: RULED. Ian, 2026-09-24: "approve all".** Every recommendation below is accepted as written:
> (1) per-position defaults for NEW orgs, replacing 0152's all-21; (2) production NOT trimmed by this task;
> (3) Cashier no void/refund/discount; (4) Cashier no credit payments/sales; (5) Inventory Staff no
> count/adjust; (6) no production posting for Slicer/Inventory Staff; (7) Cook does not sign for
> deliveries; (8) Server and Dishwasher may log wastage. Built by **T-336** (reserved), after T-335.

## The problem in one paragraph

Since T-318, what a staff member may do comes from their **position** (Cashier, Cook, ...), not from
being "staff". A brand-new organisation gets the six canonical positions (T-335) but **no access
defaults**, so a newly hired Cashier cannot close a sales day until an admin fills in
`/admin/access-defaults`. Production does not have this problem: migration `0152` filled its
defaults once, on 2026-09-14. This proposal decides what a **new** organisation's six positions get
on day one.

## What the evidence says

- **Production today (`0152`) gives all 21 everyday capabilities to every position, identically**
  (`packages/db/migrations/0152_t318_position_access_defaults_backfill.sql:189-196`). That was
  deliberate, but as a **bridge, not a design**: it had to "reproduce today's behaviour exactly and
  change nothing observable", and the plan was that **"Ian subtracts afterwards, at his own pace"**
  (`docs/tasks/318-position-decides-access.md:76-85`; bible §13 row 211, `PROJECT_BIBLE.md:1525`).
- **Ian's own words started T-318:** record sale and submit sales day on *"dishwasher role and
  server and panda role — they do not have this"* (`docs/tasks/318-position-decides-access.md:33`).
  So copying `0152` onto new organisations would copy the exact thing he asked to be able to remove.
- **v1 did distinguish positions**, both in its menu and in its server checks (full list below).
- **Server is the fail-safe position.** A hire saved with no position becomes a Server
  (`packages/db/schema/employment.ts:65-72`, ported from v1 `src/types/position.ts:58-64`: Server "is
  not referenced by any nav group or server-side gate"). Whatever Server gets, every blank hire gets.
- **What can be offered to a position at all:** 91 of the 96 capabilities. Excluded: the four
  super-admin-only ones and `close_period` (`packages/domain/src/people/position-defaults.ts:50-55`).
  This proposal only ever ticks from the 21 that staff held before T-318; the other 70 (voids,
  approvals, posting, counts, payroll, settings) stay **—** for every position.

## The proposal

✅ = on by default · — = off (an admin can still switch it on per store, or grant it to one person)

| Position | T1 | T2 | T3 | T4 | T5 | T6 | T7 | R1 | R2 | R3 | R4 | R5 | R6 | O1 | O2 | O3 | O4 | F1 | F2 | F3 | F4 | Total |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **Cashier** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | 18 |
| **Cook** | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | ✅ | — | ✅ | — | 2 |
| **Server** | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | ✅ | — | 1 |
| **Dishwasher** | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | ✅ | — | 1 |
| **Slicer** | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | ✅ | — | ✅ | ✅ | 3 |
| **Inventory Staff** | — | — | — | — | — | — | — | — | ✅ | ✅ | ✅ | — | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 11 |

### Legend — what each column lets a person do

**T — the till (money at the counter)**
- **T1** `record_sale` — ring up a sale. ⚠️ Nothing in v2 checks it yet (the POS is not built).
- **T2** `submit_sales_day` — close and submit their day's sales report.
- **T3** `record_statutory_discount` — log a Senior Citizen / PWD discount.
- **T4** `record_till_count` — count the cash drawer at open and close.
- **T5** `create_expense` — record money spent (e.g. paid from the drawer).
- **T6** `edit_own_expense` — fix or delete their *own* expense, within 48 hours.
- **T7** `record_order_wastage` — log a refunded or remade order.

**R — paperwork and receiving**
- **R1** `record_supplier_invoice` — photograph/log a supplier receipt. Moves no money.
- **R2** `receive_delivery` — receive a supplier delivery into a storage room.
- **R3** `confirm_receipt` — sign for crates arriving from the commissary.
- **R4** `record_supplier_return` — send goods back to a supplier.
- **R5** `record_customer_return` — take goods back from a wholesale customer.
- **R6** `create_wholesale_order` — enter a wholesale order. ⚠️ Nothing in v2 checks it yet.

**O — branch ↔ commissary ordering**
- **O1** `place_branch_order` — a branch orders stock from the commissary.
- **O2** `fulfil_branch_order` — the commissary accepts and packs that order (no stock moves yet).
- **O3** `post_order_message` — write in an order's message thread.
- **O4** `set_item_threshold` — set the "running low" level for an item.

**F — stock floor work** (drafts only; a manager posts)
- **F1** `record_stock_movement` — record usage, count lines, draft a production run, build the POS usage plan.
- **F2** `transfer_stock` — move stock between rooms in one store.
- **F3** `record_wastage` — log spoiled or dropped stock.
- **F4** `request_pos_map` — flag a POS item that has no stock item attached.

## Why each ✅ (v1 = `C:\Users\ianla\webapps\ERP-rebuild`, read-only)

v1's staff menu (`src/components/shell/sidebar-nav.tsx`) has a CASHIER group (`:112-123`), an
all-staff OPERATIONS group (`:125-148`), an INVENTORY group for Inventory Staff + Slicer (`:150-173`),
ordering groups for Cashier + Inventory Staff (`:174-199`) and a COOKBOOK group for Cooks (`:204-222`).

| Cell | Reason |
|---|---|
| Cashier T1 | POS gives the cashier the till (POS `src/components/layout/main-nav.tsx:17`). Ian excluded Server/Dishwasher (T-318 spec `:33`). |
| Cashier T2 | v1 refuses non-cashiers: `src/lib/actions/sales-day.actions.ts:330-331`. |
| Cashier T3 | Matrix: "the person holding that book is a cashier" (`docs/decisions/CAPABILITY-MATRIX.md:35`). |
| Cashier T4 | Matrix: "the person holding the drawer is the cashier" (`CAPABILITY-MATRIX.md:39`). |
| Cashier T5 | v1 lets only cashiers create expenses: `src/lib/actions/expense.actions.ts:169-170`. |
| Cashier T6 | v1's cashier 48-hour edit window: `src/lib/policies/policy.ts:82-88`. |
| Cashier T7 | "The person at the counter logs a refunded or remade order" (`packages/auth/src/capabilities.ts:244`). |
| Cashier R1 | v1 receipts are cashier-only: `src/lib/actions/receipt.actions.ts:252-254`. |
| Cashier, Inv. Staff R2 | v1 deliveries: `src/lib/actions/delivery.actions.ts:84-85, 378-379`. |
| Cashier, Inv. Staff R3 | v1 branch receiving uses `gateBranchActor`: `src/lib/financial/commissary/order-helpers.ts:244-245`. |
| Cashier, Inv. Staff R4 | v1: `src/lib/actions/supplier-return.actions.ts:93-94`. |
| Cashier, Inv. Staff O1 | v1: `order-helpers.ts:244-245` (branch side). |
| Cashier, Inv. Staff O2 | v1: `order-helpers.ts:265-266` (commissary side). |
| Cashier, Inv. Staff O3 | v1: `src/lib/actions/branch-order-messages.actions.ts:81-82`. |
| Cashier, Inv. Staff O4 | v1: `src/lib/actions/item-location-settings.actions.ts:33-34`. |
| Cashier, Inv. Staff F2 | v1: `src/lib/actions/stock-transfer.actions.ts:39-40`. |
| Slicer, Inv. Staff F1 | v1 production is Slicer/Inventory Staff: `src/lib/actions/production.actions.ts:131-133`. |
| Cashier, Cook F1 | v1 Usage is in the all-staff menu (`sidebar-nav.tsx:144`), accepts any staff (`src/lib/actions/meat-usage.actions.ts:81`) and handles cashiers specially (`src/app/inventory/usage/page.tsx:144`). Cooks use the stock. |
| All six F3 | v1 Wastages is in the all-staff menu (`sidebar-nav.tsx:145`); the matrix says it "must be frictionless, or it goes unrecorded" (`CAPABILITY-MATRIX.md:58`). It is a draft; a manager posts. |
| Slicer, Inv. Staff F4 | v1 POS Usage sits in their INVENTORY menu (`sidebar-nav.tsx:155, 166`); flagging is open to readers (`src/lib/actions/pos-usage-pull.actions.ts:66-75`). |

**Deliberately — for all six:** R5 and R6. v1 evidence for who does these was **not found**, so least
privilege applies; an admin grants them where needed.

## Differs from `0152` (production)

`0152` gives all 21 to every position. This proposal gives fewer: **Cashier 18** (drops R5, R6, F4),
**Inventory Staff 11**, **Slicer 3**, **Cook 2**, **Server 1**, **Dishwasher 1**. Why: `0152` was a
no-change bridge, not a per-position decision (see above), and Ian's own report says Server and
Dishwasher should not close a sales day. ⭐ **This proposal changes nothing in production.** It is
only for organisations created from now on. Production keeps its `0152` rows until Ian trims them.

## Decisions only Ian can make

1. **Give new organisations these per-position defaults, instead of copying `0152`'s
   "everyone gets all 21"?** — *Recommend YES.* Copying `0152` matches production but brings back
   the exact problem Ian reported.
2. **Also trim production's existing defaults to match?** — *Recommend NO, not in this task.* Ian
   does it from `/admin/access-defaults` at his own pace, as T-318 planned. People on shift should
   not lose access through a migration.
3. **May a Cashier void a sales day, void a Senior/PWD record, refund a customer or give a
   discount?** — *Recommend NO.* The live POS already hides discount and void from cashiers (POS
   `src/components/cashier/bill-adjustments.tsx:228-233`, `active-sessions-grid.tsx:91`).
4. **May a Cashier record payments from credit customers and credit sales (`record_ar_collection`)?**
   v1 allows it (`src/lib/actions/ar-collection.actions.ts:492-493`, `ar-credit-sale.actions.ts:211-212`),
   but production v2 does not today. — *Recommend NO for now* (it matches production); switch it
   on per store if a branch with no manager on site is blocked.
5. **May Inventory Staff open a stock count, commit its result or adjust stock?** — *Recommend NO.*
   v1 is manager-only (`src/lib/actions/count-session.actions.ts:25`, `stock-count.actions.ts:58`).
   They still count the lines (F1).
6. **May Slicer or Inventory Staff post a production run?** v1 lets them
   (`production.actions.ts:205-206`); v2 made posting manager-only (T-176). — *Recommend NO*: they
   draft, a manager posts.
7. **May a Cook sign for deliveries or commissary crates (R2, R3)?** The matrix note says "a branch
   cook signs for the crates" (`CAPABILITY-MATRIX.md:69`), but v1 only let Cashier and Inventory
   Staff do it. — *Recommend NO* by default; grant it to the one cook who needs it.
8. **May Server and Dishwasher log wastage (F3)?** — *Recommend YES.* v1 lets all staff, it is only a
   draft, and waste that is hard to log goes unrecorded. Because Server is the blank-hire default,
   this is the one thing every unassigned hire can do.

Not up for a default, for any position: pay rates, payroll, attendance, cash policy, user
management. These stay with managers and admins.

## Could NOT verify

- **Whether Ian has already trimmed production's defaults** since 2026-09-14. Agents cannot query
  production. DEF-413 also asks for a read-only count at cutover to confirm `0152`'s rows exist.
- **T1 and R6 protect nothing yet.** No v2 code checks `record_sale` or `create_wholesale_order`
  (grep: 0 callers in `packages/domain/src`, `apps/erp/src`). Those cells only matter once the POS
  and wholesale screens call them.
- **v1 wastage and usage are open to "all staff" from the menu and a staff-only check.** I did not
  find a per-position server check for recording wastage, so F3 relies on the menu (`sidebar-nav.tsx:145`).
- **Who records wholesale orders and customer returns in v1** — not found, so both are — here.
- **Whether a POS "server" will ring up sales in the new POS.** The live POS has a separate Server
  screen for taking orders (POS `main-nav.tsx:22`). Whether that counts as `record_sale` is for the
  POS design to decide.
- **Defaults are stored per position AND per store.** How a new organisation's seeding covers
  stores added later is for the implementing task. It is not settled here.

## Amendment, Ian, 2026-09-24
> *"yes default permission for new branches, yes most basic must include record usage and wastage
> thats everyone should be capable of doing"*

1. **Every newly created store gets the ruled defaults**, including new branches in an existing org
   (T-336 seeds them in `createStore`). Existing stores stay untouched.
2. **A hire gets the basic `staff` role automatically** (T-336 open item 2 → yes).
3. **The baseline for EVERY position includes F1 `record_stock_movement` and F3 log wastage.** This
   changes the table: **Server and Dishwasher gain F1** (Server 1→2, Dishwasher 1→2). ⚠️ F1 is a
   single capability: it also covers count lines and drafting a production run. Those are drafts
   only; posting and committing stay manager-only (items 5 and 6).

# T-531 — POS v2 day close: X and Z readings, the ERP sales day from POS receipts, and the December bridge to v1

> **Status:** spec written 7 Nov 2026 by the POS design lane (Opus planner). Not built. **Required for Lipa go-live
> (7 Dec)**.
> **Migration:** **0247** (to be reserved by BOSS on the board). **Risk:** HIGH. It touches money and posting, and it
> amends a DB trigger. The builder and the auditor are Sonnet, and the auditor checks money, posting and auth.
> **Depends on:** T-523 (`pos_day_closes`, `pos_day_close_tenders`, `sales_days.pos_day_close_id`), T-524/T-528
> (receipts, payments and statutory rows), T-539 (`businessDayStartHour`), T-546 (tills) and T-528a (print).
> **Bible rows:** 270 (the sales day is a derived closing, never typed), 313 (one billing tablet per store), 319 (the
> till stays in the ERP), 390 (Z to Z; selling continues; a manager approves with their PIN; cash control, not a BIR
> document), 391 (cash refunds come off the expected drawer cash), 430, 436 (the December bridge).
> **The posting is looked up, never decided:** `docs/POSTING-PATTERNS.md` § "Sale (`sale`)": `sale.unli.simple`,
> `sale.alacarte.simple`, `sale.discount.senior-pwd`, `sale.mixed`.

## Goal

At the end of a business day, the cashier taps **Close day (Z)** on the store tablet's Till tab and a manager approves
with their PIN. The server then does five things:
1. freezes that terminal's receipts since the last Z into one `pos_day_closes` row with tender totals;
2. creates the ERP **sales day** for that business date, with `source = 'pos_receipts'`, derived from the receipts
   (row 270);
3. sets the sales day to `submitted`, so an ERP verifier verifies it and the existing `verifySalesDay` posts it exactly
   as it posts v1-feed days today;
4. prints a Z-slip ("cash control, not a BIR document");
5. **until 31 Dec 2026 only**, writes that day's totals into the one v1 Firestore document v1's ERP pull reads (row
   436), so Lipa's December books in v1 stay whole.

An **X-reading** shows the same figures for the open window without closing anything.

**v1's goal (§1.2d):** know each day's sales and cash and book them once. v1 had no Z. The ERP pulled a Firestore
analytics document at 06:00 and re-derived it, so a late tablet could change a booked day.

**v2 beats it in four ways:**
- the day is closed **by a person, with approval**, at a known moment;
- the receipts behind it are **frozen to it** (`day_close_id`), so a late receipt never silently changes a closed day;
- the sales day is derived from the receipts themselves, not from a counter document;
- posting goes through the same `verifySalesDay` (a second person, idempotent).

## Out of scope

| Out | Why |
|---|---|
| Offline X-slip every 4 h | T-530 (device-side). T-531's X is online |
| Refunds, Convert and wrong-tender corrections on the Z | They don't exist in v2 yet (T-534). The Z shows zero refunds |
| The drawer reconciliation (expected vs counted cash) | Row 319: the till stays in the ERP (`till_custody_shifts`). The Z shows **cash collected**. The counted drawer and its variance stay on the ERP till screens. The Till tab links there |
| Several billing tablets per store | Row 313: one tablet bills. A second terminal's Z on the same business date is refused for the sales day (R4) |
| Writing to v1 after 31 Dec 2026 | Row 436. The writer refuses later dates |

## R1 — Migration `0247_t531_pos_receipts_sales_day.sql` (hand-authored; ADR-012 §5)

- **The figure-lock trigger (0185) refuses a sales-day INSERT for a store linked to v1** unless the source is
  `pos_v1_day_feed`. Lipa is linked, so amend the trigger function by CREATE OR REPLACE, keeping every existing branch
  and adding one:
  - an INSERT with `source = 'pos_receipts'` is allowed **only** inside the derivation flag (`app.sales_day_derivation`);
  - only when the store's `pos_stores.mode = 'live'`;
  - only when `NEW.business_date >= pos_stores.live_from`;
  - and only with `pos_day_close_id` set (the existing `sales_days_pos_day_close_link_check` already ties those two).
  - Everything else is unchanged. The `pos_v1_day_feed` path for linked stores still works for dates before
    `live_from`.
- Add the guard row 436 names: a `pos_v1_day_feed` INSERT for a store whose `pos_stores.mode = 'live'` and
  `business_date >= live_from` is refused with the sentence "This store is on the new POS from <date>; its sales days
  come from POS receipts." This makes the 06:00 v1 import (T-396) unable to double-book Lipa after the switch.
- No new table and no new grant. Re-register the trigger in `triggers/registry.ts` if its definition hash is pinned.
  Follow the journal grid.
- Header comment: why, and which branches were added.

## R2 — Domain: the reading (`packages/domain/src/pos/day-close.ts`)

`readingFor(tx, actor, {storeId, terminalId, at})` is pure apart from reads. It computes the **open window** for one
terminal:
- `windowStart`:
  - the `window_end` of that terminal's last `pos_day_closes` row;
  - if there is none, 00:00 + `businessDayStartHour` (T-539) Manila on the store's `pos_stores.live_from` date. The
    first Z starts at the start hour of the first day (row 390).
- `windowEnd = at` (server now).
- **Receipts:** that terminal's `pos_sales_receipts` with `day_close_id IS NULL`. This **includes "late" receipts**:
  ones issued before `windowStart` that synced after the last Z. They are counted in this Z and flagged `late`, so
  nothing is ever lost or double-closed.
- **Figures** (every amount in `@shareat/core/money`, centavos exact):
  - `receiptCount` and `grossTotal` (Σ receipt `total`). This is the receipt total after discounts, which is what
    `pos_day_closes.gross_total` takes; say so in a comment.
  - `subtotal` (before discounts) and `discountTotal`, split into **senior**, **pwd** and **other**:
    - senior/PWD from the receipt line discounts (`vat_removed + discount_amount`, kind senior/pwd);
    - other from presets and custom.
  - `seniorPwdDiners`: the count of statutory rows.
  - **Unli vs à la carte**, from receipt lines:
    - `unliSales` is Σ the gross of package lines (head lines, bundle and extra-heads lines, `itemType = 'package'`);
    - `alaCarteSales` is Σ every other line gross;
    - refill lines are 0.
    - **They must add up to the subtotal**, and an assert enforces it. GLOSSARY: these are stated, never residuals.
  - `byTender`: Σ per `tender_id` of the **net collected**. For cash that is the amount tendered minus the change on
    that receipt (T-524 stores change; follow its columns). Wallet amounts as tendered. Plus `toCheckCount`, the
    offline wallet payments still to be checked.
  - Assert: Σ byTender = grossTotal, exactly.
  - `heads`: Σ billed heads of package sessions. `packageSessions`: their count.
  - `lateCount`: receipts issued before `windowStart`.
  - `spansTwoDates`: true when the Manila business date of `windowStart` differs from that of `windowEnd − 1 ms`.
- `xReading(tx, actor, {storeId})` calls `readingFor` for the paired terminal and returns it. Capability `record_sale`.
  It writes nothing.

## R3 — Domain: the close (`closeDay(tx, actor, input, deps)`)

Input: `{storeId, terminalId, closeId (device uuid, idempotent), approval: {pin}}`. **Online only.** It is an API call,
not an outbox event (A4). Inside **one top-level transaction**:

1. Authorize the actor with `record_sale`. Then `verifyPosManagerApproval` (the manager's PIN; `approve_pos_correction`,
   row 390).
   - A wrong PIN must still count against the cap: charge the miss in a separate committed transaction, exactly as the
     T-525 inbox does (`recordPosApprovalMiss`), never inside this one.
   - `approved_by` = the approver.
2. **Idempotency:** if a `pos_day_closes` row with `id = closeId` exists, return it (`wrote: false`).
3. Compute `readingFor(... at = now)`. If `receiptCount = 0`, refuse with "There are no sales to close since the last
   Z." Selling continues after a Z, so there is nothing to close.
4. Insert `pos_day_closes`:
   - `z_no` = the terminal's max + 1;
   - `business_date` = the Manila business date of `windowStart` (the date the window opened; row 390);
   - window, count and `gross_total`;
   - `closed_by` and `approved_by`.
   Insert one `pos_day_close_tenders` row per tender (amount = net collected).
5. Set `day_close_id` on every receipt in the reading, through the one-time column grant. The 0238 trigger allows
   exactly NULL → value once. Write a repo helper `closeReceipts(tx, orgId, storeId, dayCloseId, receiptIds)` with
   `WHERE day_close_id IS NULL`, and assert that the updated row count equals the count read. A race refuses with
   "Another close is in progress. Try again."
6. **Derive the sales day (R4)** in the same transaction.
7. Bump `pos_stores.state_version` and write the audit `pos.day_closed` (before: null; after: z_no, window, count,
   gross, byTender, approvedBy).
8. Return `{wrote: true, dayCloseId, zNo, reading, salesDayId}`.

**After the commit, outside the transaction:** the December bridge (R5). Its failure never undoes the close.

## R4 — The ERP sales day from the Z (`deriveSalesDayFromZ`, called inside `closeDay`)

- Refuse, which rolls back the whole close, in two cases:
  - if a live sales day already exists for (store, business_date), with "A sales day for <date> already exists
    (<source>). Ask an accountant." This is how a second terminal or a v1-feed day for the same date is caught;
  - if the store's `pos_stores.mode` is not `'live'`. In `'test'` mode the Z closes, but **no sales day is created**.
    Test mode never books.
- Inside `withSalesDayDerivation`, insert `sales_days` with:
  - `source = 'pos_receipts'`, `pos_day_close_id`, `business_date`;
  - `total_sales = subtotal`, `unli_sales`, `ala_carte_sales` (with unli + ala = total);
  - `senior_discount`, `pwd_discount`, `other_discount`;
  - `comps = 0`, `refunds = 0`, `service_charge = 0`, `other_charges = 0`;
  - `cash_collected` = Σ the cash-kind tenders;
  - `online_collected` = Σ the wallet-kind tenders;
  - `credit_sales = 0`.
  Then insert `sales_day_tenders` per tender, with the money account resolved exactly as the v1-feed import resolves it.
  Reuse its helper; do not re-decide. `sales_day_channels` stays empty (no remitted channels on the POS).
  - Widen the TS `source` enum (`schema/sales-days.ts`, `repo/sales-days.ts`) to include `'pos_receipts'`. The file
    comments say "T-531 widens both".
  - Check that the derived figures satisfy both balance checks of `sale.mixed` (POSTING-PATTERNS §"Sale", the trap at
    about line 322) **before** insert. A failure refuses the close with the figures in the sentence, and nothing is
    written.
- Set the status to `submitted`, as `submitSalesDay` would, with `submitted_by` = the closing cashier. **Verification
  and posting are unchanged:** an ERP verifier (a different person) runs the existing `verifySalesDay`, which posts.
  T-531 adds no posting code.
- Audit `sales_day.derived_from_z`.

## R5 — The December bridge to v1 (row 436)

- In `apps/erp/src/lib/v1-bridge.ts` (server-only; uses `firebase-admin`, already an apps/erp dependency) and
  `packages/domain/src/pos/v1-bridge-payload.ts` (a pure builder):
  - **Writes** only when the store has a `pos_v1_store_links` row (giving `posStoreId`) **and**
    `business_date <= 2026-12-31`. Any later date is refused in code, with a test.
  - **Document:** `stores/{posStoreId}/analytics/{yyyymmdd}`, where yyyymmdd is the Z's `business_date`. It is a
    **full overwrite** (`set(..., {merge:false})`, v1's own rebuild precedent), never an increment.
  - **Fields** (what v1's `api/external/sales` reads):
    - `payments.totalGross` = `grossTotal`;
    - `payments.txCount` = `receiptCount`;
    - `payments.byMethod`: keyed by **v1 method name**, using the store's existing v1 method map (the same mapping the
      T-396 import uses in reverse; find it, do not invent one), with cash under `'cash'`;
    - `payments.discountsTotal` = `discountTotal`;
    - `payments.chargesTotal = 0` and `payments.voidCashRetainedTotal = 0`;
    - `sales.dineInSalesGross` = `unliSales`. **Required.** Without it v1 books the whole day as take-out (discovery
      §6);
    - `guests.guestCountFinalTotal` = `heads` and `guests.packageSessionsCount` = `packageSessions`.
  - **Check before writing:** Σ byMethod equals totalGross to the centavo (v1 tolerates 1 peso). A tender with no v1
    mapping refuses the write with "Tender <name> has no v1 method mapping."
  - **Several Zs on one business date** (a forgotten Z followed by a late one): the document is rebuilt from **all**
    `pos_day_closes` of that store and date, never just the latest one.
- **Durability:** the write runs after the close commits. On failure it logs at warn and records the audit
  `pos.v1_bridge_failed`. The Till tab shows "Not yet sent to v1. Tap Resend." **Resend** is
  `resendV1Bridge(tx, actor, {storeId, businessDate})`, capability `approve_pos_correction`. It rebuilds the payload from
  the DB and rewrites it (idempotent, because it is a full overwrite). A success writes `pos.v1_bridge_sent`.
- **Credentials:** `POS_FIREBASE_SA_KEY_FILE` (design §8a). Add it to `.env.example` (name only). With no key, the
  writer refuses with "The v1 bridge is not configured." and the close still succeeds.
- **Tests** inject a fake writer. No real Firestore in CI.

## R6 — Screens: the Till tab (`app/pos/till/page.tsx` and `_till/*`)

- **X-reading:** a "Reading so far" card from `xReading`:
  - receipts, gross, discounts by kind, and tenders;
  - to-check wallet count, late count, and "Spans two dates" when it applies.
  It comes with a **Print X** button. Add `formatXSlip` to `pos-print` with the header "X-READING", the line "Reading so
  far - the day is NOT closed", and the footer "Cash control, not a BIR document".
- **Close day (Z):** a button (60 px). It opens a confirm sheet showing the X figures, then the manager's **Employee ID +
  PIN** keypad (the T-526 keypad component, but the check is done **on the server** by `closeDay`), then **Close day**.
  - On success: print the Z-slip with `formatZSlip`: "Z-READING", `Z-0001`, from/to in Manila time, "Spans two dates",
    printed by and approved by, the same figures, and "Cash control, not a BIR document". Show it on screen with
    Reprint, like the T-528d receipt screen.
  - Offline: the button is disabled with "Closing the day needs the internet." (§5.4).
- **History:** today's and recent Zs, with z_no, business date, gross, tenders and the v1 bridge status, plus Reprint
  and Resend (manager).
- **Till counts:** a link "Till counts and handover" to the existing ERP till screen for this store (row 319). This
  task adds no till UI.
- Census duties as usual. Flag any action-link-sweep change for BOSS.

## R7 — API

- `GET /api/pos/x-reading` (person session, `record_sale`, effectiveStore).
- `POST /api/pos/day-close`:
  - auth: device pairing **and** a person session;
  - body `{closeId, approval:{employeeId, pin}}`;
  - responses: 200 with the result; 409 with a refusal sentence; 401 or 403.
  - The PIN is never logged or stored.
- `POST /api/pos/day-close/resend-v1`.
- All of these are online only.

## R8 — Tests (the tester writes them first; every ✅ needs its ✗)

- **Migration and DB:**
  - a pos_receipts sales day is allowed for a live store at or after `live_from`, inside the flag;
  - it is refused outside the flag, in test mode, or before `live_from`;
  - a v1-feed day at or after `live_from` is refused with the sentence;
  - a v1-feed day before `live_from` still works;
  - every existing 0185 test still passes.
- **Reading:**
  - the window from the last Z;
  - the first-ever window from `live_from` plus the start hour;
  - a late receipt is included and flagged;
  - unli + ala = subtotal;
  - Σ tenders = gross;
  - cash net of change;
  - senior, pwd and other splits;
  - spansTwoDates;
  - X writes nothing.
- **Close:**
  - happy path: a row, its tenders, every receipt's `day_close_id` set, the sales day submitted with the right figures,
    and audits written;
  - idempotent replay (same closeId) returns `wrote:false`;
  - no receipts gives the refusal;
  - a wrong manager PIN is refused **and the miss commits** (the cap trips after 5);
  - a cashier without `record_sale` is refused;
  - a manager PIN from another store is refused;
  - a sales day that already exists rolls back the whole close (no `day_close_id` set);
  - test mode closes with no sales day;
  - concurrent closes: one wins and the other is refused, with no receipt in two closes;
  - selling after a Z: the next Z's window starts at the previous end.
- **Posting:** the derived day is verified by a different person through the existing `verifySalesDay`, and posts a
  balanced `sale.mixed` entry (asserted against POSTING-PATTERNS). The same person is refused.
- **Bridge (fake writer):**
  - the exact payload for a known day, with all fields including `sales.dineInSalesGross`;
  - `merge:false`;
  - a date after 2026-12-31 is refused;
  - a tender with no mapping is refused;
  - two Zs on one date sum into one document;
  - a failure leaves the close committed and shows Resend;
  - Resend rewrites;
  - no key gives the refusal while the close succeeds.
- **Print:** exact X and Z line arrays at 32 and 48 columns.
- **Screens:** offline disables Close; the PIN never appears in any request log or audit row; Reprint works.

## R9 — Gates

Typecheck, the unit project, the integration files above, the 0185, 0188 and sales-day suites, and t524 through t528,
all on the lane's own `_test` DB with its **own `npm ci`** (no junction). **Never print any `.env.local` value.**

## Ian's rulings (7 Nov 2026; bible rows 449, 450)

### R10 — Who verifies a POS-derived sales day (row 449)

`verifySalesDay` gains one branch, and **only for `source = 'pos_receipts'`**. v1-fed and typed days keep today's
rule. For a POS-derived day, the verifier must meet **all** of these:
1. They hold `verify_sales_day` at that store (`authorize`, as today).
2. Their **role** at that store is **store manager or above**: store manager, area manager, or admin/owner, using the
   same role ranking `requirePageAccess` and access defaults use. Do not invent a new ranking. A cashier or supervisor
   who has been hand-granted `verify_sales_day` is still refused.
3. They are **not** the person who closed the Z (`pos_day_closes.closed_by` for the day's `pos_day_close_id`, or any
   Z of that date if there are several).
4. `verify_own_sales_day` does **not** exempt them on a POS-derived day.

The refusal sentence names the rule: "A sales day from the POS is verified by a store manager or above who did not
close the day." Tests cover each clause's ✗ (a cashier holding the grant, the closer, a manager from another store),
plus the ✅ for a manager who did not close the Z, and a test that a v1-fed day still follows today's rule.

### R11 — A Z that would span more than 2 business days (row 450)

- `closeDay` refuses when the open window covers **more than 2 business dates**. That is, the business date of the
  oldest unclosed receipt, measured to today's business date, takes in more than two dates. The sentence is
  "This close would cover more than 2 days. Call a manager." The Till tab shows the sentence and a **Close day by day**
  button that only a manager can use.
- **Close day by day** is `closeBacklog(tx, actor, {storeId, terminalId, closeRunId, approval:{pin}})`. It needs a
  manager's PIN (`approve_pos_correction`; a miss is counted as in R3) and the actor's role must be store manager or
  above (the same check as R10). In one transaction it closes the backlog **one business day at a time**, oldest
  first, up to and including yesterday's business date:
  - each Z's window runs from the previous end to that business day's end, which is the next day at
    `businessDayStartHour`;
  - each Z takes the unclosed receipts whose business date (from `issued_at_device` and the start hour) is that day;
  - a business day with no receipts gets no Z;
  - each Z derives its own sales day (R4), with `submitted` status;
  - `z_no` keeps counting up.
  The current business day is left open, to be closed normally.
- **Idempotency:** each Z id is uuidv5(closeRunId, businessDate), so a replay writes nothing new.
- **Audit:** `pos.day_closed_backlog`, recording the days, Z numbers and totals, and who approved it. Each Z also writes
  its own `pos.day_closed`.
- **The December bridge (R5)** runs after the commit for every closed date up to 31 Dec, in date order.
- **Tests:**
  - a 4-day backlog gives 3 Zs (one per past day with sales), 3 sales days, and today left open;
  - a day with no sales is skipped;
  - a non-manager is refused;
  - a wrong PIN is counted;
  - a replay writes nothing;
  - `closeDay` refuses at 3 days with the exact sentence;
  - a 2-day window still closes normally (row 390's forgotten-Z case).

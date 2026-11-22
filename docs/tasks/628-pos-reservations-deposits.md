# T-628: table reservations with deposits on POS v2

**Owner:** builder (Sonnet), laptop. Auditor: Sonnet (money + ledger). **Spec:** BOSS (Opus), 22 Nov 2026.
**Ian, 22 Nov 2026:** build reservations with deposits before go-live ("b"); scope = **table reservations** (Christmas
set orders stay on v1 this year); on cancel / no-show the **manager decides each time** (refund or keep). Bible row 463
(Ian 13 Nov): voiding a deposit needs the manager PIN and is refused once applied. **MIGRATION 0276** (after T-627's 0275;
renumber at merge if T-627 is not in first). Needs new posting patterns.

## v1, read as requirements

GOAL: hold a table for a customer and take money in advance, then credit it to their final bill.
v1 (`POS/src/lib/types.ts:470-530`, `ReservationPaymentModal.tsx`, `payment-modal-logic.ts:60-111`,
`pos-commands/checkout.ts:320-424`): reservation doc (name, phone, party size, time, optional table, status), any staff
records deposit payments with a tender, the Pay screen pre-fills them as "From reservation", the server consumes once.
29 reservations ever, 4 with a deposit.
**Not copied:** deposits invisible on the day they are taken (drawer vs books gap), void without PIN or after apply
(DEF-844), cancel/no-show leaving the money undecided, no ledger entry.

## Rule (v2)

- **Data:** `pos_reservations` (org, store, customer name, phone, party size, reserved for (timestamp), optional stand,
  note, status booked / seated / cancelled / no_show / closed, created by) and append-only `pos_reservation_deposits`
  events (kind taken / voided / applied / refunded / kept, amount, tender, reference no. for wallets, actor, receipt id when
  applied, reason). The balance is derived from the events, never stored.
- **POS:** a "Reservations" tab on `/pos` (any signed-in POS person): today and upcoming list, New reservation, Take deposit
  (tender + amount + reference for wallets), Seat (links to a stand; opens the table as usual). Creating a reservation and
  taking a deposit work offline (events through the inbox, like a sale); the deposit counts in the drawer of the day taken.
- **Pay:** a seated table linked to a reservation shows the held deposit; the cashier applies it as a payment line
  "Deposit"; applying is consume-once (unique per reservation in the checkout transaction). Offline, only a deposit already
  synced to the tablet can be applied; a second use arriving later is quarantined (existing quarantine flow).
- **Manager-only, online, manager PIN** (rows 351/356/463): void a deposit (refused once applied), refund, keep. Closing a
  cancelled or no-show reservation with money held **forces** the choice refund or keep, with a reason.
- **ERP view:** a read-only list of reservations and held deposits per store (who, when, amount, status) for the office;
  editing stays on the POS.
- **Ledger (new patterns in `docs/POSTING-PATTERNS.md`, tests for each):** a new store-level liability account
  "Customer deposits payable" (pick the next free 21xx code; it is a chart change, so update the chart pins honestly).
  Taken: DR cash / money account, CR deposits payable. Applied: DR deposits payable, as a tender of the sale. Refunded:
  DR deposits payable, CR cash / money account. Kept: DR deposits payable, CR other income (4500). Posted through the
  existing POS day-close / sales-day path where the day's other tenders post, not a separate journal flow, unless that
  path cannot carry it (then stop and ask BOSS).
- **X / Z:** lines for deposits taken, applied, refunded and kept, so the drawer count matches the day the cash moved.
- **Receipt:** a deposit receipt slip when taken (name, amount, reservation time); the final receipt shows "Less deposit".

## Tests (each with a mutant that goes red)

1. Take deposit offline → syncs → counted on that day's Z and posted DR cash / CR deposits payable.
2. Apply at payment consume-once; a second apply is refused/quarantined (mutant: drop the unique → red).
3. Void after apply refused; void needs manager PIN and is online only (mutant: allow cashier → red).
4. Cancel with money held cannot close without refund-or-keep; keep posts to 4500 (mutant: close silently → red).
5. Posting patterns: each new pattern balanced and on the right accounts (existing posting-pattern test harness).
- Migration 0276 hand-authored (ADR-012 §5), classification + RLS registry, full CI suite. `npm run census:write`;
  typecheck apps/erp and package tests via a temp tsconfig.

## As built (T-628)

**Migration 0276** (journal `when` = 0275's + 86400000): `pos_reservations` (purge, guard trigger), `pos_reservation_deposits` (purge, append-only except `day_close_id` once; two guard triggers),
`pos_sales_receipts.deposit_applied`, `sales_days.deposits_applied` (only on a `pos_receipts` day; the figure-lock function is re-created with it), account **2170 Customer deposits payable** (seed + one INSERT per org).
Registries: classification (both purge), RLS (both `org_column`), trigger registry (+3 ALWAYS: 73 -> 76), audit catalogue (+7 actions: 297 -> 304), chart pins (104 accounts, 97 leaves).
Rules in the DATABASE: reservation statuses move forward only; CLOSING needs a zero held balance (refund or keep first); a deposit is taken only on a booked or seated reservation; nothing leaves more than is held;
a VOID is refused once any deposit was applied and must name the taken deposit (same amount and method); an apply needs a seated reservation; applied once per reservation and once per receipt (partial uniques).
**Events (inbox, offline):** `reservation.created`, `deposit.taken`, `reservation.seated`, `reservation.status_set` (cancelled / no_show); `sale.completed` gains an optional `deposit { reservationId, amount }`.
**Online only (no outbox kind), manager PIN or a signed-in `approve_pos_correction` holder (the refund pattern `postSaleApprover`), a reason, `record_sale` through `authorize()` first:** void, refund, keep, and close a reservation
(`POST /api/pos/deposits`, action void | refund | keep | close; close with money held carries the refund-or-keep choice for the whole balance).
**Apply:** `completeSale` takes the deposit as a part-payment (never more than held or than the bill, one per reservation), writes the `applied` event in the sale's transaction and closes the reservation when nothing is left held. A
deposit larger than the bill leaves the rest held; the reservation stays seated for a manager. A payment line may be absent when the deposit covers the bill. A refund of a receipt that used a deposit is capped by what was paid by method (the deposit part is not refundable by method).
**Books (no new journal flow):** the cash-moving events of a till (taken / voided / refunded / kept) are collected into its Z (`day_close_id`) and post beside the sales day, `postDepositsForZ` (source_type `pos_deposit`, one entry per kind per money place,
key `pos_deposit:<closeId>:<kind>:<place>`); `applied` rides the sales day: `routeSalesDay` takes `depositsApplied` on the collected side and posts `Dr 2170`. Four patterns in POSTING-PATTERNS: `deposit.taken`, `deposit.refunded` (void too),
`deposit.kept`, `sale.pos-deposit-applied`. Reading identities: Σ byTender + deposits applied + short payments + refunds = gross. A Z may be closed with only deposit events (no sales day).
**X / Z / receipt:** DEPOSITS TAKEN / REFUNDED / KEPT / APPLIED rows (each only above zero; refunded includes voided), LESS DEPOSIT above the tenders on the final receipt, a deposit slip (`formatDepositSlip`) printed when a deposit is taken.
**Screens:** POS Reservations tab (`/pos/reservations`: list from the snapshot with the outbox on top, New reservation, Take deposit, Seat, Cancel / No-show, manager Settle), Pay screen "Use deposit", ERP read-only `/pos-reservations` (capability `approve_pos_correction`).
**Known limits (shortcuts, recorded):** a deposit event taken offline and synced AFTER its day's Z lands in the next Z (the cash was in the drawer the earlier day; a late receipt behaves the same); a `deposit.taken` still in the outbox can show twice for a moment after a snapshot refresh (display only);
a table voided while its reservation holds money leaves the reservation seated for the manager to cancel and settle; the v1 bridge document (December) carries the Z's tenders only, and (BOSS ruling, as v1 prepaidLines) the bridge keeps the FULL gross and counts a used deposit as a payment under its ORIGINAL method (byMethod) on the bill day.
**Open question for Ian / the accountant:** the 1 January opening balance must count any deposit still held (account 2170) by hand, and the reservation entered again (both tables purge at cutover).

**Audit fixes:** apply refuses a reservation that is not seated (plain sentence); the held balance is read after the locks; 2170 is in "what we owe"; the X/Z print DEPOSITS CASH IN / CASH OUT (cash part only); the sales-day page shows Deposits applied; replay compares the reservation id.

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

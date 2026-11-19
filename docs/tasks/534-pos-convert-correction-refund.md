# T-534: POS v2 money follow-ups (Convert, wrong payment method, refund)

**Owner:** builder (Sonnet), one slice at a time. **Spec:** BOSS (Opus), 19 Nov 2026.

**Ian's rulings, 19 Nov 2026:**
- **(1A)** Convert is built **before go-live**.
- **(2A)** A refund goes back **the way it was paid** (cash for cash, GCash for GCash). It can cover **some items only**, and it needs a **manager PIN and the internet**.
- Row 351's "cash-only" limit is superseded. It existed only because of the v1 day feed, and v2 owns the data.

**Source:**
- Bible rows 272, 351, 356, 359, 391, 402.
- ADR-015 A4.2 (`docs/decisions/ADR-015-pos-and-customer-on-the-shared-backend.md:192-208`).
- `docs/plans/pos-v2-design.md:76-77, 122, 212, 235, 241, 330`.
- The old Firebase-era specs, as **requirements only**: `docs/tasks/424-pos-v2-server-approvals.md`, `docs/tasks/427-pos-v2-convert-cash-in-out.md`.
- v1 Convert: `POS/src/components/dashboard/PaymentConvertModal.tsx`, `POS/src/lib/server/analytics/applyPaymentConversionServer.ts`.

**Live use (91 days):**
- Convert: 333, of which Lipa 308 (25 voided).
- Refunds: 7 ever, all at Lipa, all partial.
- Edited paid receipts: 13, of which Lipa 8. These are the wrong-payment-method cases.

**Migration 0265** (reserve it on the board). It is hand-authored per ADR-012 §5. Classify every new table in `packages/db/src/cutover/classification.ts` and `packages/db/src/rls/registry.ts`. The gate is the FULL suite on a fresh gate DB.

## The three documents (none of them edits a receipt)

A receipt is frozen (migrations 0238 and 0240: no update, no late child rows). So each action is a **new document**. Each one:
- is dated when it happens;
- is collected into the next Z (end-of-day close) through a `day_close_id` that is set once;
- is idempotent on a `request_id` that is unique per org.

All three are **online only**. Each runs through a route beside `/api/pos/day-close`, not an outbox event (A4). The tablet shows "This needs the internet" when offline (wording in `_shell/offline-band.ts:9-11`).

### Convert: `pos_payment_conversions` (GCash cash-in/cash-out)

v1 meaning (row 359): a customer gives cash and the store sends GCash, or the other way round. **It is not a sale.**

- **Columns:**
  - `id`, `org_id`, `store_id`, `terminal_id`;
  - `from_tender_id` (the money that leaves), `to_tender_id` (the money that comes in), with from ≠ to;
  - `amount > 0`, `note`;
  - `recorded_by`, `recorded_at`, `request_id`;
  - `voided_by`, `voided_at`, `void_reason`, all-or-none;
  - `day_close_id`.
- **Guard trigger:** only `day_close_id` (once) and the void triple (once, and only while `day_close_id is null`) may change. Delete is refused.
- **Who:** `record_sale` at the store, with **no PIN** (T-427 ruling, as v1).
  - Void: the person who recorded it, or anyone holding `approve_pos_correction`, before the Z.
- **The wallet going below zero:** v2 does not track a live GCash balance, so there's nothing to refuse. Out of scope (T-427's "flag" needs a balance v2 does not have).

### Wrong payment method: `pos_tender_corrections`

A4.2: the receipt never changes. A correction entry, approved with a manager PIN, fixes the payment method **before the Z**. After the Z it's a refund plus a new sale (row 272).

- **Columns:**
  - `id`, `org_id`, `store_id`, `receipt_id`, `payment_id` (the paid row being moved);
  - `to_tender_id` (≠ the payment's tender), `amount` (> 0, at most the payment's amount − change given − amounts already corrected off it);
  - `reference_no` (required when the new method is a wallet, as at payment);
  - `reason`, `approved_by`, `recorded_by`, `recorded_at`, `request_id`, `day_close_id`.
- **Refuse when:**
  - the receipt already has a `day_close_id` ("Already in a closed day. Refund it and ring it again.");
  - the receipt is from another store.
- **Approval:** `verifyPosManagerApproval` (`packages/auth/src/pos-approval.ts:44`), the same as `voidUnpaidSession` (`sale.ts:63-78`). A signed-in holder of `approve_pos_correction` skips the PIN. Since 19 Nov (ruling D2, T-601), every store manager holds it by default.
- **Lock:** take a row lock on the receipt to serialise corrections.

### Refund: `pos_refunds` + `pos_refund_lines` + `pos_refund_payments`

This keeps row 272's purpose: the original is never edited, the refund is dated the day it happens, and it links to its parent.
- It uses its own tables, not a negative receipt: `pos_sales_receipts.total >= 0`, and its append guard should stay strict.
- **`pos_refunds`:**
  - `id`, `org_id`, `store_id`, `terminal_id`, `parent_receipt_id`;
  - `refund_no` (`<store code>-R-<seq6>`, per store; the sequence follows the receipt numbering pattern but is separate);
  - `total > 0`, `reason`, `approved_by`, `recorded_by`, `recorded_at`, `request_id`, `day_close_id`.
- **`pos_refund_lines`:** `refund_id`, `receipt_line_id`, `qty > 0`, `amount > 0`.
- **`pos_refund_payments`:** `refund_id`, `payment_id` (the original paid row), `tender_id` (= that payment's tender), `amount > 0`, `reference_no` (for a wallet, the reference of the money sent back).
- **Append guard:** as 0240. Lines and payments are inserted only in the transaction that wrote the refund. All three tables are frozen after that, except `day_close_id` once.
- **The amount for a line:** the line's share of what the customer actually paid, after line discounts and the bill-level discounts (SC/PWD, presets) spread across lines.
  - Find how `completeSale` stores the line nets and bill discounts. If bill discounts are not stored per line, spread them over lines in proportion to each line's amount before discounts, in bigint centavos, with the largest-remainder rounding the codebase already uses (grep `largestRemainder` or the receipt allocation in `sale.ts`; reuse, don't write a new one).
  - The refund amount for `q` of a line's `Q` = `round(lineNet × q / Q)`. The final refund that takes a line's quantity to `Q` gets the exact remainder.
  - DEF-590 (the old design refunded without discounts) must not repeat; a test pins it.
- **Caps** (taken under a row lock on the parent receipt):
  - Σ refunded qty for a line ≤ sold qty.
  - Σ refunded per original payment ≤ its amount − change given.
  - Σ of the refund's payments = the refund total = Σ of its lines.
- **Refund method (2A):** the screen offers the receipt's own paid rows, filled in by default in payment order (cash first). The manager may change the split within the caps.
- **Where and who:**
  - Only at the receipt's own store (row 402: cash comes from the refunding store's drawer).
  - Allowed before or after the parent's Z. A refund after the Z lands in the current open day.
  - Manager PIN, as for corrections. Internet required (row 356).
- **Slip:** add `formatRefundSlip` beside `formatReceipt` (`apps/erp/src/lib/pos-print/`), printed through the adapter, one copy. It shows "REFUND", the refund no, the original receipt no, the lines, the money back by method, and the approver's name.

## The end-of-day close, the cash count and the books

`readingFor` / `figuresOf` (`packages/domain/src/pos/day-close.ts:145-185`) and `deriveSalesDayFromZ` (:485-549) today sum receipt payments only, with `refunds: ZERO` at :527.

- **Per payment method, for the Z:**
  - sales = receipt payments − change given;
  - **minus** refund payments by method;
  - **± corrections**: the amount moves from the old method to the new one;
  - Convert stays in its **own block** and is not mixed into sales.
- **Expected drawer cash** (row 391) = start + cash sales − cash refunds + Convert net (cash in − cash out) + adjustments − deductions.
  - Corrections are already inside "cash sales" once applied.
  - The X, Z and handover lines show "Convert: cash in ₱x / cash out ₱y" and "Refunds: ₱z".
  - The X and Z slip formatters (`reading-text.ts`) gain these lines.
- **The sales day the Z creates** (`deriveSalesDayFromZ`):
  - sales by method = after corrections;
  - `refunds` = Σ refunds (the sales-day field that already exists);
  - Convert does **not** change sales.
- **Posting: look it up, do not decide** (`docs/POSTING-PATTERNS.md`):
  - **Refunds:** the existing sales-day posting must already handle a non-zero `refunds` figure. Find the pattern that posts it, and the money account each refund method reduces (the tender's `money_account_id`). If no pattern posts sales-day refunds, **stop and report to BOSS** before inventing one.
  - **Convert:** a money move between the drawer's cash account and the wallet's account at the same store. One entry per Z for each pair of methods, net of voids. Use the same-store internal transfer pattern (grep `transfer.` in POSTING-PATTERNS). If none fits, stop and report.
  - Migration 0247 locks the sales day's figures to what the Z derived. Extend the derivation it checks against, not the lock.
- The day-close tables (`pos_day_close_tenders`) gain only what the derivation needs. Prefer computing over storing new columns, unless the Z must freeze the figure. It must: closed figures never change. So add `refunds`, `convert_in` and `convert_out` per method row, written once.

## Slices (one builder at a time; each slice merges before the next starts)

| Slice | What | Needed for |
|---|---|---|
| **S1** | Migration 0265: the five tables, their guards and checks, classification and RLS registry rows, repo functions in `packages/db/src/repo/pos-v2.ts`. No behaviour yet. | Go-live |
| **S2** | **Convert**: domain `recordConversion` / `voidConversion` / `listOpenConversions`; routes `/api/pos/conversions` (POST, void); a Till screen "Convert (GCash cash-in / cash-out)" dialog with From, To, amount, note, plus today's list with Void; X/Z/handover lines and the posting. | **Go-live** |
| **S3** | **Wrong payment method**: domain + route + a "Wrong payment method" button on `/pos/receipts` rows not yet in a Z (manager PIN dialog: reuse the void PIN dialog component); Z effect. | Go-live |
| **S4** | **Refund**: domain + route + a "Refund" button on `/pos/receipts` rows (pick items and quantities, the method split, a reason, then the manager PIN); refund slip; Z, cash count and sales-day effect. | Go-live |

## Tests (integration on any `_test` DB; unit where pure; each with a mutant that goes red)

- **S1:**
  - each guard refuses an update or delete;
  - refund lines inserted in a later transaction are refused (the 0240 `xmin` pattern);
  - the checks (from ≠ to, amount > 0) hold;
  - classification and RLS guards pass.
- **S2:**
  - cash→GCash ₱500 and GCash→cash ₱200, then the Z: Convert block in 200 / out 500, expected cash +300 − 0 (state the direction explicitly in the test name), sales unchanged;
  - a voided conversion is excluded;
  - void after the Z is refused;
  - the same `request_id` twice gives one row;
  - posting: one transfer entry per method pair, net; the ledger balances.
  - **Mutant:** count voided rows → red.
- **S3:**
  - moving ₱300 of a ₱1,000 cash payment to GCash changes the Z (cash 700, GCash 300) while the receipt is unchanged;
  - over the available amount is refused;
  - after the Z it's refused with the sentence above;
  - without the right and with a wrong PIN it's refused, and the miss counts toward the cap;
  - a wallet without a reference is refused.
- **S4:**
  - a partial refund of 1 of 3 on a bill with a 20% SC discount refunds the discounted share (pins DEF-590);
  - a second refund over the quantity is refused;
  - a refund over a payment's amount is refused;
  - two-method refund caps work;
  - a refund after the Z lands in the next Z;
  - expected cash drops by the cash refund;
  - the sales day's `refunds` equals the Z;
  - another store's receipt is refused;
  - offline is not possible (route only);
  - the last refund of a line takes the exact remainder.
  - **Mutant:** spread the discount over nothing → the DEF-590 test goes red.
- **Pins:** `domain-actions-have-callers`, the t343 throw ratchet, t371 numeric write guard, touch-target census, the trigger registry (`packages/db/src/triggers/registry.ts`).

## Out (with reasons)

- **Offline Convert, corrections or refunds:** row 356 and A4 say online only.
- **Tracking a live GCash balance or warning on a negative one:** v2 has no wallet balance; this would be a new feature.
- **Preset discounts, Online tab, stock-usage drafts:** T-535, after the freeze.
- **Refunding a v1 receipt:** v1 receipts stay in v1 (row 452).
- **Editing a closed Z:** closed days are fixed. A post-Z mistake is a refund plus a new sale (row 272).
- **Store-to-store refunds:** row 402.

## Done when

S1 to S4 are merged in order, each with green CI and its tests. The Lipa run in TEST mode shows a Convert, a correction and a partial refund on the X and Z, with the right expected cash. The sales day the Z creates posts and balances.

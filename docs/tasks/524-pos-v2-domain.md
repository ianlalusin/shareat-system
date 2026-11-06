# T-524 — POS v2 domain: stands, orders, kitchen, refills, per-line discounts, pay with server recompute

**Status:** SPEC (Opus planner, POS design lane, 6 Nov 2026). **Owner:** orchestrator (BOSS).
**Migration:** one small one, **0240** (reserved by BOSS 6 Nov; `when` = 0239 + 1 day): the receipt-children append guard (R11).
**Lanes:** Sonnet tester → Sonnet builder (money lane) → Sonnet auditor (money + auth: always Sonnet). Branch from main
after T-523 (#169) merges; until then from `lane/t523-r`.
**Depends on:** T-523 (schema, migration 0238) · `business_rule_values` (T-511 S5c, migration 0239) for the two statutory
rates (R7). If S5c has not merged when T-524 starts, R7's reader is built against its spec and the integration tests
seed the table directly. Say so in the report.
**Authority:** `docs/plans/pos-v2-design.md` §5, §5.4, §9 · bible rows 270, 272, 276, 313, 351, 356, 371, 390, 430, 431,
435, 436, 437, 438, 439, 440 · ADR-015 §5 and Amendment 2 · `docs/tasks/523-pos-v2-schema.md` (R1–R13).

## Why

T-523 made the tables; nothing writes them. This slice is the **only** place POS business rules live
(`packages/domain/src/pos`). The APIs (T-525) and the screens (T-526 onward) call these functions and add nothing. The
same functions serve an online tap and a replayed offline event, so every rule is enforced once, on the server
(§5.4 rule 1: the device records, the server decides).

## v1 goal (§1.2d) and what v2 beats

**Goal:** seat a party on a free stand, take package and à la carte orders, route them to kitchen stations, pace refills,
discount the right units, take any mix of tenders with correct change, and never lose or double a sale.

| v1 method (discovery 39; the 6 Nov reads) | v2 rule here |
|---|---|
| The sale engine runs in the browser; the server trusts its totals | The server recomputes every figure from the lines; a mismatch is recorded with the server's figure and flagged (R9) |
| Tender keyed by name, change from "a name containing cash" | `tender_id` and `tenders.kind = 'cash'` (R9) |
| Line discounts unbounded; SC/PWD whole-bill and stacked on promos | Per-line, oldest first, never past billable qty; no other discount on a senior unit (R6) |
| 1-centavo tolerance between client and server | Exact centavos; no tolerance (R9) |
| Several allocators for receipt numbers | The device's per-terminal `receipt_seq`, `UNIQUE (terminal_id, receipt_seq)` (R9) |

## Shape of every function (house conventions, cited)

- `fn(tx: Tx, actor: Actor, input)`; `authorize(tx, actor, cap, { storeId })` is the **first** statement; for a call
  keyed by a row id, read the row first and authorize at **its** store (`packages/domain/src/kitchen/index.ts`
  `renameKitchenStation`).
- Refusals: `refuse(raw, sentence)` / `gone(raw, what)` from `packages/domain/src/shared/refusal.ts`; plain sentences
  (row 236). Field rules via `assertFieldRules` with a new `packages/domain/src/field-rules/pos.ts`.
- Money: `@shareat/core/money` only (`money`, `add`, `subtract`, `multiply`, `allocate`, `toCentavos`), half-up once at
  the end; never a float.
- **Context, not actor:** `Actor` is `{ personId, orgId }` only. `storeId` and `pairingId` are explicit inputs, derived
  server-side by T-525 from the signed-in tablet session; T-524 still checks them (R1).
- **Idempotent by device id.** Every create takes the device-made uuid (sessions, lines, discounts, sales receipts). The
  same id again with the same content returns `{ wrote: false }`; with different content it is refused ("This change was
  already recorded differently on the till."). This is what makes an offline replay safe even before T-525's
  `UNIQUE (pairing_id, seq)` check.
- **Polling counter:** every function that changes anything a screen shows bumps `pos_stores.state_version` once, in the
  same transaction (T-523 R1). Tested.
- Audit: `auditLogRepo.append(..., source: 'pos', deviceId: pairingId, occurredAt: <device time>)` with new catalogue
  actions (R12).

## Rulings

- **R1 — The store must be switched on, and the tablet must belong to it.** Every write first loads `pos_stores` for
  `storeId`: `mode = 'off'` refuses ("The new POS is not switched on for this store yet.", row 435); `test` and `live`
  proceed. `pairingId` must be a live pairing of the same store (`pos_tablet_pairings`); a phone browser write
  (kitchen, refill, heads) passes `pairingId: null` and is allowed only for the functions marked *phone ok*.
  A helper `currentBusinessDate(tx, storeId)` returns the business date of the open Z window: the Manila date on which
  the window started (the last Z's `window_end`, or 04:00 Manila of the store's first POS day; rows 348, 390). T-531
  reuses it.
- **R2 — Capabilities.** Reuse `record_sale` (store; position-granted to Cashier, T-318) for seating, ordering,
  discounts and payment. Add three store-scoped capabilities, each through all six places in
  `packages/auth/src/capabilities.ts`, with rows in `docs/decisions/CAPABILITY-MATRIX.md` and the count bumps in
  `apps/erp/tests/access-defaults-lib.test.ts`:
  - `request_pos_refill`: super_admin/admin/manager ✅, staff by position (Server, Cashier, Kitchen Staff);
  - `serve_pos_ticket`: super_admin/admin/manager ✅, staff by position (Kitchen Staff, Server);
  - `confirm_pos_heads`: super_admin/admin/manager ✅, staff by position (Server).
  Position defaults follow row 211 (backfill first, then flip). Every ✅ gets a test that the matching ✗ is refused.
  Voiding uses the existing `approve_pos_correction` (R8).
- **R3 — `openStand(tx, actor, { storeId, pairingId, sessionId, mode, standId?, headsCashier, openedAtDevice, lines? })`**
  (`record_sale`). Dine-in needs an **active** stand of the store with no open session (the partial unique index is the
  backstop; a 23505 becomes "Stand 7 is already in use."). Take-out has no stand. `lines?` lets the first order carry a
  package and à la carte together (row 358), applied through R4 in the same transaction.
- **R4 — `addLines(tx, actor, { storeId, pairingId?, sessionId, lines[] })`** (`record_sale`; *phone ok*). Each line names
  `lineId`, `menuItemId`, `variantId?`, `qty`, `note?`, `addedAtDevice`. **Price, name, kind and kitchen station come
  from the server's menu** (`loadStoreMenu` + `projectStoreMenu` at the line's device time, `packages/domain/src/menu`),
  never from the device. Refused: an item not orderable on the store channel at that time (`notOffered`, incl.
  `outside_hours`), an item with no station (`notOnPos`), a session that is not open (the T-523 trigger is the
  backstop), and a package for a take-out session. Package pricing: `bundleHeads = 1` → one `package` line, `qty` = heads,
  `unit_price` = `amount`. `bundleHeads > 1` → one `package` line `qty 1 × amount` named "(up to N)" plus, when heads >
  N, a second `package` line `qty = heads − N × extraHeadAmount`. Option price deltas are added into `unit_price`.
- **R5 — Heads, refills, kitchen.**
  - `confirmHeads(…, { sessionId, headsServer })` (`confirm_pos_heads`; *phone ok*). `setHeadsCashier(…)`
    (`record_sale`). Both only while open. **The package line follows:** when the billed heads
    (`greatest(heads_cashier, coalesce(heads_server, 0))`) change, the package line(s) are re-made: the old line is
    cancelled (it may already be `served`; then the change is refused while it is served, "The package was already
    served; change the heads on a new line."; *ruled:* a served package line is not re-made, the difference goes on a
    new package line) and a new line is added at the new qty. Discounts on the cancelled line are removed with it.
  - `requestRefill(…, { sessionId, lines[] })` (`request_pos_refill`; *phone ok*): each item must be in the session's
    package variant `refillItemIds`; `kind = 'refill'`, `unit_price = 0`. The refill cooldown (DEF-021) is **not** in
    release 1 (CUSTOMER-side today; noted).
  - `serveLine(…, { lineId, servedAtDevice })` (`serve_pos_ticket`; *phone ok*): queued → served; allowed on a paid
    session (late serve, T-523 ruling 4).
  - `cancelLine(…, { lineId, reason })` (`record_sale`): queued only, open session only, reason 3–200 characters, kept in
    the audit row.
- **R6 — Per-line discounts (rows 439, 440).** `addLineDiscount(…, { discountId, lineId, kind, presetId?, valueType?,
  value?, qty, dinerNo?, appliedAtDevice })` and `removeLineDiscount(…, { discountId })` (`record_sale`; any cashier, no
  PIN, row 440). Rules:
  - `qty` ≥ 1, and the line's active discounts never cover more than its billable qty (qty minus nothing in release 1;
    there is no free qty yet); oldest first.
  - **A unit covered by senior/PWD carries no other discount** (row 439): adding a senior/PWD where the units are
    already discounted, or a preset where they are senior-covered, is refused with how many units are free.
  - `preset` takes value and type from the active preset of the store at that moment; `custom` takes them from the input
    (percent 0–100, fixed ≤ unit price).
  - `senior`/`pwd` need `dinerNo`, and the session's package line must have a free unit for that diner's head
    (the senior's own head, row 437); a dish counts only if covered explicitly by its line discount (dishes ordered only
    for them).
  - **"Apply to all lines"** (row 440) is `applyPresetToAllLines(…, { presetId })`: one discount per line, covering
    every unit not already covered; lines with no free unit are skipped and counted in the result.
- **R7 — The arithmetic (one function, `priceSession(snapshot)`, pure, unit-tested, used by R9 and by T-528's screen via
  T-525).** For each line: `gross = qty × unit_price`. For each discount, in creation order, on `cov` covered units:
  - preset/custom percent: `cov × unit_price × value/100`; fixed: `cov × min(value, unit_price)`.
  - senior/pwd on a **VAT-registered org** (`organizations.tax_type = 'vat'`): covered gross `G = cov × unit_price`
    (for a bundle line, `G = amount ÷ bundleHeads` per covered head, allocated exactly with `allocate`);
    `vat_removed = G − G ÷ (1 + vat_rate)`; `discount_amount = (G − vat_removed) × sc_pwd_rate`. On a **non-VAT org**:
    `vat_removed = 0`, `discount_amount = G × sc_pwd_rate`.
  - Round each amount half-up once to the centavo; `discount_total = Σ(vat_removed + discount_amount)` per line;
    `net = gross − discount_total`; receipt `subtotal = Σ gross`, `discount_total = Σ line discount_total`,
    `total = subtotal − discount_total`.
  - **Rates are never typed into code** (Ian, 5 Nov): `vat_rate` (0.12) and `sc_pwd_discount_rate` (0.20) are read from
    `business_rule_values` (S5c) by key, org-scoped, effective on the session's business date. A missing rate refuses
    the payment ("The senior/PWD rate is not set up. Ask an admin."), never a silent default.
- **R8 — `voidUnpaidSession(…, { sessionId, reason, voidedAtDevice, offline, approval? })`** (row 356). Open session only.
  The approver is the actor if the actor holds `approve_pos_correction` at the store, otherwise `approval` must be a
  manager PIN verified by `verifyPosManagerApproval` (online only; offline the tablet already refused, row 356). Sets
  `voided`, `voided_offline`, cancels queued lines, removes active discounts, frees the stand. Reason 3–200 characters.
- **R9 — `completeSale(tx, actor, input)`** (`record_sale`). Input: `{ storeId, pairingId, sessionId, receiptId,
  terminalNo, receiptSeq, issuedAtDevice, offline, device: { subtotal, discountTotal, total, lines: [{lineId, gross,
  discountTotal, net}] }, payments: [{ tenderId, amount, referenceNo?, toCheck }], seniors: [{ dinerNo, kind, idNumber,
  holderName }] }`. One transaction, in this order:
  1. Lock the session (`FOR UPDATE`); it must be open and have ≥ 1 line; the terminal must be this store's
     `terminal_no` and its pairing must be `pairingId`.
  2. Recompute with R7 from the **database** lines and discounts. Write the sales receipt with the **server's**
     figures and `device_total` as sent. If any device figure differs, write the audit row `pos.sale_recompute_mismatch`
     (severity high; before = device, after = server). The sale is never refused for a mismatch (row 276).
  3. Payments (row 438): 1–20 rows; each `tender_id` an **active tender of this store**; amounts > 0; a
     reference is required where the tender needs one, and always for `toCheck`; `toCheck` only when `offline` and the
     tender kind is `wallet` (A3); card-type and QR tenders refused when `offline`. **Change comes only from cash:**
     `paid = Σ amount`; `paid ≥ total` exactly; `change = paid − total` must be ≤ the cash tendered, and is written as
     `change_given` on the cash row (one cash row carries it). Over-payment with no cash is refused ("Change can only be
     given in cash.").
  4. **Senior/PWD (rows 437, 439):** one `statutory_discount_records` row per `dinerNo` with a senior/pwd discount, via
     the existing repo with `source = 'pos'`, `business_date = currentBusinessDate`, `invoice_number` = the printed sales
     receipt number (`<store code>-<terminal 2 digits>-<seq 6 digits>`), `gross_amount` = that diner's covered gross,
     `discount_amount` = their `vat_removed + discount_amount`. A diner with discounts but no `seniors` entry, or an entry
     with no discounts, refuses the sale. `holderName` and `idNumber` are written **only** there (row 353), never to the
     audit row or a log.
  5. Freeze: receipt lines (one per non-cancelled session line, `line_no` in creation order), receipt line discounts
     (label = "Senior" / "PWD" / the preset's name / "Discount"), payments; session → `paid`.
  6. A repeated `completeSale` with the same `receiptId` and identical input returns the existing receipt; a different
     `receiptId` for an already-paid session is refused; a `receiptSeq` already used on the terminal is refused
     ("That receipt number is already used on this till.").
- **R10 — Reads for the screens** (no capability beyond store read scope; *phone ok*): `listOpenStands`,
  `getSessionBill` (lines, discounts, and `priceSession` output), `listKitchenQueue(stationId?)`, `listRefillQueue`,
  `listTodaysSalesReceipts`. Each returns `stateVersion` so T-525 can answer 304.
- **R11 — Carried from T-523: refuse appends after a sales receipt is done.** Migration (number from BOSS) adds a
  `BEFORE INSERT` trigger on `pos_sales_receipt_lines`, `pos_sales_receipt_payments` and
  `pos_sales_receipt_line_discounts` that refuses (23001) a child whose parent receipt row was **not** inserted in the
  current transaction (`parent.xmin = pg_current_xact_id()::xid` is the test), `history_guard`, `mode: 'always'`,
  registered. Test: inserting a payment for yesterday's receipt in a new transaction is refused; R9's single transaction
  still works.
- **R12 — Audit catalogue** (`packages/db/src/audit/catalogue.ts`, `def(..., 'pos', ..., 'T-524')`): `pos.stand_opened`,
  `pos.lines_added`, `pos.line_cancelled`, `pos.heads_changed`, `pos.refill_requested`, `pos.line_served`,
  `pos.discount_added`, `pos.discount_removed`, `pos.session_voided` (high), `pos.sale_completed`,
  `pos.sale_recompute_mismatch` (high). No personal data in any `before`/`after`.

## Not in this slice

Refunds, wrong-tender correction, Convert (T-534) · preset editing screen (T-535) · day close / Z and the December bridge
(T-531; it reuses `currentBusinessDate`) · the event inbox and quarantine (T-525) · offline storage (T-530) · free qty
("Mark as free", v1) · refill cooldown · loyalty (row 432) · **widening `SalesDayRow`'s TypeScript `source` type to
`'pos_receipts'` is T-531's** (the DB already allows it).

## Files

- `packages/domain/src/pos/*.ts` (new: `index.ts`, `price.ts` for R7, one file per area as the builder prefers) and its
  export in `packages/domain/src/index.ts`
- `packages/domain/src/field-rules/pos.ts` (new)
- `packages/auth/src/capabilities.ts` · `docs/decisions/CAPABILITY-MATRIX.md` · `apps/erp/tests/access-defaults-lib.test.ts`
  (counts) · the position-default backfill per row 211 (where the builder finds T-318's pattern; name it in the report)
- `packages/db/src/repo/pos-v2.ts` (write helpers now allowed) · `packages/db/src/audit/catalogue.ts`
- `packages/db/migrations/0240_t524_receipt_append_guard.sql` + journal · `packages/db/src/triggers/registry.ts`
- Tests: `packages/domain/src/pos/price.test.ts` (unit, R7) · `packages/domain/tests/integration/t524-*.test.ts` · guard
  census files only where a count must move

## Tests (written first)

1. R7 unit table, at least: per-head package with one senior (VAT org) → the PC-7 mock figures (₱449 head: VAT off
   48.11, 20% 80.18); non-VAT org senior; two seniors on one table; a preset 10% on 1 of 2 units; fixed discount above
   unit price capped; a bundle "(up to 6)" with one senior; rounding half-up once; totals add exactly.
2. Store `off` refuses every write; `test` allows; a pairing of another store refuses.
3. Stand already in use → the plain sentence; take-out without stand; dine-in needs heads ≥ 1.
4. A device-sent price is ignored (server menu wins); an `outside_hours` item and a `notOnPos` item are refused.
5. Heads change re-makes the package line; a served package line is not re-made (new line instead).
6. Refill of an item not in the package refused; refill price is 0.
7. Discounts: over-coverage refused; senior on a promo-covered unit refused and vice versa; apply-to-all skips full lines.
8. Void: by a holder of `approve_pos_correction`; by a cashier with a valid manager PIN; refused without either.
9. completeSale: mismatch recorded with server figures + audit row; change only from cash; over-pay with wallet only
   refused; `toCheck` only offline; card refused offline; 21 payments refused; statutory rows one per diner with
   `source='pos'` and the printed number; missing senior identity refused; replay with same `receiptId` returns the same
   receipt; reused `receiptSeq` refused; the session ends `paid`.
10. R11 append guard; `state_version` bumped once per write; every new ✅ capability has its ✗ test; no holder name or ID
    number appears in any audit row (search the rows).

**Done when:** the tests pass on the builder's own `_test` DB; typecheck and unit pass; the full integration suite runs
in CI on the PR; the auditor's findings are closed. Report the real output.

## Open (for BOSS, not blocking)

1. **`business_rule_values` must exist** (S5c, 0239) with keys `vat_rate` and `sc_pwd_discount_rate` seeded for Lipa's
   org before 7 Dec; if S5c slips, T-524's payment of a senior is blocked, everything else works.
2. **There is no VAT engine in v2** (bible row 75, `organizations.tax_type` is "descriptive only"). R7 removes VAT only
   inside the senior/PWD share, because the statute requires it on the receipt; it posts nothing and computes no output
   VAT (row 279). If Ian wants the VATable / VAT / VAT-exempt block on the receipt (the mock shows it), T-528 derives it
   from these same figures for display only.

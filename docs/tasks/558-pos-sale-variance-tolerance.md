# T-558 — POS sale variance tolerance: record a short-paid sale, flag the gap, never quarantine

> **Status:** spec written 11 Nov 2026 by the POS design lane (Opus planner). Not built. **Required before go-live.**
> **Migration:** **0248**, seed only. Its journal `when` is 0247's plus 1 day. **It merges AFTER T-531 (0247).**
> **Risk:** high (money and posting). The builder and the auditor are Sonnet.
> **Authority:** bible row 453 (Ian, 11 Nov; audit item P-002). Also rows 276 (a mismatch never refuses a sale), 438
> and 270. The posting is **looked up** in `docs/POSTING-PATTERNS.md`, never invented.
> **Depends on:** T-524 (`completeSale`), T-525 (the inbox), T-528 (the device payment rules), T-531 (day close and
> the derived sales day), and T-539 (the rules reader and the registry pattern).

## The defect

T-524 R9(2) says a recompute mismatch never refuses the sale. R9(3) says `paid ≥ total` exactly.

An offline sale paid ₱99.99, which the server re-prices at ₱100.00, fails R9(3). The inbox then quarantines it as the
event's fault (T-525). The customer has paid and left, but the sale is not in the books until a manager replays it,
and the replay refuses again.

## Goal

Every completed sale is recorded with the money actually taken.
- A gap where the payments come up **short** of the server's total is recorded as a **variance**.
- Up to the tolerance it is a routine reconciliation item.
- Above the tolerance it is a **finding** that a manager must look at.
- A short payment never makes a sale fail, refuse or quarantine.
- Overpayment keeps today's rule: change comes only from cash.

## R1 — The business rule (T-539 pattern)

- **Registry key** `pos.sale_variance_tolerance`:
  - label: "Largest short payment on a POS sale that counts as normal (₱)";
  - help: "A sale can be paid a few centavos short of the server's total when the tablet priced it offline. Up to this
    amount the gap is recorded as a normal variance. A bigger gap is still recorded, and is flagged for a manager.";
  - unit `money`, default `0.01`, min `0`, max `0.10`. **The registry max is the hard ceiling** (row 453).
  - namespace `pos`.
- **Migration `0248_t558_pos_sale_variance_tolerance.sql`:** data only, following the 0241/0245 seed pattern. It
  inserts 0.01 per org. Its journal entry is idx 248, with `when` = 0247's + 86400000.
- `readPosRules` returns `saleVarianceToleranceCentavos: bigint`. The T-525 snapshot `rules` also carries it, as a
  display hint for the tablet; the tablet never enforces it.
- **Tests:**
  - the registry entry;
  - the seed pin, covering every key;
  - the writer refuses `0.11` with the bounds sentence;
  - a dated change is read on its date.

## R2 — `completeSale` (T-524 R9(3) is replaced)

After the server recompute (R9(2)), let `paid = Σ payments`, `total = server total`, and `gap = total − paid`.

- **`gap ≤ 0`, paid in full or more:** unchanged. Change comes only from cash and is checked as today.
- **`0 < gap ≤ tolerance`:**
  - record the sale as normal, with `change = 0`;
  - write the audit row `pos.sale_payment_variance` with severity `low`, holding the gap, the device total, the server
    total and the payments.
- **`gap > tolerance`:**
  - record the sale exactly the same way;
  - write the audit row `pos.sale_payment_shortfall` with severity `high`. That is the finding. It lists the gap and
    the tolerance in force.
  - **Never refuse.**
- Read the tolerance with `readPosRules` on the sale's business date.
- Find every database CHECK or trigger that assumes payments ≥ total, for example on `pos_sales_receipts` or the
  payments table (T-523). If one exists, relax it **in 0248** with the narrowest change that allows a short payment,
  and say exactly which. If nothing assumes it, 0248 stays seed-only.
- The T-525 inbox needs no change: a short payment is no longer a refusal, so it is no longer quarantined.
- Register both audit actions in the catalogue.
- **Tests:**
  - 99.99 paid against a 100.00 server total is recorded, with a low-severity variance audit and no quarantine;
  - a 0.50 gap with tolerance 0.01 is recorded, with a high-severity finding;
  - an overpayment by a non-cash tender is still refused (the change-from-cash rule is unchanged);
  - a gap of exactly the tolerance counts as a variance, and one centavo above it is a finding;
  - an inbox replay of the P-002 case is applied, not quarantined.

## R3 — Day close and sales day (amends T-531)

- **T-531 R2 asserts Σ byTender = grossTotal exactly. Replace it** with:
  - Σ byTender + Σ variance = grossTotal, where `variance` = Σ the receipts' gaps (> 0 only);
  - `varianceTotal` and `shortfallCount` added to the reading.
- **The Z-slip and the X-slip** print "Short payments" with the amount, plus the count of findings when there are any.
  Add the line to `formatXSlip` and `formatZSlip`, with exact arrays at 32 and 48 columns.
- **The derived sales day:**
  - The revenue side is unchanged: the receipts are sold at the server's prices.
  - The tender side is short by `varianceTotal`.
  - **Look up the posting** for a cash shortage or an over/short difference in `docs/POSTING-PATTERNS.md`, and use
    that account and pattern.
  - If no pattern covers a POS short payment, **stop and report to the planner**. Do not invent an account. Both
    `sale.mixed` balance checks must pass.
- **The December bridge (R5):** `payments.totalGross` stays the gross. `byMethod` then sums to gross − variance, which
  is inside v1's ₱1 tolerance for small gaps. A day whose `varianceTotal` is over ₱1 refuses the bridge write with
  "Short payments of ₱X exceed v1's ₱1 check; send this day by hand." Test it.
- **Tests:**
  - a Z over receipts with a 0.01 variance gives a balanced sales day that posts, with the variance line from the
    looked-up pattern;
  - the Z-slip shows "Short payments";
  - the bridge refuses a day whose variance is over ₱1.

## R4 — The tablet (T-528)

- The device keeps its own rule: Pay needs paid ≥ the **device** total. A server-side variance only happens when the
  device and the server price differently, for example after an offline price change.
- Show nothing new to the cashier. The variance is a back-office item.

## R5 — Gates

Typecheck, unit, the integration files above, plus t524, t525, t528, t531 and t539. Run on the lane's own `_test` DB
with its **own `npm ci`**. **Never print any `.env.local` value.** The CHECK and posting changes are gated on the
FULL integration suite on a fresh gate DB, per the standing rule for CHECK and trigger migrations.

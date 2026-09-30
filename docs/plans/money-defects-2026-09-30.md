# Open money defects in v2 — census 2026-09-30

Ian, 2026-09-30: "close all open money defects in v2"; scope anchored on the What's Left board's list.
Census: Opus, read-only, verified at source and in git. Section E: 453 rows, 168 not marked fixed.
**34 open money defects.** ⚠️ `verified` in the State column means *defect confirmed*, not fixed (register legend).

## Batches → tasks (grouped by shared files so lanes never collide)
| Task | Batch | Defects | Notes |
|---|---|---|---|
| T-364 | authorise-first | 496, 497 | specced first |
| T-365 | supplier bank audit | 498 | edits `ap/index.ts` → before T-367 |
| T-366 | A · remittance & floats | 386(+105), 374, 398, 399, 406 | `remittance/`, `repo/findings.ts` |
| T-367 | B · AP/AR | 201, 396, 420, 499, 500, 395, 508 | after T-365; 201 needs a unique backstop (migration) |
| T-368 | C · periods & depreciation | 424, 426, 433, 434, 435, 441, 442, 436 | 434 shares `findings.ts` with 406 → after T-366; 436 DB guard (migration) |
| T-369 | D · unwired money screens | 198, 314, 479, 291 | app layer |
| T-370 | E · owner cap & dates | 108, 494 | |
| T-371 | F · NaN sweep | 382 | last — touches every module |

## Ranked (money risk), with evidence
- 386 (+105) remittance variance posts nothing; the person's receivable never exists — `remittance/index.ts:453`
- 201 double-clicked write-off → second subledger row — `ar/index.ts:555`, no unique index
- 406 float driven negative reads as settled — `repo/findings.ts:753`
- 374 two concurrent handovers both pass the cap — `remittance/index.ts:94`, no lock
- 396 voided supplier bill still settleable — `repo/ap.ts:608`
- 420 `Number(total) <= 0` lets NaN through — `ap/index.ts:397`
- 382 NaN passes ~36 domain comparisons; DB 0155 is the only backstop
- 395 `overdraftLimit` reaches the DB unparsed — `money-accounts/actions.ts:71`
- 434 a FAILED depreciation run clears the not-booked finding — `repo/findings.ts:201-210`
- 424/426/433 period close with an earlier month missing; partial period never closes; seed opens months unchecked — `fiscal-periods/index.ts:62`
- 435/441 reversed depreciation can't be re-booked; reversal confirm acts on a recomputed plan
- 442 asset creatable at a deactivated store — `capitalize.ts`
- 436 asset-term change would rewrite posted months (latent; no writer yet)
- 108 payroll recovery never frees an owner's drawing cap — `repo/owners.ts:234`
- 499/500 due date not derived from terms — `ap/index.ts:421`; Drizzle lacks 0–365 CHECK — `schema/suppliers.ts:144`
- 498 supplier bank edits unaudited — `ap/index.ts:262`
- 496/497 validation before `authorize()` — `expenses/actions.ts:198`; `adjustments.ts:111` vs `:113`
- 198 `payReimbursement`, `readFileUrl` have no app caller
- 314 ratified closed-period override has no UI caller
- 479 unverified sales-day draft can't be edited or voided
- 291 money-account picker unscoped — `expenses/lib.ts:187`
- 398/399 allocator compares via `Number()`; two allocators sort opposite ways — `remittance/allocate.ts:64`
- 494 core parser accepts 2026-02-30

## Needs Ian (not started until ruled)
127 outbound freight never reaches dispatch/receipt · 054 ETL quarantines `other`/`ar_collection` payment methods ·
302 closed-period override inventory ruling · 409 refuse a bad pay cycle at save time? · 491 same-org FKs (before a 2nd org).

## Deferred (L): 421 (~153 null-tx branches), 491.

## Not money / closed / ops (seed rows)
Closed: 389. Partial: 417, 257, 288. Tooling: 387, 388, 094. Security code+ops: 356. Ops-only: 340, 336, 373.
Decided-unbuilt: 260. Privacy: 476. v1 requirements v2 already beats: 051, 059, 062; partly: 060, 061.

## State column wrong (open in register, fixed in code/git) — fix rows at wrap-up
038, 068, 082, 099, 190, 200, 207, 210, 256, 284, 358, 393, 397, 418, 419; 409 partly.

## Ian's rulings, 2026-09-30 (record as bible §13 rows at wrap-up)
- **T-364 Q1 → (a)**: one uniform refusal sentence for an employment the caller cannot see.
- **DEF-491 → ok**: same-org FKs deferred until before a second organisation.
- **Commissary order lifecycle (given against DEF-127)**: once an order is *prepared* it can never return to
  unprepared; it waits until *dispatched* or *cancelled*. A branch cannot have a new order processed while one of its
  orders is still open (not dispatched). ⚠️ This is a new lifecycle rule, not an answer to DEF-127's freight
  question — freight re-asked. Verify v2 enforces both halves (commissary/orders.ts, fulfilment.ts, auto-order.ts);
  gap → new DEF + task.
- Pending explanations sent to Ian: DEF-054 (recommendation), DEF-302 (the inventory question), DEF-409 (example),
  T-368 Q0 (fiscal-period cleanup approval) and Q1 (asset term corrections).
- T-366 migration slot: T-366 takes 0172; T-368 takes the next index at build.
- **DEF-127 → (a)** (Ian, 2026-09-30): outbound freight on an internal commissary order posts as a haulage expense on
  the RECEIVING branch at confirmReceipt. → T-367-adjacent; new slice in the commissary lane (spec with T-372).
- **DEF-302 → (a)**: closed months' stock stays fixed; the admin override does NOT cover stock movements. Fix = the
  three flows (confirmReceipt, runProductionPosting, recordInternalReturn) refuse with a plain closed-period message
  instead of a stock error. → T-368 or T-369.
- **DEF-409 → refuse on save**: semi-monthly needs exactly two pay days ≤16 days apart. → T-370.
- **T-368 Q1 → (b)**: an in-service asset's terms can be corrected by reversing booked months and re-booking at the
  new terms (follow-up slice; (a) lock ships first). T-368 Q0 (cleanup approval) still unanswered.
- DEF-054: Ian asked for more detail — research running.
- **Open-order block (Ian, 2026-09-30):** like v1 — a branch stays blocked until its order is RECEIVED or CANCELLED;
  dispatch does not free it. v2 already enforces this (0070 unique partial index on draft/confirmed/dispatched;
  `openOrderFor`). No change; T-372 adds a guard test only.
- **T-368 Q0 → yes** (Ian, 2026-09-30): fiscal-period cleanup approved — no month closes while an earlier month is
  missing. T-368 unblocked (runs after T-366; next free migration index).
- **DEF-054 → yes**: retire `ar_collection` as an expense method (fee = a deduction line on the customer receipt; ETL
  skips v1's auto fee-expense docs — the collection carries the fee); split `other` into "supplier credit / rebate"
  (reduces AP) and "voucher / points / gift certificate" (a balance-tracked asset); v1 `other` rows land in suspense,
  flagged. Count from landed data before building. → T-367 slice.
- **T-366 Q1 → no write-off**: a remittance shortage is ALWAYS charged to staff. `write_off` is retired (refused
  permanently, removed from the UI); existing `written_off` rows are reported, not silently re-posted.
- **T-366 Q3 → manager confirms** an overage before it becomes income. **Q2 → (a)**: negative 2120/2130 = finding only; 2160 alone blocks close.
- **T-372 Q1 → (a)** (Ian, 2026-09-30): the commissary credits its own 6630 for internal freight. **Q2 → yes**: freight
  posts even when nothing arrives. Ian added: v1 records how much was received and flags the discrepancy — copy it
  and harden it (T-372 S6 if v2 lacks or is weaker).
- **T-372 Q3 → (i)** (Ian, 2026-09-30): over-receipt books only what was sent; the excess is an "over" discrepancy blocking day-open (top-up dispatch or return).
- **T-370 Q1 → ok** (Ian, 2026-09-30): payroll recoveries clear an owner's oldest debt first; a voided pay run takes the freed cap back.

## Ian's answers on the Open Questions page (read at wrap-up, 2026-09-30) — bible row 260
- **T-367**: Q1 rebate → reduces the payable · Q2 voucher account → only if the count shows more than a handful ·
  Q3 v1 `other` rows → an EXISTING suspense account (⚠️ which one not named — re-asked on the page) · Q4 → refuse voiding
  a paid bill until the payment is voided · Q5 → an identical second write-off by the same person is the same write-off ·
  Q6 bad prod data → show Ian each one before anything changes · Q7 → add write-off and bill-void to POSTING-PATTERNS.
  Q0 (prod count) → "run it on session terminal": the orchestrator runs the read-only count itself.
- **T-369**: Q1 (a) voiding frees the date, **but only a manager can re-enter it, never staff** · Q2 (a) · Q3 (a) · Q4 (a).
- **T-371**: empty money box → "field decides" (required→refuse; defaulted→keep; optional→empty, never zero).
- **Other**: DEF-443 → thread read-only on a cancelled order · DEF-476 → fix before launch · T-315 → (2) one-time
  admin-reviewed list · T-316 → cashiers count BEFORE handing over · service charge → on after T-366 · dark colours → keep ·
  dev migrations 0169–0171 → apply to the shared dev DB · supplier terms after deploy → the tester does it.
- **Ops handed to the orchestrator by Ian**: fiscal-period timer on prod ("do it with orchestrator"); prod ACL check for
  0169 ("run it with session"); T-367 Q0 count; Firebase terminal account exists — Ian asks where to put the credentials.
- **Still open**: DEF-539 charge scope · T-370 monthly floor · HR statutory data owner · T-367 Q3 which suspense account.

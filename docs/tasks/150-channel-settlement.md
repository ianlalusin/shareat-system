# T-150 — Channel settlement: clearing the platform receivable Foodpanda and Grab raise

> **Status:** Spec written 2026-08-28 by the Opus planner (session `ianla-72`); **built the same
> day by a peer session — commit `f9d1efb`.** Both open decisions in §4 and §5 were taken on this
> spec's own recommendations: `6420` is seeded, and `1220` keeps a job separate from `1221`/`1222`.
> The unticked boxes below are not stale by neglect — they are unticked because *this* session did
> not verify them; the implementing session's report is the record.
> **Depends on:** T-123 (`sales_channels`, `sales_day_channels` — the receivable this clears),
> T-131 (AR, and the `6400` fee leg it already books once), T-126 (loans), T-139 (money transfers /
> destination accounts).
> **Blocks:** Phase 2's exit gate — *"subledgers tie to control accounts"* cannot pass while
> `1220` only ever grows.
> **Assessed before specced**, per bible row 163. The assessment is in this session's
> research-evaluate-propose pass and is summarised under **The assessment** below; it cut the task
> roughly in half by finding that most of the machinery is already shipped and idle.

## Why this exists at all

T-131 built AR and explicitly carved this out, closing with *"channel settlement raised with Ian as
an unowned task."* Ian owned it on 2026-08-28. It is the **largest unowned money path in the
system**: three-quarters of what v1 calls a collection is one of these, and until it exists the
receivable that T-123 already raises on every verified Foodpanda or Grab day has nothing that ever
clears it.

## Grounding — v1, measured (read as requirements, bible §1.2b)

| | |
|---|---|
| ⭐ v1 "AR collections" that are really platform settlements | **381 of 512 (74%)** |
| Platform fees v1 double-counted before the fix | **₱198,148.29**, two stores, **37** duplicate expense docs voided |
| Stores wired for settlement | 4, most with **both** platforms |
| Channels docking a loan out of the payout | 2, one of them **cross-store** (Grab loan owned by Lipa, docked from Malvar's payout) |
| `channel-settlement.actions.ts` | 735 lines, plus batch, parsers, and a discrepancy→infraction control |

⚠️ **Two numbers I could not reach and did not invent.** Monthly gross platform sales per store,
and the total `wht` withheld across settlements. Both live in v1 Firestore (`channelSettlements`,
`salesDays.salesChannelBreakdown`) and are reachable with
`npm run capture -- --collection channelSettlements --fetch`, which needs local Postgres up and SA
credentials. Neither changes the design; both would size the WHT question below.

### What v1 gets right, and is ported

- **A per-platform clearing account that nets to zero.** *Clearing IN = outstanding + gain
  (= gross); OUT = fees + variance + loan + net.* This is the standard marketplace pattern and v1
  arrived at it correctly. `1221`/`1222` are already seeded here for exactly this.
- ⭐ **Fee components are SIGNED.** Both parsers derive `platformFee` as a residual, so an
  incentive-heavy or promo-heavy day yields a **negative** fee — a real credit back to the
  merchant. v1 once filtered to `amount > 0` and *"silently dropped it, overstating feesTotal and
  understating netToBank by exactly the credit, with no tripwire because net is a plug."*
  **Any implementation that clamps a deduction at zero has reintroduced that bug.**
- **A tolerance with two different refusals, not one.** `threshold = max(₱50, 10% of gross)`.
  A shortfall beyond it **blocks** — reconcile first. An excess beyond it blocks *unless* an
  explicit `recognizeGain` is passed, so a data-entry error cannot silently become income.
- **A gain is recognised rather than back-edited into the sales day.** The sales day is immutable
  once verified; the excess the platform actually paid posts to `7100` instead.
- **A settlement that paid down a loan cannot be voided directly** — the loan payment unwinds
  through its own module first, so the reversal stays one comprehensible transaction.
- **`taxTreatment: 'expense' | 'creditable'` as per-channel config.** v1 built the switch and
  never flipped it. Keep the switch; see §7.

### What v1 gets wrong, and is corrected

| v1 | Here |
|---|---|
| An **untyped `feeBreakdown` map** (`commission`/`marketing`/`platformFee`/`vat`/`wht`/`penalty`) parallel to the typed fields | Typed columns with a DB-enforced identity (§2) |
| Deductions land in one *Other Operating Expense* parent separated only by `subCategory` | Real accounts, so the P&L answers "what did channels cost" as a query (§3) |
| The receivable is a **slot-mangled document id** — `ch_{channelId}_{date}`, then `__r1`, `__r2` when a voided day is re-recorded | A row with a foreign key. The slot dance exists only because Firestore had no other way to be idempotent |
| Idempotency by "does any live slot exist" | A unique constraint plus `postEntry`'s idempotency key |
| Variance direction documented only in a comment | A CHECK constraint and a named column |

## The assessment — what this task deliberately is NOT

**Most of this is already built and idle**, which is why the task is one document and not a module:

| Piece | Where | State |
|---|---|---|
| Channel config, remittable flag, receivable routing | `schema/sales-days.ts` | shipped, CHECK-enforced |
| `1220` Channel receivable (control, `requiresParty`) | COA seed:135 | seeded |
| `1221`/`1222` clearing — Grab / Foodpanda | COA seed:136-139 | seeded, legacy-mapped |
| `6400` fees · `6650` marketing · `6800` taxes · `7100` settlement gain | COA seed | seeded |
| The three-leg fee pattern and its double-count trap | `POSTING-PATTERNS.md:393-420` | verified, 176 legs |
| Loans, incl. cross-store via `1250`/`2150` | T-126 | shipped |
| **The settlement document** | — | **this task** |

## Contract

### 1. `channel_settlements` — one platform payout, against one channel-day

A settlement clears the receivable raised by **one** verified sales day on **one** channel. (Batch
files covering many days are out of scope — see §Out of scope; each day still settles as its own
row, which is what keeps the identity below checkable.)

Required: `orgId`, `storeId`, `channelId`, `businessDate`, `salesDayId`, `grossAmount`,
`outstandingCleared`, the deduction columns of §2, `loanDeduction`, `netDeposited`,
`destinationMoneyAccountId`, `reference` (the platform's payout reference), `settledOn`,
`createdBy`, `postedBy`, `journalEntryId`.

Statuses: `draft → posted → voided`, matching AP and AR. **Only `posted` has ledger effect.**

### 2. The deduction columns, and the identity that binds them

Typed columns, not rows — deliberately the opposite of `sales_day_channels`. That table uses rows
because channels are open-ended per-store configuration; **deduction kinds are a closed set of
six**, and a seventh needs an *account decision* before it needs a column. Making a new kind a
migration rather than a data row is the point: the decision cannot be smuggled in as data.

`commission`, `marketing`, `platformFee`, `vatOnFees`, `withholdingTax`, `penalty` —
**all `numeric(14,2)`, all NULLABLE-free (default 0), and none of them constrained non-negative.**
A negative is a real credit and must survive.

⭐ **The identity, as a CHECK constraint** — one row, so the database can hold it:

```
outstandingCleared + settlementGain
  = commission + marketing + platformFee + vatOnFees + withholdingTax + penalty
  + variance + loanDeduction + netDeposited
```

Plus: `netDeposited >= 0` (fees exceeding the payout is a refusal, not a negative deposit), and
`variance >= 0 AND settlementGain >= 0` with `variance = 0 OR settlementGain = 0` — they are
opposite directions of the same difference and cannot both be non-zero.

### 3. The deduction map — every fee to a real account

⭐ **This table is the deliverable Ian asked for.** Add a deduction kind and this is the row you
must fill in.

| Deduction | Account | Why this one |
|---|---|---|
| `commission` | **`6400`** Platform and channel fees | The core transaction fee. The account exists for this |
| `platformFee` | **`6400`** | The parsers' residual. **Signed** — negative on a promo-heavy day |
| `marketing` | **`6650`** Marketing and advertising | It *is* ad spend. Burying it in `6400` hides channel marketing from total marketing spend, which is a question Ian asks |
| `vatOnFees` | **`6400`**, with the fee it belongs to | Bible §13 row 75: no VAT engine, no input-VAT account. Commission books **gross of VAT**, which is the true economic cost when the input is not claimed |
| `withholdingTax` | **`6800`** Taxes and licences | See §7 — a decision, taken |
| `penalty` | **`6410`** Online order expenses | Separable from commission on purpose, so a penalty trend is visible rather than averaged into the fee rate |
| `variance` (shortfall) | **`6420`** — ⚠️ **NEW, needs Ian** | See §5 |
| `settlementGain` (excess) | **`7100`** Platform settlement gain | Already seeded, already named for this |
| `loanDeduction` | **`2400`** Loans payable, or `1250`/`2150` cross-store | T-126. See §6 |
| `netDeposited` | the channel's `destinationMoneyAccountId` | Per-channel config, not a constant |

### 4. Posting — four steps, and `1220` versus `1221`/`1222`

⭐ **The one structural decision, recommended and awaiting Ian:**

- **`1220` Channel receivable, `party = channel`, is the receivable.** It carries a party, so it
  ages per channel for free and satisfies invariant 6's subledger↔control reconciliation.
  *"Foodpanda owes us ₱X, and it is 12 days old."*
- **`1221`/`1222` are the settlement-batch clearing accounts, and are ZERO AT REST.** A non-zero
  balance means a settlement is mid-flight or broken. *"Something did not finish."*

Two different alarms about two different problems. Collapsing them into one account loses one.

The posting, for a ₱100,000 Foodpanda day with ₱20,000 commission, ₱500 withheld, ₱79,500 banked:

| Account | Debit | Credit | Party |
|---|---:|---:|---|
| `1120` Bank — office (per channel config) | 79,500.00 | | money_account |
| `6400` Platform and channel fees | 20,000.00 | | — |
| `6800` Taxes and licences | 500.00 | | — |
| `1220` Channel receivable | | 100,000.00 | channel |

⛔ **The trap, restated because it cost ₱198,148.29 once:** these fees are booked **here, once**.
A module that posts this settlement *and* lets someone raise a separate expense document for the
same platform fee has rebuilt the confirmed v1 defect. `POSTING-PATTERNS.md:411`.

### 5. Variance and gain

`variance = outstandingCleared − grossAmount`, and it is a **statement about the sales day**, not
about the platform:

- **`variance > 0`** — staff **over-reported** the day. The shortfall is swept to expense so the
  receivable clears exactly. Above `max(₱50, 10% of gross)` the posting is **refused**: reconcile.
- **`variance < 0`** — staff **under-reported**. The excess posts to `7100` as income rather than
  editing an immutable verified sales day. Above the same tolerance it is refused **unless**
  `recognizeGain` is passed explicitly, so a typo cannot quietly become revenue.

⚠️ **`6420` is a new account and T-102 gates the chart on Ian.** The alternative is folding
below-tolerance variance into `6400`, which works but makes a channel that *systematically*
under-remits by ₱40 a day invisible — it reads as a slightly worse fee rate. The settlement row
carries `variance` as its own column either way, so the report can show it regardless; the
question is only whether the P&L can.

### 6. Loan deduction, including the cross-store case

The platform docks a loan repayment out of the payout. Same-store: `2400` Loans payable, against
the loan T-126 already models. **Cross-store** (Grab loan owned by Lipa, docked from Malvar's
payout): the paying store books `1250` Due from related store, the owning store `2150` Due to
related store — and **invariant 6's reciprocal elimination already checks that pair nets to zero**,
which is exactly the safety net this case needs.

**Void refuses while a loan payment stands**, ported from v1: unwind the loan first.

### 7. Withholding tax — decided, 2026-08-28

**`6800` Taxes and licences. It is an expense, not an asset.**

[RR 2-98 §2.58.3(B)](https://www.forvismazars.com/ph/en/insights/tax-alerts/withholding-taxes-in-the-philippines-transactions):
a creditable withholding tax may be claimed *only* when the income payment has been declared as
part of gross income and the 2307 is attached. Bible §13 row 75 records that reported sales are not
all sales and that this ledger is never a filing basis. **So the credit cannot be realised, and an
asset is a resource from which future benefit is expected — there is none. Booking it as an expense
is the correct treatment, not a compromise.** Indicative arithmetic, per ₱100,000 of gross: the
1% on one-half of gross recovers ₱500, and declaring to claim it costs roughly ₱4,800 in net VAT
plus income tax on the margin. Roughly ten to one against.

⭐ **Keep v1's per-channel `taxTreatment: 'expense' | 'creditable'` switch anyway, defaulting to
`expense`.** One flag decides which account the leg hits; the ledger records what happened either
way. Do **not** seed a `1270` creditable-withholding-tax asset — an account that exists invites
someone to use it, and an unrealisable asset on the balance sheet is worse than no account.

⭐ **Add the 2307 attachment slot now, on `expense`.** It costs one `stored_files` reference and it
is the one document that cannot be obtained retroactively if the posture ever changes. Under
`creditable` it becomes required at posting.

## Invariants

1. Clearing (`1221`/`1222`) nets to **exactly zero** on every posted settlement.
2. The §2 identity holds, enforced by CHECK, not by the service layer.
3. A negative deduction survives end to end and reduces `feesTotal` — asserted with a real
   promo-day fixture, because this is the bug v1 shipped.
4. `netDeposited` is never negative; fees exceeding gross is a refusal.
5. A posted settlement is immutable; correction is void + re-post, and void reverses every leg.
6. Void refuses while a loan payment stands.
7. `1220` for a fully settled channel-day is **exactly zero**, not near zero.
8. Σ `1220` by party reconciles to the `1220` control balance (invariant 6).
9. Cross-store loan deductions leave Σ`1250` = Σ`2150` at entity level.
10. One posted settlement per `(channel, businessDate)`; a second is refused, not duplicated.
11. No settlement posts into a closed period, by any path (invariant 7).
12. A platform fee cannot also exist as a standalone expense document for the same settlement.

## Tests

Integration, against real Postgres, in the shape T-130/T-131 used. Required fixtures: the plain
settlement; a **negative** `platformFee` promo day; a below-tolerance shortfall; an above-tolerance
shortfall (refused); an under-report gain with and without `recognizeGain`; a same-store loan
deduction; a **cross-store** loan deduction asserting the reciprocal; a void; a void blocked by a
standing loan payment; a closed-period refusal; a duplicate-settlement refusal.

⭐ **Add a `channel.settlement` specimen to `packages/etl/corpus/`** — the corpus has expense and
sale specimens and no settlement, which is why nothing catches a settlement-shaped ETL regression.

## Out of scope — each with its reason

**Batch upload and the platform payout parsers** — v1's `parse-grab` carries drift tests and
real-loan-data tests *because the formats keep moving*; it is the larger half and it is
convenience, not correctness. Manual entry first; the parsers are their own task once this posts
correctly · **Discrepancy → infraction** — a real, actively-used control, but it belongs with
whoever owns HR in Phase 7. This task stores `variance` so the trigger exists to be wired later ·
**Input VAT on platform commission** — bible row 75, no VAT engine · **A `1270` creditable
withholding tax asset** — §7 · **Coverage date ranges** — unvalidated metadata in v1, reconciled
against nothing · **Settlements spanning multiple business days in one row** — the identity in §2
is checkable precisely because a settlement clears one day; a multi-day payout is N rows sharing a
`reference`.

## Done when

- [ ] All twelve invariants pass against real Postgres.
- [ ] Migration hand-written per DEF-073, journalled with `previous.when + 86400000`.
- [ ] `typecheck` · `npm test` · `npm run test:integration` · `npm run build` green.
- [ ] New tables classified in `classification.ts` **and** registered in `rls/registry.ts`.
- [ ] `POSTING-PATTERNS.md` gains the `channel_settlement.*` patterns.
- [x] ~~`channel.settlement` specimen added to the ETL corpus.~~ ⛔ **DEFERRED, with a
      reason.** The corpus exists to replay v1 documents through the converter, and a
      specimen needs a `channel.settlement` case class plus a converter branch that turns a
      v1 settlement into entries. ⚠️ **v2 migrates no history** — it always opens from a zero
      starting point — so that converter would have no job, and the specimen would be
      testing a path nothing takes. The regression risk the spec names is instead covered by
      the two `channel_settlement.*` worked examples in `POSTING-PATTERNS.md`, which the
      doc-parity guard keeps honest.
- [ ] `docs/ROADMAP.html` and `docs/plans/phase-2-source-documents.md` updated.
- [ ] **Ian has answered the two open decisions:** `1220` vs `1221`/`1222` roles (§4, recommended)
      and whether `6420` is seeded for settlement variance (§5).

# T-108 — Worked examples: the canonical posting pattern for every business event

> **Status:** ✅ **COMPLETE 2026-08-24** — 41 fixtures, all 12 invariants pass against real
> Postgres. **Depends on:** T-102, T-105, T-106, T-118 (all done).
> **Delivers:** Phase 1 exit-gate item **4** — *every worked example posts exactly the expected
> lines* — and closes the T-110 invariant-6 gap (see the task report for how to wire T-110's own
> tests to this corpus, not done here — out of Scope).
> **Written by:** Opus planner, 2026-08-24.
>
> **Found and fixed en route (reported, not silently worked around): DEF-049** — `postEntry`/
> `reverseEntry` never learned to carry the `party_type`/`party_id` T-118 added to the schema,
> silently blocking every control-account posting through the sanctioned write path. This is
> outside this task's own stated Scope ("Out of scope: ... changing postEntry or reverseEntry")
> — done anyway per bible §3.4a ("implement the defensible reading and flag it"), purely
> additive, zero regressions across the full pre-existing suite. See
> `packages/domain/tests/integration/post-entry-party.test.ts` and
> `docs/DEFECTS-REGISTER.md` DEF-049.
>
> **Spec defect found and corrected, not followed: this document's own §4 table said comps post
> `DR 4900`.** They post **4950** — confirmed by bible decision-log row 74, `docs/GLOSSARY.md`'s
> own comps entry, and `packages/etl/src/convert.ts`'s already-implemented, already-tested
> `ACCOUNTS.SALES_RETURNS_AND_VOIDS` mapping. Three independent, already-decided sources agree
> against this task's own spec text; the fixture (`sale.comps`) and the document
> (`docs/POSTING-PATTERNS.md`) both use 4950, and the discrepancy is called out explicitly in
> both places so it is never silently "fixed" back to what this file originally said.

## Goal

For every business event this restaurant actually has, state **exactly which lines it posts** —
once, in one place, machine-checked.

This is the document every Phase 2 module implementer reaches for. When someone builds the expense
module and asks *"what does a split-payment cash expense post?"*, the answer must be a lookup, not
a judgement call — because two people making that judgement independently is how v1 ended up
recognising the same platform fee twice (discovery `06` §3.2: **₱198,148.29 across two stores**,
37 duplicate expense documents voided).

## Why this was worth Ian's "build it"

I referenced T-108 in T-110's invariant 6 as though it existed. It did not. But the gap is real
rather than bookkeeping: **`POSTING-PATTERNS.md` has been an open Phase-1 deliverable since bible
decision #40**, and every module built without it re-derives its own answer.

---

## Scope is set by what the business ACTUALLY does

The v1 capture (2026-08-24, 12,824 journal legs across four operating stores) gives the real
frequency. **Write the examples in this order** — the top five are 88% of all activity:

| v1 `sourceType` | Legs | Example |
|---|---:|---|
| `expense_payment` | 4,396 | **Required** — and its split-payment variant |
| `sale` | 2,945 | **Required** — unli, à la carte, discounts, comps |
| `salary_advance` | 1,488 | **Required** |
| `transfer` | 926 | **Required** |
| `depreciation` | 362 | **Required** |
| `loan_payment` · `ar_collection` · `ap_payment` | 221 / 176 / 93 | **Required** |
| `cash_request_release` / `_return` | 82 / 52 | **Required** — the pair, together |
| `commissary_dispatch` | 70 | **Required** — the inter-store elimination case |
| `amortization` · `wastage_expense` · `remittance` | 38 / 16 / 10 | **Required** |
| `prepaid_purchase` · `asset_purchase` · `loan_disbursement` · `slicer_payment` | 4 / 2 / 4 / 4 | Include; they are cheap and they pin a pattern |
| `balance_adjustment` | 10 | **Include, and mark it as the one to design OUT** — see §4 |

Plus three that have no v1 `sourceType` because v1 cannot do them:

- **Reversal** of each of the above (T-106) — the correction path.
- **Year close** (ADR-006) — the single entry into 3300, carrying `source_type = 'year_close'`.
- **Opening balance** (ADR-005 + bible row 106) — the 2027-01-01 entry, per-party lump sums,
  netting 3900 to exactly zero.

---

## Contract

### 1. The fixtures are the source of truth; the document is generated from them

`docs/POSTING-PATTERNS.md` and the fixtures **must not be able to disagree.** Two hand-maintained
copies of an accounting rule is precisely the second-source-of-truth failure this project exists to
remove.

So: **fixtures are typed TypeScript**, and a test asserts the document lists every fixture and
every fixture appears in the document — the same technique `chart-of-accounts.test.ts` already uses
to parse `COA-ALIGNMENT.md` §4 for `**NNNN**` codes rather than keeping a hand-written list.

### 2. A fixture declares an event and its EXACT lines

```ts
{
  id: 'expense.cash.simple',
  title: 'Cash expense, single payment',
  narrative: 'A ₱1,200 delivery of pork paid in cash from the cashier drawer.',
  input: { /* what the module would be given */ },
  expect: [
    { accountCode: '5100', debit: '1200.00', party: null },
    { accountCode: '1110', credit: '1200.00', party: null },
  ],
}
```

- **Exact lines, in order.** Not "balances" — the specific accounts, the specific sides, the
  specific amounts. A test asserting only that debits equal credits proves almost nothing: an entry
  posting to the wrong two accounts balances perfectly.
- **`party` is explicit on every line**, `null` included. The nine `requires_party` control accounts
  reject a missing party and reject an unwanted one (T-118), so the fixture states it either way.
- Amounts are **strings**. Never floats (bible §6, and DEF-046 for what happens otherwise).

### 3. Every fixture is posted through the real `postEntry`, against real Postgres

Not asserted against a hand-written expectation of what the code does — **posted, then read back
from `journal_lines`**. That is what makes these examples rather than assertions: each one proves
the database accepts it, the triggers permit it, the balance rule passes at COMMIT, and the party
requirement is satisfied.

**Each fixture must also be reversible** — run `reverseEntry` and assert every account nets to
exactly zero. An entry that cannot be unwound is a trap (T-106 §5), and finding one here is far
cheaper than finding it in production.

### 4. The cases that carry the real decisions

These are not extra credit; they are why the document is worth writing.

| | |
|---|---|
| **Comps are contra-revenue** | Bible row 24, Ian's own rule. `DR 4900`, not an expense. A comp is revenue foregone, never a cost incurred |
| **Unli vs à la carte** | `dineInSales` is **package-only** → `4100`. `takeOutSales` is a **residual** and folds take-out into à la carte → `4150`. Read `docs/GLOSSARY.md` first: both names mean the opposite of what they look like |
| **Senior / PWD discount** | `DR 4900` contra-revenue. In v1 this is **hardcoded to zero** — the worked example is what it *should* be, and the divergence is the finding |
| **VAT is a label, not an engine** | Bible: internal books, not VAT-compliant. **No VAT is computed anywhere.** Say so in the document, or someone will build one |
| **Split-payment expense** | One expense, several payment methods → one entry, several credit lines. The single most common shape in the whole dataset |
| **AR collection with a platform fee** | Three legs: gross receivable cleared, cash actually received, fee expensed. **v1 recognised this fee twice** and it cost ₱198,148.29 — this example exists to make that impossible |
| **Commissary dispatch → branch receipt** | Inter-store. The pair must **eliminate to zero** at entity level. Phase 3 owns valuation; the *shape* belongs here |
| **`balance_adjustment`** | Include it, and label it plainly: **a plug**. v1 has 10. v2 should make it unnecessary — a correction is a reversal with a reason (T-106), not an adjusting line. **Document it as the anti-pattern**, so nobody ports it forward as a feature |

### 5. The document is written for a human

`docs/POSTING-PATTERNS.md` is a reference someone reads at 11pm while building a module. Each
pattern gets: the business event in one sentence, the T-account table, the party requirement, and
**any trap** — the fields that lie, the double-count that already happened, the account that looks
right and is not.

---

## Invariants the tests must prove

1. **Every fixture posts successfully** through `postEntry` against real Postgres.
2. **Every fixture produces exactly its declared lines** — account, side, amount, party — read back
   from `journal_lines`, in order.
3. **Every fixture balances at COMMIT** (implied by 1, asserted explicitly so a failure names it).
4. **Every fixture is reversible**, and original + reversal net to exactly zero per account.
5. **Every `requires_party` line carries its party; every other line carries none** — both
   directions, since the trigger rejects both.
6. **The document and the fixtures agree**: every fixture id appears in `POSTING-PATTERNS.md`, and
   every pattern in the document has a fixture. Parsed, not hand-checked.
7. **The trial balance ties over the whole corpus** — this closes T-110's invariant 6, which
   referenced these examples before they existed.
8. **Contra-revenue reduces revenue**: the comps and discount fixtures move `4900`, and the income
   statement shows revenue *net*, not expense inflated.
9. **The commissary pair eliminates**: dispatch + receipt net to zero at entity level.
10. **The opening-balance fixture nets 3900 to exactly zero** (ADR-005; a residual halts).
11. **The year-close fixture carries `source_type = 'year_close'`** and is excluded from a
    date-range P&L while included in a balance-sheet-as-of (ADR-006).
12. **No fixture uses a float anywhere** — asserted structurally over the fixture source.

## Out of scope

Building the modules that will post these (Phase 2) · inventory valuation (Phase 3) · any UI ·
any schema change · VAT of any kind · changing `postEntry` or `reverseEntry`.

## Done when

- [ ] All 12 invariants pass against real Postgres.
- [ ] `docs/POSTING-PATTERNS.md` exists, is generated from or checked against the fixtures, and
      reads as a reference rather than a test dump.
- [ ] `npm run typecheck` clean · `test` · `test:integration` green (**every existing test still
      passes**) · `build` succeeds with the dev server stopped.
- [ ] T-110's invariant 6 now runs against this corpus rather than a substitute.
- [ ] Any spec defect **reported, not silently worked around**.

> **The measure of success:** a Phase 2 implementer building the expense module should never have
> to decide what an expense posts. If they still have to decide, this document failed.

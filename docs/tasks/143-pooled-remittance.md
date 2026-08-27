# T-143 — Pooled remittance: one handover settling many days

> **Status:** SPEC, 2026-08-27. Written before implementation (bible §1.2a).
> **Requirements:** T-136 §1 and §7 — this is their **design**. Bible rows **128–129, 144–147**.
> **Depends on:** T-139 money transfers, T-142's five foundation accounts, ADR-010's custodians.
> **⛔ Not in scope:** T-136 §2's imprest revolving fund. Its §5 research pass (ERPNext/Odoo
> petty-cash models) is still owed and this task does not pre-empt it.

## 1. What is being built

> **Ian:** *"Lipa has 5 sitting sales reports for January 1 to 5, all verified, money in cashier
> not remitted yet — it can be remitted all at once, so remittance-01 can cover 5 dates. If the
> remittance is short, cover the oldest sales report first, and record shortage/overage on the last
> date."*

The **daily count stays daily** (a sales day locks on verify, and that is when the till is
reconciled). What pools is the **handover**. T-136 §1's phrase for it: *separate the COUNT from the
TRANSFER.*

## 2. ⭐ A remittance IS a transfer, with allocations attached

The money movement is already built: cashier-custodian account → office-custodian account, same
store, T-139. **Nothing new posts to the ledger here.**

⛔ **So this task must not grow a second money-movement path.** What it adds is the *bookkeeping
around* that transfer: which days it settles, in what order, and what was left over. Building a
parallel posting routine is precisely how v1 ended up with two amortisation runners that drifted.

| Concern | Owner |
|---|---|
| Moving the money | `createMoneyTransfer` (T-139) — unchanged |
| Which days it settles | **This task** |
| The variance and its lifecycle | **This task** (§5) |
| What each day is owed | ⭐ **Derived** — never stored (§3) |

## 3. Expected remittance is DERIVED, and row 145 already settled how

> **Bible row 145:** *"Expected remittance is the cashier accounts' NET MOVEMENT, derived from the
> ledger — not a sum over document types."*

⭐ This is why it is `custodianPositions(custodian: 'cashier')` and not a sum over sales, less
expenses, less cash requests, less advances. Ian's inventory of ins and outs is the
**documentation** of what posts there; it is not the query. A query that enumerates document types
is wrong the day a new document type appears — silently, and in the safe-looking direction.

⛔ **No `expected_remittance` column, anywhere.** v1's non-remitted total ended up holding a copy of
a figure it no longer matched.

## 4. Allocation: FIFO, oldest first

```
Jan 1–5 verified, ₱10,000 remittable each        expected  ₱50,000
Cashier hands over                                actual    ₱46,000

  Jan 1–4   settled in full
  Jan 5     ₱6,000 settled  →  ₱4,000 SHORT
```

⭐ **"Record the shortage on the last date" is not a second rule — it is what FIFO produces.** A
rule that falls out of the allocation cannot drift from it. An overage is symmetric: every day
settles in full and the residual sits positive on the same last date.

### A day's remittance state is DERIVED

`unremitted` · `partially_remitted` · `remitted`, computed from *what the day is owed* against
*what has been allocated to it*.

⚠️ **`partially_remitted` is not a column** — bible row 146 confirms v1 has that state and we keep
the word, but `sales_days`' own header forbids the column: *"do not add `actualRemittanceCash`,
`remittanceRefNo` or a `partially_remitted` status here; that is precisely the shape that blocks
pooling."* Same name, derived rather than stamped.

### Batch is ADDITIVE

Row 146: daily remittance is **not** replaced. One day may be settled by one handover or by three;
a day already fully settled is simply skipped by FIFO.

## 5. ⭐ The variance gets its own table, because the point is that it cannot hide

> **Ian, 2026-08-26:** *"no, it won't block — but it must be flagged and dedicate a separated table
> so it won't hide from sight like v1 does."*

`remittance_variances` — the **case** and its lifecycle. Row 147: *the table holds the case; the
peso figure stays derived.*

⛔ **An open variance does not block the next remittance.** Blocking would push people to fudge the
count to keep trading, which is worse than a visible open item.

### 5.1 ⚠️ It is a CUSTODY variance, not a COUNT variance

| | Found when | Means | Belongs to |
|---|---|---|---|
| **Count** variance | Daily close, per day | The till did not match the day | The cashier who worked **that day** |
| **Custody** variance | The batch handover | Money counted and signed for did not arrive | Whoever **held the pool** |

⭐ Once the till is counted daily and signed, a batch shortage **cannot** be a counting error — the
counts already reconciled. It is a loss *in custody*, after the fact.

⛔ **So dating it on the last date is right; attributing it to that date's cashier is NOT.** FIFO
put the residual there; that says nothing about who was holding the money. **v1 already refuses to
guess** — its remittance builder *throws* if a shortage posts without an explicit
`chargeToStaffId`. Port the refusal. Inferring the person from the date is exactly the wrong
inference, and row 128 warned of it: *"a shortage found then is attributable to nobody."*

## 6. Tables

**`remittances`** — the handover. `org_id`, `store_id`, `remitted_on`, `reference`, `notes`,
`accepted_by`, `created_by`, `created_at`. ⛔ No total column: the total is its lines.

**`remittance_lines`** — one per money account handed over (the till and the wallet remit
separately), each carrying the `money_transfer_id` that moved it. ⭐ The FK is the seam that keeps
one money-movement path.

**`remittance_allocations`** — `remittance_id`, `sales_day_id`, `amount`. FIFO's output, written
once. This is what makes a day's state derivable.

**`remittance_variances`** — `remittance_id`, `sales_day_id` (the last date), `amount` (signed:
negative short, positive over), `status` (`open` · `charged` · `written_off`), `charged_to_person_id`
(⚠️ nullable, and **required to leave `open`**), `resolved_by`, `resolved_on`, `reason`.

## 7. Rules

1. Only **verified** sales days are remittable. An unverified day has no signed count behind it.
2. Allocation is FIFO by business date, ascending. Fully-settled days are skipped.
3. `accept_remittance` gates the handover — the capability exists and DEF-052 records that in v1
   it *enforced nothing*, so it needs a denial test.
4. ⛔ A variance cannot be **charged** to nobody: leaving `open` requires a person or an explicit
   write-off with a reason. Never inferred from the date.
5. Row 129's un-remitted **ceiling** still governs the cadence; this task surfaces the figure it
   watches (§3) but does not enforce the ceiling.
6. Reversing a remittance reverses its transfers through `reverseEntry` and voids its allocations.
   ⛔ Never a delete.

## 8. Done when

- [ ] The four tables, classified in `cutover/classification.ts` **and** `rls/registry.ts`, with
      RLS policies in the migration.
- [ ] `createRemittance` — allocates FIFO, posts through `createMoneyTransfer`, records the
      variance. Reverse path too.
- [ ] A day's state derived, never stamped; a test asserting no `partially_remitted` column exists.
- [ ] Integration tests: the five-day worked example above to the peso; an overage; an additive
      second batch; a denial test for `accept_remittance`; and ⛔ **a test that a shortage cannot be
      charged to nobody**.
- [ ] Driven end to end in a browser.
- [ ] Gates: typecheck · unit · integration.

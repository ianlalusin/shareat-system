# T-126 — Loans: disbursement, payment, interest

> **Status:** ⚠️ **BUILT (service layer), 2026-08-27.** Screens remain. Written before implementation (bible §1.2a).
> **Plan:** phase-2 §Financial, after T-125.
> **Accounts already seeded:** `2400` Loans payable (**control, party-requiring — the lender**) and
> `7200` Interest expense.

## 1. What v1 has, and the postings to port unchanged

`loan.builder.ts` documents them, and they are right:

| Event | Posting |
|---|---|
| **Disbursement** | DR the money account · CR `2400` (party = lender) |
| **Payment** | DR `2400` *principal* · DR `7200` *interest* · CR the money account |

⭐ **`2400` is party-requiring**, so the lender is on the line — one control account, many loans,
the same shape ADR-010 uses for wallets. No `liability__loan_{id}` account per loan.

## 2. ⛔ FOUR maintained running totals, and the register already drifted

`LoanPlain` carries **`totalPaid`, `principalPaid`, `interestPaid`, and `outstandingBalance`** —
the last with the comment *"principalAmount - principalPaid"*, i.e. a stored copy of a subtraction.

⚠️ **This is not a hypothetical risk. The ERPNext migration measured it** (`00_PROGRESS.md`, two
Grab loans on Lipa): *"NEITHER figure is usable."*

- **Loan A** shows `principalPaid ₱170,875.88` → outstanding ₱29,124.12 — but Lipa's settlements
  stop 14 days short, so the figure is stale by construction.
- **Loan B** shows **zero payments**, which is *"a **wiring artifact**, not a fact"*: every
  settlement routes its deduction through a single `channelCfg.loanId`, and a full scan found
  **0 references** to Loan B.

⛔ **So v2 stores none of the four.** Outstanding is `principal − Σ(principal legs posted against
2400 for this loan)`, read from the ledger. ⚠️ **And no balance is imported at cutover** — T-134
owns opening balances, and both live figures are known-wrong.

## 3. ⭐ The rate period must be NOT NULL, and v1 says why

> *"ABSENT on loans written before this field existed — those were all entered as an annual
> percentage, so absent MUST read as `'year'`. New loans default to `'month'`, which is how Grab
> quotes. **A month is 30 days and a year is 365; the two are not interchangeable**, which is why
> this is stored rather than inferred."*

⛔ An absent `ratePeriod` means **different things for old and new rows** — a 2% that is monthly on
one loan and annual on another, with nothing on the row to tell them apart. `NOT NULL` with no
default, so a loan whose rate period nobody stated cannot exist.

## 4. ⭐ The improvement: the split is COMPUTED, not typed

v1's builder takes the principal/interest split **from the caller** — *"Interest is cash-basis,
recognised at payment time from the split provided by the caller"* — with a `suggestPaymentSplit`
helper the caller may ignore. So the number that decides how fast a debt retires is hand-entered.

**v2 computes it.** Interest accrued since the last payment is a function of the rate, the period
and the days elapsed; given a payment, **interest is taken first, principal takes the remainder**.

⚠️ **This matters because real payments do not follow the schedule.** Grab deducts what the day's
net allows — *"the history shows Grab repeatedly deducting less than the instalment when the day's
net is small"* — so "an arbitrary amount arrived, how does it split?" is the normal case, not the
exception.

⛔ **Interest stays cash-basis, as v1 has it.** Accruing monthly would be more correct in principle
and is a bigger change than this task; it is named here so the omission is a decision.

## 5. Scope

**In.** `loans` · disbursement · payment (with the computed split) · void · derived outstanding ·
the three interest methods v1 supports (`straight`, `amortizing`, `equal_principal`) · screens.

**Out.** Auto-deduct (v1 has a cron; ⭐ **T-140's month-end runner is where that belongs now**, not
a second scheduler) · the cross-store channel-loan paydown (`crossStorePayer`, funded through the
inter-store payable — it needs T-133 and rows 152–153's due-from/due-to pair) · loan restructuring.

## 6. Rules

1. `2400` needs a party. ⛔ A loan with no lender cannot be disbursed — the line would be
   unattributable, which is what the party requirement exists to prevent.
2. Payment: interest first, principal second, and ⛔ **principal may never exceed what is
   outstanding** — a payment bigger than the debt is an overpayment, not a negative loan.
3. Outstanding, paid-to-date and interest-to-date are **derived**. A test must prove no such column
   exists.
4. A loan reaching zero outstanding becomes `paid_off` — derived from the ledger, not stamped by
   whoever happened to post last.
5. Money leaving for a payment obeys T-139's rules: a cashier account **warns**, an office account
   **refuses** (bible row 154).
6. Void reverses through `reverseEntry`. ⛔ Never a delete.

## 7. Done when

- [x] `loans` in the schema, classified in `cutover/classification.ts` **and** `rls/registry.ts`,
      with RLS policies in the migration.
- [x] Interest and split arithmetic in a **pure module**, 14 unit tests across the three methods.
- [x] Repo + services (disburse · pay · void), with outstanding derived.
- [x] Integration tests — 10, incl. the postings, the computed split, the overpayment refused,
      the denial, and that neither v1's four totals nor a `loan_payments` table exists.
- [ ] Screens, driven end to end in a browser.
- [x] Gates: typecheck · unit 575 · integration 885. ⚠️ Screens still to do.

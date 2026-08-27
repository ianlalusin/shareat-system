# T-128 — Generic liabilities: what the business owes that nothing else tracks

> **Status:** SPEC, 2026-08-27. Written before implementation (bible §1.2a).
> **Defect it fixes:** DEF-074 — a liability recorded in three places, for the fourth time.

## 1. What it is

An obligation the business has incurred and not yet paid, where **no other module already owns it**:
an accrued rent, a permit fee billed but unpaid, a settlement agreed with a contractor.

⛔ **Deliberately NOT this module's job**, because each already has a home:

| | Owned by |
|---|---|
| A supplier invoice | `2110` AP, T-130 |
| Money borrowed | `2400`, T-126 |
| Wages owed | `2300`, payroll |
| SSS / PhilHealth / Pag-IBIG / withholding tax | `2210`–`2240`, payroll accrues and `statutory_remittance` settles |
| What one store owes another | `2150`, rows 152–153 |

⭐ **A generic liability is the residual**, and naming the residual precisely is what stops it
becoming a dumping ground.

## 2. ⭐ One control account, `2500`, with the obligation as the party

`2500 Accrued and other liabilities` — new, party-requiring, `party_type = 'liability'`.

```
charge    DR the expense (or asset)   CR 2500   (party = the liability)
payment   DR 2500 (party = it)        CR the money account
                                          → 2500 nets to zero when it is settled
```

**Fifth application of the same rule** — the wallet (row 142), the loan (row 158), the cash request
(row 159), the owner (row 160), now the obligation. One shared control account, the entity named on
the line, so *"which of these is still unpaid?"* is a `GROUP BY` and not a second register.

### ⛔ Why the statutory accounts are NOT used here, and must not be

`2210`–`2240` stay exactly as they are: **party-free**. Two things already depend on that —
`statutory_remittance` debits `2210` with no party, and payroll will accrue into those accounts when
it is built. Making them party-requiring would break a pattern that already works to serve a module
that does not need it.

⚠️ **So a liability whose real home is a statutory account is REFUSED, naming the reason.** Recording
an SSS obligation here would put its balance in `2500` while payroll puts the same money in `2210` —
the same debt counted twice, in two accounts, with nothing reconciling them. ⛔ Blocking beats
silently double-counting (T-122 invariant 7's rule, unchanged).

## 3. ⛔ DEF-074 — the same three registers, a fourth time

`LiabilityAccountPlain` carries `outstandingBalance`, `totalCharged` and `totalPaid`; a
`LiabilityLedgerEntry` carries its own `balanceBefore` / `balanceAfter`; and both sit beside the
journal. Identical in shape to the loans (row 158), owner equity (DEF-072) and the cash requests.

⭐ Here `charged`, `paid` and `outstanding` are all summed from `2500` by party, and
`outstanding = charged − paid` is arithmetic on that one balance.

⚠️ **`status` is derived too.** v1 stores `'active' | 'settled'`; settled means the balance reached
zero, and the ledger already knows.

## 4. ⭐ Due dates — a genuine ADD, because v1 cannot tell you what is late

`LiabilityAccountPlain` has **no due date field at all**. An obligation with no due date cannot be
overdue, so v1's liability screen can show what is owed and never what is *late* — which is the
question anyone actually opens it to ask.

v2 records `due_on` (nullable — some obligations genuinely have no date), and **overdue items surface
above the register**, the way remittance surfaces open variances and T-127 surfaces aged owner
receivables. ⚠️ A prompt, not a rule: nothing refuses an overdue liability, but nobody has to
remember to look for one.

## 5. Scope

**In.** The register · create · charge · payment · reverse either · the derived position · overdue
surfacing · screens.

**Out, named so the omissions are decisions:**

- ⛔ **Recurring / scheduled charges.** T-140's runner owns scheduling; a second cron is how v1 ended
  up with two.
- ⛔ **Partial-payment allocation across several charges.** The balance is per obligation, and FIFO
  within one obligation answers nothing — unlike T-143's remittance, where the days are distinct
  documents.
- ⛔ **Interest or penalties on a late obligation.** Real, and it is T-126's arithmetic, not this
  module's. A liability that accrues interest is a loan wearing a different word.

## 6. Done when

- [ ] `liabilities` in the schema, classified in `cutover/classification.ts` **and** registered in
      `rls/registry.ts`.
- [ ] `2500` seeded and party-requiring; `party_type` widened to `'liability'`.
- [ ] Services: create · charge · payment · reverse, with the position derived.
- [ ] Integration tests: ⭐ **`2500` nets to zero when it is settled**; ⭐ **a statutory account is
      refused, naming the reason**; a reversal nets out; two obligations on one account are told
      apart; overdue is computed from `due_on`.
- [ ] Screens, driven end to end in a browser.
- [ ] Gates: typecheck · unit · integration · build.

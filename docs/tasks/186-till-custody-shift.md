# T-186 — The till custody shift

> **Status:** specced 2026-08-30 · the pass that produced it is `docs/tasks/153-standing-till-float.md` §14
> **Unblocks:** T-153 §13 (short/over need a count) · T-143's named attribution
> **Depends on:** nothing. Attendance supplies the person and the clock; neither is required to open a shift.

---

## 1. ⭐ Verdict — build it, and it is the highest-frequency record in the cash module

**Build it.** Two tables, no new dimension, no new posting path.

Roughly **two rows per store per day** — an opening count and a closing count on one till, morning
and evening. Nothing else in cash custody runs at that rate: remittances are pooled and therefore
rarer by design (T-143), sales days are one per store per day, expenses are event-driven.

**What gets worse if it is never built** is not hypothetical, and it is already written down in two
shipped modules:

| Already shipped | The sentence it rests on | True today? |
|---|---|---|
| **T-143** `remittance_variances` | *"Once the till is counted daily and signed, a batch shortage **cannot** be a counting error — the counts already reconciled."* | ⛔ **No.** There is nowhere to record a count, so every batch shortage is ambiguous |
| **T-153** §13.3 | *"Neither rule is implementable yet… v2 has **no shift record**, so there is nowhere to enter a count."* | ⛔ Still true |

⭐ **So this task's real output is not a screen — it is making T-143's stated premise true.** A
custody variance means "a loss after the counts reconciled". Until counts exist, it means "a
difference of unknown kind", which is what v1 had.

---

## 2. The stated reason, and whether it holds

The reason given for a shift record was *"the cashier has to count the ₱20,000 float every opening
and closing"* (Ian, 2026-08-29). **It holds, but it is the smaller half.**

The float count is one count of one pocket. The same record is what finally lets a shortage
**name a person** — which bible row 128 requires, `remittance_variances` enforces with a CHECK
constraint, and v1 cannot do at all:

```
v1  CashRemitShiftPlain.cashierName: z.string().optional().nullable()
```

⛔ **v1 records the custodian as a nullable free-text name.** Not a reference, not required. That is
why v1's own remittance builder throws rather than infer who owes a shortage — there is nothing
reliable to infer *from*. The fix is not a better inference; it is a row that names the person.

---

## 3. What already exists

### 3.1 Here (v2)

| Exists | Relevance |
|---|---|
| `money_accounts` + `float_target` (T-153) | ⭐ **The till already has an identity** — a store's cashier-custodian accounts. No `tills` table is needed |
| `balanceOf(tx, orgId, account)` | The expected figure. ⚠️ See §6.3 — it has no `asOf`, and that changes the design |
| `remittances` / `remittance_variances` (T-143) | The **custody** variance. A different question — see §5 |
| `attendance_days` / `attendance_punches` (T-157) | The person and the clock. ⭐ Referenced, never restated |
| `count_sessions` (T-169) | Precedent for a counted thing that posts its variance. ⚠️ **Stock, not cash** — no reuse, only shape |
| `postEntry` + `commissary/discrepancy.ts` | The working precedent for charging a person to `1230` with `party_type='employee'` |

### 3.2 v1 — `CashRemitShiftPlain`

Read at source (`ERP-rebuild/src/lib/financial/cashRemit.schemas.ts`). **It is two objects fused
into one**, and only one of them belongs here:

```
opening { source: 'float'|'manual'|'handover', floatAmount, prevShiftId, startedAt, startedByUid }
closing { cashCounted, cashKeptInDrawer, cashHandoverToNext, cashRemitToOwnerManager, nextShiftId }
         .refine(cashCounted === kept + handover + remitted)          ⭐ the distribution identity
--------------------------------------------------------------------- everything below is the sales report
cashIns[] cashOuts[] totalSales dineInSales takeOutSales deliverySales
less { cashierExpense, salaryAdvanceCashier, cashRequestReleasedCashier, apPaymentsCashier, … }
plus { arPaymentsCashier }   summary { cashierRemittance, onlineRemittance, … }
```

⭐ **Port the top. Refuse the bottom.** Every field under the line is a figure v2 already holds as a
real document — `expenses`, `cash_requests`, `ap_payments`, `ar_collections`, `sales_days`. Copying
them onto a shift would be a second entry point for the same fact, which is
[discovery 23 §4](../discovery/23-store-settings-and-config.md)'s decision restated:

> *"POS may still take the physical count, where the drawer is. **But it submits evidence; it does
> not compute expected cash.** One computation, one owner."*

⚠️ **v1's `FLOAT_TOLERANCE = 0.01`** on the distribution identity. v2 uses exact integer centavos,
so the identity is an equality and needs no tolerance. (Not to be confused with the ₱1 receipt
close tolerance — a different document, a different question.)

### 3.3 POS

`cashHandovers` computes `expectedCash = startingCash + cashSales − deductions[]`, and **POS does
not know the deductions** — every one is an ERP document. Already decided (discovery 23 §4): the
count is evidence POS may capture; the expectation is the ERP's. ⛔ **Out of scope here** — POS v2
owns its own entry surface.

### 3.4 Industry / open source

A till-custody record is a point-of-sale primitive ("blind close", "X/Z reading", "cash drop"), not
a general accounting one. Open-source ERPs model it inside their POS module — Odoo's
`pos.session` (`cash_register_balance_start` / `_end_real`, `cash_real_difference`) and ERPNext's
*POS Closing Entry* (`pos_opening_entry`, per-mode `opening_amount` / `closing_amount` /
`difference`) are the two mature examples. **Both confirm the shape below** — a session with an
opening and a closing amount *per payment mode*, a signed difference, and a link to the prior
session.

⛔ **Nothing worth adopting as code.** Both are AGPL-3.0 and both are inseparable from their host ORM
and POS. What they are worth is the confirmation that per-account count lines (not two fixed cash
columns) is the settled design, and that the difference is stored on the session rather than
recomputed — which §6.3 arrives at independently, for a reason neither of them documents.

---

## 4. ⛔ The grain — and why it is not `attendance_days`

Settled in T-153 §14; restated here because it is the one thing that must not be re-litigated.

```
uniqueIndex('attendance_days_employment_shift_day_unique').on(employmentId, shiftDay)
```

**One row per person per 05:00-to-05:00 day.** A till needs **one row per till per handover**.

⚠️ **The decisive case:** a cashier who works the morning, hands over, and returns in the evening
produces **ONE** `attendance_days` row and **TWO** custody periods. Keying custody on that row makes
the second handover unrepresentable — and a handover that cannot be recorded is exactly the
shortage that gets attributed to nobody.

⭐ **So the shift REFERENCES attendance and never restates it.** `attendance_day_id` is nullable and
carries no times of its own: two tables asserting when the evening cashier took over will drift, and
the first symptom is a variance charged to the wrong person.

---

## 5. ⭐ Three variances that look identical and mean opposite things

This is the contribution that outlives the code. All three are a signed peso amount on a till.

| | Compares | Means | ⭐ Who answers | Status |
|---|---|---|---|---|
| `tillFloatOffTarget` | **ledger** vs `float_target` | the pot was spent down or over-topped, correctly posted | ⛔ **nobody** — the office replenishes | shipped, T-153 |
| **counted variance** | **physical count** vs ledger | cash that should be in the pocket is not | ⭐ **the cashier** | ⬅ **this task** |
| custody variance | **remitted batch** vs what was owed | a loss after the counts reconciled | whoever held the pool | shipped, T-143 |

⚠️ T-153 §13.4 already put a guard on the first-vs-second confusion, because *"reading the
detector's finding as 'the cashier owes this' would charge somebody for a delivery they paid for
correctly."* **That guard is now load-bearing** — this task introduces the row that genuinely does
mean "the cashier owes this", so the two must never render alike.

---

## 6. The structure

### 6.1 `till_custody_shifts` — the period

| Column | Notes |
|---|---|
| `id`, `org_id`, `store_id` | |
| `business_date` (date) | The trading date the shift belongs to. ⭐ Same key `remittance_allocations` settles against (bible row 157) |
| `shift_no` (int, ≥1) | 1 = morning, 2 = evening. **Unique on `(store_id, business_date, shift_no)`** |
| `status` | `open` → `closed` → `voided` |
| `opened_at`, `opened_by` → `persons` | ⛔ **`opened_by` is NOT NULL.** This is the whole point — see §2 |
| `closed_at`, `closed_by` → `persons` | Null while open |
| `prev_shift_id` → self | ⭐ The handover chain, v1's `opening.prevShiftId`. Nullable — the first shift of a day has none |
| `attendance_day_id` → `attendance_days` | ⚠️ **Nullable, and no times of its own.** §4 |
| `notes` | |

**Constraints**

- `closed` ⟺ `closed_at` and `closed_by` are both present; `open` ⟺ both null.
- ⛔ `prev_shift_id` is UNIQUE — one shift hands over to at most one successor. A branching chain
  would let the same cash be inherited twice.
- ⛔ **A store may have at most one `open` shift.** Partial unique index on
  `(store_id) where status = 'open'`. Two open shifts on one till means two people believe they
  hold the same cash.

### 6.2 `till_count_lines` — what was physically counted

One row per money account per moment. ⭐ **Lines, not two fixed cash columns** — the float and the
takings drawer are different accounts, they reconcile against different things (§5), and a store
that ever grows a second drawer gets a second account, not a schema change.

| Column | Notes |
|---|---|
| `id`, `shift_id` → `till_custody_shifts` | |
| `moment` | `open` \| `close` |
| `money_account_id` → `money_accounts` | |
| `counted` (numeric 14,2) | ⛔ `>= 0`. A physical count of cash cannot be negative |
| `expected` (numeric 14,2) | **Stored, not derived.** §6.3 |
| `counted_at`, `counted_by` → `persons` | |

- Unique on `(shift_id, moment, money_account_id)`.
- **`variance` is `counted − expected`, and is DERIVED** — computed on read, never a third stored
  number that can disagree with the two it comes from.

### 6.3 ⚠️ `expected` is STORED — the one deliberate exception to derive-don't-store

Everything else in this system computes on read. This does not, and the reason is specific:

> **`balanceOf(tx, orgId, account)` takes no `asOf`** — and even if it did, **entries can be
> backdated**: an expense keyed tomorrow with today's `entry_date` changes what "expected at 22:00
> today" evaluates to, *after the count was taken and signed*.

⛔ **A count is an observation of a moment, not a standing question.** Re-deriving its expectation
later would silently rewrite last week's variance — and someone was charged for that number. This is
the same reason `attendance_days` stores `attendance_config_id` (discovery 15 #6): *a payslip must
never disagree with what was actually recorded, even if today's config has since changed.*

⭐ **The test that protects it:** count a shift, assert the variance; post a backdated entry into the
same account and period; assert the shift's variance is **unchanged**.

### 6.4 Registries — the build will refuse the tables until both are filled

- `packages/db/src/rls/registry.ts` — `till_custody_shifts`: `org_column`.
  `till_count_lines`: `derived`, via its parent shift, exactly as `remittance_lines` is.
- `packages/db/src/cutover/classification.ts` — both **`purge`**. A custody period over 2026 cash,
  against days that are themselves purged. ⚠️ Same caveat T-134 records for `remittance_variances`:
  an unresolved counted shortage is a real claim and must be **settled or written off before
  cutover**, never silently inherited.

---

## 7. The postings

### 7.1 Opening and closing post NOTHING

A count is an observation. The money did not move; somebody looked at it. ⭐ The handover between
two cashiers posts nothing either — same store, same custodian, same GL code `1110`; a transfer
whose two legs are the same account is not an entry, it is a change of who is answerable, and that
is what `prev_shift_id` records.

### 7.2 A counted SHORT on the float — charged, per T-153 §13.1

Ian, 2026-08-29: *"charge to cashier, then office will replenish on the day it is counted as short."*

```
Dr  1230  Advances to employees        500.00   party_type = 'employee', party = the cashier
    Cr  1115  Cash on hand — till float          500.00
```

⚠️ **Order matters and is not cosmetic** — charging first leaves the pot short and the cashier owing
it. The office replenishment (`Dr 1115 / Cr 1130`) is **an ordinary money transfer that already
exists** (T-153 §3.4); it is not part of this posting and must not be fused into it, or the shortage
vanishes into a transfer and nobody answers for it.

### 7.3 A counted OVER — ⛔ posts nothing at all

Ian: *"if it overs then it will be remitted, but **it must not hit the book** because we put it on
the tipbox."* T-153 §13.2 established that **doing nothing is the correct implementation, not a
dodge** — the ledger says the pot holds its target, the pocket happens to hold more, and removing
money the ledger never knew about is not a ledger event. The books were right before and after.

⛔ **Never `7350`** (that account is for a *remittance* variance, where the money genuinely was the
business's) and **never an income account**.

⭐ **A test must assert that resolving an overage creates ZERO journal entries.** "It posts nothing"
is the kind of rule that is silently violated by a later helpful edit.

### 7.4 ⛔ Deliberately NOT built here: `remittance.shortage` posting

`POSTING-PATTERNS.md` §`remittance.shortage` documents `Dr 1230 / Cr 1110` for a batch shortage —
and `resolveRemittanceVariance` **does not post it**; it only flips a status. Verified: no module
under `packages/domain/src/remittance/` references `1230`.

That is a real gap, it is **T-143's**, and fixing it from inside this task would put a second cash
shortage posting path in a second module — precisely the drift the bible warns about (two
amortisation runners). ⭐ **Raise it as a defect; do not fix it here.** When it is fixed, both should
call one helper.

---

## 8. Capabilities

Follows the `submit_sales_day` / `verify_sales_day` segregation already in the matrix.

| Capability | Scope | super | admin | manager | staff | Notes |
|---|---|:--:|:--:|:--:|:--:|---|
| `record_till_count` | store | ✅ | ✅ | ✅ | ✅ | ⭐ **Staff-open deliberately.** The person holding the drawer is the cashier. Manager-gating it is how the register stays empty — the same reasoning T-137 records for `record_statutory_discount` |
| `resolve_till_variance` | store | ✅ | ✅ | ✅ | **✗** | ⛔ **The asymmetry IS the control.** Charging a shortage names a person and moves `1230`; a cashier must never be able to charge, forgive, or write off their own count |

Each ✅ needs a test proving the ✗ fires (`docs/decisions/CAPABILITY-MATRIX.md`).

---

## 9. The finding

One new detector in T-135's layer — **`tillCountVarianceOpen`**, severity **soft**.

- Soft, not hard: an unresolved shortage is a business problem, not a ledger imbalance. The trial
  balance ties either way. (Same reasoning T-143 records for not blocking on an open variance —
  blocking pushes people to fudge a count to keep trading.)
- ⚠️ Its message must say **counted**, in as many words, and must not read like
  `tillFloatOffTarget`. §5 is why.
- ⚠️ Adding it moves T-135's pinned finding count from 11 to 12, and `KIND_LABEL` in
  `apps/erp/src/app/findings/lib.ts` needs the twelfth entry or the page renders a raw kind.

---

## 10. ⛔ Deliberately out of scope

| Not built | Why |
|---|---|
| A **`tills` table** | *"1 store 1 till, most is 2 shifts, same till"* (Ian). T-153 already enforces one float pot per store. A second till would be a second money account — which the count lines already key on. Inventing the dimension before the business has it is how it ends up wrong |
| **Per-denomination breakdown** | v1 has none, nobody asked, and it multiplies rows by ten to answer a question no report asks |
| **POS-side count capture** | Discovery 23 §4 — POS submits evidence. That is POS v2's surface, and the ERP must accept a late paper count regardless (POS sells offline) |
| **`remittance.shortage` posting** | §7.4 — T-143's gap, raised as a defect |
| **Blocking the next shift on an open variance** | T-143's decision, applied consistently: it would push people to fudge a count to keep trading |
| **Auto-opening a shift from an attendance punch** | ⛔ Tempting and wrong. Clocking in is not taking custody of cash; a server clocks in too. Custody is an explicit act with an explicit count |

---

## 11. Done when

1. Both tables exist, in **one** migration, registered in **both** registries.
2. A shift can be opened, counted, closed and handed over to the next shift, with the chain intact.
3. ⛔ A second `open` shift on the same store is **refused by the database**, not only by code.
4. A backdated entry does **not** move a closed shift's variance (§6.3).
5. A float short charges `1230` to a named person; **an over posts nothing** — both asserted.
6. `resolve_till_variance` denies staff, with a test that proves the ✗ fires.
7. The twelfth finding renders on `/findings` with a label, and its wording is distinct from
   `tillFloatOffTarget`.
8. ⭐ **Driven in a browser** — open, count, close, hand over. Per T-169's lesson: *a shipped server
   action is not a shipped feature.*

## 12. Gates

`npm run typecheck` · `npm run test` · `npm run test:integration` · `npm run build`, and the screen
rendered in Chrome on port 9008.

---

## 13. ✅ Built — 2026-08-30

Shipped as specced. Two tables, one migration (`0103`), no second posting path.

| Delivered | Where |
|---|---|
| `till_custody_shifts` + `till_count_lines` | `packages/db/schema/till-shifts.ts`, migration `0103` |
| Repo | `packages/db/src/repo/till-shifts.ts` |
| Services | `packages/domain/src/till/index.ts` — open · count · close · charge |
| Capabilities | `record_till_count` (staff ✅), `resolve_till_variance` (staff ✗) |
| Twelfth finding | `tillCountVarianceOpen`, in T-135's layer |
| Screen | `/till`, linked from the Daily nav group |
| Tests | 17 integration, `packages/domain/tests/integration/till-custody.test.ts` |

### 13.1 ⛔ What the build found that the spec did not predict

**The `expected`-is-stored argument got stronger, not weaker.** §6.3 justified it on `balanceOf`
having no `asOf`. The test written to prove it (`a BACKDATED entry does not move a closed shift's
variance`) showed the deeper reason: even a point-in-time `asOf` would not have been enough, because
an entry posted *tomorrow* can carry *today's* `entry_date`. A stored expectation is not a
concession to a missing parameter; it is the only correct model of an observation.

**`countableAccounts` had to refuse e-wallets, and that was not in the spec.** A cashier's money
accounts include `Cashier online`. Offering it as a countable pocket invites a typed-in figure for
something nobody can physically count — so the service refuses it by name. The lesson generalises:
**a count screen must never offer a field that cannot be counted.**

### 13.2 ⛔ DEF-104 — found while running the gates, and it is the bigger find

The first full integration run against the shared `shareat_test` failed **187 tests**, all in
attendance, on a working tree whose typecheck and unit suites were green.

**The database, not the code.** `shareat_test` had 73 of 87 migrations applied and **no attendance
tables at all**. Thirteen migrations — all ten attendance ones and three inventory ones — carry a
`when` *below* the highest already recorded in `drizzle.__drizzle_migrations`, so the runner had
skipped them and would skip them forever.

⭐ **This is DEF-039's damage, made permanent.** DEF-039 records that a migration *can* be silently
skipped. What it does not say — and what cost an hour here — is that **correcting the journal only
helps a FRESH database.** One migrated during the broken window has an unrepairable hole:

> ⛔ After any journal-timestamp correction, every already-migrated database must be **checked, not
> assumed**. A `when` that is present in `_journal.json`, absent from `__drizzle_migrations`, and
> below that table's maximum is a hole no re-run can fill. The only remedy is to drop and recreate.

Both local databases were rebuilt (87/87, RLS forced on the new tables). `shareat_dev` had the same
hole in a milder form — three inventory migrations recorded under their pre-correction timestamps.

### 13.3 What is still open, deliberately

- **DEF-105** — `remittance.shortage` is a documented posting pattern that nothing implements.
  §7.4 argued against fixing it here and the build did not change that: two cash-shortage posting
  paths in two modules is the drift the bible warns about. ⭐ One helper, when it is done.
- **The office replenishment** stays an ordinary money transfer (T-153 §3.4). Fusing it into the
  charge is what makes a shortage disappear into a transfer.

## 14. Gates — 2026-08-30

`typecheck` ✅ · `unit` **777 passed, 1 skipped** ✅ · `integration` ✅ · `build` ✅ ·
`/till` driven in Chrome on 9008: open → count → close → hand over, and a shortage charged.

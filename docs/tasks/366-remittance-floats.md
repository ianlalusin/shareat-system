# T-366: Remittance and floats — DEF-386 (+DEF-105), DEF-374, DEF-398, DEF-399, DEF-406

**Status:** **S1 DONE (`d0ceb2c`), S1b DONE (`891bc1e`), S1c DONE (`f1fa09c`); S2 DONE (`94f38e2`; live-charge smoke MET 2026-10-01, DEF-386 closed); S3, S5, S6 DONE 2026-10-01 (overage → 7350 manager-confirmed; controlAccountNegative; allocator exact + last-owed day)** — APPROVED 2026-09-30 (orchestrator, after independent Opus review; 7 review changes applied). Spec by the Opus planner, 2026-09-30. Part of the money-defect push
(Ian, 2026-09-30: *"close all open money defects in v2"*), batch A of `docs/plans/money-defects-2026-09-30.md`.
**Model:** Sonnet for each slice, tester first and then builder. One lane runs the slices in order.
**Migration:** YES, exactly one: `0172_t366_def386_remittance_variance_posting.sql`, hand-authored per ADR-012 §5, in
slice S2. The highest migration at HEAD `3ed900f` is 0171. T-366 keeps 0172; T-368 (also drafted as 0172) takes the
next free index at build.
**Gate:** ⛔ Slice S4 is BLOCKED on Ian's Q1. Until he answers, the DEFAULT ships in S2: `resolveRemittanceVariance`
REFUSES every NEW `write_off` call (reversible, moves no money; existing `written_off` rows are untouched). Everything
else can start. Q2 and Q3 have defaults that ship unless Ian
rules otherwise.
**Line numbers** were checked at HEAD `3ed900f`. No BUILDER path is dirty there. The dirty files under `apps/erp/src`
belong to T-348, and this task touches none of them.

## Goal
Every figure the remittance and float modules show must be backed by the ledger and protected against concurrent
writers:
- a charged shortage creates the person's receivable;
- a recognised overage is other income;
- two concurrent handovers or payouts cannot both pass one cap;
- an overdrawn liability control account raises a finding instead of reading as settled.

## Census, verified at source (corrections marked ✎)
- **DEF-386 (+DEF-105). Confirmed.** `resolveRemittanceVariance` (`packages/domain/src/remittance/index.ts:428-475`)
  writes `status` and `chargedToPersonId` (`:451-457`) and returns. It never calls `postEntry`.
  - The file header states it outright: *"Nothing here posts to the ledger"* (`:17`).
  - `remittance_variances` has no link to a journal entry (`packages/db/schema/remittance.ts:190-238`).
  - The cash leg is posted without its counter-leg. `createMoneyTransfer` (`:325-333`) moves only what was handed
    over, so after a shortage the cashier account still shows money that is not in the drawer.
  - ✎ **The register's remedy has the overage leg wrong.** It says "Cr 7350 against the office account". The office
    already received the full cash through the transfer. The correcting entry is **Dr the cashier account / Cr
    7350**, and together with the transfer it nets to exactly `POSTING-PATTERNS.md` `remittance.overage` (Dr 1130
    10,080 / Cr 1110 10,000 / Cr 7350 80).
  - ✎ The resolution date is taken in UTC: `new Date().toISOString().slice(0, 10)` at `:456` and `:470`. Bible §6
    says business dates are Manila dates. Between 00:00 and 08:00 Manila this gives the wrong day. S2 fixes it.
- **DEF-374. Confirmed, and it covers three paths, not one** (register log row 2026-09-20).
  - `createRemittance`, through `transaction()` at `:94`. It reads `endDayReports` (`packages/db/src/repo/remittance.ts:57`)
    with no lock.
  - `distributeServiceCharge`, whose `floatBalance` cap is at `packages/domain/src/service-charge/index.ts:82`.
  - `payLiability`, whose `positionOf` cap is at `packages/domain/src/liabilities/index.ts:164-172`.
  - None of the three takes a lock, and all three run at READ COMMITTED.
- **DEF-398. Confirmed.** `Number()` comparisons in `allocate.ts`:
  - ✎ The comparisons are at `:65`, `:66`, `:68`, `:75` and `:88`. The register cites `:64,65,67`.
  - ✎ `compare()` is at `packages/core/src/money.ts:150`. `:146` is `isZero`.
- **DEF-399. Confirmed.** The two rulings are `allocateFifo` (`allocate.ts:52-59`, where the caller sorts) and
  `allocateOldestFirst` (`packages/domain/src/shared/allocate-oldest-first.ts:98`, which sorts itself). Neither file
  mentions the other.
- **DEF-406. Confirmed.** ✎ The register's line numbers are stale; the census's `:753` is right.
  - The idiom `if (balance < 0.005) continue;` appears at `findings.ts:753` (`serviceChargeFloatAgeing`, 2160 per
    store), `:1134` (`reimbursablePayableAgeing`, 2130 per employee) and `:1548` (`grniNotAtRest`, 2120 per store).
  - The other `< 0.005` sites (`:58, :86, :138, :559, :564`) use `Math.abs` and are not in this family.
  - There is still no detector for a negative balance.
- ✎ **NEW finding: `allocateFifo` can put the variance on the wrong date.**
  - It records the variance on the last day it TOUCHED, not the last date. If a handover exactly clears day 1 and
    day 2 is still owed, the shortage is recorded on day 1 (`allocate.ts:65,71,88`).
  - Bible row 144 says *"record shortage/overage on the last date"*.
  - Fixed in S6.
- ✎ **NEW finding: a variance can stay open forever.** If a later remittance settles a shortage's days in cash,
  the variance row stays `open` permanently. Row 216's second outcome, *"mark as remit when staff pays shortage by
  cash"*, is still unbuilt. Out of scope here; the orchestrator should log it as a DEF.

## Rulings (planner)
- **R1. The two postings. These were looked up in `POSTING-PATTERNS.md` §Remittance (`:967-1007`) and bible row
  216, not decided here.**
  - `remittance.shortage` charged to a person: **Dr 1230 Advances to employees (party employee = the person) / Cr
    the cashier money account.**
  - `remittance.overage`, which row 216(4) makes other income: **Dr the cashier money account / Cr 7350 Cash over
    and short.**
  - In v2 each is a SECOND entry beside the transfer, never merged into it. The till module refuses that merge for
    the same reason (`till/index.ts:262-265`), and DEF-386's remedy forbids it too.
  - The trap in `remittance.shortage` still applies: a CHARGED shortage never touches 7350.
- **R2. A charge completes the day (row 216(3): "charge … closes").** The charge also writes settlement rows so
  the days read `remitted`:
  - The rows go in `remittance_allocations` with a new `source = 'charge'`, under the variance's own remittance.
  - They are FIFO over the days that are still owed on or before that remittance's `remitted_on`.
  - Existing readers (`endDayReports` `settled`, `findings.ts:374`) already sum every allocation of a posted
    remittance, so they pick this up with no change.
  - Reversing the remittance drops these rows through the existing `status = 'posted'` filter.
- **R3. Variance entries are custody movements, not activity of the day.**
  - Their journal entries carry `source_type = 'remittance_variance'`.
  - That source type is excluded from cashier movement wherever `'transfer'` already is:
    - `repo/remittance.ts:81` and `:237`;
    - `findings.ts:369`.
  - The list lives in ONE exported constant so the three copies cannot drift.
  - Without this, a charge dated a trading day would reduce what that day owes, and the next remittance would read
    as over by the same amount.
- **R4. The amount charged is capped at what is still owed:** `min(|variance|, Σ owed of settleable days ≤
  remitted_on)`.
  - This matters when a later cash remittance has already covered part of the shortage.
  - If the cap is zero, the charge is refused.
  - Nobody is charged for money that has since arrived.
- **R5. The cashier account is named, never guessed.** It must be one of the variance's remittance's
  `from_money_account_id`s.
  - If there is exactly one distinct account, it is used by default.
  - If there are several, `fromMoneyAccountId` is required and the refusal names them.
  - A 1140 line carries `party_type 'money_account'`, using the same conditional as `payLiability`.
- **R6. The entry date** is `on`. The default is today in Manila (`toBusinessDate()` from `@shareat/core/datetime`).
  `on` must be on or after the remittance's `remitted_on`.
- **R7. Overage is recognised by a manager action.** `action: 'recognise_income'` posts R1's overage entry and sets
  a new status, `'income'`.
  - Default Q3: it is NOT posted automatically inside `createRemittance`.
  - `charge` and `write_off` are refused on a positive variance. `recognise_income` is refused on a negative one.
- **R8. DEF-105: one helper.** `postStaffShortageCharge` goes in a new
  `packages/domain/src/shared/staff-shortage-charge.ts`.
  - Both `chargeTillShortage` and the remittance charge call it.
  - The till's posted lines must stay byte-identical: same accounts, parties, source type, idempotency key and
    date. `till-custody.test.ts` is the regression guard.
- **R9. DEF-374: lock before reading the cap.**
  - The lock is taken immediately after `authorize()`. The T-364 rule puts authorisation first and says a
    non-holder takes no lock.
  - Two cases use a transaction-scoped advisory lock, `pg_advisory_xact_lock(<ns int4>, hashtext(storeId))`:
    - the store's cash custody: `createRemittance`, `resolveRemittanceVariance` and `reverseRemittance`;
    - the store's service-charge float: `distributeServiceCharge`.
  - `payLiability` locks the liability row: `select id from liabilities where org_id=… and id=… for update`.
  - `for update` on the store row is refused.
    - It conflicts with the `FOR KEY SHARE` that every FK insert naming the store takes.
    - Holding it would serialise every posting at that store behind a remittance.
    - The advisory lock blocks only other callers of the same lock.
  - Precedents: `organizations.ts:214` (advisory lock) and `ar.ts:335-341` (row lock before reading balances).
  - SERIALIZABLE is refused, per DEF-374's own remedy note.
- **R10. DEF-406: add a detector; leave the existing guards alone.**
  - The new finding is `controlAccountNegative`, over 2160 per store, 2130 per employee party and 2120 per store.
  - It fires when `sum(credit) - sum(debit) < 0`, compared in SQL `numeric`, not in JS floats.
  - The three ageing guards stay exactly as they are (register remedy: the early return answers its own question
    correctly).
  - Severity: 2160 is `hard`, because Ian's T-187 Q5 says the float is never negative. 2130 and 2120 are `soft`
    (Q2).
- **R11. DEF-399: document it, do not merge.** Each allocator's docstring names the other and says why the
  rulings differ. `allocateFifo` has a single date key that a query can express. T-330's order has three keys and a
  nullable fallback. This follows the register remedy: *"Do NOT merge the two allocators"*.

## Invariants (every slice)
- Bible §16.1 inv. 1: every entry has at least two lines and balances.
  - Inv. 4: every entry traces to its source (`source_type 'remittance_variance'`, `source_id = variance id`, and
    `remittance_variances.journal_entry_id`).
  - Inv. 5: corrections are reversals.
  - Inv. 7: `postEntry`'s period guard applies. A closed period refuses and nothing is written.
- Bible §6 and RULES rule 6: money comparisons go through `@shareat/core/money` (`compare`, `negate`, `isZero`). Bare
  `Number()` is not added in any file this task touches.
- Bible rows 128 and 144: a shortage is never charged to an inferred person.
- Row 154: the cashier-overdraft warning semantics are unchanged.
- Row 157: what a day owes is still derived from the ledger. No `expected` column is added.
- Row 216 is the authority on variance meaning, and it wins over the register's pre-decision text.
- Bible §13 row 214 (stale comments): every docstring a slice falsifies is rewritten in the same slice. This
  includes `remittance/index.ts:17-20`, the `resolveRemittanceVariance` docblock, `schema/remittance.ts`'s
  allocation-unique comment and `allocate.ts:52-58`.
- Each ✅ in the CAPABILITY-MATRIX (`accept_remittance`, `approve_expense`) has a test proving the ✗ fires, and the
  refusal leaves the ledger unchanged.

---

## S1: DEF-374, lock before reading the cap (foundation; S2 relies on it)
**BUILDER** (source):
- `packages/db/src/repo/advisory-locks.ts` (new). It contains:
  - `lockStoreCashCustody(tx, storeId)` and `lockServiceChargeFloat(tx, storeId)`;
  - a named int4 namespace constant for each, with a comment listing EVERY advisory key in the repo:
    - `organizations.ts:214`: `pg_advisory_xact_lock(232002)` (single bigint);
    - `access.ts:166`: `pg_advisory_xact_lock(hashtext(orgId))` (single bigint);
    - migration `0160:157`: `pg_advisory_xact_lock(hashtextextended('fiscal_periods:' || org_id, 0))` (single bigint);
    - the new two-int4 form is a SEPARATE key space (`pg_locks.objsubid` 2 vs 1), so it never collides with those;
    - a `hashtext(storeId)` collision only serialises two stores; it never gives a wrong answer (as `access.ts:163`).
- `packages/db/src/index.ts`, to export it.
- `packages/db/src/repo/liabilities.ts`, adding `lockForPayment(tx, orgId, liabilityId)`.
- `packages/domain/src/remittance/index.ts`:
  - `runCreate` locks after `:103`;
  - `reverseRemittance` locks after `:395`, then RE-READS the remittance's status and the variance's
    `journal_entry_id` after the lock. The `:399` status check and any variance lookup made before the lock are
    stale: two reversals would both pass `'posted'`, and a charge committing while a reversal waits would leave its
    1230 entry unreversed;
  - `resolveRemittanceVariance` locks after `:442`.
- `packages/domain/src/service-charge/index.ts`, which locks after `:44`.
- `packages/domain/src/liabilities/index.ts`, which locks after `authorize` at `:159` and before `positionOf` at
  `:164`.

**TESTER:** `packages/domain/tests/integration/t366-s1-cash-custody-locks.test.ts` (new).

**Contract:**
- Each of the three paths takes its lock after `authorize` and before its first cap read.
- A second caller for the same key blocks until the first commits, then reads the committed state.
- Different keys (another store, another liability) never block each other.

**Tests.** Two real connections against real Postgres. They must be deterministic, not a `Promise.all` race; the
register records that `ap.test.ts:712-724` passed without its lock.
- Harness:
  - Tx A runs the operation inside `asOrg(…, async tx => { await op(tx); await gate; })`.
  - Tx B then starts the competing operation.
  - A third connection polls `pg_stat_activity` until B's backend is WAITING (up to 5 s), **or** B settles.
    WAITING means `wait_event_type = 'Lock'` AND `wait_event = 'advisory'` for T1 and T2, and
    `wait_event_type = 'Lock'` AND `wait_event in ('transactionid', 'tuple')` for T3 (the row lock).
  - Every paying money account is funded with at least ₱1,300.00, so `checkDraw` never refuses B in the mutant run;
    the only thing that can stop B is the cap.
  - The gate then releases A.
  - If B settled before it was ever seen waiting, the test fails with *"B never waited: no lock"*.
- **T1 createRemittance.** A day owes 10,000.00 and A and B each hand over 6,000.00 with no declared overage.
  - Exactly one is fulfilled.
  - The other is rejected with the check-2 message (`/settleable days owe only/`).
  - Σ `remittance_allocations.amount` for the date is **6,000.00**, all from the winner. The day owes 4,000.00
    afterwards (`endDayReports`), and there is exactly one `remittances` row.
  - Mutant: remove the lock call. Both are fulfilled, allocations total 12,000.00, and the test goes red.
- **T2 distributeServiceCharge.** The float is 1,000.00. A pays 700.00 on payday P1 and B pays 600.00 on payday P2
  (different idempotency keys).
  - Exactly one is fulfilled; the other gets the cap message.
  - The 2160 balance for the store is exactly **300.00** or **400.00** (the winner's residual), never negative.
  - Mutant: remove the lock. The balance is −300.00 and the test goes red.
- **T3 payLiability.** Outstanding is 1,000.00. A pays 700.00 and B pays 600.00.
  - Exactly one wins, and outstanding is 300.00 or 400.00.
  - Mutant: remove the lock. Outstanding is −300.00 and the test goes red.
- **Positive controls.**
  - T1 and T2 run at two DIFFERENT stores, and T3 on two different liabilities. Both are fulfilled, and B is
    **never** seen waiting. This proves the lock is scoped, not global.
    - Mutant: a fixed global key makes B wait, and the test goes red.
  - A single uncontended call still succeeds with the same figures as today.
- **T4: charge vs reversal** (needs S2; the tester adds it to this file when S2 lands).
  - A holds a charge of a −150.00 variance open; B reverses the same remittance. B waits (advisory), re-reads, and
    reverses the transfers AND the charge entry: the person's 1230 balance is **0.00** and exactly one reversal of
    the charge entry exists.
  - Reverse order (A reverses, B charges): B is refused (the remittance is not posted), and nothing is written.
  - Two concurrent reversals: exactly one succeeds, the other is refused as already reversed, and each transfer has
    exactly one reversal entry.
  - Mutant: status or `journal_entry_id` read before the lock → 1230 stays 150.00, or two reversals → red.
- **Refusal.** A non-holder of `accept_remittance` (staff) calls `createRemittance` while A holds the lock. The
  non-holder is refused at once, without waiting, because authorisation runs first. The assertion is that it
  settled while A was still gated.

**Smoke:** none of its own; the S2 smoke exercises the locked paths.

---

## S2: DEF-386 (+DEF-105), charging a shortage posts the receivable and completes the day
**BUILDER** (source):
- `packages/db/migrations/0172_t366_def386_remittance_variance_posting.sql` (new).
- `packages/db/migrations/meta/_journal.json`: idx 172, `when` = 1800847907084 + 86,400,000.
- `packages/db/schema/remittance.ts`.
- `packages/db/src/repo/remittance.ts`, adding:
  - a `CUSTODY_SOURCE_TYPES` constant, used at `:81` and `:237`;
  - `insertAllocation` taking `source`;
  - `allocationsFor` selecting `source`;
  - `resolveVariance` taking `journalEntryId` and the `'income'` status;
  - a `fromAccountsFor(remittanceId)` read.
- `packages/db/src/repo/findings.ts`, `:369` only, to use the constant.
- `packages/domain/src/shared/staff-shortage-charge.ts` (new). The helper takes the CREDIT line's party (or none)
  from the caller and never derives one.
- `packages/domain/src/till/index.ts`: `chargeTillShortage` calls the helper passing NO credit-line party (HEAD's
  credit line at `till/index.ts:328-332` carries none), so its posted lines are unchanged.
- `packages/domain/src/remittance/index.ts`: charge posting, capping, settlement, the Manila date, reversal of the
  variance entry, and the rewritten header and docblock.
- `apps/erp/src/app/remittance/actions.ts` and `apps/erp/src/app/remittance/page.tsx`:
  - an account picker, shown only when a remittance has more than one from-account;
  - `charge` shown only for a negative variance.
- `docs/POSTING-PATTERNS.md`: one paragraph under `remittance.shortage` saying that in v2 the charge is a second
  entry and the net is identical. Then run `npm run toc` and the unit suite (DEF-389).

**TESTER:**
- `packages/domain/tests/integration/t366-s2-variance-charge.test.ts` (new).
- `packages/db/tests/integration/t366-0172-migration.test.ts` (new).
- `packages/domain/tests/integration/t366-s2-till-charge-regression.test.ts` (new; C9).
- `packages/domain/tests/integration/remittance.test.ts`, only for assertions that encode DEF-386's defect. Each
  edit carries a comment citing T-366.

**Migration 0172** (header names T-366/DEF-386 and this section):
- `remittance_allocations`:
  - add `source text not null default 'cash'` with `CHECK (source in ('cash','charge'))`;
  - `remittance_allocations_unique` is a unique INDEX (`schema/remittance.ts:167`), not a constraint:
    `DROP INDEX "remittance_allocations_unique"`, then `CREATE UNIQUE INDEX "remittance_allocations_unique" ON
    "remittance_allocations" (remittance_id, business_date, source)`. The schema's `uniqueIndex(...)` gains
    `t.source`.
- `remittance_variances`:
  - add `journal_entry_id uuid references journal_entries(id) on delete restrict`, plus an index on it;
  - recreate `remittance_variances_status_check` with `'income'` added, and add `'income'` to `VARIANCE_STATUSES`
    in the schema file;
  - recreate `remittance_variances_resolution_shape_check` with this additional arm:
    `(status='income' and charged_to_person_id is null and resolved_by is not null)`.
- Add, **NOT VALID** (the smoke DB may hold legacy `charged` rows with no entry):
  - `remittance_variances_sign_check`: `(status <> 'income' or amount > 0) and (status <> 'charged' or amount < 0)`;
  - `remittance_variances_posting_check`:
    `(status='open' and journal_entry_id is null) or (status in ('charged','income') and journal_entry_id is not null) or status='written_off'`.
  - In the schema file, write `// NOTE: … NOT VALID, hand-added in migration 0172` beside each.
- No new table, so the classification and RLS registries are unchanged. Confirm that the existing UPDATE grant on
  `remittance_variances` covers the new column.
- Prove it on a scratch DB (ADR-012 §5.8).

**Contract.** `resolveRemittanceVariance(tx, actor, { varianceId, action: 'charge', personId, fromMoneyAccountId?,
reason?, on? })` does the following, in order:
1. Read the variance and its store.
2. `authorize(accept_remittance)`.
3. Take `lockStoreCashCustody`.
4. Re-read the variance. Refuse unless it is `open`, `amount < 0`, and its remittance is `posted`.
5. Validate `personId`, `on` (R6) and the account (R5).
6. Compute the chargeable amount (R4). Refuse `"…has since been remitted in cash — nothing is left to charge"` if it
   is zero.
7. Use `allocateFifo(owedDays, chargeable)` to insert allocation rows with `source 'charge'`.
8. Post through `postStaffShortageCharge`:
   - `sourceType 'remittance_variance'`, `sourceId = varianceId`;
   - `idempotencyKey 'remittance-variance:<id>:charge'`;
   - `entryDate on`;
   - lines Dr 1230 {employee, personId} and Cr {cashier account, party per R5}.
9. Update the variance (`where status='open'`) to `charged`, with the person, `journal_entry_id`, `resolved_by`, and
   `resolved_on = on`.

Any throw means nothing is written; this is one transaction. `reverseRemittance` reverses the variance's journal
entry, when there is one, through `reverseEntry` before `markReversed`.

**Tests.** Red legs assert the TARGET values.
- **C1: Ian's shape.** Day D (verified) moved 10,000.00, and 9,850.00 was remitted from the till, giving variance
  −150.00. The variance is charged to P on D+1.
  - Exactly ONE `remittance_variance` entry, dated D+1, with exactly 2 lines:
    - `1230` debit **150.00**, `party_type 'employee'`, `party_id P`, store S;
    - `1110` credit **150.00**, no party, store S.
  - The variance is `charged` with `journal_entry_id` equal to that entry.
  - The 1230 balance for P is **150.00**.
  - The 1110 balance for store S is **0.00**.
  - `endDayReports`: D has allocated **10,000.00** and owed **0.00**; `remittanceStateOf` is `remitted`. There is
    no report row for D+1.
  - The allocations are {D, cash, 9,850.00} and {D, charge, 150.00}.
  - The net of the transfer and the charge equals `remittance.shortage` exactly: Dr 1130 9,850 · Dr 1230 150 · Cr
    1110 10,000.
  - Mutants C1 must kill:
    - posting nothing (HEAD);
    - crediting 1130;
    - debiting 7350;
    - no settlement rows, which leaves D owing 150;
    - no source-type exclusion, which makes D+1 owe −150 or reduces D+1's owed.
- **C2: partial cash after the shortage.** A second remittance of 100.00 goes to D, then the charge is made.
  - The entry is **50.00**, the 1230 balance for P is **50.00**, D owes 0.00, and the charge allocation is 50.00.
  - Mutant: charging the full |variance| gives 1230 = 150 and D allocated 10,050, and the test goes red.
  - The second (100.00) remittance creates its OWN −50.00 open variance. After the charge above, charging that
    second variance is refused (cap zero: D owes 0.00), and nothing is written.
- **C3: fully paid in cash.** A second remittance of 150.00 is made, then a charge is attempted.
  - It is refused, and the ledger and allocation snapshot is unchanged.
  - Positive control: C1.
- **C4: two accounts.** The remittance has a till line and a wallet line, both short.
  - A charge without `fromMoneyAccountId` is refused, and the message names both accounts.
  - With the wallet: Cr **1140** with `party_type 'money_account'` = the wallet id.
  - An account not on the remittance is refused.
  - Positive control: with one from-account, no id is needed (C1).
- **C5: refusals leave nothing written.** Each is paired with its success control in the same test.
  - Staff (✗ `accept_remittance`) is refused; the manager (✅) succeeds.
  - An already-charged variance is refused and there is still exactly one entry. Two sequential calls are made; the
    first succeeds.
  - A positive variance is refused for `charge`.
  - An empty `personId` is refused.
  - A NEW `write_off` call is refused (the Gate default until Q1), and nothing is written; an existing `written_off`
    row is untouched. Positive control: `charge` on the same variance succeeds.
  - `on` earlier than `remitted_on` is refused.
  - `on` in a closed period is refused by `postEntry`. The variance stays `open` and no charge allocation exists.
- **C6: reversal.** The remittance is reversed after the charge.
  - A reversal entry for the charge exists.
  - The 1230 balance for P is **0.00**, the 1110 balance is back to **10,000.00**, and D owes **10,000.00**.
  - Mutant: reversing without the variance entry leaves 1230 at 150, and the test goes red.
- **C7: Manila date.** A fake clock is set to `2026-01-06T17:30:00Z`, with no `on` given. The `entry_date` and
  `resolved_on` are **2026-01-07**. Mutant: the UTC slice gives 01-06, and the test goes red.
- **C8: charge and a cash remittance for the same shortage, two ordered cases** (sequential, both under S1's lock):
  - **Charge first:** the charge posts **150.00** (1230 = 150.00, D owes 0.00). Then a 150.00 remittance for D is
    refused (no settleable day, nothing to settle), and nothing is written.
  - **Remittance first:** a 150.00 remittance settles D (D owes 0.00). Then the charge is refused (cap zero, nothing
    is left to charge), and 1230 = 0.00.
  - Mutant: no R4 cap → the second case's charge posts 150.00 and D is allocated 10,150.00 → red.
- **C9: DEF-105 regression** (`t366-s2-till-charge-regression.test.ts`). `till-custody.test.ts` and the existing
  till-shortage tests pass unchanged. The tester adds one assertion that the till entry's lines, key and source type match the HEAD values it captured before the
  build.
- **Migration test.** On a scratch DB:
  - a `charged` row with a positive amount is refused;
  - an `income` row with no `journal_entry_id` is refused;
  - two `cash` allocations for one (remittance, date) are refused, while a `cash` and a `charge` allocation for the
    same pair are accepted;
  - a pre-existing legacy `charged` row with no entry survives the migration (NOT VALID).

**Smoke** (`http://localhost:9008`; the smoke DB's periods for Jan 2026 to Jan 2027 are CLOSED, so use **2027-02**
dates):
1. Verify a sales day for 2027-02-03 at a store.
2. On `/remittance`, remit ₱150 short from the till.
3. Charge the variance to a person on 2027-02-04.
4. Confirm that the entry shows Dr 1230 (the person) / Cr 1110 ₱150, that the day reads fully remitted, and that
   2027-02-04 shows nothing owed.
5. Screenshot the picker on a two-account remittance.

---

## S3: DEF-386, the overage half. `recognise_income` posts 7350 (closes DEF-380's posting half)
**BUILDER:**
- `packages/domain/src/remittance/index.ts`: the `recognise_income` action; refusing `charge`/`write_off` on a
  positive variance.
- `apps/erp/src/app/remittance/actions.ts` and `page.tsx`: a positive variance shows only "Recognise as other
  income (7350)".

**TESTER:** `packages/domain/tests/integration/t366-s3-overage-income.test.ts` (new).

**Contract.** `action: 'recognise_income'`, with an optional `fromMoneyAccountId` and `on`:
- Authorise first, then lock (S1).
- Refuse unless the variance is `open` and `amount > 0`.
- The account follows R5 and the date follows R6.
- Post Dr {cashier account} / Cr 7350 for the amount, with `sourceType 'remittance_variance'` and key
  `'remittance-variance:<id>:income'`.
- Set the status to `income` with `journal_entry_id`.
- There are no settlement rows, because the days were already fully allocated.

**Tests.**
- **O1.** Owed is 10,000.00. 10,080.00 is remitted from the till with declared overage 80. `recognise_income` is
  called.
  - One entry: `1110` debit **80.00** and `7350` credit **80.00**, with no party on either line.
  - The status is `income`.
  - The 1110 balance is **0.00**, not −80.
  - The net with the transfer equals `remittance.overage`: Dr 1130 10,080 · Cr 1110 10,000 · Cr 7350 80.
  - `endDayReports` shows no new owed row on the entry date.
  - Mutants O1 must kill: debiting 1130 (1110 stays −80); crediting any account other than 7350; not excluding the
    source type (the entry date then owes 80).
- **O2: refusals with controls.**
  - `charge` and `write_off` on a positive variance are refused and nothing is written; `recognise_income` on the
    same row succeeds.
  - `recognise_income` on a negative variance is refused; `charge` on it succeeds.
  - Staff is refused and the manager succeeds.
  - A second `recognise_income` is refused, and there is still exactly one entry.
- **O3: exact remittance** (the "neither leg" control). There is no variance row and no `remittance_variance` entry.
- **O4.** Reversing the remittance reverses the 7350 entry. The 7350 balance is **0.00** and the 1110 balance is
  back to 10,000.00.

**Smoke:** on 2027-02-05, remit ₱80 over with the overage declared, click "Recognise as other income", and see
Cr 7350 ₱80. Screenshot the section: it shows no "Charge" control.

---

### S3 review record (orchestrator, 2026-10-01)
Contract-complete (auditor JOBs 8, 10, 11). Changes beyond the spec, all orchestrator rulings: (a) the Charge and Recognise controls render only where the viewer holds `accept_remittance` at that store (the T-367 rule: never show a control the caller cannot use); (b) the variance list follows the page's store picker; (c) **the unresolved COUNT stays org-wide** ("N here · M more at other stores") — bible row 147, a count must be visible, and (b) had scoped it away; (d) an unknown action gets a plain domain refusal. POSTING-PATTERNS `remittance.overage` rewritten as two entries. Open for Ian: may the manager who took the handover confirm its overage (Open Questions page)?

## S4: the `write_off` posting. ⛔ BLOCKED on Q1
Until Q1 is answered, S2 ships the default: new `write_off` calls are REFUSED (reversible, moves no money; existing
`written_off` rows are untouched). This is the unresolved half of DEF-386. Once Ian answers, the planner amends this slice. The likely shape, if he keeps it
as a loss, is Dr 7350 / Cr the cashier account, plus settlement rows with `source 'write_off'`. That would need a
second migration to widen the CHECK.

---

## S5: DEF-406, the `controlAccountNegative` detector
**BUILDER:**
- `packages/db/src/repo/findings.ts`: the new `controlAccountNegative` function. The three ageing guards are
  untouched.
- `packages/domain/src/findings/index.ts`: register the detector in `listFindings`, beside `:216`.
- `apps/erp/src/app/findings/lib.ts`: a `KIND_LABEL` entry reading "Control account below zero".

**TESTER:** `packages/domain/tests/integration/t366-s5-negative-control.test.ts` (new).

**Contract:**
- One SQL statement per account family, grouped by store (2160, 2120) or by employee party (2130), using
  `having sum(credit) - sum(debit) < 0` in numeric.
- It emits `{ kind: 'controlAccountNegative', key: 'controlAccountNegative:<code>:<group id>', storeId (null for
  2130), severity }`.
- The detail names the account, the store or employee, and the exact negative figure formatted with
  `formatMoney`.

**Tests:**
- **N1.** 2160 at store S is driven to −200.00 by a posted entry.
  - Exactly one finding: severity `hard`, `storeId` S, and the detail contains "₱200.00".
  - `closeReadiness(period).ready` is `false`.
  - Mutants: the `< 0.005` idiom, and `balance > 0`.
- **N2.** The same for 2130 for employee E (`soft`, key includes E) and for 2120 at store S (`soft`).
- **Positive controls:**
  - At exactly 0.00 there is no finding (mutant: `<= 0`).
  - At a positive balance there is no `controlAccountNegative` finding.
  - Two stores, one negative: exactly one finding, for the right store.
- **N3.** At −200.00, `serviceChargeFloatAgeing` is still silent. This pins R10: the detector was added and the
  guard was not edited.

**Smoke:** `/findings` renders the new label. If no UI path can drive a control account negative in the smoke DB,
say so in the report and rely on N1 and N2. Do not write SQL to the smoke DB.

---

## S6: DEF-398 and DEF-399, allocator arithmetic and rulings
**BUILDER:**
- `packages/domain/src/remittance/allocate.ts`:
  - `compare`, `isZero` and `add` replace every `Number()` at `:65,:66,:68,:75,:88`;
  - `varianceDayId` becomes the last day with owed > 0 (row 144);
  - the docstring names `allocateOldestFirst` and the R11 reason.
- `packages/domain/src/shared/allocate-oldest-first.ts`: the docstring only, a reciprocal pointer.

**TESTER:** `packages/domain/tests/unit/t366-s6-allocate.test.ts` (new).

**Tests:**
- **A1.** Days `[d1 owed 1000.00, d2 owed 500.00]`, handed over 1000.00: `varianceDayId` is **d2** and the variance
  is −500.00. HEAD gives d1, so this is red.
- **A2 (control).** Handed over 1200.00: allocations d1 1000.00 and d2 200.00, variance −300.00 on d2. This matches
  HEAD, which shows the change is limited to the boundary.
- **A3.** Handed over 1600.00: variance +100.00 on d2.
- **A4.** A days list with a zero-owed day between two owed days: that day is skipped.
- **A5.** A source ratchet: `allocate.ts` contains no `Number(`. This is the honest instrument for DEF-398, whose
  comparisons are exact at 2dp, so no value-based red leg exists. It is stated as such.
- The existing `remittance.test.ts` worked example still passes, with ₱4,000 short on day 5.

---

## Out of scope
- The UI wording of DEF-380 beyond the controls above.
- Row 216's "staff pays the shortage in cash" path (the new finding in the Census; the orchestrator logs a DEF).
- DEF-099, recovering 1230 through payroll.
- DEF-357, DEF-375 (glossary terms) and DEF-407.
- NaN in `payLiability`'s `Number(input.amount)` (T-371).
- The ETL's v1 remittance legs.
- Any change to `allocateOldestFirst`'s behaviour.
- Bible amendments. The orchestrator or planner adds a §13 row at approval recording R2, R3, R7 and R9.

## Done when
- S1, S2, S3, S5 and S6 are green.
- Each red leg was shown red against HEAD, or against its named mutant, before the build.
- Typecheck is clean, the unit suite passes (including `toc-freshness`), and the FULL integration suite passes
  before push.
- Migration 0172 applies from zero and on a scratch copy.
- The S2 and S3 smoke was run on 9008 with 2027-02 dates and screenshots.
- `npm run build` passes with the dev server stopped.
- The register rows are updated at wrap-up:
  - DEF-386, DEF-105, DEF-374, DEF-398, DEF-399 and DEF-406 are fixed, with commit hashes;
  - DEF-386's overage remedy is corrected;
  - DEF-406's line numbers are corrected;
  - DEF-380's posting half is noted;
  - S4 is left open on Q1.

## Questions only Ian can answer
- **Q1: should `write_off` exist? (Blocks S4. Bible row 216 leaves this open.)** v1 has no write-off; every
  shortage was charged. The options are:
  - (a) keep it, posting the loss Dr 7350 / Cr cashier;
  - (b) retire it, so a shortage can only be charged or paid in cash.
  - Note that `POSTING-PATTERNS` says a *charged* shortage never touches 7350; nothing there covers a forgiven one.
- **Q2: should a negative 2130 (reimbursements owed to staff) or 2120 (goods received, not yet invoiced) block the
  month-end close?** The default is no (`soft`). 2160 blocks, following your T-187 ruling.
- **Q3: should an overage become other income automatically at handover, or only when a manager confirms it?** The
  default is manager-confirmed (R7). The reason: under T-324, a declared overage is often the cash of a day not yet
  verified. Once that day verifies, the same money would count as both sales and 7350 income, and the day would then
  show short. Confirming by hand lets a manager reverse and redo the remittance instead. Row 216 says an overage is
  income; it does not say when.

## Amendment A1 — Ian's answers (2026-09-30, orchestrator)
- **Q1 → NO write-off.** A shortage is always charged to staff. S4 becomes: retire `write_off` — the domain refuses it
  permanently (the interim refusal becomes the rule), the UI stops offering it, and a finding lists any existing
  `written_off` rows for a person to charge; nothing is re-posted automatically. Red leg: write_off refused with the
  plain sentence; positive control: charge still works.
- **Q3 → manager confirms** (the spec's default) — S3 stands.
- **Q2 → (a)** (Ian, 2026-09-30): a negative 2120 or 2130 is a finding, not a close blocker; only 2160 blocks. S5 as written.

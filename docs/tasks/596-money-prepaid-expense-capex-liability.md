# T-596 — Money fixes: prepaid write-off, expense void, CAPEX below threshold, liability reversal

Status: SPEC (Opus planner), 2026-11-18. Fixes DEF-882, 883, 884 (PR A, prepaid) and DEF-890, 891, 892, 893 (PR B).
Main at `9892641`. Risk: **high** (money). Builders: Sonnet. No migration. No new domain export.
⚠️ None of these DEF numbers is in `docs/DEFECTS-REGISTER.md` on main yet. **The builder adds them** (ruling R4).

## Rulings (BOSS, 18 Nov)
- **R1 DEF-891 = option A.** Below-threshold CAPEX goes to 6510 Smallwares at approval. Already decided in T-124 and
  matches v1, so no new ruling from Ian. Correcting existing rows is OUT of scope; the count query stays, for BOSS to
  run after Ian approves a production read.
- **R2 DEF-894** = the `entriesForPeriod` bracket bug (F1). Fix stays in slice A1, with a register row.
- **R3 DEF-892's message names only an action that exists.** Nothing reverses a disposal (no screen, no domain function:
  `fixed-assets/*.ts` has only `disposeAsset`), so the refusal is the plain sentence below, recorded as a known limit.
- **R4 the builder adds register rows** for DEF-882, 883, 884, 890, 891, 892, 893, 894 in `docs/DEFECTS-REGISTER.md`
  section E (table at `:124`, columns `# | Sev | Defect | State | Disposition`; Sev ⛔ for all but DEF-894 🔸;
  State `✅ fixed` with the PR number, Disposition "T-596"). PR A adds 882-884 and 894; PR B adds 890-893.

## Partial work found (builders started, then stopped) — KEEP, with the gaps below

| Worktree (branch `worktree-agent-…`) | Diff | Verdict |
|---|---|---|
| `.claude/worktrees/agent-a839801399e5b4ea6` | `repo/prepaid.ts` +`writeOffEntries`, `nextWriteOffKey`; `prepaid/index.ts` locks in amortise, reverse, write-off, undo; DEF-884 refusal; revision key | **Keep all.** Add: parentheses in the new WHERE (F1), page change, tests. |
| `.claude/worktrees/agent-a369c829a597d31b6` | `expenses/void.ts` DEF-890 + DEF-892 guards; `liabilities/index.ts` DEF-893 guard | **Keep, fix 3 gaps:** DEF-892 reads the asset WITHOUT its lock (race with `disposeAsset`); payee locks not sorted; DEF-892 sentence points to an undo that does not exist. No DEF-891 work, no tests. |

Each worktree is on its own branch off `9892641`; continue there (no fresh worktree, no `--force` removal ever).

## F1 = DEF-894 — a finding the partial work copied (fix in A1)
`packages/db/src/repo/prepaid.ts:362` (`entriesForPeriod`):
```ts
sql`${journalEntries.idempotencyKey} = ${base} or ${journalEntries.idempotencyKey} like ${base + '#%'}`,
```
Drizzle `and()` wraps the whole list in one pair of brackets, not each condition
(`node_modules/drizzle-orm/sql/expressions/conditions.js:36-40`), so this reads
`(org_id = $1 and key = $2 or key like $3)`: the LIKE arm skips the org filter. RLS and the item uuid in the key
make it harmless today. Fix: wrap the raw SQL in `( … )` here and in the new `writeOffEntries`. Only occurrence in
`packages/db/src` (grep `= ${…} or `).

---

## PR A — prepaid (`packages/domain/src/prepaid/index.ts`, `packages/db/src/repo/prepaid.ts`)

**Lock rule for every prepaid writer:** `prepaidRepo.lockItemRow(tx, orgId, itemId)` (`repo/prepaid.ts:111`, `SELECT … FOR UPDATE`)
is the FIRST statement after `authorize()` and the reason check, BEFORE `getById`. Read Committed re-reads after the wait,
so the loser sees the winner's status and ledger. Same lock `bookMissedMonth` already takes (`missed-months/index.ts:146`).
No prepaid path takes any other row lock first, so there is no ordering cycle.

### DEF-882 — write-off after an undo posts nothing (confirmed on main)
`prepaid/index.ts:477-493`:
```ts
const result = await postEntry(tx, { ...
  idempotencyKey: `prepaid:${item.id}:write-off`,
await prepaidRepo.markStatus(tx, actor.orgId, item.id, { status: 'written_off', ...
```
Write off → `undoWriteOff` reverses the entry → write off again: `postEntry` finds the reversed entry (`created:false`),
status still becomes `written_off`, 1400 keeps the balance. **Reachable today only from code**: `undoWriteOff` is UNWIRED
(`tests/unit/domain-actions-have-callers.test.ts:248`). Fix it now; wiring the undo is out of scope.
Change (already in partial): `repo/prepaid.ts` after `nextRevisionKey` (~382): `writeOffEntries(tx, orgId, itemId)` (all
entries with key `prepaid:{id}:write-off` or `…#%`, any status, oldest first; WHERE bracketed per F1) and
`nextWriteOffKey(itemId, existing)` (plain key first, then `#2`, `#3`). In `runWriteOff` call both before `postEntry`.

### DEF-883 — amortise and write-off race (confirmed)
`amortiseItemCore` (`:230`) and `runWriteOff` (`:405`) read status and `amortisedFromLedger` with no lock. Write-off
credits "remaining" while a month posts: 1400 is credited past the item's cost. Add `lockItemRow` in `amortiseItemCore`
before `:230` (covers the screen AND `runAmortisationAsSystem`), `runWriteOff` before `:405`, `reverseAmortisation`
before `:334`, `undoWriteOff` before `:515`.

### DEF-884 — month reversal on a written-off item (confirmed)
`reverseAmortisation` `:334-338` goes straight from `getById` to `activeEntryForPeriod`; no status check. After a
write-off the month's cost is already inside the write-off, so reversing it debits 1400 back above zero. Add after
`:337`:
```ts
if (item.status === 'written_off') throw refuse(
  `reverseAmortisation: ${item.name} is written off.`,
  `${item.name} has been written off. Undo the write-off first, then reverse the month.`);
```
Page `apps/erp/src/app/prepaid/[id]/page.tsx:214`: `{p.posted && (` → `{p.posted && item.status !== 'written_off' && (`
so the button is not offered. Action `apps/erp/src/app/prepaid/actions.ts:114` needs no change (`errorMessage` shows
`refuse()` text).

### PR A tests — new `packages/domain/tests/integration/t596-prepaid-write-off.test.ts`
Copy `fixture()`, `policy()`, `netOf()`, `asOrg()` from `prepaid.test.ts`; copy `runConcurrencyLeg` + `ROW_LOCK`
from `t366-s1b-liability-reverse-retire-locks.test.ts:141-184`. Assert the item's own 1400 movement: sum of
(credit − debit) on 1400 for entries with `source_id = item.id` and source type `amortisation`/`prepaid_write_off`.
1. `DEF-882 write off, undo, write off again posts a second entry` — second call `created` entry id differs from the
   first; item's 1400 credits = total cost; status `written_off`; key ends `#2`. Mutant: fixed key → equal ids, red.
2. `DEF-882 a third cycle uses #3` (undo again, write off again).
3. `DEF-883 write-off holding the lock makes amortise wait, then amortise posts nothing` — A = write-off (held),
   B = amortise through a later month; `bWaited` true; B `posted: []`; credits = cost. Mutant: drop the lock in
   `amortiseItemCore` → `bWaited` false, red.
4. `DEF-883 amortise holding the lock makes write-off wait, remaining is re-read` — A = amortise, B = write-off;
   credits = cost exactly. Mutant: drop the lock in `runWriteOff` → credits = cost + one month, red.
5. `DEF-884 reversing a month on a written-off item is refused` — sentence matches `/Undo the write-off first/`,
   no new journal entry. Positive: same month reverses fine after `undoWriteOff`. Mutant: delete the check → red.
6. Web: extend `apps/erp/tests/integration/t343-s5-5p-followups.test.ts` only if it renders `/prepaid/[id]`;
   otherwise skip (the page change is one condition, covered by smoketest).

---

## PR B — expense void, CAPEX, liabilities

### DEF-890 — a reimbursed expense can be voided (confirmed)
`packages/domain/src/expenses/void.ts:83-89` refuses only for posted AP allocations:
```ts
const postedAllocated = money(await apRepo.postedAllocatedFor(tx, actor.orgId, expenseId));
if (compare(postedAllocated, ZERO) > 0) { throw refuse( ...
```
2130 is a pooled balance per employee per store; `payReimbursement` (`expenses/reimbursement.ts:109,170`) pays against
`expensesRepo.reimbursablePayableOf(tx, org, employeeId, storeId)` under `advisoryLocksRepo.lockReimbursementPayee`.
Rule: refuse when this expense's 2130 credit for a person at a store is more than what is still owed to that person at
that store. Partial code (after `:99`, skipped when `expense.status === 'voided'` so a replay stays a no-op) is right;
change: collect employee ids, **sort them**, lock each, then read. Sentence (keep the partial's):
"{expense} has already been paid back to {name} as a reimbursement. Void the reimbursement payment first, then void the
expense." (There is no reimbursement-void yet; open question Q2.)

### DEF-892 — voiding a CAPEX expense whose asset is disposed credits 1510 twice (confirmed)
`fixed-assets/capitalize.ts:326-334`: `retireAssetFromVoidedExpense` returns early when the asset is not `active`, but
`voidExpense` has already reversed the expense entry (CR 1510); `disposeAsset` (`dispose.ts:153`) already credited cost.
Fix in `void.ts`, same block as DEF-890, BEFORE it: `found = fixedAssetsRepo.findBySourceExpense(...)`;
`asset = found && await fixedAssetsRepo.getByIdForUpdate(tx, org, found.id)` (the lock `disposeAsset` takes, so a
disposal in flight is waited for); if `asset.status === 'disposed'` refuse with exactly (R3):
"This asset was already disposed, so this bill can't be voided."
**Known limit:** nothing reverses a disposal, so such a bill can never be voided from the app.
**Lock order in `voidExpense`:** expense row (`:72`, existing) → asset row (new) → payee advisory locks, sorted (new) →
cash-request rows (`:116`, existing). No other path takes these in another order (`disposeAsset`, `depreciate` lock the
asset only; `payReimbursement` the advisory only; `voidInvoice` `ap/index.ts:944` holds expense rows first).

### DEF-891 — CAPEX below the threshold lands in 1510 with no register row (confirmed) — RULED A (R1)
Today: the seeded category `Capital Expenditure` → `1510` (`packages/db/seed/expense-categories.ts:107`);
`approve.ts:273-277` routes `categoryAccountCode: category!.accountCode`; `capitalize.ts:259-261` then returns
`below_threshold` with no asset. A ₱4,999 purchase sits in 1510 forever, never depreciated, on no walk-round list.
- **T-124 says** (§9, `docs/tasks/124-…md:163-180`): one ₱5,000 threshold; below it the item "is expensed on the day it is
  bought". The chart seeds `6510 Smallwares` as "below-threshold half of the CAPEX/OPEX split" (`chart-of-accounts.ts:389`).
- **v1 does** (`ERP-rebuild/src/lib/actions/expense.actions.ts:266-271,346`): below-threshold CAPEX is re-stamped OPEX
  and hits the P&L at once; an entry flag `capitalizesToAsset` forces capitalisation at any cost.

| Option | What it changes for the books |
|---|---|
| **A. Route to 6510 at approval (RULED, R1)** | Below-threshold CAPEX posts DR 6510 / CR funding. P&L takes it the day it is bought, as T-124 and v1 do. 1510 holds only registered assets. |
| B. Refuse below-threshold CAPEX | Nothing wrong posts; staff must re-pick "Smallwares". More friction, same books as A. |
| C. Register every CAPEX regardless of cost | Every ₱300 tong becomes a depreciating asset and a walk-round row; contradicts the threshold. |

Build A. In `approve.ts` gather (after `:214`): if `category?.group === 'CAPEX'`, `policy = await readPolicyOrRefuse(tx, org)`
(`fixed-assets/policy.ts`; already refuses an unreadable policy) and put `belowThreshold: compare(money(expense.totalAmount),
money(policy.threshold)) < 0` in `detail`. In `routeFacts` (`:277`): `categoryAccountCode: detail.belowThreshold ?
BELOW_THRESHOLD_CAPEX_ACCOUNT : category!.accountCode`. Constant `BELOW_THRESHOLD_CAPEX_ACCOUNT = '6510'` in
`fixed-assets/policy.ts` with a comment citing the chart line (a chart code, like `2130`; not a business setting — Q3).
Preview and post both read `routeFacts`, so they agree. `capitalize.ts:259-261` stays (it is now the truth).
Posting patterns: add `### \`asset_purchase.below-threshold\`` to `docs/POSTING-PATTERNS.md` under the asset purchase
section (`:1530-1564`) and the matching fixture in `tests/worked-examples/fixtures.ts` after `asset_purchase.credit`
(~`:1567`): ₱4,500 cash, `D('6510')` / `C('1110')`; then `npm run toc`.

**Existing rows (OUT of scope)** — BOSS runs after Ian approves a production read; as the database owner, read-only:
```sql
BEGIN READ ONLY;
SELECT s.code AS store, count(*) AS expenses, sum(e.total_amount) AS in_1510
  FROM expenses e JOIN expense_categories c ON c.id = e.category_id JOIN stores s ON s.id = e.store_id
 WHERE c."group" = 'CAPEX' AND e.status = 'posted'
   AND NOT EXISTS (SELECT 1 FROM fixed_assets fa WHERE fa.source_expense_id = e.id)
 GROUP BY 1;
ROLLBACK;
```
Likely correction, for a later task: void and re-enter each hit after PR B ships (re-approval routes to 6510), or a
reclass task if the count is large or a month is locked; there is no manual-journal screen today.

### DEF-893 — reversing a paid-down charge takes 2500 negative (confirmed; ruling given: refuse)
`liabilities/index.ts:288-294` calls `reverseEntry` after the reason check with no balance check. Partial code is right:
under the existing `lockForPayment` (`:264`), only for `entry.status === 'posted'`, sum (credit − debit) on 2500 lines with
`partyId === liability.id`; refuse when `positionOf().outstanding` < that. A payment's sum is negative, so payment
reversals always pass. Sentence: "Reversing this {formatMoney(removed)} charge would leave {name} owing
{formatMoney(after)}, because payments already cover it. Reverse a payment first."

### PR B tests
`packages/domain/tests/integration/t596-void-and-reverse-guards.test.ts` (copy `setup`/`capexExpense`/`asPerson` from
`fixed-assets.test.ts`, a reimbursable fixture from `expenses.test.ts:~1480-1560`, liability fixture from `liabilities.test.ts`):
1. `DEF-890 voiding a reimbursed expense is refused` (₱800 reimbursable, pay ₱800) → refused, no reversal, 2130 = 0.
   Positive: unpaid → voids; two ₱500 expenses, ₱500 paid → one voids (pooled). Mutant: delete guard → 2130 −800, red.
2. `DEF-890 concurrency: payout holding the payee lock makes the void wait, then refuses` (`ADVISORY` from
   `t369-s1-reimbursement-payout.test.ts:150`). Mutant: drop the lock → void succeeds, red.
3. `DEF-892 voiding after disposal is refused` → 1510 for the asset nets 0. Positive: active asset still retires
   (existing DEF-160 tests stay green). Mutant: delete guard → 1510 −cost, red.
4. `DEF-892 concurrency: disposal holding the asset lock makes the void wait` (`ROW_LOCK`). Mutant: read without lock.
5. `DEF-891 ₱4,999.99 CAPEX posts to 6510, nothing to 1510, no asset`; ₱5,000.00 still posts 1510 + asset; void of the
   below one reverses 6510. Mutant: route `category.accountCode` → red. Update `fixed-assets.test.ts` threshold test
   (`~:918-935`) to also assert 6510.
6. `DEF-893 charge 1000, pay 600, reverse charge refused`; pay 0 → reverse OK; reversing the payment OK. Mutant: delete
   guard → outstanding −600, red. `t366-s1b` R1 (`:190-211`) stays green (reversal runs first, outstanding 0).

## Census and guards (re-measure, never hand-edit)
- `tests/unit/t343-throw-ratchet.test.ts` ceilings (`<=`): prepaid 17, expenses **0**, fixed-assets 17, liabilities 14.
  Every new refusal is `refuse()`; any `throw new Error` in `expenses/` fails it.
- `tests/unit/domain-actions-have-callers.test.ts`: add no domain export (helpers stay module-private).
- `tests/unit/posting-patterns-doc.test.ts` + `toc-freshness.test.ts` (doc ↔ fixtures both ways, after `npm run toc`).
- Page edit (PR A): `apps/erp/tests/action-link-sweep.test.ts`, `editable-record-baseline.json`, touch-target census;
  run them, re-measure only if red.

## Out of scope
Wiring `undoWriteOff` to `/prepaid` (DEF-198); an undo for disposal; a reimbursement-payment void; a per-org
below-threshold account setting; reclassing existing rows; `chargeLiability`'s missing lock (t366-s1b header).

## Build order (one commit per slice; Sonnet; `--maxWorkers=2` always)
PR A (worktree `agent-a839801399e5b4ea6`):
- A1 commit the partial diff + DEF-894 brackets + register rows 882-884, 894; A2 test file 1-5 (show each mutant red,
  quote it); A3 page condition.
PR B (worktree `agent-a369c829a597d31b6`):
- B1 DEF-893 + test 6; B2 DEF-890 sort fix + tests 1-2; B3 DEF-892 lock + sentence + tests 3-4;
  B4 DEF-891 routing + posting pattern + test 5. Register rows 890-893 land with their slice.
After every slice:
```bash
npm run typecheck
npx vitest run --project unit --maxWorkers=2 tests/unit/t343-throw-ratchet.test.ts tests/unit/domain-actions-have-callers.test.ts tests/unit/posting-patterns-doc.test.ts tests/unit/toc-freshness.test.ts
npx vitest run --project integration --maxWorkers=2 packages/domain/tests/integration/t596-prepaid-write-off.test.ts packages/domain/tests/integration/prepaid.test.ts packages/domain/tests/integration/t345-missed-month.test.ts
npx vitest run --project integration --maxWorkers=2 packages/domain/tests/integration/t596-void-and-reverse-guards.test.ts packages/domain/tests/integration/expenses.test.ts packages/domain/tests/integration/fixed-assets.test.ts packages/domain/tests/integration/liabilities.test.ts packages/domain/tests/integration/t366-s1b-liability-reverse-retire-locks.test.ts packages/domain/tests/integration/t369-s1-reimbursement-payout.test.ts packages/domain/tests/integration/t369-s8-cross-store-draw.test.ts packages/domain/tests/integration/ap.test.ts
```
Full suite runs in CI on each PR. Smoketest: `/prepaid/[id]` written-off item shows no reverse button; a ₱4,999 CAPEX
expense approves and its entry shows 6510.

## Open questions (recommendation first)
- **Q2 DEF-890:** the refusal points to "void the reimbursement payment", which has no screen. Recommend: ship the refusal
  now (it stops a wrong balance); add a payout reversal as its own task.
- **Q3 6510 constant vs setting:** keep it a code constant; it is a chart account, like 2130/1510, not a business value.

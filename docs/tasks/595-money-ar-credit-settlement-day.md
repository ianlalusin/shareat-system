# T-595 — Money guards: store credit void, store credit race, cross-store credit, settlement day check

Status: SPEC (Opus), 2026-11-18. Fixes DEF-878..DEF-881 (allotted by BOSS 18 Nov in `shareat-coord/BOARD.md`; not yet
rows in `docs/DEFECTS-REGISTER.md` on main 9892641; add them at commit in the DEF-866 format, marked `fixed - T-595`).
Risk: **high** (money). Builder: Sonnet. No migration, no schema, no capability, no bible change. Lines are main 9892641.
DEF-880 **ruled B by Ian, 18 Nov 2026 (via BOSS, "2 B")**: store credit is spent only at the store that earned it.
The builder adds the four register rows DEF-878..881 in the last commit.

## Start from the stopped builder's work (judged)

Worktree `C:\Users\ianla\webapps\shareat-system\.claude\worktrees\agent-a2c413d20089148a7`, branch
`worktree-agent-a2c413d20089148a7`, base 9892641, 3 files uncommitted, no tests. Work there.

| File | Verdict |
|---|---|
| `db/src/repo/channel-settlements.ts` `salesDayForSettlement` | **Keep**, add `for share of sd` (DEF-881), fix the label to DEF-881 |
| `domain/src/channel-settlements/index.ts` day check | **Keep the three refusals; move the block** after `lockSettlementChannel` (DEF-881); label DEF-881 |
| `domain/src/ar/index.ts` lock in `recordCollection` | **Keep**; label is wrong (says DEF-878, is DEF-879) |
| `domain/src/ar/index.ts` void guard | **Keep the logic, redo the details**: does not compile (`customerNameOf` does not exist); re-reads the lines already read at 733; label says DEF-877 (is DEF-878) |
| `trade/returns.ts` | **Missing**: the `applyCredit` lock order (DEF-879) |

## DEF-878 — a collection that left store credit can be voided after the credit was spent

Main `packages/domain/src/ar/index.ts:731-742` (`voidCollection`): authorizes other stores, checks status, then
reverses. Nothing checks that the 2140 credit this entry created is still there:
```ts
    if (collection.journalEntryId) {
      await authorizeOtherStores(trx, actor, {
        lines: await journalRepo.findLinesForEntryWithAccountCodes(trx, collection.journalEntryId),
    ...
    const result = await reverseEntry(trx, {
```
Precedents: `trade/returns.ts:581-594` (customer return void, rough check) and the exact AR mirror,
`ap/index.ts:1534-1551` (`voidPayment`, net on 1240 versus the live balance). Copy the AP shape.

Change (in `voidCollection` only):
1. Hoist the lines at 733 into `const entryLines = collection.journalEntryId ? await journalRepo.findLinesForEntryWithAccountCodes(...) : []`
   and pass `entryLines` to `authorizeOtherStores`. Lines are immutable, so reading before the lock is safe.
2. After the `reason` check (740) and before `reverseEntry`: `await customersRepo.lockForCredit(trx, actor.orgId, collection.customerId);`
3. `held` = sum over `entryLines` where `accountCode === STORE_CREDIT_CODE && partyId === collection.customerId` of
   `credit - debit`, with `add`/`subtract`/`money` (no `toCentavos`, not imported here). If `compare(held, ZERO) > 0`, read
   `money(await arRepo.creditBalanceOf(trx, actor.orgId, collection.customerId))`; if `compare(balance, held) < 0`:
   `throw refuse(\`voidCollection: collection ${collection.id} left ${held} of store credit and only ${balance} is held\`,`
   `\`${formatMoney(subtract(held, balance))} of the store credit this collection created has already been spent. Void the collections that used it first.\`)`.
   Import `formatMoney` from `@shareat/core/money` (as `ap/index.ts` does).
A collection that SPENT credit (net debit on 2140) gives credit back: no check. Lock order: customer row only (void
takes no charge lock). S4 replaces `balance` with the store-and-org figure (see DEF-880).

## DEF-879 — two collections can spend the same store credit

Main `ar/index.ts:494-502` reads the balance with no lock; the only lock (533) is on the CHARGES, so two collections
against different charges never queue:
```ts
    if (compare(creditApplied, ZERO) > 0) {
      const balance = money(await arRepo.creditBalanceOf(trx, actor.orgId, input.customerId));
      if (compare(creditApplied, balance) > 0) {
```
Change: first line inside that `if`: `await customersRepo.lockForCredit(trx, actor.orgId, input.customerId);`
(`packages/db/src/repo/customers.ts:99`, the row lock `recordCharge` already takes at `ar/index.ts:81`). Lock only when
credit is spent: earning credit cannot drive a balance negative, and the void (DEF-878) takes the same lock.

**Lock order, everywhere: customer row, then charge rows.** One caller breaks it: `trade/returns.ts:696-704`
`applyCredit` locks the charge, then calls `recordCollection` (which now locks the customer). Against a direct
collection on the same charge that is a deadlock. Fix: in `applyCredit`, add
`await customersRepo.lockForCredit(trx, orgId, order.customerId);` immediately BEFORE line 697 and say why in one line.
Checked, no other inversion: `recordChargeWithCollection` (ar 279 customer, then 287 charges), `writeOffCharge` (830),
`voidCharge` (373), `postCustomerReturn` (returns 185) and `postFranchiseShortageCredit` (franchise-credit 56) lock
charges and never the customer.

## DEF-880 — credit earned at one store is spent at another with no inter-store legs (RULED B)

Main `ar/index.ts:594-605`: the creditApplied leg is booked at the PAYING store whatever store earned the credit:
```ts
              accountCode: STORE_CREDIT_CODE,
              storeId: input.storeId,
              debit: creditApplied,
```
Earned 500 at Lipa, spent at Malvar: org total right, but Malvar's 2140 shows -500 and Lipa's +500 forever, with no
1250/2150 pair. Options weighed: A (draw at the earning store + inter-store legs), **B (spend only where earned)**, C
(leave org-wide). **Ian ruled B.** The posting at 594-605 stays: under B, `input.storeId` IS the earning store.

Change (S4):
1. One helper, the single source of truth, in `packages/domain/src/ar/index.ts` (beside `STORE_CREDIT_CODE`, ~30), exported
   through the barrel:
   `export async function spendableStoreCredit(tx: Tx, orgId: string, customerId: string, storeId: string): Promise<Money>`
   = the smaller of `money(await arRepo.creditBalanceOf(tx, orgId, customerId, [storeId]))` and
   `money(await arRepo.creditBalanceOf(tx, orgId, customerId))`, floored at `ZERO`. No new repo code (`creditBalanceOf`
   already takes `storeIds`, `repo/ar.ts:172-192`). Both figures are needed: credit spent across stores BEFORE this change
   left the earning store's figure too high (see "already spent" below); the org figure caps it.
2. `recordCollection` (494-502, after S2's lock): `const spendable = await spendableStoreCredit(trx, actor.orgId,
   input.customerId, input.storeId);` and replace the `throw new Error(...)` at 497-500 with
   `throw refuse(\`recordCollection: ${customer.name} has ${spendable} of store credit at store ${input.storeId}; ${creditApplied} does not fit\`,`
   `\`${customer.name} has only ${formatMoney(spendable)} of store credit at this store, so ${formatMoney(creditApplied)} cannot be applied. Store credit can only be spent at the store where it was earned.\`)`.
   Lock unchanged (customer row, before the read). `applyCredit` (`trade/returns.ts:704`) passes `order.storeId`, so trade
   orders get the same rule with no change of their own.
3. `voidCollection` (S3's guard): the collection's 2140 lines all sit at `collection.storeId`, so `balance` becomes
   `await spendableStoreCredit(trx, actor.orgId, collection.customerId, collection.storeId)`. Sentence unchanged.
4. Customer page. Today the header (`customers/[customerId]/page.tsx:202-206`) shows the credit summed over the viewer's
   stores (`lib.ts:138-143`) and passes the same figure to the collection form (`page.tsx:264` -> `AutoAllocateCollectionForm.tsx:313-316`,
   "₱X held as customer store credit"). Under B a viewer holding both stores could be offered Lipa credit for a Malvar
   collection. Add `spendableCreditAt(actor, customerId, storeId)` to `apps/erp/src/app/customers/lib.ts`
   (`withOrgPrincipal`, refuse a store not in `heldArStores` by returning `'0.00'`, then call `spendableStoreCredit`) and
   pass it as the form's `credit` for the form's `storeId`. Change the hint to
   "₱X of store credit can be spent at this store. Credit is spent where it was earned." The header line stays the
   viewer's-stores total (T-435: the org figure and other stores' amounts never reach the page; the min only ever lowers
   the store figure, so it leaks nothing). Out of scope: the trade returns page credit column (`trade/returns/page.tsx:88`,
   org-wide, informational) and the trade order print (`trade/orders/lib.ts:289`).

**Credit ALREADY spent across stores before this change: no automatic correction.** Those entries stay as posted (no
migration, no back-dated entry). Effect after S4: the store that spent it shows a negative or zero 2140 for that
customer and offers nothing; the store that earned it still shows the old figure but can spend only up to the org
balance, so nothing is spent twice and the org total stays right. If the count below is non-zero, moving the figures
between stores is a separate adjusting entry (2140 plus 1250/2150) that BOSS and Ian decide on; not built here.
Read-only count for BOSS to run later (as the database owner, RLS is forced for the app role; prints no names):
```sql
BEGIN READ ONLY;
-- customers with a NEGATIVE store credit at a store = credit spent there that another store earned
SELECT s.code AS store, count(*) AS customers, sum(b.bal) AS total_negative
  FROM (SELECT jl.store_id, jl.party_id, sum(jl.credit - jl.debit) AS bal
          FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id JOIN accounts a ON a.id = jl.account_id
         WHERE a.code = '2140' AND jl.party_type = 'customer' AND je.status <> 'draft'
         GROUP BY 1, 2 HAVING sum(jl.credit - jl.debit) < 0) b
  JOIN stores s ON s.id = b.store_id GROUP BY 1;
ROLLBACK;
```
The AP twin (1240 drawn at `input.storeId`, `ap/index.ts:1316-1321`) has the same shape: log it as a new DEF; out of scope.

## DEF-881 — a settlement can name any sales day

Main `packages/domain/src/channel-settlements/index.ts:715-724`: the day is only checked for non-empty, then stored at 757.
```ts
    if (!rawInput.salesDayId) {
      throw refuse(
    ...
    await advisoryLocksRepo.lockSettlementChannel(trx, input.channelId);
```
The org half is already enforced by the DB (`channel_settlements_sales_day_id_same_org_fk`, schema line 209); store,
date, channel and status are not. Change, using the stopped builder's repo function and sentences:
1. Repo `salesDayForSettlement(tx, orgId, salesDayId, channelId)` in `packages/db/src/repo/channel-settlements.ts`
   (beside `postedSettlementFor`, ~251): returns `{ storeId, businessDate, status, hasChannel }` from `sales_days` joined
   to an `exists` on `sales_day_channels`, `where sd.id = $1 and sd.org_id = $2`, ending `for share of sd` (a day void
   waits for this commit).
2. Domain: AFTER `lockSettlementChannel` (724) and BEFORE `gatherSettlementContext` (725). Lock order: channel advisory
   lock, then the sales day row, the same order `approveDay` uses (channel, line, day via `correctPlatformSales`).
   Guard the id with the file's `UUID_TEXT` (241) so a garbage id is "not found", never a cast error. Refusals (keep wording):
   - missing, other store, or no channel row: "That sales day could not be found for this store and channel. Choose the day from the list of days waiting to be settled."
   - date differs: "That sales day is {day.businessDate}, not {input.businessDate}. A settlement clears the one day it names."
   - not verified: "That sales day is not verified yet, so it has raised no receivable to settle. Verify the day first."
   These mirror the page queue (`listSettleableChannelDays`, repo 362-395: verified + a channel row), so the form never
   offers a day this refuses. `approveDay` passes `day.id` from `findByBusinessDate` and reaches this check too.

## Callers and pages (S1-S3 change no page; S4 changes the collection form figure only)
`apps/erp/src/app/customers/actions.ts:211` (collect) and `:262` (void) show `refuse()` sentences already.
`apps/erp/src/app/channel-settlements/actions.ts:137` and `settlement-intake/approve.ts:96` call `recordChannelSettlement`.
`trade/returns.ts:704` (`applyCredit`) and `ar/index.ts:287` call `recordCollection`.

## Tests (write first, see each fail for the right reason, quote the red line of each mutant in the commit)
New `packages/domain/tests/integration/t595-ar-credit.test.ts` (copy the local fixture from `ar.test.ts:45-128`; for
DEF-880 the two-store fixture from `t369-s8b-cross-store-collections-loans.test.ts:83`):
- `DEF-878 positive`: overpay 1500 on a 1000 charge, void it with credit unspent: voids, credit back to 0.
- `DEF-878 refusal`: overpay (500 credit), spend 300 on another charge, void the first: refused, sentence says ₱200.00,
  no reversal entry, status still posted. Mutant: delete the guard -> red.
- `DEF-878 spent-credit collection voids`: void a collection that only SPENT credit: voids, credit returns.
- `DEF-878 race`: tx1 spends the credit and holds open (pattern: `t433-s3-credit-limit.test.ts:142-177`), tx2 voids the
  overpaying collection: tx2 waits, then is refused. Mutant: remove the void's `lockForCredit` -> red.
- `DEF-879 race`: 500 credit, two charges; tx1 collects with `creditApplied 500` and holds, tx2 does the same on the other
  charge: tx2 refused (assert refused + balances, not the wording: S4 rewrites it), credit ends at 0.00 not -500.00.
  Mutant: remove the lock -> red.
New `packages/domain/tests/unit/t595-lock-order-scan.test.ts` (source scan, comments stripped, as
`t511-s7a-fixes-scan.test.ts`): in `applyCredit`, `lockForCredit(` precedes `lockChargesForAllocation(`; in
`recordCollection`, `lockForCredit(` precedes `creditBalanceOf(`; in `voidCollection`, `lockForCredit(` precedes
`reverseEntry(`. Mutant: swap the applyCredit lines -> red.
New `packages/domain/tests/integration/t595-settlement-day.test.ts` (fixture from `channel-settlements.test.ts:51-95`):
positive (verified day, channel row, same store and date: posts); refusals, each with no row in `channel_settlements`:
other store's day, date differs, day `open`, day `submitted`, no channel row, `not-a-uuid`. Mutant per condition -> red.
DEF-880 (S4), in `t595-ar-credit.test.ts`, two-store fixture, one customer:
- `B positive`: overpay at Lipa (500 credit), spend 500 on a Lipa charge: posts, Lipa 2140 back to 0.00.
- `B refusal`: same 500 Lipa credit, `creditApplied 500` on a Malvar charge: refused with "can only be spent at the store
  where it was earned", no `ar_collections` row, no entry. Mutant: drop `[storeId]` from the store read -> red.
- `B old cross-store history`: post a raw legacy entry (Dr 2140 Malvar 500 / Cr 1210 Malvar 500, via `postEntry` as the
  old code did) after a 500 Lipa credit: Lipa still reads +500 store, org reads 0; spending 1 at Lipa refused.
  Mutant: drop the org-wide `min` -> red (it would spend credit already used).
- `B void`: overpay 500 at Lipa, then the old-history entry spends it at Malvar; void the Lipa collection: refused.
- `B race`: the S2 race test, both collections at Lipa, still green (lock unchanged).
- `trade order`: `applyCredit` on a Malvar order with only Lipa credit: refused (the `ok: false` path is not used; the
  refusal propagates from `recordCollection`, same as `customer-returns.test.ts:413`).
Web, `apps/erp/tests/integration/t595-customer-credit-page.test.ts` (pattern: `t435-readers-take-actor.test.ts`):
`spendableCreditAt` returns 500.00 at Lipa and 0.00 at Malvar for an admin holding both; 0.00 for a store the viewer
does not hold. Mutant: pass the viewer's-stores total -> red.

## Existing tests the change breaks (fix the fixture, never the check)
Fixtures insert `sales_days` with the default status and no `sales_day_channels` row. Make the day `status 'verified'`
(the T-385 trigger fires on UPDATE only, so an INSERT is allowed) and insert one channel row (amount = the gross used):
`channel-settlements.test.ts:86`, `order-wastage.test.ts`, `t511-s6a-loan-legs.test.ts`, `t511-s6a-fixes-settlement.test.ts`,
`t511-s6b-readers.test.ts`, `t511-s6c-settlement-netting.test.ts`, `t512-t150-wiring.test.ts`, `t440-s6-money-refusals.test.ts`,
`_fixtures/t507-platform-ar.ts`, `apps/erp/tests/integration/t343-s5-5s-followups.test.ts:601`, `t343-s5-5v-followups.test.ts:937`.
Run the `t511-s7a-*` approve tests unchanged; if one goes red, report it (the approve path's day may not be verified).
AR: `ar.test.ts`, `customer-returns.test.ts`, `t494-ar-credited-outstanding.test.ts`, `t433-s1-pay-now.test.ts`,
`apps/erp/tests/integration/def654-collection-void.test.ts` must stay green unchanged.

## Census pins and guards
`tests/unit/t343-throw-ratchet.test.ts`: new refusals use `refuse()`, so `channel-settlements` 8 and `trade` 51 stay;
S4 converts the `throw new Error` at `ar/index.ts:497`, so lower `packages/domain/src/ar` 31 -> 30 (line 78, with a
"T-595 S4" note) after measuring. `tests/unit/production-caller-ratchet.test.ts`: the
new repo function has a caller; regenerate only if it reports drift (`node scripts/production-caller-census.mjs --names`).
`packages/domain/tests/unit/t511-s7a-fixes-scan.test.ts:41` (lock before context read) must stay green.

## Out of scope
The same unlocked balance read in `voidCustomerReturn` (`returns.ts:583`, see Q2); the AP 1240 twin of DEF-880; a DB
foreign key for store and date on `channel_settlements` (Q3); the day check in `previewChannelSettlement` (no day id);
the sales day void blockers (DEF-877); correcting credit already spent across stores; any page change beyond S4's form figure.

## Build order (one commit each, LF endings, register rows in the last commit)
S1 DEF-881 repo + domain + fixtures + t595-settlement-day. S2 DEF-879 locks (`recordCollection`, `applyCredit`) + race
test + scan. S3 DEF-878 void guard + tests. S4 DEF-880 (B): helper, collection + void use it, sentence, page figure,
tests, ratchet 31 -> 30, register rows DEF-878..881. Each commit message pastes the mutant reds.

Commands (worktree root, a `_test` database, never a lane-pinned name):
```
npm run typecheck
npx vitest run --project integration packages/domain/tests/integration/t595-settlement-day.test.ts packages/domain/tests/integration/channel-settlements.test.ts packages/domain/tests/integration/order-wastage.test.ts packages/domain/tests/integration/t512-t150-wiring.test.ts packages/domain/tests/integration/t440-s6-money-refusals.test.ts --maxWorkers=2
npx vitest run --project integration packages/domain/tests/integration/t511 --maxWorkers=2
npx vitest run --project integration packages/domain/tests/integration/t595-ar-credit.test.ts packages/domain/tests/integration/ar.test.ts packages/domain/tests/integration/customer-returns.test.ts packages/domain/tests/integration/t494-ar-credited-outstanding.test.ts packages/domain/tests/integration/t433-s1-pay-now.test.ts --maxWorkers=2
npx vitest run --project integration packages/domain/tests/integration/t369-s8b-cross-store-collections-loans.test.ts packages/domain/tests/integration/t371-trade-returns-nan.test.ts --maxWorkers=2
npx vitest run --project integration apps/erp/tests/integration/t595-customer-credit-page.test.ts apps/erp/tests/integration/def654-collection-void.test.ts apps/erp/tests/integration/t343-s5-5s-followups.test.ts apps/erp/tests/integration/t343-s5-5v-followups.test.ts --maxWorkers=2
npx vitest run --project unit packages/domain/tests/unit/t595-lock-order-scan.test.ts packages/domain/tests/unit/t511-s7a-fixes-scan.test.ts tests/unit/t343-throw-ratchet.test.ts tests/unit/production-caller-ratchet.test.ts --maxWorkers=2
```
Full suite runs in CI on the PR. Smoketest on a private port: void an overpaying collection after spending its credit (refused).

## Open questions for BOSS
Q1. DEF-880: **answered, B** (Ian, 18 Nov). BOSS runs the read-only count above when convenient; non-zero means a
separate adjusting-entry decision.
Q2. `voidCustomerReturn` reads the balance with no lock (same race as DEF-878). Add `customersRepo.lockForCredit` before
`returns.ts:583` in S3? **Recommend yes**: one line, same lock, one race test.
Q3. Back the DEF-881 store and date check with a DB composite foreign key? **Recommend not now**: it needs a new unique
index on `sales_days` and a migration with a production pre-check; status can never be a key anyway, so the domain
check stays the authority for "verified". Log it as a follow-up.

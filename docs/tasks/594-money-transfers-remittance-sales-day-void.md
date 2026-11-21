# T-594 — Transfer void vs remittance, store-pair lock, verified sales-day void (DEF-875..877, DEF-904)

Status: SPEC (Opus planner), 2026-11-18. Builder: Sonnet. No migration. Main read at `9892641`; line numbers are main's.
All four findings are real on main (evidence quoted below).

## Rulings (BOSS, 18 Nov)

- DEF-875: refuse; tell the user to reverse the remittance; hide Void on such rows. Keep the internal flag for
  `reverseRemittance`; it must not be reachable from any action or form, and a test proves it (§1).
- DEF-876: same lock, same order; refuse a void that would make owed negative — also when the stores owe each other
  both ways; the sentence says to settle between the stores or reverse the settlement first (§2).
- DEF-877: refuse a verified day while a posted remittance, a posted channel settlement, a POS usage pull that POSTED
  usage, or recorded wastage counts against it; checks before any `reverseEntry` (§3). A merely planned pull does not block.
- Wastage: refuse as ruled; the builder does NOT build a wastage void (gap note in §6).
- DEF-904 (the opposite race) is slice S3b: lock the day row in remittance create and settlement post, re-check (§3b).
- The 5 old-design tests are rewritten, never deleted (§3).
- The builder adds register rows DEF-875, 876, 877 and 904 (`docs/DEFECTS-REGISTER.md` section E).

## 0. Partial work from the two stopped builders — verdict

| Worktree (`shareat-system\.claude\worktrees\…`) | Verdict |
|---|---|
| `agent-a70088a35a85145e0` (DEF-875/876, 5 files, uncommitted, no tests) | **KEEP all**, two edits: the negative-owed sentence's last sentence becomes the §2 one; add `VoidMoneyTransferInput` to `packages/domain/src/money-transfers/README.md` line 6 |
| `agent-a723ab6c0e064dd29` (DEF-877, 2 files, uncommitted, no tests) | **KEEP the shape** (helper `assertNothingCountsAgainstDay` before `reverseEntry`); **REDO** the four items in §3 |

Carry over in a fresh worktree from main: `git -C <old> diff > <scratch>/p.patch`, then `git apply`. Check LF.

## 1. DEF-875 — a remittance leg can be voided on its own

Main, `packages/domain/src/money-transfers/index.ts:276-283` — no remittance check before the reversal:
```ts
  if (transfer.status !== 'posted') {
    throw new Error(`voidMoneyTransfer: this transfer is already ${transfer.status}.`);
  }
  const reversal = await reverseEntry(tx, {
```
`remittance/index.ts:466-472`: `reverseRemittance` voids each leg through the SAME function while the remittance is
still `posted` (marked reversed at :487). A plain refusal would break every reversal — hence the internal flag.

Change (as in the kept patch):
- Repo `packages/db/src/repo/money-transfers.ts`: `isPostedRemittanceLeg(tx, moneyTransferId)` (exists over
  `remittance_lines` join `remittances` where `status = 'posted'`); `listMoneyTransfers` (:137-141) gains derived
  `inRemittance: boolean` with the same SQL; `MoneyTransferListRow` gains the field.
- `runVoid`, after the status/journal checks, before `reverseEntry`:
  `if (!input.viaRemittanceReversal && await isPostedRemittanceLeg(...)) throw refuse(<log>, SENTENCE)`.
  SENTENCE: "This transfer is part of a remittance (a cashier handover). Reverse the remittance instead - that undoes
  this transfer and reopens its days."
- `VoidMoneyTransferInput.viaRemittanceReversal?: boolean`, set ONLY at `remittance/index.ts:467`. **Not reachable from
  any action or form**: the one web caller (`apps/erp/src/app/money-transfers/actions.ts:127`) passes the literal
  `{ moneyTransferId, reason }` and reads no such field; leave that line untouched.
- Page `apps/erp/src/app/money-transfers/page.tsx:358`: posted + `inRemittance` shows the muted line "Part of a
  remittance. Reverse the remittance instead." and no form; other posted rows keep the form.

Other callers (none voids a remittance leg, none breaks): `def778-request-ids.test.ts:407`, `money-transfers.test.ts:393,
431-440,534`, `t369-s9-settle-between-stores.test.ts:430-463`, `t373-s2-inter-store-pair-finding.test.ts:215`.

Tests — `packages/domain/tests/integration/remittance.test.ts`, `describe('reversal')` (:428, reuse its fixture):
- "DEF-875 a remittance leg is refused": createRemittance, read the leg's `money_transfer_id`, void it as admin →
  `userMessage` = SENTENCE; transfer and remittance still `posted`; `reports(f)[0].owed` 0.00.
- "positive: reverseRemittance still voids its legs": after reversal the leg's `status = 'voided'`.
- "listMoneyTransfers: the leg is inRemittance, an ordinary transfer is not, the leg is not after reversal".
- Mutants: delete the refusal → case 1 red; delete `viaRemittanceReversal: true` → existing ":429" reversal test red.
- No concurrency case: a page void reads the remittance `posted` and refuses; `markVoided`'s `status = 'posted'` guard
  backstops a double void.
- Page: one case in `apps/erp/tests/integration/t369-s6-account-lists-web.test.ts` (render helper :143): SQL
  `remittances` + `remittance_lines` rows (NOT NULL: remittance_id, from/to account, amount, money_transfer_id) over a
  fixture transfer → no `moneyTransferId` input for it, the sentence shown; an ordinary transfer keeps the form.
- **The flag cannot be set from the screen**: one `it` in `apps/erp/tests/integration/t412-destructive-actions.test.ts`
  (reuse `approvedFixture`, `addPin`, `runAction`; the transfer as in the builder at :154, plus the SQL remittance rows):
  run `voidMoneyTransferAction` as the manager with the admin's correct PIN and a forged field
  `viaRemittanceReversal=true` → error banner = SENTENCE; transfer and remittance still `posted`. Mutant: make the
  action pass `viaRemittanceReversal: formData.get('viaRemittanceReversal') === 'true'` → red.

## 2. DEF-876 — store-pair race and a void that turns the debt negative

Main: `settle.ts:102` takes `advisoryLocksRepo.lockInterStorePair` after both `authorize`, before the replay and owed
reads; its draw lock comes later (`checkDraw` → `lockForDraw`, :172). `createMoneyTransfer` takes only
`lockForDraw(from)` (index.ts:106); `runVoid` (:250-298) takes none. `advisory-locks.ts:81-86` admits it: "a
cross-store void ... racing a settlement does not, and can leave the position reversed".

Change (as in the kept patch). **Lock order everywhere: pair lock FIRST, then any account draw lock.**
- `runCreate`: `if (crossStore) await lockInterStorePair(tx, from.storeId, to.storeId)` right after `prepareTransfer`
  (before the replay lookup and :106).
- `runVoid`, destination store differs: after the second `authorize`, take the pair lock, then RE-READ the transfer.
- Negative check, cross-store and NOT a settlement (repo `entrySettles(tx, journalEntryId, storeId)` = the
  DR-2150-at-source test `settles` uses): `interStorePosition(tx, org, debtor = destination, creditor = source)
  .owedPerDebtor - amountIn < 0` → `refuse`. The position is netted, so this also refuses when the stores owe each
  other both ways (ruled). SENTENCE: "`<Dest>` now owes `<Source>` only ₱X. Voiding ₱Y would turn that into a debt the
  other way round. Settle between the stores or reverse the settlement first." (names via `storesRepo.getById`).
  A settlement's void only restores debt and is never checked.
- Replace the advisory-locks.ts comment with the kept patch's text.
- No deadlock: settle/create = pair → draw → post; void = pair → reverse; expense approval = draw only.

Tests — new `describe('T-594 DEF-876')` in `t369-s9-settle-between-stores.test.ts` (reuse `fixture`, `seedDebt` (Lipa
owes Malvar 650), `repay`, `transfer`, `expectOwed`, `runConcurrencyLeg`, `ADVISORY`):
- refusal: seedDebt, repay 400, void the seeding transfer → sentence exact; owed 250 on both readings; still `posted`.
- both ways: seedDebt, then `transfer(lipaSafe → malvarSafe, 300)` (net 350); void the 650 → refused, same sentence.
- positive: void the settlement first (owed back to 650), then the seeding transfer → owed 0.00.
- concurrency create: A settles 400 (held); B creates `malvarBank → lipaBank` (other accounts) → `bWaited` on
  `advisory`; both fulfil. Mutant: delete the create lock → `bWaited` false, red.
- concurrency void: A settles 400 (held); B voids the 650 → waits on `advisory`, then refused; owed 250. Mutant:
  delete the void lock → B fulfils, owed -400, red. Mutant: delete the negative check → refusal case red.
- T7 (:426-466) and `t373-s2` T2 (:203-219) stay green unchanged.

## 3. DEF-877 — a VERIFIED sales day is reversed with no blocker check

Main, `packages/domain/src/sales-days/verify.ts:296-327` runs `withdrawBlockers` only inside
`if (day.status !== 'verified')`; the verified path goes straight to `reverseEntry` (:338) and the corrections
(:346, :356). `salesDaysRepo.withdrawBlockers` (`packages/db/src/repo/sales-days.ts:920-947`) has no settlement check.

Redo list for the kept patch:
1. `channelSettlement` SQL: just `cs.org_id = $org and cs.status = 'posted' and cs.sales_day_id = $day`
   (`channel_settlements.sales_day_id` is NOT NULL, schema :48-50; the patch's date fallback is dead weight).
2. Add `postedUsagePull` to `WithdrawBlockers` = non-void pull with `direct_finalized_at` or `recipe_finalized_at` set
   (the definition of `posMappingRepo.findLivePullOnVoidedDayForDate`, `pos-mapping.ts:298-320`). Verified days check
   `postedUsagePull`; unverified keep `usagePull`.
3. Drop the `checkSettlement` option: all checks always, in both branches, before `markUnverifiedVoided` and before the
   first `reverseEntry`. Refusal order: pull, wastage, remittance, settlement.
4. Verified-day sentences (unverified stay byte-identical; t369-s3 :510-525 and t375-s4 :359-374 pin them):
   pull "Stock usage was pulled from POS for this day. Void that usage first under Inventory › Usage & wastage." ·
   wastage "Wastage is recorded against this day, so it can't be voided." · remittance (existing) "Cash handed over has
   been counted against this day. Reverse that handover first." · settlement "A delivery-platform payout has been
   settled against this day. Void that settlement first under Channel settlements."

Concurrency: the day is read `FOR UPDATE` (:273). A remittance allocation or settlement inserted first holds a FK
key-share lock on the day row, so the void parks, then sees the committed row and refuses. The other order is §3b.
"Before reverseEntry" has no runtime mutant (a refusal rolls everything back): review item.

New `packages/domain/tests/integration/t594-verified-day-void-blockers.test.ts`, fixture `fx` from
`_fixtures/t511-s6b-world.ts` (verified day, Foodpanda channel, admin), `heldRace` from `_fixtures/held-race.ts`:
- each blocker on a VERIFIED day → its sentence, day still `verified`, no new `journal_entries`: remittance (SQL
  allocation by `sales_day_id`, as `t369-s7-audit-reentry.test.ts:99-107`), wastage (SQL, as t375-s4 :356), posted pull
  (SQL `pos_usage_pulls` with `direct_finalized_at`), settlement (real `D.recordChannelSettlement`, as
  `t511-s6b-readers.test.ts:100`).
- positive controls: reversed remittance, VOIDED settlement, merely planned pull → the day voids, entry reversed.
- concurrency: A records the settlement (held); B voids the day → parks, then the settlement sentence.
- Mutants: delete the verified-branch call → every refusal red; delete the settlement field → settlement case red.

The 5 old-design tests (they void a verified day carrying a blocker) — rewrite, never delete:
| Test | Fix |
|---|---|
| `t369-s7-audit-reentry.test.ts:113` (A) | call `postedHandover` AFTER `withdraw` (the re-entry rule reads store + date) |
| `t373-s1-voided-day-writers.test.ts:329` (T2) | the "before" wastage posts on a second verified day; void D1 with none |
| `t373-s1…:560` and `:599` (T12, finalized pull) | legacy state by owner SQL after finalize: `update sales_days set status='voided', voided_by, voided_at=now(), void_reason='fixture: pre-T-594 void'`; comment why |
| `t374-s7-void-pos-usage-pull.test.ts:699` (leg 2) | same owner-SQL void of D1 |
Unchanged (planned pull, ruled not blocking): t373-s1 :398, :588, :627. If a trigger refuses the owner-SQL void, stop
and report. T-373 R7 stays as the backstop for voided-with-pull rows already in production.

## 3b. DEF-904 — the opposite race: a writer commits against a day just voided

The void locks the day `FOR UPDATE` first; a remittance or settlement read the day as verified before that, its insert
waits on the FK, then commits against the voided day (the FK only checks the row exists). It is exactly a missing
"lock the day row, re-check its status", and the door already exists: `lockLiveSalesDay`
(`packages/domain/src/sales-days/live-day.ts:15-34`, `getByIdForShare`; used by usage pulls and wastage).
- `live-day.ts:18`: widen `doing` to `'usage' | 'wastage' | 'a cash handover' | 'a payout settlement'`. Sentence comes
  out "The sales day for {date} has been voided, so a cash handover can't be recorded against it."
- `createRemittance` (`remittance/index.ts`): after `allocateFifo` (:351), before `insertRemittance` (:353), lock every
  distinct non-null sales day id the allocations and the variance day map to (move `byDate`, now :389, up), in id
  order, with `storeId: input.storeId, doing: 'a cash handover'`. Also in `resolveRemittanceVariance` before its
  allocation inserts (:744-753): same writer family, same two lines.
- `recordChannelSettlement` (`channel-settlements/index.ts`): right after `gatherSettlementContext` (:725), before any
  write (:753): `lockLiveSalesDay(trx, actor.orgId, { salesDayId: input.salesDayId, storeId: input.storeId, doing:
  'a payout settlement' })`. After the gather so its store/config refusals keep their sentences
  (`channel-settlements.test.ts:480,529`). `settlement-intake/approve.ts:96` goes through it.
- Lock order: remittance = custody advisory → day share → draw; settlement = channel advisory → day share → loan rows;
  void = day update only. No cycle.
- Tests: remittance in `remittance.test.ts` (its `verifiedDay`/`tillMovement`), settlement in the t594 file, both with
  `heldRace`: A voids the verified day (held); B posts → B parks on the day row, then the voided sentence; no new
  allocation / settlement row. Positive: no void in flight → posts (existing suites). Mutant: delete either call → B
  commits against the voided day, red.

## 4. Census pins and guards (re-measure, never hand-edit)

- `tests/unit/t343-throw-ratchet.test.ts` (money-transfers 11, remittance 17, sales-days 0) unchanged: refusals use `refuse()`.
- Page edit: `apps/erp/tests/action-link-sweep.test.ts` (+ `touch-target-baseline.json`), `t412-destructive-census.test.ts`
  (:84 "Reverse money transfer" still present), `t411-row-link-census`, `t380-s3-guard`, `t348-page-description-sweep`,
  `def778-form-request-id`. If a count moves, take it from the test's own measured output and say so in the commit.
- `node scripts/production-caller-census.mjs --names`: no new test-only name (both new repo functions have domain callers).

## 5. Files you may touch

Domain: `money-transfers/index.ts`, `money-transfers/README.md`, `remittance/index.ts`, `sales-days/verify.ts`,
`sales-days/live-day.ts`, `channel-settlements/index.ts` (all under `packages/domain/src/`). Repo (`packages/db/src/repo/`):
`money-transfers.ts`, `advisory-locks.ts`, `sales-days.ts`. Page: `apps/erp/src/app/money-transfers/page.tsx`. Tests: every
file named above. Docs: this file, `docs/DEFECTS-REGISTER.md`.

## 6. Out of scope, and the capability gap

- **Capability gap, for BOSS to file in `docs/CAPABILITY-GAPS.md`:** nothing can void an order wastage, so a verified
  day with wastage can never be voided. Not built here.
- The stale unverified sentence "Inventory › POS usage" (page retired by T-550); hiding the sales-day Void button;
  settle.ts itself; any migration.

## 7. Build order (one commit per slice, LF, local commits; push at wrap-up)

S1 DEF-875 (repo, domain, flag, page, three test places) · S2 DEF-876 · S3 DEF-877 (+ 5 rewrites) · S3b DEF-904 ·
S4 census/guards, README line, register rows DEF-875..877 and 904.

Commands (lane `_test` database; no dev server running while tests run):
```bash
npm run typecheck
npx vitest run --project integration --maxWorkers=2 packages/domain/tests/integration/remittance.test.ts apps/erp/tests/integration/t369-s6-account-lists-web.test.ts apps/erp/tests/integration/t412-destructive-actions.test.ts
npx vitest run --project integration --maxWorkers=2 packages/domain/tests/integration/t369-s9-settle-between-stores.test.ts packages/domain/tests/integration/t373-s2-inter-store-pair-finding.test.ts packages/domain/tests/integration/money-transfers.test.ts packages/domain/tests/integration/def778-request-ids.test.ts
npx vitest run --project integration --maxWorkers=2 packages/domain/tests/integration/t594-verified-day-void-blockers.test.ts packages/domain/tests/integration/t369-s3-sales-day-edit-void.test.ts packages/domain/tests/integration/t369-s7-audit-reentry.test.ts packages/domain/tests/integration/t373-s1-voided-day-writers.test.ts packages/domain/tests/integration/t374-s7-void-pos-usage-pull.test.ts packages/domain/tests/integration/t375-s4-platform.test.ts packages/domain/tests/integration/t511-s6b-readers.test.ts
npx vitest run --project integration --maxWorkers=2 packages/domain/tests/integration/channel-settlements.test.ts packages/domain/tests/integration/t511-s2-settlement-upload.test.ts packages/domain/tests/integration/t366-s2-variance-charge.test.ts
npx vitest run --project unit --maxWorkers=2 tests/unit/t343-throw-ratchet.test.ts apps/erp/tests/action-link-sweep.test.ts apps/erp/tests/t412-destructive-census.test.ts apps/erp/tests/t411-row-link-census.test.ts apps/erp/tests/t380-s3-guard.test.ts
```
Full suite runs in CI on the wrap-up PR. Smoketest on a private port: a remittance leg on `/money-transfers` shows the
sentence and no Reverse; voiding a verified day with a handover shows the refusal banner.

No open questions remain.

# T-373: money follow-ups — DEF-547, DEF-552, DEF-555, DEF-559

**Status:** ✅ **SHIPPED 2026-10-04** — S1 `5e676c1` (DEF-552), S2 `c03851b` (DEF-559), S3 `79043f8` (DEF-555, migration 0180), S4 `d00d0c9` (DEF-547). Tester-first per slice, audited twice. Gates: typecheck 0; unit 4021/4022; FULL integration on fresh `shareat_test_orch_t373gate2` 283 files 4792/4792; build 0. Audit changes: R7 keys on a finalized section, not on status (a planned-only pull no longer blocks the date); a reversed bad 1250/2150 line and its reversal cancel; the pair sentence states who owes whom. Follow-up DEF-580 (reversal of a reversal). S2's production precheck is in `docs/ops/README.md`. Screen smoke: pending.
Written at HEAD `9830f85`; every line number below was read there. Dirty at that HEAD and NOT touched here:
`docs/POSTING-PATTERNS.md`, `tests/worked-examples/fixtures.ts` (another lane's). Uncommitted T-371 work touches
`packages/db/src/index.ts`, `packages/core/src/money.ts`, `packages/domain/src/stock/quantity.ts` and
`packages/db/src/repo/numeric-input.ts`; none of them is a T-373 path. **S1 needs no change to `packages/db/src/index.ts`**:
the `salesDaysRepo` and `posMappingRepo` namespace exports already carry new repo functions.
**Model:** Sonnet for each slice, tester first, then builder. Any amendment is written in plan mode (Opus).
**Migration:** S3 only, **0180** (journal head is 0179, `when` 1801539107084 → 0180's `when` = **1801625507084**).
S3 is gated on the FULL integration suite on a fresh gate DB, with the tree frozen while it runs.

## Goal
Four follow-ups the T-366/T-369 audits left open, each a place where the books or the screens can say something
untrue:
- nothing can be recorded against a sales day that is being, or has been, voided (DEF-552);
- a per-store-pair finding catches two inter-store pairs drifting in opposite directions (DEF-559);
- the closed-month stock trigger judges a movement by its Manila business day, like every other period rule (DEF-555);
- a reversed handover's unresolved variance stops reading as open work (DEF-547).

## v1 as requirements (§1.2d)
None of the four needs v1 to settle its intended behaviour: each is a v2 inconsistency against a v2 rule already
written down (the S3 withdraw rule, S9's per-pair reading, `toBusinessDate`, the reversal's own docstring). v1 was not
read for this spec.

## Census, verified at source (corrections to the register marked ✎)
- **DEF-552** (⛔). Confirmed, and wider than the register says.
  - `buildPlan` (`packages/domain/src/pos/usage-pull.ts:126`) reads the day with a plain `getById` (`:134`), checks only
    existence and store (`:135-136`), and never looks at `status`. It writes `pos_usage_pulls` and its lines (`:147-168`).
  - ✎ **`finalizeSections` (`:190`) is the writer that moves money, and the register does not name it.** It reads the
    day with a plain `getById` (`:209`) and, with no status check, posts usage records dated `salesDay.businessDate`
    through `saveUsageDraft`/`postUsage` (`:269-281`): stock movements and the COGS entry, on a voided day.
  - ✎ **`recordOrderWastage` (`packages/domain/src/wastage/orders.ts:243`) never reads the sales day at all.** It trusts
    `input.salesDayId` (`:298`): no lock, no status check, and no check that the day belongs to `input.storeId`. The FK
    (`schema/order-wastage.ts:92-94`) proves only that some day exists. An instant channel posts at once (`:325`).
  - ✎ The wastage action looks the day up in a SEPARATE transaction (`apps/erp/src/app/wastage/actions.ts:97-99`)
    before calling the domain (`:104`), so even its "live day" read is stale by the time the write happens.
  - ✎ **The POS-usage day picker offers voided days** (`apps/erp/src/app/inventory/pos-usage/lib.ts:19-22`, every
    status; rendered `page.tsx:209` as "(voided)"). Building a plan for a voided day is reachable from the screen
    today, not only through a race.
  - The void side is already right: `runVoid` takes `getByIdForUpdate` first (`sales-days/verify.ts:183`) and an
    unverified day's withdraw checks `withdrawBlockers` (`:203`, `repo/sales-days.ts:601-620`). A verified day's void
    checks no blockers (`:233-250`) — that is the register's "pre-existing for verified voids" (→ Q1).
  - ✎ **The double-post hole a voided verified day opens.** `0177` frees a voided day's date, so a replacement day can
    be entered. "One live pull per day" is keyed on `sales_day_id`, not the date (`schema/pos-mapping.ts:189-191`,
    `repo/pos-mapping.ts:280-285`). So a pull kept on the voided day does not stop a new pull on the replacement day,
    and finalizing it posts the same date's usage a second time (double COGS, double stock-out). A re-recorded wastage
    doubles the same way. S1 closes the pull half (R7); the wastage half is the person's (Q1).
  - ✎ **Nothing can void a pull.** `pos_usage_pulls.status` is only ever written `planned`/`finalized`
    (`repo/pos-mapping.ts`; no domain function, no action). So the withdraw refusal *"This day has a POS usage pull.
    Void the pull first."* (`verify.ts:205-208`) is a dead end: the person cannot do what it says. **S1·N2, a new DEF for
    the orchestrator.** It is also why Q1 (b) cannot be built without a new pull-void flow.
  - Why the fix is a status check under a row lock, not more blockers: an insert already takes `FOR KEY SHARE` on the
    day through the FK, so "writer first, then withdraw" is already caught (the withdraw waits, then `withdrawBlockers`
    sees the row). The hole is "void first, then writer": nothing in any writer reads `status`.
  - Remittance allocations (the third blocker) are not a writer of this kind: they key on `business_date`, and only a
    verified day is remittable (`repo/remittance.ts:118-124`). Not in scope.
- **DEF-559** (⚠️). Confirmed. `reciprocalDrift` (`packages/db/src/repo/findings.ts:76-98`) sums Σ1250 and Σ2150 over the
  whole org. Two pairs out of step by +X and −X net to zero and stay silent.
  - The per-pair reading already exists for one pair: `interStorePosition` (`repo/money-transfers.ts:218-246`) reads
    "what D owes C" from D's books and from C's books; `settleBetweenStores` refuses when they differ (T-369 S9·T9).
    Nothing watches every pair without someone trying to settle.
  - ✎ A second blind spot the register does not mention: a 1250/2150 line that names no store pair is invisible to
    every per-pair reading — `store_id` null, `party_type` not `'store'`, a party code that matches no store in the
    org, or one that names the line's own store. `unpartiedControlLines` (`findings.ts:185-205`) catches only a NULL
    party. Every current writer posts `party_type: 'store'` with a code (`ledger/inter-store.ts`,
    `money-transfers/index.ts:100-108`, `settle.ts:195`, `commissary/transfer.ts:556-564,658-663`,
    `commissary/discrepancy.ts:323-324`, `channel-settlements/index.ts:580-590`, `trade/returns.ts:477-483`), so this
    is a backstop for the
    cutover and for future writers, not a known live bug.
  - `reciprocalDrift` compares JS `Number`s (`:85`); it is NOT edited here (T-371's class). The new detector decides in
    SQL `numeric`.
- **DEF-555** (⚠️). Confirmed, and ✎ narrower than the register says.
  - `0145` (`packages/db/migrations/0145_t281_def302_honest_stock_period_refusal.sql`) tests
    `(NEW."moved_at" AT TIME ZONE 'UTC')::date`; `moved_at` is `timestamptz` (`schema/stock-ledger.ts:117`). The trigger
    is `BEFORE INSERT` only (`0063`), and `stock_movements` is append-only.
  - ✎ **Two encodings of `moved_at` exist, and only one is affected.**
    - Date-stamped writers store the business date as **UTC midnight**: `new Date(\`${date}T00:00:00Z\`)` (usage
      `stock/usage.ts:121,232`, deliveries `deliveries/receive.ts:152`, production `production/index.ts:428…837`,
      counts `stock/count-sessions.ts:141,161`, commissary `commissary/transfer.ts:247,455`, `discrepancy.ts:290`,
      customer returns `trade/returns.ts:247,411`, dispatch `trade/index.ts:592`). Their UTC date IS the business
      date, and their Manila date is the same date (08:00). **Unaffected either way.**
    - `now`-stamped writers store the real instant: supplier returns (`stock/supplier-returns.ts:173,341`), in-store
      transfers (`stock/transfers.ts:135-322`), the trade-order void (`trade/index.ts:659`) and the customer-return void
      (`trade/returns.ts:575,583`). Between 00:00 and 07:59 Manila their UTC date is the PREVIOUS day.
  - ✎ **Only one direction is real.** UTC is behind Manila, so the UTC date is never later than the Manila date: an
    early-morning movement on the 1st is judged against last month (a false refusal). The register's other direction
    ("a movement late on the last day lands in the next month") cannot happen. And because periods close in order, the
    trigger never ADMITS a movement into a closed month; the defect is false refusals only.
  - ✎ **The TS guards disagree with each other today.** T-369 S4 made `closedStockPeriodSentenceToday`
    (`stock/period-guard.ts:58-67`) test the UTC date, to match the trigger. But `stock/transfers.ts:47` tests
    `toBusinessDate()` (Manila), so at 02:00 Manila on the 1st an in-store transfer passes its own guard and then dies
    on the trigger's raw P0001.
  - ✎ `stock/transfers.ts`' `assertPeriodOpen` (`:46-60`, called at `:98, :194, :240, :292`) has two more faults: its
    reason carries the period uuid (*"fiscal period {id} (…) is closed — cannot move stock dated …"*), and it REFUSES
    when no period covers the date, where the trigger allows it (`0063`: "a movement with no fiscal period covering its
    date is ALLOWED"). It also reads the clock twice: `toBusinessDate()` at `:47`, then `new Date()` at `:104`.
  - ✎ Four existing tests PIN the UTC behaviour and must be inverted, not deleted: `t369-s4-audit.test.ts` AUDIT A
    (`:261-291`, two legs) and `t369-s4-followup.test.ts` FOLLOW-UP B (`:306-356`, two legs).
- **DEF-547** (🔸). Confirmed.
  - `reverseRemittance` (`packages/domain/src/remittance/index.ts:407-460`) reverses a variance's journal entry only
    when it has one (`:445-453`). An `open` variance has none (`schema/remittance.ts:259-263`), so it stays `open`.
  - `resolveRemittanceVariance` then refuses it (`:583-588`), so it can never close.
  - It is still listed and counted: `listVariances(…, 'open')` (`repo/remittance.ts:429-457`, called at
    `apps/erp/src/app/remittance/lib.ts:92`) and `countOpenVariances` (`:466-475`, `lib.ts:109`) filter only on the
    variance's own `status`.
  - ✎ The register asks "check whether open variances block a period close". **They do not.** `closeReadiness`
    (`findings/index.ts:320-330`) blocks on hard findings only, and no detector reads `remittance_variances`. Nothing
    to change there.
  - ✎ Also in `reverseRemittance`: three raw `new Error`s (`:415`, `:428`, `:430`). The action strips the prefix and
    shows them (`remittance/actions.ts:186-199`), so nothing leaks, but a double reversal reads "this remittance is
    already reversed." (lower-case, developer wording). Converted in S4 (S4·N1).

## Rulings (planner)
- **R1 (S1). The lock is `FOR SHARE` on the day row, taken by each writer after `authorize` and before its first write.**
  `FOR SHARE` conflicts with the `FOR UPDATE` that void, edit and verify take, so a writer and a void serialize; two
  writers (two wastage rows on one day) do not block each other. Under READ COMMITTED a writer that waited re-reads the
  committed row, sees `voided`, and refuses. No advisory namespace.
- **R2 (S1). A writer never holds the lock across the POS HTTP fetch.** `buildPlan` and `finalizeSections` read the day
  plainly, fetch, THEN lock and re-check. The date cannot change in between (T-369 S3 R1: an edit never changes the
  date), so the fetched lines stay valid; the re-check is status and store only.
- **R3 (S1). Both voided shapes are refused**: a withdrawn (unverified) day and a voided verified day. The sentence names
  the date, never an id.
- **R7 (S1). One date, one live pull, across a void.** `buildPlan` refuses when the store already has a non-void pull
  on a VOIDED day with the same `business_date` as the day being planned: *"Stock usage for {d MMM YYYY} was already
  pulled against the voided day, so pulling it again would count it twice."* This is what makes Q1 (a) safe for usage.
  A plain read is enough: the pull rows it reads cannot change (nothing voids a pull, census), and the voided day
  cannot come back.
- **R4 (S2). Two kinds, both `hard`.** `interStorePairOutOfStep` (one per unordered pair whose two readings differ) and
  `interStoreLineUnmatched` (one org-wide, for 1250/2150 lines no pair can read). `hard` because the codebase defines
  severity as "do the books add up" (`findings.ts:864`), and a pair whose two stores disagree does not. The org-wide
  `dueFromDueToNotReciprocal` stays, unedited.
- **R5 (S3). The stock day is the Manila business day, midnight to midnight**, exactly `toBusinessDate`
  (`packages/core/src/datetime.ts:38`, `BUSINESS_TIMEZONE = 'Asia/Manila'`). Not the 05:00 shift day (GLOSSARY "shift
  day": that is the attendance calendar). The migration hard-codes `'Asia/Manila'` as `0112` does, not
  `stores.timezone`, because the TS business date is fixed Manila and the two must agree.
- **R6 (S4). "Open" is DERIVED: a variance is open when its status is `open` AND its remittance is `posted`.** No
  status change, no migration. A reversal is terminal (`remittances_status_check`: `posted | reversed`), so the derived
  answer can never flip back. This follows the reversal's own rule: *"the days it settled become unsettled again,
  derived rather than repaired"* (`remittance/index.ts:403-405`).
  - Rejected: a new `cancelled` status written by the reversal. It needs a migration rewriting three CHECKs
    (`status`, `resolution_shape`, `posting`), it stores a second copy of the remittance's state, and on a `charged`
    row it would overwrite who charged it.

## Parallel plan
| Slice | Money risk | Files (BUILDER) | Shared state | Parallel-safe with |
|---|---|---|---|---|
| S1 DEF-552 | ⛔ posts COGS / a wastage charge on a voided day, or the same date's usage twice | `pos/usage-pull.ts`, `wastage/orders.ts`, `sales-days/live-day.ts`, `repo/sales-days.ts`, `repo/pos-mapping.ts`, `inventory/pos-usage/lib.ts` + `page.tsx` | `sales_days`, `pos_usage_pulls`, `order_wastages` | S2, S3, S4 |
| S2 DEF-559 | ⚠️ inter-store drift goes unseen | `repo/findings.ts`, `findings/index.ts`, `app/findings/lib.ts` | read-only | S1, S3, S4 |
| S3 DEF-555 | ⚠️ false refusals on the 1st, no wrong money | migration 0180, `migrations/meta/_journal.json`, `stock/period-guard.ts`, `stock/transfers.ts`, `triggers/registry.ts` | `stock_movements` trigger | S1, S2, S4 (it alone owns the journal) |
| S4 DEF-547 | 🔸 display only, no money moves | `repo/remittance.ts`, `remittance/index.ts` | read-only on `remittances` | S1, S2, S3 |

All four are file-disjoint. Each lane runs on its own lane DB (§3.4 row 94). **When S3 runs its FULL-suite gate, every
other lane stops editing until it finishes** (the tree is frozen during gates). No slice touches `fixtures.ts` or
`POSTING-PATTERNS.md`: none posts a new shape.

## Invariants (every slice)
- I1. `authorize()` first, before any lock, read-for-write or business refusal (T-364 order). The ✗ is proven.
- I2. No new capability. S1 uses `record_stock_movement`, `finalize_pos_usage_pull`, `record_order_wastage`; S4
  `accept_remittance`; S2 is read-only.
- I3. The database enforces period and immutability. S3 changes the trigger, the one enforcement; the TS guard only
  picks the sentence and must agree with it.
- I4. Refusals are `refuse(raw, userSentence)` (or an Outcome `reason` that is a sentence): no ids, no column names
  (T-343, `errorMessage` step 0). Dates via `humanDate`.
- I5. Money is SQL `numeric` returned as strings, or `@shareat/core/money`. No new `Number()` comparison.

---

## S1: DEF-552 — nothing is recorded against a voided sales day
**Goal:** a POS usage pull and an order wastage can attach only to a live day of the same store, checked under a lock a
void must wait for.

**BUILDER:**
- `packages/db/src/repo/sales-days.ts`: new `getByIdForShare(tx, orgId, id)` — `getByIdForUpdate`'s query with
  `.for('share')`, beside it, with a docstring naming R1.
- `packages/domain/src/sales-days/live-day.ts` (new): `lockLiveSalesDay(tx, orgId, { salesDayId, storeId, doing })`
  returns the day or throws:
  - missing → `gone(raw, 'sales day')`;
  - another store → `refuse(raw, 'That sales day belongs to another store.')`;
  - `voided` → `refuse(raw, \`The sales day for ${humanDate(d)} has been voided, so ${doing} can't be recorded against
    it.\`)` with `doing` = "usage" / "wastage".
  Export it from `sales-days/index.ts`.
- `packages/domain/src/pos/usage-pull.ts`:
  - `buildPlan`: keep `authorize` → plain `getById` → existing store check → `findLivePull`. Then the R7 refusal
    (`{ ok: false, reason }`), before the fetch. Then `rebuildLines`, then `lockLiveSalesDay` (R2), converting its
    `RefusalError` to `{ ok: false, reason: err.userMessage }` (this function returns Outcomes). Then the writes.
  - `finalizeSections`: after `rebuildLines` (`:212`) and before the PLAN_CHANGED loop, the same lock and conversion.
    ⛔ It must sit before the section loop, so a refused day posts nothing and marks no section finalized.
- `packages/db/src/repo/pos-mapping.ts`: new `findLivePullOnVoidedDayForDate(tx, storeId, businessDate)` — a non-void
  pull joined to a `voided` sales day of that store and date (R7).
- `packages/domain/src/wastage/orders.ts` `recordOrderWastage`: after both `authorize` calls (`:249-252`) and before
  `findChannelByName`, `await lockLiveSalesDay(trx, actor.orgId, { salesDayId: input.salesDayId, storeId:
  input.storeId, doing: 'wastage' })`. It throws (this function throws today).
- `apps/erp/src/app/inventory/pos-usage/lib.ts` `listSalesDaysForStore`: drop `voided` days from the picker UNLESS
  the day carries a live pull. Those stay listed, labelled "(voided — view only)", so a pull kept under Q1 (a) can
  still be read. `page.tsx` renders no Build/Finalize control for them (the domain refuses anyway).
- `apps/erp/src/app/inventory/pos-usage/page.tsx`: the view-only label and the hidden controls above.
- `apps/erp/src/app/wastage/actions.ts`: **unchanged.** Its pre-read keeps the friendly "no sales day" sentence; the
  domain re-checks under the lock, and its refusal already reaches `?error=` through `errorMessageOf` (`:121`).

**TESTER:**
- `packages/domain/tests/integration/t373-s1-voided-day-writers.test.ts` (new). Fixtures copied from
  `order-wastage.test.ts` and `pos-usage-pull.test.ts` (injected `fetchSnapshot`, never the live POS). The two-connection
  gated harness is copied from `t369-s3-sales-day-edit-void.test.ts` T10 (never a bare `Promise.all` race).
- `apps/erp/tests/integration/t373-s1-pos-usage-picker.test.ts` (new): the picker loader.

**Contract:** `buildPlan`, `finalizeSections`, `recordOrderWastage` keep their signatures. Each refuses the new cases
(voided day, another store's day, a missing day for wastage; `buildPlan` also R7). `getByIdForShare`,
`lockLiveSalesDay` and `findLivePullOnVoidedDayForDate` are new.

**Tests** (real Postgres; each red leg asserts the target and is shown red on HEAD):
- T1 (wastage, withdrawn day): withdraw an open day, then `recordOrderWastage` on it → the voided sentence with the
  date and no uuid; zero `order_wastages` rows, zero entries. Red on HEAD (it records). Positive control: the same call
  on an open day records.
- T2 (wastage, voided verified day, instant `absorbed` channel) → refused; zero entries with `source_type` for
  wastage. Red on HEAD (it posts). Control: before the void it posts.
- T3 (wastage, another store's day) → "That sales day belongs to another store."; nothing written. Red on HEAD.
- T4 (`buildPlan`, withdrawn day) → `{ ok: false }`, the voided sentence ("usage"); zero `pos_usage_pulls`. Red on HEAD.
  Control: an open day builds.
- T5 (`finalizeSections`, the money leg): build a plan on a verified day, void the day (a verified void is not blocked
  by a planned pull), then finalize → `{ ok: false }` with the sentence; zero usage records, zero stock movements,
  zero entries, no section marked finalized. Red on HEAD (it posts usage). Control: the same pull on a live day
  finalizes.
- T6 (race, void first): A runs `voidSalesDay` (withdraw) and holds it uncommitted; B runs `recordOrderWastage` on the
  same day. B is observed waiting (`wait_event_type = 'Lock'`) — this only gates the harness: on HEAD B waits too, on
  the FK's `FOR KEY SHARE`. A commits. **The red assertion is the OUTCOME**: B gets the voided sentence and zero
  wastage rows exist. Red on HEAD: after the wait B records.
- T7 (race, writer first): A runs `recordOrderWastage` and holds it uncommitted; B withdraws the day → B waits, then is
  refused with the existing wastage blocker sentence; the day stays open. Green on HEAD (the FK lock) — this pins it.
- T8 (race, `buildPlan` vs withdraw, void first): same shape as T6; the wait gates the harness only. Outcome:
  `{ ok: false }` and no pull row. Red on HEAD: after the FK wait the pull is inserted.
- T9 (two writers do not block): A holds a wastage uncommitted; B records a second wastage on the same day and commits
  while A is still open. Both rows exist after A commits. This proves `FOR SHARE`, not `FOR UPDATE`.
- T10 (✗ first): a person without `record_order_wastage` on a VOIDED day → `AuthorizationError`, not the voided
  sentence (T-364 order). Same for `buildPlan` without `record_stock_movement`.
- T11 (web): `listSalesDaysForStore` omits a voided day with no pull, keeps an open and a verified one, and keeps a
  voided day that carries a live pull, flagged view-only.
- T12 (R7, the double): verified day D1 for 2027-02-10 with a FINALIZED pull (usage posted); void D1; enter replacement
  D2 for the same date (manager, per 0177/S7); `buildPlan` on D2 → `{ ok: false }` with the R7 sentence; zero new
  pulls, zero new usage records and movements. Red on HEAD (it builds, and finalizing posts the date's usage again).
  Control: the same with D1 withdrawn while it had NO pull → D2 builds. Second control: another date at the same store
  builds.
- Mutants (each turns a named test red):
  - drop the voided check in `lockLiveSalesDay` → T1, T4, T5 red;
  - `getById` instead of `getByIdForShare` → T6 and T8 red;
  - `FOR UPDATE` instead of `FOR SHARE` → T9 red;
  - lock inside the section loop in `finalizeSections` → T5's "no section finalized" leg red;
  - lock before `authorize` → T10 red;
  - drop the R7 check (or key it on `sales_day_id` instead of the date) → T12 red.

**Migration:** none.

**Smoke (9008, `shareat_test_setup`, 2027-02 open):**
1. Record a wastage on an open day → recorded.
2. Withdraw a day that has wastage → the existing refusal banner.
3. `/inventory/pos-usage`: a voided day with no pull is no longer in the picker; a voided verified day with a kept pull
   is listed as "(voided — view only)" with no Build/Finalize control.
4. Forge the build-plan POST with a voided day's id (devtools) → the voided-day banner, no pull.
Screenshots of 2, 3 and 4.

**Not in S1:** whether voiding a VERIFIED day should first require its pull and wastage to be undone (Q1); tying
`openedOn` to the day's date (S1·N1, a new DEF for the orchestrator: `recordOrderWastage` accepts an `openedOn`
different from its sales day's date); a pull-void flow (S1·N2, census: the withdraw sentence "Void the pull first."
names an action that does not exist).

---

## S2: DEF-559 — a finding per store pair
**Goal:** every unordered pair of stores whose two books disagree about what one owes the other is a hard finding,
with both figures in words, and so is any 1250/2150 line that no pair can read.

**The question, in SQL `numeric`.** Over non-draft entries, 1250/2150 lines with `party_type = 'store'`, a non-null
`store_id`, and a party code matching a store `P` in the org other than the line's store. For the unordered pair
{A, B} (A < B by id), with `amt = credit − debit`:
- "A owes B", per A's books = Σ `amt` on lines at A, party B;
- "A owes B", per B's books = −Σ `amt` on lines at B, party A;
- the pair is out of step exactly when Σ `amt` over both sets ≠ 0 (`having`, never a JS compare).
This is the same reading `interStorePosition` uses, for every pair at once.

**Example:** Lipa's books say Lipa owes Malvar ₱650.00; Malvar's say ₱400.00. Detail: *"Lipa's books say Lipa owes
Malvar ₱650.00, but Malvar's books say ₱400.00. An inter-store posting is missing on one side."* Meanwhile a second
pair off by −₱250.00 makes the org totals tie, so `dueFromDueToNotReciprocal` stays silent (that is the defect).

**BUILDER:**
- `packages/db/src/repo/findings.ts`, after `reciprocalDrift` (which is NOT edited):
  - `interStorePairOutOfStep(tx, orgId)`: one row per out-of-step pair with both store names and both readings as
    `numeric(14,2)::text`. Finding: kind `interStorePairOutOfStep`, key `interStorePairOutOfStep:${aId}:${bId}`
    (A < B, so the key is stable whichever store posted last), `storeId: null`, `severity: 'hard'`, detail as above via
    the file's `peso`.
  - `interStoreLineUnmatched(tx, orgId)`: 1250/2150 non-draft lines with a non-null `party_id` and any of: `store_id`
    null, `party_type` distinct from `'store'`, no store in the org with that code, or the code naming the line's own
    store. One finding when the count is > 0: kind and key `interStoreLineUnmatched`, `hard`, *"{n} due-from/due-to
    line(s) worth ₱X don't name two different stores, so no store pair can account for them."* (A NULL party is
    `subledgerDoesNotMatchControl`'s, so it is excluded here: one fact, one finding.)
- `packages/domain/src/findings/index.ts` `listFindings`: both detectors, directly after `reciprocalDrift` (`:151`).
- `apps/erp/src/app/findings/lib.ts` `KIND_LABEL`: `interStorePairOutOfStep: 'Two stores disagree on what one owes the
  other'`, `interStoreLineUnmatched: 'Due-from/due-to lines with no store pair'`.

**TESTER:** `packages/domain/tests/integration/t373-s2-inter-store-pair-finding.test.ts` (new). Three stores (Lipa,
Malvar, Commissary) with office safes; the debt is seeded through real writers (`createMoneyTransfer`,
`settleBetweenStores`), and the out-of-step shapes by an in-test balanced entry posting one side only (S9·T9's method).

**Contract:** `listFindings` returns two more kinds. No existing detector, key or label changes.

**Tests:**
- T1 (the defect): pair Lipa/Malvar +₱250 out of step and pair Lipa/Commissary −₱250 (Σ1250 = Σ2150) → exactly two
  `interStorePairOutOfStep` findings with the right keys and both figures; `dueFromDueToNotReciprocal` absent. Red on
  HEAD (no such kind).
- T2 (positive control): a real cross-store transfer, a settlement, and a voided transfer → no new finding. The
  file's existing "a clean ledger reports nothing" test (`findings.test.ts:135`) stays green, unchanged.
- T3 (direction): the same mismatch posted from Malvar's side → the same key (the unordered pair).
- T4 (draft): a one-sided DRAFT entry → no finding.
- T5 (unmatched, one leg each): a 1250 line whose party code names no store; one naming its own store; one with
  `party_type 'customer'`. Each → one `interStoreLineUnmatched` with the count and amount. A NULL-party line raises
  `subledgerDoesNotMatchControl` and NOT this one. ⚠️ A NULL-party 1250 line cannot be posted normally (`0007`'s
  `journal_lines_check_party_requirement` trigger refuses it), so seed it the way `findings.test.ts:193-196` does:
  `update accounts set requires_party = false` for 1250 in the test org, post, then set it back to `true`.
- T6 (close): with T1's state, `closeReadiness` for the month lists the pair findings in `blocking`. Control: T2's
  state is ready.
- T7 (precision): a mismatch of ₱0.01 fires; an exact match does not (SQL `numeric`, no epsilon).
- Mutants:
  - group by ordered pair (`store_id, party`) instead of unordered → T2 red: a real cross-store transfer leaves two
    non-zero ordered sums (each store's own side), so a clean ledger fires;
  - compare in JS with `Math.abs(x) < 0.005` → T7 red;
  - include drafts → T4 red;
  - drop the own-store condition → T5's own-store leg red.

**Migration:** none.
**Production precheck (before the deploy that ships S2):** the orchestrator runs the two detector queries read-only
on production. A row means a month close will be blocked; it goes to Ian with the figures before the push, not after.

**Smoke (9008):** `/findings` on `shareat_test_setup`, which holds S8/S9's real cross-store data, shows neither new kind
(no false alarm). The firing leg is T1, not the shared DB. Screenshot.

**Not in S2:** changing `reciprocalDrift`'s JS compare (T-371); a screen listing every pair's balance (S9's panel lists
positive nets already).

---

## S3: DEF-555 — the closed-month stock trigger uses the Manila business day
**Goal:** a stock movement is judged against the period of its Manila business date, by the trigger and by every TS
guard alike.

**BUILDER:**
- `packages/db/migrations/0180_t373_s3_def555_stock_period_manila_day.sql` (new, hand-authored, ADR-012 §5):
  - header: T-373 S3 / DEF-555, this section, and why — the two encodings (census), only `now`-stamped writers
    change, false refusals only, R5;
  - `CREATE OR REPLACE FUNCTION "stock_movements_check_period_open"()`: `0145`'s body with ONE change,
    `(NEW."moved_at" AT TIME ZONE 'Asia/Manila')::date`. Both RAISE sentences byte-identical (the T-369 S4 tests and
    `stock-movements-period-override.test.ts` assert them). The trigger itself is not re-created.
  - **Precheck: none required.** The function runs only on INSERT into an append-only table, so it validates no
    existing row. For the record, the header carries a read-only query counting existing movements whose Manila and
    UTC dates fall in different periods; those rows stand as written.
- `packages/db/migrations/meta/_journal.json`: `{ "idx": 180, "version": "7", "when": 1801625507084, "tag":
  "0180_t373_s3_def555_stock_period_manila_day", "breakpoints": true }`.
- `packages/domain/src/stock/period-guard.ts` `closedStockPeriodSentenceToday`: test `toBusinessDate(now)` instead of
  `now.toISOString().slice(0, 10)`, and rewrite its docstring (it now matches the trigger by being Manila too).
- `packages/domain/src/stock/transfers.ts`: replace `assertPeriodOpen` (`:46-60`) at all four call sites (`:98`,
  `:194`, `:240`, `:292`) with `closedStockPeriodSentenceToday(tx, orgId, now, 'moved')`; a non-null sentence →
  `{ ok: false, reason: sentence }`. Read `now = new Date()` ONCE, before the check, and use that same `now` for the
  movements and header stamps (today `:47` reads the clock for the check and `:104` again for the stamps). No period
  covering the date → allowed, matching the trigger (`0063`). Delete `assertPeriodOpen` and the now-unused
  `toBusinessDate` import if nothing else uses it; update the header comment at `:15`.
- `packages/db/src/triggers/registry.ts:295-300`: the reason says "(0063; Manila business day since 0180)".

**TESTER:**
- `packages/db/tests/integration/t373-s3-stock-period-manila-day.test.ts` (new): the trigger alone, by direct insert
  with explicit `moved_at`.
- `packages/domain/tests/integration/t373-s3-now-stamped-flows.test.ts` (new): the flows, with the fake clock
  (`withClock`, copied from `t369-s4-audit.test.ts:238`).
- **Invert, in place** (they pin the bug): `t369-s4-audit.test.ts` AUDIT A (`:261-291`) and `t369-s4-followup.test.ts`
  FOLLOW-UP B (`:306-356`). At 02:00 Manila on 1 April with March closed, each flow now SUCCEEDS; each keeps its
  midday control, and each GAINS a refusal control at 23:30 Manila on 31 March (`2026-03-31T15:30:00Z`): the "today"
  sentence for March, nothing written. Rename the `describe`s to say Manila. Also update the comments that state the
  UTC rule: `MANILA_2AM_APRIL_1`'s at `t369-s4-audit.test.ts:236` and `t369-s4-followup.test.ts:232`, and the file
  header at `t369-s4-audit.test.ts:9` (leg A).

**Contract:** the trigger refuses fewer rows (never more); its sentences are unchanged. `closedStockPeriodSentenceToday`
keeps its signature.

**Tests:**
- T1 (trigger, red on HEAD): March closed, April open. Insert `moved_at = '2026-03-31T16:00:00Z'` (00:00 Manila on
  1 April) → accepted. Same at `'2026-03-31T23:59:59Z'` (07:59 Manila) → accepted.
- T2 (trigger, control): `'2026-03-31T15:59:59Z'` (23:59 Manila on 31 March) → refused with `0145`'s exact sentence.
- T3 (date-stamped, unchanged): `'2026-04-01T00:00:00Z'` accepted, `'2026-03-31T00:00:00Z'` refused, before and after.
- T4 (override sentence): T2 under `app.period_override = 'on'` → the override sentence, unchanged.
- T5 (flows at 02:00 Manila on 1 April, March closed; red on HEAD): supplier `recordReturn` and `voidReturn`, an
  in-store room transfer (`stock/transfers.ts`), `voidTradeOrder`, `voidCustomerReturn` → each succeeds, its movements
  stamped with the fake `now`.
- T6 (flows, control): the same five at 23:30 Manila on 31 March → each refused with its "today" closed-month
  sentence for March; nothing written.
- T7 (guard agrees with trigger): for each `now` flow at 07:59 Manila on 1 April (`2026-03-31T23:59:00Z`), March
  closed: `closedStockPeriodSentenceToday` returns null AND the flow's insert is accepted (the movement row exists).
  Red on HEAD: the guard (UTC) returns March's sentence and the flow is refused. At 08:00 Manila both agree before
  and after (pin).
- T8 (in-store transfer, `stock/transfers.ts`): (i) with no fiscal period covering today → the transfer posts (red on
  HEAD: "no fiscal period covers …"); (ii) with today's month closed → the "today" sentence with verb "moved" and no
  uuid (red on HEAD: the reason carries the period id); (iii) the movement's `moved_at` and the transfer's
  `dispatched_at` are the same instant as the clock read for the check (fake clock).
- Mutants:
  - keep `AT TIME ZONE 'UTC'` → T1, T5 red;
  - `AT TIME ZONE 'Asia/Manila'` applied to a `now()` instead of `moved_at` → T3 red;
  - guard left on the UTC date → T7 red;
  - keep `assertPeriodOpen` in `transfers.ts` → T8 (i) and (ii) red.

**Migration:** yes, **0180**. Gate: the FULL integration suite on a fresh gate DB, tree frozen; prove it on a scratch DB
first (ADR-012 §5 step 8). `stock-movements-period-override.test.ts` and `period-override.test.ts` stay green
unchanged.

**Smoke (9008):** stock flows cannot be clock-shifted on the dev server, so the smoke is a regression check: a
supplier return and an in-store transfer today still post, and one dated into a closed month still gets the S4
sentence. Screenshots. The time-of-day behaviour is proven by T1/T5, not by the smoke.

**Not in S3:** ✎ **S3·N1, a new DEF for the orchestrator — 19 "today" defaults use the UTC date**
(`new Date().toISOString().slice(0, 10)`): `domain/cash-requests/index.ts:97`, `domain/liabilities/index.ts:322`, and 17
in `apps/erp/src/app` (`ap/lib.ts:143`, `loans/lib.ts:68,124`, `remittance/lib.ts:120`, `money-transfers/page.tsx:40`,
`channel-settlements/page.tsx:134`, `payroll/lib.ts:46`, `owners/lib.ts:108`, `customers/lib.ts:156`,
`cash-requests/lib.ts:96`, `liabilities/lib.ts:75`, `attendance/page.tsx:63`, `prepaid/[id]/page.tsx:263`,
`trade/returns/actions.ts:39,84`, `inventory/returns/actions.ts:43,89`). Between 00:00 and 08:00 Manila they default
to yesterday. Same class as DEF-555, different fix (`toBusinessDate()`), many files: its own task.
Also not here: `onHand(asOf)` instant comparisons (`repo/stock-ledger.ts:96-110`), which are instant-correct.

---

## S4: DEF-547 — a reversed handover's variance stops reading as open
**Goal:** an uncharged variance on a reversed remittance is neither listed nor counted as open work, and the reversal
says so; a double reversal is refused in a sentence.

**BUILDER:**
- `packages/db/src/repo/remittance.ts`:
  - one predicate beside `listVariances`, `liveOpenVariance = and(eq(remittanceVariances.status, 'open'),
    eq(remittances.status, 'posted'))`, with a docstring naming R6;
  - `listVariances`: when `status === 'open'`, use it (other statuses unchanged);
  - `countOpenVariances`: use it.
- `packages/domain/src/remittance/index.ts` `reverseRemittance`:
  - docstring: an open variance closes by derivation (R6); a charged one has its entry reversed (unchanged);
  - S4·N1: `:415` → `gone(raw, 'remittance')`; `:428` → `refuse(raw, 'Say why this handover is being reversed.')`;
    `:430` → `refuse(raw, 'This handover was already reversed.')`. Authorization and lock order unchanged.

**TESTER:**
- `packages/domain/tests/integration/t373-s4-reversed-remittance-variance.test.ts` (new), seeded as in the T-366 S2
  remittance tests.
- `apps/erp/tests/integration/t373-s4-remittance-loader.test.ts` (new): `openVariances` and `openVarianceCountForOrg`
  (`app/remittance/lib.ts:90-110`).

**Contract:** `listVariances(…, 'open')` and `countOpenVariances` return fewer rows. `reverseRemittance` keeps its
signature; three refusals become `RefusalError`s.

**Tests:**
- T1 (red on HEAD): a short handover (open variance, −₱50.00) → listed and counted (positive control). Reverse it →
  not listed; count 0.
- T2: the same for an over (+₱30.00).
- T3 (control): a second, posted remittance's open variance stays listed and counted beside T1's reversed one.
- T4 (pin): charge a shortage, then reverse → the charge entry is reversed (existing behaviour), the person's 1230
  nets to 0.00, and nothing is listed.
- T5 (pin): resolving T1's variance after the reversal → the existing "That handover was reversed…" refusal.
- T6 (org-wide): a reversed open variance at another store is excluded from `countOpenVariances`.
- T7 (S4·N1, red on HEAD): a second `reverseRemittance` → `RefusalError` with "This handover was already reversed."; an
  empty reason → its sentence. Neither contains a uuid.
- T8 (web): the loaders agree with T1 and T6.
- Mutants: filter `listVariances` but not `countOpenVariances` → T1's count leg red; drop the predicate from both →
  T1 and T6 red; leave `:430` a plain `Error` → T7 red. (Filtering on `reversed_on is null` instead of `status` is
  equivalent by `remittances_reverse_shape_check`, so it is not a mutant.)

**Migration:** none.

**Smoke (9008, `shareat_test_setup`):** `/remittance` for SmokeStore Two: the five stale rows from the T-366 S2 smoke
are gone from the open list and the org-wide count drops by five. Then make a short handover, see it listed, reverse
it, see it gone; a second Reverse on a forged POST shows "This handover was already reversed." Screenshots.

**Not in S4:** showing a reversed handover's closed variance in its history row; whether open variances should block a
period close (they do not today, census; nobody has asked for it).

---

## Out of scope
- Q1's behaviour (verified-day voids with dependents) until Ian answers.
- S1·N1 (`openedOn` vs the day's date), S1·N2 (no way to void a POS usage pull, so the withdraw sentence "Void the
  pull first." is a dead end) and S3·N1 (the 19 UTC "today" defaults): new DEFs, filed by the orchestrator.
- `reciprocalDrift`'s JS compare (T-371).
- The bible, the register, CAPABILITY-MATRIX, the GLOSSARY: the orchestrator's, at wrap-up.

## Done when
- S1, S2, S3, S4 are green; each red leg was shown red on HEAD or against its named mutant before the build.
- Typecheck clean; unit suite passes (incl. `domain-actions-have-callers`, `route-capability-coverage`,
  `migration-journal`). The FULL integration suite passes on a fresh gate DB for S3, and before any push.
- Each slice's smoke run on 9008 with screenshots. `npm run build` passes with the dev server stopped. Touched files
  are LF.
- Each builder touched only its BUILDER paths; each tester only its TESTER paths.
- The orchestrator, at wrap-up: marks DEF-547, 552, 555, 559 fixed with hashes and applies this census's ✎ corrections
  to their rows; files S1·N1, S1·N2 and S3·N1; records Q1's answer; runs S2's production precheck before the deploy.

## Questions only Ian can answer
- **Q1: When a VERIFIED sales day is voided, must its POS usage pull and wastage be undone first?**
  Example: Lipa's 28 September report was verified with wrong totals. That day's stock usage (₱8,000 of meat) was
  already pulled from POS and posted, and a ₱200 Foodpanda wastage was recorded. A manager voids the day and enters it
  again. Today the void goes through, the usage and wastage stay on the voided day, and nothing stops the usage being
  pulled again on the new day: ₱16,000 of meat would leave the books for one day's ₱8,000. Re-recording the ₱200
  wastage on the new day would double it the same way. (An unverified day already refuses to be withdrawn while
  either exists.)
  - (a) **Allow the void; keep the usage and wastage on the voided day, and refuse a second pull for the same date**
    (recommended). The stock was really used and the food really wasted; only the sales figures were wrong. T-373 S1
    builds the "already pulled for this date" refusal (R7), which is what makes (a) safe for usage. Accepted under (a):
    a wastage is not blocked from being recorded again on the new day (staff must not re-enter it), and a tracked
    wastage still open on the voided day can still be resolved, posting against that voided day.
  - (b) Refuse the void until the pull and the wastage are undone first, as for an unverified day. ⚠️ Not buildable
    today: nothing can void a POS usage pull (S1·N2), so (b) needs a new pull-void flow first.
  - Default the build uses: (a), with R7.

## Ruling log
- 2026-10-03, planner: R1–R7 above (R7 and the census additions after an independent Opus review: 10 changes). S3 takes migration **0180**. No advisory lock namespace is taken.

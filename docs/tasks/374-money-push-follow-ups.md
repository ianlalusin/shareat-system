# T-374: money-push follow-ups — DEF-577, DEF-580, DEF-576, DEF-579, DEF-574, DEF-578

**Status:** APPROVED 2026-10-04 (orchestrator, after an independent Opus review whose 8 changes ✎R1–✎R8 are folded in). Not started. S1–S6 are un-gated; S5 waits for T-369 S5b/S6b to commit (`expenses/actions.ts`). **S7 (DEF-578) builds with Q1's recommended default and is
re-checked against Ian's answer before its commit.**
Written at HEAD `7d89c46` (tree clean); every line number below was read there. ⚠️ While this was being written,
another lane's uncommitted T-369 S5/S6 work appeared in `apps/erp/src/app/expenses/actions.ts` (not the `lineCount`
line) and `components/money/MoneyLines.tsx`. **S5's `expenses/actions.ts` edit waits until that work is committed**,
and its line numbers are re-read then.
**Model:** Sonnet for each slice, tester first, then builder. Any amendment is written in plan mode (Opus).
**Migration:** S7 only, **0181** (journal head is 0180, `when` 1801625507084 → 0181's `when` = **1801711907084**).
S7 is gated on the FULL integration suite on a fresh gate DB, with the tree frozen while it runs.

## Goal
Six follow-ups the T-371/T-372/T-373 pushes left open, each a place where a screen or the books can say something
untrue, or a sentence names an action nobody can take:
- every "today" the system fills in, posts, or prints is the Manila business date, never the UTC date (DEF-577);
- a reversal of a reversal no longer hides a re-stated unmatched inter-store line (DEF-580);
- an order wastage posts on its sales day's date, never on a different `openedOn` (DEF-576);
- an unreadable whole number in a form is refused, never replaced by a default or dropped (DEF-579);
- a branch manager can reach the over-receipt they must recount and return (DEF-574);
- a POS usage pull can be voided, so *"Void the pull first."* names a real action (DEF-578).

## v1 as requirements (§1.2d)
Only DEF-578 needed v1. The other five are v2 inconsistencies against v2 rules already written (`toBusinessDate`,
T-373 S2's reversal netting, T-373 S1's live-day rule, T-371 R6, Ian's t372-s6-recount-who ruling).
- **v1 at source (`ERP-rebuild/src/lib/actions/pos-usage-pull.actions.ts`).** v1 has no pull document. A pull is a
  set of usage records tagged `source: 'pos_pull'` (`:198-215`). Re-pulling a day *revises* or *void_only*s those
  records (`:456-488`) through `voidInventoryUsageRecordAction`, the ordinary usage void.
- **Who.** Writes need a manager (`writeGate`, `:79-83`). Voiding a prior record also needs `canVoidRecords`
  (`actorCanVoid: isManager && canVoidRecords`, `:282, :399`; enforced in the planner,
  `src/lib/financial/posUsagePull.ts:239`).
- **The goal v1 serves:** a day's POS-sourced usage can be undone and re-taken when POS figures change or the day was
  wrong, by the people who may void stock records, reversing the stock and the cost exactly.
- **v2 must beat it on two counts.** v2 has a pull document with "one live pull per day" (`schema/pos-mapping.ts:189-191`)
  and T-373's R7, so undoing is a document-level void, all-or-nothing. And v2 must close a hole v1 does not have: a
  single pull-made usage record voided on its own leaves a "finalized" pull that posted nothing (census, DEF-578).

## Census, verified at source (corrections to the register marked ✎)

### DEF-577 (⚠️) — "today" as a UTC date
The register's 19 are all still there; line numbers moved. ✎ **The class is wider: 37 sites in groups A–D, plus group E (correct, ratcheted).**
✎R1 (review): the planner's count was 36; `apps/erp/src/app/prepaid/lib.ts:96` `thisPeriod()` (`new Date().toISOString().slice(0, 7)`,
the prepaid run's "catch up through" default, `prepaid/[id]/page.tsx:162`) was missed. On the 1st before 08:00 it
defaults to last month. Added to B. Group E also omits `db/src/repo/stores.ts:391`, `payroll/periods.ts:172,174` and
`recurring-expenses/recurrence.ts:92,113` (all `getUTC*` on `Date.UTC`-built dates, correct); the guard measures, so
the tester lists them, not this census.
Search used: `toISOString().slice(0, 10|7)`, `.split('T')`, `.substring(`, `getFullYear/getUTC*` and `+ 8 * 3_600_000`,
over `packages/*/src` and `apps/erp/src`, non-test files.
- **A. Domain, defaults (register's 2).**
  - `packages/domain/src/cash-requests/index.ts:98`: `input.on ?? new Date()…` becomes the approval's `decidedOn`.
  - `packages/domain/src/liabilities/index.ts:325`: `isOverdue(…, asOf = new Date()…)` drives the overdue flag
    (`apps/erp/src/app/liabilities/lib.ts:37,52`).
- **B. apps/erp, defaults (register's 17).**
  - `ap/lib.ts:145`, `attendance/page.tsx:63`, `cash-requests/lib.ts:97`, `channel-settlements/page.tsx:135`,
    `customers/lib.ts:157`, `liabilities/lib.ts:75`, `loans/lib.ts:68,124`, `money-transfers/page.tsx:41`,
    `owners/lib.ts:108`, `payroll/lib.ts:46`, `prepaid/[id]/page.tsx:264`, `remittance/lib.ts:120`.
  - ✎R1 not in the register: `prepaid/lib.ts:96` `thisPeriod()`, a month default (→ `toBusinessDate().slice(0, 7)`).
  - ✎ **Four of the 17 are not defaults. They are POSTED dates, with no box to correct them:**
    - `inventory/returns/actions.ts:43`: supplier return `returnedOn`, which dates stock movements.
    - `inventory/returns/actions.ts:90`: `refundSupplierCredit` `businessDate`, a money posting.
    - `trade/returns/actions.ts:39`: customer return `returnedOn`.
    - `trade/returns/actions.ts:84`: `applyCredit` `collectionDate`, a money posting.
    - Between 00:00 and 07:59 Manila each posts to yesterday. On the 1st that is last month: refused if it is
      closed, wrongly booked if it is open. Severity is ⚠️ money-in-the-wrong-day, not just a wrong pre-fill.
- **C. ✎ Not in the register. Same fault, other spellings.**
  - `apps/erp/src/app/till/lib.ts:75` `today(now)`: the till's trading-date default (`till/page.tsx:110`).
  - `apps/erp/src/app/payroll/lib.ts:96` `currentPeriod` and `:88` `periodsForMonth` (`getUTCFullYear`/`getUTCMonth`):
    on the 1st before 08:00 the payroll form opens on last month's periods.
  - `apps/erp/src/app/payroll/thirteenth-month/page.tsx:36`: `new Date().getFullYear()` is the SERVER's local zone, so
    on 1 January before 08:00 it defaults to last year.
  - `apps/erp/src/app/statutory-discounts/page.tsx:44`: `monthBounds(new Date())` uses the UTC month.
  - `packages/domain/src/wastage/orders.ts:612`: the 15-day backstop's `entryDate`, a money posting, and its
    idempotency suffix `backstop:${entryDate}` (`:655`). Moved to S4, which owns that file.
- **D. ✎ A stored instant printed as its UTC date.** A wastage opened at 02:00 Manila reads as yesterday.
  - apps: `admin/prerequisite-refusals/page.tsx:51`, `budgets/page.tsx:181`, `wastage/page.tsx:252,284`,
    `wastage/[id]/page.tsx:92`, `components/scheduler-status.tsx:72`.
  - domain sentences: `attendance/credentials.ts:283`, `attendance/terminals.ts:179`, `sync/health.ts:438`,
    `sync/ingestor.ts:268`, `wastage/orders.ts:544` (S4).
  - The fix is the same call: `toBusinessDate(instant)` (`packages/core/src/datetime.ts:38`) takes an instant.
- **E. Correct today. Not converted; ratcheted by the guard so no new one appears.**
  - Hard-coded `+ 8 * 3_600_000` Manila offset: `recurring-expenses/index.ts:53`, `recurring-expenses/job.ts:63`,
    `scheduler/index.ts:333,442,634,699,801,951,1026`, `attendance/sweep.ts:89`, `apps/erp/src/app/budgets/lib.ts:24,40`,
    `expenses/new/page.tsx:43`, `expenses/recurring/lib.ts:34`, `findings/lib.ts:127-129`, `lib/terminal/lane.ts:112`.
  - `toLocaleDateString(…, { timeZone: 'Asia/Manila' })`: `fixed-assets/lib.ts:131`, `inventory/counts/page.tsx:31`.
  - UTC calendar arithmetic on `Date.UTC(…)`-built dates (correct by construction): `core/datetime.ts:89`,
    `repo/fiscal-periods.ts:34,143,147`, `fiscal-periods/holes.ts:38,42,46`, `payroll/periods.ts:155,177`,
    `recurring-expenses/recurrence.ts:52`, `scheduler/index.ts:307,1259,1265`, `findings/page.tsx:298`,
    `shared/straight-line.ts:52`.
  - OUT, read: `findings/page.tsx:292-298` `monthsAheadThrough` uses the UTC month **on purpose**, for parity with the
    fiscal-period seed job's window (`scheduler/index.ts:1060`). Changing one without the other would make the
    "missing periods" banner disagree with the job. Not this task.

### DEF-580 (🔸) — reversal of a reversal
- Confirmed. `interStoreLineUnmatched` (`packages/db/src/repo/findings.ts:212-243`) excludes `je.status = 'reversed'`
  (`:222`) and any entry whose original is reversed (`:223`).
- Reversing a reversal is legal: `reverse-entry.ts:131-132` says a reversal "stays 'posted' forever (invariant 9:
  reversing a reversal is legitimate)". So A → R1 → R2 excludes all three, though R2 re-states A's line.
- ✎ **The register's proposed fix is wrong for a chain of four.** "Exclude a reversal only when its original is
  reversed AND that original is not itself a reversal": for A → R1 → R2 → R3, A, R1 and R2 are excluded by status,
  and R3 (original R2 is a reversal) is COUNTED. But A + R1 + R2 + R3 nets to zero. The right rule is **parity**:
  the live tail of a chain re-states the root exactly when its depth (reversal hops from the root) is even.
- ✎ `interStorePairOutOfStep` (`:140-205`) is **not** affected: it sums signed `credit − debit`, so any chain nets
  correctly. Only the unmatched detector (a count and an unsigned `debit + credit` sum, `:214-215`) needs exclusion.

### DEF-576 (🔸) — wastage `openedOn`
- Confirmed. `recordOrderWastage` (`packages/domain/src/wastage/orders.ts:270`) locks the day (`:282`, T-373 S1) and
  discards it; the instant posting dates on `input.openedOn` (`:370`). `openedOn` is stored nowhere else.
- Only caller: `apps/erp/src/app/wastage/actions.ts:96-110`. It derives the day FROM `businessDate` and passes the same
  string, so the screen cannot mismatch today. Direct callers can (5 test files).
- `lockLiveSalesDay` (`sales-days/live-day.ts:15`) already returns the day row, with `businessDate`.

### DEF-579 (🔸) — integer form fields that substitute or drop
- ✎ **The register's specimen is gone.** `int(fd, 'maxShiftHours', 16)` no longer exists. `settings/attendance/actions.ts:98`
  now passes `str(formData, 'maxShiftHours')`, parsed after `authorize()` by `parseConfigWholeNumber`
  (`domain/attendance/config-input.ts:43`). No `function int(` remains in `apps/erp/src`.
- **The census ran BACKWARDS, from the column (DEF-395(d)).**
  - 58 `integer`/`smallint` columns in `packages/db/schema`.
  - 17 are reached by a form key in an `actions.ts`.
  - Each was traced to its parse. The rest are system-written (counts, minutes, line numbers).
- **IN: three sites substitute or drop.**
  - **`apps/erp/src/app/settings/attendance/lib.ts:30-39` `parseIntList`** feeds `allowedShiftStartHours` (`actions.ts:57`)
    and `payoutDays` (`:95`). It silently DROPS any token that is not an integer: `"9, 1O, 14"` becomes `[9, 14]`, and
    the save says OK. This is DEF-395's 7th spelling on integer columns. The drop is pinned by
    `apps/erp/tests/settings-attendance-lib.test.ts:32` (`'9,abc,10'` → `[9, 10]`), and
    `t370-settings-attendance-web.test.ts:10-17` documents it. It also runs BEFORE `authorize()` (T-364 order).
  - **`apps/erp/src/app/expenses/recurring/actions.ts:44,71`** `anchorDay: Number(str(…))`.
    - A blank box is `Number('') = 0`, which `isAnchorValid` (`recurrence.ts:38-41`) accepts for a weekly or
      fortnightly template. So a blank becomes **Sunday**, silently.
    - `Number` also reads `0x5` as 5 and `1e1` as 10.
    - The form box is free text (`expenses/recurring/page.tsx:386-391`).
  - **`apps/erp/src/app/expenses/actions.ts:141`** `Math.min(Number(str(formData, 'lineCount')) || 0, 50)`.
    - An unreadable count becomes 0 lines.
    - Any line past the 50th is silently dropped. `<MoneyLines>` has no 50 cap
      (`components/money/MoneyLines.tsx`, read).
- **OUT (each READ):**
  - attendance config's 10 integer keys and `maxShiftHours`/`autoClockOutHour` (`config-input.ts:43-60`, refuse).
  - attendance adjustments (`adjustments.ts:70`, `parseWholeNumberInput`).
  - `termPeriods` (`loans/index.ts:88`), `coverageMonths` (`prepaid/index.ts`, `parseWholeNumberInput`).
  - `creditTermsDays` (`ap/…parseCreditTermsDays`, T-362).
  - `year` (13th month, `assertRunYear` refuses NaN and 0, `payroll/thirteenth-month.ts:34`).
  - `usefulLifeMonths` (`fixed-assets/capitalize.ts:133`, refuses a non-integer; `Number('0x10')` = 16 is accepted,
    a lax parse, not a substitution, noted N1).
  - The page filter `thirteenth-month/page.tsx:36` `Number(sp.year) || …` is a URL filter, not a form write (its
    date half is S2's).
- **Limit:** `str()` keys built from expressions (`` `lineAmount_${i}` ``) are not literals. They were read in the
  two files that have them (`expenses/actions.ts`, `sales-days/actions.ts`), not grepped.

### DEF-574 (🔸) — the branch's recount has no screen
- Confirmed. `/commissary/discrepancies` lists `lowStockRepo.discrepancyList(tx, orgId, storeId, …)`
  (`page.tsx:46`). That filters `d.store_id = storeId`, the DISPATCHING store (`repo/low-stock.ts:462`). A branch
  picked in the store filter sees nothing of its own over-receipts.
- The domain already admits the branch: `resolveDiscrepancy` (`commissary/discrepancy.ts:103-120`) lets the order's
  branch resolve `return` on an `over` row. Ian, t372-s6-recount-who.
- The action already works for it. `resolveDiscrepancyAction` (`actions.ts:29-60`) authorises
  `resolve_trade_discrepancy` on the posted `storeId` and passes that as `commissaryStoreId`. Managers hold it
  (`capabilities.ts:799`). **No domain, action or capability change is needed; only a list and a form.**
- ✎ **Two definitions of "the branch":**
  - the list's label joins `o.requested_by_store_id` (`low-stock.ts:461`);
  - the domain's gate uses the order customer's `counterparty_store_id` (`discrepancy.ts:217-223`).
  - The new list MUST use the gate's definition, or it could offer a row the domain then refuses.
- ✎ `CAPABILITY-MATRIX.md:70` still says the domain "refuses the branch outright, whatever the role". That has been
  stale since T-372 S6. It is the orchestrator's to fix (N2).

### DEF-578 (⚠️) — nothing voids a POS usage pull
- Confirmed.
  - `pos_usage_pulls.status` allows `void` (`0127:109`, `schema/pos-mapping.ts:155`), and the live-pull unique index
    excludes it (`:189-191`).
  - No writer sets it. `finalizeSections` refuses a void pull (`usage-pull.ts:236`), a dead branch today.
  - The sales-day withdraw says *"Void the pull first."* (`sales-days/verify.ts:205-208`).
- What a finalized pull wrote: one usage record per (section, location), each posted through
  `saveUsageDraft`/`postUsage` (`usage-pull.ts:303-317`). Each record's id is linked on its pull lines
  (`setLineUsageRecord`, `:322-327`).
- **The reverse path already exists per record.** `voidUsage` (`stock/usage-records.ts:335-376`, `void_usage_record`,
  manager-only) reverses stock, the FIFO layers and the COGS entry (`stock/usage.ts:207-270`) and marks the record
  void with who/why (`repo/stock-usage.ts:231-236`).
- ✎ **Census hole: a single pull-made record can be voided on its own today** (`/inventory/usage/[id]`,
  `voidUsageAction`). The pull then still reads "finalized" and still counts as the day's one live pull. So the day
  can never be re-pulled, and the stock it shows as used was put back. `voidUsage` never asks whether a pull owns
  the record.
- ✎ **Race:** `finalizeSections` reads the pull with a plain `getPull` (`:232`). A void and a finalize on the same
  pull could interleave, leaving a void pull with freshly posted usage. Both must take the pull row `FOR UPDATE`.
- ✎ `voidUsage` reverses on `toBusinessDate()` (`usage-records.ts:366`), i.e. today. For a pull, that leaves the sales
  day's COGS standing and puts the reversal on today. A re-pull then posts on the sales day again, so that day
  reads double and today reads negative (R12).
- No audit columns: `pos_usage_pulls` has `finalized_at/by` but nothing for a void (`schema/pos-mapping.ts:175-185`).
  `stock_usage_records` has the precedent: `voided_at`, `voided_by`, `void_reason` +
  `stock_usage_void_shape_check` (`schema/stock-usage.ts:84-108`).

## Rulings (planner)
- **R1 (S1, S2). Every "today", and every stored instant shown as a date, goes through `toBusinessDate`.**
  - Defaults: `toBusinessDate()`. Instants: `toBusinessDate(instant)`.
  - Month defaults take `toBusinessDate().slice(0, 7)`, or the year and month parsed from it. Never `getUTC*` or
    `getFullYear` on `now`.
  - A function that already takes `now` keeps the parameter and passes it: `toBusinessDate(now)`.
  - No new helper. `toBusinessDate` is the one door.
- **R2 (S2). The guard is a ratchet keyed on SHAPE, not names.** In non-test files of `packages/*/src` and
  `apps/erp/src`:
  - **Zero** `.toISOString()` on a current instant: `new Date()`, `new Date(Date.now())`, or a parameter named
    `now`. Also zero `getFullYear()`/`getMonth()`/`getDate()` on such an instant.
  - ✎R2 (review): **and zero `getUTCFullYear()`/`getUTCMonth()`/`getUTCDate()` on one, and a LOCAL `const now = new
    Date()` counts as a current instant.** As first written the guard missed the very C/D sites S2 converts:
    `payroll/lib.ts:88` (`now.getUTCFullYear()` on the `now` parameter) and `scheduler-status.tsx:39` (a local
    `now`). Stated limit: a `new Date()` passed INTO a helper that calls `getUTC*` on its parameter
    (`statutory-discounts/page.tsx:44` → `monthBounds(d)`) is invisible to a shape scan; that site's proof is its
    conversion and the smoke.
  - Every remaining `.toISOString().slice(0, 7|10)` (also `.split('T')[0]`, `.substring(0, 10)`) and every
    `8 * 3_600_000` is an ENTRY in an allowlist. The key is `file`, the value is a count plus one reason from a
    closed list: `utc-calendar-arithmetic` · `manila-offset-ratchet` · `manila-locale` · `seed-window-parity`.
  - A new site, or a count that rises, fails. A count that falls must be lowered in the same commit (t343 ratchet
    shape).
  - Pure `fs`, no shell (Windows).
- **R3 (S3). Unmatched lines are read by chain parity.**
  - An entry's 1250/2150 lines count when the entry is not `draft`, not `reversed`, AND its reversal depth is even.
  - Depth: 0 for an entry with no `reversal_of_entry_id`, else 1 + its original's depth (a recursive CTE over the
    org's entries).
  - Why parity: the live tail of an odd chain (A, R1) cancels the root; the live tail of an even chain
    (A, R1, R2) re-states it. `interStorePairOutOfStep` is not touched.
- **R4 (S4). The day's date is the wastage's date.**
  - `recordOrderWastage` posts on `day.businessDate`, the row `lockLiveSalesDay` returns.
  - `input.openedOn` stays in the type, so no caller churns, and it must EQUAL that date. A mismatch is refused with
    nothing written: *"This wastage is dated {d MMM YYYY}, but the sales day it's recorded against is {d MMM YYYY}."*
  - The check runs after the lock, for tracked and instant alike (one rule, though only instant posts).
  - Rejected: silently using the day's date while accepting any `openedOn`. That makes the field a lie.
- **R5 (S5). An unreadable whole number is refused by name, after `authorize()`.**
  - Parse with `parseWholeNumberInput` (`domain/shared/whole-number-input.ts:22`), or a list form of it, inside the
    domain function.
  - A blank in a NOT NULL, no-default column is refused (T-371 R6). No token is dropped. No default is substituted.
  - `lineCount` is not typed by a person. It is the form's structure. Malformed or above 50, it is refused, never
    truncated.
  - ✎R5 (review): the planner wrote that `lineCount` is "read before `authorize()`". It is not: `parseExpenseForm`
    authorizes at `:122` and reads `lineCount` at `:141`; `:157` is also after the gate. Only `Choose a store.`
    precedes it (T-364, documented at `:104-110`). The check stays where it is, AFTER the gate. No line moves above it.
- **R6 (S6). The branch's recount list keys on the domain's own definition.**
  - Rows are `direction = 'over'`, not resolved, whose order's customer has `counterparty_store_id` = the selected
    store.
  - Only the Return form is offered, posting `storeId` = that store. No new action, capability or domain change.
- **R7 (S7). A pull is voided as a document: all of it or none.**
  - `voidPosUsagePull(tx, actor, { pullId, reason })` reverses every POSTED usage record the pull made, then marks the
    pull `void` with who, when and why, in one transaction.
  - A refusal anywhere (a closed stock month, say) throws and unwinds the records already reversed. This is
    `voidUsageRecord`'s own rule, at the document level.
  - Planned, partly finalized and finalized pulls are all voidable. A planned pull reverses nothing.
- **R8 (S7). Capability: `void_usage_record`, on the pull's store** (manager, admin, super admin; Q1 default).
  - Reason: a pull void IS usage-record voids. v1 gates the same act on manager + `canVoidRecords`.
  - No new capability, so no matrix row and no migration for one.
- **R9 (S7). Lock order: `authorize` → pull `FOR UPDATE` → status checks → record voids.**
  - `finalizeSections` takes the same pull lock AFTER its POS fetch (T-373 R2: never hold a lock across HTTP), then
    re-reads the pull and re-checks `void` and each section's finalized stamp under it.
  - A void and a finalize therefore serialize.
- **R10 (S7). A pull-made usage record cannot be voided on its own.**
  - `voidUsage` refuses a record linked to a non-void pull: *"This usage came from the POS pull for {d MMM YYYY}.
    Void the pull instead, so the day can be pulled again."*
  - Records of an already-void pull were voided by it, so they fail the existing "not posted" check anyway.
- **R11 (S7). A voided pull frees its date.**
  - The unique index already excludes `void`.
  - R7 of T-373 (`findLivePullOnVoidedDayForDate`) counts only non-void pulls, so voiding the voided day's pull lets
    the replacement day be pulled. That is exactly T-373 Q1's option (b), now buildable. Q1's default stays (a)
    until Ian says otherwise.
- **R12 (S7). The reversal is dated on the pull's sales day when that stock month is open, else today.**
  - The re-pull posts on the sales day (`usedOn = salesDay.businessDate`, `usage-pull.ts:308`). Reversing on the same
    date keeps that day's COGS true after a void and re-pull.
  - When the day's stock month is closed, the reversal falls back to today, and `reverseEntry` tags it
    `[prior period]` (`reverse-entry.ts:150-157`). If today's month is closed too, the existing closed-month sentence
    refuses the void.
  - ✎R8: the date travels on the actor-less core `voidPullUsageRecord`, not on `voidUsage` (S7 BUILDER). The
    screen path keeps `toBusinessDate()`.
- **R13 (S7). Audit columns, migration 0181:** `voided_at`, `voided_by`, `void_reason` on `pos_usage_pulls`, plus
  `pos_usage_pulls_void_shape_check`: `status <> 'void' or (voided_at, voided_by not null and btrim(void_reason) <> '')`.
  Mirrors `stock_usage_void_shape_check`. No row is `void` today (no writer), so the precheck must return 0.

## Parallel plan
| Slice | DEF | Risk | Files (BUILDER) | Shared state | Parallel-safe with |
|---|---|---|---|---|---|
| S1 | 577 (domain) | ⚠️ wrong-day defaults, dates in sentences | `domain/src/cash-requests/index.ts`, `liabilities/index.ts`, `attendance/credentials.ts`, `attendance/terminals.ts`, `sync/health.ts`, `sync/ingestor.ts` | none | all |
| S2 | 577 (apps + guard) | ⚠️ money posted to yesterday (4 sites) | the 23 `apps/erp/src` files in census B (incl. ✎R1 `prepaid/lib.ts`), C (not `wastage/orders.ts`) and D (apps); `tests/unit/t374-s2-no-utc-today.test.ts` | none | all; **the guard's final measurement waits for S1 and S4 to commit** |
| S3 | 580 | 🔸 a finding hidden | `db/src/repo/findings.ts` | read-only | all |
| S4 | 576 (+ 577 in its file) | 🔸 wastage posted on the wrong date | `domain/src/wastage/orders.ts` | `order_wastages` | all |
| S5 | 579 | 🔸 a setting saved wrong, silently | `apps/erp/src/app/settings/attendance/{actions,lib}.ts`, `domain/src/attendance/config-input.ts`, `apps/erp/src/app/expenses/recurring/actions.ts`, `domain/src/recurring-expenses/index.ts`, `apps/erp/src/app/expenses/actions.ts` | `store_attendance_config`, `recurring_expense_templates` | all |
| S6 | 574 | 🔸 a ruled flow with no screen | `db/src/repo/low-stock.ts`, `apps/erp/src/app/commissary/discrepancies/page.tsx` | read + the existing action | all |
| S7 | 578 | ⚠️ a dead-end refusal; a re-pull hole | migration 0181, `migrations/meta/_journal.json`, `db/schema/pos-mapping.ts`, `db/src/repo/pos-mapping.ts`, `domain/src/pos/usage-pull.ts`, `domain/src/stock/usage-records.ts`, `domain/src/sales-days/verify.ts`, `apps/erp/src/app/inventory/pos-usage/{actions,page,lib}.ts(x)` | `pos_usage_pulls`, `stock_usage_records`, ledger | all (it alone owns the journal) |

- All seven are file-disjoint.
- S2 does not touch `wastage/orders.ts`; S4 does. S2 touches the wastage PAGES; S4 does not.
- `packages/db/src/index.ts` and `packages/domain/src/index.ts` need no edit: the new repo functions sit in existing
  namespaces, and `export * from './pos/usage-pull'` (`domain/src/index.ts:98`) carries `voidPosUsagePull`.
- Each lane runs on its own lane DB (§3.4 row 94). **When S7 runs its FULL-suite gate, every other lane stops editing.**
- No slice touches `tests/worked-examples/fixtures.ts` or `POSTING-PATTERNS.md`. S7 posts only reversals through
  `reverseEntry`, an existing shape.

## Invariants (every slice)
- I1. `authorize()` first, before any lock, read-for-write, parse sentence or business refusal (T-364). The ✗ is proven.
- I2. No new capability. S4 `record_order_wastage`; S5 `manage_store_settings`/`manage_recurring_expenses` (as
  today); S6 `resolve_trade_discrepancy`; S7 `void_usage_record` (Q1).
- I3. The database enforces period and immutability. S7 adds one shape CHECK. The closed-month refusal stays the
  trigger's and `closedStockPeriodSentence`'s.
- I4. Refusals are `refuse(raw, sentence)` or an Outcome `reason` that is a sentence: no ids, no column names. Dates via
  `humanDate`.
- I5. Money is SQL `numeric` or `@shareat/core/money`. No new `Number()` comparison.
- I6. Every date a person sees or the books store is a Manila business date (R1).

---

## S1: DEF-577, domain
**Goal:** the six domain sites in census A and D read the Manila date.

**BUILDER:**
- `cash-requests/index.ts:98`: `input.on ?? toBusinessDate()`.
- `liabilities/index.ts:325`: `asOf: string = toBusinessDate()`.
- `attendance/credentials.ts:283`, `attendance/terminals.ts:179`, `sync/health.ts:438`, `sync/ingestor.ts:268`:
  `humanDate(toBusinessDate(row.x))` where the sentence is shown to a person. Where it is the raw half of
  `refuse(raw, …)`, `toBusinessDate(row.x)` alone. Read each site and say which in the report.

**TESTER:** `packages/domain/tests/integration/t374-s1-business-date-defaults.test.ts` (new). Use the fake clock
(`withClock`, as `t369-s4-audit.test.ts:238`) at **02:00 Manila on 1 April 2026 (`2026-03-31T18:00:00Z`)**.

**Tests:**
- T1 (red on HEAD): `decideCashRequest` with no `on` → `decided_on = '2026-04-01'` (HEAD: `'2026-03-31'`). Control:
  an explicit `on` is kept.
- T2 (red on HEAD, unit): `isOverdue('2026-03-31', '100.00')` at the fake clock → `true` (HEAD: `false`, since "today"
  is the 31st). Control: at 10:00 Manila the same → `true`; `dueOn = '2026-04-01'` → `false`.
- T3 (red on HEAD): a credential revoked at `2026-03-31T18:00:00Z`, revoked again → the sentence says 1 Apr 2026,
  not 31 Mar. Same leg for a terminal (`terminals.ts:179`).
- Mutant: revert any one site → its leg red.

**Migration:** none. **Smoke:** none of its own; S2's covers the screens these feed.

---

## S2: DEF-577, apps/erp, and the guard
**Goal:** no screen, form default or posted date in `apps/erp` uses the UTC date, and nothing new can.

**BUILDER:** the census B, C and D apps sites, each by R1:
- B: the 13 defaults (+ ✎R1 `prepaid/lib.ts:96` → `toBusinessDate().slice(0, 7)`), and the four POSTED dates (`inventory/returns/actions.ts:43,90`, `trade/returns/actions.ts:39,84`)
  → `toBusinessDate()`.
- C:
  - `till/lib.ts:75` → `toBusinessDate(now)`.
  - `payroll/lib.ts:88` → year and month from `toBusinessDate(now)`; `:96` → `toBusinessDate(now)`.
  - `payroll/thirteenth-month/page.tsx:36` → `Number(sp.year) || Number(toBusinessDate().slice(0, 4))`. The `||` is
    a URL filter fallback, kept.
  - `statutory-discounts/page.tsx:44` → `monthBounds` takes a `YYYY-MM-DD` from `toBusinessDate()` and keeps its
    `Date.UTC` arithmetic.
- D (apps): `toBusinessDate(row.x)` at `admin/prerequisite-refusals/page.tsx:51`, `budgets/page.tsx:181`,
  `wastage/page.tsx:252,284`, `wastage/[id]/page.tsx:92`, `components/scheduler-status.tsx:72`.
  - `scheduler-status.tsx:36-41` `monthsSince` → months between `toBusinessDate()` and `toBusinessDate(date)`.

**TESTER:**
- `tests/unit/t374-s2-no-utc-today.test.ts` (new), per R2.
  - Export a pure `findUtcToday(source: string)` from `tests/unit/lib/utc-today-census.ts` (new) and unit-test it
    on fixture strings first.
  - Then walk the tree and compare to the allowlist (`ALLOWED`, file → `{ count, reason }`), measured on the
    COMMITTED tree after S1 and S4 land.
- `apps/erp/tests/t374-s2-date-helpers.test.ts` (new): the helpers that take `now`.

**Tests:**
- G1 (shape, fixtures): `findUtcToday` flags `new Date().toISOString().slice(0, 10)`, `now.toISOString().slice(0, 10)`,
  `new Date().toISOString().split('T')[0]`, `new Date().getFullYear()`, and (✎R2) `now.getUTCMonth()` and
  `const now = new Date(); now.getUTCFullYear()`. It does NOT flag `toBusinessDate()`,
  `toBusinessDate(row.openedAt)`, or `new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)` (that one is
  allowlist material, a different finding kind).
- G2 (tree): zero current-instant hits. Every other `.toISOString().slice(0, 7|10)` and `8 * 3_600_000` site matches
  `ALLOWED` exactly. A new file or a raised count fails, naming the file:line.
- G3 (fail-closed): a file in `ALLOWED` that no longer exists fails (no stale entries).
- U1 (red on HEAD): `today(new Date('2026-03-31T18:00:00Z'))` (till) → `'2026-04-01'`.
- U2 (red on HEAD): `currentPeriod(cfg, new Date('2026-03-31T18:00:00Z'))` → an April period; `periodsForMonth` →
  April's.
- U3 (control): both at `2026-04-01T04:00:00Z` → unchanged from HEAD.
- Mutants:
  - re-add `new Date().toISOString().slice(0, 10)` to any one converted file → G2 red, naming it;
  - ✎R2: restore `now.getUTCFullYear()` in `payroll/lib.ts` `periodsForMonth` → G2 red (and U2);
  - delete one `ALLOWED` entry → G2 red;
  - revert `till/lib.ts` → U1 red.
- ⚠️ The four posted-date sites have no clock seam (the actions call `toBusinessDate()` directly). Their proof is G2,
  plus the S2 smoke. Do not add a clock parameter to a server action for a test.

**Migration:** none.
**Smoke (9008):**
- the wastage list and detail show the Manila date of a wastage opened after 16:00 UTC, i.e. 00:00–08:00 Manila (seed
  one with `opened_at` at 02:00 Manila);
- the till's date box, the payroll form's period and `/statutory-discounts`' month default today;
- a supplier return and a customer return post, carrying today's Manila date.
Screenshots.

---

## S3: DEF-580, chain parity in `interStoreLineUnmatched`
**BUILDER:** `packages/db/src/repo/findings.ts` `interStoreLineUnmatched` only.
- Replace `:221-223` with a recursive CTE computing each org entry's reversal depth.
  - ✎R3 (review): walk UP from the candidate entries (those carrying a 1250/2150 line) via `reversal_of_entry_id`,
    not down from every root in the org's journal. Same depth, bounded by chain length, not journal size.
- Keep `je.status <> 'reversed' and depth % 2 = 0` (R3).
- Rewrite the docstring and the inline comment: reversal-chain parity, and why the pair detector needs none.
- `interStorePairOutOfStep` and every other detector: untouched.

**TESTER:** `packages/domain/tests/integration/t374-s3-unmatched-reversal-chain.test.ts` (new). Seed as T-373 S2 T5
(`t373-s2-inter-store-pair-finding.test.ts`): a 1250 line whose party code names no store. Reverse through the real
`reverseEntry` each time.

**Tests:**
- T1 (pin): A alone → one finding, count 1, amount = A's.
- T2 (pin): A → R1 → no finding.
- T3 (red on HEAD, the defect): A → R1 → R2 → one finding, count 1, A's amount.
- T4 (the ✎ case): A → R1 → R2 → R3 → no finding. Green on HEAD, so it pins. **It is the mutant-killer for the
  register's proposed fix.**
- T5 (mixed): one clean entry + T3's chain → count 1 (only R2), not 2.
- T6 (draft): a draft reversal is ignored (`status <> 'draft'` keeps its place).
- Mutants:
  - the register's rule ("exclude a reversal whose original is reversed and not itself a reversal") → T4 red;
  - drop the depth test → T2 and T4 red. ✎R3 (review): the planner wrote "T3 red". It is not: with only
    `status <> 'reversed'`, T3's live R2 is counted, so T3 stays GREEN. The live R1 of T2 and the live R3 of T4 are
    what the mutant wrongly counts;
  - `depth % 2 = 1` → T1 and T3 red.

**Migration:** none.
**Smoke (9008):** `/findings` on `shareat_test_setup` shows no `interStoreLineUnmatched` (no false alarm). Screenshot.

---

## S4: DEF-576, a wastage is dated by its sales day (+ two DEF-577 sites in the file)
**BUILDER:** `packages/domain/src/wastage/orders.ts`.
- `recordOrderWastage`:
  - `const day = await lockLiveSalesDay(…)` (`:282`);
  - then `if (input.openedOn !== day.businessDate) throw refuse(raw, sentence)` per R4, dates via `humanDate`;
  - the posting at `:370` uses `day.businessDate`.
  - Update the `openedOn` docstring (`:244`): it must equal the day's date.
- `runOrderWastageBackstop` (`:612`): `const entryDate = toBusinessDate(now)`. The idempotency suffix follows it
  unchanged.
- `:544`: `toBusinessDate(row.resolvedAt)` in the raw message.

**TESTER:** `packages/domain/tests/integration/t374-s4-wastage-date.test.ts` (new). Fixtures from
`t373-s1-voided-day-writers.test.ts`.

**Tests:**
- T1 (red on HEAD): an instant `absorbed` wastage on day 2027-02-10 with `openedOn: '2027-02-09'` → R4's sentence with
  both dates and no uuid; zero `order_wastages` rows, zero entries.
- T2 (control): `openedOn` equal → posts, `entry_date = '2027-02-10'`.
- T3: the same mismatch on a TRACKED channel → refused, no row (one rule).
- T4 (I1): no `record_order_wastage` + mismatch → `AuthorizationError`, not the date sentence.
- T5 (red on HEAD): backstop with `now = 2027-03-01T18:00:00Z` (02:00 Manila, 2 March) on a due wastage → the charge
  entry's `entry_date = '2027-03-02'`. A second run is a no-op (the row is resolved; same idempotency).
- T6 (control): backstop at `2027-03-02T04:00:00Z` → `'2027-03-02'` before and after.
- Mutants:
  - ✎R4 (review): the planner's "T7: the check moved after the write → T1's zero-rows leg red" is struck. A refusal
    after the write still throws inside the same transaction, which unwinds the row, so T1 stays green: the mutant
    is unobservable. "Post on `input.openedOn` with the check kept" is EQUIVALENT (the check makes the two equal).
    Neither is listed as a killer. The ordering that IS observable is I1, T4's;
  - date check before `authorize` → T4 red;
  - drop the check → T1 red;
  - revert `:612` → T5 red.

**Migration:** none.
**Smoke (9008):** record a wastage on the screen → posts on the chosen day (the action passes equal dates). A
forged POST is not reachable: the action derives the day from the same date. T1 is the proof. Screenshot of the
recorded row.

---

## S5: DEF-579, whole numbers refuse instead of substituting
**BUILDER:**
- `apps/erp/src/app/settings/attendance/lib.ts`: delete `parseIntList`.
- `apps/erp/src/app/settings/attendance/actions.ts:57,95`: pass the raw box strings through.
- `packages/domain/src/attendance/config-input.ts`:
  - widen `allowedShiftStartHours` and `payoutDays` in `ConfigChangesInput` to `number[] | string`;
  - parse inside `parseConfigChanges`, which runs after `authorize()`, with a new local `parseWholeNumberList(raw,
    key, label, min, max)`. It splits on commas, ignores empty tokens, refuses any other token by name (*"Allowed shift
    start hours — "1O" is not a whole number from 0 to 23."*), and de-duplicates and sorts as today;
  - ranges from the existing CHECKs (`allowed_hours_check` 0–23, `payout_days_range_check` 1–31): read the
    migration, do not guess;
  - an empty list keeps today's meaning (the DB CHECK decides).
  - ✎R6 (review): a `number[]` input passes through UNTOUCHED, as it does today (`config-input.ts:196`). Only a string
    is parsed. `t370-semi-monthly-refusal.test.ts:133` passes `[10, 10]` directly to prove distinctness is checked
    downstream; de-duplicating an array input would quietly change what that leg proves.
- `apps/erp/src/app/expenses/recurring/actions.ts:44,71`: pass `str(formData, 'anchorDay')` raw.
- `packages/domain/src/recurring-expenses/index.ts`:
  - `anchorDay: number | string` in both inputs;
  - after `authorize()`, `parseWholeNumberInput(raw, '…: anchorDay', 'The day', 0, 31)`, then `isAnchorValid`
    unchanged;
  - a blank is refused (NOT NULL, no default: R6);
  - on update an omitted key stays omitted (`undefined`), never `Number(undefined)`.
- `apps/erp/src/app/expenses/actions.ts:141`:
  - `lineCount` must match `/^\d+$/` and be ≤ 50;
  - otherwise throw, in this file's existing style (`:157`): *"The payment lines didn't arrive complete — reload the
    page and try again."*, and above 50: *"An expense can carry at most 50 payment lines."*;
  - no `|| 0`, no `Math.min`.

**TESTER:**
- invert `apps/erp/tests/settings-attendance-lib.test.ts` (it pins the drop): delete it with `parseIntList`, and move
  its accepted shapes into the domain test below;
- `packages/domain/tests/integration/t374-s5-whole-number-refusals.test.ts` (new);
- `apps/erp/tests/integration/t374-s5-expense-line-count.test.ts` (new);
- keep `t370-settings-attendance-web.test.ts` W1 green. Its sentence may change: `"10, 2 5"` is now refused by the
  token sentence before the two-days rule. Update its expected sentence in place, and say so.

**Tests:**
- T1 (red on HEAD): `supersedeConfig` with `payoutDays: '10, 2O'` → the token sentence; no config row.
- T2 (red on HEAD): `allowedShiftStartHours: '9, abc, 14'` → refused; no row.
- T3 (controls): `'9, 10,  11'`, `'14,9,11'`, `'9,9,10'`, `'9,,10,'` → `[9,10,11]`, `[9,11,14]`, `[9,10]`, `[9,10]`
  (today's accepted shapes, byte-identical results).
- T4 (I1): no `manage_store_settings` + `'abc'` → `AuthorizationError`.
- T5 (red on HEAD): weekly recurring template with `anchorDay: ''` → *"The day — enter a whole number…"*; no template
  (HEAD: created on Sunday). `'0x5'` and `'1e1'` → refused.
- T6 (control): weekly `'0'` → Sunday; monthly `'31'` → kept.
- T7 (update): `updateRecurringTemplate` without `anchorDay` → unchanged; with `''` → refused.
- T8 (red on HEAD): the expense action with `lineCount = '51'` and 51 rows → the 50-line sentence, nothing posted
  (HEAD: posts 50). `lineCount = 'x'` → the incomplete-form sentence.
- T9 (control): `lineCount = '2'` with two rows → posts both.
- Mutants:
  - keep a `filter`-drop in `parseWholeNumberList` → T1, T2 red;
  - `Number(raw)` instead of `parseWholeNumberInput` → T5 red;
  - keep `Math.min(…, 50)` → T8 red;
  - parse before `authorize` → T4 red.

**Migration:** none.
**Smoke (9008):** `/settings/attendance`: payout days `10, 2O` → the sentence, nothing saved; `10, 25` saves. A weekly
recurring template with a blank day → the sentence. Screenshots.

---

## S6: DEF-574, the branch's recount list
**BUILDER:**
- `packages/db/src/repo/low-stock.ts`: `branchRecountList(tx, orgId, branchStoreId)` beside `discrepancyList`.
  - Join `trade_orders o` → `customers c on c.id = o.customer_id`;
  - `where d.org_id = orgId and d.direction = 'over' and d.status <> 'resolved' and c.counterparty_store_id =
    branchStoreId`;
  - same columns as `DiscrepancyListRow`, plus the dispatching store's name (`d.store_id`);
  - docstring naming R6 and the two-definitions note.
- `apps/erp/src/app/commissary/discrepancies/page.tsx`:
  - load `branchRecountList` for the selected store beside `discrepancyList`;
  - when non-empty, render a second section, *"Counted over at {store} — recount and return"*, one card per row:
    item, quantity, from {dispatching store}, order link;
  - one form to `resolveDiscrepancyAction` with hidden `id`, `storeId` = the selected (branch) store,
    `disposition = return`, `resolvedOn = today`, a REQUIRED note (*"Who carried it back and when, or that you
    recounted"*), and a "Return" button;
  - no other disposition and no defer;
  - relabel the filter "Dispatching store" → "Store". The page description gains one sentence for the branch case.

**TESTER:**
- `apps/erp/tests/integration/t374-s6-branch-recount-list.test.ts` (new): the repo and the page loader.
- `packages/domain/tests/integration/t374-s6-branch-recount-action.test.ts` (new): the end-to-end action call.
- Seed an over-receipt as in T-372 S6b's tests.

**Tests:**
- T1 (red on HEAD; no such function): a branch with one open over row → listed once. A short row, a resolved row, and
  another branch's over row → not listed.
- T2 (definition): an order whose `requested_by_store_id` is null but whose customer's counterparty is the branch →
  listed (the gate's definition).
- T3 (the path): a branch manager posts the listed form → resolved as `return`, nothing posted, the row leaves the list.
- T4 (✗): a branch STAFF (no `resolve_trade_discrepancy`) posting the form → refused by authorization, row unchanged.
- T5 (the gate holds): the branch posting `extra_dispatch` for the same row (forged) → the existing domain refusal.
- T6 (control): the commissary's own list for the dispatching store is unchanged.
- Mutants:
  - key the list on `d.store_id` → T1 red;
  - key it on `requested_by_store_id` → T2 red;
  - include `short` rows → T1 red.

**Migration:** none.
**Smoke (9008):** as a branch manager, open `/commissary/discrepancies?store=<branch>` → the over-receipt is listed
under the new section. Return it with a note → gone, and the commissary's view shows it resolved as Return.
Screenshots of both.

---

## S7: DEF-578, voiding a POS usage pull
**BUILDER:**
- `packages/db/migrations/0181_t374_s7_def578_pos_usage_pull_void.sql` (new, hand-authored, ADR-012 §5):
  - header: T-374 S7 / DEF-578, R13, and the precheck;
  - `ALTER TABLE pos_usage_pulls ADD COLUMN voided_at timestamptz, ADD COLUMN voided_by uuid REFERENCES persons(id)
    ON DELETE RESTRICT, ADD COLUMN void_reason text`;
  - `ADD CONSTRAINT pos_usage_pulls_void_shape_check CHECK (…R13…)`;
  - **precheck** in the header and run before apply: `select count(*) from pos_usage_pulls where status = 'void'`
    must be 0 (no writer exists).
- `migrations/meta/_journal.json`: `{ "idx": 181, "version": "7", "when": 1801711907084, "tag":
  "0181_t374_s7_def578_pos_usage_pull_void", "breakpoints": true }`.
- `packages/db/schema/pos-mapping.ts`: the three columns and the check, matching `stock-usage.ts:84-108`. Update the
  header note on statuses.
- `packages/db/src/repo/pos-mapping.ts`:
  - `getPullForUpdate(tx, id)`;
  - `markPullVoid(tx, id, voidedBy, reason)`;
  - `postedUsageRecordIdsForPull(tx, pullId)`: distinct `usage_record_id` on its lines whose record is `posted`;
  - `livePullForUsageRecord(tx, recordId)`: the non-void pull, with its sales day's `business_date`, that links the
    record, or none.
- `packages/domain/src/pos/usage-pull.ts`:
  - new `voidPosUsagePull(tx, actor, { pullId, reason })`, in this order:
    1. `getPull` (missing → `gone`);
    2. `authorize('void_usage_record', { storeId })` (R8);
    3. `getPullForUpdate`;
    4. already `void` → *"This POS usage pull was already voided."*;
    5. blank reason → *"Say why this pull is being voided."*;
    6. choose `voidedOn` per R12, using `closedStockPeriodSentence(tx, orgId, salesDay.businessDate, 'voided')`:
       null → the sales day's date, else `toBusinessDate()`;
       ✎R7 (review): **then test the CHOSEN date once, before any write:** `closedStockPeriodSentence(tx, orgId,
       voidedOn, 'voided')` non-null → `throw refuse(raw, thatSentence)`. Every record reverses on the same
       `voidedOn`, so a closed month can never refuse only the second record; checked per record it would always
       fire on the first, and T3 as first written could not reach "the refusal on the second";
    7. for each posted record: `voidPullUsageRecord(tx, { recordId, reason, voidedOn, voidedBy })` (✎R8). A
       `{ ok: false }` after step 6 is not a person's mistake (its reasons carry record ids): THROW it as an internal
       fault, so earlier record voids unwind (R7). A DB-level refusal (a room frozen by an open count) throws on its own;
    8. `markPullVoid`.
  - Returns `{ ok: true, reversedRecordCount }` or throws. Docstring names R7–R13.
  - `finalizeSections`: after `rebuildLines` and the day lock, `getPullForUpdate`; re-check `void` and use the
    LOCKED row's `*FinalizedAt` for `alreadyFinalized` (R9).
- `packages/domain/src/stock/usage-records.ts` `voidUsage`:
  - ✎R8 (review): **no `viaPull` flag and no `voidedOn` on `voidUsage`'s signature.** It is the screen's function
    (`inventory/usage/actions.ts:182`); a bypass flag on it is one keystroke from an action that skips R10. Instead:
    - factor its body after `authorize` into an exported, ACTOR-LESS `voidPullUsageRecord(tx, { recordId, reason,
      voidedOn, voidedBy })`: the posted/kind/movement checks, `voidUsageRecord`, `markUsageVoid`. Actor-less, so it
      sits outside `domain-actions-have-callers`' population (`(tx, …, actor)`) and needs no exemption row;
    - `voidUsage` = `getUsageRecord` → `authorize` → R10 (`livePullForUsageRecord`) → `voidPullUsageRecord` with
      `toBusinessDate()`. Signature unchanged;
    - `voidPosUsagePull` authorizes ONCE on the pull's store (R8; a pull's records are its store's) and calls the
      core per record.
  - R10's refusal comes after `authorize`.
- `packages/domain/src/sales-days/verify.ts:205-208`: the sentence becomes *"This day has a POS usage pull. Void it
  first under Inventory › POS usage."* (keep the raw half).
- `apps/erp/src/app/inventory/pos-usage/actions.ts`: `voidPullAction(fd)` → `voidPosUsagePull`, redirect with
  `ok: 'Pull voided — {n} usage record(s) reversed. The day can be pulled again.'` or `error`.
- `apps/erp/src/app/inventory/pos-usage/page.tsx` (+ `lib.ts` if the loader must expose the pull's status): for a
  `planned` or `finalized` pull, a "Void this pull" form with a required reason, shown also on a "(voided — view
  only)" day (that is the undo T-373 Q1 (b) needs). No control on a void pull.

**TESTER:**
- `packages/db/tests/integration/t374-s7-pull-void-shape.test.ts` (new): the CHECK, raw SQL as the migration role.
- `packages/domain/tests/integration/t374-s7-void-pos-usage-pull.test.ts` (new). Fixtures from
  `pos-usage-pull.test.ts` (an injected `fetchSnapshot`, never the live POS) and `t373-s1-voided-day-writers.test.ts`
  (the gated two-connection harness, never a bare `Promise.all` race).
- `apps/erp/tests/integration/t374-s7-pos-usage-void-action.test.ts` (new).

**Tests:**
- T1 (red on HEAD; no function): finalized pull (direct + recipe posted) on an open-month day →
  - void → pull `void` with who/when/why;
  - every pull-made record `void`;
  - stock `on_hand` back to the pre-finalize figure per item;
  - each COGS entry `reversed`, its reversal dated the SALES DAY (R12);
  - 1310 and 5110 net to zero for that day.
- T2 (R12 fallback): the sales day's stock month closed, today's open → the reversal dated today, memo
  `[prior period]`; movements dated today.
- T3 (both closed): → the closed-month sentence for today's date, no uuid. Pull still `finalized`, records still
  `posted`, zero reversals.
- ✎R7 T3b (**the all-or-none leg**): a finalized pull with two records at two locations; freeze the SECOND record's
  room with an open count (`count-workflow.ts`; the tester confirms at source that a reversal movement into a frozen
  room is refused, or names another DB-level refusal that hits only the second record). Void → throws. Pull still
  `finalized`, BOTH records `posted`, zero reversal entries, zero reversal movements, `on_hand` unchanged at the
  first room. Assert the first record WAS reached (sort order is the repo's; seed so the frozen one sorts second).
- T4: planned pull → void, zero reversals, status `void`.
- T5: a partly finalized pull (direct only) → its direct records reversed, the pull void.
- T6: a second void → *"already voided"*; a blank reason → its sentence. No uuid in either.
- T7 (✗ first): no `void_usage_record` → `AuthorizationError`, even on an already-void pull (T-364 order).
- T8 (R10, red on HEAD): `voidUsage` on a pull-made record → R10's sentence; nothing reversed. Control: a hand-entered
  usage record still voids. After the pull is voided, the record is `void` and the existing "not posted" refusal
  applies.
- T9 (R11, the path that was dead): an UNVERIFIED day with a pull → withdraw refused with the new sentence → void the
  pull → withdraw succeeds. Second leg: T-373 T12's shape (verified D1 with a finalized pull, D1 voided, replacement
  D2) → `buildPlan(D2)` refused (R7) → void D1's pull → `buildPlan(D2)` builds.
- T10 (race, R9): A holds `voidPosUsagePull` uncommitted; B runs `finalizeSections` on the same pull. B is observed
  waiting (`wait_event_type = 'Lock'`). A commits. B → *"this pull has been voided"*, and zero new usage records.
  Red on HEAD's `finalizeSections` read path once the void exists (mutant: plain `getPull` in finalize).
- T11 (schema): raw `update pos_usage_pulls set status = 'void'` without `voided_by` → refused by
  `pos_usage_pulls_void_shape_check`; with all three and a blank reason → refused.
- T12 (web): `voidPullAction` → the ok banner with the count; the loader shows no live pull for the day.
- Mutants:
  - void records but not the pull → T9 red;
  - `voidedOn = toBusinessDate()` always → T1's date leg red;
  - ✎R7: drop step 6's up-front check of the chosen date → T3 still refuses (on the first record, before a write),
    so this is pinned by T3's sentence and zero-write legs, not killed; listed for honesty;
  - catch the per-record throw and carry on (mark the pull void anyway) → T3b red;
  - ✎R8: R10's check moved into `voidPullUsageRecord` (so the pull's own void refuses itself) → T1 red;
  - drop the R10 check → T8 red;
  - authorize after the lock → T7 red;
  - finalize without `getPullForUpdate` → T10 red.

**Migration:** yes, **0181**. Prove it on a scratch DB first (ADR-012 §5 step 8). Gate: the FULL integration suite on a
fresh gate DB, tree frozen. `pos-usage-pull.test.ts` and `t373-s1-*` stay green unchanged.
**Production precheck (before the deploy that ships S7):** the orchestrator runs the 0181 precheck read-only on
production. A non-zero count stops the push.

**Smoke (9008, `shareat_test_setup`):**
1. Build and finalize a pull with the stubbed snapshot.
2. Void it with a reason → banner with the count. `/inventory/usage` shows its records void.
3. Build again for the same day → builds.
4. On `/inventory/usage/[id]` of a live pull's record, Void → R10's sentence.
5. Withdraw an unverified day that has a pull → the new sentence. Void the pull, then withdraw → succeeds.
Screenshots of 2, 4 and 5.

**Not in S7:** changing T-373 Q1's default; a pull "revise" (v1's void-and-recreate in one step). Void then build is
two clicks and keeps each step auditable.

---

## Out of scope
- N1: `fixed-assets/actions.ts:69` `Number(lifeRaw)` accepts `0x10` as 16. A lax parse, not a substitution. The
  orchestrator may file it.
- N2: `CAPABILITY-MATRIX.md:70`'s stale "refuses the branch outright" (T-372 S6). The orchestrator's, at wrap-up.
- The census E sites (correct today, ratcheted). `findings/page.tsx`' seed-window parity.
- The domain refusal wording in `resolveDiscrepancy` (`'only the dispatching commissary may resolve this…'`, lower
  case, Outcome reason). Shown on the page as is.
- The bible, the register, the GLOSSARY: the orchestrator's.

## Done when
- S1–S7 green; each red leg shown red on HEAD or against its named mutant before the build.
- Typecheck clean. The unit suite passes, including the new guard, `domain-actions-have-callers`,
  `route-capability-coverage` and `migration-journal`. The FULL integration suite passes on a fresh gate DB for S7,
  and before any push.
- Each slice's smoke on 9008 with screenshots. `npm run build` passes with the dev server stopped. Touched files are LF.
- Each builder touched only its BUILDER paths; each tester only its TESTER paths.
- The orchestrator, at wrap-up:
  - marks DEF-574, 576, 577, 578, 579, 580 fixed with hashes;
  - applies the ✎ corrections (577's 37 sites, ✎R1; 579's specimen gone and the three real sites; 580's
    parity rule);
  - records Q1's answer and files N1 if wanted;
  - fixes N2;
  - runs S7's production precheck before the deploy.

## Questions only Ian can answer
- **Q1 (t374-q1-pull-void-who): Who may void a day's POS usage pull?**
  - Example: Lipa's 28 September usage (₱8,000 of meat) was pulled from POS and posted. Then POS corrected two
    receipts. Voiding the pull puts the ₱8,000 of stock back and reverses its cost, so the day can be pulled again
    with the right figures.
  - (a) **The people who may void a usage record today: managers, admins, super admins** (recommended). A pull void is
    exactly a set of usage-record voids. v1 lets a manager with the "void records" right do it. No new permission.
  - (b) A new permission, admins and super admins only. Stricter, because a whole day's cost moves at once.
  - (c) Anyone who may finalize a pull (also managers and up today). Same people as (a) now, but it would follow the
    finalize right if that ever widens.
  - Default the build uses: (a).

## Ruling log
- 2026-10-04, planner: R1–R13 above. S7 takes migration **0181**. No advisory lock namespace is taken. The census
  corrects three register rows (577 wider, 579's specimen gone, 580's proposed rule wrong for even chains).
- 2026-10-04, independent Opus review: 8 changes (✎R1–✎R8). R1 census 36→37 (`prepaid/lib.ts:96`); R2 guard also
  bans `getUTC*` on a current instant and a local `now`; R3 S3's "drop depth → T3 red" was wrong (T2, T4), CTE walks
  up; R4 S4's T7 mutant unobservable (one transaction), struck; R5 `lineCount` is already after `authorize`; R6 array
  input passes through; R7 S7 checks the chosen date once up front, all-or-none proven by a frozen-room T3b; R8 no
  bypass flag on `voidUsage`, an actor-less core instead. Verified at source and unchanged: journal `when`
  1801711907084, DEF-580 parity on A→R1→R2→R3, the 3 DEF-579 sites, `[prior period]` (stock period = fiscal period,
  `period-guard.ts:40`), pull grants (0127 predates 0169), file-disjointness with the uncommitted T-369 work except
  S5's noted `expenses/actions.ts` wait.

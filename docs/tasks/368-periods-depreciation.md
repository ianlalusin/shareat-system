# T-368: Periods and depreciation — DEF-424, 426, 433, 434, 435, 441, 442, 436

**Status:** APPROVED 2026-09-30 (orchestrator, after independent Opus review; its eight CHANGES folded in). Written 2026-09-30 by the Opus planner for the money-defect push
(Ian, 2026-09-30: *"close all open money defects in v2"*). Census: `docs/plans/money-defects-2026-09-30.md`, batch C.
**Model:** Sonnet for every slice, tester first, then builder. Any spec amendment is written in plan mode (Opus).
**Line numbers** were checked at HEAD `3ed900f`.
**Order against other lanes:**
- **S4 runs after T-366 lands.** T-366 (DEF-406) edits `packages/db/src/repo/findings.ts:753`. S4 edits the same file
  at `:195-240`, which is a different function, but the two must not share a working tree.
- **S2 and S3 each touch one page that T-348 S3 (DEF-440) currently has dirty in the tree**:
  `apps/erp/src/app/admin/stores/[id]/page.tsx` and `apps/erp/src/app/fixed-assets/new/page.tsx`. The app-page part of
  those slices waits until T-348 S3 is committed. Their domain parts do not have to wait.
- **Migration:** yes, exactly one, in S0: **`0173`** (Ian, 2026-09-30: T-366 = 0172, T-368 next, T-372 after).

---

## ✅ Ian's rulings (2026-09-30)

The HANDOFF item *"fiscal-period cleanup (DEF-424/426/433/434/439)"*, which was proposed on 2026-09-26/27 (git
`bf6741c`, `567a564`) and carried as "not approved", is now answered:
- **Q0: YES.** S0, S1 and S4 are approved. Ian accepts that no month can close while an earlier month has no period.
  The orchestrator records this as a bible §13 row.
- **Q1: option (b), restate.** S3's lock ships first. The restate flow is reserved as the named follow-up slice
  **S5** (below). It depends on S0.4 excluding reversals.

DEF-439 (the `/findings` page offers a Close button for a month that has no period) was in the old proposal. The
census left it out because it is not money. It stays out of this task (see Out of scope).

---

## Census, verified at source (corrections marked ✎)

| DEF | Verified | Where | Notes |
|---|---|---|---|
| 424 | ✅ | `packages/domain/src/fiscal-periods/index.ts:62` (`closeBlockers` → `hasEarlierOpenPeriodBefore`, `repo/fiscal-periods.ts:199-206`, which checks `status = 'open'` only); `close-year.ts:58` asks the same question | A missing month is invisible to both closes. |
| 426 | ✅ | `repo/fiscal-periods.ts:159-178` matches `starts_on`/`ends_on` against whole-month bounds | A partial OPEN period never matches, so it can never close. While it stays open, `hasEarlierOpenPeriodBefore` blocks every later close. **✎ No code path creates a partial open period.** `seedCalendarMonths` makes whole months, and `insertFilledPeriod` makes closed/locked rows only (0160's `fiscal_periods_fill_shape_check`), so only hand SQL can. The fix is therefore to forbid the shape. |
| 433 | ✅ | **✎ `packages/domain/src/scheduler/index.ts:1100-1105`**, not `fiscal-periods/index.ts:62` (census) and not `:~583` (register) | The forward window `seedCalendarMonths(M, 12)` runs before and regardless of `classifyHoles`. **✎ The register calls 0160's guard "BEFORE INSERT". It is `AFTER INSERT … FOR EACH STATEMENT` with a transition table** (`0160:195-198`). The effect is the same: inserting a missing month M+k as `open` when a later month is closed raises, the whole org transaction aborts, and the B/C failure lines computed afterwards are never written. |
| 434 | ✅ | `packages/db/src/repo/findings.ts:201-206` (the `ran` CTE counts `scheduler_runs` rows whatever their `outcome`/`failed_count`), gate at `:216` | **✎ `amortisationNotBooked` has the identical flaw at `:230`**, and it is fixed in the same edit. The domain's `periodicPostingsStillMissing` (`domain/findings/index.ts:160-186`) already asks the ledger which subjects owe P with no entry, but it only runs on findings the repo emits, and the run-count gate suppresses them first. **✎ An existing test asserts the defect:** `packages/domain/tests/integration/findings.test.ts:226-235`, *"a no-op run still counts as having run"*, inserts an `ok` run row with no entry and expects silence. |
| 435 | ✅ | Ordinary run: `fixed-assets/depreciate.ts:148` uses the fixed key `asset:{id}:depreciation:{P}`, so after a reversal `postEntry` finds the key taken and returns `created:false`, which means the month is silently never re-posted. Catch-up: `missed-months/index.ts:150-161` refuses outright. The link table `missed_month_adjustments` has UNIQUE `(org_id, fixed_asset_id, belongs_to_period)` (`0161`), which would refuse a second link anyway. | **✎ The census understates the reach.** DEF-435 is also why T-346 refuses in-service moves (`in-service.ts:186-191`, `stores/service.ts:345-351`: *"which this cannot do yet (DEF-435)"*). Prepaid solved the same problem already with `prepaidRepo.nextRevisionKey` (`repo/prepaid.ts:370-377`, `#N` suffix, used at `prepaid/index.ts:255-266`). Every depreciation key reader already accepts `#N` (`repo/fixed-assets.ts:474,499,564,587`; 0161 check 2; 0163's `substring`). |
| 441 | ✅ | `in-service.ts:194` and `stores/service.ts:354` gate on `confirmReversal: boolean`. Both actions set it from a hidden `confirmReversal=1` (`fixed-assets/[id]/page.tsx:210`, `admin/stores/[id]/page.tsx:230`) | The confirm pins the intent, not the set of entries shown. |
| 442 | ✅ | `fixed-assets/capitalize.ts:79-146` (`runCreateAsset`) never reads the store. The form's list is `listStores` (`apps/erp/src/app/expenses/lib.ts:64-72`, unfiltered), re-exported by `fixed-assets/lib.ts:12` | No domain function anywhere checks `stores.is_active` today. |
| 436 | ✅ **✎ LIVE, not latent** | `apps/erp/src/app/fixed-assets/actions.ts:92-125` `updateTermsAction` → `fixedAssetsRepo.updateTerms` (`repo/fixed-assets.ts:320-336`), shipped with T-124 (2026-08-26) | The census says "no writer yet", but there is one on `/fixed-assets/[id]` today. It writes `useful_life_months`, `interval` and `salvage_value` on any active asset, posted months or not, and it also bypasses the domain (app → repo, with its own `authorize`). Auto-capitalised `needsReview` assets are depreciated by the run (`depreciate.ts` has no `needsReview` gate), so the case "an admin reviews the default terms after the first run" is the normal path. |

**Found in passing (bible row 164; the orchestrator logs it as a new section-E row, `reported`):**
`packages/db/src/repo/prepaid.ts:356` builds `and(eq(org_id), sql\`key = base or key like base#%\`)`. Drizzle's `and()`
does not parenthesise each operand, so the SQL is `org_id = $1 and key = $2 or key like $3`, and the LIKE branch escapes
the org filter. The keys embed the item uuid and RLS backstops the query, so there is no live leak, but it is a tenancy
filter that does not filter. S2's depreciation twin of this function must not copy the shape.

---

## Goal (bible §1.2d)
1. **v1** has no fiscal-period model at all, and its depreciation "stopped silently for two months" (DEF-044). The v2
   machinery that exists to prevent that (T-264, T-276, T-344, T-345, T-346) has the eight holes above.
2. **The goal.** Books close in order, with no month missing behind a close. A month counts as booked only when the
   ledger says so. A reversed charge can always be put back. A confirm acts on exactly what was shown. A posted month
   never changes under an asset's feet.
3. **Live data.** Production is in its pilot (row 108). Each DB guard below has a pre-flight or is transition-only,
   so bad existing data is named, never silently rewritten.
4. **The v2 bar.** Each rule is enforced twice, in the domain for the sentence and in the database as the guarantee
   (RULES §6 item 3; bible §15.11, "no layer may be the only one").

---

## Slices (sequential: S0 → S1 → S2 → S3 → S4)

### S0 — the one migration (DEF-424, 426, 435, 436 backstops)
**Hand-authored** per ADR-012 §5. Index **`0173`** (Ian: T-366 = 0172). Name it `0173_t368_periods_depreciation_guards.sql`. Edit `_journal.json` in order, after 0172, with its `when` on the
one-day grid. Journal entry per the §5 checklist (the
one-day `when` grid, `migration-journal.test.ts`). No new table, so there is no `classification.ts` or
`rls/registry.ts` entry.

1. **DEF-426 — an OPEN period is a whole calendar month.**
   - Pre-flight `DO` block in 0160's style: if any `status = 'open'` row is not exactly one whole calendar month,
     `RAISE` naming the org, `starts_on` and `ends_on`, and apply nothing.
   - Then add `CHECK fiscal_periods_open_whole_month_check`: `status <> 'open'` OR (`starts_on` is the 1st of its
     month AND `ends_on` is that month's last day).
   - Mirror the CHECK in `packages/db/schema/fiscal-periods.ts`.
   - Closed/locked part-month pieces (T-344 Q4) stay legal.
2. **DEF-424 — no close or lock over a missing month.**
   - A new `AFTER UPDATE … REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT` trigger. It
     is statement-level for 0160's reason: multi-row year locks.
   - Register it in `packages/db/src/triggers/registry.ts` as `mode: 'origin'`, `kind: 'validator'`. It reads other
     rows' current state, so it must stay silent on replay (not ALWAYS).
   - For every row whose status moved INTO `closed` or `locked`, the org's periods starting before that row's
     `starts_on` must cover `[min(starts_on), row.starts_on - 1]` with no gap.
   - Periods never overlap (the EXCLUDE constraint), so "no gap" is the same as
     `sum(ends_on - starts_on + 1) = row.starts_on - min(starts_on)`.
   - On a gap, `RAISE` naming the first uncovered date.
   - Take the same per-org advisory lock as 0160 (`hashtextextended('fiscal_periods:' || org_id, 0)`) before
     checking.
   - **INSERT is deliberately not guarded.** T-344's fill inserts closed pieces, and filling holes in any order is
     harmless.
3. **DEF-435 — a reversed catch-up can be linked again.**
   - `DROP` the two unique indexes `missed_month_adjustments_org_{asset,prepaid}_period_unique` and recreate them as
     plain (non-unique) indexes on the same columns, because `findLink` reads by them.
   - Add **check 6** to `missed_month_adjustments_guard()` with `CREATE OR REPLACE`, keeping checks 1-5 byte-identical:
     refuse the insert if another link row for the same `(org_id, subject, belongs_to_period)` points at an entry
     whose `status = 'posted'`.
   - ⛔ Check 6 is a plain `SELECT`, never `FOR UPDATE`/`FOR SHARE` on `missed_month_adjustments`. 0170 revoked the
     app role's UPDATE on that history table (bible row 243), and the trigger runs as `shareat_app`, so a locking read
     raises 42501.
   - The race between two re-books is serialised by the journal's own `(org_id, idempotency_key)` unique index,
     because both would compute the same `#N`.
4. **DEF-436 — a posted month's terms never change.**
   - `BEFORE UPDATE ON fixed_assets FOR EACH ROW WHEN ((OLD.useful_life_months, OLD.interval, OLD.salvage_value,
     OLD.cost) IS DISTINCT FROM (NEW.…))`.
   - `RAISE` if any `journal_entries` row with `source_type = 'depreciation'`, `source_id = NEW.id::text`,
     `status = 'posted'` **and `reversal_of_entry_id IS NULL`** exists.
   - ⛔ The reversal filter is load-bearing. `reverseEntry` copies `sourceType`/`sourceId` onto the reversal
     (`ledger/reverse-entry.ts:190-191`), and the reversal is itself `posted`. Without the filter, a fully reversed
     asset would lock forever and S5 could never run. An original whose reversal exists has `status = 'reversed'`
     and is excluded by the status test.
   - Register it in `triggers/registry.ts` as `mode: 'origin'`, `kind: 'validator'`, for the same reason as S0.2. The message is `fixed_assets: % already has depreciation posted; its useful life,
     interval, salvage value and cost can no longer change`.
   - Reversed entries do not count.
   - T-347's shell activation (`repo/fixed-assets.ts:366`) sets cost on a shell with no posted depreciation, so it
     passes.

**BUILDER (source):** `packages/db/migrations/0173_t368_periods_depreciation_guards.sql` · `packages/db/migrations/meta/_journal.json` ·
`packages/db/src/triggers/registry.ts` (two new `origin`/`validator` entries) ·
`packages/db/schema/fiscal-periods.ts` · `packages/db/schema/missed-month-adjustments.ts` (unique → index).
**TESTER:** `packages/db/tests/integration/t368-migration.test.ts`.

### S1 — periods in the domain (DEF-424, 433)
- **`repo/fiscal-periods.ts`:** add `firstCoverageGapBefore(tx, orgId, beforeDate): { startsOn, endsOn } | null`.
  It returns the earliest uncovered range between the org's first period and `beforeDate - 1`, and it reuses
  `coverageHoles`' walk. Holes before the first period are not holes.
- **`closePeriod` (`fiscal-periods/index.ts`):** after the drafts/findings/earlier-open checks and before the write,
  a missing earlier range refuses with `refuse()`:
  - Raw: `closePeriod: {period} cannot close — {s}..{e} has no fiscal period. Periods close in order.`
  - User message: `{s} to {e} is missing from the books. Periods close in order, so {period} cannot close until it
    exists.` When `classifyHoles` puts that piece in class B/C, append ` An administrator can create it with "Create
    the missing month" on the findings screen.` When it is class A/D, append ` The monthly fiscal-period job creates
    missing months in open books.`
  - The check does **not** go into `closeBlockers`. `createMissingClosedPeriod` uses that, and it must stay able to
    fill holes in any order.
- **`closeYear` (`close-year.ts`):** the same check against next January 1. The sentence is the same, with the year.
- **The seed job (`scheduler/index.ts:1096-1105`):** drop the unconditional `seedCalendarMonths(M, 12)`.
  - Insert only months ≥ M that `classifyHoles` returned as **whole class-A** pieces, grouped into contiguous runs
    exactly like the elapsed-A loop below it (one `seedCalendarMonths` call per run).
  - `windowInserted` counts those inserts. `windowSkipped` = 12 − windowInserted, which keeps the detail string's
    shape.
  - Class B/C/D months ≥ M are reported by the existing loop and never inserted.
  - The zero-period branch (`:1061-1087`) is unchanged.

**BUILDER:** `packages/db/src/repo/fiscal-periods.ts` · `packages/domain/src/fiscal-periods/index.ts` ·
`packages/domain/src/fiscal-periods/close-year.ts` · `packages/domain/src/scheduler/index.ts` (the
`runFiscalPeriodSeedForOrg` body only).
**TESTER:** `packages/domain/tests/integration/t368-periods.test.ts`.

### S2 — re-book after reversal, and pin the confirmed plan (DEF-435, 441)
- **Revision keys for depreciation.** Add `fixedAssetsRepo.depreciationEntriesForPeriod(tx, orgId, assetId, period)`
  and `depreciationRevisionKey(assetId, period, existing)`, prepaid's shape (`base`, or `base#N` with N = count + 1).
  **Parenthesise the OR** (see "Found in passing").
- **The run (`depreciate.ts` `postPeriodsFor`):**
  - Read `postedDepreciationPeriods` once and skip every period already effective.
  - For each remaining owed period, post with the revision key.
  - ⛔ The skip is load-bearing. Without it every run posts `#2`, `#3`, … (leg R2).
- **Catch-up (`missed-months/index.ts:150-161, 199-206`):** delete the "reversed → cannot re-book" refusal. The
  `alreadyEffective` check stays and is the gate. The depreciation key uses the revision key.
  - `missedMonthsRepo.findLink` returns the newest link (`order by created_at desc`).
  - `isLinkCollision` and its constraint-name set become dead, so delete them (zero-caller guard, DEF-186).
- **Lift the DEF-435 conflict.**
  - In `planInServiceReversal` (`in-service.ts:85-121`), drop `conflict` and the `reversedDepreciationPeriods` read.
    That read is its only caller, so delete the repo function too.
  - Delete the two "cannot do yet (DEF-435)" throws (`in-service.ts:186-191`, `stores/service.ts:345-351`).
  - A month the new schedule owes at a different amount is simply reversed. It re-posts on the next run if its
    period is open, or is listed by T-345 if its period is closed (T-346 §3.4's existing text for newly-owed months).
- **Pin the plan (DEF-441).**
  - `planToken(entries)` = the first 16 hex chars of sha-256 over the sorted `entryId`s joined by `,` (`node:crypto`;
    the domain already uses it in `files/index.ts`). For the store cascade, the ids of every affected asset go into
    one token.
  - Replace `confirmReversal?: boolean` with `confirmedPlan?: string` on `SetAssetInServiceInput` and on
    `setStoreOpeningDate`'s input.
  - With a non-empty plan and no `confirmedPlan`: throw `refuse()` as today, with the message still ending
    `confirm to proceed` and a `planToken` property on the error.
  - With a `confirmedPlan` that differs from the recomputed token: throw the same shape with the **new** token. The
    user message starts `What this would reverse has changed since you confirmed.`, then the new list. Nothing is
    written.
  - With a match: proceed.
  - Actions (`fixed-assets/actions.ts:137-167`, `admin/stores/actions.ts:192-214`) carry `plan=<token>` in the
    confirm redirect. The pages resubmit it as hidden `confirmedPlan`.

**BUILDER:** `packages/db/src/repo/fixed-assets.ts` · `packages/db/src/repo/missed-months.ts` ·
`packages/domain/src/fixed-assets/depreciate.ts` · `packages/domain/src/fixed-assets/in-service.ts` ·
`packages/domain/src/stores/service.ts` · `packages/domain/src/missed-months/index.ts` ·
`apps/erp/src/app/fixed-assets/actions.ts` · `apps/erp/src/app/fixed-assets/[id]/page.tsx` ·
`apps/erp/src/app/admin/stores/actions.ts` · `apps/erp/src/app/admin/stores/[id]/page.tsx` (⛔ after T-348 S3 commits).
**TESTER:** `packages/domain/tests/integration/t368-depreciation-rebook.test.ts` · `apps/erp/tests/t368-confirm-plan.test.ts`.
The TESTER also rewrites the legs that assert the defect, and names each one in the report:
- `t345-missed-month.test.ts` A16 (`:727-752`) becomes "re-book succeeds".
- `t346-in-service-date.test.ts` I8 (`:432-460`) and I13 (`:577-620`) become "reverses, no DEF-435".
- Every `confirmReversal: true` in `t346-in-service-date.test.ts` and `t346-store-opening-date.test.ts` becomes a
  real token taken from the first refusal.

### S3 — asset terms through the domain, and no asset at a deactivated store (DEF-436, 442)
- **New `updateAssetTerms(tx, actor, assetId, input)`** in `packages/domain/src/fixed-assets/terms.ts`, exported from
  the index.
  - `authorize('manage_fixed_assets')` comes first, then parsing. The life parse moves here from the action, with the
    same `refuse()` sentence.
  - ⛔ **Race:** its first read is `SELECT … FROM fixed_assets WHERE id = … FOR UPDATE`, and so is the run's first
    read in `postPeriodsFor` (`depreciate.ts`). A terms change and a run on the same asset then serialise: whichever
    commits second sees the other's result.
  - It reads the asset and `postedDepreciationPeriods`. If any are posted and `usefulLifeMonths`, `interval` or
    `salvageValue` differs from the row, refuse, with nothing written:
    - Raw: `updateAssetTerms: {name} has depreciation posted for {first}–{last}; its useful life, interval and
      salvage value can no longer change`.
    - User message: `{name} has already been depreciated ({first} to {last}), so its useful life, interval and salvage
      value can no longer be changed. Name, category and notes can still be edited.`
  - Otherwise call `fixedAssetsRepo.updateTerms` as today, which also clears `needsReview`.
  - The S0 trigger is the backstop.
- **`updateTermsAction`** calls `updateAssetTerms` and nothing else. Remove its inline `authorize` and repo call.
- **`runCreateAsset` (`capitalize.ts:79`):** after `authorize`, `storesRepo.getById(tx, orgId, input.storeId)`.
  - Missing → `gone(…, 'store')`.
  - `!isActive` → `refuse('createAsset: store {code} is deactivated', '{name} is deactivated. An asset cannot be added
    at a store that is no longer active.')`.
  - `capitalizeFromExpense` is **unchanged**. Refusing there would block an expense approval over a store flag, which
    is out of scope.
- **Form list:** add `listActiveStores(orgId)` in `apps/erp/src/app/fixed-assets/lib.ts` (`is_active = true`) and
  use it in `new/page.tsx:27` only. The register and `[id]` pages keep `listStores`, because they must still name
  assets at inactive stores.

**BUILDER:** `packages/domain/src/fixed-assets/terms.ts` (new) · `packages/domain/src/fixed-assets/index.ts` ·
`packages/domain/src/fixed-assets/depreciate.ts` (the `FOR UPDATE` read only; S2 already edited the rest) ·
`packages/domain/src/fixed-assets/capitalize.ts` · `apps/erp/src/app/fixed-assets/actions.ts` ·
`apps/erp/src/app/fixed-assets/lib.ts` · `apps/erp/src/app/fixed-assets/new/page.tsx` (⛔ after T-348 S3 commits).
**TESTER:** `packages/domain/tests/integration/t368-asset-terms-store.test.ts` · `apps/erp/tests/t368-asset-forms.test.ts`.
`apps/erp/tests/integration/t343-s5-5q-followups.test.ts` T1–T3 call `updateTermsAction` and must stay green. If a
refusal sentence there changes because the parse moved into the domain, the TESTER rewrites that assertion and names
it in the report.

### S5 — RESERVED (Ian Q1 = b): restate an asset's terms — follow-up, not built in this task
Changing useful life, interval or salvage on an asset with booked months will:
1. Plan every effective depreciation entry for the asset.
2. Show the same confirm as the in-service date, pinned by S2's `planToken`.
3. Reverse every booked month (`[prior period]` for closed ones).
4. Write the new terms. This passes S0.4, because only reversals and `reversed` originals remain.
5. Leave re-booking to the next run (open months) and to `bookMissedMonth` (closed months), both on S2's `#N` keys.

It depends on S0.4's reversal filter and on S2. The orchestrator specs it as its own task after T-368 lands. S3's
refusal is the interim behaviour.

### S4 — a failed run does not count as booked (DEF-434) — ⛔ after T-366
- In `periodicPostingsMissed` (`repo/findings.ts:182-247`), delete the `ran` CTE and both run-count conditions.
  - Emit the provisional `depreciationNotBooked:P` whenever `depreciable > 0`, and `amortisationNotBooked:P` whenever
    `prepaid > 0`.
  - The domain's `periodicPostingsStillMissing` stays the only judge: it drops the finding when no subject owes P
    without an entry. That makes "booked" mean "an effective entry exists", whatever `scheduler_runs` says.
  - The detail wording is unchanged.
- Update the function's header comment: "the ledger, not the run log".

**BUILDER:** `packages/db/src/repo/findings.ts` (`periodicPostingsMissed` only).
**TESTER:** `packages/domain/tests/integration/t368-findings-failed-run.test.ts`, and a rewrite of
`findings.test.ts:226-235` ("a no-op run counts") into "a run that posted the entry clears it".

---

## Contract
- A month may close or lock only when every earlier month since the org's first period has a period, in the domain
  (sentence) and the DB (S0.2).
- An open period is always one whole calendar month (S0.1).
- The seed job never inserts an open month in front of a closed one. It reports it instead.
- `depreciationNotBooked:P` / `amortisationNotBooked:P` clear only when the ledger holds an effective entry for every
  subject owing P.
- For every period, an asset has at most one effective (posted) depreciation entry. A reversed period can be posted
  again, as `…#N`, by the run (open month) or by `bookMissedMonth` (closed month).
- A reversal confirm executes only the exact entry set whose token it carries.
- Useful life, interval, salvage value and cost are immutable once any depreciation entry for the asset is posted.
- `createAsset` refuses a deactivated or missing store.

## Invariants (cite)
- Periods close in order: ADR-006 §7.4, bible §13 rows 100 and 103. Closed books are never rewritten, only corrected
  by reversal in an open month (row 193; T-106, `POSTING-PATTERNS.md:1220-1241`).
- Depreciation posts per asset per period (row 140), always `depreciation.monthly`'s two legs, DR 6700 / CR 1590
  (`POSTING-PATTERNS.md:361-373`). S2 adds no new posting pattern, only a key suffix.
- The DB enforces, the domain explains (RULES §6 item 3; §15.11). Every rule above has both layers.
- Every gate stays inside the domain function, never trusted from the caller (`fiscal-periods/index.ts` header).
- `authorize()` comes before any parse (T-352 pattern; DEF-496/497).
- Money is never a float (§2.5). Amounts come from the schedule, never typed (T-345 §3.4).
- The T-344 fill action keeps its current gates. Holes may be filled in any order.

## Tests (TESTER first; real Postgres; raw red recorded per leg; every ⛔ asserts nothing was written)
Red today means on `main` with the earlier T-368 slices applied.

**S0 — `t368-migration.test.ts` (raw SQL on the migrated test DB)**
| Id | Leg | Target | Red today | Mutant it kills |
|---|---|---|---|---|
| M1 | insert `open` 2027-03-10..2027-03-31 | 23514 on `fiscal_periods_open_whole_month_check` | inserts | CHECK dropped |
| M2 | **+control:** insert a closed T-344-shaped part-month piece; insert an `open` whole month | both succeed | green (guard) | CHECK written as "every period whole" |
| M3 | pre-flight: run the DO block against a DB holding a partial open row | raises naming org and dates | n/a (new) | pre-flight removed |
| M4 | org 2027-02 closed, 03 missing, 04 open → `update … status='closed'` on 04 | raises naming 2027-03-01 | succeeds | guard deleted, or guard checking only `open` rows |
| M5 | **+control:** same org, fill 03 as a closed piece, then close 04 | succeeds | green | guard counting a hole that has been filled |
| M6 | 2026 all closed except one missing month → `lockYearPeriods`-style multi-row `closed→locked` | raises | succeeds | guard firing only on `open→closed` |
| M7 | link A (entry reversed) exists → insert link B for the same asset+P with a posted `#2` entry | succeeds | 23505 | unique index kept |
| M8 | **⛔ +control for M7:** link A's entry still **posted** → insert link B | raises check 6 | 23505 (a different error: assert the message) | check 6 missing |
| M9 | asset with a posted depreciation entry: update `useful_life_months`; then `interval`; `salvage_value`; `cost` (4 legs) | each raises | each succeeds | guard's WHEN list missing a column |
| M10 | **+control:** same asset, update `name`/`category`/`notes`; a second asset whose only entry is **reversed**, update life | all succeed | green | guard counting reversed entries |
| M10b | post depreciation through `postEntry`, reverse it through the real `reverseEntry` (the reversal carries `source_type='depreciation'` and the same `source_id`), then update `useful_life_months` | succeeds | n/a (new guard) | the `reversal_of_entry_id IS NULL` filter dropped |
| M11 | `triggers/registry.ts` lists both new triggers as `origin`/`validator`; `pg_trigger.tgenabled = 'O'` for both | pinned | fails | registered ALWAYS, or not registered |

**S1 — `t368-periods.test.ts`**
| Id | Leg | Target | Red today | Mutant |
|---|---|---|---|---|
| P1 | `closePeriod('2027-04')`, with 02 closed, 03 missing, 04 open | rejects with the class-B user sentence naming 2027-03-01 to 2027-03-31 and "Create the missing month"; 04 still open | S0's raw trigger text (not the sentence) | domain check deleted (DB text surfaces) |
| P2 | **+control:** `createMissingClosedPeriod` for 03, then close 04 | 04 closed | green | check computing the gap after filling |
| P3 | **+control:** org whose first period is 2027-02, close 2027-02 | closes | green | gap measured from 0001-01-01 instead of the first period |
| P4 | `closeYear(2026)` with 2026-06 missing | rejects with the year sentence; nothing locked | raw trigger text | closeYear check deleted |
| P5 | fill action on 03 while 2027-01 is **also** missing (fill the later hole first) | succeeds | green | check put into `closeBlockers` |
| P6 | seed job, `nowMs` pinned so M = 2027-02; 02 and 03 closed, 04 missing, 05 closed | outcome not error; 04 still absent; a failure line `month 2027-04 is missing inside closed books…`; 06..2028-01 inserted open | run errors with the order-guard text; no B line | window left unconditional |
| P7 | **+control:** full-coverage org | `inserted 0 · skipped 12`, no failure; a tail-gap org still gives t276 case 4's exact string | green | window counting wrong |

**S2 — `t368-depreciation-rebook.test.ts` (and `apps/erp/tests/t368-confirm-plan.test.ts`)**
| Id | Leg | Target | Red today | Mutant |
|---|---|---|---|---|
| R1 | run P (open), `reverseEntry`, run P again | one posted entry for P, key `asset:{id}:depreciation:P#2`, `created:true` | `created:false`, P unbooked | fixed key restored |
| R2 | **⛔ +control:** run P twice with no reversal | exactly one entry for P, no `#2` | green | the "already effective" skip removed |
| R3 | `bookMissedMonth` P (closed), reverse it, book P again | succeeds; `#2`; 2 link rows, 1 posted | `/cannot re-book it/` | refusal kept |
| R4 | **⛔ +control:** book P while an effective entry exists | `/already booked/`, nothing written | green | `alreadyEffective` removed |
| R5 | t346 I8's shape (a kept month at a different amount), with a valid token | succeeds; the month reversed; the next run in its open period posts `#2` at the new amount | `/DEF-435/` | conflict kept |
| R6 | `setAssetInService`, no token → error with `planToken` T1; then a run posts one more month; resubmit with T1 | refused, "has changed since you confirmed"; new token ≠ T1; 0 entries reversed | reverses the new set | token ignored when present, or token over count+first+last only (the leg adds a month in the middle of the range: assert ids) |
| R7 | **+control:** resubmit with the current token | reverses exactly the planned entry ids | n/a | — |
| R8 | `setStoreOpeningDate` across 2 followers: R6 and R7 shape, with a follower changed between submits | the same | the same | the same |
| W1 | source pin: both confirm forms carry `name="confirmedPlan"`; neither carries `confirmReversal` | pinned | fails | the page not updated |

**S3 — `t368-asset-terms-store.test.ts` (and `apps/erp/tests/t368-asset-forms.test.ts`)**
| Id | Leg | Target | Red today | Mutant |
|---|---|---|---|---|
| T1 | `updateAssetTerms` on an asset with 2027-02 posted, life 24→36 | refuse with the user sentence; row unchanged | the import fails (no function); via the action, the row changes | domain check deleted (S0 raw text surfaces) |
| T2 | **+control:** same asset, only name/category/notes | written; `needsReview` false | n/a | check comparing all fields |
| T3 | **+control:** asset with no posted entry, life change | written | n/a | check ignoring "posted" |
| T4 | **⛔ ✗ fires:** staff, valid input | `AuthorizationError`; nothing written | n/a | authorize dropped |
| T5 | staff with `usefulLifeMonths: 'abc'` | the same message as T4 (authorise first) | n/a | parse before authorize |
| T6 | `createAsset` at a deactivated store | refuse "…is deactivated…"; 0 asset rows | row created | check removed |
| T7 | **+control:** the same store re-activated | created | green | check inverted |
| T9 | **race, two connections:** A runs `updateAssetTerms` (life change) on an asset with nothing posted and holds its tx open after the `FOR UPDATE` read; B starts `depreciateAsset` through P; A commits, then B continues. Reverse the order in a second leg | first ordering: B blocks until A commits, then posts at the **new** terms. Second ordering (B first): A is refused with the domain sentence, not a raw trigger error | B posts at the old terms while A writes new ones | a `FOR UPDATE` read removed from either side |
| T8 | guard: `capitalizeFromExpense` at an inactive store is unchanged | as today | green | scope creep |
| W2 | source pin: `new/page.tsx` uses `listActiveStores`; `updateTermsAction` imports `updateAssetTerms` and not `fixedAssetsRepo.updateTerms` | pinned | fails | revert |

**S4 — `t368-findings-failed-run.test.ts`**
| Id | Leg | Target | Red today | Mutant |
|---|---|---|---|---|
| F1 | asset owing P, a `scheduler_runs` row with `outcome='error'`, no entry | `depreciationNotBooked:P` hard; `closePeriod(P)` refused | absent; close allowed | gate restored |
| F2 | an `outcome='ok'` run with `failed_count=1`, one of two assets posted | finding, detail `1 asset(s)` | absent | gate restricted to `outcome='ok'` |
| F3 | **+control:** the run posted every asset | no finding; close allowed | green | filter dropped (always fires) |
| F4 | F1 for prepaid (`amortisationNotBooked`) | fires | absent | the fix applied to depreciation only |

**Must stay green (no edits except the named rewrites):** `fiscal-period-close.test.ts`, `t344-*.test.ts`,
`t276-fiscal-period-seed-job.test.ts`, `t345-missed-month.test.ts` (except A16), `t346-*.test.ts` (except the named
legs), `t347-*.test.ts`, `fixed-assets.test.ts`, `findings.test.ts` (except `:226-235`), `scheduler.test.ts`,
`posting-patterns.test.ts`, `tests/unit/t276-scheduler-job-check-mirror.test.ts`, `migration-journal.test.ts`,
`packages/db/tests/integration/t354-trigger-registry.test.ts`, `packages/db/tests/integration/t354-immutability-triggers-always.test.ts`,
`apps/erp/tests/integration/t343-s5-5q-followups.test.ts` (T1–T3; sentence-only rewrites allowed, see S3), and the
full integration suite before the push (RULES §2 DoD).

## §9.4 smoketest (9008, `docs/SMOKETEST.md`)
⚠️ `shareat_test_setup` has every period from Jan 2026 to Jan 2027 CLOSED. **Use a fresh lane smoke DB instead:**
`make-test-dbs.mjs shareat_test_t368` + `bootstrap-org` (step 2). That creates 12 **open** months from the current
month (M = 2026-10 if run in October), then forge a session and `npm run start` on 9008. Otherwise, on
`shareat_test_setup`, date everything 2027-02 or later.
1. **S1.** SQL on the lane DB (fixture only): delete the empty period M+2. On `/findings`, close M; that succeeds.
   Try to close M+1; that succeeds (M+2 is after it). Close M+3 and screenshot the "missing from the books" banner.
   Then run `fiscal_period_seed` manually and screenshot the M+2 line on the scheduler status.
2. **S2.** Admin: add an asset (active store, in service M) and run depreciation through M. Set its in-service date
   one month later, screenshot the confirm banner, and confirm. Then run depreciation again and screenshot the asset
   page showing M re-posted (`#2` in the entry list, or the booked-months row). For the plan pin, open the confirm in
   a tab, run depreciation for M+1 in another tab, then press Confirm in the first. Screenshot the "has changed" banner.
3. **S3.** On an asset with a posted month, change its useful life and screenshot the refusal. Change its notes and
   screenshot `ok`. Deactivate a second store, open `/fixed-assets/new`, and screenshot that it is not listed.
4. **S4.** Insert an `outcome='error'` depreciation run for an owing month (fixture SQL), then screenshot
   `/findings` showing `depreciationNotBooked`.
Paste the screenshot paths. Staff views rely on T4/T5 and say so.

## Migration
**Yes: one**, hand-authored (ADR-012 §5), in S0: **`0173_t368_periods_depreciation_guards.sql`** (Ian, 2026-09-30:
T-366 = 0172, T-368 = 0173, T-372 after). `_journal.json` is edited in order after 0172, with `when` on the one-day grid.

**Read-only production checks before deploy.** Ian runs these, or approves running them, on `159.223.46.224`, DB of
`shareat-erp`, in a read-only session.
1. **Part-month open periods.** A row here stops S0.1 from applying.
   ```sql
   select org_id, starts_on, ends_on from fiscal_periods
   where status = 'open'
     and (starts_on <> date_trunc('month', starts_on)::date
          or ends_on <> (date_trunc('month', starts_on) + interval '1 month - 1 day')::date);
   ```
2. **Gaps behind closed/locked months.** Each row is a missing range that, after S0.2 and S1, stops the next close
   until an admin creates it. Running this before deploy tells Ian before month-end, not at it.
   ```sql
   with p as (
     select org_id, starts_on,
            lag(ends_on) over (partition by org_id order by starts_on) as prev_end
     from fiscal_periods)
   select p.org_id, p.prev_end + 1 as gap_starts, p.starts_on - 1 as gap_ends
   from p
   where p.prev_end is not null and p.starts_on > p.prev_end + 1
     and exists (select 1 from fiscal_periods c
                 where c.org_id = p.org_id and c.status in ('closed', 'locked')
                   and c.starts_on >= p.starts_on)
   order by 1, 2;
   ```
   Expected: 0 rows. Any row goes to Ian in plain words ("{month} is missing; create it on the findings screen before
   closing {next month}").

## Out of scope
- **DEF-439** (a Close button offered for a missing month). This is app-only. It fits T-369 (app layer), or it could
  be a two-line follow-up once S1 exists. After S1, the domain refuses that close with a proper sentence anyway.
- **S5, the terms-restate flow (Ian Q1 = b).** It is reserved above and specced as its own task after T-368. The
  prospective option (c) was not chosen.
- A store-move writer for assets, and refusing an automatic capitalisation at an inactive store.
- `stores` deactivation refusing while active assets exist.
- Fixing `repo/prepaid.ts:356` (logged, not fixed here).
- DEF-426's alternative (closing a partial period by its own bounds). Forbidding the shape is simpler and nothing
  writes it.

## Done when
- Every red leg above goes red→green, with raw reds recorded. Every +control and guard leg is green before and
  after. Each mutant is proven killed (the builder applies it, the leg goes red, the builder reverts).
- The rewritten legs (t345 A16, t346 I8/I13 and the `confirmReversal` sites, findings.test `:226-235`) are listed in
  the report with the reason "asserted the defect".
- Typecheck is clean. `file <each touched file>` shows LF. The builder touched only BUILDER paths. Unit + full
  integration pass (the solo re-run of DEF-502's two flaky files is allowed). `npm run build` passes with the dev
  server stopped. §9.4 screenshots are pasted.
- **Orchestrator:**
  - DEF-424, 426, 433, 434, 435, 436, 441 and 442 → `fixed (T-368, <commit>)`.
  - Correct the register text of DEF-433 (the trigger timing and `scheduler/index.ts:1100`) and DEF-436 (live
    writer).
  - Log the `prepaid.ts:356` finding.
  - Record Ian's 2026-09-30 rulings (Q0 yes; Q1 = b) as a bible §13 row.
  - Reserve and spec the S5 follow-up (terms restate) as its own task number.
  - Run, or have Ian run, the two production queries under "Migration" before deploy, and report the row counts.
  - GLOSSARY: "revision key: `…:P#N`, a re-post after a reversal; the effective entry is the one posted".

## Questions only Ian can answer
None open. **Q0 = YES** and **Q1 = (b), restate** (Ian, 2026-09-30); see "Ian's rulings" at the top and S5.

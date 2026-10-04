# T-316 — the maintaining balance moves onto the cashier's own drawer

> ### **Status: APPROVED, NEXT (Phase 2 closer) — precondition met (0 rows); T-375 S1 committed (2c9b0f2, 0183); migration 0184**
>
> **Rule (migration order): the next migration takes the next index at build time; never build a higher index before a lower reserved one is committed.** Drizzle orders by `when`, and a higher-index file applied first can leave the lower one silently skipped (DEF-039's failure mode). Reservations: **0184 = T-316, 0185 = T-375 S4.**
>
> Approved 2026-09-14 by `system32-85` (written by lane C, `webapps-f7`, Opus 5). Refreshed 2026-10-04 by the
> Opus planner against HEAD `e79c18c` plus T-375 S1's uncommitted tree. **Every file:line below was re-read at
> that tree.** The refresh is recorded as Amendments A1–A7 (§0). Where an amendment changes the 09-14 text, the
> body below already carries the change. The 09-14 reasoning is kept where it still holds.
>
> ⛔ **The 09-14 arithmetic is NOT buildable as written** (A3). T-319 (DEF-358) and T-324 (DEF-357) have shipped
> since then. Re-checked against them, the approved refusal refuses Ian's own motivating case, and the approved
> detector fires on every declared day. A3 corrected both; ✎S-1 then simplified the refusal to `handedOver ≤ totalOwed` at float stores (question t316-early-handover for Ian). **The orchestrator should
> read A3 before dispatching.** It is a planner correction to a ruled design, not a new ruling.
>
> **Ian, verbatim:** *"attach the till budget to cash cashier account as maintaining balance so when there is no
> sales yet and cashier has to spend something it can draw from there replenish when sales comes and check when
> closing if maintaining balance still complete i guess this mirror the operations better."*
>
> T-136 §9.3 reached the same boundary in August (*"the till already functions as the revolving fund"*). ⛔ This
> is DESIGNED, not ported: v1 has no minimum-balance concept anywhere (RULES §1.2d).

---

# 0. AMENDMENTS (2026-10-04)

| # | What | Source |
|---|---|---|
| **A1** | ⭐ **The §5 precondition was run on production, 0 rows.** It was the read-only query "float/1115 money accounts: ledger balance per store", run with Ian on 2026-10-04 on `159.223.46.224` before any push. Under §5's table, **"the replace is free"**: 0184 replaces the CHECK and migrates nothing. **Re-run it before the push that carries 0184** (bible row 278), because an admin could set a float between now and then. Expected: still 0 rows. | `docs/ops/README.md:18` ("T-316 1115 float money accounts: 0 rows") |
| **A2** | ⭐ **Ian's ruling on the cash count: "before".** The question was §3.4's: do cashiers enter or count the day's cash **before** handing it over, or remit first? Ian (Open Questions page, 2026-09-30): ***cashiers count BEFORE handing over.*** So the cost §3.4 named, "a handover needs the day's cash on record first", **matches how the stores run. It is accepted, not a change to their morning.** Under A3, that cost now applies only to handing over cash from a day that is not yet verified. | bible §13 row 260; `docs/plans/money-defects-2026-09-30.md:104`; `docs/ROADMAP.html:621` ("You ruled count-first (30 Sep)") |
| **A3** | ⛔⛔ **The refusal and the detector are re-derived against T-319 and T-324**, which shipped after 09-14. **(a)** Since T-319, `createRemittance` refuses unless a verified day owes money (`remittance/index.ts:188-213`). Since T-324, the handover is capped at verified `owed` plus an explicitly **declared overage** (`:250-337`). So **"remit ₱8,000 of declared-but-unverified cash" (the old test 3) is now an overage**, never a plain handover. **(b)** ⛔ The 09-14 level rule `posted + declaredUnposted − remit ≥ target` **refuses Ian's motivating case.** The cashier buys ice for ₱500 at 7am (posted on today's still-open date), then remits yesterday's verified ₱5,000 exactly: 24,500 + 0 − 5,000 = 19,500 < 20,000, so it is refused. That is wrong, because today's sales repay the ice ("replenish when sales comes"). The same rule also refuses handing over exactly `owed` after a verified day that spent more than it took. Holding the difference back would book a legitimate expense as an open **shortage variance** on the next day. **(c)** ⛔ The 09-14 detector figure `posted + declaredUnposted − unremittedOwed` reads **"₱8,000 over"** on every day that has declared cash and is not yet verified. That cash is in the drawer but in nobody's `owed` yet. It is the same fires-every-day failure §1.2 exists to remove. **(d)** ⛔ `owed` is **pooled per date across every cashier account** (`repo/remittance.ts:85-108`; T-324 §3.1: `Cashier cash` 1110 + `Cashier online` 1140). So "one account's balance minus pooled owed" is apples against oranges. **Correction: §2–§3 below.** One function returns pooled figures. The refusal bounds only the part of a handover that is **beyond verified `owed`**. The detector compares a figure that ordinary trading cannot move. ✎S-1 supersedes the refusal half of this correction (§3.3); the detector half stands. | re-read at source, this refresh |
| **A4** | ⛔ **`setTillFloat` INSERTS a new `1115` pot** (`domain/src/money-accounts/index.ts:287-331`; `TILL_FLOAT_GL_CODE = '1115'` at `:268`). Under 0184 that insert violates the CHECK. The original "zero new code" assessment missed it. **Fix (S1): `setTillFloat` sets `float_target` on the store's existing `Cashier cash` account (cash, cashier, `1110`) and never inserts.** `balanceOf`'s header (`repo/money-accounts.ts:276-282`) records that the service already refuses a second cash location per custodian, so there is exactly one. | re-read |
| **A5** | ⭐ **T-375 reconciled. The evidence column is `sales_days.cash_collected` on both kinds of store, and T-316 never reads the link.** **Linked store:** `cash_collected` is written only by `importSalesDay` through `withSalesDayDerivation`: Σ cash-tender methods − `refunds` (T-375 R4, R5, R6). So the "declaration" is **the imported day**. **Unlinked store:** it stays the typed figure (`createSalesDay` / `editSalesDay`, T-375 R13). Both post to `1110` at verify (`sales-days/routing.ts:94`, `:261-262`). So the refusal reads one column, filtered by `status in ('open','submitted')`, whichever path wrote it. ⛔ **No `pos_v1_store_links` read and no `source` branch in T-316 code**, and a guard test enforces it (T-S3-6). Consequences: (i) on a linked store, unverified cash can be handed over only after that day is **imported**; (ii) T-375 q4 (a): if POS is unreachable, the day waits, so its cash cannot leave early either; (iii) ordinary handovers of verified `owed` never need today's figure under A3, so neither (i) nor (ii) ever blocks them. ✎S-1: under option (a) the refusal reads no `sales_days` figure at all, so this column matters only if Ian picks (b). **No unresolved conflict with T-375**: T-316 writes no `sales_days` row, so T-375 S4's lock (0185) never sees it. | `docs/tasks/375-pos-v1-day-feed.md` Goal, R4 (`cash_collected` row), R5, R6, R13, ✎V2b |
| **A6** | **Migration 0151 → 0184.** `0151` was never used (the journal jumps 148 → 152, T-324 §10). Journal head committed: **0183** (T-375 S1, `2c9b0f2`, `when` 1801884707084). **T-316 is 0184; T-375 S4 is 0185** (renumbered 2026-10-05: a build of 0185 before 0184 exists could leave 0184 skipped, DEF-039). Its `when` is **re-derived by the builder from the journal head** at build time (ADR-012 §5, `ADR-012-hand-authored-migrations.md:156`), never copied from here. **Rule (migration order): the next migration takes the next index at build time; never build a higher index before a lower reserved one is committed.** Drizzle orders by `when`, and a higher-index file applied first can leave the lower one silently skipped (DEF-039's failure mode). Reservations: **0184 = T-316, 0185 = T-375 S4.** | `_journal.json`; T-375 header |
| **A7** | **Status of the two out-of-scope defects (§8.1):** DEF-357 **FIXED** by T-324 (`1404609`, `d776758`). DEF-358 **FIXED** by T-319 (Ian, 2026-09-17: refuse outright). The A3 design builds on both. | `docs/DEFECTS-REGISTER.md:436-437` |
| **✎S-1** | ⛔ **Decision (planner, 2026-10-04, at the orchestrator's steer): at a float-carrying store the remittance carries NO overage. `handedOver ≤ totalOwed`.** Two sequences re-checked after ✎R still let the float leave, and both came through early handover of unverified cash as a declared overage. **(1)** R1 hands over U's ₱7,500 early. That books an open overage variance and allocates nothing to U (`remittance/index.ts:386-408`). U is then verified (U owes 7,500), and R3 hands over that 7,500 again as `owed`: excess 0, allowed, drawer 12,500. **(2)** `recognise_income` posts Dr cashier / Cr 7350 (source `remittance_variance`), which is outside `movement` but inside `cashierBalance`, so `floatPosition` rises 7,500 and a second early 7,500 is allowed. **(3)** Σ max(0, per-day) hides a day that spent more than it took, and the order days are verified in changed the verdict. The same leak (2) applies to any "float surplus" term, so that term is dropped too: surplus float goes back to the office **by transfer** (T-S2-7's seam), never as an overage. Why this is still Ian's design: the ice case (⑤) and the overspent day (⑥) hand over only `owed` and pass. Ian ruled that a physical over goes to the tip box (`findings.ts` over sentence). T-319 is untouched. T-324 is narrowed **only at float stores**, and production has none (A1). Because it narrows a path Ian chose (T-324, 2026-09-18), it is put to him as **t316-early-handover** (§0), recommendation (a). | coordinator re-check, this refresh |

**⚠️ One question for Ian (non-blocking; the build defaults to the current design):** say a verified day spends more
from the drawer than it took, for example ₱3,000 of supplies against ₱1,000 of sales. Who puts the ₱2,000 back:
**the office, by transfer** (today's design, `findings.ts` message: *"the office replenishes it"*), or **the next days'
sales**? The second needs `owed` to net a negative day against later days, which is a T-143 change and a different task.
T-316 builds the first. Within a single day, sales already repay the float automatically, because `owed` is net movement.
(Open Questions id: **t316-overspend-refill**.) ✎S-1 Under §3.3's rule, early takings cannot refill a short float
either, because they cannot leave early at all. So the ✎R-1 trade-off no longer arises.

**⚠️ ✎S-1 Second question for Ian (t316-early-handover). The build defaults to the recommended option.** Today
(T-324) a cashier can hand over cash from a day **that isn't verified yet** by typing it in as "overage". Example:
yesterday is verified and owes ₱5,000, and today has taken ₱8,000 that nobody has checked yet. The cashier hands over
₱13,000 and declares ₱8,000 overage. **At a store whose drawer now carries the float, should that still be allowed?**
- **(a) Recommended: no.** The handover is capped at what the verified days owe. Today's ₱8,000 waits in the drawer
  until today is verified, then it goes as ordinary takings. It is simple and cannot leak the float. The cost is that
  cash sits in the till one more night. Stores without a float keep T-324 exactly as it is.
- **(b) Yes, keep early handover.** That needs three more changes, each one a place the float leaked in review: the
  early ₱8,000 must be settled against today when today is verified (otherwise today still "owes" it and it can be
  handed over twice); "recognise as income" must be refused while today is unverified (otherwise the books show
  ₱8,000 back in the drawer and it can leave again); and the check must total the unverified days before flooring
  them. It is more code and more ways to be wrong.

---

# 1. WHAT THIS ACTUALLY COSTS — the sites, verified 2026-10-04

> ⭐ **The premise, stated once:** `1115` moves **only by transfer**, so its ledger balance is COMPLETE. `1110` is
> the takings drawer: sales post at **verify**, so its ledger balance is **provisional**, and it legitimately holds
> float **plus** takings. Merging the accounts merges two facts that the code below still treats as one
> (bible §13 row 207: *grep finds identifiers, not premises*).

## 1.1 ⛔ `judgeDraw`: the migration alone refuses the case Ian is asking for

`packages/domain/src/money-accounts/draw-verdict.ts:48` `judgeDraw`. The float branch is at **`:72`** and its
stated reason is at `:59-71`; it runs **before** the cashier branch at **`:83`** and blocks at zero. Its own premise:
*"A float pot's is complete: it only ever moves by transfer"*. That is **true of `1115` and false of `1110`.** So
0184 **on its own** flips every cashier draw from a *warning, allowed down to −`overdraftLimit`* to *blocked at
zero*. `overdraft.ts:12` warns against exactly this (*"A drawer that reads ₱0 at 2pm may hold…"*).

**Fix (S1): delete the float branch (`:59-81`).** After 0184, the only account that can carry a target is the
cashier's takings drawer, so `custodian === 'cashier'` governs and the floor is enforced at the document (§3). Keep
`floatTarget` on `DrawableAccount` (callers pass it, `MoneyLines.tsx:200`) and document it as **not consulted by
`judgeDraw`**. Update the `:31` doc comment. `judgeDraw` also runs in the browser (`MoneyLines.tsx:195`), so the
fix reaches the screen with no further change.

## 1.2 ⛔ `tillFloatOffTarget` becomes noise, and it is the "check when closing" Ian asked for

`packages/db/src/repo/findings.ts:771-834` compares the account's raw ledger balance against `float_target`. It is
called from `domain/src/findings/index.ts:171` and listed in `domain/src/till/index.ts:17`. On `1110`, drift is
ordinary trading: ₱20,000 float plus ₱5,000 verified-but-unremitted reads "₱5,000 over", every day. **Fix (S3):
§2's `floatPosition` replaces the raw balance.** The `soft` severity, the key, the pre-opening suppression (R1.6)
and both sentences stay. The "short" sentence (*"the office replenishes it… NOT a counted shortage"*) is exactly
right for what `floatPosition` measures.

## 1.3 ✅ Unaffected, verified

- **`owed`**: `endDayReports` (`repo/remittance.ts:79-138`) excludes custody source types (`notCustodySourceType`,
  `:103`). Funding or topping up the float **by transfer** is therefore never a day's takings. Proven by
  `remittance.test.ts:565` (*"cash arriving by transfer is custody…"*). Do not "fix" it.
- **The till count** (`domain/src/till/index.ts:180`): expected = `balanceOf` for each countable cashier cash
  account (`repo/till-shifts.ts:361`). After T-316 there is one line instead of two. The three-variance table at
  `schema/till-shifts.ts:28-34` keeps its three meanings.
- **The `1115` GL account stays in the chart** (`seed/chart-of-accounts.ts:132`) and in `reports/cash-flow.ts:33`'s
  `CASH_CODES`, because history may name it (production has none, A1). Only money accounts stop using it.

## 1.4 ⛔ `setTillFloat` (A4)

`domain/src/money-accounts/index.ts:287-331`. Today it finds a pot via `listFloatPots` (`repo/money-accounts.ts:202`)
and otherwise **inserts** a `1115` account (`:319-330`). New behaviour, same signature minus `name`:

- Keep `authorize('set_cash_policy')` first, then parse (unchanged, `:292-302`).
- Find the store's active account with `instrument = 'cash'`, `custodian = 'cashier'`, `gl_account_code = '1110'`.
  If there is **none**, refuse in a sentence: *"{Store} has no cashier cash account to hold a float."* If there is
  **more than one**, refuse: *"{Store} has more than one cashier cash account; the float needs exactly one."* Both
  go through `refuse` (`shared/refusal.ts:21`), not a raw `throw new Error(`: the T-343 per-directory ratchet
  (`tests/unit/t343-throw-ratchet.test.ts`) must not rise.
- Set `float_target` with `setFloatTarget` (`repo/money-accounts.ts:185`). `null` clears it. **Never insert.**
  "No till float to clear" (`:316`) becomes: clearing an account that has no target is a no-op returning its id.
- Delete `TILL_FLOAT_GL_CODE` (`:268`). Its only use is `:327`.
- Rewrite the doc comment (`:270-286`): the float is a **target on the drawer**, not a side pocket.

---

# 2. THE DESIGN — one function, pooled, two callers using different fields

## 2.1 `tillFloorPosition(tx, orgId, { storeId, upTo })` in `packages/db/src/repo/remittance.ts`

It sits beside `endDayReports`, because it is the same subject. **It calls `endDayReports` and
`custodianPositions` (`repo/money-accounts.ts:234`); it never re-derives either.** Pooled across all of the store's
cashier-custody accounts, which is the same population and the same join shape `owed` uses, so the subtractions are
like for like (A3 d).

Definitions. Each row is an `endDayReports` row for the store, up to `upTo`.
- **on-loan row**: `salesDayStatus in ('open','submitted')`, **or** (✎R-2) `salesDayId` is null **and**
  `businessDate >` the store's latest `verified` business date (≤ `upTo`; no verified day at all → every
  day-less date is on-loan). This is a date whose sales have not posted. Money it has already spent is float
  **on loan**, repaid by that day's own sales at verify. ⛔ The 09-14 refresh used `businessDate = upTo`. That fired
  the detector every morning: yesterday's spend has no sales-day row until someone types the day or imports it,
  and T-375 has **no scheduled import**. `endDayReports` returns `salesDayId` null for such a date
  (`repo/remittance.ts:126-128`).
- **closed row**: every other row (verified; or a date with no live sales day at or before the latest verified
  date, a gap nobody will fill).

✎S-4 A day-less on-loan date has no `cash_collected`. Its spend is excused from `floatPosition`, and nothing is credited for it. That is acceptable under A2 (cashiers count first): the spend is excused only until a verified day is recorded after it, and then the date turns closed and any shortfall shows.

| Field | Value |
|---|---|
| `floatTarget` | the store's `money_accounts.float_target` (at most one, `one_float_per_store`), or null |
| `cashierBalance` | Σ `custodianPositions(tx, orgId, { asOf: upTo, storeId })` rows with `custodian = 'cashier'` |
| `onLoanMovement` | Σ `movement` over on-loan rows (normally ≤ 0: posted spend) |
| `closedOwed` | Σ `max(owed, 0)` over closed rows. ⛔ **`max`, not `owed`**: a closed negative day is never repaid by FIFO (`remittance/index.ts:188` settles `owed > 0` only), so its deficit is a real float shortfall |
| **`floatPosition`** | `cashierBalance − onLoanMovement − closedOwed`: the float as the books hold it. **Ordinary trading cannot move it.** |
| ~~`unverifiedNetCash`~~ | ✎S-1 **NOT BUILT under option (a).** Kept only as option (b)'s definition, in the corrected form (✎S-3): `max(0, Σ (cash_collected + movement_of_that_date))` over `sales_days` with `status in ('open','submitted')` and `business_date <= upTo`. That is the total first, then the floor, never Σ max(0, per day). Column: `sales_days.cash_collected` (A5) |

**Algebra, for the auditor.** Transfers are excluded from `movement`, and a remittance posts as transfers
(`index.ts:361-366`). So `floatPosition` = net float funding − Σ amounts handed over beyond `owed` + Σ closed
negative days. That is exactly the set of things that should move a float.

## 2.2 Who reads what

| Caller | Reads | ⛔ Must not read |
|---|---|---|
| Refusal (§3) | ✎S-1 `floatTarget` only (is this a float store?), plus T-324's `totalOwed` already in hand | `floatPosition`: a figure that `recognise_income` can raise must not unlock a handover (✎S-1 (2)) |
| Detector (§1.2) | `floatTarget`, `floatPosition`, `cashierBalance` (pre-opening suppression only) | any `sales_days` figure (that was A3 c's bug) |

**Do not collapse these into one expression.** If a third surface ever needs "what should be in the drawer", it
calls this function.

---

# 3. THE REFUSAL

## 3.1 A rule about the DOCUMENT, not about every draw (unchanged from 09-14)

An expense drawing the float down is the intended use: *"it can draw from there"*. A **remittance carrying it
away** is the risk. `checkDraw`/`judgeDraw` is the value chokepoint shared by six callers, so the rule cannot live
there. Not a CHECK or trigger either: RULES §6 item 3 scopes database enforcement to balance, period and
immutability. This rule compares a running position plus another table's figure against a column, which would
re-implement the ledger in a trigger. **The single door is `createRemittance`.** A bare `createMoneyTransfer` is not
a remittance and settles nothing, so it is governed by `judgeDraw` alone (test T-S2-7 makes that a decision, not an
oversight).

## 3.2 Where

`packages/domain/src/remittance/index.ts`:
- **Delete** the T-153 refusal `:161-176` (*"a float is never remitted"*). After 0184, the float is the takings
  drawer, which is the remittance source.
- **Insert** the new check **after T-324's check 2 (`:298-337`) and before `const days` (`:339`),
  `allocateFifo` (`:349`) and `insertRemittance`**, so nothing is written when it fires. The per-store advisory
  lock (`:120`) already serialises it against other handovers.
- Only when the store has a non-null `float_target` (the `tillFloorPosition` field, or the money-account row; ✎S-1
  no other field is read). Re-use T-324's `totalOwed` (`:309`). Nothing new is read.

## 3.3 The rule, and the one character that matters (✎S-1)

```
if store has a float target:  REFUSE if handedOver > totalOwed     // strictly greater; T-324's totalOwed, :309
```

Plain words: at a store whose drawer carries the float, a handover may carry what the verified days owe and nothing
more. The float, any surplus above it, and today's unchecked cash all stay in the till.

⭐ **Strictly `>`. Ruled 2026-09-14 and kept.** Handing over exactly `owed` is the ordinary close, and it leaves the
float where it was. With `>=`, every ordinary handover would be refused.

**Worked.** Float ₱20,000, funded by transfer. **V** verified, cash ₱5,000 (`owed` 5,000). **U** open today, ice
₱500 posted, `cash_collected` ₱8,000.

| Case | Hand over | Verdict |
|---|---|---|
| ① ordinary | ₱5,000 | ✅ |
| ② boundary | ₱5,000.00 exactly; ₱5,000.01 | ✅ ; ⛔ |
| ③ early takings as overage | ₱13,000 (₱8,000 declared) | ⛔ **this is the task** (✎S-1 (a)) |
| ⑤ **Ian's case**: 7am, ice ₱500 on U, U has no figure yet | ₱5,000 | ✅ (the 09-14 level rule refused this) |
| ⑥ closed negative day D1 (−₱2,000), D2 verified ₱10,000 | ₱10,000 | ✅; float sits at 18,000, and the detector says so |
| ⑦ overage, no unverified day | `owed` + ₱1,000 | ⛔ (a physical over goes to the tip box) |
| ⑧ surplus float (funded ₱21,000) | `owed` + ₱1,000 | ⛔: the surplus goes back by transfer (T-S2-7) |
| ⑨ the ✎S-1 (1) sequence: R1 early | — | R1 ⛔, so (1) cannot start |
| ⑩ store **without** a float | ③'s ₱13,000 | ✅ T-324 unchanged (control) |

✎S-1 This rule never reads `floatPosition`, `cash_collected` or a variance. So leaks (1), (2) and (3) have no
input to act through: the refusal holds whatever `recognise_income` or verify order does to the books.

**Sentence** (through `refuse`). ✎R-7 Deleting the T-153 raw throw makes the `remittance` directory's raw-throw
count **drop by 1**. The ratchet only fails on a rise (`t343-throw-ratchet.test.ts:234`; ceiling `:105`), so the
builder may lower the ceiling by 1:
*"This hands over {handedOver}, but the verified days owe {totalOwed}. {Store}'s till keeps a {floatTarget} float,
so only what the verified days owe can be handed over. Cash from a day that isn't verified yet is handed over after
that day is verified. Extra float goes back to the office as a transfer."* No branch on the POS link (A5).

## 3.4 What it costs the stores — Tell Ian

⭐ **Tell Ian (plain language), under recommendation (a):** *"Handing over verified sales never changes. In a store
whose till keeps a float, cash from a day that isn't verified yet stays in the till until that day is verified,
whether the day is typed or imported from POS. If POS can't be reached, the day waits, and so does its cash. The
float can never be handed over; extra float goes back to the office as a transfer. If the float runs short because a
day spent more than it sold, the office tops it up. Your 'count before handing over' rule is unchanged."*

---

# 4. THE MIGRATION — `0184`, ONE FILE

`packages/db/migrations/0184_t316_float_on_the_cashier_drawer.sql`, hand-authored per ADR-012 §5 (`db:generate` is
retired, DEF-242). `when` as A6. Header states: **one concern**, the CHECK; the index is **deliberately untouched**.

1. `alter table money_accounts drop constraint money_accounts_float_target_shape_check;` then re-add it as
   `float_target is null or (instrument = 'cash' and custodian = 'cashier' and gl_account_code = '1110')`.
   **`1110` ONLY**, never `1110`-or-`1115`: A1 measured 0 rows on production, and `one_float_per_store`
   (`schema/money-accounts.ts:212-214`) makes a transition state impossible anyway. Re-adding **validates** the
   constraint, so if any `1115` target exists in a database, the migration **fails loudly** rather than migrating a
   balance (§5's ⛔ row). That is the precondition enforced by something that executes.
2. `money_accounts_one_float_per_store`: **unchanged**, by decision. One target per store is still the property.
3. `packages/db/schema/money-accounts.ts:215-218` edited to match. Rewrite the comment at `:206-207` (*"rolling
   into `1115`"*) so it says the float is a target on the cashier's cash drawer. `schema/till-shifts.ts:150`'s
   comment (*"The float (`1115`) and the takings drawer (`1110`)"*) is corrected in the same slice.
4. No table added, so `cutover/classification.ts` and `rls/registry.ts` are untouched.

---

# 5. ✅ `1115` — PRECONDITION MET (A1)

The 09-14 query (kept for the pre-push re-run):

```sql
BEGIN READ ONLY;
SELECT ma.id, ma.org_id, ma.store_id, ma.name, ma.gl_account_code, ma.float_target,
       COALESCE(SUM(jl.debit - jl.credit), 0) AS ledger_balance
FROM money_accounts ma
LEFT JOIN accounts a        ON a.org_id = ma.org_id AND a.code = ma.gl_account_code
LEFT JOIN journal_lines jl  ON jl.account_id = a.id AND jl.store_id = ma.store_id
LEFT JOIN journal_entries je ON je.id = jl.entry_id AND je.status <> 'draft'
WHERE (ma.float_target IS NOT NULL OR ma.gl_account_code = '1115')
  AND (jl.id IS NULL OR je.id IS NOT NULL)   -- ✎R-8 drop draft lines, as findings.ts:801
GROUP BY ma.id, ma.org_id, ma.store_id, ma.name, ma.gl_account_code, ma.float_target;
ROLLBACK;
```

| Result | Meaning |
|---|---|
| **No rows** ← **2026-10-04 production** | The replace is free. 0184 replaces the CHECK; nothing is migrated |
| Rows, all `ledger_balance = 0` | Still free; retire them in 0184 with a reason (re-plan first) |
| ⛔ Any non-zero balance | **STOP.** A posting with a pattern and Ian's date, not a schema change |

---

# 6. THE CLOSE-TIME CHECK — no new surface

*"Check when closing if maintaining balance still complete."* §1.2's repaired `tillFloatOffTarget` answers it
**continuously**, and T-186's `closeTillShift` count now has one cash line to count instead of two. ⛔ No new screen,
table or finding kind. No `setTillFloat` screen exists today (it is domain-only); adding one is **out of scope**.

---

# 7. SLICES, TESTS, MUTANTS

**Model:** Sonnet, tester first, then builder, per slice. **Paths are disjoint:** the tester owns `**/tests/**` only,
including the existing tests listed under "Old behaviour" below. The builder owns `packages/**/src`,
`packages/db/schema`, `packages/db/migrations`, and nothing under `tests/`. Every red asserts the **target**
behaviour (a sentence, a verdict, a value), never "throws". Every "does not" has a **positive control** beside it.
Fixture: hoist or write a store with `Cashier cash` (1110) and `Cashier online` (1140), float funded **by
transfer** from `Office cash`.

**Ordering:** after T-375 S1 (0183) is committed. Independent of T-375 S2–S6 file-wise (no shared file: T-316 touches
no `sales-days/*`, no `sales_days` write). If T-375 S4 (0185) has landed before T-316's tests run, any raw
`sales_days` insert on a feed day uses S4's `insertDerivedSalesDayRow` (`_fixtures/pos-day.ts`) on a linked store.
Otherwise it uses a raw insert with a `pos_v1_day_feeds` row (0183's CHECK
`(source = 'pos_v1_day_feed') = (pos_v1_day_feed_id is not null)`).

**⛔ S1, S2 and S3 ship in ONE push.** S1 alone would let an admin set a target on `1110` that the old T-153 refusal
then turns into "every cash remittance refused", while the detector fires daily. Commit each slice locally and push
once at wrap-up (standing rule), after the A1 re-run.

## S1 — 0184, `judgeDraw`, `setTillFloat`
**Builder:** §4 migration + schema + comments; §1.1; §1.4.
**Tests** (`packages/db/tests/integration/t316-s1-migration.test.ts`, `packages/domain/tests/unit/t316-s1-judge-draw.test.ts`,
`packages/domain/tests/integration/t316-s1-set-till-float.test.ts`):
- **T-S1-1 ⛔⛔ (write first): a cashier draw at ₱0 ledger on a float-carrying `1110` WARNS within `overdraftLimit`
  and does not block** (verdict `blocked: false`, message names the overdraft). Control: past the limit → blocked.
  This is the regression the migration alone causes.
- T-S1-2: after 0184, `float_target` on a `1115` cashier cash row → refused naming
  `money_accounts_float_target_shape_check`. Control: on the `1110` cashier cash row → accepted. On an office
  `1130` row → refused.
- T-S1-3: a second `float_target` at the same store (raw insert of a second cashier cash row with a target) →
  refused naming `money_accounts_one_float_per_store`. Control: another store → accepted.
- T-S1-4: `setTillFloat` sets the target on the existing `Cashier cash` id, and **the money-account count for the
  store is unchanged**. Control: clearing returns the same id with `float_target` null.
- T-S1-5: store with no cashier cash account → the §1.4 sentence. Store with two (raw) → the other sentence.
- T-S1-6: `judgeDraw` for office or staff accounts still blocks at zero (control: the branch deletion did not widen
  them).
**Old behaviour, updated by the tester (report each assertion changed):** `overdraft.test.ts:22,95-122` (a pot
blocks → it warns as a cashier drawer); `remittance.test.ts:737-853` (T-153 pot on `1115`, `:747`, `:830`);
`expenses.test.ts:1381-1440` (`fundAccount(...'1115'...)`, two credit legs → one `1110` leg);
`till-custody.test.ts:527-535` (two countable accounts → one); `t346-opening-readers.test.ts:204-251` (repoint to
the `1110` target). `chart-of-accounts.test.ts:351-354` is unchanged (the GL account stays).
**Mutants:** M1 keep the float branch → T-S1-1 red. M2 0184 permits `1110`-or-`1115` → T-S1-2's `1115` leg red.
M3 `setTillFloat` still inserts → T-S1-4 red (CHECK violation or count +1).

## S2 — `tillFloorPosition` + the refusal
**Builder:** §2.1 (repo; `unverifiedNetCash` NOT built, ✎S-1); §3.2–3.3 (domain).
**Tests** (`packages/db/tests/integration/t316-s2-floor-position.test.ts`, `packages/domain/tests/integration/t316-s2-remittance-floor.test.ts`).
✎S-5 **Every fixture has a verified day with `owed > 0`.** Otherwise T-319 refuses first and a mutant goes red for
the wrong reason. Each test asserts the T-316 sentence, never just "throws".
- T-S2-1: `tillFloorPosition` on §3.3's fixture returns exactly `floatPosition` 20000.00, `cashierBalance` 24500.00,
  `floatTarget` 20000.00, and has no `unverifiedNetCash` field.
- T-S2-2: rows ①–⑩ of §3.3, each asserting the verdict and the sentence's figures. ✎R-3 **Same-transaction
  ordering proof:** `refuse` is a JS throw, so the transaction stays usable. Call `createRemittance(tx, …)`, catch
  the refusal inside the same transaction, and count `remittances`, `money_transfers` and journal lines there,
  before the rollback. The counts must equal the pre-call counts.
- T-S2-3 ⭐ boundary: ② exactly `owed` allowed; `owed` + ₱0.01 refused.
- T-S2-8 ✎S-1 (1): at a float store, R1 (V1's owed + U's ₱7,500 declared) → refused. Control: at a store **without**
  a float, the same R1 is allowed (T-324 unchanged). Then, on that no-float store, verify U and confirm R3 of U's
  ₱7,500 is allowed. That records today's no-float behaviour as T-324's, so the scope of ✎S-1 is visible.
- T-S2-9 ✎S-1 (2): at a float store, post a `recognise_income` on an older overage (raw, made before the target was
  set). `floatPosition` rises, yet `owed` + ₱1 is still refused. Control: `owed` exactly is allowed.
- T-S2-6: an expense paid from the float-carrying `1110` below target is **allowed** (`approveExpense`, warning only).
- T-S2-7 ⭐: a bare `createMoneyTransfer` cashier→office of surplus float succeeds and **settles nothing** (no
  `remittance_allocations` row, `owed` unchanged). The seam is a decision.
**Mutants:** M4 `>=` for `>` → ①, ⑤, ⑥ and T-S2-3's allowed leg red. M10 old T-153 refusal kept → ① red (the float
store's till is refused outright). M11 refusal moved after `insertRemittance` or the transfer loop → T-S2-2's
same-transaction counts red. M15 ✎S-1 refusal applied to every store → ⑩ and T-S2-8's control red. M18 refusal reads
`floatPosition − floatTarget` as an allowance → ⑧ and T-S2-9 red. M19 refusal skipped when `declaredOverage` is
blank → ⑦ with no declaration red. M9 refusal placed in `judgeDraw` → T-S2-6 red.
**Option (b) only, if Ian chooses it** (not built now): the settle-at-verify, `recognise_income`-refusal and
Σ-then-floor changes in §0, plus an R1 → verify U → R3 refusal test and a `recognise_income` test.

## S3 — the detector + T-375 guard
**Builder:** `tillFloatOffTarget` computes per float-carrying store from `tillFloorPosition(..., { upTo: Manila
today })`: drift = `floatPosition − floatTarget`. Suppression: pre-opening by both measures **and**
`cashierBalance` exactly zero (R1.6 unchanged in meaning).
✎R-5 **Rewrite both sentences** (`findings.ts:822-830`). They become false after T-316: the float IS the drawer,
so "{name} holds {balance}" no longer describes the float, and "posted INTO the float that belongs in the takings
drawer" describes two pockets that no longer exist. New text:
- lead: *"{Store}'s till float stands at {floatPosition} on the books against a target of {target} —"*
- short: *"{drift} short. Money was paid out of the till and not put back. The office tops it up. ⛔ This is NOT a
  counted shortage and must not be charged to a cashier."*
- over: *"{drift} over. Either the office sent more than the target, or an overage was booked (7350) instead of
  being settled against the day it came from. Send the surplus back to the office by transfer, or correct the
  overage."*
**Tests** (`packages/domain/tests/integration/t316-s3-float-detector.test.ts`, `tests/unit/t316-s3-no-link-read.test.ts`):
- T-S3-1: ordinary trading day (verified, unremitted ₱5,000) → **no finding**. Control: an expense on a **closed**
  day leaving the float ₱500 short → the "short… office replenishes" finding for ₱500.
- T-S3-2: declared-but-unverified ₱8,000 (U) → no finding (A3 c).
- T-S3-3: ice on today's open day (⑤) → no finding (on loan).
- T-S3-4: ⑥ after remitting D2 → finding "₱2,000 short". Kills M7.
- T-S3-8 ✎R-2 (the morning case). Yesterday's ₱500 spend is posted, yesterday has **no sales-day row**, and the
  latest verified day is the day before → **no finding**. Run it on a typed store and on a linked store (no
  import yet). Control (✎S-5): the same spend on a day-less date **before** the latest verified date → "₱500 short".
- T-S3-9 ✎R-5: the short and over findings carry the §S3 sentences word for word, and neither contains "holds"
  nor "INTO the float".
- T-S3-5: float over-funded by transfer (₱21,000) → the "over" finding. Pre-opening store, zero balance → none
  (T-346 control kept).
- T-S3-6 (unit, `fs`): the files T-316 touches (`repo/remittance.ts`' `tillFloorPosition`, `remittance/index.ts`,
  `repo/findings.ts`' `tillFloatOffTarget`) contain no `pos_v1_store_links`, `posV1StoreLinks` or `source =` read.
  Control: the test finds the string when fed a fixture text containing it.
- T-S3-7 (A5, ✎S-1): a feed-sourced open day (`source = 'pos_v1_day_feed'`) and a typed open day with the same spend
  give the same `floatPosition`. No `sales_days` figure enters it.
**Mutants:** M12 detector on the raw balance → T-S3-1 red. M13 detector adds any `cash_collected` term → T-S3-2 red.
M7 `owed` instead of `max(owed,0)` in `closedOwed` → T-S3-4 red. M14 on-loan rows treated as closed → T-S3-3 red. M16 ✎R-2 the old `businessDate = upTo` rule → T-S3-8 red on
both stores. M17 every day-less date treated as on-loan → T-S3-8's control red.

## Gate (it is a migration, memory "full suite for migrations")
Typecheck · lint · unit (`npm test`) · **the FULL integration suite on a FRESH gate DB, every other lane frozen
while it runs** · `npm run build` with the 9008 dev server stopped · smoke. Each named mutant shown red, then
restored. Every changed old-behaviour assertion is listed in the slice report.

## Smoke (9008)
On the dev DB, set a ₱20,000 target with a one-off `setTillFloat` call (no screen exists) and fund it by transfer.
Then: `/till` shows **one** cash line, "Cashier cash … float ₱20,000" (`till/page.tsx:204`). `/remittance`:
handover of verified `owed` succeeds; ③'s handover shows the §3.3 sentence; nothing posted. `/findings`: no
`tillFloatOffTarget` on an ordinary day. An expense from Cashier cash below target warns and saves. Screenshots.

---

# 8. OUT OF SCOPE

- **DEF-357, DEF-358**: fixed (A7).
- ⚠️ **The AP ceremony for floor-funded purchases** (T-130: supplier + verified invoice + photo for a ₱200 bag of
  ice). It needs Ian's decision and is a different task. T-316 makes that path routine.
- Cross-day replenishment from sales (the §0 question), `overdraftLimit`'s meaning, the two shortage paths,
  `remittance_variances`, what `owed` means, a `setTillFloat` screen.
- How a declared overage of unverified cash later settles that day's `owed` (T-324 / T-366 S3). The detector reads
  such a handover as float short until it is resolved. That is true if the overage was float; if it was early
  takings, it is a T-366 settlement question. T-316 does not change it.

# 9. ⚠️ NOT VERIFIED BY THIS REFRESH

- Nothing was run. No test, no migration, no query (a full gate run was in progress). Line numbers were read at
  `e79c18c` plus T-375 S1's tree. Builders re-check any that drift.
- That `custodianPositions` and `endDayReports` agree to the centavo on a two-account store. T-S2-1 proves it.
- How often stores remit unverified cash early. A2 says cashiers count first, so the cost should be rare.

# T-187 — the service-charge float is distributed to staff, and 2160 finally has a debit

**Status:** ⭐ **ANSWERED AND READY TO SPEC — all five questions ruled by Ian, 2026-09-20 (bible row 223). NOT YET BUILT.** ⚠️ His answers arrived RELAYED via `webapps-17`, not typed in the orchestrator's terminal — verbatim, and flagged to him for confirmation. **Ordered by Ian** (bible rows 221, 222, 223).
**Closes:** DEF-082 — *nothing in the codebase ever DEBITS `2160`, so the service-charge float can
only grow.*
**Migration slot:** ⭐ **none needed** — row 223 removed the only thing that would have required one
(an eligibility field). `0156` is allocated to T-276; `0155` is applied in production.
**Shape, after row 223:** ONE aggregate entry per store per payday — **Dr `2160` (that store) / Cr the
money account, capped at that store's available balance.** A day's work, not a module.

> ⛔ **ANCHORS — GREP THESE, NEVER A LINE NUMBER** (bible row 204).
>
> | Anchor | File |
> |---|---|
> | `SERVICE_CHARGE_FLOAT` | `packages/domain/src/sales-days/routing.ts` — the only writer; credits 2160 |
> | `serviceChargeFloatAgeing` | `packages/db/src/repo/findings.ts` — the alarm that must go QUIET once this ships |
> | `Service charge float — held for staff` | `packages/db/seed/chart-of-accounts.ts` — account 2160 |
> | `T-152 — DEF-082, the service-charge float nothing can discharge` | `packages/domain/tests/integration/findings.test.ts` — the 4 existing detector cases |

---

## 1. Why this exists, and why it is now urgent rather than scheduled

Every sales day carrying a service charge **credits** `2160 Service charge float — held for staff`.
**Nothing anywhere debits it.** RA 11360 sends 100% of the service charge to rank-and-file staff and
requires distribution **at least twice a month, at intervals not exceeding sixteen days** — so from
the first month of real use this is a statutory liability with no path to clear it, and the real
handover to staff would happen off-book.

⭐ **What changed on 2026-09-20.** Ian ruled *"service charge turn on so we can test"* (bible row
222). Measured before recording: **there is no switch to turn on.** No feature flag exists anywhere
in the repo; `sales_days.service_charge` is an ordinary `numeric` defaulting to `'0'`, and
`/sales-days/new` already renders the field. **The entry side has always been open.** So the ruling
is satisfied on its face and useless on its own — the half worth testing is the distribution, and
that is this task. T-187 therefore moves ahead of the DEF-395 re-derivation.

⚠️ **The production line, restated because the two sit one sentence apart:** row 222 authorises the
service charge **in testing, on a system no staff use yet**. It does **NOT** authorise enabling the
POS service-charge setting in production before this ships. That decision is separate and still open.

## 2. ✅ THE FIVE QUESTIONS — ALL RULED, AND THREE WERE DISSOLVED RATHER THAN ANSWERED

Ian, 2026-09-20, verbatim: *"the business will collect it and dispense it every payday. thats all erp
should record. as to split erp wont know that, who counts erp does not have to know. odd centavo erp
not know too, per store , pay only whats available never negative ----- ALL erp does not have to know
will be processed manually and documented manually too."* Then: *"simplify its build."*

| # | Question | Ruling |
|---|---|---|
| **Q1** | How is the money split between staff? | ⛔ **OUT OF ERP SCOPE.** *"erp wont know that."* No per-employee computation. The business splits it by hand. |
| **Q2** | Who is eligible (RA 11360's "rank-and-file")? | ⛔ **OUT OF ERP SCOPE.** *"who counts erp does not have to know."* ⭐ **Therefore NO eligibility field and NO schema change** — this is what removes the migration from the task. |
| **Q3** | Where does the odd centavo go? | ⛔ **OUT OF ERP SCOPE.** *"odd centavo erp not know too."* No rounding rule in code. |
| **Q4** | One org-wide pool, or per store? | ✅ **PER STORE.** ⛔ This makes `serviceChargeFloatAgeing` **wrong as built** — see §3. |
| **Q5** | Zero or negative float? | ✅ **"pay only whats available never negative."** A dispense exceeding that store's balance is REFUSED, not clamped. |

⚠️ **CADENCE CHANGED, AND IT OVERRIDES AN EARLIER RULING.** *"every payday."* `docs/tasks/136-cash-custody.md` §6 offers a closed list of **daily or weekly ONLY** (Ian, 2026-08-25), with twice-monthly deliberately excluded though lawful. **Payday cadence supersedes that list** (bible row 223). §6's option list is now stale and must not be implemented as written.

⛔ **THE TRADE, STATED PLAINLY BECAUSE IT IS REAL:** the ERP will hold **no record of who received what**. It can prove the float was discharged and by how much; it cannot answer *"was this person paid their share"* from its own data. Ian accepted this explicitly — *"processed manually and documented manually too."*

⚠⚠ **ONE COMPLIANCE CAUTION, RAISED ONCE, NOT A BLOCKER.** RA 11360 requires intervals **not exceeding sixteen days**. *"Every payday"* is lawful only while every store's pay cycle stays inside 16 days. T-189 shows per-store semi-monthly cutoffs (Lipa cuts on the 15th) — ~15–16 days, almost certainly fine. ⛔ **But nobody has checked every store's configured cadence, and a month containing a 31st can stretch a semi-monthly gap past 16 days.** ⭐ Once the payout date is recorded and the alarm is grouped per store, **this becomes self-reporting rather than theoretical.** Verify the configured cadences before calling T-187 done; do not treat "payday" as self-evidently compliant. (Flagged by `webapps-17` while relaying, as a risk rather than an assertion — the right call.)

## 3. What is already built, and must not be rebuilt

- **The credit side is done and correct** — `routing.ts` credits `SERVICE_CHARGE_FLOAT`. Not new work.
- **The alarm is done AND tested** — `serviceChargeFloatAgeing` plus four integration cases (silent
  at zero, silent inside 16 days, fires past 16 days carrying `RA 11360` and `DEF-082` in its detail
  with `soft` severity, and a FIFO-clear case proving the oldest accrual drives it, not the balance).
  ⭐ **This is the task's best available red:** once distribution ships, the detector must go **QUIET**,
  and a detector nobody ever saw fire is a detector nobody can prove stopped. These four cases mean
  we can prove it.
  ⚠️ **One gap, reported not fixed:** the `ageDays <= 16` boundary is precise in code but the tests
  use day-3 and day-40 — **day-16 vs day-17 has never been exercised**, so the exact statutory cutoff
  is unverified.

## 4. Out of scope

- ⛔ Enabling the service charge in **production** — separate, still open, Ian's (bible row 222).
- ⛔ Building a feature flag. There is none and the ruling does not require one.
- ⛔ **Modelling the split, eligibility or rounding in any form** — row 223 put all three outside the system. Re-proposing them is re-litigating a ruling.
- ⛔ Changing the credit side or the chart of accounts.

## 5. Done when

Every §9 gate. ⛔ **Plus two specific to this task:** the four existing `serviceChargeFloatAgeing`
cases must be shown going **QUIET** after a distribution, and Q4's answer must be reflected in the
detector's grouping — **or a recorded decision saying why it stays org-wide.**
⚠️ **§9.4 is currently UNMEETABLE** — DEF-401: `next dev` returns 500 on every route on this machine.

---

# ⭐ ADDENDUM 2026-09-20 (orchestrator `system32-df`) — the executable half

> The sections above RULE the task. They do not SPEC it: there was no file scope, and RULES §3.3
> requires one before any lane may touch anything. Everything below is the buildable half.
> ⛔ Nothing here re-opens a §2 ruling. Where this addendum and §2 disagree, §2 wins.

## 6. Ian's cadence ruling — the compliance caution of §2 is CLOSED

Ian, 2026-09-20, typed directly into the orchestrator terminal (not relayed):
*"our set up follows payday every 15 days"*.

**Fifteen days is inside RA 11360's sixteen-day ceiling, so the caution §2 raised is answered and
this task is no longer carrying it.** ⭐ **What §2 asked for was a measurement and this is a
RULING** — Ian has stated the business's actual cadence rather than us inferring it from T-189's
per-store cutoffs. It is authority, and the "verify every store's configured cadence before calling
T-187 done" instruction in §2 and in `docs/HANDOFF-TODAY.md` is **discharged by it**.

⚠️ **One thing the ruling does NOT do, and it is the reason T-332 exists.** Fifteen days is the
*policy*. Nothing in the system *records* it, so nothing can detect a store that drifts off it — a
month containing a 31st is still the case that stretches a semi-monthly gap, and today the ERP
would not notice. Ian ordered the remedy in the same breath: *"create a doc on store settings where
admin define the date of paydays"*. That is **T-332**, specced separately, and it is what turns this
from a policy nobody can check into a self-reporting one. **T-187 does not depend on it** — this
task records the payout date it is given; T-332 is what later lets a detector compare that date
against a configured cadence.

## 7. Contract

**`distributeServiceCharge(tx: Tx | null, actor: Actor, input)`**, new, in the domain layer.

> ⛔ **AMENDMENT 1, 2026-09-20 — this signature was WRONG when first written and the TESTER caught
> it before a line of source existed.** The spec said `(tx, orgId, input)`. Every comparable
> money-moving function in this repo takes an `Actor`: `payLiability(tx, actor, input)`,
> `createRemittance(tx, actor, input)`, both `tx: Tx | null` with the run-or-open-transaction
> pattern. ⭐ **A bare `orgId` gives no `personId` for who posted it and nothing to authorize
> against** — it would have produced a money entry attributable to nobody, in the one module whose
> subject is a statutory liability to staff. The tester reported it as a spec defect rather than
> building around it (RULES §3.4a), which is exactly the behaviour that rule exists to produce.
> **Its choice is ruled correct and is now the contract.**

> ⭐ **AMENDMENT 2, same pass — `postEntry` REQUIRES an `idempotencyKey` and the spec never said
> so.** `packages/domain/src/ledger/post-entry.ts:117` throws without one. Found while verifying
> amendment 1. **Derive it from the facts that make this payout unique — the store and the payday
> — never from a timestamp or a random value**, or a double-submitted payday posts twice and the
> float is discharged money that never left the drawer.

| Input | Meaning |
|---|---|
| `storeId` | the ONE store being paid out. Required. There is no org-wide form. |
| `moneyAccountId` | the account the cash leaves. Must belong to `storeId`. |
| `amount` | `Money`. The aggregate handed to staff. |
| `paidOn` | the payday date carried onto the entry. |

**Posts exactly one journal entry, two lines, both carrying `storeId`:**

```
Dr  2160  Service charge float — held for staff   <amount>   store_id = storeId
Cr  <moneyAccount.glAccountCode>                  <amount>   store_id = storeId
```

⛔ **`journal_entries` has NO `store_id` column and that is deliberate** (`packages/db/schema/journal.ts`
header). Store identity lives on **`journal_lines.store_id`**. "One aggregate entry per store" is
therefore expressed by putting the same `storeId` on both LINES, not by a column on the entry.
**A builder who assumes an entry-level store column will produce an entry the per-store detector
cannot see** — which is the exact failure mode this task exists to remove.

### Invariants

1. ⛔ **The cap is that store's OWN 2160 balance, derived from the ledger, never a stored column.**
   Sum credits minus debits on `2160` restricted to `journal_lines.store_id = storeId`, over
   non-draft entries. A store may not spend another store's float (§2 Q4).
2. ⛔ **Exceeding the cap REFUSES. It does not clamp** (§2 Q5, *"pay only whats available never
   negative"*). Throw, naming the store and the shortfall. **Not a Result type** — the domain layer
   of this repo throws, and `payLiability` is the precedent.
3. ⛔ **Refuse BEFORE any write**, `createRemittance`'s discipline (DEF-358 / T-319). The cap check
   is computed and thrown on strictly above the first insert, not interleaved with it.
4. **The money account must belong to the paying store** — `payLiability` already makes this exact
   check against its liability's store; mirror it.
5. **No per-employee, eligibility or rounding logic in any form** (§2 Q1-Q3, §4). A reviewer seeing
   any of the three should treat it as out-of-scope code, not as a bonus.

### The regroup, in the same task

`serviceChargeFloatAgeing` (`packages/db/src/repo/findings.ts`) groups by `je.entry_date` **only**
and emits `storeId: null`. Per §2 Q4 that is now wrong as built: a payout at one store would tick
off another store's older accrual.

⭐ **Do not invent the shape — `grniNotAtRest` in the SAME FILE already is it.** It selects
`jl.store_id`, joins `stores`, groups by `(store_id, name, entry_date)`, buckets into a
`Map<storeId, rows>`, runs an independent FIFO walk per store, and emits one finding per store with
`storeId` set. Mirror it.

## 8. File scope — disjoint by construction

**BUILDER (`webapps-4d`) — source only. ⛔ May not edit, weaken, skip or delete a single test file.**

| Path | New/edit |
|---|---|
| `packages/domain/src/service-charge/index.ts` | **new** — `distributeServiceCharge`, shaped like `payLiability`, refusing like `createRemittance` |
| `packages/db/src/repo/findings.ts` | **edit** — `serviceChargeFloatAgeing` only, regrouped per store, mirroring `grniNotAtRest` |
| `packages/db/src/repo/service-charge.ts` | **new, only if needed** — the per-store 2160 balance query |

**TESTER (`webapps-d1`) — test paths only. ⛔ May not edit source.**

| Path | New/edit |
|---|---|
| `packages/domain/tests/integration/service-charge-distribution.test.ts` | **new** — the posting contract and every refusal in §7 |
| `packages/domain/tests/integration/findings.test.ts` | **edit** — the four existing cases go per-store, plus the two-store case that proves the regroup |

**ORCHESTRATOR pre-wires and owns — no lane touches these:** `packages/domain/src/index.ts`
(barrel), `apps/erp/src/components/nav.tsx` and any second nav registry, `docs/ROADMAP.html`, the
registers, this spec's status line.

⛔ **THE ONE COUPLING, AND IT IS THE ORCHESTRATOR'S TO HOLD.** The builder's regroup of
`findings.ts` turns the tester's four existing cases in `findings.test.ts` red until they are
updated. **Those two land in ONE commit.** Committing them separately makes `main` red in between,
which is DEF-389's shape.

## 9. Slices

> ⛔ **AMENDMENT 3, 2026-09-20 — THE TWO SLICES ARE NOW ONE, AND THE REPO IS WHAT SAID SO.** This
> section originally split the domain from its screen. Running the unit guards against the tree
> while the builder worked, two fired on the new export: `domain-actions-have-callers` (*"it
> authorizes, so it presumes a human — and no file under `apps/` calls it"*) and
> `production-caller-ratchet` (*"NOT tracked anywhere else"*). **They are correct.** A domain
> function that authorizes presumes an operator, and a slice that lands one with no screen ships
> money-moving code nothing can reach — the **DEF-129/135/136/137/147** shape, five tasks marked
> done with zero callers, which is why those guards exist at all.
>
> ⛔ **Both could have been silenced — with an `EXEMPT` entry or by regenerating the baseline — and
> both were refused.** An exemption is a promissory note, and a regenerated baseline is precisely
> how **DEF-403** deleted a real zero-caller finding in this repo. ⭐ **A real caller is the honest
> fix, so the screen moved into slice 1.**

| Slice | Contents | Lane order |
|---|---|---|
| **1 (all of it)** | `distributeServiceCharge` · the per-store regroup · the operator screen under `apps/erp/src/app/service-charge/` mirroring `liabilities/`'s three-file shape · both integration test files · the screen wiring test | tester RED → builder GREEN → auditor → gates → **one commit** |

⭐ **The screen's own risk, carried from T-330:** its screen was **reviewed, not smoketested**, and
three screen-layer defects were caught by code review alone because no test in this repo can reach
them. **This one gets driven in a real browser** — `docs/SMOKETEST.md`. The operator must see the
store's available float **before** committing to an amount, and a refusal must name the store and
the shortfall; a refusal the operator could not have predicted is a screen that wastes their time.

⛔ **The gates live in the services, not in the action** (`liabilities/actions.ts`'s own header).
The screen calls the domain function and lets it refuse. **A second copy of the cap in the app
layer is a second source of truth and the two will drift** — RULES §6.3.

## 10. The §9.4 position — CHANGED 2026-09-20, and better than §5 says

§5 says *"§9.4 is currently UNMEETABLE"*. ⭐ **That is no longer true, and two of its three
premises were wrong.** Measured by the orchestrator at cold start:

- `/api/health` reported `configuration: invalid` for one reason: **`FIREBASE_PROJECT_ID` was blank
  in `.env.local`** while `NEXT_PUBLIC_FIREBASE_PROJECT_ID` beside it was filled, and `.env.example`
  requires the two to be equal. Set to match; health is now `ok` with `database: reachable`.
- ⛔ **"Playwright needs Chrome and the install needs Administrator" is wrong.** That is *branded*
  Chrome and nothing here needs it. Playwright and three chromium builds are already installed.
  A headless chromium loaded `/sign-in` at 200 with the correct title and a screenshot was taken.
- **What is genuinely missing is a signed-in session.** The PIN form does not render against
  `shareat_dev`, and `shareat_test_setup` — the seeded database every earlier smoketest signed into
  — has been deleted.

> ⛔ **CORRECTION, later the same night — this section was written BEFORE the fix existed and it
> overclaims.** It said rebuilding the seeded database *"unblocks every later task"*. **It does
> not.** What was built instead is a **session forge** (`docs/SMOKETEST.md` §3) that mints a
> `shareat_session` row directly against a throwaway database. ⛔ **It BYPASSES sign-in on purpose.
> A smoketest driven through it proves things about SCREENS and nothing whatever about
> authentication** — T-304's layer 1 authenticates the tablet against Firebase in the browser and
> cannot be faked from a script. ⭐ **So screen testing is unblocked and end-to-end sign-in is
> not**, and the latter still needs Ian to create the terminal account in the Firebase console.
> ⚠️ **Read `docs/SMOKETEST.md` §3 before using it** — that is the one place the limit is stated in
> full, and a report that calls a forged-session smoketest *"sign-in works"* is wrong.

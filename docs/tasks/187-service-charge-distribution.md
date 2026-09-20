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

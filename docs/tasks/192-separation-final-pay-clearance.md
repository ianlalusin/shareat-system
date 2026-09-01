# T-192 — separation, final pay, and clearance (first slice)

> **Status:** 📝 SPECCED, implementing same session. Handoff item 3's sibling; phase-5-payroll.md
> sequences it directly after T-191. Assessed via `/research-evaluate-propose` first, **and Ian
> answered two scoping questions before this was written** — see §1.
> **Depends on:** T-191 (reuses `basicPayEarnedInYear`, extended with an `asOf` bound), T-189
> (`outstandingAdvance`, `advanceToRecover`, `postEntry`). **Modifies T-191's `preview13thMonthRun`**
> — see §2.3, the reason this could not simply be additive.

---

## 1. Assessment, and the two questions only Ian could answer

**Verdict: build a scoped first slice — the mechanical parts, not a guessed legal formula.**

v1 has **zero** code for staff separation pay, final pay, or an offboarding clearance workflow
(confirmed by a repo-wide grep; every apparent hit was a false positive — supplier payments,
barangay permits). Bible row 90 confirms this is a genuine ADD, not a porting gap.

**Why this is not T-191's shape again.** Final pay (wages + whatever is owed at separation, due
within 30 days per DOLE Labor Advisory 06-20) and separation pay (Labor Code Art. 298/299) are
**different things**. Separation pay is owed **only** for authorized causes (redundancy,
retrenchment, closure, disease) at 0.5–1 month per year of service depending on cause — **just
cause and plain resignation get none by law**, unless a business's own policy is more generous.
Guessing a formula here risks either shortchanging someone (a DOLE complaint) or auto-paying an
unbudgeted amount nobody approved.

**Ian answered two questions before any code was written** (2026-09-01):
1. *"Does this business have a track record of paying separation pay?"* — **No track record;
   decide the policy now.** Confirms this is genuinely greenfield, not a practice to preserve.
2. *"Skip unused-leave conversion, or is it needed for a real pending departure?"* — **Skip it.**
   Leave/breaks have no data source in v2 at all (parked at Ian's own earlier instruction), so
   computing a conversion amount would be inventing a number with nothing behind it.

**What that scopes IN, mechanically, reusing exactly what T-189/T-191 already compute correctly:**
wages owed to the separation date (T-189's own `postPayRun`, unchanged — a final pay period is
just a regular pay run whose `periodEnd` is the last worked day, not new code), pro-rated 13th
month (T-191's basic-pay sum, bounded to the separation date instead of Dec 31), advance netting
(`outstandingAdvance`/`advanceToRecover`, unchanged), and a clearance gate (new — an explicit
confirmation, not a computed value).

**What stays OUT, deliberately:** an auto-computed separation-pay amount (§1's finding — the peso
figure is a business decision, captured as a manual entry, not derived), unused leave conversion
(no data source), and any cause-specific statutory formula (captured as a `cause` classification
for record-keeping and future automation, never auto-priced).

---

## 2. Design

### 2.1 A new table, not a reuse of `pay_runs`/`thirteenth_month_runs`

Same reasoning T-191 gave for not reusing `pay_runs`: a separation is its own fact with its own
shape (one per employment, ever — an employment separates once), and neither existing table has a
`cause`, a `clearance`, or a manually-entered `separationPayAmount`.

```
separations
  id, org_id, store_id, employment_id (UNIQUE — one separation per employment, ever),
  person_id, separation_date,
  cause (enum: resignation | just_cause | redundancy | retrenchment | closure | disease | other),

  -- Pro-rated 13th month, same shape as thirteenth_month_payouts: kept alongside the derived
  -- gross for the same audit reason every other money table here keeps its components.
  thirteenth_month_basic_pay_earned, thirteenth_month_gross,

  -- The business decision T-191's formula cannot make. Nullable/defaults to 0 — "not yet decided"
  -- must not silently mean "decided as zero" any more than an unset attendance policy should.
  separation_pay_amount numeric default 0,

  advance_recovered, net_pay,

  -- Clearance is a GATE, not a derived value. postSeparation refuses without it.
  clearance_confirmed_at, clearance_confirmed_by, clearance_notes,

  status (draft|posted|voided), money_account_id, posted_at/by, voided_at/by/reason,
  journal_entry_id, notes, created_by, created_at
```

### 2.2 Wages to the separation date: NOT new code

A final pay period's wages are computed exactly like any other pay run's — `postPayRun` with
`periodEnd` set to the employee's last worked day already does this correctly from
`attendance_days`. **No schema change, no new domain function.** The `/payroll/separations` page
links to `/payroll` pre-filled with that period as a reminder, rather than re-implementing period
computation a second time.

### 2.3 ⛔ The fix T-191 needed: excluding a separated employment from the ANNUAL run

**The double-payment this task would otherwise create.** T-191's `preview13thMonthRun` sums a
FULL YEAR of `basicPay` for every employment at a store, `employmentsForStore` included ended ones
on purpose (T-191 test 9: *"an ended employment... still appears — owed regardless of
separation"*). That was correct **in the absence of T-192** — nothing else paid a departed
employee their 13th month, so the annual run had to. **Once a separation posts a pro-rated
13th-month payout, the annual run must stop also paying it**, or December pays it twice.

**Fix:** `preview13thMonthRun` now excludes any employment with a **posted** `separations` row
whose `separation_date` falls in the requested year. An employment with no separation row (still
active, or separated but not yet processed through T-192) is unaffected — T-191's existing test 9
still passes unchanged, because it never creates a `separations` row.

`basicPayEarnedInYear` gains an optional `asOf` upper bound (defaults to `${year}-12-31`,
T-191's existing behaviour unchanged) so `previewSeparation` can sum only up to the separation
date rather than the whole year.

### 2.4 Clearance is a precondition, not a workflow stage

`postSeparation` requires `clearanceConfirmedBy` and takes it as an explicit input in the same
call — no separate "confirm clearance" step with its own status to track. This is simpler than a
multi-stage workflow and matches the size of what clearance actually is here: "somebody in
authority attests there is nothing outstanding," not a multi-party sign-off chain. If the business
later wants a heavier process, that is a real second slice, not a guess made now.

### 2.5 Domain — `packages/domain/src/payroll/separation.ts`

- **`previewSeparation(tx, actor, { storeId, employmentId, separationDate, cause })`** —
  read-only. Sums `basicPayEarnedInYear(..., asOf: separationDate)` for the separation year, ÷ 12,
  nets `outstandingAdvance`/`advanceToRecover`. `separationPayAmount` is not part of the preview —
  it is entered at post time, a decision, not a computation.
- **`postSeparation(tx, actor, { storeId, employmentId, separationDate, cause, separationPayAmount, moneyAccountId, clearanceConfirmedBy, clearanceNotes, notes? })`**
  — refuses without `clearanceConfirmedBy`. Same self-dealing block as `postPayRun`/`post13thMonthRun`.
  Posts `Dr 6140 (13th-month portion) + Dr 6150 or a separation-pay account (separationPayAmount, if > 0) / Cr 1230 (advance) / Cr money account (net)`.
  ⚠️ **Uses `6150 salary additions`** for `separationPayAmount` — already in the approved chart
  (phase-5-payroll.md §2), no new account needed; separation pay is exactly "an addition to what
  is otherwise owed," which is what 6150 already means.
- **`voidSeparation(tx, actor, { employmentId, reason })`** — mirrors `voidPayRun`/`void13thMonthRun`.

### 2.6 UI — `apps/erp/src/app/payroll/separations/`

Lists ended employments (`employment_status in ('resigned','terminated')`) with no `separations`
row yet — the worklist. Selecting one shows the preview (pro-rated 13th month, advance owed),
a cause selector, a separation-pay amount field (defaulting to 0, clearly labelled as a decision
not a calculation), a clearance confirmation checkbox + notes, and post/void.

---

## 3. Files

| File | Change |
|---|---|
| `packages/db/schema/separations.ts` | New |
| `packages/db/migrations/0116_t192_separations.sql` | New. Hand-written — see DEF-121, `db:generate` cannot diff this repo cleanly |
| `packages/db/src/repo/separations.ts` | New |
| `packages/db/src/repo/thirteenth-month.ts` | `basicPayEarnedInYear` gains an optional `asOf` param; new `hasPostedSeparationInYear(tx, orgId, employmentId, year)` |
| `packages/domain/src/payroll/thirteenth-month.ts` | `preview13thMonthRun` excludes employments with a posted separation for the year (§2.3) |
| `packages/domain/src/payroll/separation.ts` | New. `previewSeparation`, `postSeparation`, `voidSeparation` |
| `packages/domain/src/payroll/index.ts` | `export * from './separation'` |
| `apps/erp/src/app/payroll/separations/page.tsx`, `lib.ts`, `actions.ts` | New |
| `packages/db/src/cutover/classification.ts`, `src/rls/registry.ts` | Classify/scope `separations` — `purge` (2026 pilot data, same as every other 2026-dated payroll table), `org_column` |
| `packages/domain/tests/integration/separation.test.ts` | New |
| `packages/domain/tests/integration/thirteenth-month.test.ts` | New test: a posted separation excludes that employment from the annual run |

---

## 4. Tests

1. ⭐ Pro-rated 13th month sums only basic pay THROUGH the separation date, not the whole year.
2. ⛔ **The fix**: post a separation, then run the annual `preview13thMonthRun` for the same
   store/year — the separated employment does NOT appear (no double payment).
3. Advance netting, same identity as T-189/T-191.
4. `separationPayAmount` defaults to 0 and is NOT auto-computed from `cause` — posting with cause
   `redundancy` and amount `0` succeeds (the system never refuses to let a human decide zero).
5. ⛔ `postSeparation` refuses without `clearanceConfirmedBy`.
6. ⛔ Self-dealing refused, same shape as T-189/T-191.
7. One separation per employment — a second `postSeparation` for the same employment is refused.
8. Void frees the employment... **does NOT** re-include it in the annual run automatically unless
   voided before that year's annual run posts — named as a real edge case, not silently handled:
   see §5.

---

## 5. Do not decide alone — Ian's

| Question | The recommendation on the table |
|---|---|
| **The separation-pay peso amount, per case** | Not decided by this task — manual entry, defaulting to 0. §1's finding stands: cause-specific statutory formulas need policy sign-off this build does not have |
| **Voiding a separation after the year's annual 13th-month run already posted** | Edge case, not built: if a separation is voided late, the employment is not automatically re-included in an already-posted annual run. Re-running would need a correction, same as any other void-after-the-fact in this codebase (a new run, not a silent retroactive fix) |
| **Unused leave conversion** | Deferred — no data source exists. Revisit once a leave-balance system is built |

---

## 6. Deliberately out of scope

| Not done | Why |
|---|---|
| Auto-computed separation pay by cause (Art. 298/299 multipliers) | §1 — a policy decision, not a formula this build should guess |
| Unused leave conversion | §1 — no data source in v2 |
| A multi-stage clearance approval workflow | §2.4 — the size of what clearance actually is here does not warrant it; a real second slice if ever needed |
| Re-including a voided separation's employment in a later annual run automatically | §5 — an edge case named, not solved, pending Ian's call |
| Statutory withholding on final pay | T-190, same as every other payroll task this phase |

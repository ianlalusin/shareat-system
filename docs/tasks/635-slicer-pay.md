# T-635: slicer pay: the slicer records, another staff member confirms, payroll pays per kg

**Owner:** builder (Sonnet), laptop. Auditor: Sonnet (money + payroll + ledger). **Spec:** BOSS (Opus), 25 Nov 2026.
**MIGRATION 0279** (reserved; 0278 is T-634 on the DELL, so renumber at merge if needed).

**Ian, 24-25 Nov 2026:**
- "it looks for staff who is slicer and that staff can record his production. someone, currently other staff not necessary manager has to check and confirm it then the app computes how much payment to pay to the slicer"
- Rate: **per kg of paid slices**.
- Payout: **with payroll, as salary** (like v1).
- "can we do it now" → yes.
- Builds on bible row 326 (14 Oct): a slice record carries who sliced, paid/unpaid and the rate; paying stays in payroll.

## v1, read as requirements

GOAL: pay the slicer for the meat they slice, at a per-weight rate, only after someone else has checked the work. The pay rides the normal salary cycle.

v1 (ERP-rebuild `src/types/inventory.ts` SlicerPaymentPlain, `src/app/inventory/production/payments/*`, `production.actions.ts`):
- the slicer's production records
- a payment over a date range that sums totalPaidWeight
- statuses draft → unpaid (after verify) → paid, paid as salary through salaries payable
- an output line can be marked isPaid:false (rare)

Live data: 237 of 241 production records are Lipa's; 3 payments in about 5 months (CAPABILITY-GAPS, DEF-173).

**Not copied:**
- the separate payment document with its own funding splits (v2 pays through the pay run)
- the dead 'verified' status (v1 bug B6)
- the stub lock `hasLiveSlicerPaymentCovering`, which becomes real here

## Today in v2 (facts)

- `production_records` (packages/db/schema/production.ts:128): kind slice/convert/cook, status draft/posted/void, produced_on, labour_cost.
- Lines are in `production_record_lines`.
- Posting moves FIFO stock (packages/domain/src/production/index.ts). `PROCESSING_LABOUR_ACCOUNT` = 6100.
- `hasLiveSlicerPaymentCovering` (index.ts:86) is a stub returning false. Edit and void already call it.
- Slicer is a canonical position (packages/db/schema/employment.ts).
- Payroll (T-189, packages/db/schema/payroll.ts): `pay_rates`, `pay_runs`, `payslips`. A daily-rate compute from attendance_days, which posts, and freezes the days it paid (`frozenByPayRunId`).

## Rule (v2)

1. **Who sliced.** A slice record gets `performed_by_person_id`.
   - It is required to post a slice record.
   - That person must hold the Slicer position at that store on produced_on.
   - A person holding Slicer can create and post a slice record naming themselves. Anyone with today's production capability can name any slicer.
   - Each slice OUTPUT line gets `is_paid` (default true). Unpaid lines are, for example, re-cuts or trimmings the slicer isn't paid for. Convert and cook records are untouched (row 326: convert stays the unpaid re-cut).
2. **Confirm.** A posted slice record must be confirmed before it counts for pay.
   - It gains `confirmed_by_person_id`, `confirmed_at`.
   - The confirmer must be a different person from `performed_by` (refused in words), must be signed in, and must be staff at that store. Use an existing capability that any staff member can be granted, or add `confirm_slicing` as a position-grantable capability (CAPABILITY-MATRIX; every ✅ needs a test proving the ✗).
   - It is audited. Un-confirm is allowed until paid.
   - Editing a posted record (the existing edit-in-place) clears its confirmation.
3. **Rate.** A per-kg rate, set ON SCREEN (no hard-coded value; STANDING rule).
   - It is an org default, plus an optional per-slice-item override.
   - Append-only and effective-dated like `pay_rates`: the rate in force is the latest row whose effective_from <= produced_on.
   - Edited on a small "Slicer pay rates" section (on the production page or the payroll settings, whichever fits), capability = whoever manages pay rates today.
   - Pay per record = sum over paid output lines of (kg × the rate in force for that slice item on produced_on). Use exact centavos, rounded half-up per record. Weights must be in kg: convert g→kg with the existing unit-conversion module; refuse other units.
4. **Pay.** The pay run for a period includes, per person, a **"Slicer pay"** amount: the sum over their slice records that are confirmed, posted, not void, not yet paid, and dated in the run's period.
   - The payslip shows it as its own line with the kg and the record count, and it adds to gross.
   - Posting the pay run posts it as salary through the existing payroll posting path.
   - Look the posting up in docs/POSTING-PATTERNS.md, and decide carefully how it interacts with `labour_cost` / 6100 on the production record, so labour is never booked twice. If no pattern fits, STOP and report to BOSS with the options; do not invent one.
   - The included records are frozen by the pay run (`paid_by_pay_run_id`, the same idea as `attendance_days.frozenByPayRunId`).
5. **Lock.** Implement `hasLiveSlicerPaymentCovering` for real.
   - Editing or voiding a slice record that a posted pay run has paid is refused in words.
   - Voiding the pay run unfreezes its records.
   - An unconfirmed record is never paid; it waits for a later run.
6. **Screens:**
   - the production record page shows the Slicer, the paid/unpaid toggle per output line (draft only), a Confirm button (not shown to the slicer themself), and confirmed by/at
   - a **"Slicer pay"** view per store: per slicer per period, unconfirmed count, confirmed kg, amount due, paid
   - the pay run / payslip screens show the Slicer pay line
   - phone 390px, no sideways scroll, 44px taps
   - invoke `impeccable`

## Not in this task

- Cash payout outside payroll (Ian chose payroll).
- Per-piece rates.
- Paying for convert or cook runs.
- Statutory changes.
- v1 data import of old slicer payments (the cutover purges operational data).

## Tests (each with a mutant that goes red)

1. Pay maths: kg × rate in force on produced_on, the per-item override over the org default, g→kg, exact centavos, unpaid lines excluded.
2. Confirm: the slicer cannot confirm their own record; another staff member can; editing clears the confirmation; an unconfirmed record is not paid.
3. Pay run: includes only confirmed, posted, unpaid records in the period, for the right person; the payslip line and gross are right; posting balances and does not double-book labour against 6100.
4. Lock: editing or voiding a paid record is refused; voiding the pay run unfreezes.
5. performed_by must hold Slicer at that store on that date.
6. authorize first on every new action; a refusal is tested for each capability ✅.

Migration 0279 is hand-authored (ADR-012 §5): classification + RLS registry + trigger registry + audit catalogue + journal. The full CI suite is required. census:write. Typecheck as in shareat-builder.md.

## As built (builder, 25 Nov 2026)

**MIGRATION 0279** (`0279_t635_slicer_pay.sql`, journal idx 279; 0278 stays T-634's). Hand-authored; no trigger, so no trigger-registry pin moves.
- `production_records`: `performed_by_person_id`, `confirmed_by_person_id`, `confirmed_at`, `paid_by_pay_run_id`, with same-org FKs and three CHECKs (confirmation is a pair; the confirmer is never the slicer; a paid record is confirmed and still posted).
- `production_record_lines.is_paid` (default true). `payslips.slicer_pay / slicer_kg / slicer_records` (zero defaults, so every raw `insert into payslips` fixture still holds) and the gross identity restated with the slicer leg.
- `slicer_pay_rates`: append-only by grants (SELECT + INSERT only), effective-dated, `item_id` null = org default. Classified `keep`; RLS registered.
- Audit catalogue +3 (`production.slicing_confirmed`, `production.slicing_unconfirmed`, `slicer_rate.set`), ceilings 308 -> 311.

**Labour is booked once (POSTING-PATTERNS: `production.conversion.slice` + the payslip entry; no new pattern).** The slicer pay is added to the payslip's gross, so the payslip's own entry (Dr 6100 gross) is the only place it is expensed. The pay run posts nothing against a production record and only freezes it. `labour_cost` stays the capitalisation credit to 6100 at post. The test asserts the run writes exactly one entry, 6100 is debited the gross once, and the entry balances.

**Rulings applied:** the date rule is exactly the attendance rule (BOSS/Ian, 25 Nov): `produced_on between periodStart and periodEnd`, inclusive, the same `between` as `payrollRepo.payableDays`; the period itself comes from `payroll/periods.ts` on the new screen (same picker as payroll). Tested: a record on the period's last day is paid, the day after is not.

**Decisions and limits (BOSS to check):**
- No new capability. Confirm and un-confirm use `record_stock_movement` (position-grantable) at the record's store plus the rule that the confirmer is not the slicer. Rates use `set_pay_rate` (admin; a manager is refused). The Slicer pay view uses `run_payroll`. A slicer posts a slice record naming themselves with `record_stock_movement`; anyone else posts under `post_production`.
- "Holds Slicer on that date": positions are not dated, so it is read as "has the Slicer position now and had an open job at the store on `produced_on`".
- A slicer paid ONLY per kg needs no daily rate (BOSS, 25 Nov): `payslips.pay_rate_id` is now nullable (0279), the slip's gross is the slicer pay alone, statutory applies as for anyone else under their government numbers, and with no daily rate they are not judged a minimum-wage earner. Someone with neither a rate nor slicer pay still gets no slip.
- Slicer pay is in `gross_pay` but NOT in `basic_pay`, so the 13th-month read of `basic_pay` ignores it. Philippine piece-rate earnings usually count as basic salary for 13th month; Ian/the accountant should rule on this. Stays as built; recorded as a question for the accountant (BOSS, 25 Nov).
- Existing posted slice records have no slicer, so they are never paid. A manager names one by editing the record (which also clears any confirmation).
- Editing a posted slice record keeps each output line's existing paid / unpaid (matched to the old line of the same item) unless the form sends a new value (BOSS, 25 Nov), so an edit can never silently overpay.

**Screens:** production form (who sliced, paid / not paid per output line on a slice), production record page (slicer, paid-line ticks on a draft, Confirm / Take back confirmation, checked-by), `/inventory/production/slicer-pay` (per slicer per period, rates section), payroll preview and run history show the Slicer pay column and line. Not yet seen in a browser.

## S2: clock in "as slicer" or "as regular staff" (Ian, 25 Nov 2026)

**Ian's words:**
- "yes they clock in but they dont get daily rate. the thing is we need to configure the app when they sign in they will tell app if they are slicer or regular staff. if they are slicer their day earnings is based on slicing if they are regular staff they are paid in their daily rate. v1 has staff tagged as slicer to have an access to adding slice record".
- Confirmer: "Any staff except slicers".
- Late confirmations: "Paid in the next pay run".

**Rule:**
1. **Clock-in choice.** On the attendance kiosk (/clock, offline Firebase lane), a person who holds the Slicer position at that store is asked once per day, at clock-in: **"Working today as: Slicer / Regular staff"** (big buttons, 44px+). Everyone else clocks in exactly as today.
   - The choice rides on the punch event (an optional field, e.g. `workedAs: 'slicer' | 'regular'`). An event without it (old terminals, queued punches) means regular.
   - The roster mirror the kiosk reads must carry "is a slicer at this store" so the kiosk knows whom to ask. Follow the existing publisher/ingestor pattern in packages/domain/sync and the T-157 punch path; never let the kiosk import server code (clock/README invariants).
2. **The day remembers it.** `attendance_days` gains `worked_as` (regular | slicer, NOT NULL default regular), set by the ingestor from the day's clock-in punch, and kept through the T-157 recompute (derive it from the punches, not as a hand-set column that a recompute overwrites).
   - A manager can correct it on the attendance review page: an adjustment, audited, the T-157 adjustment pattern; the day still recomputes.
3. **Payroll per day:**
   - a `regular` day pays the daily rate as today
   - a `slicer` day pays 0 from the daily rate (its earnings come from slicer pay)
   - a person whose only days in the period are slicer days needs NO daily rate (no `unratedEmployments` refusal for them)
   - a person with regular days and no rate is still refused as today
   - the payslip shows "Regular days N" and "Slicer days N"
4. **Who may add slice records:** creating or posting a slice record naming yourself needs the Slicer position (like v1). Others keep today's production capability rule.
5. **Confirmer = any staff at that store who does NOT hold the Slicer position there** (domain rule + test; the DB CHECK confirmer != slicer stays).
6. **Late confirmations carry forward:** a pay run includes confirmed, posted, unpaid slice records with produced_on <= periodEnd (not only inside the period). Earlier-period ones show as "from an earlier period" on the slip and the Slicer pay view. Attendance days keep their exact period window.

**Audit fixes folded in here:**
- The paid tick on the record page uses the house `Checkbox`, then census:write (unresolved back to 50).
- An unpriceable slice record (unit not kg/g, no rate in force, no job that day) is SKIPPED with a warning in the pay-run preview and stays unpaid. It never blocks the run.
- Accountant questions (recorded, not built): whether slicer pay should count in basic pay for PhilHealth, Pag-IBIG and the 13th month.
- Migration ordering: T-634 (DELL) also adds a migration; whichever merges second takes the next number with a `when` above the other's.

**Tests (each with a mutant):**
- the kiosk asks only slicers, and the choice reaches attendance_days
- a missing field means regular
- a slicer day pays 0 daily, a regular day pays the rate
- slicer-only days need no rate
- a manager correction is audited and survives a recompute
- a Slicer-position confirmer is refused
- a late-confirmed earlier record is paid in the next run, exactly once
- an unpriceable record is skipped, not blocking

## S2 as built (builder, 25 Nov 2026) - folded into migration 0279 (still unapplied anywhere)

**Migration 0279 (S2 part):** `attendance_punches.worked_as` (null allowed), `attendance_days.worked_as` (NOT NULL default regular), `attendance_adjustments.worked_as` + the new kind `worked_as` (kind CHECK and the payload whitelist restated), `payslips.slicer_days` and `slicer_earlier_records`. Applied clean on a fresh scratch DB (t635s2_test).

- **Kiosk:** `/clock` stays Firebase-only. The roster mirror document gains `isSlicer` (any open canonical Slicer position, primary or not; the position trigger already re-enqueues the roster). `lane.ts` `mustChooseWorkedAs(intent, who)` decides: only a slicer clocking IN is asked, with two 56px buttons; the punch is written when one is pressed; no answer in 30 s records nothing and says so. `writePunch` adds `workedAs` only when chosen. Firestore rules: `workedAs` optional, `slicer`/`regular` only. An event without it is regular and still ingests; any other value is quarantined as malformed.
- **The day remembers it, derived:** `adjudicateDay` sets `worked_as = live adjustment ?? first clock-in punch's value ?? regular` on every recompute. A manager's correction is a `worked_as` adjustment (audited like the other kinds: who, which session, superseding the last), saved from a "Worked as" card on the attendance day page. `slicer` is refused for someone without the Slicer position that day.
- **Payroll per day:** only regular days are priced and need a rate; slicer days pay 0 from the daily rate but are still frozen to the run. A person with slicer days only and no rate gets no unrated refusal. The slip and the preview show Regular days N and Slicer days N.
- **Confirmer:** a person who holds the Slicer position at the store cannot confirm (domain rule; the DB CHECK confirmer != slicer stays).
- **Late confirmations:** a run pays every confirmed, posted, unpaid record with `produced_on <= periodEnd` (attendance days keep their exact window). Earlier-period ones are counted on the slip (`slicer_earlier_records`) and on the Slicer pay view ("from an earlier period"). Paid once: the freeze (`paid_by_pay_run_id`) excludes them from every later run; voiding the run releases them.
- **Unpriceable records are skipped:** no rate in force, a unit that is not kg or g, or no job that day gives a warning in the preview and Slicer pay view; the record stays unpaid and unfrozen and the run still posts (the S1 post-time refusal is gone, and the test that asserted it now asserts the skip).
- **Rule 4 (who may add slice records):** unchanged and already true: naming yourself needs the Slicer position (`slicerRefusal` at draft and at post); everyone else keeps `post_production`.
- **Audit fixes:** paid tick uses the house `Checkbox`; slicer rate form converted to `CheckedForm` with `SLICER_RATE_RULES`; census pins re-written.

**Shortcuts and doubts (BOSS to check):**
- The kiosk asks at every clock-IN by a slicer (not literally once per day); only the day's first clock-in decides, so a second answer is harmless. A "once per day" ask would need the day feed to carry `workedAs` too.
- A device can assert `slicer` for someone who does not hold the position; the server stores it as sent. The cost falls on that person (a slicer day pays 0 daily and they have no slicer pay), and a manager can correct it. Not checked at ingest.
- t384-s3 and t411 guard classifications were added as exemptions (the Set-a-rate window and the draft slicer form are not edit-in-place records; Confirm and Take back confirmation are COMMANDS). Marked NEEDS BOSS APPROVAL in the test files.
- The slicer-pay.ts and slicer-pay-math.ts string-date comparisons are EXEMPT in the t371 G2 guard as ISO-date ordering, like the other date comparisons there.
- **Rollout (audit round):** 0279 ends its attendance part with a one-time roster republish: one `mirror_outbox` roster upsert per live employment (the row the 0088 trigger enqueues; not for an ended job or an inactive person; skipped if an unpublished row already exists), so the first publisher pass after deploy rewrites every roster document with `isSlicer`. Without it a slicer would get no prompt, the day would be regular, and the person would be paid the daily rate PLUS slicer pay. A test runs the migration's own block. The two `worked_as` CHECKs on the big attendance tables are added NOT VALID then VALIDATEd.
- **Not built, on purpose:** no republish trigger on the positions table. Giving someone the Slicer position makes the employment-positions trigger republish their roster already, and the ingestor re-checks the position on every slicer tap (a non-slicer tap is stored as regular), so a stale roster cannot overpay.
- **Frozen day:** a late punch is recorded but the day is untouched (counted as an adjudication failure); a `worked_as` correction on a frozen day is refused. Tested.
- **Ended employment:** a late-confirmed record of a slicer whose job has ended is still paid; the slip takes the name from `persons`, not the active roster. Tested through statutory.
- **Post result:** `postPayRun` returns `slicerSkipped` (the unpriceable-record warnings) and the post confirmation shows them.


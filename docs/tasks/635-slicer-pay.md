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

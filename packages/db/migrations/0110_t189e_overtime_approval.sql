-- T-189e — the overtime approval gate. ⛔ CLOSES A DEFECT IN T-189.
--
-- `attendance_days.pending_ot_minutes` carries this warning, written by the attendance lane FOR
-- Phase 5:
--
--   "⛔ The short-shift / late-out remainder. Recorded, never paid here — the approval gate is
--    Phase 5, and auto-paying it is exactly what the pending status exists to prevent."
--
-- T-189's `previewPayRun` read `pending_ot_minutes` straight into `otMinutes` and PAID IT. The
-- gate the comment names did not exist, so every pending minute was paid the moment a run posted —
-- the precise thing the pending status exists to prevent, walked past by the module it was
-- addressed to. Recorded as DEF-109.
--
-- ⭐ The gate is a sixth ADJUSTMENT KIND rather than a column on the day, and that is the right
-- home: `attendance_adjustments` is explicitly the DECISION layer — append-and-supersede, naming
-- who decided and under which session. Approving overtime is exactly that kind of fact, and a
-- manager who approves 2h of a 3h claim is a decision the day itself must not absorb.
--
-- Ian's model, 2026-08-31: "undertime is provisional OT — 5hr is set halfday, 9hr for wholeday, a
-- 7 hour duty is halfday plus provisional 2 hour OT to be approved by manager."
--
-- Hand-written, per DEF-073. Never edited after apply.

ALTER TABLE "attendance_adjustments" DROP CONSTRAINT IF EXISTS "attendance_adjustments_kind_check";

ALTER TABLE "attendance_adjustments" ADD CONSTRAINT "attendance_adjustments_kind_check"
  CHECK ("kind" in ('start_anchor', 'early_out_approved', 'half_day_override', 'verify', 'void',
                    'overtime_approved'));

-- How many of the day's PENDING minutes the manager accepts. ⚠️ Not "the overtime worked" — the
-- day already records that. This is what somebody agreed to pay for, which may be less.
ALTER TABLE "attendance_adjustments" ADD COLUMN "approved_ot_minutes" integer;

-- ⭐ T-158's payload shape check is an EXHAUSTIVE whitelist: every kind names exactly which
-- payload columns it may and may not carry. A new kind that is not listed is refused outright,
-- which is how this constraint caught `overtime_approved` the moment it was inserted. Extending it
-- is the correct move, not adding a second constraint beside it — one place says what a kind may
-- carry, or the two eventually disagree.
ALTER TABLE "attendance_adjustments" DROP CONSTRAINT "attendance_adjustments_payload_shape_check";

ALTER TABLE "attendance_adjustments" ADD CONSTRAINT "attendance_adjustments_payload_shape_check" CHECK (
  ("kind" = 'start_anchor' AND "chosen_anchor_minute" IS NOT NULL
     AND "effective_out_minute" IS NULL AND "is_half_day" IS NULL AND "approved_ot_minutes" IS NULL)
  OR ("kind" = 'early_out_approved' AND "effective_out_minute" IS NOT NULL
     AND "chosen_anchor_minute" IS NULL AND "is_half_day" IS NULL AND "approved_ot_minutes" IS NULL)
  OR ("kind" = 'half_day_override' AND "is_half_day" IN ('true','false')
     AND "chosen_anchor_minute" IS NULL AND "effective_out_minute" IS NULL AND "approved_ot_minutes" IS NULL)
  -- ⛔ Zero is a legitimate decision — "I looked at this and I am approving none of it" — and it
  -- is NOT the same as never having decided, which is why `approved_ot_minutes` is required here
  -- rather than merely allowed. Negative is not a decision at all.
  OR ("kind" = 'overtime_approved' AND "approved_ot_minutes" IS NOT NULL AND "approved_ot_minutes" >= 0
     AND "chosen_anchor_minute" IS NULL AND "effective_out_minute" IS NULL AND "is_half_day" IS NULL)
  OR ("kind" IN ('verify','void') AND "chosen_anchor_minute" IS NULL
     AND "effective_out_minute" IS NULL AND "is_half_day" IS NULL AND "approved_ot_minutes" IS NULL)
);

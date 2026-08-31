-- T-197 — `shortShiftHalfDayOt` on, because the business already has it on. Closes DEF-112.
--
-- ⭐ THE EVIDENCE, from the raw v1 capture (no default merge — `capture-attendance-golden.ts:84`
-- reads the store document literally):
--
--     store          sessions   shortShiftHalfDayOt
--       Lipa              442          true
--       Malvar            100          true
--       Banay-Banay        18          true
--
-- v1's own default is FALSE (`ERP-rebuild/src/types/attendance-config.ts:205`), so all three
-- operating stores turned this on deliberately. ⛔ v2 shipped `false`, which does not preserve the
-- status quo — it REVERSES it. Measured on the 560-session corpus: 51.5 days a month, ~9.2% of
-- basic pay, across three stores.
--
-- ⭐ The DEFAULT is the fix rather than a per-store toggle, because v2 always assumes a zero
-- starting point: every store is created fresh and `seedAttendanceConfig` inserts with no explicit
-- values, so the column default IS the policy every future store receives.
--
-- ⚠️ A store that genuinely wants it off supersedes its config — that path is untouched. What
-- changes is which way the UNCHOSEN case points.

alter table "store_attendance_config"
  alter column "short_shift_half_day_ot" set default true;--> statement-breakpoint

-- ⛔ **AND THE EXISTING ROWS ARE DELIBERATELY NOT TOUCHED HERE.**
--
-- The first draft of this migration ran `update store_attendance_config set ... = true`, and
-- T-155's immutability trigger refused it by name: *"rows are immutable — supersede with a new row
-- instead of editing row ..."*. That refusal is correct and it is the better design.
--
-- A config row is EFFECTIVE-DATED, and T-157 invariant 11 depends on it: *"a day is judged by the
-- config that governed IT"*. Rewriting a live row in place would retroactively restate the policy
-- every already-computed day was judged under. Changing the policy for an EXISTING store is a
-- business decision with an effective date, and `supersedeConfig` is the path that exists for it —
-- the same path a settings screen will call.
--
-- ⭐ So this migration changes only what a store gets when nobody has chosen: the default. Every
-- store created from here on matches live practice. An already-created store is superseded through
-- the service, on a date somebody picked.

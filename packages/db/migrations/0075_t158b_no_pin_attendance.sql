-- D1, decided 2026-08-29 — PIN is not a mode of attendance in v2.
-- Ian: "in v2 only fingerprint face and card will be mode of attendance no pin"
--
-- ⛔ Made UNREPRESENTABLE rather than disabled. Bible 12: each inherited failure must be made
-- "structurally impossible, not merely avoided by care", and a kill switch left in the wrong
-- position is precisely the class of defect this project exists to close (landmine 12: two
-- switches governed one behaviour; only one was enforced). There is no switch here to get wrong.
--
-- ⚠️ A FORWARD migration rather than an edit to 0071/0072, which are committed. Bible rule 9 is
-- absolute -- "an applied migration is never edited, write a new one" -- and this is a genuine
-- change of requirement arriving after the tables shipped, which is exactly what a forward
-- migration is for.
--
-- ⭐ What is NOT closed: `person_credentials.kind = 'pin'` stays. Signing in to the app and
-- clocking in are different acts, and only the second one is a punch.

-- 1. The punch method. A `pin` punch becomes impossible, not merely refused by config.
alter table "attendance_punches"
  drop constraint "attendance_punches_method_check";--> statement-breakpoint

alter table "attendance_punches"
  add constraint "attendance_punches_method_check"
  check ("method" in ('nfc','qr','fingerprint','face','manual'));--> statement-breakpoint

-- 2. The kill switch with nothing left to govern. Dropping it rather than defaulting it to false:
-- a column that can only ever hold one value is a question nobody should be asked.
alter table "store_attendance_config"
  drop column "credential_passcode";--> statement-breakpoint

-- 3. Face stays online-only PERMANENTLY (bible 5.3, the 2026-07-04 exfiltration fix) -- but it IS a
-- mode of attendance, so its switch stays. Fingerprint and card likewise. No change to those three.

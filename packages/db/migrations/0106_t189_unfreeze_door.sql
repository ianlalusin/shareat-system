-- T-189 — the one door out of a freeze, for voiding a pay run.
-- docs/tasks/189-pay-rates-and-the-pay-run.md §7.1
--
-- ⚠️ THIS AMENDS ANOTHER LANE'S TRIGGER, and deliberately. T-157's
-- `attendance_days_refuse_frozen_update` refuses every UPDATE on a frozen day, and its own comment
-- says the correction "goes through payroll, where somebody is accountable for it" — but payroll
-- was never given a door. Without one, voiding a mis-posted run is impossible and the days it
-- touched are stranded: frozen against a run that no longer pays them, unpayable by anyone, for
-- ever.
--
-- ⭐ The door is as narrow as it can be made: an update may clear the freeze ONLY IF it changes
-- NOTHING ELSE on the row. A recomputation moves `computed_minutes`, `status`, `anomalies` or
-- `explain`, so it is still refused exactly as before — the invariant T-157 wrote ("a frozen day
-- that can be quietly unfrozen is not frozen") is preserved in the sense that matters: a frozen
-- day cannot be RESTATED. It can only be released, whole, by the module that froze it.
--
-- The comparison is over every column via jsonb rather than a hand-written list, so a column added
-- to attendance_days later is covered without anybody remembering to add it here.

CREATE OR REPLACE FUNCTION attendance_days_refuse_frozen_update() RETURNS trigger AS $$
BEGIN
  IF (tg_op = 'DELETE') THEN
    IF (old.frozen_at IS NOT NULL) THEN
      RAISE EXCEPTION 'attendance day % is frozen by pay run % and cannot be deleted',
        old.id, old.frozen_by_pay_run_id USING errcode = 'restrict_violation';
    END IF;
    RETURN old;
  END IF;

  IF (old.frozen_at IS NOT NULL) THEN
    -- ⭐ THE ONLY EXCEPTION: releasing the freeze and touching nothing else. This is what
    -- `voidPayRun` does, and it is why the pair is nullable rather than a boolean.
    IF (new.frozen_at IS NULL
        AND new.frozen_by_pay_run_id IS NULL
        AND (to_jsonb(new) - 'frozen_at' - 'frozen_by_pay_run_id')
          = (to_jsonb(old) - 'frozen_at' - 'frozen_by_pay_run_id')) THEN
      RETURN new;
    END IF;

    RAISE EXCEPTION 'attendance day % is frozen by pay run % — recomputation is refused. Correct it through payroll, not by restating the day.',
      old.id, old.frozen_by_pay_run_id USING errcode = 'restrict_violation';
  END IF;

  RETURN new;
END;
$$ LANGUAGE plpgsql;

-- T-198 — the clock mirror stops publishing the entire attendance history. Closes DEF-118.
--
-- ⛔ THE DEFECT, MEASURED. Bible §5.3 defines hot-set item 4 as the "current business day" punch
-- feed — *small*, refreshed every few minutes. `mirror_enqueue` takes no date filter and the
-- trigger fired on EVERY `attendance_days` insert or update, so any touch of any day, however old,
-- queued a Firestore write. On the dev database: 24 of 24 day_feed publishes were for days that
-- are NOT the current business day. 100%.
--
-- ⚠️ And payroll DOUBLED it: T-189's `freezeDays` updates every day a run pays, so each historical
-- day carried two publishes — the original adjudication and the pay run's freeze. A semi-monthly
-- run across three stores would enqueue hundreds of writes for days no terminal will ever show.
--
-- ⭐ Worse: NOTHING READS IT. `apps/erp/src/lib/terminal/lane.ts` subscribes the terminal to
-- roster, config and credentials only. v2 was publishing the whole attendance history to Firestore
-- and consuming none of it — pure cost, growing with every pay run.
--
-- ⭐ THE FIX IS A TRIGGER `WHEN` CLAUSE, NOT A PUBLISHER FILTER. The cost is the outbox row AND the
-- Firestore write, and both happen upstream of anything the publisher could decide; filtering later
-- would still pay for the queue row and leave the outbox growing without bound.
--
-- ⚠️ TWO DAYS, not one, and the second day is not slack:
--   · a night shift beginning 22:00 belongs to the previous business day and is still being
--     punched after midnight;
--   · ⭐ OFFLINE REPLAY is the entire point of the inbox lane — a terminal that was offline
--     replays punches hours later, and `shift_day` is the BUSINESS day, not the arrival time. A
--     one-day window would silently drop exactly the punches the offline design exists to protect.
--
-- ⚠️ `(now() at time zone 'Asia/Manila')::date`, never bare `current_date`: `current_date` follows
-- the SESSION timezone, and a production database running UTC is eight hours behind Manila — the
-- window would roll at 08:00 local. A trigger WHEN clause cannot reach `organizations.timezone`,
-- so the literal is pinned here, which is the same discipline the bible requires for business dates
-- everywhere else.

drop trigger if exists attendance_days_mirror_enqueue on "attendance_days";--> statement-breakpoint

create trigger attendance_days_mirror_enqueue
  after insert or update on "attendance_days"
  for each row
  when (new."shift_day" >= ((now() at time zone 'Asia/Manila')::date - 1))
  execute function mirror_enqueue('day_feed');

-- 0156 — T-336 SCOPE LIFECYCLE fix (auditor finding 1, RULED 2026-09-24: Ian/Opus judgement,
-- orchestrator). docs/tasks/336-per-position-access-defaults.md, "SCOPE LIFECYCLE" section, Fix A.
-- Re-allocated from T-276, which moves to 0157 — no gap is ever applied out of order (ADR-012 §5
-- item 1; DEF-039's shape is exactly what a misordered journal `when` produces).
--
-- ⛔ THE BUG THIS CLOSES. T-336 made `createEmployment` grant `person_store_scope` for the hired
-- store so a fresh hire can work day one. Nothing then revoked it: a terminated cashier kept
-- sign-in at that store forever, and a person hired at store B while still (wrongly) scoped to
-- store A from an earlier, ended employment kept reaching A too. `source` is what makes a safe
-- revocation possible: it records WHY a row exists, so `endEmployment` can delete a row it wrote,
-- and only that one — never an admin's deliberate grant, never the new-admin/new-store fan-out.
--
-- ⛔⛔ `DEFAULT 'manual'`, RULED 2026-09-24, not a bare `NOT NULL`. ~147 raw inserts predate this
-- column — `scripts/dev-seed.ts:121` and 84 test fixtures — and never will pass `source`; only
-- `packages/domain/src/people/index.ts`'s `createEmployment` ever writes `'employment'`. A caller
-- with no opinion on provenance is, by construction, the same shape as a deliberate manual grant,
-- so the default backfills every existing row AND covers every future caller this migration cannot
-- see, in one declaration — no separate UPDATE pass is needed. (`now()` is constant for the whole
-- duration of one transaction, so an earlier draft's plan to classify old rows by timestamp
-- proximity to a sibling `stores.created_at` / `person_roles.granted_at` write was measuring
-- something that cannot drift within a real fan-out transaction; the apparent drift in that
-- measurement came from comparing rows across DIFFERENT transactions, not within one — moot now
-- that every pre-existing row collapses to `'manual'` regardless.)
alter table "person_store_scope" add column "source" text not null default 'manual';--> statement-breakpoint

-- Same discipline as `person_roles`/`positions`: the enum lives in the TS column type AND as an
-- explicit CHECK, so a raw INSERT bypassing the builder cannot store a fourth value silently.
alter table "person_store_scope" add constraint "person_store_scope_source_check"
  check ("source" in ('employment', 'manual', 'fan_out'));--> statement-breakpoint

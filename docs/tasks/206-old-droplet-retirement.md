# T-206 — Retire the old droplet (ERPNext/Frappe + the POS Transaction Archive)

> **Status:** 📋 **Scoped, not started.** Written 2026-09-04 at Ian's request, after T-205 gave
> shareat-system its own new dedicated droplet — which means retiring the old one is no longer
> something shareat-system's deployment waits on. This spec exists so the checklist and the
> POS-archive gap aren't lost between now and whenever the trigger conditions below are met.
> **Depends on:** `ADR-002-infrastructure-and-auth.md`'s "droplet reuse at cutover" amendment
> (2026-09-04) for the ERPNext retirement steps — written for a since-superseded plan, but the
> steps themselves are still correct. `ADR-007-pilot-then-purge.md` for the cutover/purge timeline.
> **Do NOT start this task until the trigger conditions below are actually met.**

## Why this exists, and why it isn't urgent

T-205 stood up a **new** droplet dedicated to shareat-system. The old droplet
(`159.223.78.207` — 4 GB RAM, 80 GB disk, SGP1, ~$20/mo, already paid for) keeps running exactly
as it always has: the ERPNext/Frappe legacy stack (~11 containers) and the POS Transaction Archive
(a separate live production system, unrelated to either ERPNext or shareat-system).

Ian, 2026-09-04: *"for shareat system we will create our own POS right so the db of that will be
shared... so yes all old erpnext pos data will be backed up then its droplet and space will be
retired."*

**Nothing gets worse today if this sits unexecuted.** The honest trigger is months out — see below.

## Trigger conditions — do not start until BOTH are true

1. **Shareat System has its own POS app**, sharing the same Postgres backend as ERP (ADR-003, "1
   backend for erp and pos and customer app"). This is what actually makes the POS Transaction
   Archive redundant — see the analysis below — and it does not exist yet; it is its own
   unscoped project.
2. **The ADR-007 pilot/purge window has arrived or passed** (Oct–Dec 2026 pilot, purge from
   1 January 2027). Retiring the business's live legacy books and its transaction archive before
   the pilot has proven v2 works would be retiring the safety net while still testing the parachute.

## Part 1 — ERPNext/Frappe retirement (steps already drafted, consolidated here)

This is `ADR-002`'s existing 5-step sequence, unchanged in substance — it was written for a plan
where Shareat System would deploy onto this same droplet afterward; that last step no longer
applies, but steps 1-4 are the actual retirement and remain correct:

1. **Confirm with whoever operates Frappe first.** Per bible §1.2a, `ERP-rebuild` and the Frappe
   migration are both actively owned by someone else alongside Ian — this is not a unilateral
   infra call just because Ian holds root on the box.
2. **Final backup, verified**: `bench backup --with-files`, confirmed complete, with the existing
   rclone job having shipped it to Spaces (`shareat-erp-backups`, SGP1) before anything is stopped.
3. **Never delete the Spaces backups.** They are the only surviving record of the Frappe/ERPNext
   work. Statutory retention (BIR) runs years, not months.
4. **Stop and remove the `erpnext_prod` stack** (`docker compose -p erpnext_prod down`, then
   `docker system prune`) to reclaim the space.

**Not superseded, not re-litigated** — reproduced here so a future session doesn't have to dig
through `ADR-002`'s amendment history to find it.

## Part 2 — the POS Transaction Archive (new — not covered by any existing doc)

**What it is**: a standalone project (`POS MIGRATION` on this machine), nightly cron at 2am
Asia/Manila, pulling POS receipts/lines/payments from Firestore (`shareat-hub-v2`) into a
dedicated Postgres container (`pos_archive_db`) on the old droplet — because v1 POS has no
queryable transaction history of its own, only per-document Firestore reads. **~9,600+ receipts
as of 2026-08-19 and growing daily**, actively used, not vestigial.

**Why trigger condition 1 (v2's own POS) makes it structurally redundant, not just relocatable**:
the archive exists ONLY because v1 POS writes to Firestore, which isn't queryable at scale. Once
Shareat System has its own POS writing directly into the SAME shared Postgres ERP already uses
(ADR-003), transactions are natively queryable from the moment they're created — there is nothing
left to archive nightly from Firestore, because Firestore stops being the system of record for
new POS transactions at all.

**What this means for the OLD archive's data** (Ian to decide, not decided here):
- **Option A — absorb it.** One-time import of the ~9,600+ historical receipts into
  Shareat System's own schema, so v2's reports can see pre-cutover POS history too. Real work:
  a new one-off ETL, similar in shape to the ERP capture/audit tooling already built for the main
  cutover (`packages/etl`), but a distinct source (POS's Firestore shape, not ERP's).
- **Option B — leave it archived, standalone.** `pos_archive_db`'s data gets a final backup and
  the container (and the droplet under it) is retired; historical POS receipts remain queryable
  only by restoring that backup, not from within Shareat System.
- **Not this task's call to make** — flagged as an open question for whoever picks this up,
  informed by whether the business actually needs pre-cutover POS history inside v2's reports.

### POS archive retirement steps (parallel structure to Part 1)

1. **Confirm the nightly job is stopped cleanly** before backing up — a backup mid-write is not a
   backup. Check `/root/pos-archive/logs/` for the last clean run first.
2. **Final backup, verified**: dump `pos_archive_db` (the whole cluster, not just `public`), ship
   it to Spaces under its own prefix (**never** interleaved with the Frappe backups — same rule
   ADR-002 already applies to Frappe, extended here).
3. **Decide Option A vs B above** before deleting anything live.
4. **Stop and remove** the `pos_archive_db` container once the backup is verified restorable (a
   test restore, not just "the dump command exited 0" — `ADR-002`'s own "an untested backup is not
   a backup" standard applies here too).

## Part 3 — actually retiring the droplet

Only after both Parts 1 and 2 are done and verified:

1. Confirm nothing else is running on the box (`docker ps`, `systemctl list-units`) — the original
   open question from `ADR-002`'s Task 2 decision table, never actually closed.
2. `doctl compute droplet delete` (or the console equivalent) — irreversible, needs Ian's explicit
   go-ahead in the moment, not pre-authorized by this spec.
3. Decide the Spaces bucket's own fate separately — `ADR-002` already says explicitly not to
   delete the Frappe backups "until Shareat System is cut over and reconciled, and only on Ian's
   explicit say-so." Same standard applies to the POS archive backups from Part 2.

## Scope — explicitly out of this task

- Building Shareat System's own POS app — the actual project that trigger condition 1 depends on.
  Not scoped here; this task only names it as a dependency.
- Deciding Option A vs B for the POS archive's historical data — flagged, not decided.
- Anything happening before the trigger conditions are met.

## Verification, when this is actually executed

1. A restore drill from the Spaces backup for BOTH the Frappe and the POS archive dumps, before
   either live copy is removed — proves the backup, not just its existence.
2. Written sign-off from Frappe's co-owner, dated, recorded here or in the bible's decision log.
3. `doctl compute droplet list` no longer shows `SharEat-Droplet` (or shows it stopped, if Ian
   prefers stop-and-hold over delete for a grace period — his call at execution time).

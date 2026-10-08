# T-385: a sales day is verified and posted only after it is submitted

**Status:** BUILT 2026-10-09 on `release/t385` (S1-S4 incl. B1 self-verify); Opus-audited (0 money/auth findings, 1 UI gap fixed); browser-smoked. **PR #3 waits for Ian's 0188 prechecks (P0188c = 0, P0188f only Ian) and its CI.** SPEC 2026-10-09 (Opus planner), written at `release/t384-sweep` `b4e917e`.
**Model:** Sonnet for each slice, tester first, then builder. Any amendment is written in plan mode (Opus).
**Migration:** **0188**, hand-authored per ADR-012 §5, gated on the FULL suite (CI on a PR, bible row 291; memory: a
CHECK/trigger migration is gated on the full suite on a fresh gate DB). Prechecks go in `docs/ops/README.md` before the
push. S3 may need **0189** (see S3), allocated only if Ian answers (a).
**Ruling behind it:** Ian, 2026-10-09, verbatim: *"verify and post must be blocked until submitted"*.
**Defect (PROPOSED; the orchestrator allocates; the register's head is DEF-617):** **DEF-618** (⛔ control missing) —
`runVerify` (`packages/domain/src/sales-days/verify.ts:68-92`) refuses only `voided` and no-ops on `verified`, so an
`open` (never submitted) day can be verified and posted; the day page offers "Verify & post" on `open` days
(`apps/erp/src/app/sales-days/[id]/page.tsx:473`). The two-step review the schema records (`submitted_by`,
`verified_by`, `packages/db/schema/sales-days.ts:90-96`) is optional in practice.
**Open question:** `t385-q1-different-verifier` (S3). S1, S2 and S4 do not wait for it.

## Goal
- A sales day moves `open` → `submitted` → `verified`, and never `open` → `verified`. Not through the app, not through a
  raw `UPDATE` under the app role.
- Re-verifying a `verified` day stays a safe no-op that returns the existing entry (unchanged).
- The day page shows "Verify & post" only on a `submitted` day. An `open` day shows Submit, with one line saying verify
  comes after.
- Days verified before 0188 without a submit (history) stay exactly as they are and keep working (void, reports).

## v1 as requirement (bible §1.2d: study, goal, count, beat)
1. **What v1 does.** `ERP-rebuild/src/lib/actions/sales-day.actions.ts`: submit (`:330-365`) is cashier-or-manager,
   only from `open`, and refuses a newer day while an older one is unverified. Verify (`:84-120`) accepts `open` OR
   `submitted` — the comment calls `submitted` *"the legacy pre-rebuild name for the same state"*. The screen
   (`src/app/financial/sales-report/page.tsx:726-738`) shows **Submit for Review** to the cashier on `open` and
   **Verify** to a manager/admin only on `submitted`. So v1's screen enforces the order; its server does not.
2. **The goal underneath.** A day's figures are looked at by a second person before they become revenue: the cashier
   closes and hands over ("Submit for Review"), a manager checks and posts. v1 knows this (four-role `signoff`, the
   screen gating) and fails it at the server, which is the layer that matters.
3. **Count.** Production holds the live number in P0188a/b (run with Ian). v1's own data on the sibling control:
   **577 of 1,324 verified receipts (44%) were verified by whoever submitted them** (DEFECTS-REGISTER 2026-08-28 entry,
   the 0046 two-person rule) — evidence that a rule left to the screen is not kept.
4. **Beat it.** The order is enforced in the domain (a plain sentence) AND in the database (a trigger), so no screen,
   script or raw SQL under the app role can post an unsubmitted day. Self-verify is S3, Ian's call.

## Census, verified at source (`b4e917e`)

### Who moves a day to `verified`
- **Only** `salesDaysRepo.markVerified` (`packages/db/src/repo/sales-days.ts:639-665`), WHERE status IN
  `UNVERIFIED_STATUSES` (`['open','submitted']`, `:32`). **Its only caller** is `runVerify` (`verify.ts:131`).
- `verifySalesDay`'s only production caller: `verifySalesDayAction` (`apps/erp/src/app/sales-days/actions.ts:237-248`).
  `create.ts`, `edit.ts`, `service-charge/index.ts` name it only in comments.
- `insertSalesDay` (`repo/sales-days.ts:338`) takes no `status`, so every app-created day is born `open` (column
  default). The POS import (T-375) creates `open` days and re-imports while `open` or `submitted`
  (`domain/src/sales-days/import.ts:96-110`); it never submits or verifies.
- **ETL / cutover / scripts: none verifies.** `packages/etl` converts v1 specimens for the ledger replay and the audit;
  it writes no `sales_days` row (grep `sales_days|salesDays` in `packages/etl/src`: `audit/groups.ts`, `convert.ts`,
  both read-side). Cutover classifies `sales_days` as **purge** (`packages/db/src/cutover/classification.ts:227-233`).
  No file under `scripts/` names the table. **So no production path verifies without submitting except the gap
  itself; nothing to migrate or re-route.**
- `postPosCorrection` (`correction.ts:62`) acts on an already-verified day and never changes status.

### The screen (`apps/erp/src/app/sales-days/[id]/page.tsx`)
- `:459-471` Submit form when `status === 'open'` (no capability probe; the domain authorizes).
- `:473-489` "Verify & post" when `open || submitted`. Its text already says *"The person who submits should not be
  the one who verifies."*
- `:171-176` amber banner on any unverified day. `:66-81` `can` probes (`edit`, `void`, `verify`).

### Database today
- `sales_days_status_check` (0016:53) allows the four values; **no transition rule exists**.
- `sales_days_figure_lock` (0185:112, BEFORE INSERT OR UPDATE) never locks a status move (0185 header; T-375 R6).
- Trigger registry `packages/db/src/triggers/registry.ts`: every trigger must be classified (T-354 guard).

### Constraint sentences
- `apps/erp/src/lib/constraint-messages.ts:23` `CONSTRAINT_MESSAGES`; key count pinned at **41** in
  `apps/erp/tests/constraint-messages.test.ts:178` and
  `apps/erp/tests/integration/constraint-message-lookup-mechanism.test.ts:137`;
  `apps/erp/tests/integration/constraint-message-lookup.test.ts:557` requires every key to be exercised.

## S1: domain — verify refuses unless the day is submitted

**R1.** In `runVerify`, after `authorize` and after the existing `verified` no-op (unchanged, still first) and the
`voided` refusal: if `day.status !== 'submitted'`, throw `refuse(...)`:
- log: `verifySalesDay: sales day ${id} is ${status} — only a submitted day may be verified`
- sentence (plain, Ian's words): **"This sales day hasn't been submitted yet. Submit it first; it can be verified and
  posted after that."**
The check sits BEFORE routing and `postEntry`, so no entry is attempted. The row lock (`getByIdForUpdate`) is kept, so
a submit racing a verify serialises.
**R1a.** `markVerified` narrows its WHERE from `UNVERIFIED_STATUSES` to `status = 'submitted'` and its `recordGone`
message to "or is not submitted" (defence in depth, same idiom as `markSubmitted`). `UNVERIFIED_STATUSES` itself is
untouched (other callers).
**R1b.** Verify.ts's header comment gains one line: verify requires submitted (T-385, Ian 2026-10-09).

### S1 files
- TESTER: `packages/domain/tests/integration/t385-s1-verify-requires-submit.test.ts` (new);
  `packages/domain/tests/integration/_fixtures/sales-day-flow.ts` (new helper, below); the fallout files (below).
- BUILDER: `packages/domain/src/sales-days/verify.ts`; `packages/db/src/repo/sales-days.ts` (`markVerified` only).

### S1 tests (red first, each with why it is red today, and its mutant)
- V1 open day, verify as manager → refused with the R1 sentence; status still `open`; no `journal_entries` row with
  `source_id = day`; `verified_by` null. *Red today: verify posts.* Mutant: drop the R1 check → red.
- V2 submitted day, verify → posts, `created: true`, status `verified`. Control (green today).
- V3 verified day, verify again → `{ created: false }`, same `journalEntryId`, one entry. Control.
- V4 voided day → the existing voided sentence, unchanged (the R1 check must not mask it). Mutant: R1 placed before
  the voided branch → V4 red (sentence differs).
- V5 open day verified by a person WITHOUT `verify_sales_day` → `AuthorizationError` (authorize still first).
  Mutant: R1 moved above `authorize` → V5 red (refusal instead of AuthorizationError).
- V6 repo: `markVerified` on an `open` row (called directly in a tx) → `recordGone`; the row is unchanged.
  *Red today.* Mutant: WHERE back to `UNVERIFIED_STATUSES` → red.
- V7 POS feed day (`_fixtures/pos-day.ts` `importTestDay`), imported `open`, verify → refused (R1); submit, verify →
  posts. *Red today.*

### Test fallout (the main cost of this task) — a shared helper
New `packages/domain/tests/integration/_fixtures/sales-day-flow.ts` (importable from `apps/erp/tests` by relative
path, as `_fixtures/pos-day.ts` already is):
```ts
/** T-385: verify requires submit. Submits the day if it is open, then verifies. Returns verifySalesDay's result.
 *  `submitter` defaults to `verifier` today; S3 (if Ian answers a/b) changes ONLY call sites that need two people. */
export async function submitThenVerify(tx: Tx, verifier: Actor, salesDayId: string, submitter: Actor = verifier)
```
It reads the status in the same tx; `open` → `submitSalesDay(tx, submitter, id)`; then `verifySalesDay`. It must not
swallow a refusal from either call.
Raw-SQL fixtures get a second helper in the same file: `forceVerifiedSql(sql, dayId, personId)` — two UPDATEs,
`open → submitted` (with `submitted_by/at`) then `submitted → verified` (with `verified_by/at`).

**Files to change (23 files calling verifySalesDay, 49 calls, + 7 raw-SQL sites), verified by grep at `b4e917e`.** Calls / submits
per file in brackets; every file with 0 submits certainly breaks, the others are checked per call:
- `packages/domain/tests/integration/`: `sales-days.test.ts` [16/1], `t369-s3-sales-day-edit-void.test.ts` [4/1],
  `t375-s3-import.test.ts` [5/6], `pos-day-reconciliation.test.ts` [2/0], `t369-s7-voided-date-reentry.test.ts` [2/1],
  `t373-s1-voided-day-writers.test.ts` [2/0], `t382-s2-unlink.test.ts` [2/1], `sales-rollup.test.ts` [1/0],
  `t369-s7-audit-reentry.test.ts` [1/0], `t374-s7-void-pos-usage-pull.test.ts` [1/0], `t375-s4-platform.test.ts` [1/1],
  `t375-s5-usage-from-feed.test.ts` [1/0], `t375-s6-correction.test.ts` [1/0], `t375-s6-drift.test.ts` [1/0],
  `t377-s2-empty-sections.test.ts` [1/0].
- `apps/erp/tests/integration/`: `t373-s1-pos-usage-picker.test.ts` [1/0], `t375-s6-day-corrections-web.test.ts`
  [1/0], `t375-s6-reconciliation-web.test.ts` [1/0], `t380-s4-pos-recon-banner.test.ts` [1/0],
  `t382-s3-unlink-web.test.ts` [1/0], `t369-s3-sales-day-web.test.ts` [1/1], `t375-s3-import-web.test.ts` [1/1],
  `t375-s4-day-page.test.ts` [1/2].
- Raw SQL `open → verified` UPDATEs (break at S2, change in S1 so S2 lands green):
  `packages/domain/tests/integration/channel-settlements.test.ts:635`, `oil-wave-2.test.ts:138`,
  `t316-s2-remittance-floor.test.ts:344`, `t375-s1-store-link.test.ts:346`;
  `packages/db/tests/integration/t375-s4-lock.test.ts:249` (the "verify (markVerified)" control: submit inside the
  same `attempt` first) and `:336`; `packages/db/tests/integration/t382-s1-unlink-lock.test.ts:231`.
- **Not affected:** raw `INSERT ... status 'verified'` fixtures (≈15 files, e.g. `remittance.test.ts:178`,
  `t369-s7-migration.test.ts:50`) — 0188 guards UPDATE only (see Out of scope). `t343-s5-action-guard.test.ts` names
  the function only as a string.
- Rule for the tester: **a leg whose subject IS "verify an open day" changes its expectation; every other leg only
  swaps to the helper.** List each changed expectation in the commit body.

## S2: database — 0188 refuses `→ verified` unless the row was `submitted`

**R2.** Trigger `sales_days_verify_requires_submitted`, BEFORE UPDATE on `sales_days`, FOR EACH ROW,
`WHEN (NEW.status = 'verified' AND OLD.status IS DISTINCT FROM 'verified')`; the function raises unless
`OLD.status = 'submitted' AND OLD.submitted_by IS NOT NULL`. SQLSTATE 23514, `CONSTRAINT =
'sales_days_verify_requires_submitted'` (0185's idiom, so `errorMessage` maps it).
- Fires for every role (no bypass branch): the rule is about the row's own transition and no legitimate writer skips
  it. `doadmin` can still `ALTER TABLE ... DISABLE TRIGGER` in an emergency; that is deliberate, visible SQL.
- Not on INSERT (Out of scope). Not touching rows already `verified` (the WHEN excludes them), so historic
  verified-without-submit rows still void (verified → voided) and still update in other columns.
- Also refuses `voided → verified` (OLD is not submitted). No such path exists; the trigger makes it impossible.
**R2a. Trigger registry:** `sales_days_verify_requires_submitted: { table: 'sales_days', mode: 'origin', kind:
'validator', reason: 'A day reaches verified only from submitted (T-385, 0188). Origin: a replay or restore must load
historic days verified straight from open.' }`. Not `history_guard`: it refuses a forward transition, not a rewrite of
history (registry R1 test), and replaying genuine pre-0188 rows must stay silent.
**R2b. Constraint sentence** in `CONSTRAINT_MESSAGES`: `sales_days_verify_requires_submitted: 'A sales day can be
verified only after it has been submitted.'` Key count 41 → **42** in both pinned tests; a leg in
`constraint-message-lookup.test.ts` that raises it (raw UPDATE open → verified under the app role).
**R2c. Schema note** beside `status` in `packages/db/schema/sales-days.ts`: `// NOTE: open -> verified refused by
trigger sales_days_verify_requires_submitted, hand-added in migration 0188 (T-385).`
**R2d.** No new table, column, grant, RLS or classification change. Journal entry idx 188 on the grid
(`when = 1802230307084 + 86_400_000 = 1802316707084`), tag `0188_t385_verify_requires_submitted`.

### 0188 sketch (the builder transcribes; header follows 0187's model)
```sql
-- 0188 - T-385, docs/tasks/385-verify-only-after-submit.md: a sales day is verified only after it is submitted.
--
-- PURPOSE: Ian 2026-10-09, "verify and post must be blocked until submitted". runVerify gains the same rule in plain
-- words (S1); this is the database's copy of the ORDER, so no writer under any role skips submit. DEF-618.
--
-- WHAT IT GUARDS: an UPDATE that moves a row INTO 'verified' from anything other than 'submitted' with a submitter.
-- Rows already verified are untouched (the WHEN), so days verified before 0188 without a submit (history, P0188b)
-- still void and still update. INSERT is not guarded (no app path inserts a non-open day; insertSalesDay takes no
-- status). Trigger registry: origin / validator (a replay must load historic rows).
--
-- PRECHECKS (read-only, BEGIN READ ONLY; ... ROLLBACK;, run as doadmin with Ian before the push):
--   P0188a  SELECT status, count(*) FROM sales_days GROUP BY status ORDER BY status;      -- informational
--   P0188b  SELECT count(*) FROM sales_days WHERE status = 'verified' AND submitted_at IS NULL;
--           -- informational: historic days verified straight from open; they must NOT break (they do not: WHEN)
--   P0188c  SELECT count(*) FROM sales_days WHERE status = 'submitted' AND submitted_by IS NULL;
--           -- MUST be 0: such a day could never be verified after 0188 (markSubmitted always sets submitted_by)
--   P0188d  SELECT count(*) FROM sales_days WHERE status = 'open';
--           -- informational: days whose people must now press Submit before Verify (tell the store)
--   P0188e  SELECT count(*) FROM sales_days WHERE status = 'verified' AND verified_by = submitted_by;
--           -- informational, for Ian's t385-q1 (self-verify) answer
--
-- Hand-authored per ADR-012 section 5 -- `npm run db:generate` is retired and fails closed (DEF-242).

CREATE OR REPLACE FUNCTION "sales_days_check_verify_requires_submitted"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF OLD.status <> 'submitted' OR OLD.submitted_by IS NULL THEN
		RAISE EXCEPTION 'A sales day is verified only after it is submitted (T-385): this one is %.', OLD.status
			USING ERRCODE = '23514', CONSTRAINT = 'sales_days_verify_requires_submitted';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "sales_days_verify_requires_submitted"
	BEFORE UPDATE ON "sales_days"
	FOR EACH ROW
	WHEN (NEW.status = 'verified' AND OLD.status IS DISTINCT FROM 'verified')
	EXECUTE FUNCTION "sales_days_check_verify_requires_submitted"();
```
(SECURITY INVOKER, the default; no `SECURITY DEFINER`. Postgres fires BEFORE triggers in name order, so
`sales_days_figure_lock` runs first; it never locks a status move, so the order does not matter.)

**`docs/ops/README.md` deploy-gate row** (builder adds): `| 0188 (T-385) | READ ONLY, as doadmin with Ian before the
push (SQL in the 0188 header). P0188a status counts; P0188b historic verified-without-submit (informational, unaffected);
P0188c MUST be 0; P0188d open days (tell stores Submit now comes first); P0188e self-verified (for t385-q1) | (results)
|`. Expected after deploy: `drizzle.__drizzle_migrations` = **169** rows if 0187 is applied first (168 + 1).

### S2 files
- TESTER: `packages/db/tests/integration/t385-s2-verify-requires-submitted.test.ts` (new); the two pinned key-count
  tests; one leg in `apps/erp/tests/integration/constraint-message-lookup.test.ts`.
- BUILDER: `packages/db/migrations/0188_t385_verify_requires_submitted.sql`; `packages/db/migrations/meta/_journal.json`;
  `packages/db/src/triggers/registry.ts`; `packages/db/schema/sales-days.ts` (note only);
  `apps/erp/src/lib/constraint-messages.ts`; `docs/ops/README.md`.

### S2 tests (as `shareat_app` via the org principal, plus one as the owner role)
- D1 raw `UPDATE status='verified'` on an `open` row → 23514, constraint `sales_days_verify_requires_submitted`.
  *Red today.* Mutant: WHEN drops `OLD.status IS DISTINCT FROM 'verified'` → D4 red; function drops the check → D1 red.
- D2 `submitted` row (with `submitted_by`) → `verified` → allowed. Control.
- D3 `submitted` row with `submitted_by` NULL (inserted raw) → `verified` → refused. Mutant: drop the
  `submitted_by IS NULL` arm → red.
- D4 a row INSERTED as `verified` with `submitted_at` NULL (history): UPDATE `verified → voided` allowed; UPDATE of
  `updated_at` allowed. Guards P0188b.
- D5 `voided → verified` → refused.
- D6 the same as D1 under the table owner / superuser connection → still refused (no bypass). Mutant: a bypass branch
  → red.
- D7 trigger present in `pg_trigger` with `tgenabled = 'O'` (the T-354 guard covers it once registered; this leg names
  it so a missing registry entry fails here first).
- D8 `errorMessage` of D1's error = the R2b sentence (the lookup leg).

## S3 (GATED on Ian, `t385-q1-different-verifier`): the submitter may not verify their own day

**The question for Ian.** *"Should the person who submitted a sales day be refused when they try to verify it?"*
- **(a) recommended:** yes, except a super-admin (you). A manager who submitted must get another manager/admin to
  verify; you can verify your own in a pinch.
- (b) yes, no exception for anyone.
- (c) no, leave it as a warning on screen (today's line).
**What it costs the stores:** on a POS-linked store (Lipa) nobody types figures, so the manager who presses Submit
cannot then press Verify. A second person with `submit_sales_day` (a cashier holding the position grant, T-318) must
submit, or a second manager/admin must verify. P0188e shows how often production already self-verifies.

**Design under (a).**
- R3. `runVerify`, after R1: if `day.submittedBy === actor.personId` and the actor lacks the new super-admin-only
  capability `verify_own_sales_day`, refuse: *"You submitted this day, so someone else has to verify it."*
  `holdsSuperAdminAuthority` is private to `packages/auth/src/roles.ts:206`; use the capability path, not an export.
- R3a. New capability row in `docs/decisions/CAPABILITY-MATRIX.md` (super-admin only); the pinned
  `SUPER_ADMIN_ONLY_CAPABILITIES` set (`packages/auth/tests/super-admin-capability-set.test.ts`) grows by one; and,
  as 0187 R6a found, **migration 0189 must backfill the grant to every existing owner** or Ian silently loses
  super-admin authority (copy 0187's B0187 block, row_security off, run as doadmin; prechecks as P0187b).
- R3b. Database: none under (a). The exception is an authority question the database cannot answer without a second
  copy of `holdsSuperAdminAuthority` (RULES: no second source of truth). `verified_by` and `submitted_by` already
  record the fact; P0188e-style reads find it.
- Day page: when `can.verify` is true but the viewer submitted the day and is not exempt, the Verify card shows the
  sentence instead of the button.
**Design under (b).** R3 without the exception, plus the database rule: if Ian answers before S2's builder starts, the
0188 function also raises when `NEW.verified_by = OLD.submitted_by`; otherwise migration 0189 adds it. No capability.
**Fallout.** Every `submitThenVerify` call where `submitter === verifier` (the default) breaks. S3's tester passes a
second actor at each such site (fixtures already carry `adminId`/`managerId`/`staffId`); the helper's default then
changes to "no default" so a new test must name both people.
**S3 tests.** W1 manager submits, same manager verifies → refused, no entry (mutant: drop R3 → red). W2 staff submits,
manager verifies → posts. W3 (a only) super-admin submits and verifies → posts (mutant: exemption dropped → red).
W4 (a only) the capability backfill: the owner holding the four current grants gains the fifth; nobody else does.
**S3 files.** TESTER: `packages/domain/tests/integration/t385-s3-self-verify.test.ts`, the fallout sites, the auth
pinned-set test. BUILDER: `verify.ts`, `CAPABILITY-MATRIX.md`, `packages/auth` capability list, 0189 (a) or 0188 (b),
the day page Verify card.

## S4: the screen — Verify & post only on a submitted day

**R4.** `page.tsx:473`: the Verify form renders when `day.status === 'submitted' && can.verify` (today: open OR
submitted, no probe). **R4a.** The Submit card (`:459`) keeps its button and gains one line under the existing text:
*"Verify & post comes after this, on the submitted day."* No new button label (the T-384 S3 label census,
`apps/erp/tests/t384-s3-lock-and-save-guard.test.ts:90`, already holds "Verify &amp; post"). **R4b.** On an open day
where the viewer cannot submit, nothing new; the domain still refuses a forged post (S1).
### S4 files
- TESTER: `apps/erp/tests/integration/t385-s4-day-page-verify-gate.test.ts` (new; render the page as
  `t375-s4-day-page.test.ts` does).
- BUILDER: `apps/erp/src/app/sales-days/[id]/page.tsx` only.
### S4 tests
- P1 open day, manager: HTML has the Submit form and the R4a line; has NO form posting `verifySalesDayAction` and no
  "Verify &amp; post". *Red today.* Mutant: R4 condition back to `open || submitted` → red.
- P2 submitted day, manager: the Verify form is present. Control.
- P3 submitted day, staff without `verify_sales_day`: no Verify form. *Red today* (no probe). Mutant: drop
  `can.verify` → red.
- P4 forged `verifySalesDayAction` on an open day → redirect with the R1 sentence in the flash, status `open`.

## Invariants
- I1 No `sales_days` row reaches `verified` except from `submitted` with a `submitted_by` (domain R1 + DB R2).
- I2 Re-verify of a verified day: no-op, same entry, no new row (unchanged).
- I3 Rows verified before 0188 are never refused for anything they could do before (void, column updates).
- I4 The order of checks in `runVerify`: lock → gone → authorize → verified no-op → voided → R1 → (R3) → route → post.
- I5 No new status value; `UNVERIFIED_STATUSES` keeps its meaning for every other caller.

## Out of scope (each with a reason)
- **Guarding INSERT** (a row born `submitted`/`verified`). No app path does it (`insertSalesDay` takes no status);
  ≈15 test fixtures insert `verified` rows directly for remittance/float tests, so a guard there is a large fallout for
  a hole only raw SQL can reach. Named follow-up, not built.
- **A CHECK that `verified` implies `submitted_at IS NOT NULL`.** It would reject the history counted by P0188b.
- **Auto-submit on import** for POS-linked days. Ian's ruling keeps a human Submit; any shortcut is his call.
- **v1's "verify in date order" submit block** (`sales-day.actions.ts:340-352`). v2 already blocks creating a newer
  day while an older one is unverified (create-block, bible row 126); a submit-order rule is a separate question.
- Bulk verify on the list page: none exists.

## Done when
- S1, S2, S4 committed (S3 only once Ian answers), each slice tester-red then builder-green; full suite green in CI on
  the PR; typecheck 0; build 0 with the dev server stopped.
- 0188 applies from zero (CI) and on a scratch DB (ADR-012 §5.8); registry and journal guards green.
- `docs/ops/README.md` 0188 row written; prechecks run with Ian before the push.
- DEF-618 (as allocated) marked fixed with commit ids; bible §13 row for the ruling (orchestrator); GLOSSARY "sales
  day" lifecycle line updated if it states the order (it does not today — add *open → submitted → verified; verify
  needs submitted*).
- §9.4 smoke done (below), screenshots named in the commit.

## §9.4 smoke (port 9008, `docs/SMOKETEST.md`)
1. As a manager, open an `open` typed day at `/sales-days/{id}`: Submit card with the new line; **no** Verify & post
   card. Screenshot.
2. Forge the verify: re-submit the Verify form's POST (devtools, or an old tab opened before step 3 of a second day):
   red flash "This sales day hasn't been submitted yet…"; status still open.
3. Press Submit: the page shows the Verify & post card. Press it: status Verified, entry dated on the business date.
4. On a POS-linked test store: import a day, confirm no Verify card while open, Submit, then Verify.
5. psql as the app role on the dev DB: `UPDATE sales_days SET status='verified' WHERE id='<an open day>'` → 23514
   `sales_days_verify_requires_submitted`.
6. Phone width (375px): the Submit card's new line wraps, no horizontal scroll.

## Questions only Ian can answer
- **t385-q1-different-verifier** — (a) refuse self-verify except a super-admin [recommended], (b) refuse for everyone,
  (c) keep it a warning. Ask with the Lipa consequence stated: the manager who submits a POS day cannot verify it
  under (a)/(b).

## Amendment B1 — Ian's answer (2026-10-09, orchestrator)
- **`t385-q1-different-verifier` = a**: the person who submitted a sales day may not verify it; **a super-admin may**
  verify their own submission. S3 is IN scope and **folds into migration 0188** (no 0189): the new super-admin-only
  capability `verify_own_sales_day` and its backfill to the existing owner/admin (the 0187 `unlink_store_from_pos`
  pattern) ship in the same migration, and 0188's prechecks gain P0187b's holder list for the new grant.
  Item codes move to migration 0189.

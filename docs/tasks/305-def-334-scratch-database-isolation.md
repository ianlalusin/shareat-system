# T-305 — DEF-334: the from-zero proof's scratch database name is not lane-safe

> **Status: SHIPPED.** See `docs/ROADMAP.html` (search `T-305`) for the commit, date and outcome —
> the roadmap is the maintained record. This is Lane B's own DEF-325 finding, handed
> back by the orchestrator to confirm-or-kill and, if real, act on.

Source: DEF-325's Slice 2 finding (`docs/tasks/299-def-325-from-zero-migration-timeout.md`) — a
bimodal local timing pattern (fine in ~2-3s, or stuck at whatever ceiling was configured, nothing
between) that didn't match DEF-313's smooth load-drift shape, flagged as unconfirmed and handed off
rather than fixed on suspicion alone.

## Step 1 — confirmed, not killed

Two shells, `position-defaults.test.ts` against two different lane databases
(`shareat_test_laneb`, `shareat_test_orch`), run concurrently, 4 rounds:

| Round | `laneb` exit | `orch` exit |
|---|---|---|
| 1 | 1 (failed) | 0 |
| 2 | 1 (failed) | 0 |
| 3 | 1 (failed) | 0 |
| 4 | 0 | 1 (failed) |

**4/4 rounds: exactly one side failed, every time**, with the identical error on the losing side:

```
PostgresError: duplicate key value violates unique constraint "pg_database_datname_index"
detail: Key (datname)=(shareat_test_scratch_t289) already exists.
query: 'create database "shareat_test_scratch_t289"'
```

This is a clean, deterministic, 100%-reproducible confirmation — not a probabilistic "sometimes."
Two concurrent runs race `CREATE DATABASE` on the identical hardcoded literal
(`shareat_test_scratch_t289`), and the loser gets an immediate Postgres error (94-204ms in these
four trials — fast, not a hang).

⚠️ **Honest caveat, worth stating plainly**: this confirmed failure mode is a fast, explicit error,
not the ~30s stuck-at-ceiling shape DEF-325's Slice 2 originally observed. A live
`pg_stat_activity`/`pg_locks` watch was attempted during these four rounds but the monitor script's
own filter self-matched its own query text (a bug in the diagnostic, not in the finding — discarded
rather than trusted) and captured nothing useful. The two phenomena — duplicate-key collision here,
and the original bimodal-stall shape — are very plausibly the same root cause manifesting two ways
depending on the exact interleaving (a race that loses the `CREATE` step errors fast; a race where
one side's `DROP DATABASE` overlaps the other's still-running migration could plausibly block or
error differently under heavier ambient load than these four trials had), but that specific
mechanical link is not independently proven here. What IS proven: the hardcoded name is a real,
reproducible hazard on its own, sufficient to fix regardless of whether it fully explains every
prior observation.

**No sibling was found.** `grep -ril "create database\|createDatabase\|drop database"` across every
`*.ts/*.tsx/*.mjs/*.cjs/*.js` file in the repo returns exactly one file:
`packages/domain/tests/integration/position-defaults.test.ts`. A separate grep for `scratch`
(case-insensitive, `*.ts/*.tsx`) returns two other files (`scripts/storage-smoke.ts`,
`packages/domain/src/files/driver.ts`) — read and confirmed unrelated: both are about a Firebase
Storage "scratch bucket", not a database. This test is the only one that creates a database with a
hardcoded name.

## Step 2 — the fix

`packages/domain/tests/integration/position-defaults.test.ts`, case 13: the scratch name is now
derived as `${laneTag}_scratch_t289_${process.pid}`, where `laneTag` is the database name already
in `TEST_DATABASE_URL` (e.g. `shareat_test_laneb`), sanitized to safe identifier characters.

**The property relied on, stated per the briefing's requirement**: `process.pid` is unique among
every process alive on this OS at the same time — two runs that are both still running structurally
cannot compute the same name, which is a stronger claim than "unlikely to collide" (what the
original hardcoded literal gave zero of). The lane tag adds nothing to that guarantee (two
concurrent processes already can't share a pid) — it's there so `pg_database` reads legibly when
someone is debugging, not for correctness.

Re-ran the exact reproduction that failed 4/4 times before the fix, 4 more rounds, same two lane
databases: **4/4 rounds, both sides exit 0**, case 13 passing in 2.4-2.5s each side (real output in
the READY report).

⚠️ **Not addressed by this fix, stated so it isn't assumed closed**: a scratch database orphaned by
a process that crashes before its own `finally` block's `drop database` runs (e.g. an OOM-kill, which
this session has directly observed happen to a different background command today) would sit under a
now-unique, pid-tagged name forever — harmless (never collides, since the pid that made it is gone)
but not self-cleaning either. Out of scope for this fix; noted for whoever next looks at orphan
cleanup for `shareat_test_scratch_*` names.

## Question the orchestrator asked, answered

**Does case 13 need updating for migration `0147`?** Checked `packages/db/migrations/0147_t304_t303_terminal_sign_in_and_throttle.sql`
(read-only) directly, per the instruction to report rather than fix:

- `persons.kind` is added as `NOT NULL DEFAULT 'person'` with a CHECK constraining it to
  `('person', 'terminal')`. Case 13's raw `insert into persons (org_id, display_name) values (...)`
  does not name `kind`, so it takes the default and satisfies the CHECK — **no fixture breakage**.
- The migration-count assertion (`expect(applied[0]!.count).toBe(journal.entries.length)`) reads the
  journal's own length at run time rather than a hardcoded number, so it self-adjusts to `0147`
  landing (130 → 131) with no edit needed.
- ⚠️ **Cosmetic only, not functional**: the `describe`/`it` title strings say "migration 0146 applies
  to an empty database" and "admits pre-0146-shaped rows." Once `0147` is on `main` this remains
  literally true (0146 still applies to an empty database; pre-0146 rows are still admitted) but
  reads as slightly stale, since the test now also proves the chain through 0147. Not fixing this
  myself — reporting per the instruction, since it's a naming choice tied to lane A's migration and
  you said you'd route it.

## Scope — the exact files this task creates or modifies

- `packages/domain/tests/integration/position-defaults.test.ts` — the scratch-name derivation
  (case 13 only) plus a citation comment. The DEF-325 120_000ms timeout and its comment are
  untouched in this slice — Step 3 (re-measure and possibly remove it) is explicitly gated on
  migration `0147` landing on `main`, per the orchestrator's sequencing constraint.
- `docs/tasks/305-def-334-scratch-database-isolation.md` — this file.

## Contract

1. The scratch database's identity changes; nothing about what case 13 proves changes — same
   from-zero migration replay, same admission checks, same CHECK-constraint refusal assertion.
2. No migration, no schema file, no other test file touched.
3. `packages/db`, `packages/auth`, `apps/erp/src/app/sign-in`, `scripts/`, `tests/` — lane A's — not
   touched; migration `0147` was only read, never modified.
4. Step 3 (re-measuring DEF-325's timeout and possibly deleting it) is explicitly NOT done in this
   task — waiting for the orchestrator's signal that `0147` is on `main`.

## Invariants

1. ⛔ Do not remove the defensive `drop database if exists` at the top of case 13 — cheap, and still
   a real (if now much narrower) safety net against an orphaned name from a crashed prior run.
2. ⛔ Do not touch the 120_000ms timeout or its comment in this task — out of scope until Step 3 is
   unblocked.
3. The uniqueness property must be stated in the comment as what it actually is (pid-based,
   structural) — not a vaguer "should be unique enough" that a future reader can't verify.

## Tests

1. Reproduction before the fix: 4 concurrent two-shell rounds, 4/4 showing the duplicate-key error
   on one side — captured above and in the READY report's real log excerpts.
2. Reproduction after the fix: the identical 4-round experiment, 4/4 both sides green.
3. `npm run typecheck`, `npm run test` (unit) — confirm nothing else regressed.
4. 3 consecutive solo runs of `position-defaults.test.ts` against `shareat_test_laneb` — real output,
   real exit codes.

## Out of scope

- ⛔ Step 3 — re-measuring DEF-325 and deciding whether `120_000` is still needed once names can't
  collide. Waiting on migration `0147` landing on `main`, per instruction.
- ⛔ Orphan cleanup for a scratch database left behind by a crashed process — noted above, not built.
- ⛔ Updating case 13's describe/it title strings for `0147` — reported above, routed to the
  orchestrator rather than fixed here.
- ⛔ Any file under `packages/auth`, `packages/db`, `apps/erp/src/app/sign-in`, `scripts/`, `tests/`
  — lane A's.

## Done when

- `position-defaults.test.ts`'s scratch name is pid-derived, with a comment stating the exact
  property relied on.
- 4/4 concurrent-collision reproductions pass clean, matching the 4/4 that failed before.
- typecheck clean; unit suite green; 3 consecutive solo integration runs green.
- Self-reviewed line by line.
- Report ends with a `FOR IAN` block.

See `docs/DEFECTS-REGISTER.md` DEF-325, DEF-334; `docs/tasks/299-def-325-from-zero-migration-timeout.md`;
`packages/db/migrations/0147_t304_t303_terminal_sign_in_and_throttle.sql` (read only).

# T-400 — Run the integration suite on several workers, one database each

> **Status: SPEC.** From Ian, 2026-10-11: *"continue with optimization"*, after T-399.
> Branch `lane/t400-parallel-integration`.

## The goal, with the numbers that set it

Integration is now the CI job. In the last green run on `main` (run 38137406395, GitHub-hosted, 11 Oct):

| Step | Time |
|---|---|
| Integration tests | **20 m 48 s** (390 files, 6,162 tests) |
| Unit tests | 3 m 56 s |
| Typecheck | 58 s |
| Build | 1 m 12 s |

Vitest's own breakdown of the integration run: `tests 884.52s, import 302.80s` out of `Duration 1247.17s`.
No single file dominates: the slowest is `inbox-ingestor.test.ts` at 55.6 s, the next 19.0 s.

**Why it is slow.** `vitest.config.mts` sets `fileParallelism: false`, and every file shares one
database. Every one of the 390 files runs one after another, and pays its ~0.8 s of module import one after another.

**What it is not** (measured on `ians-pc`, 11 Oct, so that nobody re-tries it):
- **Not disk flushes.** A synthetic benchmark of 128 FK-linked tables and 40 insert-plus-`TRUNCATE … CASCADE`
  cycles took 35.3 s with default settings and 37.0 s with `fsync`, `synchronous_commit` and
  `full_page_writes` off. On tmpfs it took 95.6 s, which is slower.
- **Not CPU.** During integration on `ians-pc` (16 cores), load average was about 1.5 and the CPU was over 90% idle.

**Target:** integration under **7 minutes** on `ians-pc` with 4 workers, with the same file and
test counts and a green result twice in a row.

## The design

### 1. One database per worker, cloned from the migrated test DB

- CI already runs `provision-test-role.mjs`, then `db:migrate` into `shareat_test`. After migration
  nothing is connected to it (`migrate.ts:57` ends with `sql.end`).
- **A new script, `scripts/make-integration-worker-dbs.mjs <N>`**, runs as the admin user from `TEST_DATABASE_URL`:
  - For `i` in 1..N: `DROP DATABASE IF EXISTS <base>_w<i> WITH (FORCE)`, then
    `CREATE DATABASE <base>_w<i> TEMPLATE <base>`.
  - Then `ALTER DATABASE <db> SET client_min_messages = warning` for the base DB and each clone (see §4).
    Per-database settings are **not** copied by `TEMPLATE`, so the script sets each one explicitly.
  - It refuses any base name without `_test`, the same rule as `setup.ts:22`, and never prints a URL.
  - Use `new URL()` to swap the pathname. Never use string surgery; see `setup.ts:86`.
- **The clone carries everything the restricted role needs.** The roles (`shareat_app`,
  `shareat_test_runner`) are cluster-wide and were made by `provision-test-role.mjs:85-111` before
  migrating. The grants and default privileges are per-database objects made by migrations (`0011:66-72`,
  `0088`, `0183`, `0189`, `0190`), so `TEMPLATE` copies them. Verify this rather than trust it:
  the suite must pass with the restricted role armed, which is the default.

### 2. `tests/integration/setup.ts` points each worker at its own clone

- **Opt-in: `INTEGRATION_WORKERS` > 1.** Insert this before the line `const url = process.env.TEST_DATABASE_URL`:
  - Swap the pathname of `process.env.TEST_DATABASE_URL` to `<base>_w${VITEST_POOL_ID}`, and **write it
    back to `process.env.TEST_DATABASE_URL`**. About 374 files open their own `postgres(TEST_DATABASE_URL)`
    seeding connection, and they follow only if the variable itself changes. `setupFiles` run before
    each test file is imported, so the rewrite is in place before any file reads it.
  - Everything after that (the `_test` guard, the restricted `DATABASE_URL`, `SYSTEM_DATABASE_URL`)
    already derives from `url` and follows unchanged.
  - If `VITEST_POOL_ID` is missing or above `INTEGRATION_WORKERS`, throw. A worker silently sharing a DB is the failure to prevent.
- Unset, or `1`: behaviour is byte-for-byte today's. Local lanes, and anyone running the suite on one
  DB, change nothing.

### 3. `vitest.config.mts`, integration project only

- `fileParallelism: Number(process.env.INTEGRATION_WORKERS ?? 1) > 1`.
- Cap the workers at `INTEGRATION_WORKERS`: `maxWorkers` (vitest 4.1.11; `VITEST_POOL_ID` ranges over 1..`maxWorkers`,
  per `vitest/dist/chunks/cli-api.*.js`). If `maxWorkers` is not honoured per project in 4.1,
  set it at the root only when the variable is set. The unit project runs as a separate invocation in CI.
- Keep `testTimeout` and `hookTimeout` at 30 s. If contention makes hooks time out, lower N; do not raise the timeouts.

### 4. Connection budget — the blocker the discovery missed

- Each worker can hold `DATABASE_POOL_MAX` (default **10**, `packages/core/src/env.ts:53`) app
  connections, plus 10 system connections, plus each file's raw seeding connections.
- 4 workers × ~22 is about the Postgres default `max_connections = 100`. The service container cannot change that limit.
- **Set `DATABASE_POOL_MAX: '4'` on the CI integration step when parallel.** Before choosing it, check that no test needs
  more than 4 simultaneous app connections: grep for `Promise.all` over transactions in the
  lock and concurrency tests (e.g. `t390-s1-opening-counts-per-room.test.ts:486`).
- During the first parallel run, log the peak connection count: run
  `select count(*) from pg_stat_activity` in a background loop, or check it from the step after.

### 5. NOTICE noise — a free win, in both modes

Each `TRUNCATE … CASCADE` prints about 124 `truncate cascades to table …` NOTICEs through the raw
seeding connections, none of which set `onnotice`. That came to 85,325 notice entries, most of the job log's
780,737 lines (71 MB). No test asserts on or captures a Postgres notice (discovery, 11 Oct). Setting
`client_min_messages = warning` on each database (§1) silences them with no change to any test.

### 6. CI wiring (`ci.yml`, `verify`)

- After `Apply migrations`, add a step `Create integration worker DBs` that runs `node scripts/make-integration-worker-dbs.mjs 4`.
  It is gated on the same `docs_only` condition.
- On `Integration tests`: `env: INTEGRATION_WORKERS: '4'` and `DATABASE_POOL_MAX: '4'`.
- **Rollback** is one edit: remove `INTEGRATION_WORKERS`. The extra databases are then unused.

## Risks to watch

- **Scratch databases.** About 17 files in `packages/db/tests/integration` create and drop their own
  databases from `template1` (names suffixed with `Date.now()`, the pid, or a UUID). Concurrent
  `CREATE DATABASE` from one template, and forced checkpoints, may contend. DEF-365 already documents
  slow `DROP DATABASE`.
  - If they flake under parallelism, append `_p${VITEST_POOL_ID}` to their names.
  - If that's not enough, put those files in their own serial project. Do not raise timeouts.
- **Hosted runners have 4 vCPU.** N=4 must also stay green there, because rollback to hosted is
  the `CI_RUNNER` switch. If it flakes on hosted, use `INTEGRATION_WORKERS: ${{ vars.CI_RUNNER != '' && '4' || '2' }}`.
- **Hidden order dependence.** A file that passes only because another ran first, in the same DB,
  will now fail. Fix that file. That is a real defect, not a parallelism problem.

## Acceptance

1. Two consecutive CI runs on `ians-pc`, both green, with **390 files and 6,162 tests** (or the
   current count on the day, matching a serial run of the same commit) in the integration step.
2. Integration step time recorded for both runs, against the 20 m 48 s baseline. Target: under 7 m.
3. Peak `pg_stat_activity` count recorded, and below 90.
4. The integration step log carries no `truncate cascades` lines (`grep -c` gives 0).
5. Locally with `INTEGRATION_WORKERS` unset, behaviour is unchanged: one DB, serial.
6. One hosted run (with `CI_RUNNER` temporarily unset) is green, or the variable fallback in Risks is applied.

Put the numbers under `## Outcome` in this file.

## Files

- `scripts/make-integration-worker-dbs.mjs` (new)
- `tests/integration/setup.ts`: the opt-in URL rewrite, before the line `const url = …`
- `vitest.config.mts`: the integration project's `fileParallelism` and the worker cap
- `.github/workflows/ci.yml`: the new step, plus the env on `Integration tests`
- `docs/ops/self-hosted-runner.md` is unchanged. `HANDOFF.md` or `docs/SMOKETEST.md` gets one line on how to run the suite parallel locally:
  `node scripts/make-integration-worker-dbs.mjs 4 && INTEGRATION_WORKERS=4 DATABASE_POOL_MAX=4 npm run test:integration`.

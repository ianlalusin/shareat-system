# T-394: Purge and opening rehearsal on a restored copy; the 31 Dec-2 Jan runbook (DEF-585)

**Status:** SPEC APPROVED WITH CHANGES 2026-10-12 (fresh Opus review applied). Written at HEAD a9e299b.
**Model:** Sonnet lanes, **tester first** in S1 and S2, then builder (bible row 184). S3 (the runbook) is written in plan
mode (Opus) because it records decisions. S4 and S5 are operations with Ian present.
**Lane:** L1 Cutover, wave 3 (`docs/plans/remaining-build-plan.md` §3.3, plan item C6, plus DEF-585 from C10).
Size **M ≈ 2.75 lane-days** to 13 Nov (S1-S4), plus S5 (0.5) on 18 Dec.
**Migration:** **none.** No table, no `SCHEDULER_JOBS` entry. The rehearsal's own state is a local JSON journal (R9).
**Defects:** DEF-585 (closed by R6, see §Rulings). Found while specifying and now registered: DEF-641 (`--as-of` UTC
default), DEF-642 (five copies of the conversion date), DEF-643 (Firestore mirror reset after the purge); see §14.

## 1. Goal

**By 13 Nov the whole 1 January sequence has run end to end on a restored copy of production, every step timed,
with a report that says pass or names the failure; and the hour-by-hour runbook for 31 Dec-2 Jan and the "go back
to v1" rule are written down and signed by Ian.** 18 Dec repeats it on a fresh copy with two organisations.

The test of success is not "the purge ran". It is: on 1 Jan nobody does anything for the first time.

## 2. Source

- ADR-007 §5 (backup verified restorable; one transaction; FK order; sequences reset; post-conditions asserted;
  **rehearsed in November against a restored copy**). Bible §13 row 108 (pilot then purge), row 124 (no rehearsal
  flag inside the product: every reference system uses an isolated copy), row 306 (T-393 not switched on; the
  15 Nov gate cannot pass without a restored copy), row 274 (rehearsed restore required).
- ADR-005 honesty checkpoints (15 Nov go/no-go; no-go means 1 April 2027).
- Plan §1.1 C6 and C10, §2 dates (13 Nov rehearsal, 15 Nov go/no-go, 18 Dec second rehearsal), risks R2, R4, R7.
- Built: `scripts/cutover-purge.ts` + `packages/db/src/cutover/purge.ts` (T-119, T-347, T-390 R8), the wizard
  (`packages/domain/src/cutover/{steps,index,opening,opening-stock,tie-out}.ts`, `apps/erp/src/app/cutover/**`),
  T-393's backup and drill (`scripts/{db-backup,restore-drill}.ts`, `scripts/lib/backup/*`, incl. `fingerprint.ts`).
- Dependencies' specs: T-390 (S4 import + price list waits on T-391's apply), T-391 (built; rollout per store),
  T-393 (built, not on), T-398 (S1 built, migration 0194 awaiting Ian's precheck; S2-S4 dated 13-24 Nov).

## 3. Research (row 283: research, evaluate, propose)

### What v1 does, and its goal

v1 has no cutover. Its goal for this step is ours alone: open 2027 on counted present-day facts without losing a
centavo or a staff login, and be able to undo it.

### The industry pattern

ERP conversions (SAP Activate "mock conversions", Oracle's "conference room pilots", every Big-4 cutover plan) share
one shape: **two or three mock runs on a copy of production, the last a timed dress rehearsal**, driven by a
**cutover runbook** (step, owner, command, expected duration, evidence, checkpoint), with **control totals
reconciled before and after** (record counts, trial balance), a declared **point of no return**, and a rollback
plan that has itself been rehearsed. Defects found in a mock are fixed and the mock is re-run; the rehearsal
timings become the runbook's durations.

### What we adopt, and what we do not

| Pattern | Verdict |
|---|---|
| Mock run on a copy of production, then a dress rehearsal | **Adopted**: 13 Nov (mock) and 18 Dec (dress, two orgs). A third only if 13 Nov fails |
| One tool that runs the machine steps and times every step, human ones included | **Adopted** (S1, S2): `npm run cutover:rehearse` |
| Control totals before and after | **Adopted**, reusing T-393's `db-backup` manifest fingerprint and T-390's `openingTieOut`, never re-implementing them (RULES §6 item 3) |
| Rollback rehearsed, not just written | **Adopted**: the copy is dumped before the purge with T-393's own `db-backup`, and the rehearsal ends by restoring that dump into a second database and proving its fingerprint equals the dump's manifest (R12) |
| A "rehearsal mode" inside the product | **Rejected** (row 124, ADR-007 §1): the copy is the isolation. The tool runs the real `cutover-purge` CLI with `--apply` on a database that can never be production |
| `cutover-purge --rehearse` as "the rehearsal" | **Not enough**: it always rolls back, so C3-C5 can never follow it. It stays as the 31 Dec dry rehearsal on production; the copy gets a real committed purge |
| A staging app server on the droplet | **Rejected**: 4 GB box (RULES §1 item 11). The copy is driven from Ian's machine on 9008 |
| Automating the human steps (count entry, opening figures, POST) | **Rejected**: those are what is being rehearsed. The tool only times them (`mark`) and checks their result |

### What is already in the tree (verified at `a9e299b`)

- The purge engine is complete and asserts its own post-conditions inside the transaction (purge tables empty,
  shells cleared, KEEP tables byte-identical by md5, FKs re-added validated, `mirror_version_seq` untouched), then
  records C2 for every organisation.
- `fiscal_periods` is date-scoped: rows with `starts_on < 2027-01-01` are deleted by the purge.
- `CONVERSION_DATE = '2027-01-01'` (`apps/erp/src/app/cutover/lib.ts:17`); `keepFrom: '2027-01-01'`
  (`classification.ts:149`); `PURGE_AS_OF = '2027-01-01'` (`tests/integration/t390-real-purge.ts`); also `CONVERSION_DATE` in
  `packages/domain/src/cutover/tie-out.ts:25` and a private `CONVERSION` in `opening-stock.ts`. Nothing pins that
  the five agree (DEF-642).
- `opening_counts` and `cutover_steps` are KEEP. **A test count typed into production would survive the real purge
  and become an opening count.** The Lipa test count therefore exists only on the copy (I1).
- The drill restores into `shareat_restore_drill` on the production cluster (T-393 Q3 a) and drops it; it does not
  leave a copy anyone can run the app against. T-393 Q3 already recommends "a one-off temporary cluster for T-394".

## 4. Rulings (planner, 2026-10-13)

| # | Ruling | Why |
|---|---|---|
| R1 | **The copy is a temporary DigitalOcean cluster** (Q1 a), created by Ian, destroyed the same day. Preferred source: **the T-393 cutover-rehearsal dump restored with the ops README "Restoring" steps** (grants kept, `--no-acl` not passed), which also rehearses wizard step C1. Fallback when T-393 is not on: **DO "fork" of the production cluster** (native backup, roles and grants included); C1 and dump-based rollback are then reported `UNREHEARSED` | A fork keeps the roles, so the app on the copy runs as `shareat_app_prod` (`rolbypassrls = f`, ops README) under RLS exactly as production does. On a dump restore that holds **only after** `<stem>.roles.sql` is replayed and the passwords set by hand (ops README "Restoring for real" step 3) and the T-355 grants re-run (step 5). A `--no-acl` drill restore never does |
| R2 | **The target database is renamed to `shareat_rehearsal_YYYYMMDD`** before the tool touches it (one `ALTER DATABASE ... RENAME` from `defaultdb`, in the runbook). The tool refuses any other name | A name production can never carry is the primary guard (Ian confirms the production name does not match, as in T-393's facts) |
| R3 | **Target guards, all must pass, checked before the first write:** (a) the name matches `^shareat_rehearsal_[0-9]{8}$`; (b) the target URL comes from `REHEARSAL_DATABASE_URL` only, never `DATABASE_URL`; (c) its host is **not one of the production cluster's pinned hosts**, named in a constant in `scripts/lib/rehearsal/guards.ts` (**Ian, 2026-10-13: production is `shareat-system-db-do-user-39783702-0.m.db.ondigitalocean.com`** — pin that host for both ports, 25060 direct and 25061 pooler; the constant matches on host, never on port) and extendable by `PRODUCTION_DB_HOSTS` (comma-separated; it can only add hosts, never remove the constant's), **and** its host+database differ from those of `DATABASE_URL` and `SYSTEM_DATABASE_URL` (**parsed, never connected**); (d) the database name is typed back (`--confirm-database`); (e) **liveness**: on `start` and `purge`, no other client session is connected to the target database (`pg_stat_activity`), because production always holds the app's pool (S4 therefore stops the 9008 app before `start` and before `purge`); (f) the tool's role bypasses RLS (the engine already refuses otherwise). **The same guards apply to the database `rollback-check --against` names** | Six independent refusals for one irreversible act. (c)'s pinned host does not depend on `.env.local` being right; (e) catches a mistyped host |
| R4 | **Same command as 1 Jan.** After the guards pass, `purge` runs **`scripts/cutover-purge.ts` as a child process**, three times in the runbook's order: dry run → `--rehearse` → `--apply --as-of <keepFrom> --by <personId>`, each with `--confirm-database <target>` and `--yes-really-not-local`. The child's env sets `DATABASE_URL` to the guarded target (a bypass-RLS role) **explicitly**; it never inherits the parent's. The tool has no purge SQL of its own, only read-only checks | A rehearsal of a different command is not a rehearsal; the CLI's ceremony and refusals are part of what 1 Jan runs |
| R5 | **Migrations run on the copy, timed.** `migrate` runs `npm run db:migrate` as a child process with `DATABASE_URL` set to the guarded target **in the child env**. `packages/db/migrate.ts:11-16` loads `../../.env.local` through dotenv, and dotenv never overrides a variable already set, so the explicit child env is what wins; without it the child would migrate whatever `.env.local` names. Whatever is on `main` on 13 Nov: if 0194 (T-398 S1) is merged its pre-flight runs on real data there | The 1 Jan release may carry migrations; their pre-flights (cross-org RAISE) must not meet real data for the first time on 1 Jan |
| R6 | **DEF-585 is closed by a check, not by creating 2025-2026 periods.** Every cutover posting is dated `CONVERSION_DATE`; the purge deletes every period before it anyway. `start` and `verify` assert, per organisation: **an `open` fiscal period covering `CONVERSION_DATE`, and coverage through the fiscal-period-seed horizon on the run date** (the seed keeps 12 months from the current Manila business month, `packages/domain/src/scheduler/index.ts:997` onward: on 13 Nov that is through Oct 2027). The 2027-12 horizon (12 months from January) is checked only on a 1 Jan run. Creating pre-Oct-2026 periods is **not** done (they would be purged) | DEF-585's real risk is a cutover-dated posting with no period. Padre Garcia's org (T-398 S7) needs its own periods; this check names it if the seed has not run for it |
| R7 | **All five conversion-date copies are pinned equal by a unit test** (DEF-642): `CONVERSION_DATE` in `apps/erp/src/app/cutover/lib.ts:17` and in `packages/domain/src/cutover/tie-out.ts:25`, the private `CONVERSION` in `packages/domain/src/cutover/opening-stock.ts`, `fiscal_periods.keepFrom` (`classification.ts:149`) and `PURGE_AS_OF` (`tests/integration/t390-real-purge.ts`). S1's builder may change `opening-stock.ts:25` to `const CONVERSION = CONVERSION_DATE;` plus its import from `./tie-out` (no other line; the private name keeps its 6 call sites). The tool reads the date from `CUTOVER_CLASSIFICATION.fiscal_periods.keepFrom` (scripts may not import from apps) | If the date moves (rollback rule, R12), one edit must not leave the others behind |
| R8 | **`cutover-purge --apply` and `--rehearse` require an explicit `--as-of`;** a dry run may default, and its default is the **Manila** business date from `packages/core` datetime, not `toISOString()` (DEF-641) | Before 08:00 Manila the UTC date is yesterday; on 31 Jan 2027 that silently defers the ETL purge (`notBefore: '2027-01-31'`) |
| R9 | **The rehearsal journal is a local JSON file** (`REHEARSAL_DIR`, default the OS temp dir; never inside the repo), one file per rehearsal: the guards' result, the start fingerprint, each step's `{code, startedAt, endedAt, by, result}`. `mark <step> start|end` records a human step | No migration, no table, nothing on the copy that the purge would treat as data. A step without an end mark is reported `NOT TIMED`, never silently zero |
| R10 | **The report is sanitised by construction.** Committed part (`docs/reviews/cutover-rehearsal-YYYY-MM-DD.md`): counts per class, durations, pass/fail per check, account **codes** with totals, the migration list, the guards. Never a person name, email, PIN or password hash, phone, item cost by supplier, or connection string. The full numeric detail stays in `REHEARSAL_DIR` | Production business data stays off the repo; the report is still evidence for the 15 Nov pack |
| R11 | **The app on the copy runs from Ian's machine on 9008 in development mode, with Firebase kept for SIGN-IN ONLY**: `FIREBASE_PROJECT_ID` and the `NEXT_PUBLIC_FIREBASE_*` sign-in values stay set (`firebase-auth-admin.ts` refuses to verify a token without the project id; `packages/core/src/env.ts` hard-requires the three public sign-in values); `FIREBASE_SERVICE_ACCOUNT_KEY`, `FIREBASE_SERVICE_ACCOUNT_KEY_FILE`, `FIREBASE_STORAGE_BUCKET` and every `POS_API_*` are blank; `SESSION_SECRET` differs from production's; no heartbeat URL. **Terminal routes and terminal (PIN) sign-in are forbidden on the copy**: the terminal client writes Firestore directly with the public config (`apps/erp/src/lib/terminal/firebase.ts:47-57`), so a test punch would land in the production inbox and the production ingestor would adjudicate it. The runbook says so in S4's steps (no `/terminal` URL, no device pairing, no PIN sign-in on the copy). The tool backs it twice: `app-env-check --env-file <path>` refuses an app env with any service-account, storage-bucket or `POS_API_*` value set, and `verify` / `report` fail if any `clock_terminals` row was created or updated, or any `attendance_punches` row inserted, on the copy after `start` (I10c). `verify` reads the app's role from `pg_stat_activity.usename` on the target (the app's session), not from `DATABASE_URL`, and refuses if that role bypasses RLS | The copy must never write to production Firestore, call the POS, or ping production heartbeats; production-mode startup demands the service account (`env.ts:132-146`), so dev mode it is. The app must exercise RLS as production does |
| R12 | **Point of no return = C5 POST, and v1 stays the book of record until C5 is posted and the first day verified.** Before C5: abort means restore the pinned pre-purge dump into a new database (ops README; never over the live one), fix, re-run C2-C5. **The rehearsal proves this path for real:** after `migrate` and before `purge`, `predump` runs `npm run db-backup -- --store=fs:<REHEARSAL_DIR>` as a child process with the copy as its source (`SYSTEM_DATABASE_URL` set to the guarded target in the child env), and records that dump's own fingerprint from its manifest; after the opening, that dump is restored into a second guarded database on the temporary cluster and `rollback-check` compares the restored fingerprint with the manifest's. Nothing is compared with a fingerprint taken from the same database it is checking. v1 keeps running in parallel (ADR-005), so the stores lose nothing. **If C5 is not posted by the deadline (Q4: 5 Jan), go back to v1 for Q1 and the date becomes 1 April 2027 (ADR-005).** After C5: forward-fix only, by reversing entries; never a restore | Counted values are as at 31 Dec and do not change, so a re-run within days is honest; after posting, January's real entries make a restore a data-loss event |
| R13 | **Freeze between C2 and C5 is procedural, and checked** (Q3 a): staff enter nothing in v2 on 1 Jan until C5 posts, and **the runbook disarms every journal-writing timer from C2 to C5** (the list is built in S3 from `SCHEDULER_JOBS` and the systemd units in `docs/ops/`, e.g. month-end, recurring-expense-draft, budget-reissue, order-wastage-backstop, and T-396's POS import; each with its disarm and re-arm command and an `is-enabled` check). `verify --after-post` flags **any journal entry whose `source_type` is not `opening_balance` and that was CREATED after the purge commit, whatever its date** | Cheap; the check makes a breach visible instead of silently mixing into the opening balance, and a back-dated entry cannot hide behind its `entry_date` |

## 5. Contract

### 5.1 Command (`scripts/cutover-rehearsal.ts`, `npm run cutover:rehearse`)

```
npm run cutover:rehearse -- <sub> --confirm-database shareat_rehearsal_YYYYMMDD [options]
  start                 guards (R3), DEF-585 check (R6), row counts, migration head; opens the journal
  migrate               child: npm run db:migrate, DATABASE_URL = target in the child env (R5), timed
  predump               child: npm run db-backup -- --store=fs:<REHEARSAL_DIR>, source = target (R12), timed
  purge --by <personId> child: cutover-purge dry run -> --rehearse -> --apply --as-of <keepFrom> --by (R4), timed;
                        post-purge checks (I5)
  mark <step> start|end [--by <personId>]   times a human step (B3, C3, C3P, C4, C5, smoke, rollback)
  app-env-check --env-file <path>           refuses an app env that could write the edge or the POS (R11)
  verify                openingTieOut per org and store; DEF-585 check again; terminal-activity check (I10c)
  verify --after-post   I9-I10c after C5 is posted in the app
  rollback-check --against <url-env-name>   the restored predump's fingerprint equals its manifest's (I11);
                        the --against database passes the same guards as the target
  report                writes the sanitised report (R10) and the full one in REHEARSAL_DIR
```

Every subcommand re-runs guards (a)-(d) and (f); `start` and `purge` also run (e). Exit codes: 0 pass, 1 a check
failed (named), 2 refused by a guard.

### 5.2 Runbook (`docs/ops/cutover-runbook.md`, S3)

One table per day (31 Dec, 1 Jan, 2 Jan): time, step code, owner (a named person), command or screen, expected
duration (from S4's report), evidence, checkpoint. It includes: the v2 entry freeze from the 31 Dec close; the
pinned cutover-eve dump (`postgres/pinned/`, T-393 R4) and its drill; **the journal-writing timers disarmed before
C2 and re-armed after C5 (R13)**; `cutover-purge` dry run, then `--rehearse`, then `--apply --as-of 2027-01-01 --by
<Ian>` on production; C3/C3P/C4/C5 in the app; the first-day check (2 Jan 06:00 POS import lands in the new books);
the rollback rule (R12) with its deadline; the Firestore mirror step (DEF-643, owner to be named); for rehearsals,
the copy's app env (R11: sign-in only, no terminal routes, no pairing, no PIN sign-in) and "stop the 9008 app before
`start` and `purge`"; and a "who to call" line. `docs/ops/README.md` gets one pointer line to it.

### 5.3 Paths

| Slice | TESTER writes (first) | BUILDER owns |
|---|---|---|
| S1 | `tests/unit/t394-s1-guards.test.ts`, `tests/unit/t394-s1-conversion-date.test.ts`, `tests/unit/t394-s1-children.test.ts` (argv + env of every child), `tests/integration/t394-s1-rehearsal.test.ts` | `scripts/cutover-rehearsal.ts`, `scripts/lib/rehearsal/{guards,journal,checks,children,app-env}.ts`, `scripts/cutover-purge.ts` (R8 only), `packages/domain/src/cutover/opening-stock.ts` (**line 25 + one import only**: `const CONVERSION = CONVERSION_DATE;` imported from `./tie-out`, R7), `package.json` (one script line) |
| S2 | `tests/unit/t394-s2-report.test.ts`, `tests/integration/t394-s2-verify.test.ts` | `scripts/lib/rehearsal/{verify,report}.ts`, `scripts/cutover-rehearsal.ts` (verify/report subcommands) |
| S3 | — | `docs/ops/cutover-runbook.md`, `docs/ops/README.md` (one pointer line) |

⛔ No other domain, db, auth or app source; no schema, migration, register or bible edit. If `openingTieOut` or
the `db-backup` manifest fingerprint (`compareFingerprints`) cannot be used as they are, the builder reports it and stops (§3.4a).

## 6. Invariants (each has a test; the auditor applies each mutant)

**Guards and safety (S1)**
1. A target whose name does not match `^shareat_rehearsal_[0-9]{8}$` is refused before any connection writes;
   so is one whose host is a pinned production host (the constant, or one added by `PRODUCTION_DB_HOSTS`) even when
   `.env.local` names a different one, one whose host+database equals `DATABASE_URL`'s or `SYSTEM_DATABASE_URL`'s,
   and one whose typed name differs. The same refusals hold for the `rollback-check --against` database. *Mutants:
   pattern without anchors (`shareat_rehearsal_20261113_prod` passes); host compared, database not; `DATABASE_URL`
   accepted as the target; pinned-host list replaced (not extended) by `PRODUCTION_DB_HOSTS`; `--against` unguarded.*
2. The source URLs are parsed, never connected (a URL to an unreachable port does not slow or fail the guard).
   *Mutant: connecting to `SYSTEM_DATABASE_URL` to compare names.*
3. Liveness: a second open session on the target makes `start` and `purge` refuse (exit 2), naming the session's
   `application_name`. *Mutant: check skipped on `purge`.*
4. **The command is the command** (R4): `purge` spawns `scripts/cutover-purge.ts` exactly three times, in order,
   with argv `--confirm-database <target> --yes-really-not-local` + (none | `--rehearse` | `--apply --as-of
   <keepFrom> --by <id>`), and each child's env has `DATABASE_URL` = the guarded target and no other database URL
   (unit, on a spawn fake). It spawns nothing when a guard fails, and stops at the first non-zero child. In
   integration, the C2 row exists for every org afterwards. *Mutants: `--apply` without `--rehearse` first; child
   inherits the parent env (`DATABASE_URL` from `.env.local`); a local `truncate` loop; `--as-of` omitted.*
4a. `migrate` and `predump` (R5, R12): each child's env sets `DATABASE_URL` (migrate) or `SYSTEM_DATABASE_URL`
   (predump) to the guarded target explicitly; a test with a different `DATABASE_URL` in the parent env and in a
   fixture `.env.local` proves the child used the target (integration: the target's `drizzle` journal advanced and
   the decoy's did not). *Mutant: child inherits the parent env.*

**The purge on the copy (S1)**
5. After `purge`: every purge-class table is empty; `persons`, `accounts`, `stores`, `opening_counts` row counts
   equal the start counts; every org's trial balance is zero (Σdebit = Σcredit = 0, numeric text); no
   `fiscal_periods` row has `starts_on < CONVERSION_DATE`. *Mutants: start counts taken after the purge; money
   compared as `Number`.*
6. DEF-585 (R6): an org with no `open` period covering `CONVERSION_DATE`, or with coverage ending before the seed
   horizon for the run date (run 2026-11-13: through 2027-10; run 2027-01-01: through 2027-12), fails `start` naming
   the org and the first missing month; a second org created with no periods fails it too. *Mutants: check over the
   first org only; `closed` period accepted; horizon fixed at `CONVERSION_DATE` + 11 months whatever the run date;
   run month taken in UTC.*
7. R7: all five conversion-date copies are equal. *Mutants: change `PURGE_AS_OF`; change `tie-out.ts`'s
   `CONVERSION_DATE`; restore `opening-stock.ts`'s private copy with another value.*
7a. R8: `cutover-purge --apply` without `--as-of` is refused; a dry run at 2026-12-31T23:30Z (07:30 Manila,
   1 Jan) defaults to `2027-01-01`. *Mutant: `toISOString().slice(0, 10)`.*

**After the opening is posted (S2)**
8. `verify` runs `openingTieOut` for **every** org and fails on any non-tying line (per store and account code, as
   the function returns them), printing `tieOutDetail`. *Mutant: first org only.*
9. `verify --after-post`, per org: the opening is **the set of entries with `source_type = 'opening_balance'`**
   (C5 posts several: the figures entry and one inventory entry per store, Dr 1310/1320/1330 / Cr 3900,
   `opening-stock.ts:201`); every one is posted and dated `CONVERSION_DATE`; then `openingTieOut` is run again for
   every org and every line must tie, per store and code. **No balance, 3900 or inventory sum is re-computed in
   the tool** (RULES §6 item 3); C2 and C5 rows exist in `cutover_steps`. *Mutants: only the first
   `opening_balance` entry considered; a store's inventory entry left as a draft passes; a re-implemented
   Σdebit = Σcredit replaces `openingTieOut`.*
10. R13 freeze: any journal entry whose `source_type` is not `opening_balance` and whose creation time is after the
    purge commit (recorded in the journal from the `--apply` child's exit) fails, naming its id and source,
    **whatever its `entry_date`**. *Mutants: compare by `entry_date` only; a back-dated 2026-12-31 entry passes.*
10a. The first document after the purge gets number 1 for each sequence the purge reset (read `last_value`/
    `is_called`, never `nextval`). *Mutant: calling `nextval` (consumes a number on the copy and reports 2).*
10b. R11: `verify` reads the app's role from `pg_stat_activity.usename` for the sessions on the target that are not
    its own, and refuses when that role has `rolbypassrls` or `rolsuper`, or when no app session is connected.
    *Mutants: role read from `current_user` of the tool's own (bypass) connection; role parsed from
    `DATABASE_URL`.*
10c. R11 terminal ban: `app-env-check` refuses an env file with `FIREBASE_SERVICE_ACCOUNT_KEY`,
    `FIREBASE_SERVICE_ACCOUNT_KEY_FILE`, `FIREBASE_STORAGE_BUCKET` or any `POS_API_*` non-blank, and accepts one with
    only `FIREBASE_PROJECT_ID` + `NEXT_PUBLIC_FIREBASE_*` set; `verify` and `report` fail when any `clock_terminals`
    row was created or updated, or any `attendance_punches` row inserted, after `start`. *Mutants: `_KEY_FILE` not
    checked; a blank-with-spaces value treated as set; the activity check reads `clock_terminals` only.*

**Rollback and report (S1, S2)**
11. `rollback-check` (R12): the `predump` dump, restored into the `--against` database, has a fingerprint **equal**
    to the fingerprint in that dump's own manifest (`compareFingerprints`), and the `--against` database passed the
    guards; a single changed row count or a 0.01 difference fails, named. The comparison is never between two
    fingerprints of the same database. *Mutants: comparing TB parts only, not row counts; comparing the target with
    itself; `--against` equal to the target accepted.*
12. Every journal step has an end mark or is reported `NOT TIMED`; durations are whole seconds from the marks.
    *Mutant: missing end treated as zero.*
13. The committed report contains no value from `persons` text columns, no email, hash, phone or URL with a
    password (a fixture seeded with sentinel strings; the report is grepped for each). *Mutant: report includes the
    `--by` person's name instead of the id.*

## 7. Slices

| Slice | What | Size | Depends on | Date |
|---|---|---|---|---|
| **S1** | Guards (incl. pinned production hosts), journal, child-process runner; `start` / `migrate` / `predump` / `purge` (the real CLI, three runs) / `mark` / `app-env-check` / `rollback-check`; DEF-585 check; R7 five-copy test + the one-line `opening-stock.ts` import; R8 fix to `cutover-purge` | M 1.25 | none (local DBs) | 28 Oct |
| **S2** | `verify` (openingTieOut per org/store/code, app role from `pg_stat_activity`, terminal-activity check), `verify --after-post` (the `opening_balance` set, freeze by creation time), `report` (sanitised + full) | S 0.75 | S1; T-390 S5 (on main) | 4 Nov |
| **S3** | Runbook + rollback rule, durations left as `TBD (S4)` | S 0.25 (Opus, plan mode) | S1's command shape; Ian's Q2, Q4 | 7 Nov |
| **S4** | **The 13 Nov rehearsal** (operations, Ian present): copy, rename, `start`, `migrate`, `purge`, **stop the 9008 app**, `app-env-check`, `start`, `migrate`, `predump`, `purge`; start the 9008 app (R11 env: sign-in only, no terminal routes, no pairing, no PIN sign-in); Lipa test count + opening figures in the app (timed), C3P, `verify`, POST C5, `verify --after-post`, smoke; restore the predump into a second guarded database + `rollback-check`; `report`; runbook durations filled; copy destroyed | S 0.5 | S1-S3; T-391 Lipa applied; see §8 | 13 Nov |
| **S5** | **18 Dec dress rehearsal** on a fresh copy with two organisations; runbook frozen | S 0.5 | S4; T-398 S1-S4 + S7 | 18 Dec |

S1 and S2 integration tests need their own lane DB (a real purge truncates the whole database; RULES §2,
`t390-real-purge.ts` header), and create each `shareat_rehearsal_<8 digits>` database from a **template DB** (row 298:
migrated and seeded once, `CREATE DATABASE ... TEMPLATE`) and drop it; the local guard tests use a localhost URL as the "production" stand-in.

## 8. Dependencies, and what the rehearsal does if one slips

| Dependency | Needed for | If it slips by 13 Nov |
|---|---|---|
| **T-393 switched on** (Ian, row 306) | R1 preferred source; C1 rehearsed; dump-based rollback + RTO | Fork the cluster (R1 fallback). The rollback path is still rehearsed (R12: `predump` uses T-393's script locally with `--store=fs:`, which needs no Spaces key), but C1 (the production backup and its drill) is reported `UNREHEARSED`. **Plan risk R7 stays a named no-go item in the 15 Nov pack** |
| **T-390 S4** (import + price list; waits on T-391 apply per store) | Lipa's count entered from a file at last-v1-delivery prices | The Lipa test count is typed through `/cutover/count` (S1/S2 paths) with costs typed by a manager; R2 is still met (a real count, not a fixture). The import path is reported `UNREHEARSED` and must be rehearsed on 18 Dec |
| **T-391 Lipa applied in production** (17 Oct) | Real items on the copy to count | No meaningful count: the rehearsal is limited to purge + an opening of money and party figures; **no-go risk on its own**, said in the report |
| **T-398 S1** (0194) merged | R5: its pre-flight on real data | Rehearsal runs at `main`'s head; 0194's pre-flight is run read-only on the copy as P0194a (ops README) and the count reported |
| **T-398 S2-S4** (persons/stores and remaining same-org FKs) | 18 Dec two-org rehearsal | 13 Nov is single-org regardless. If not on production by 4 Dec, the drop-alone rule (T-398) applies and S5 rehearses Ian's org alone |

## 9. Money and auth invariants, stated

- **Money:** every comparison is `numeric` text or integer centavos, never a float (I5, I11); the tool re-computes
  no balance: the opening ties only if `openingTieOut` ties for every org, store and code after the POST (I9; RULES
  §6 item 3), which covers 3900 netting to zero (nothing is plugged, row 124) and 1310/1320/1330 against the opening
  layers.
- **Auth:** the tool connects with a bypass-RLS role **to the copy only** (I1-I3, R3); the app on the copy connects
  as `shareat_app_prod` under RLS (invariant 10b, role read from `pg_stat_activity`), so C3-C5 are performed through `authorize()` exactly as on 1 Jan, by the person
  who will do them then, signed in with their own credentials (typed by them, never by an agent). `--by` and every
  `mark --by` take a person id that must exist on the copy. No credential, key or connection string reaches a log or
  the report (I13; T-393 R13's `redact`).
- **Isolation:** the copy never reaches production Firestore, POS or heartbeats (R11, invariant 10c: Firebase for
  sign-in only, no terminal routes, pairing or PIN sign-in); production never receives a
  test count (§3: `opening_counts` is KEEP).

## 10. Out of scope

Any change to the purge engine, the wizard, posting or the classification · making wizard C1 `verified` (Q5) · the
Firestore mirror reset after the purge (DEF-643, logged, owner to be named in the runbook) · the ETL purge on
31 Jan 2027 (a dated task of its own, ADR-007 §6) · T-393's production switch-on (Ian) · creating DO clusters (Ian)
· the bible, the register, the plan (planner/orchestrator).

## 11. Done when

- [ ] S1-S2: all invariants pass, each red leg shown red on HEAD or against its mutant; typecheck clean; affected
      tests locally; full suite green in CI on the PR; `build` with the dev server stopped.
- [ ] S3: runbook merged, signed by Ian (his initials and date in its header, typed by him).
- [ ] **S4: the 13 Nov report exists** with every step timed or named `NOT TIMED`/`UNREHEARSED`, every check pass
      or named, the copy destroyed (Ian confirms in the DO panel). *The report is the deliverable, not the code.*
- [ ] DEF-585 closed by the orchestrator citing R6 and I6.
- [ ] S5 report on 18 Dec; runbook frozen.

## 12. Risks

1. **T-393 still off on 13 Nov** (row 306): the rehearsal still runs (fork) and the rollback restore is still
   rehearsed from the local predump, but C1 (the production backup and its drill) is unproven and the 15 Nov gate
   names it. Mitigation: ask on 1 Nov (plan R7).
2. **Purge duration on real data unknown**: it is one transaction with md5 over every KEEP table; on a copy it may
   be minutes. S4 measures it; if > 15 min the runbook adds a maintenance window.
3. **A pre-flight in a 1 Jan migration RAISEs on real data** (0194 and later): found on 13 Nov, which is the point.
4. **Human steps take longer than a day**: C3 for four stores (T-390 says days). S4 times Lipa only and scales;
   the runbook starts C3 drafting on the copy's figures pattern, not on 1 Jan.
5. **The copy holds production PII on a cluster Ian must remember to destroy**: the runbook's last S4 line is the
   destroy, and the report records it.

## 13. Questions for Ian (Open Questions page; the recommended option is built)

| Id | Question | Options | Recommended |
|---|---|---|---|
| **t394-q1** | Where does the copy for the rehearsal live? | (a) **a temporary DO cluster** you create (restore of the backup, or a fork), destroyed the same day, about US$0.03 an hour · (b) your laptop's Postgres (payroll and PINs copied onto the laptop) · (c) a database on the production cluster (disk shared with live POS and ERP) | **(a).** Truest copy, no risk to production, nothing left behind |
| **t394-q2** | Who does each step, on 13 Nov and on 1 Jan? Example: the purge is typed by you; Lipa's manager counts; the encoder enters the opening figures. | (a) **the same named people on both days**, you for the purge and the POST · (b) agents run the commands, people only count | **(a).** The rehearsal is of the people as much as the code; an agent may not sign in for them |
| **t394-q3** | Between the purge and the POST on 1 Jan, nobody may enter anything in v2. How is that kept? | (a) **a rule in the runbook, and the check fails if anything slipped in** · (b) a code lock on every posting screen | **(a).** One morning; the check makes a breach visible. (b) is a new code path that only runs once |
| **t394-q4** | If the POST has not happened, how long do we keep trying before going back to v1 until 1 April? | (a) **until 5 Jan**, v1 stays the book of record until then · (b) 2 Jan · (c) 15 Jan | **(a).** The count is as at 31 Dec and does not change, so a re-run within days is honest; past the first week the gap in v2 grows |
| **t394-q5** | Wizard step C1 ("restore rehearsed") is a tick today. Should it check the restore report itself? | (a) **keep it a tick that quotes the drill report's name** · (b) make it check automatically (the app reads the backup store) | **(a).** Costs nothing; (b) gives the app access to the backups for one tick |

## 14. Findings while specifying (registered as DEF-641..643; the doc note is the orchestrator's)

- **DEF-641** `scripts/cutover-purge.ts` `parseArgs`: the `--as-of` default is `new Date().toISOString().slice(0, 10)`,
  the **UTC** date. Before 08:00 Manila it is yesterday; run early on 31 Jan 2027 it silently defers the ETL tables
  (`notBefore: '2027-01-31'`). Fixed by R8 in S1.
- **DEF-642** The conversion date is hard-coded five times (`apps/erp/src/app/cutover/lib.ts:17`,
  `packages/domain/src/cutover/tie-out.ts:25`, the private `CONVERSION` in `packages/domain/src/cutover/opening-stock.ts`,
  `packages/db/src/cutover/classification.ts:149`, `tests/integration/t390-real-purge.ts`) with nothing pinning their
  agreement. Fixed by R7's test in S1.
- **DEF-643** After the purge, the Firestore mirror still holds pilot-period documents and no republish/reset tool
  exists (no hit for a mirror rebuild in `packages/domain/src`, `scripts`, `docs/ops/README.md`); the clock terminals
  would show stale state. Unowned: CAPABILITY-GAPS or section E, owner to be named before the runbook freezes.
- **Doc note** (not registered) `docs/plans/remaining-build-plan.md:9` says "15 Nov go/no-go + purge rehearsal", while §2 and
  §3 put the rehearsal on 13 Nov; and plan R4 says wizard C1 "refuses until a restore is rehearsed", which it does
  not (T-393 R14 already noted it).

## S1 orchestrator rulings (2026-10-14)
- **Tests may create local rehearsal databases** named `shareat_rehearsal_2099MMDD` on localhost:5435 (R3's real pattern; a far-future date so they can never collide with a real rehearsal), created and dropped by the tests themselves. The name pattern is NOT made injectable.
- The function signatures pinned in the S1 test headers (guards, children, checks, app-env) are the contract.
- The tester's readings stand: `--against` needs no typed name of its own; a closed period covering 2027-01 counts as missing; months before the conversion month are not required; `opening-stock.ts` must derive its conversion date (7.b required); both `--apply` and `--rehearse` need `--as-of`.

# T-393: Nightly off-cluster backup to Spaces, a failure alert, and a restore drill that proves the trial balance ties

**Status:** SPEC APPROVED WITH CHANGES 2026-10-10 (fresh Opus review applied). **Ian, 2026-10-10, answering Q1-Q5: "no backup for now, we'll set up soon" (bible row 306).** Build and test S1-S2 as specced; **do NOT switch it on in production** until Ian sets it up. ⚠️ **Open point for that day, not resolved here:** plan-q7 = (a) says the existing `shareat-erp-backups` bucket under `postgres/` with prefix-scoped 30-day retention; this spec says a dedicated `shareat-pg-backups` bucket with 35 days + 13 monthly + yearly (R5, R12). Ian picks one when he sets it up; both are config-contract values.

(≈1.75 days, two slices, lane L3). **No migration** (R11). Five questions for Ian (Q1-Q5) plus a short list of facts to confirm. The
recommended option of each is what this spec builds, and the code runs and is tested locally
before any of them is answered. Only the production install waits on Q1, Q2, Q3 and Q5.

## Goal

Plan row C5: **a dump lands in DO Spaces under `postgres/` every night, a failure alerts somebody,
and a scripted restore into a scratch database proves the trial balance ties.** The point is the
last clause. Bible §15.8 says *"An untested backup is not a backup"*. Today nothing has ever been
restored.

## Source

- `docs/plans/remaining-build-plan.md` §1 row C5, §3.3 T-393 (L3, wave 1, S 1.5), Q7, risk R4.
- `PROJECT_BIBLE.md` §15.8 (backups with PITR, restore rehearsed on a schedule). §13 row 274 (one
  Postgres; *"a nightly off-cluster dump with a rehearsed restore is required"*). Row 61 (DO
  Managed Postgres plus the droplet; *"Spaces already exists for backups"*). **Row 64** (Frappe
  backups in `shareat-erp-backups` are retained; Postgres goes to a separate prefix; **no expiry
  rule**).
- `docs/decisions/ADR-002-infrastructure-and-auth.md` §1 (*The Spaces bucket, confirmed contents*:
  prefix `postgres/`, no lifecycle rule that could age out Frappe objects) and §7 (*retention long
  enough to cover a statutory period, not just a week*; a restore rehearsed on a schedule).
- `docs/ops/README.md`: *The jobs*, *Restores and replica mode (T-354)*, *How you find out it
  stopped*, the `SYSTEM_DATABASE_URL` section, and *Traps on the box*.
- `packages/domain/src/cutover/steps.ts` step **C1** *"Backup taken and restore REHEARSED"*
  (`kind: 'attested'`).

## Research

### What exists (verified 2026-10-10)

| Piece | State |
|---|---|
| DO Managed Postgres native backups | On, by the platform: daily, with point-in-time recovery inside DO's retention window (7 days at our tier). **Same provider and account as the cluster.** Never restored |
| Any `pg_dump` / `pg_restore` in the tree | **None** (`grep` across `*.ts`, `*.sh`, `*.yml`) |
| An S3 client | **None** in any `package.json` |
| `pg_dump` on the droplet | **Not installed.** `docs/ops/provision.sh` installs Caddy and nothing for Postgres. Production is **PostgreSQL 18.6** (`docs/ops/README.md:74`). `pg_dump` refuses a server newer than itself, so Ubuntu's stock client will not work. It needs PGDG's `postgresql-client-18` |
| Credentials | `SYSTEM_DATABASE_URL` in `/srv/shareat-shared/.env.local` is the `doadmin` string, which bypasses RLS. `DATABASE_URL` is `shareat_app_prod`, which does not bypass it. No Spaces key is on the box |
| Job conventions | One `shareat-<script>.{service,timer}` pair per runner script. `Type=oneshot`, `User=shareat`, `WorkingDirectory=/srv/shareat`, log to `/var/log/shareat/<script>.log`, `Persistent=true`, `Asia/Manila` calendar. `provision.sh` installs by glob and **arms nothing**. Ian arms with `systemctl enable --now` |
| Guards | `tests/unit/scheduler-job-hosting.test.ts` fails on any `.service`/`.timer` in `docs/ops` that is neither a `SCHEDULER_JOBS` script nor a named exception. `scheduler_runs.org_id` is `NOT NULL`, so it **cannot record a cluster-wide run** (the same reason T-272 scoped the orphan sweep per org) |
| Nightly slots taken | 01:30, 02:00, 02:30, 03:00, 03:30 daily; 04:00 on the 1st (`docs/ops/README.md` *The jobs*) |
| Trial balance | `v_trial_balance` (`packages/db/schema/views.ts:126`), read by `getTrialBalance` |

### ⚠️ Found in passing: the alert every job relies on probably does not exist

All nine `.service` files say *"The exit code is load-bearing: non-zero when anything failed, so the
host's mailer speaks up."* `provision.sh` installs no MTA, and no unit has `OnFailure=`. Unless Ian
installed a mailer by hand, **a failing nightly job tells nobody**. That is why this spec does not
use the exit code as its alarm (R7). The orchestrator should log it as a section-E defect, status
`reported`. One `dpkg -l | grep -E 'postfix|msmtp|exim'` on the box settles it.

### The standard pattern, and how much of it we take

| Practice (PostgreSQL docs §26, "3-2-1", restore-testing) | Here |
|---|---|
| Logical dump in custom format (`pg_dump -Fc`): one file, compressed, selective and parallel restore | **Adopted** (R1) |
| A checksum stored with the dump and verified before restore | **Adopted**: sha256 in a manifest beside the dump (R3) |
| Copy off the primary system (off-cluster, ideally off-provider) | **Partly**. Spaces is off-cluster but **same provider, same region (SGP1)**. A DO account loss or an SGP1 regional loss takes both. Accepted for now; see *Not adopting* |
| Retention as grandfather-father-son | **Adopted** (R5). It replaces the plan's flat 30 days, which conflicts with ADR-002 §7 (Q4) |
| A dead-man's switch: alert when the success signal is **absent**, not only when a failure is reported | **Adopted** (R7). It catches the never-armed timer, which has happened five times here (DEF-186, -226, -299, -303, -332) |
| Restore drill on a schedule, with a **content check**, not just "it loaded" | **Adopted** (R8-R10): the trial balance and row counts, compared with figures captured **in the same snapshot as the dump** |
| Measure the restore time (RTO) | **Adopted**: the drill records dump and restore durations. T-394's runbook quotes them |

### What we are NOT adopting, and why

- **WAL archiving / our own PITR (pgBackRest, WAL-G).** DO Managed Postgres does not give a
  customer physical replication or `archive_command`, so neither tool can run against it. DO's
  native PITR already covers *"undo the last few days"*. The nightly dump covers *"the cluster or
  the account is gone"* and *"older than DO keeps"*. The worst case is losing up to 24 hours of
  data in a total-loss event. For a business whose POS keeps its own sales records, that is
  recoverable. Revisit when POS P2 writes sales here directly (the row 274 standby trigger).
- **A bucket lifecycle (expiry) rule.** ADR-002 §1 and row 64 forbid one, because a mis-scoped
  rule silently ages out the Frappe archive. Retention runs **in the script**, which can delete
  only keys matching one exact pattern under `postgres/daily/` (R5, I5), and tests prove it.
- **Client-side encryption is Ian's call (Q5), built behind one switch.** The dump holds payroll
  and PIN hashes. With one operator, the likeliest failure of encryption is losing the private key
  and with it every backup; the likeliest failure without it is a leaked Spaces key. The switch
  (`BACKUP_AGE_RECIPIENT` set or not) means either answer costs no rework.
- **A second region or provider.** It would be a real 3-2-1, but it is a second account and a second
  key for Ian to manage. Revisit after cutover. The manifest format already supports a second
  destination.
- **Running the drill in GitHub Actions.** It would be free and automatic, but it copies production
  payroll data onto a third party's runner. Rejected (Q3 option c).
- **A `backup_runs` table and a `backupStale` finding.** That needs a migration, an RLS class and a
  detector. It shows only to someone who opens `/findings`, and it cannot fire when the app itself
  is down. The dead-man's switch fires in all of those cases (Q2 option b).
- **Using `scheduler_runs`.** It cannot record a cluster-wide run (`org_id NOT NULL`), and widening it
  needs a migration of its job CHECK constraint.

## Rulings

| # | Ruling | Reason |
|---|---|---|
| R1 | **One `pg_dump -Fc` of the whole production database, nightly at 04:30 Manila**, through `SYSTEM_DATABASE_URL` (the RLS-bypassing `doadmin` role) on the **direct** port (25060). **A URL on the pooler port 25061 is refused** before connecting. No `--exclude-*`. Owners and ACLs are kept in the dump; the restore decides whether to apply them. **`runBackup` refuses unless `current_user` has `rolbypassrls` or `rolsuper`**, and **writes no manifest unless the fingerprint has ≥1 org and ≥1 journal line** (an empty production ledger is a misconfiguration, not a quiet night). Beside each dump it uploads **`pg_dumpall --roles-only --no-role-passwords`** output (`<key>.roles.sql`, named in the manifest), because `pg_dump` carries no roles and a restore into a new cluster needs them | 04:30 is after every other nightly job (latest 04:00), so the dump includes their output. As a non-bypassing role, `pg_dump` errors out on FORCE-RLS tables, so it fails loudly rather than producing a hollow dump, but only the bypass role can produce a full one. A snapshot export (R2) needs a session connection, which a transaction pool cannot provide |
| R2 | **The manifest is computed in the same snapshot as the dump.** The script opens a `REPEATABLE READ READ ONLY` transaction, asserts `SHOW transaction_isolation` = `repeatable read` inside it, calls `pg_export_snapshot()`, computes the fingerprint (R9) inside it, runs `pg_dump --snapshot=<id>`, and keeps the exporting session open **until `pg_dump` has exited** (the snapshot dies with the session), then commits | The drill can then demand an **exact** tie, and does not have to explain a difference by writes that happened during the dump |
| R3 | **Every dump has a manifest** `<key>.manifest.json`: created-at (UTC), source server version, source `pg_database_size`, `pg_dump` version, byte size, sha256 (computed **streaming**, never by reading the file into memory), dump duration, the roles file's key and sha256, and the fingerprint (R9). **The manifest is uploaded last.** A dump with no manifest is incomplete, and retention and the drill ignore it | A dump whose content nobody recorded cannot be checked. Uploading the manifest last makes "manifest exists" mean "the upload finished" |
| R4 | **Key layout.** `postgres/daily/YYYY-MM-DD/shareat-YYYYMMDDTHHMMSSZ.dump` plus `.manifest.json`, where the date is the **Manila** business date and the stamp is UTC. `postgres/drills/YYYY-MM-DD.json` holds drill reports. `postgres/pinned/` is for hand-pinned copies (the cutover-eve dump, T-394) and **no code deletes there** | One prefix, never interleaved with Frappe (row 64). A human can read the date in the key |
| R5 | **Retention is grandfather-father-son and is pruned by the script.** It keeps every complete dump from the last **35 days**, the **earliest** complete dump of each Manila month for **13 months**, and the earliest complete dump of each **year, forever**. It runs **only after** tonight's dump and manifest have been verified in Spaces. It deletes at most **10 dumps per run**, and never leaves fewer than **7 complete dumps**. A bare `.dump` with no manifest (a crashed night) is deleted once it is 2 days old | ADR-002 §7 asks for a statutory horizon. A yearly dump kept forever costs little: about 47 dumps live at once, which should fit inside the Spaces subscription (250 GiB shared across all buckets; verify on DO's price page; the smoke measures the real size). The caps mean a clock or parsing bug can never empty the prefix in one night |
| R6 | **Pre-upload verification, three steps.** (1) `pg_dump` exited 0. (2) `pg_restore --list` reads the table of contents and it has more than zero entries. (3) **A full read**: `pg_restore -f <null device> <file>` (`/dev/null`; `NUL` on Windows) decodes every data block and exits 0. After upload, `HEAD` must report the same byte size and carry the sha256 as object metadata. **Free-disk pre-check:** before dumping, the temp directory must have free space ≥ `pg_database_size` × 1.5, else fail | `--list` reads only the TOC, so a file truncated in its data section passes it. The full read catches that before a broken archive replaces a good one in the retention count |
| R7 | **The alert is a dead-man's switch (Q2 option a).** The script pings `BACKUP_HEARTBEAT_URL/start` when it starts, the bare URL on success, and `/fail` with a one-line reason on any failure. The service alerts Ian when **no success arrives within 26 hours**. The drill has its own check (`DRILL_HEARTBEAT_URL`), with an 8-day grace. **The exit code stays load-bearing as well** (non-zero on any failure), per the house rule | Only an absence-based alarm fires when the timer was never armed, the droplet is down, or the script hangs. A heartbeat that fails to send is logged and **never** fails the backup |
| R8 | **The drill restores the newest complete dump into a scratch database, weekly** (Sunday 05:30 Manila, Q3 option a). It downloads the dump and verifies the sha256, drops and recreates the scratch database, then runs `pg_restore --no-owner --no-acl --exit-on-error --single-transaction`, logs the restored `pg_database_size`, then runs the tie check (R9) and the sequence check (each sequence's `last_value` ≥ `max()` of its owning column, **not** equality, because a sequence may run ahead of its rows), then drops the scratch database. It writes `postgres/drills/<date>.json` with the dump key, the result, every mismatch, and the download, restore and check durations | A weekly drill proves every week's dumps restore without a human remembering to try. `--single-transaction` means a failed restore leaves nothing half-loaded. `--no-owner --no-acl` lets the dump restore into a cluster that lacks `shareat_app_prod`, which is the real disaster case. The README's T-354 note says a full restore keeps the `ENABLE ALWAYS` triggers |
| R9 | **What "ties" means.** The fingerprint has three parts: (1) per org and account, `sum(debit_total)`, `sum(credit_total)` and `sum(net_balance)` from `v_trial_balance` over **all** dates; (2) per org, total debits = total credits; (3) an exact `count(*)` for **every** base table in `public` and `drizzle`. The restored database's fingerprint must **equal** the manifest's, with money compared as `numeric` text, never as floats. Part (2) must hold in both. ⛔ **A fingerprint with zero orgs, or with zero journal lines while the manifest has some, is a FAILURE**, never an empty-equals-empty pass | Part 1 is what Ian means by "the trial balance ties". Part 3 catches a table that lost rows the ledger cannot see (staff, items, documents). The empty-set rule kills the most dangerous false green: a check run under RLS that sees nothing and so "ties" |
| R10 | **Scratch-target guards.** The drill refuses unless the target database name matches `^shareat_(restore_drill|test_drill_[a-z0-9]+)$`. It refuses whenever the target database name **equals the source database name, regardless of host**. It drops a database **only** if the name passes the same pattern. It **only parses** `sourceUrl` (to compare names) and **never connects** to the source. Its maintenance connection is a separate configured database (`defaultdb` on DO, `postgres` locally), never the source database | The drill holds credentials that can reach production. Its one destructive statement must be impossible to aim at the real database |
| R11 | **No migration, no table, no `SCHEDULER_JOBS` entry.** The run record is the object in Spaces plus its manifest, the drill report, and the heartbeat history. The two new unit pairs are listed in the hosting guard as **named platform jobs** (S1 tests) | See *Not adopting*. Nothing here is per-org state |
| R12 | **Config is checked against the documented values** with `scripts/lib/config-contract.ts`: bucket **`shareat-pg-backups`** (a dedicated bucket holding nothing else, Q1), endpoint `https://sgp1.digitaloceanspaces.com`, prefix `postgres/` (a constant, **not** an env var). **`shareat-erp-backups` (the Frappe archive) is refused by name**: the droplet's key must never be able to write to or delete from it (row 64; ADR-002 *"Do not delete them"*). A missing or empty key aborts before any connection opens (bible §15.9) | DEF-311 shipped a reachable-but-wrong bucket for the life of a deployment. A backup written to the wrong bucket is a backup nobody will find |
| R13 | **No secret reaches a log, a heartbeat body or a drill report.** Connection strings, Spaces keys and the heartbeat URL are redacted in every message. `pg_dump`, `pg_restore` and `pg_dumpall` get the password through `PGPASSWORD` in the child's env. The connection string in argv has the password **stripped**, built by one pure `buildPgArgs()` in `pg-tools.ts` | DEF-196 (a sourced `.env.local` echoing the password) and v1's POS weather job (which echoed its shared secret). Argv is visible in `ps` |
| R14 | **Wizard step C1 stays `attested`.** The person attesting quotes the newest passing drill report's key. Making C1 `verified` would need the app to read Spaces or a table; that belongs to T-394 if Ian wants it | Keeps T-393 small. See *Questions*: the plan's R4 says C1 "refuses", which it does not |

## Contract

### Files and entry points

```ts
// scripts/lib/backup/object-store.ts
export interface ObjectStore {
  put(key: string, file: string, meta: Record<string, string>): Promise<void>;   // streamed multipart
  head(key: string): Promise<{ size: number; meta: Record<string, string> } | null>;
  list(prefix: string): Promise<{ key: string; size: number }[]>;                 // paginates fully
  get(key: string, toFile: string): Promise<void>;
  delete(keys: string[]): Promise<void>;
}
export function spacesStore(cfg: SpacesConfig): ObjectStore;   // @aws-sdk/client-s3 + lib-storage, forcePathStyle false
export function fsStore(rootDir: string): ObjectStore;          // tests and local smoke; same key semantics
export const BACKUP_PREFIX = 'postgres/';                       // constant, R12

// scripts/lib/backup/pg-tools.ts
resolvePgBin(name: 'pg_dump' | 'pg_restore' | 'pg_dumpall'): string   // PG_BIN_DIR, else PATH
buildPgArgs(url: string, extra: string[]): { argv: string[]; env: Record<string, string> }  // pure; the password goes only in env.PGPASSWORD
assertDirectPort(url: string): void                             // refuses port 25061 (the pooler)
assertClientMatchesServer(bin, serverVersionNum): void          // client major >= server major, else throw
redact(s: string): string                                       // R13

// scripts/lib/backup/fingerprint.ts
export interface Fingerprint {
  trialBalance: { orgId: string; accountId: string; debit: string; credit: string; net: string }[]; // sorted
  orgTotals: { orgId: string; debit: string; credit: string }[];
  rowCounts: Record<string, number>;                            // 'schema.table' -> count
}
computeFingerprint(sql: Sql /* inside the snapshot tx */): Promise<Fingerprint>
compareFingerprints(source, restored): { ok: boolean; mismatches: string[] }  // R9, incl. the empty-set rule

// scripts/lib/backup/retention.ts   (pure; no I/O)
planPrune(keys: string[], todayManila: string): { keep: string[]; delete: string[]; reasons: Record<string, string> }

// scripts/lib/backup/run-backup.ts
runBackup(deps: { store: ObjectStore; sourceUrl: string; heartbeat: Heartbeat; now: () => Date; tmpDir: string;
  hooks?: { afterFingerprint?: () => Promise<void>; afterDump?: (file: string) => Promise<void> } }): Promise<BackupResult>  // hooks: tests only

// scripts/lib/backup/run-drill.ts
runDrill(deps: { store: ObjectStore; targetUrl: string; maintenanceDb: string; sourceUrl: string; heartbeat: Heartbeat; tmpDir: string }): Promise<DrillResult>

// scripts/lib/backup/heartbeat.ts
export interface Heartbeat { start(): Promise<void>; ok(): Promise<void>; fail(reason: string): Promise<void> }
httpHeartbeat(url: string | undefined): Heartbeat               // undefined -> logs "no heartbeat configured" once; never throws
```

- `scripts/db-backup.ts` and `scripts/restore-drill.ts` are thin: validate env (R12), build the
  real deps, call `runBackup`/`runDrill`, print one summary line, and `process.exit(ok ? 0 : 1)`.
  npm scripts: `db-backup`, `restore-drill`. **One name convention, `shareat-<script>`:** script `db-backup` goes with units `shareat-db-backup.*`, and script `restore-drill` with `shareat-restore-drill.*`. (The plan's `scripts/backup-*` glob is superseded by this name.) Both accept `--store=fs:<dir>` for local runs.
  Without that flag they require the Spaces env.
- **`runBackup` order is fixed (I1):** heartbeat start → config and pooler-port check → privilege
  check (`rolbypassrls` or `rolsuper`) → free-disk check → open the snapshot tx and assert its
  isolation → fingerprint (refuse if empty) → `pg_dump --snapshot` to `tmpDir` (exit 0) → commit →
  `pg_dumpall --roles-only --no-role-passwords` → `pg_restore --list` and full read (R6) → (encrypt,
  if Q5 is on) → streamed sha256 → `put` dump and roles file → `head` verify → `put` manifest →
  `planPrune` + `delete` → heartbeat ok → remove the temp files. On any throw:
  heartbeat fail, remove the temp file, rethrow. **Nothing is pruned on a failed night.**

### Env (`.env.example`, server-only, in `/srv/shareat-shared/.env.local`)

`SPACES_ENDPOINT`, `SPACES_REGION` (`sgp1`), `SPACES_BUCKET` (`shareat-pg-backups`), `SPACES_KEY`,
`SPACES_SECRET`, `BACKUP_HEARTBEAT_URL`, `DRILL_HEARTBEAT_URL`, `RESTORE_DRILL_DATABASE_URL`,
`RESTORE_DRILL_MAINTENANCE_DB` (default `defaultdb`), optional `PG_BIN_DIR`, and, only if Q5 is
on, `BACKUP_AGE_RECIPIENT` (public key) and `BACKUP_AGE_IDENTITY_FILE` (the drill's private key file,
mode 600, owned by `shareat`). The source is
`SYSTEM_DATABASE_URL`. The heartbeat URLs are optional for local runs, required by `--production`
(which the unit files pass).

### Units

`docs/ops/shareat-db-backup.{service,timer}` (daily 04:30 Manila) and
`docs/ops/shareat-restore-drill.{service,timer}` (`Sun *-*-* 05:30:00 Asia/Manila`). Both are
copies of the house shape: oneshot, `User=shareat`, `Persistent=true`, a log under
`/var/log/shareat/`, the never-build warning, and `TimeoutStartSec=2h`. They also set **`Nice=10`,
`IOSchedulingClass=idle` and `MemoryMax=1G`**, so a dump or drill cannot starve the app on the same
box. (Aside: the existing units' comments say "2 GB droplet". The box is 4 GB. The comment is stale
but harmless, and is not fixed here.) They follow the
"No `After=postgresql.service`" note. `provision.sh` adds PGDG's apt repository and
`postgresql-client-18`, idempotently.

## Invariants

| # | Invariant |
|---|---|
| I1 | The manifest's fingerprint and the dump come from one exported snapshot, and the exporting session stays open until `pg_dump` has imported it and exited |
| I2 | A dump without a manifest is never counted as complete. Not by retention, not by the drill, not by the "≥7 complete" floor |
| I3 | Nothing is pruned unless tonight's dump and manifest are both verified in the store |
| I4 | A prune deletes at most 10 dumps (each with its manifest) and never leaves fewer than 7 complete dumps |
| I5 | Every key a prune deletes matches `^postgres/daily/\d{4}-\d{2}-\d{2}/shareat-\d{8}T\d{6}Z\.(dump|manifest\.json)$`. Nothing outside `postgres/daily/` is ever deleted, and `postgres/pinned/` is never even listed for deletion |
| I6 | The drill's tie check fails on any difference, on an empty fingerprint, and on debits ≠ credits for any org |
| I7 | The drill drops or creates only a database whose name passes R10, never one named like the source, and never opens a connection to the source |
| I8 | A failure at any step exits non-zero and sends `fail`. A heartbeat that cannot be delivered never changes the exit code |
| I9 | No log line, heartbeat body, manifest or drill report contains a password, a Spaces secret, or the heartbeat URL |
| I10 | The bucket and prefix are checked against their documented values before any I/O, and the Frappe bucket is refused by name |
| I11 | No manifest is written unless the role bypasses RLS and the fingerprint has ≥1 org and ≥1 journal line |
| I12 | No argv element of any spawned Postgres tool contains a password |

## Slices

| Slice | BUILDER files | TESTER files | Size |
|---|---|---|---|
| **S1** nightly backup, retention, heartbeat, units | `scripts/lib/backup/{object-store,pg-tools,fingerprint,retention,heartbeat,run-backup}.ts` (new), `scripts/db-backup.ts` (new), `docs/ops/shareat-db-backup.{service,timer}` (new), `docs/ops/provision.sh`, `package.json` (two scripts; deps `@aws-sdk/client-s3`, `@aws-sdk/lib-storage`), `package-lock.json`, `.env.example`, `.github/workflows/ci.yml` (install `postgresql-client-18` from PGDG before the integration job; CI runs `postgres:18`), `docs/ops/README.md` (a *Jobs* row, plus a short *Backups* section: install, arm, first run, where to look) | `tests/unit/t393-retention.test.ts` (new), `tests/unit/t393-redaction-and-config.test.ts` (new), `tests/integration/t393-backup.test.ts` (new), `tests/unit/t393-pg-args.test.ts` (new), `tests/unit/scheduler-job-hosting.test.ts` (add a `NAMED_PLATFORM_JOB` list holding **`db-backup` only**, with a reason citing T-393, requiring **both** units and accepted by the two "unexplained" checks) | 1.0 day |
| **S2** restore drill and tie check | `scripts/lib/backup/run-drill.ts` (new), `scripts/restore-drill.ts` (new), `docs/ops/shareat-restore-drill.{service,timer}` (new), `docs/ops/README.md` (a *Restoring for real* runbook, fifteen lines or fewer: which dump; replay its `.roles.sql`, then set the role passwords by hand; the `pg_restore` flags; re-run the grants and default privileges for `shareat_app_prod` (T-355); point the env; verify with the drill check) | `tests/integration/t393-restore-drill.test.ts` (new), `tests/unit/scheduler-job-hosting.test.ts` (add **`restore-drill`** to `NAMED_PLATFORM_JOB`) | 0.75 day |

- **Disjoint paths.** BUILDER never writes under `tests/`. TESTER writes only under `tests/`. S2
  starts after S1 is committed. Tester first, then builder, in each slice. One Sonnet lane (L3).
- **Out-of-list needs: stop and report.** The orchestrator edits the register (the mailer finding,
  above), `docs/ROADMAP.html`, the board and plan row C5. The Opus planner writes the bible §13 row
  for R5, R7 and R9 at merge.

## Tests (TESTER writes first; each is shown red on HEAD or against the named mutant)

Integration tests use real Postgres on 5435 and real `pg_dump`/`pg_restore`. Spaces is replaced
by `fsStore(tmpdir)`, and the heartbeat by a recording fake. **Missing binaries or a version
mismatch are a FAILURE with a message naming `PG_BIN_DIR`, never a skip.** The source is the test
database. It is seeded through the real `postEntry` with worked-example fixtures for **two** orgs,
so the trial balance is not trivially empty. Drill targets are `shareat_test_drill_<random>`,
always dropped in `afterAll`.

**S1, unit: `t393-retention.test.ts`** (pure `planPrune`)

1. 60 consecutive daily dumps: keeps the last 35, plus the earliest of each older month. *Mutant: `>` for `>=` at day 35.*
2. 3 years of dailies: keeps one per month for 13 months and **the earliest of each year forever**. *Mutant: yearly tier dropped.*
3. A dump with no manifest is neither kept as "complete" nor counted toward the floor, and is deleted only once it is older than 2 days (a crashed night's orphan). *Mutant: count bare `.dump` keys as complete (I2).*
4. 200 eligible old keys yields **at most 10** dumps deleted. *Mutant: cap removed.*
5. "Today" set 10 years ahead (a clock bug) still leaves at least 7 complete dumps. *Mutant: floor removed.*
6. Keys under `postgres/pinned/`, a Frappe-looking key (`backups/site-...tar.gz`), `postgres/daily/` keys with a malformed date, and `postgres/drills/` keys are **never** in `delete`. *Mutant: prefix test instead of the full I5 regex.*

**S1, unit: `t393-redaction-and-config.test.ts`**

7. `redact` removes the password from `postgresql://u:p@h:25060/db?sslmode=require`, a Spaces secret, and a heartbeat URL embedded in an error message. *Mutant: redact only the URL form.*
8. The config check refuses bucket `shareat-hub-v2` and an empty `SPACES_SECRET`, and accepts the documented values. *Mutant: bucket read from env without the contract check.*

**S1, unit: `t393-pg-args.test.ts`**

8a. `buildPgArgs('postgresql://u:s3cr3t@h:25060/db?sslmode=require', [...])`: **no argv element contains `s3cr3t`**, the connection string in argv has no password, and `env.PGPASSWORD === 's3cr3t'`. *Mutant: pass the URL through unchanged.*
8b. `assertDirectPort` refuses `:25061` and accepts `:25060` and `:5435`. *Mutant: check removed.*

**S1, integration: `t393-backup.test.ts`**

9. **Happy path.** `runBackup` writes exactly one `.dump`, one `.roles.sql` and one `.manifest.json` under `postgres/daily/<Manila date>/`. The manifest's sha256 and size match the file. The fingerprint lists both orgs, with debits = credits each. Heartbeat calls are `start`, `ok`. Red on HEAD (nothing exists).
10. **Same snapshot (I1).** With a hook between fingerprint and `pg_dump`, insert a balanced entry from another connection. The manifest does **not** include it, and restoring the dump (with plain `pg_restore`, no drill code) yields a trial balance equal to the manifest. *Mutant: compute the fingerprint in a separate transaction without `--snapshot`.*
11. **Manifest last (R3).** A store fake that fails the second `put`: no manifest exists, the exit is non-zero, heartbeat `fail`, and **no delete was called** (I3). *Mutant: prune before verify.*
12. **Corrupt archive (R6).** Truncate the dump file to **about 90%** of its size in the `afterDump` hook (the TOC survives, so `--list` alone passes): the full read fails, nothing is uploaded, and the run fails. *Mutant: keep only the `--list` check.*
13. **Bad credentials.** Source URL with a wrong password: the run fails, and the captured stdout, stderr and heartbeat reason do not contain that password (I9). *Mutant: the error is logged raw.* (The argv half is test 8a.)
14. **Heartbeat down.** The heartbeat throws on every call: the backup still succeeds with exit 0 (I8).
15. **Prune runs only on success.** Seed the store with 50 old dated dumps. A successful run deletes ≤10, and a failed run deletes 0.
15a. **Privilege and empty-ledger refusal (I11).** As a role with neither `rolbypassrls` nor `rolsuper`, the run is refused before `pg_dump` and writes no object. As a superuser against a database with orgs but zero journal lines, it is refused and writes **no manifest**. *Mutants: privilege check removed; empty-fingerprint check removed.*

**S2, integration: `t393-restore-drill.test.ts`**

16. **Round trip ties.** Backup, then drill: the result is ok, the report `postgres/drills/<date>.json` exists with durations, and the target database is gone afterwards. Red on HEAD.
17. **A changed balance fails.** Edit the stored manifest's figure for one account by 0.01 and re-upload (the sha256 is of the dump, so it still verifies). The drill fails and names the org and account. *Mutant: compare totals only, not per account.*
18. **A lost table fails.** Edit the manifest's row count for one non-ledger table: the drill fails naming it. *Mutant: row counts not compared.*
19. **Empty is not a tie (R9).** In setup, create a role with no `BYPASSRLS` and `GRANT SELECT` on every restored table to it, so RLS filters its rows instead of a permission error stopping it. Run the drill's check as that role: FORCE RLS hides every row. The check **fails** instead of reporting equal empties. *Mutant: remove the empty-set rule.*
20. **Checksum.** Flip one byte of the stored dump: the drill fails before restoring, and creates no database. *Mutant: skip the sha256 check.*
21. **Target guards (R10).** The targets `shareat_test` (the source), `shareat_prod`, `foo_drill`, and a pattern-valid name equal to the source's name on a **different** host are each refused **before any connection opens**. The source database still exists with its row counts unchanged, and a spy proves no connection to `sourceUrl` is ever opened. *Mutants: name check only on create, not on drop; source equality compared on host and database instead of name alone; the drill connects to the source.*
22. **No complete dump.** A store holding only a bare `.dump` with no manifest: the drill fails with "no complete dump". *Mutant: pick the newest key regardless of manifest.*
23a. **Sequences.** On the restored database, set one sequence below its column's `max()`: the check fails and names it. A sequence ahead of `max()` passes. *Mutants: check removed; equality instead of ≥.*
23. **History guards survive.** On the restored database, before it is dropped, an `UPDATE` of a posted `journal_entries` row is refused by its trigger. This proves the restore keeps the `ENABLE ALWAYS` guards, as the T-354 note claims.

## Smoke (§9.4)

**Locally, by the lane, with output in the hand-back:**

1. `npm run db-backup -- --store=fs:<scratchpad>/spaces` against a seeded `_test` database, then `npm run restore-drill -- --store=fs:<scratchpad>/spaces` into `shareat_test_drill_smoke`. Print the summary lines, the manifest (fingerprint truncated), the drill report and the durations.
2. Run step 1 three more times with `--now` faked across a month boundary. `ls` the fs store shows retention behaving.

**On production, by Ian (agents cannot SSH), after Q1 and Q2:** ship `docs/ops` as the README's
*FIRST* section says, re-run `provision.sh` (installs the client and the four units), then
`systemctl start shareat-db-backup.service` once and read `/var/log/shareat/db-backup.log`. Check
in the DO panel that the object is under `postgres/daily/` and that it is in `shareat-pg-backups`.
Check that the heartbeat shows green. Then `systemctl start shareat-restore-drill.service` once,
and arm both with `systemctl enable --now` and `systemctl is-enabled`/`is-active` per unit (never
`list-timers`, DEF-332). **The dump size and the restore duration from that first run go into
T-394's runbook.**

**Unmet locally, stated plainly:** the real Spaces multipart upload and the real heartbeat. The
`spacesStore` adapter is covered only by type and by the production first run. A
`--store=spaces --dry-run` mode lists `postgres/` and writes nothing, so Ian can prove the key
before the first real night.

## Out of scope

- Firebase Storage objects (receipt photos). ADR-002 §7 wants their own retention. The database
  holds only paths, so a perfect database restore still loses evidence if that bucket is lost. That
  is a separate task; the orchestrator logs it in `docs/CAPABILITY-GAPS.md` if no task owns it.
- Making wizard C1 `verified` (R14). The full cutover rehearsal on a temporary cluster is T-394.
- Encryption, a second region, WAL/PITR of our own (see *Not adopting*).
- The mailer finding beyond logging it.

## Rollout

S1 can merge and deploy before Q1 is answered: the script exists, but nothing runs it until Ian
puts the key in the env and arms the timer. Target from the plan: **nightly backups and one proven
restore by 31 Oct**, so that T-394 can rehearse on a restored copy by 13 Nov.

## Done when

- S1 and S2 are committed. Tests 1-23 (with 8a, 8b, 15a and 23a) are green, and every named mutant was shown red. The hosting
  guard is green with the two new pairs named.
- Typecheck is clean, the affected tests pass locally, and the full suite passes in CI (with the
  PGDG client step) on the wrap-up PR.
- The local smoke ran, with output in the hand-back.
- The hand-back carries a `FOR IAN` block with the exact production steps above, the five
  questions, and the facts-to-confirm list. The orchestrator moves plan C5 to *built, awaiting key* until Ian's first production
  run is green, then *done*.

## Questions for Ian

**Q1. Where should backups go, and with what key?**
Example: every night about 50-300 MB (measured on the first run) is written under `postgres/`.
- **(a) A new, dedicated bucket `shareat-pg-backups` (SGP1) that holds nothing else, and a new
  Spaces key limited to that bucket only.** You create both in DO and paste five lines into
  `/srv/shareat-shared/.env.local`: `SPACES_ENDPOINT=https://sgp1.digitaloceanspaces.com`,
  `SPACES_REGION=sgp1`, `SPACES_BUCKET=shareat-pg-backups`, `SPACES_KEY=…`, `SPACES_SECRET=…`.
  **Recommended.** Nothing on the droplet can then write to or delete the Frappe archive in
  `shareat-erp-backups`, which row 64 and ADR-002 (*"Do not delete them"*) require. The Spaces
  subscription covers all buckets (250 GiB shared), so this should cost nothing extra; verify on
  DO's price page. An agent may not handle the key.
- (b) The `postgres/` prefix inside `shareat-erp-backups`, as the plan said. A key that can prune
  backups could then also delete the Frappe archive. Not recommended.
- (c) No dump; rely on DO's built-in backups. Not recommended: same provider, never tested, and
  bible §15.8 and row 274 require more.

**Q2. When a backup fails, how should you find out?**
- **(a) A free "dead-man's switch" service (healthchecks.io).** It emails you when a night's
  "done" signal does not arrive, so it also catches a timer nobody armed or a droplet that is down.
  You make a free account, create two checks (backup: daily, 2 hours grace; drill: weekly, 1 day
  grace), and paste the two URLs into the env file as `BACKUP_HEARTBEAT_URL` and
  `DRILL_HEARTBEAT_URL`. **Recommended.**
- (b) A finding on `/findings` in the app. It needs a new table, and you only see it when you
  open the page.
- (c) Only the log file. ⚠️ Nothing on the box appears to send mail today, so in practice nobody
  would be told.

**Q3. Where does the weekly restore test run?**
- **(a) A throwaway database `shareat_restore_drill` on the production cluster, every Sunday at
  05:30.** It is created, checked and dropped automatically, and costs nothing extra. You paste
  one more line, `RESTORE_DRILL_DATABASE_URL=…`: a `doadmin`-class connection string (it needs
  `CREATEDB`) on port 25060, with the database name `shareat_restore_drill`.
  ⚠️ **While the test runs it needs free cluster disk about equal to the database size. If the
  cluster's disk fills up, POS and the ERP both stop.** The test logs the database size every week.
  Before arming it, check the cluster's disk graph in DO once and keep at least twice the database
  size free. **Recommended**, together with a one-off temporary cluster for T-394's rehearsal on
  13 Nov (about US$0.03 an hour, created and destroyed by you).
- (b) A temporary cluster every month (about US$0.05 each time). Truer to a real disaster and no
  disk risk to production, but it needs you, or a DO API token, every month, and a monthly human
  step is the kind of job that stops happening.
- (c) GitHub's CI machines. Free and automatic, but it copies payroll data to a third party. Not
  recommended.

**Q4. How long are backups kept?**
The plan said 30 days. ADR-002 §7 says *"long enough to cover a statutory period, not just a
week"*, and closed years matter for BIR.
- **(a) Every night for 35 days, one per month for 13 months, and one per year forever.**
  **Recommended.** About 47 files at a time.
- (b) A flat 30 days, as the plan said. Simpler, but a mistake found in February's books in April
  could not be traced back.
- (c) Keep everything forever. Storage grows without limit and nothing is gained over (a).

**Q5. Should each backup be encrypted before it leaves the droplet?**
Each file holds payroll and the PIN hashes. Example: if the Spaces key ever leaked, whoever had it
could download every night's copy and read it.
- **(a) Yes, with `age`.** The droplet encrypts with a public key. The private key is kept in two
  places: offline with you (printed, and in your password manager), and on the droplet in a file
  only the backup service can read, so the weekly test can prove the files still decrypt.
  **Recommended.** It protects against the likelier leak, a Spaces key or bucket setting. It does
  not protect against someone who takes over the droplet, but that person can already read the live
  database. ⚠️ If both copies of the private key are lost, every encrypted backup is unreadable.
- (b) No encryption; rely on the private bucket and the bucket-only key. Simplest, but a leaked
  key exposes everything.
- (c) Decide after cutover. The code ships with encryption off and one setting to turn it on.

**Facts Ian confirms (no decision, just a look in the DO panel):**
1. The production database name does **not** match `^shareat_(restore_drill|test_drill_[a-z0-9]+)$`.
2. `SYSTEM_DATABASE_URL` uses port **25060** (direct), not 25061 (the pooler).
3. DO's native backup retention for this cluster is **7 days**. The spec relies on that number.

**Q5 answered (Ian, 16 Oct):** no encryption of backup files. The bucket stays Private with a bucket-only key.

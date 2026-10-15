# Cutover runbook: the purge and the opening (31 Dec 2026 - 2 Jan 2027), and its rehearsals

> **T-394 S3.** Spec: `docs/tasks/394-purge-and-opening-rehearsal.md` (rulings R1-R13 are cited below as "R#"). Written
> 2026-10-15 against the S1+S2 tooling in the tree and the T-402 S3 audit-log dump on `lane/t402-s3` (NOT yet merged;
> see §0.1). **Durations are `TBD (S4)`** and are filled from the 13 Nov report. Owners are `TBD (t394-q2)` until Ian
> names them. **Frozen after the 18 Dec dress rehearsal (S5).**
>
> **Signed by Ian:** initials ______ date ______ *(typed by Ian, never by an agent)*

## 0. Read this first

### 0.1 Five rules that have already hurt, or would

| # | Rule | Why |
|---|---|---|
| 1 | **Never build on either droplet (DEF-238).** Production is **`159.223.46.224`** (`erp2.shareat.net`, `shareat-erp`). The old shared box is `159.223.78.207` (ERPNext + POS archive; this project never ran there). No `next build`, no compile, ever. Everything here runs scripts from the finished release or from Ian's PC | A build OOMs a 4 GB box in the middle of the cutover |
| 2 | **Close every psql, Drizzle Studio, DBeaver and pgAdmin window before `verify`.** `verify` reads the app's database role from `pg_stat_activity` and counts *every other session* as "the app". An open admin tool is counted as the app role (a bypass-RLS role makes `app_role` FAIL; a stray session can also make it PASS wrongly). The same open sessions make `start` and `purge` refuse (guard e) | The check proves RLS is on only if the only other sessions are the app's |
| 3 | **`--as-of YYYY-MM-DD` is mandatory with `--apply` and `--rehearse`** (R8, DEF-641). Use the **Manila** business date: `2027-01-01` for the real purge. A dry run may omit it (it then defaults to today's Manila date) | The date decides which tables the purge may touch; the old UTC default was yesterday before 08:00 Manila |
| 4 | **The audit-log dump folder must be locked down, and the purge locks `audit_log`.** `--dump-dir` (or `CUTOVER_DUMP_DIR`) is **required** with `--apply` and `--rehearse` and has no default. The dump holds every audit event (names, actions, ids). Exact ACL commands are in §1.3. While the purge compares `audit_log` to the dump it holds `LOCK TABLE audit_log IN SHARE ROW EXCLUSIVE MODE`: **any writer (the app, `firestore-relay`, any timer) waits or errors**. So the purge runs inside the cutover window with writers off (§3) | A row written after the dump would be erased unrecorded; the purge refuses if the count changed (`dump again, then run the purge`) |
| 5 | **Never run the purge against anything but the database named in the step.** Rehearsal: only `shareat_rehearsal_YYYYMMDD` on the temporary cluster. Production: the production database, typed back with `--confirm-database` | The purge cannot be undone except by restore |

✅ **T-402 S3 status.** Merged in release 2026-10-15: `--dump-dir`, the audit-log dump and the `audit_log` lock are in
`scripts/cutover-purge.ts` and `packages/db/src/cutover/purge.ts`, and `cutover:rehearse purge` passes `--dump-dir`
(CUTOVER_DUMP_DIR, else `<REHEARSAL_DIR>/<db>-auditdump`).

### 0.2 Who, and the people rule

Owners are named people, the same on rehearsal day and on 1 Jan (t394-q2 a). **Ian types the purge and the POST.**
No agent signs in for anyone or types a password, PIN or key.

| Role | Does | Name |
|---|---|---|
| Purge operator | Steps P1-P7, the POST (C5) | Ian `TBD (t394-q2)` |
| Opening-figures encoder | C3 money and party figures | `TBD (t394-q2)` |
| Store counters | Stock count per store (C3) | `TBD (t394-q2)`, one per store |
| Checker | `verify` runs, go/no-go tick sheet, evidence folder | `TBD (t394-q2)` |
| Mirror reset owner (DEF-643) | §3 step M1 | `TBD`: **unowned today**; name before freezing |
| Who to call | Ian · DigitalOcean support (database cluster) · `TBD` second phone | `TBD` |

### 0.3 The two environments

| | Rehearsal (13 Nov, 18 Dec) | Production (31 Dec - 2 Jan) |
|---|---|---|
| Database | `shareat_rehearsal_YYYYMMDD` on a **temporary DO cluster** Ian creates and destroys the same day (R1) | the production database on the production cluster |
| Where commands run | Ian's PC, repo root, `npm run ...` | the box `159.223.46.224`, inside the **release directory** (never `/srv/shareat`, DEF-330), as user `shareat` |
| Tool | `npm run cutover:rehearse` wraps the same `cutover-purge` | `npm run cutover:purge` directly |
| App | `npm run dev` on 9008, sign-in only (§1.2) | `shareat-erp` |
| DB string | `REHEARSAL_DATABASE_URL` (owner role, bypass RLS); the app uses `shareat_app_prod` | purge uses the **admin** string `SYSTEM_DATABASE_URL`; the app keeps its own |

## 1. Preparation (both environments)

### 1.1 Before the day

1. `git` checkout is the merged release; typecheck and CI are green. Do not build on a droplet.
2. T-402 S3 merged (§0.1). Migrations on `main` applied to production; `drizzle.__drizzle_migrations` count equals the journal entry count (ops README "THE CONSEQUENCE THAT WILL BITE").
3. `pg_dump` / `pg_restore` client at major version >= the server (production is 18.x). On the box it is `/usr/lib/postgresql/18/bin` (`PG_BIN_DIR`); on a Windows PC set `PG_BIN_DIR` to the folder that holds `pg_dump.exe`.
4. Every store that will count stock has a default room (`stock_locations.is_default`), every organisation has open fiscal periods (the `start` / `verify` check enforces it; run `npm run fiscal-period-seed` for an organisation that fails).

### 1.2 Rehearsal-only: the copy's app env (R11)

The app on the copy writes only to the copy. The env file the app uses must keep `FIREBASE_PROJECT_ID` and the three `NEXT_PUBLIC_FIREBASE_*` sign-in values, and have these **blank or absent**: `FIREBASE_SERVICE_ACCOUNT_KEY`, `FIREBASE_SERVICE_ACCOUNT_KEY_FILE`, `FIREBASE_STORAGE_BUCKET`, every `POS_API_*`; `SESSION_SECRET` differs from production's; no heartbeat URL. Check it:

```sh
npm run cutover:rehearse -- app-env-check --env-file <path-to-the-app-env-file>
```
Success: `app-env-check: pass (Firebase for sign-in only)`. Failure (exit 2): names the offending variables; blank them and re-run.

⛔ **On the copy: no `/terminal` URL, no device pairing, no PIN sign-in, ever.** The terminal page writes straight to production Firestore with the public config; a test punch would land in production's inbox. `verify` and `report` fail if any `clock_terminals` row changed or any `attendance_punches` row was inserted after `start`.

### 1.3 The folders (restrictive access). File modes do nothing on Windows

Two folders hold sensitive material: the **audit-log dump** (`--dump-dir`) and, in rehearsals, **`REHEARSAL_DIR`** (journal and full report name people, stores and amounts; it must be outside the repo). The code creates them `0700` and files `0600`, but **on Windows those modes are no-ops, so set the access list yourself, before the run.**

**Windows (Ian's PC, PowerShell)** : only your own account may read or write; inheritance removed:
```powershell
$d = 'C:\shareat-cutover\dump'          # use the same pattern for C:\shareat-cutover\rehearsal
New-Item -ItemType Directory -Force $d | Out-Null
icacls $d /inheritance:r
icacls $d /grant:r "${env:USERNAME}:(OI)(CI)F"
icacls $d                                # must list ONLY your account (and nothing like Users, Everyone, Authenticated Users)
```
Success: the last command lists one line, your account with `(OI)(CI)(F)`. If `BUILTIN\Users` or `Everyone` is still listed, run `icacls $d /remove "Users" "Everyone" "Authenticated Users"` and look again. `SYSTEM` and `Administrators` may remain only if you accept them; the preferred state is your account alone.

**Linux (the box)** : create and lock **before** the run (the code also chmods, but do not rely on it):
```sh
sudo install -d -m 700 -o shareat -g shareat /srv/shareat-shared/cutover-dump
ls -ld /srv/shareat-shared/cutover-dump      # must read drwx------ shareat shareat
```
After the run: `ls -l /srv/shareat-shared/cutover-dump` shows the `.dump` and `.dump.sha256` as `-rw-------`. Copy the folder off the box to the evidence store; never leave the only copy on the box that is being cut over.

Then, in the shell that runs the purge: `CUTOVER_DUMP_DIR=<that folder>` (the rehearsal tool passes it to its purge children as `--dump-dir`; if unset it uses `<REHEARSAL_DIR>/<database>-auditdump`).

## 2. The rehearsal (13 Nov mock, 18 Dec dress; spec S4/S5)

Run from Ian's PC at the repo root. `<db>` is `shareat_rehearsal_YYYYMMDD`. Every `cutover:rehearse` subcommand needs `--confirm-database <db>`. Exit codes: **0 pass, 1 a check failed (named), 2 refused by a guard.** Time each human step with `mark` (§2.3).

### 2.1 The copy and the environment

| # | Step | Command / action | Success looks like | If not |
|---|---|---|---|---|
| R1 | Create the copy (Ian) | DO panel: **fork** the production cluster (keeps roles; preferred when T-393 is off), or restore the T-393 dump with ops README "Restoring for real" steps 1-5 (grants kept, no `--no-acl`) | A new cluster with a different **host** from production's | A restore with `--no-acl` leaves the app role unprivileged: redo it with grants |
| R2 | Rename the database | from `defaultdb` on the new cluster: `ALTER DATABASE <old name> RENAME TO shareat_rehearsal_YYYYMMDD;` | `\l` lists the new name | Rename fails with "being accessed": close all sessions first |
| R3 | Environment | set in the shell: `REHEARSAL_DATABASE_URL` (owner role, direct port 25060), `REHEARSAL_DIR`, `CUTOVER_DUMP_DIR`, `PG_BIN_DIR`. **Do not** point `DATABASE_URL` at the copy | `echo` shows the three folders; `DATABASE_URL` still names your local DB | A refusal later naming "production database host" or "same host and database" means a URL is wrong: stop |
| R4 | Stop the 9008 app | close the dev server window | no session on the copy | `start`/`purge` refuse with the other session's `application_name`: find and close it |
| R5 | `start` | `npm run cutover:rehearse -- start --confirm-database <db>` | `start: pass (guards, no other session, fiscal periods cover the opening and the seed horizon)` | Exit 2: read the refusal (name pattern, host, typed name, another session, role does not bypass RLS). Exit 1 `fiscal-period coverage is missing`: run `npm run fiscal-period-seed` against the copy for the named organisation, then `start` again |
| R6 | `migrate` (timed) | `npm run cutover:rehearse -- migrate --confirm-database <db>` | `migrate: pass`; child runs `db:migrate` against the copy only | A pre-flight RAISE on real data (e.g. 0194's cross-org check) is the point of the rehearsal: record it, fix in code, re-run from R1 on a fresh copy |
| R7 | `predump` (timed) | `npm run cutover:rehearse -- predump --confirm-database <db>` | `predump: pass (dump and manifest written)`; the dump is under `REHEARSAL_DIR\<db>-predump` | `no manifest`: read the child output (usually `pg_dump` older than the server) |
| R8 | `purge` (timed) | `npm run cutover:rehearse -- purge --by <personId> --confirm-database <db>` | the child `cutover:purge` runs **three times**: dry run, `--rehearse --as-of 2027-01-01`, `--apply --as-of 2027-01-01 --by <id>`; ends `purge: pass (dry run, rehearse, apply; post-conditions hold)` | Child exit 1: read §5 for that child's message. A second session appearing between children makes it refuse (exit 2): close it, then **restore from R1**: a half-run on the copy is not a rehearsal. `--by` takes one person per organisation; for two organisations set `CUTOVER_PURGE_BY=<id1>,<id2>` instead (the rehearsal's `--by` carries one id) |
| R9 | Check the app env | `app-env-check --env-file <file>` (§1.2) | pass | blank the named variables |
| R10 | `start` again | as R5 | pass (journal re-opened; no other session) | as R5 |

> The spec's R4/S4 run order is `start, migrate, purge, stop the app, app-env-check, start, migrate, predump, purge`. The tool allows `purge` only after `start` and requires the journal; the order above (migrate, predump, then purge) is the one the tool's own sequence needs (`predump` must precede `purge` so the rollback path is rehearsed on the pre-purge state, R12). Ian confirms the final order at S4.

### 2.2 The opening, in the app, with real people

1. Start the app on the copy: `npm run dev` (port **9008**) with the §1.2 env, from Ian's PC. Each person signs in **with their own credentials, typed by them**.
2. `npm run cutover:rehearse -- mark B3 start --by <id> --confirm-database <db>` ... then the people do the wizard steps; `mark <step> end`.
3. Steps timed: **C3** (opening figures and Lipa's test count; a count typed on the copy never exists in production because `opening_counts` is KEEP), **C3P** (party balances agree with v1's aged lists), **C4** (3900 nets to zero and every register ties), **C5** (trial balance ties, then POST). Mark each `start` and `end`.
4. After C4, **before C5**: `npm run cutover:rehearse -- verify --confirm-database <db>`. Success: `PASS` lines for `fiscal_coverage`, `sequences_reset`, `app_role`, `tie_out`, `terminal_activity`, then `verify: pass`. The app must be running and **no other session** (psql, Studio) open (rule 2).
5. Ian POSTs C5. Then `npm run cutover:rehearse -- verify --after-post --confirm-database <db>`. Success: `PASS opening_set`, `c2_c5_recorded`, `freeze`, `tie_out`, `terminal_activity`.
6. Smoke in the app: sales day screen, trial balance, one payroll preview. Mark `smoke start/end`.

### 2.3 Timing a human step

```sh
npm run cutover:rehearse -- mark <STEP> start --by <personId> --confirm-database <db>
npm run cutover:rehearse -- mark <STEP> end   --by <personId> --confirm-database <db>
```
`mark X end` prints the duration in seconds; a step with no end is reported `NOT TIMED`. Step codes: `B3`, `C3`, `C3P`, `C4`, `C5`, `smoke`, `rollback` (1-32 chars, `A-Z a-z 0-9 _ . -`).

### 2.4 Proving rollback, report, destroy

| # | Step | Command | Success | If not |
|---|---|---|---|---|
| R11 | Restore the predump into a **second** database on the temporary cluster (named `shareat_rehearsal_YYYYMMDD`-pattern with a different date digit, so it passes the same guards) | follow ops README "Restoring for real" steps 2-5 with `<REHEARSAL_DIR>\<db>-predump\*.dump` | `pg_restore` exits 0 | missing roles/grants: replay `.roles.sql` first |
| R12 | `rollback-check` (timed `rollback`) | `$env:RESTORED_URL='<url of the second db>'` then `npm run cutover:rehearse -- rollback-check --against RESTORED_URL --confirm-database <db>` | `rollback-check: pass (restored fingerprint equals the dump manifest)` | A named row-count or trial-balance difference: the restore is wrong; **this blocks the 15 Nov go**. `--against` that equals the target or fails a guard exits 2 |
| R13 | `report` | `npm run cutover:rehearse -- report --confirm-database <db>` | `report: written`; sanitised file under `docs/reviews/`, full one under `REHEARSAL_DIR` (never committed) | `checks not run: ...` : run the missing `verify` / `verify --after-post` first. `a terminal was touched after start`: **no-go**, find who used `/terminal` |
| R14 | Destroy the copy (Ian) | DO panel: destroy the temporary cluster and the second database; delete `REHEARSAL_DIR` and the dump folder | Ian confirms it is gone; the report records the destroy | The copy holds production PII: it must not outlive the day |
| R15 | Fill durations | copy the report's seconds into the `TBD (S4)` cells below | | |

## 3. Production: 31 Dec 2026 - 2 Jan 2027

Times are Manila (`Asia/Manila`). Durations `TBD (S4)`. Evidence goes in one dated folder (screenshots of each success line, the audit-log dump, the pinned backup's key, the three purge reports in `docs/reviews/cutover-purge-2027-01-01.md`).

**Freeze (R13, t394-q3 a):** from the close of business on 31 Dec until C5 is posted, **staff enter nothing in v2.** v1 stays the book of record. `verify --after-post` is not run on production by the rehearsal tool, so the Checker lists any non-`opening_balance` journal entry created after the purge by looking at the Journal screen sorted by created time; any such entry is a breach to record and decide on (reverse by entry), never to ignore.

### 3.1 31 December (eve)

| Time | Step | Owner | Command / screen | Duration | Evidence | Checkpoint |
|---|---|---|---|---|---|---|
| `TBD` | **E1** Stop entries; announce the freeze | `TBD` | message to stores | n/a | the message | stores confirm they use v1 only |
| `TBD` | **E2** Final nightly backup is green | Checker | `/var/log/shareat/db-backup.log` last line; object under `postgres/daily/<date>/` has `.dump` **and** `.manifest.json` | n/a | log line, key | no manifest = unfinished: run `sudo systemctl start shareat-db-backup.service` and read the log |
| `TBD` | **E3** Pin the cutover-eve dump | Ian | in the DO Spaces panel copy that night's `.dump`, `.manifest.json` and `.roles.sql` to `postgres/pinned/<date>/` (no script does this; `postgres/pinned/` is never pruned, T-393 R4). Note the dump's sha256 from the manifest | `TBD (S4)` | the three keys | keys exist under `pinned/` |
| `TBD` | **E4** Last restore drill | Checker | `sudo systemctl start shareat-restore-drill.service`; read its log | `TBD (S4)` | drill report `postgres/drills/<date>.json` | trial balance equals the manifest. **Wizard step C1 is a tick that quotes this report's name (t394-q5 a).** Fails: no-go until fixed |
| `TBD` | **E5** Counts done, C3 drafting started | counters, encoder | `/cutover/count` per store | `TBD (S4)` (scale Lipa's time by four stores) | wizard shows counts | every item has a number (an empty shelf is a typed zero) |
| `TBD` | **E6** Go/no-go meeting (§4) | Ian | the tick sheet | | signed sheet | **no-go = stay on v1, new date 1 April 2027 (ADR-005)** |

### 3.2 1 January (the purge and the opening)

Do P1-P7 as one sitting. The box commands below run **from the release directory**, as `shareat`, with **only** the explicit database string; the purge never uses the app's non-bypass role (it refuses).

```sh
RELEASE="$(ls -1dt /srv/shareat-releases/*/ | head -1)"; echo "$RELEASE"   # eyeball: the release you mean (DEF-330)
cd "$RELEASE"
SYSTEM_DB_URL="$(grep -m1 '^SYSTEM_DATABASE_URL=' /srv/shareat-shared/.env.local | cut -d= -f2-)"; SYSTEM_DB_URL="${SYSTEM_DB_URL%$'\r'}"
export PG_BIN_DIR=/usr/lib/postgresql/18/bin NODE_ENV=production   # NODE_ENV is needed (DEF-634)
```
(`sudo -u shareat env ...` per the ops README pattern when not already that user.) `<prod-db>` below is the production database name taken from `SYSTEM_DB_URL`; `--yes-really-not-local` is required because the host is not localhost. `--by` takes **one person id per organisation** (comma-separated, or `CUTOVER_PURGE_BY`).

| Time | Step | Owner | Command / screen | Duration | Evidence | Checkpoint |
|---|---|---|---|---|---|---|
| `TBD` | **P1** Disarm journal-writing timers (R13) | Ian | §3.3 | `TBD (S4)` | each `is-enabled` = `disabled` | all listed units disabled **and** stopped |
| `TBD` | **P2** Stop the app | Ian | `sudo systemctl stop shareat-erp` ; `systemctl is-active shareat-erp` | | `inactive` | no app session (the purge locks `audit_log` and truncates; any writer waits or errors) |
| `TBD` | **P3** Close every admin session | Ian | close psql, Studio, DBeaver | | | `select count(*) from pg_stat_activity where datname=current_database() and backend_type='client backend'` is 1 (yours) |
| `TBD` | **P4** Dry run | Ian | `DATABASE_URL="$SYSTEM_DB_URL" npm run cutover:purge -- --confirm-database <prod-db> --yes-really-not-local` | `TBD (S4)` | the printed plan + `docs/reviews/cutover-purge-<date>.md` | `**DRY RUN, nothing was changed.**`; read the plan: purge tables, date-scoped, keep-shell, kept tables; deferred `notBefore` list |
| `TBD` | **P5** Rehearse (always rolls back) | Ian | same line plus `--rehearse --as-of 2027-01-01 --dump-dir /srv/shareat-shared/cutover-dump` | `TBD (S4)` | `Audit log dumped: ... sha256 ...` and the Result | `Rehearsal passed. ... nothing was kept.` Fails: §5 |
| `TBD` | **P6** Apply | Ian | same line with `--apply --as-of 2027-01-01 --by <id1>,<id2> --dump-dir /srv/shareat-shared/cutover-dump` instead of `--rehearse` | `TBD (S4)` (> 15 min means add a maintenance window, spec risk 2) | `Purge committed. All post-conditions passed inside the transaction.` and the dump's sha256 (also recorded in the `cutover.purge` event) | **Point of no return for the data (R12) is C5, not this step**, but from here v2 is empty until C3-C5. Fails: §5, then §6 rollback |
| `TBD` | **P7** Copy the audit-log dump and the three reports off the box | Ian | see §1.3 | | files in the evidence folder; `.dump.sha256` matches | the dump is not left only on the box |
| `TBD` | **M1** Reset the Firestore mirror (DEF-643) | **owner TBD** | **No tool exists today**: after the purge the mirror still holds pilot documents and the clock terminals would show stale state. Decision needed before this runbook is frozen: either a mirror re-publish step after POST, or a purge leg in `packages/domain/sync` | | | not signed until an owner and a command exist |
| `TBD` | **P8** Start the app | Ian | `sudo systemctl start shareat-erp`; `curl -s -o /dev/null -w '%{http_code}' https://erp2.shareat.net/sign-in` | | `200` | sign-in 200 |
| `TBD` | **C3** Enter opening balances | encoder, counters | wizard `/cutover` | `TBD (S4)` | wizard step state | every store's figures entered |
| `TBD` | **C3P** Party balances agree with v1's aged lists | Checker | wizard | `TBD (S4)` | | per-party agreement |
| `TBD` | **C4** 3900 nets to zero and every register ties | Checker | wizard | `TBD (S4)` | | ties |
| `TBD` | **Pre-POST check** | Checker | the wizard's own tie-out for every store (the rehearsal tool refuses production, so there is no scripted `verify` here; Appendix B item 3) | | screenshot | every line ties |
| `TBD` | **C5** Trial balance ties, then **POST** | **Ian** | wizard | `TBD (S4)` | posted opening entries (figures + one inventory entry per store) | **POINT OF NO RETURN.** After this: forward-fix only by reversing entries, never a restore |
| `TBD` | **P9** Re-arm timers (R13) | Ian | §3.3 (re-arm column) | | each `is-enabled` = `enabled` and `is-active` = `active` | every timer disarmed in P1 is back |

### 3.3 Timers (disarm after the app is stopped, re-arm after C5)

Derived from `docs/ops/*.timer`, not typed from memory. Regenerate the list the morning of 31 Dec:
```sh
ls /etc/systemd/system/shareat-*.timer          # compare against docs/ops/*.timer in the release
```
**Disarm (P1):**
```sh
for t in attendance-sweep budget-reissue finding-observation firestore-relay month-end month-end-retry order-wastage-backstop orphan-file-sweep recurring-expense-draft; do
  sudo systemctl disable --now shareat-$t.timer
  echo "$t: $(systemctl is-enabled shareat-$t.timer 2>&1) / $(systemctl is-active shareat-$t.timer 2>&1)"
done
```
Success: every line reads `disabled / inactive`. (`db-backup` and `restore-drill` stay as they were; the T-396 morning POS-import timer is **not in `docs/ops/` yet**: add it to this list when its unit lands, and check with `ls docs/ops/*.timer` on 31 Dec.) **Keep `shareat-fiscal-period-seed.timer` armed**: it runs 1 Jan 04:00 and keeps periods ahead; do not stop a job whose absence causes DEF-585.
**Re-arm (P9)**, same list, `sudo systemctl enable --now shareat-$t.timer`; never `list-timers` as the check (DEF-332); read `is-enabled` and `is-active`. `--now` is not optional.

### 3.4 2 January

| Time | Step | Owner | Command / screen | Duration | Evidence | Checkpoint |
|---|---|---|---|---|---|---|
| `TBD` | **D1** Stores trade on v1 as before; v2 entries stay frozen until C5 is posted and verified | stores | | | | |
| 06:00 | **D2** First-day check: the POS import lands in the new books | Checker | Sales Days screen for 1 Jan and 2 Jan; the import timer's last-run line (T-396, once installed) | | | figures present, dated 2027; first document numbers are **1** for each reset sequence |
| `TBD` | **D3** Rollback deadline check | Ian | §6 | | | C5 posted **by 5 Jan** (t394-q4 a) or go back to v1 |
| `TBD` | **D4** Sign off the day | Ian | tick sheet | | | done |

## 4. Go / no-go checklist (E6, and again before P6)

All must be **yes**; any **no** means stay on v1 until 1 April 2027 (ADR-005), unless Ian rules a re-run window (§6).

- [ ] The 13 Nov and 18 Dec rehearsal reports exist, every step timed or named `NOT TIMED` / `UNREHEARSED`, every check pass, the copy destroyed.
- [ ] `rollback-check` passed on 13 Nov **and** 18 Dec (the restored predump equals its manifest).
- [ ] T-402 S3 merged; `--dump-dir` accepted by the production purge on a `--rehearse` run; the dump folder ACL verified (§1.3).
- [ ] Last nightly backup has a manifest; cutover-eve dump pinned under `postgres/pinned/`; restore drill green this week (C1).
- [ ] Release deployed is the one rehearsed: `drizzle.__drizzle_migrations` count equals the journal; no migration newer than the 18 Dec rehearsal.
- [ ] Every organisation has an open fiscal period for 2027-01 and coverage through the seed horizon.
- [ ] Every store has counted; every item has a number; party figures agree with v1's aged lists (C3P).
- [ ] Timers list built from `docs/ops/*.timer` this week; each disarm and re-arm tried on the 18 Dec rehearsal box or noted.
- [ ] No admin tool sessions open (P3); app stopped (P2).
- [ ] `--as-of 2027-01-01` and one `--by` per organisation ready; production database name confirmed against `SYSTEM_DB_URL`.
- [ ] Mirror reset owner (DEF-643) named, with a tested command.
- [ ] People named, reachable, with the who-to-call line filled.

## 5. When a step fails

| Where | Message | Meaning | Do |
|---|---|---|---|
| purge | `REFUSED. --apply and --rehearse need an explicit --as-of` | missing date | add `--as-of 2027-01-01` |
| purge | `REFUSED. --apply and --rehearse need --dump-dir ...` | T-402 S3 rule | give a locked folder (§1.3) |
| purge | `REFUSED. --apply needs --by <personId>, once per organization` / `No --by person for organization(s)` | an organisation has no performer | add the missing id; nothing was changed |
| purge | `--by <id> is not a person in this database` | typo | fix the id |
| purge | `You typed "X" but this connection is to "Y"` / `not localhost` | ceremony | retype the real name; add `--yes-really-not-local` |
| purge | `The audit log could not be dumped` / `dump is incomplete` / `holds N row(s) but the dump holds M` | pg_dump missing or too old, or a writer wrote after the dump | check `PG_BIN_DIR`, version; stop writers (P1-P3); run P5 again (it re-dumps); nothing was changed |
| purge | `tool role does not bypass RLS` / engine refusal | wrong database string | use `SYSTEM_DB_URL` (admin), never the app string |
| purge | any post-condition error | the transaction rolled back: **nothing changed** | read the line; if a code bug, stop and call; the database is as before |
| rehearse tool | `another session is connected` | open Studio/psql/app | close it; on the copy, restore if a child already ran |
| rehearse tool | `post-purge checks failed` | counts or trial balance off | do **not** continue to C3; record and restore the predump (§6) |
| verify | `FAIL app_role` | no app connected, or app role bypasses RLS, or an admin tool is open | start the app, close admin tools (rule 2), re-run |
| verify | `FAIL tie_out` | an opening line does not tie | the wizard names the store and code; fix the entry before POST |
| verify --after-post | `FAIL freeze` | an entry other than `opening_balance` created after the purge | find it, record it, reverse it by entry |
| verify/report | `FAIL terminal_activity` | `/terminal`, pairing or a PIN was used on the copy | rehearsal invalid: restore and repeat |
| nothing posted by the deadline | | C5 not posted by 5 Jan | §6 |

## 6. Rollback

**Rule (R12, t394-q4 a): before C5 is posted, v1 is the book of record.** v1 keeps running in parallel, so the stores lose nothing.

| Situation | Action |
|---|---|
| Purge refused or rolled back | nothing changed; fix and re-run P4-P6 |
| Purge committed, a problem found **before C5** | **Never restore over the live database.** Restore the pinned pre-purge dump into a **new** database (ops README "Restoring for real" steps 1-7: sha256 check, `.roles.sql`, `pg_restore --no-owner --exit-on-error --single-transaction` **without** `--no-acl`, grants, fingerprint compare), switch `DATABASE_URL` and `SYSTEM_DATABASE_URL`, restart `shareat-erp`, fix, re-run C2-C5. Counts are as at 31 Dec, so a re-run within days is honest. The audit-log dump is the record of the pilot's events |
| C5 not posted by **5 Jan** | stay on v1 for Q1; the new date is **1 April 2027** (ADR-005) |
| **After C5** | **Forward-fix only**, by reversing entries. **No restore:** January's real entries would be lost |

Time the restore once (`mark rollback`) on 13 Nov; its duration is this runbook's RTO: `TBD (S4)`.

## Appendix A. Commands and flags: where each is defined (verified by reading the source)

| Command / flag | Defined at |
|---|---|
| `cutover:purge`, `cutover:rehearse`, `db-backup`, `restore-drill` npm scripts | `package.json:32,33,54,55` |
| `--confirm-database` | `scripts/cutover-purge.ts:62,137` |
| `--apply`, `--rehearse` (cannot combine) | `scripts/cutover-purge.ts:63,64,115` |
| `--as-of` mandatory with `--apply`/`--rehearse`; dry run defaults to Manila date | `scripts/cutover-purge.ts:56-57,66-72,120` (DEF-641) |
| `--by` one per organisation; `CUTOVER_PURGE_BY` | `scripts/cutover-purge.ts:73-79,125,186-215` |
| `--yes-really-not-local` | `scripts/cutover-purge.ts:65,145` |
| `CUTOVER_PURGE_REPORT_DIR` (report folder; the rehearsal sets it to `REHEARSAL_DIR`) | `scripts/cutover-purge.ts:242`; `scripts/lib/rehearsal/children.ts:82` |
| `--dump-dir`, `CUTOVER_DUMP_DIR`, dump + sha256 + `lock table audit_log in share row exclusive mode` + count compare | **`lane/t402-s3` only:** `scripts/cutover-purge.ts:48,76,84,105-107,139,238`; `packages/db/src/cutover/purge.ts:356-462,546-560` (dir `0700`, files `0600` at `:375,377,453`; `PG_BIN_DIR` at `:357-360`) |
| `start`, `migrate`, `predump`, `purge --by`, `mark <step> start\|end [--by]`, `app-env-check --env-file`, `rollback-check --against <ENV>`, `verify [--after-post]`, `report [--out-dir]` | `scripts/cutover-rehearsal.ts:135,143,155,185,194,210,253,277,324,395` |
| Exit codes 0/1/2 | `scripts/cutover-rehearsal.ts:58-71,420-429` |
| Guards: name `^shareat_rehearsal_[0-9]{8}$`, pinned host, `REHEARSAL_DATABASE_URL` only, `PRODUCTION_DB_HOSTS` (adds only), typed name | `scripts/lib/rehearsal/guards.ts:133-135,147-150,165-172,185-200,205-216` |
| Liveness (no other session), bypass-RLS role | `scripts/lib/rehearsal/checks.ts:24-39` |
| Fiscal coverage (DEF-585, R6) | `scripts/lib/rehearsal/checks.ts:59-90`; `cutover-rehearsal.ts:161,176` |
| `verify` reads the app role from `pg_stat_activity`; counts every other session | `scripts/lib/rehearsal/verify.ts:17-30` |
| Child env: database URLs replaced by the target, `SPACES_*`/heartbeat/service-account/`POS_API_*` blanked | `scripts/lib/rehearsal/children.ts:33-50` |
| Purge child runs three times (dry, `--rehearse --as-of`, `--apply --as-of --by`); liveness before each | `scripts/lib/rehearsal/children.ts:83-93` |
| `migrate` child = `npm run db:migrate`; `predump` child = `npm run db-backup -- --store=fs:<dir>` | `children.ts:100,106` |
| `REHEARSAL_DIR` outside the repo; journal and full report `0700`/`0600` | `scripts/lib/rehearsal/journal.ts:42-49,59-70` |
| `app-env-check` forbidden names | `scripts/lib/rehearsal/app-env.ts:4-8` |
| `db-backup --store=fs:`, `--production`, `--dry-run` | `scripts/db-backup.ts:8-10` |
| `PG_BIN_DIR` | `scripts/lib/backup/pg-tools.ts:13-15` |
| Timers and their schedules | `docs/ops/shareat-*.timer` (`OnCalendar`); jobs list `docs/ops/README.md` "The jobs" |
| Wizard steps C1, C2, C3, C3P, C4, C5 | `packages/domain/src/cutover/steps.ts:116-169` |
| Restore procedure; migrations must use the admin string; release dir not `/srv/shareat` | `docs/ops/README.md` "Restoring for real", "THE CONSEQUENCE THAT WILL BITE" |
| `postgres/pinned/` never pruned | `docs/tasks/393-nightly-backup-and-restore.md` R4, I5 |

## Appendix B. Mismatches between the spec and the scripts (do not paper over)

1. **`--dump-dir` / audit-log dump / `audit_log` lock are not in this branch.** Spec S3 text and the handoff assume them; they live on `lane/t402-s3` (unmerged, open audit findings). The runbook is written for after the merge (§0.1).
2. **RESOLVED (2026-10-15).** The rehearsal tool now passes `--dump-dir` to its `--rehearse` and `--apply` children (`scripts/lib/rehearsal/children.ts`, `runPurgeChildren`'s `dumpDir`). `cutover:rehearse purge` uses `CUTOVER_DUMP_DIR` if set, else `<REHEARSAL_DIR>/<database>-auditdump`. Its post-purge check `purge_tables_empty` accepts the `cutover.*` events the purge writes into `audit_log` after truncating it (T-402 R15) and fails on any other row.
3. **The rehearsal tool refuses production** (guards pin the production host); spec §5.2 lists "`cutover-purge` dry run, `--rehearse`, `--apply` on production" only for the plain CLI, which is what §3.2 uses. There is **no scripted `verify` for production**: the wizard's own checks stand in (the tool can only be pointed at a `shareat_rehearsal_*` database).
4. `cutover:rehearse purge --by` takes **one** id (`flagValue`, `cutover-rehearsal.ts:211`); an organisation count above one on a rehearsal needs `CUTOVER_PURGE_BY`, which the child inherits.
5. Spec §5.2 asks for the "journal-writing timers" list built from `SCHEDULER_JOBS` and the systemd units; **no T-396 morning-import timer exists in `docs/ops/` yet**, so it cannot be listed. §3.3 says to add it when it lands.
6. **DEF-643 (Firestore mirror reset): no command and no owner exist.** Step M1 is a placeholder and blocks signing.
7. **Pinning the cutover-eve dump** (`postgres/pinned/`) has no script; it is a manual copy in the DO panel (§3.1 E3).
8. Spec R2 says the app on the copy runs "from Ian's machine in development mode"; there is no script that starts it. §2.2 gives `npm run dev` on 9008 with the §1.2 env file.

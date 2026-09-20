# 37 — T-329 Tier E: what calls each of the 29 files in `scripts/`

> **Enumeration first, then Ian's ruling.** The DELETE / KEEP / UNKNOWN column was a recommendation
> for Ian to rule on, per T-329 Tier E ("ASK, NEVER DELETE") and bible §1.2. **Ian ruled on
> 2026-09-20** (relayed by the orchestrator): one file deleted, every other verdict stands — see
> "Ian's ruling" at the end. Written 2026-09-20 by lane `webapps-9f` (Fable) against `main` at
> `10503af`.
>
> ⚠️ **Count correction:** `scripts/` holds **30 files**, not the "~29" `docs/HANDOFF-TODAY.md` §9
> and the T-329 spec say. The handoff counted `lib/` as one directory entry (28 files + `lib/` = 29
> entries) where `lib/` holds two files. After the ruling: **29 files** (28 + 2 − `daily-review.cmd`).

## Method, in the order it was done

1. **Read the installed units on the production host first** (`159.223.46.224`,
   `shareat-system-prod`), not the repo. Read-only: `ls /etc/systemd/system`, `cat` of every
   `shareat-*` unit, `systemctl list-timers --all`, `systemctl list-unit-files 'shareat-*'`,
   `/etc/cron.d`, both crontabs, `/root/shareat-ops`, `/usr/local/bin`, `/srv` layout,
   `/var/log/shareat`.
2. Read the **deployed** `package.json` scripts block from `/srv/shareat` and diffed it against the
   repo's. **Identical** (the DEF-326 gap is closed; the artifact carries every entry point).
3. Read `.github/workflows/ci.yml` and `deploy.yml` for every `npm run` and `scripts/` mention, and
   the deploy tarball's `PATHS` (line 100: `scripts` is shipped whole).
4. For each file: grepped the exact path `scripts/<file>` and the exact `npm run <name>` across the
   repo (excluding `node_modules`, `.next`, `.git`, `*.tsbuildinfo`), then **read the file's header
   and import list**, and read the unit tests that scan `scripts/` to see which would go red on a
   deletion.
5. For `daily-review.cmd`, whose only possible caller is Windows Task Scheduler on this machine,
   queried Task Scheduler directly.

⭐ **Every row says READ or GREPPED.** A grep can show that a name appears; only a read shows an
enclosing call. Where the verdict rests on the host, the row cites the unit.

## The host, as measured (2026-09-20 ~06:50 UTC)

**Every scheduled unit invokes `npm run <name>` from `/srv/shareat`** (WorkingDirectory, User=shareat).
No unit names a `scripts/` path directly, so the unit → file mapping goes through `package.json`,
which is why the deployed block was diffed. ⭐ **The real coupling is therefore the `package.json`
scripts block, not the filenames: renaming or re-pointing a script entry breaks a production timer
without touching any file the timer mentions, and no in-repo gate compares the two.** Installed units in `/etc/systemd/system` are
byte-identical to `/root/shareat-ops/` (all 18 `cmp` same). No cron entries belong to this project.

| Unit (timer enabled) | ExecStart | Log last written | Last line |
|---|---|---|---|
| `shareat-attendance-sweep` | `npm run attendance-sweep` | 2026-09-20 06:00 | `ok — closed 0 · 1 orgs` |
| `shareat-budget-reissue` | `npm run budget-reissue` | 2026-09-19 19:30 | `ok — created 0 · 1 orgs` |
| `shareat-finding-observation` | `npm run finding-observation` | 2026-09-19 17:30 | `ok — opened 0 · 1 orgs` |
| `shareat-firestore-relay` | `npm run firestore-relay` | 2026-09-20 06:50 (every 2 min) | `ok — mirror 0 · inbox 0 · 2 outcomes` |
| `shareat-month-end` (+ `-retry`) | `npm run month-end` | 2026-09-14 19:00 | `ok — posted 0 · 2 outcomes` |
| `shareat-order-wastage-backstop` | `npm run order-wastage-backstop` | 2026-09-19 18:30 | `ok — closed 0 · 1 orgs` |
| `shareat-orphan-file-sweep` | `npm run orphan-file-sweep` | 2026-09-19 19:00 | `ok — removed 0 · 1 orgs` |
| `shareat-recurring-expense-draft` | `npm run recurring-expense-draft` | 2026-09-19 18:00 | `ok — drafted 0 · already drafted 0 · 1 orgs` |
| `shareat-erp` (service) | `npm run start` in `apps/erp` | — | not a `scripts/` file |

The log directory is the **second measurement**: eight logs, eight units, eight scripts, all
exiting `ok` on their last run. The unit files and the logs agree.

## The table

Columns: **Caller** = what invokes it (host unit · CI · test · runbook · another script · none
found) · **How** = READ (file and caller read) or GREPPED (name matched only) · **Verdict**.

### Invoked by a production systemd timer — KEEP (8)

| File | Caller | How | Verdict · reason |
|---|---|---|---|
| `attendance-sweep.ts` | `shareat-attendance-sweep.timer` (hourly) · `tests/unit/scheduler-jobs-have-callers.test.ts` | READ unit, log, header | **KEEP** — runs hourly on prod; the unit test also fails if the caller vanishes |
| `budget-reissue.ts` | `shareat-budget-reissue.timer` · same test | READ | **KEEP** — nightly on prod |
| `finding-observation.ts` | `shareat-finding-observation.timer` · same test | READ | **KEEP** — nightly on prod |
| `firestore-relay.ts` | `shareat-firestore-relay.timer` (every 2 min) · same test | READ | **KEEP** — the attendance inbox/outbox; 2.7 MB of log says it runs |
| `month-end.ts` | `shareat-month-end.timer` + `-retry.timer` · same test · `docs/ops/README.md:302` | READ | **KEEP** — monthly on prod |
| `order-wastage-backstop.ts` | `shareat-order-wastage-backstop.timer` · same test | READ | **KEEP** — nightly on prod |
| `orphan-file-sweep.ts` | `shareat-orphan-file-sweep.timer` · same test · `tests/unit/scripts-install-storage-driver.test.ts` | READ | **KEEP** — nightly on prod; the DEF-326 script itself |
| `recurring-expense-draft.ts` | `shareat-recurring-expense-draft.timer` · same test | READ | **KEEP** — nightly on prod |

### Invoked by CI or the deploy workflow — KEEP (3)

| File | Caller | How | Verdict · reason |
|---|---|---|---|
| `provision-test-role.mjs` | `ci.yml:167` `node scripts/provision-test-role.mjs` | READ workflow + header | **KEEP** — creates the RLS test role before every integration run |
| `deploy-preflight.ts` | `deploy.yml:77` `npm run deploy-preflight` | READ | **KEEP** — the DEF-235 env gate before build |
| `write-revision.mjs` | `deploy.yml:82` `npm run write-revision -- --require` · `tests/unit/deployed-revision.test.ts` spawns it and asserts the `package.json` entry | READ | **KEEP** — bakes the sha into the artifact; a unit test breaks without it |

### Imported by another script — KEEP (2)

| File | Caller | How | Verdict · reason |
|---|---|---|---|
| `lib/storage-bootstrap.ts` | `orphan-file-sweep.ts:37` import · T-277 test | READ | **KEEP** — the prod sweep cannot start without it (DEF-308) |
| `lib/config-contract.ts` | `storage-smoke.ts:36-40` import | READ | **KEEP** — DEF-311's deployed-vs-documented comparison |

### Person-run production one-shots named by a runbook, ADR or task — KEEP (5)

| File | Caller | How | Verdict · reason |
|---|---|---|---|
| `bootstrap-org.ts` | `docs/ops/README.md:376,413-426` (Path 2 fallback) · `docs/ops/access-revocation.md:57` · `tests/unit/system-transaction-callers.test.ts:33` allow-list · imported-from by `provision-terminal.ts` header | READ | **KEEP** — the recovery path for an org with no sign-in; bible row cites it |
| `provision-terminal.ts` | T-304 §"SCOPE CORRECTION": the *only* way to create a terminal credential · `system-transaction-callers.test.ts:51` | READ | **KEEP** — deleting it makes PIN sign-in un-provisionable |
| `backfill-fiscal-periods.ts` | T-264 / DEF-284 slice 1; `npm run backfill-fiscal-periods` appears only in its own header | READ header; GREPPED callers | **KEEP** — a cutover-blocker remedy for any org bootstrapped before T-264; no timer, run once per such org. ⛔ **Question asked and answered 2026-09-20, do not re-litigate:** asked whether every production org already has fiscal periods, Ian's answer was in effect *"no, or not sure"*. It stays because a backfill you might still need is not worth the risk of deleting |
| `cutover-purge.ts` | ADR-007, runs once on 2027-01-01 · `packages/db/tests/integration/cutover-purge.test.ts:113` **reads its source** | READ | **KEEP** — scheduled for a date, and an integration test parses the file |
| `storage-smoke.ts` | `docs/ops/README.md:175` · `docs/reference/…` · imports `lib/config-contract` | READ | **KEEP** — the bucket-privacy proof (T-141 §8); the only non-test caller of config-contract |

### Dev / repo tooling with a test or skill depending on it — KEEP (5)

| File | Caller | How | Verdict · reason |
|---|---|---|---|
| `gen-toc.ts` | `tests/unit/toc-freshness.test.ts:4` **imports** it · `.claude/skills/wrap-up/SKILL.md:97-162` · 10 task docs | READ | **KEEP** — unit suite imports it; the wrap-up skill requires `npm run toc` |
| `production-caller-census.mjs` | `tests/unit/production-caller-ratchet.test.ts:63` **spawns** it · `docs/production-caller-baseline.txt` | READ | **KEEP** — unit suite executes it on every run |
| `dev-seed.ts` | `docs/HANDOFF-INVENTORY-LANE.md`, DEFECTS-REGISTER, 8 task docs · `dev-seed-inventory.ts` header · `bootstrap-org.ts` header | READ | **KEEP** — the local-DB seed; refuses non-`*_dev` databases |
| `dev-seed-inventory.ts` | `docs/HANDOFF-INVENTORY-LANE.md`, `docs/PENDING-VERIFICATION.md` | READ | **KEEP** — the inventory worked case for local screens |
| `money-positivity-census.ts` | T-325 / DEF-376: exists to be the non-test caller of `scanMoneyPositivitySites` (2026-09-19, one day old) · `t327-schema-coverage-finite-check.test.ts:85` cites it | READ | **KEEP** — deleting it re-opens the DEF-376 "test-only export" finding; ⚠️ Tier B edits the domain module it imports |

### No caller found — UNKNOWN, ruled KEEP by Ian 2026-09-20 (6)

⛔ **All six STAY. This is a RULING, not an omission.** Ian, 2026-09-20, in effect: *a script whose
only caller was a person running it once by hand is a loss nobody notices for months, and the cost
of leaving it is zero — leave all six, revisit later.* **"No caller found" in these rows is a
measurement, not a licence:** a later session must not read this section and take it as grounds to
delete. Re-open only with a new ruling from Ian.

| File | What was found | How | Verdict · reason |
|---|---|---|---|
| `capture.ts` | `npm run capture` in `HANDOFF.md`, `tests/golden/attendance-adjudication.test.ts:27,128` ("BLOCKED … needs Ian — `npm run capture`"), `secrets/README.md`, 3 task docs. No unit, no CI. | READ header + golden test | **UNKNOWN** — the v1 Firestore reader for the ETL phase (T-114a). Still the documented way to re-capture the golden corpus. Needs a service-account key Ian holds |
| `capture-attendance-golden.ts` | Writes `tests/golden/fixtures/attendance-sessions.json` (committed, 1 MB). `npm run capture:attendance-golden` appears in one plan doc and its own header | READ | **UNKNOWN** — the fixture is committed, so the suite does not need it; re-running is only for refreshing the corpus from v1 |
| `audit.ts` | `HANDOFF.md:318` ("regenerates the v1 audit"), `packages/etl/src/audit/report.ts:364` (report footer names it), `docs/reviews/v1-audit-2026-08-24.md` is its output | READ | **UNKNOWN** — T-114b's v1 audit generator; the blueprint (2026-09-05 §116) still points at "copy real data from v1" as the edge-case mechanism |
| `import-items.ts` | **Zero references anywhere in the repo** (no `package.json` entry, no doc, no test). One commit, 2026-08-28: "Import the item master from v1 — and hand back the 94 decisions a machine must not make". Imports `firebase-admin` directly | READ | **UNKNOWN** — the item-master import for cutover; if the 94 conflicts were never ruled on, the full run is still ahead of us. ⚠️ Only file with literally nothing pointing at it |
| `backtick-parity.mjs` | `PROJECT_BIBLE.md:1523` (DEF-345 retraction keeps it "demoted to an anomaly detector"), DEFECTS-REGISTER. No npm entry, no test, run by hand | READ | **UNKNOWN** — a docs-hygiene sweep the bible row deliberately retained |
| `position-access-census.mjs` | T-318 slice A gate (`docs/tasks/318…:110,420`); T-318 is `t-done` on the roadmap and slice B's migration `0152` has shipped | READ | **UNKNOWN** — its gate has been passed; still the only per-store access census, read-only, `shareat_dev` only |

### The named caller was measured absent — DELETED on Ian's ruling 2026-09-20 (1)

| File | What was found | How | Verdict · reason |
|---|---|---|---|
| `daily-review.cmd` | Said "Scheduled via Windows Task Scheduler at 04:00". **`Get-ScheduledTask` on this machine: no task ran it, and none matched `daily`/`shareat`/`claude`.** The log it would write (`.claude/daily-review-last-run.log`) never existed. The skill it launched (`.claude/skills/daily-review`) still exists and `.claude/daily-review-state.json` shows a run at 2026-09-17T08:35Z — by some other route. One commit, 2026-08-25. Hard-coded `C:\Users\ianla\…`, so no other machine could run it. Not in the deploy tarball's reach (Windows only) | READ + Task Scheduler queried | **DELETED 2026-09-20** on Ian's ruling, on this evidence. Recoverable with `git show 10503af:scripts/daily-review.cmd` if the review is ever scheduled |

## Totals

| Verdict | Count |
|---|---|
| KEEP — prod timer | 8 |
| KEEP — CI/deploy | 3 |
| KEEP — imported lib | 2 |
| KEEP — runbook one-shot | 5 |
| KEEP — tooling with a test/skill on it | 5 |
| UNKNOWN → ruled KEEP 2026-09-20 | 6 |
| DELETED 2026-09-20 | 1 |
| **Total** | **30 files** enumerated (28 top-level + 2 in `lib/`; T-329's "29 entries" counted `lib/` as one) · **29 remain** |

## What a deletion would break, by test (so the gates are not the only guard)

- `tests/unit/scheduler-jobs-have-callers.test.ts` — any of the 8 timer scripts.
- `tests/unit/scripts-install-storage-driver.test.ts` — `orphan-file-sweep.ts`, `lib/storage-bootstrap.ts`.
- `tests/unit/deployed-revision.test.ts` — `write-revision.mjs`.
- `tests/unit/production-caller-ratchet.test.ts` — `production-caller-census.mjs`.
- `tests/unit/toc-freshness.test.ts` — `gen-toc.ts` (import).
- `packages/db/tests/integration/cutover-purge.test.ts` — `cutover-purge.ts` (reads source).
- `tests/unit/system-transaction-callers.test.ts` and `auth-transaction-callers.test.ts` scan
  `scripts/` as a root; they go stale, not red, if `bootstrap-org.ts` / `provision-terminal.ts`
  vanish (their allow-lists would then name absent files).
- ⚠️ **None of the 5 UNKNOWN files and not `daily-review.cmd` is covered by any test** — which is
  exactly why they are UNKNOWN: a green suite after deleting them proves nothing.

## Ian's ruling — 2026-09-20, relayed by the orchestrator

The lane put three questions to Ian after the enumeration. All three are answered; none is open.

1. **`daily-review.cmd` — DELETE.** On the evidence above (no scheduled task on this machine, no
   log ever written, hard-coded to one user's path). Deleted the same day; nothing else in
   `scripts/` was touched.
2. **The six UNKNOWN — all STAY.** *A script whose only caller was a person running it once by hand
   is a loss nobody notices for months, and the cost of leaving it is zero. Leave all six, revisit
   later.* A ruling, not an omission; see the section above.
3. **`backfill-fiscal-periods.ts` — KEEP, question closed.** Not every production organisation is
   known to have its fiscal periods set up ("no, or not sure"). A backfill you might still need is
   not worth the risk. Not to be re-asked.

**23 of the 30 were demonstrably live before the ruling** (8 on the prod host's timers, 3 in
CI/deploy, 2 imported, 5 runbook one-shots, 5 tooling with a test or skill on them). After the
ruling, 29 files remain and every one of them has a written reason to exist in this document.

## FOR IAN

- One file deleted on your ruling: `scripts/daily-review.cmd`. Everything else in `scripts/` is as
  it was.
- This document records your three answers so nobody re-asks them.
- Commit and staging belong to the orchestrator; the lane staged nothing.

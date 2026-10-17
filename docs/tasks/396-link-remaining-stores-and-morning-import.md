# T-396: Link Malvar, Banay-Banay, Davao to POS, and a morning import timer

**Status:** SPECIFIED 2026-10-17 (Opus planner). Replaces the 2026-10-10 reserved stub.
**Plan:** `docs/plans/remaining-build-plan.md` C8 (§3.3 row T-396), wave 2. **Bible:** rows 284 (Lipa first, Monday
start), 292 (POS "collected" = a second cash tender), 293 (submitter never verifies), 303 (Lipa double-enters from 19 Oct,
all four from **Mon 2 Nov**; timer 06:00 Manila; submit and verify stay human). **Builds on:** T-375 (feed, import,
recheck), T-382 (unlink), T-384 (tender form), T-401 S6 (the newest daily job, copied in shape).
**Migration:** one, `0209` (the scheduler job name check). No table.

## Goal (§1.2d)

**v1's goal** (`ERP-rebuild/src/lib/financial/posSalesPull.ts`): a store's day of sales reaches the books without anyone
retyping the till. v1 pulls on a button, per store, per day, so a forgotten store-day is simply missing and nobody is told.
**v2's goal:** every linked store's closed day is waiting as a **draft** in the ERP by the time the office starts work,
missed mornings fill themselves in, and a store-day that could not be fetched is a **red line Ian can see**, never a
silence. Nothing is recognised until a person submits and a **different** person verifies (row 293). Four stores × (import
+ submit + verify) was twelve clicks a day; the timer removes the four that carry no control.

## Live facts (verified at source, 2026-10-17)

| Fact | Source |
|---|---|
| Lipa is linked (`L5MExycvUOfQ96Y10FqF`), census GATE PASS; tenders: Cash, Collected (cash, row 292), Gcash, Bank (POS "Bank Transfer"), QR (POS "QRPH") | T-375 S0; `docs/ops/lipa-pos-link-runbook.md` |
| The v2 POS key is **store-scoped and lists Lipa only**. POS answers 403 for any other store and `/api/external/stores` **hides** stores not in the map, so the link page cannot even offer Malvar/Banay-Banay/Davao until Ian widens the map | `POS/src/lib/server/external-auth.ts:29-67`, `POS/src/app/api/external/stores/route.ts`; `docs/ops/pos-v1-key.md` |
| POS store ids are **not** the v1 ERP ids in `docs/STORE-ROSTER.md` (Lipa: ERP `b9Dz…`, POS `L5ME…`). The three POS ids are in POS admin → Stores; **no doc here holds them** | grep of `docs/` |
| POS has no "day closed" flag: `/api/external/sales` reads `stores/{id}/analytics/{yyyymmdd}`, `found:false` when absent. So "closed" = the date is before today in Manila | `POS/src/app/api/external/sales/route.ts:21-33` |
| `importSalesDay(tx, actor, {storeId, businessDate})` needs `submit_sales_day`; writes `fetched_by`/`created_by` = `actor.personId` (NOT NULL). A non-admin is **create-blocked** behind an older unverified day; an admin bypasses (`canBypassBlock` = `close_period`) | `packages/domain/src/sales-days/import.ts:135-262`, `create-block.ts:78-120` |
| On an **existing** open/submitted day `importSalesDay` silently becomes a re-import | `import.ts:94-110, 213-216` |
| The prior-7-days recheck runs only from the web action, after commit | `apps/erp/src/app/sales-days/actions.ts:140-146` |
| Daily-job pattern: `runJobForOrg` + `scheduler_runs` (period must be `YYYY-MM`, job name CHECK-constrained), unit pair in `docs/ops/`, `Persistent=true`, exit 1 on any failure | `packages/domain/src/scheduler/index.ts:115, 1274-1310`; `docs/ops/shareat-usage-auto-post.*`; 0198 |
| **No mailer is installed** on the host; "the mailer speaks up" in older units is false. The only live alarm is the backup heartbeat (healthchecks shape) | `docs/ops/shareat-db-backup.service:38-39`; `scripts/lib/backup/heartbeat.ts` |
| `SchedulerStatus` is monthly-minded: stale = 2 months, never-run text names `month-end` | `apps/erp/src/components/scheduler-status.tsx:58-125` |
| A read-only per-store readiness report exists (`posLinked`, cash account, staff, managers) | `packages/db/src/repo/store-readiness.ts`, `scripts/lib/master-data-readiness.ts` |
| 12 Oct 2026 was a Monday, so **26 Oct and 2 Nov are Mondays** (row 284 wants a Monday link) | Lipa runbook |

## Already built vs missing

**Built (do not rebuild):** link / tender / unlink screens `apps/erp/src/app/settings/pos-link/*`; `linkStoreToPos`,
`unlinkStoreFromPos` `packages/domain/src/pos/store-link.ts`; fetch `pos/v1-feed.ts`; derive `pos/v1-derive.ts`; method
resolver `pos/v1-methods.ts`; import / re-import `sales-days/import.ts`; recheck `pos/v1-recheck.ts`; census
`scripts/pos-v1-feed-census.ts` + `pos/v1-census.ts`; the 0185 lock; reconciliation report; dev fake POS
`apps/erp/src/app/api/dev/fake-pos/…` + `apps/erp/dev-fixtures/pos-v1/`; heartbeat `scripts/lib/backup/heartbeat.ts`.
**Missing:** (1) an unattended import of every linked store's missing closed days; (2) a way for it to fail **visibly**;
(3) a one-command per-store go/no-go before linking (today it is the census plus reading screens by eye); (4) a runbook
for a store that is not Lipa; (5) the three stores' POS ids, key map, accounts and tenders (Ian's data, not code).

## What linking needs, per store

| Value | Who | Notes |
|---|---|---|
| POS store id | **Ian** (POS admin → Stores) | Firestore id, ~20 chars. Not the ERP roster id |
| Store added to `POS_EXTERNAL_API_KEYS_JSON` + POS rollout | **Ian** (`pos-v1-key.md` step 2, with all four ids at once) | Without it: 403, and the store is invisible on the link page |
| 90-day census GATE PASS | Ian runs, numbers in the status line (the key lives on the server) | Lists the store's POS methods (f): the tender list to build |
| Money account per wallet method (GCash, bank, QRPH…) | **Ian chooses** which real account receives it; admin creates it on `/money-accounts` | Cash and Collected need none (row 292) |
| Tenders: one per POS method + Cash + Collected | Derivable from the census (f) list; admin enters on `/settings/pos-link` | POS name match ignores case/spaces/dashes |
| Daily-remitted sales channel of the store | Derivable (T-391 master data); preflight checks it exists and is active | |
| Tax type | Derivable: **VAT inclusive** (row 279) | |
| No unverified typed days at the store | Derivable; preflight checks | Linking refuses otherwise |
| Link date | Ian (Q5) | A Monday (row 284) |

## Design

**D1 — the job.** New `posDayImportSweep({ orgId?, now, trigger, dryRun })` in `packages/domain/src/pos/day-import-job.ts`,
scheduler job **`pos_day_import`**, one `runJobForOrg` per org, period = the Manila month of the run (the period CHECK
is `YYYY-MM`; usage_auto_post precedent). For each **live** link (`unlinked_at is null`), in store-name order:
- **Window:** business dates `max(link's Manila created date, yesterday − 6)` … **yesterday** (Manila). Never today
  (not closed). 7 days = the recheck window; a host down a week still fills in. `CATCH_UP_DAYS = 7`, exported.
- **Skip** any date that already has a sales day in **any** status, **voided included** (re-entering a withdrawn date
  is a manager's decision, `assertCanOpenDay`). Skipped dates count as `skipped`, not failures.
- **Import** each remaining date, oldest first, each in its own transaction, as the **link's `updated_by ?? created_by`**
  person (Q1 a; the recurring-expenses precedent: the automation can do nothing the admin who vouched for the link could
  not). Every read and every import runs under **`withOrgPrincipal(org.id, …)`**, never a bare `transaction` (RLS +
  0185's trigger fail closed without `app.org_id`; the integration suite connects as a superuser and cannot see this —
  `recurring-expenses/job.ts:120-126`). Call `importSalesDay` with the new option **`ifAbsent: true`**, which means
  "any day on this date, **voided included**, is present": (a) at the pre-fetch peek, a present day returns
  `{ id, skipped: true }` before `gateExistingDay` (so a verified day is a skip, never a refusal) and before POS is
  called; (b) after the fetch, the re-read under `lockStoreKeyShare` (+ `hasVoidedOn`) skips the same way, writing
  nothing (no feed batch). ⚠️ **No lock serialises two creators of a NEW day**: the store lock is `FOR KEY SHARE`
  (two imports do not block each other) and there is no day row to lock yet. A human import still uncommitted at (b)
  is invisible, so the timer's insert waits on, then hits, the partial unique index
  `sales_days_org_id_store_id_business_date_unique` (23505). The **job** catches that 23505 (its own transaction is
  aborted, so outside it) and records the date as `skipped`, never a failure. That index plus (a)/(b) is the
  idempotency guarantee (a human pressing Import at 06:00 cannot be overwritten). Option **`source: 'cron'`** writes one
  audit row `sales_day.auto_imported` (new catalogue entry: money, normal, store scope, actor person; `entityId` = the
  day) so the activity log says the timer made it, not the admin by hand. (The day page has **no history panel** today;
  this task does not add one.)
- **Typed outcomes, never string matching.** In `ifAbsent` mode a POS `found:false` returns `{ notFound: true }` (writes
  nothing) instead of throwing; a fetch refusal keeps the `PosUnreachableError` / `PosNotConfiguredError` as its
  `cause`. The job classifies on those, not on sentences or raw messages.
- **Never** submit, verify, post, re-import or void. The draft is `open`; the ledger is untouched.
- **Outcomes per store-date:** imported → `posted`; POS `found:false` → a `kind:'notice'` line ("Malvar 1 Nov: POS has
  no sales yet: closed, or not synced") — not a failure (a store may close for a day); every other refusal (unmapped
  method, retired account, bad POS day, unreachable, not configured, actor lost `submit_sales_day`) → a failure line
  with the store name, date and the import's own sentence. One store's failure never stops the next store or date —
  except: **not configured** stops the org (one line); **unreachable** stops only **that store's** remaining dates (one
  line per store, not 7). ⚠️ `v1-feed.ts:62-88` maps **every** non-2xx (incl. a 403 "store not in the key map") to
  `PosUnreachableError`, so an org-wide stop would let one store missing from the key map halt Lipa too. For an
  unreachable line, append the HTTP status parsed from the raw message (status only, never a body or the key), so a
  403 reads as the key-map problem it is.
- **After** a store's imports commit: `recheckRecentDays(actor, storeId, newestImportedDate, fetchers)` (thread the
  injected fetchers). It does **not** throw per day: it returns `failed[]` and only logs. Each `failed` entry, and a
  thrown error, becomes a notice naming the store and date.
- **Gap beyond the window:** if this org's previous `pos_day_import` run started more than `CATCH_UP_DAYS` ago, a
  **failure** line per linked store names the dates before the window that the timer will never reach ("import them by
  hand"); on the org's first-ever run, the same as a **notice**. A host down 10 days must not lose 3 days silently.
- **Closed (`found:false`) dates are retried** every morning until they age out of the window (a notice each morning;
  the text says "will be asked again tomorrow"), since a POS that synced late must still fill in.
- **Backlog notice:** a store with more than 3 imported days still `open`/`submitted` gets a notice ("Davao has 4 days
  waiting for submit/verify"). The timer bypasses the create-block as an admin, so the backlog must be said instead.
- **Dry run:** each import runs inside a transaction rolled back by a sentinel; output lists what would import / refuse.
  The recheck is **skipped** in a dry run (it writes recheck feed batches), and no `scheduler_runs` row is written.
- **"Closed" vs bible row 348.** Row 348: a business day ends at the store's closing time and after-midnight sales
  belong to the opening day. POS v1 keys `analytics/{yyyymmdd}` by the **Manila calendar date of each sale**
  (`POS/src/lib/analytics/daily.ts` `getDayIdFromTimestamp`), so after-midnight sales land on the next date in the feed.
  This task cannot change that (T-375's feed contract); at 06:00 nothing is lost unless a store trades past 06:00.
  Surfaced for Ian (Audit open item 1).

**D2 — the script and units.** `scripts/pos-day-import.ts` (`npm run pos-day-import`; flags `--org=`, `--manual`,
`--dry-run`), shaped exactly like `scripts/usage-auto-post.ts`: prints one line per store-date, exit 1 on any failure
line or zero orgs. `docs/ops/shareat-pos-day-import.timer`: `OnCalendar=*-*-* 06:00:00 Asia/Manila`, `Persistent=true`
(a missed 06:00 runs at boot; the 7-day window covers longer outages), `AccuracySec=1min`. `.service`: oneshot,
`User=shareat`, `NODE_ENV=production`, log `/var/log/shareat/pos-day-import.log`, `TimeoutStartSec=15min`.

**D3 — alarm Ian can see (Q2 a).** (i) `/sales-days` renders `SchedulerStatus job="pos_day_import"` for anyone with
`submit_sales_day`: red with every failure line, amber when stale; (ii) the script pings `POS_IMPORT_HEARTBEAT_URL`
(`httpHeartbeat`: `/start`, ok, `/fail` with the failure lines) so a dead timer or a failing morning reaches Ian's phone
from the same service the backups use. `SchedulerStatus` gains `cadence: 'daily' | 'monthly'` (default `monthly`, so
fixed-assets and prepaid are unchanged; daily = stale after 26 h) and a `command` prop for the never-run sentence.
**Store scope:** every line's `subjectId` is the v2 store id; `/sales-days` shows only the lines for stores where the
viewer holds `submit_sales_day` (a Malvar manager does not see Davao's refusals). `SchedulerStatus` reads under the org
principal, so the page filters, the component gets an optional `subjectIds` allow-list. **The heartbeat URL is a
secret** (anyone holding it can mark the job healthy): it lives only in `/srv/shareat-shared/.env.local`, is never a
command-line flag, never printed (not in the "no heartbeat configured" line, not in errors), never in `scheduler_runs`.

**D4 — preflight (the per-store dry run).** `scripts/pos-link-preflight.ts --store=<v2 store id> --pos-store=<id>`:
read-only, DB under the org principal + POS. Pure verdicts in `packages/domain/src/pos/link-preflight.ts`
(`preflightVerdict(facts) → { go: boolean; lines: {ok|fail|warn, text}[] }`). Checks: POS id answers 200 on
`/payment-methods` (403 → "not in the key map"); not already linked elsewhere; 90-day census gate (reuses
`v1-census.ts`); an active daily-remitted channel; no unverified typed days; **every POS method seen in 90 days (and
every listed method) resolves to an active tender** via `resolvePosV1Methods`'s normaliser, each wallet tender on an
active bank/e-wallet account of this store; tenders Cash and Collected present (warn). Exit 0 = GO, 1 = NO-GO, 2 = could
not run. Never prints the key or a body.

## Slices

Tester first in every slice; each test must fail on `main` for the stated reason before the builder starts (§3.2).

### S1 — the job, the migration, the units (L: Sonnet; money-adjacent)
**Tester:** `packages/domain/tests/integration/t396-s1-pos-day-import.test.ts` (new); `tests/unit/scheduler-job-hosting.test.ts`
(`JOB_SCRIPT.pos_day_import = 'pos-day-import'`); `tests/unit/t396-s1-units.test.ts` (new). **Baselines that go red
by design** (bump, do not weaken): `tests/unit/scheduler-job-run-recording.test.ts` (PINNED row for `pos_day_import`,
entry `posDayImportSweep`, file `packages/domain/src/pos/day-import-job.ts`; count 12 → 13 at `:464`);
`tests/unit/scheduler-jobs-have-callers.test.ts` (`KNOWN_JOB_NAMES`); `tests/unit/t276-scheduler-job-check-mirror.test.ts`
reads the last widening migration (passes only if schema + 0209 name the same 13). The dotted audit action needs the
catalogue only, not 0197's list (`t402-s1a` S1b rule). **Migration slot:** 0209 is claimed here and T-193 already
defers to "next free"; if T-193 merges first anyway, renumber to the next free idx and re-grid the journal `when`.
**Builder:** `packages/db/migrations/0209_t396_pos_day_import_job.sql` + `migrations/meta/_journal.json` (ADR-012 §5,
hand-authored; widen `scheduler_runs_job_check` exactly as 0198 did); `packages/db/schema/scheduler.ts`;
`packages/db/src/audit/catalogue.ts`; `packages/db/src/repo/sales-days.ts` (`datesWithAnyDay(tx, orgId, storeId, from,
to)`); `packages/db/src/repo/pos-v1.ts` (`listLiveLinks`: `listLinks` at `:111` returns unlinked rows too);
`packages/domain/src/sales-days/import.ts` (`ifAbsent`, `source`; return `{ id; skipped?: true }`; web callers unchanged);
`packages/domain/src/pos/day-import-job.ts` (new); `packages/domain/src/index.ts`; `scripts/pos-day-import.ts` (new);
`package.json` (script); `docs/ops/shareat-pos-day-import.{service,timer}` (new); `docs/ops/README.md` (one job row +
arm line; the arm loop is a glob, so nothing else).

| # | Test (fake fetchers, real Postgres) | Kills the mutant that… |
|---|---|---|
| 1 | Two linked stores, `now` = 06:00 Manila: each gets yesterday as an `open` draft, `source='pos_v1_day_feed'`; no journal entry; no `submitted_by` | …submits or verifies, or posts |
| 2 | Run twice: second run imports 0, skips 2, feed batch count and each day's feed id unchanged | …drops the skip / re-imports |
| 3 | The sales fetcher, mid-fetch, runs a **committed** human `importSalesDay(null, human, …)` for the same date on its own connection: `ifAbsent` returns skipped, no new feed batch, figures and `created_by` are the human's | …checks absence only before the fetch, not under the lock |
| 3b | A second connection inserts the day (human import) and holds its transaction open; the timer's insert blocks; the holder commits → the timer records `skipped` (23505 caught by the job), no failure line, outcome `ok` | …treats the unique-index race as a failure, or lets it abort the run |
| 3c | Peek finds a **verified** day on the date (pre-check bypassed by the test) → skipped, POS never called, no refusal | …gates before honouring `ifAbsent` |
| 4 | Last day 3 days ago → imports 3, oldest first; link made 2 days ago → only dates ≥ link date; a 10-day gap → 7 | …imports only yesterday / ignores link date / no cap |
| 4b | Previous `pos_day_import` run 10 days ago → a failure line names the 3 out-of-window dates; first-ever run → the same as a notice | …loses days beyond the window silently |
| 5 | `now` = 23:59 Manila: today never imported; `now` = **16:30 UTC** (00:30 Manila of D+1): yesterday = D, not D−1 | …uses UTC or includes today |
| 6 | A voided date in the window is skipped, no refusal, no new day | …treats voided as absent |
| 7 | An unlinked store (T-382) and a never-linked store are untouched | …iterates all stores |
| 8 | Store A has an unmapped method → failure line "SharEat A, <date>: POS took …"; store B imported; outcome `partial`; script exit 1 | …aborts the loop or swallows the failure |
| 9 | POS `found:false` → notice, outcome `ok`, exit 0 | …counts closed days as failures |
| 10 | Store A unreachable (fetcher throws `PosUnreachableError` "returned 403") → one failure line for A naming 403, no further fetches for A; store B still imports. Not configured → one line for the org, no fetches | …retries 7 times per store, stops every store on one store's 403, or reports success |
| 10b | `recheckRecentDays` returns a `failed` entry → a notice naming the store and date; dry run calls no recheck | …drops the recheck result / rechecks in a dry run |
| 11 | `fetched_by`/`created_by` = link's `updated_by ?? created_by`; that person's admin role revoked → failure naming the store, nothing written | …bypasses `authorize` / uses a system principal |
| 12 | One `sales_day.auto_imported` audit row per import, source `cron`, store set; web import still writes none | …audits as web or not at all |
| 13 | `dryRun`: sales_days, feeds, audit rows unchanged; output lists the would-import dates | …commits in dry run |
| 14 | `scheduler_runs` row: job `pos_day_import`, period `YYYY-MM`; 0209 still rejects `'bogus'` | …misnames the job / drops the CHECK |
| 15 | Backlog: 4 open imported days → notice naming the store | …stays silent on a pile of drafts |
| 16 (unit) | Timer: `OnCalendar=*-*-* 06:00:00 Asia/Manila`, `Persistent=true`; service runs `npm run pos-day-import`, no `build` | …wrong time zone / no catch-up |

### S2 — visible failure (L: Sonnet)
**Tester:** `apps/erp/tests/integration/t396-s2-import-status.test.ts` (new); `tests/unit/t396-s2-heartbeat.test.ts` (new).
**Builder:** `apps/erp/src/components/scheduler-status.tsx`; `apps/erp/src/app/sales-days/page.tsx`;
`scripts/pos-day-import.ts`; `.env.example` (`POS_IMPORT_HEARTBEAT_URL`); `docs/ops/README.md` (env line).

| # | Test | Kills the mutant that… |
|---|---|---|
| 1 | Never run → `/sales-days` says the morning import has never run and names `npm run pos-day-import` | …hides the never-run state |
| 2 | Last run `partial` → each failure line (store, date, sentence) on the page; notices not styled as failures | …shows counts only |
| 3 | Daily cadence, last run 27 h ago → stale warning; 25 h → quiet line | …keeps the 2-month threshold for daily |
| 4 | Fixed-assets page with a 40-day-old depreciation run → not stale (monthly default unchanged) | …changes the default |
| 5 | A person without `submit_sales_day` sees no status block | …leaks the run to everyone |
| 5b | A manager scoped to store A sees A's failure line, not store B's | …shows every store's refusals org-wide |
| 6 | Script with failures pings `/fail` with the lines; clean run pings ok; unset URL logs once, exit code unchanged; captured stdout never contains the configured URL | …pings ok on a failed run / prints the secret |

### S3 — preflight and the runbook (L: Sonnet; Haiku for the doc)
**Tester:** `packages/domain/tests/unit/t396-s3-preflight.test.ts` (new).
**Builder:** `packages/domain/src/pos/link-preflight.ts` (pure, new); `scripts/pos-link-preflight.ts` (new);
`package.json`; `docs/ops/pos-link-runbook.md` (new, generic, written from the Lipa runbook; Lipa's file gets a one-line
pointer at the top); `docs/ops/pos-v1-key.md` (step 2: list all four ids).

| # | Test (pure facts in, verdict out) | Kills the mutant that… |
|---|---|---|
| 1 | Census method "G-Cash" with tender POS name `gcash` → ok | …compares raw names |
| 2 | A method seen in 90 days with no tender → NO-GO naming it | …checks only the listed methods, or only tenders |
| 3 | Wallet tender on a retired / other-store / cash account → NO-GO | …trusts the tender row |
| 4 | Census gate fail (e1/d/e/n non-zero) → NO-GO with the count | …ignores the census |
| 5 | An unverified typed day → NO-GO with its date | …lets the link refusal be the first warning |
| 6 | No Collected tender → warn, still GO | …blocks on a ₱0 method |
| 7 | POS 403 → NO-GO "not in the POS key map" | …reports a generic error |

### S4 — operations, per store (orchestrator + Ian; no code)
Deploy S1-S3 (one PR, full suite on CI). Ian arms the timer (`systemctl enable --now shareat-pos-day-import.timer`;
check with `is-enabled`/`is-active`, never `list-timers`); Lipa uses it from the next morning. Before arming, Ian
creates the heartbeat check (period 1 day, grace ~2 h) in the backup alert service and puts its URL in
`/srv/shareat-shared/.env.local` as `POS_IMPORT_HEARTBEAT_URL` (with `nano`; never echoed). Expect Lipa's first run to
draft every un-imported day back to 7 days (≥ 12 Oct link date) and raise the backlog notice once. Then, **per store**
(Malvar, Banay-Banay, Davao), in `docs/ops/pos-link-runbook.md`:
1. **Data (Ian, by Fri 23 Oct):** POS id; key map widened with all four ids; POS rolled out; step-4 curl = 200.
2. **Dry run:** census (90 days) → GATE PASS in the status line; build money accounts and tenders from its (f) list;
   `npm run pos-link-preflight -- --store=… --pos-store=…` → **GO**.
3. **Link (the Monday, Q5):** `/settings/pos-link`, channel, VAT inclusive, Link store; amber "not mapped" note gone.
4. **First import check (Tuesday):** the timer's draft for Monday exists; compare total and each method to the POS
   Z-report once by hand; submit, a different person verifies; `/reports/pos-reconciliation` delta zero.
5. **Daily for week one:** `/sales-days` status line green; the heartbeat green.
Done per store = step 4 passed. DEF-586 closes when the third store passes.

## Smoke (§9.4) — local, 9008, fake POS

`POS_FAKE_ENABLED=1`, `POS_API_URL=http://localhost:9008/api/dev/fake-pos`, fixtures for two fake stores (add a second
beside `fake-lipa`, one with an extra method "Maya" unmapped). Link both on `/settings/pos-link`. Then:
`npm run pos-day-import -- --manual --dry-run` (nothing saved) → `npm run pos-day-import -- --manual` → screenshot
`/sales-days`: store 1 has yesterday as a POS draft, store 2 a red line naming "Maya"; map Maya, re-run → store 2 imports,
store 1 skipped, status line green; re-run once more → 0 imported. Open one draft: source "POS", status open; the
`sales_day.auto_imported` row (source `cron`/`manual`) exists for it (SQL read; the day page has no history panel). Run preflight against fake store 2 before mapping (NO-GO) and after (GO).

## Invariants

1. The timer never submits, verifies, posts, re-imports, or voids. 2. It never touches a date that has any day.
3. It only acts as a person who holds `submit_sales_day` at that store at run time. 4. Every failure is on
`/sales-days` and on the heartbeat. 5. No refusal sentence is re-implemented; the import's own sentences are reported.
6. No new table; the only schema change is the 0209 CHECK.

## Questions for Ian (Open Questions page)

| # | Question | Options | Recommended |
|---|---|---|---|
| Q1 | Whose name the morning import works under | (a) the admin who last saved that store's POS link · (b) a new "system" identity | **(a)**: no new always-on login nobody watches; if that admin leaves, the import stops loudly and someone re-saves the link |
| Q2 | How a failed morning reaches you | (a) red line on Sales days **and** a phone/email alert from the backup alert service · (b) the page only | **(a)**: a page only helps if someone opens it; the alert service is already paid for |
| Q3 | (action) Send the POS store ids of Malvar, Banay-Banay, Davao, add all four to the POS key and roll POS out; say which bank/e-wallet account receives each store's GCash, bank transfer and QRPH | — | By **Fri 23 Oct**, or 26 Oct slips |
| Q4 | A day POS has no sales for (store closed) | (a) a note, no alarm · (b) an alarm | **(a)**: a closed day is normal; a POS outage still alarms |
| Q5 | Which Monday to link the three stores | (a) Mon 26 Oct · (b) Mon 2 Nov | **(a)**: one week of imports to shake out before double entry starts 2 Nov; (b) leaves no slack |

## Out of scope

Re-importing a changed open day automatically (the recheck finds drift; a person re-imports). Auto-submit or verify
(row 303). Padre Garcia (franchise, T-398). POS v2 terminals (T-424). The usage pull from sold items (T-401). Expense and
delivery double entry (operational, row 303). The comparator (T-392). Rotating or changing the POS key mechanism.

## Risks

| Risk | Mitigation |
|---|---|
| Ian's data (Q3) arrives late | 26 Oct needs it by 23 Oct; 2 Nov is the hard fallback (Q5 b); escalate on 24 Oct |
| A store closes after 06:00 Manila or a late bill posts after the fetch | The recheck (7 days) raises drift; the day is still unverified, so re-import fixes it |
| Drafts pile up unverified (timer bypasses the create-block) | Backlog notice (S1 #15) + the comparator review |
| Linker admin demoted | Loud per-store failure (S1 #11); fix = re-save the link |

## Audit 2026-10-17

Opus spec audit against `main` (`c6b16cf`). Verdict: **sound design, nine fixes folded in; build-ready after Ian's open
items are answered or accepted.** Changes made above:

1. **Idempotency claim corrected (D1).** "After the store/day locks" was not a guarantee: the store lock is `FOR KEY
   SHARE` (imports don't block each other) and a new date has no row to lock. The real backstop is the partial unique
   index; the job now catches its 23505 as `skipped`. `ifAbsent` also short-circuits at the pre-fetch peek and counts a
   voided day as present (invariant 2). Tests 3 (committed human via its own connection), 3b (uncommitted race), 3c.
2. **`withOrgPrincipal` mandated** for every read/import (RLS + 0185 fail closed; superuser tests are blind to it).
3. **Typed outcomes:** `found:false` returns `{ notFound: true }` in `ifAbsent` mode; fetch refusals keep their
   `cause`. No sentence/raw-message matching.
4. **Unreachable stops one store, not the org.** `v1-feed.ts` turns a 403 (store not in key map) into
   `PosUnreachableError`; org-wide stop would halt Lipa over Malvar's key. Test 10 rewritten.
5. **Recheck result used:** `recheckRecentDays` returns `failed[]` and never throws per day; now reported. Skipped in
   dry run. Test 10b.
6. **Gap beyond the 7-day window is said** (failure if the previous run is >7 days old; notice on first run). Test 4b.
   Closed (`found:false`) dates re-asked each morning, said so.
7. **Test 5 fixed:** 00:01 UTC is 08:01 Manila the same date and kills nothing; the boundary is 16:00 UTC.
8. **Status block store-scoped** (`subjectId` = store; test 5b) and **heartbeat URL secret handling** written down
   (test 6 asserts stdout never holds it). S4 gains creating the heartbeat check and where the URL lives.
9. **Baselines named:** `scheduler-job-run-recording` PINNED + 12 → 13, `scheduler-jobs-have-callers`
   `KNOWN_JOB_NAMES`, t276 mirror; migration-slot rule vs T-193. Smoke no longer claims a day-page history panel
   (none exists); the audit row is checked by SQL.

Verified true as written: `import.ts` order and line refs; create-block bypass = `close_period` (linker needs
`manage_chart_of_accounts`, admin-only, so it holds `close_period` and `submit_sales_day`); `listLinks` returns
unlinked rows; `SchedulerFailure.kind:'notice'` exists and is not counted; outcome CHECK allows `partial` only with
posted > 0; `sales_day.auto_imported` is dotted so only the catalogue needs it; units/timer shape matches
`shareat-usage-auto-post.*` (WorkingDirectory `/srv/shareat`, User `shareat`, `NODE_ENV=production`, dotenv
`.env.local`); every "built" path exists; the never-submit/verify invariant holds (insert path writes `open` only).

**Open for Ian:** (1) row 348 vs POS v1: POS files after-midnight sales under the next calendar date; the import
inherits that. Accept for POS v1, or log a defect for T-375? (2) Does a store ever trade past 06:00 Manila? If yes, the
timer imports a partial day (the recheck catches it later). (3) The activity of the timer is visible only in the audit
log, not on the day page; acceptable?

## Orchestrator rulings 2026-10-17

- **After-midnight sales (row 348) for POS v1:** accepted as v1 files them (next calendar date) for the dual-run period; POS v2 follows row 348. Not a T-375 defect.
- **A store trading past 06:00:** the 7-day recheck corrects the partial day; no extra handling.
- **Timer work visible in the audit log; failures on /sales-days (S2):** accepted.
- **S1 builds with the recommended defaults** (actor = the admin who last saved the store's POS link; Ian's q-t396-actor can switch it before arming).
- **Status:** AUDITED 2026-10-17. S1 building now (migration 0209). S3/S4 data blocked on Ian's q-t396-pos-ids (by Fri 23 Oct).

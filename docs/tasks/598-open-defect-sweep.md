# T-598 — Open defect sweep: every open register row triaged; the no-decision fixes sliced

Status: SPEC (Opus planner), 2026-11-18. Read on main 9892641 (wt-plans), code read only, nothing run.
Scope: every row of `docs/DEFECTS-REGISTER.md` not marked fixed/closed (409 rows, sections A-E and the E rows
after the change log). DEF-866..905 are out of scope (866-868 fixed; 869-905 are owned by T-593..T-597, T-600).
Builders: Sonnet. Auditor: Sonnet on S2, S4, S6, S7 (money, auth). No bible edits by builders (RULES §1.14).

## 1. Result

| Class | Rows | Meaning | Goes to |
|---|---|---|---|
| A | 207 | already fixed on main, or done by design; the row only needs marking | §5 slice R (register clean-up) |
| B | 65 | still in our code, small, no owner decision | §4 slices S1-S11 |
| C | 116 | needs Ian, or deliberately deferred (after go-live, a later task, retiring `apps/pos`, ops step) | §6 For Ian |
| D | 21 | cannot tell from code (needs a live DB, production, a device, or a timed run) | §3 |

Rules applied: `apps/pos` (copied Firebase v1 POS, retiring) gets security fixes only, so its non-security rows
are C; the reference repos are never edited, so section A-D rows (v1 defects) are A when the rebuild already
does the row's Disposition, else C. Bible rows 471/473 named in the brief are not on main yet; the same rule is
applied from the brief.
Corrections to the brief's starting list: DEF-111 is already `fixed` (T-194; `payroll/compute.ts:133` returns 0
units for a zero-minute day). DEF-816/817/818 have no register rows (logged on the coord board); all three are
merged: ff64b8a (T-547, #200) and 61ac9d3 + dd60b7b (T-562, #235, #264). DEF-832 is NOT fixed (see §2).

## 2. The two stopped builders: what to keep

Worktree 1 `.claude/worktrees/agent-ad1551e6b0b843b24` (base 9892641, uncommitted, 10 files + 1 new). **Keep all of it as S1's
start.** Checked: inbox `hasOnly` list equals the 8 keys `apps/erp/src/lib/terminal/lane.ts:248-257` writes and
the test `event()` sends; `freezeDays` keeps its empty-list return (`payroll.ts:464`), so `id in (...)` never
renders `in ()`; `created_at` is `timestamptz` (`schema/trade-discrepancies.ts:132`), so `at time zone
'Asia/Manila'` is right; `isValidPeriod` reaches the script through `domain/src/index.ts:31`; the two
`UNRESOLVED_RAW_SQL` entries are removed because the `sql.raw` is gone. Missing: DEF-864's `.playwright-mcp/`
(11 tracked files) is not untracked; S1 adds it.

Worktree 2 `.claude/worktrees/agent-a8d3c2350ff463c10` (base 9892641, uncommitted, 9 files).
- **Keep** the DEF-859 code (`core/money.ts` `multiplyByFraction`, `payroll/compute.ts`, both tests) as S2's start.
  Math checked: `rate x (2h x mult/100) / (2 x required/100)`, the 100s cancel, one half-up rounding; hours are on
  the half-hour ladder so `Math.round(hours*2)` is exact. It changes a centavo only at exact ties.
- **Keep** the task-doc status lines (547, 562, 573, 574 marked DONE with merge commits).
- **Keep** the register edits for DEF-841 and DEF-857 (fixed, commits cited) but move them into slice R.
- **Drop** the DEF-832 edit (`deferred` -> `fixed`): ERP `/pos` has no refunds yet; the row is a carry-forward into
  T-534 (refunds). It stays C.
- **Drop** the DEF-859 register edit until S2 merges (it would claim a fix that is not on main).

## 3. Class D (cannot tell from code) — no builder work; each needs the named check

| DEF | Why not decidable | Check that settles it |
|---|---|---|
| 004 | no receipt-level fulfilment column; only `table_sessions.mode` (`schema/pos-v2.ts:66`) | does a v2 receipt know it was an online order? read T-523 spec |
| 045 | `etl/src/leg-mapping.ts:359` maps `cash_legacy_import`; date bound unproven | read `etl/src/audit/groups.ts` with a corpus run |
| 590 | refund route not read for discount netting | read `apps/pos/src/app/api/pos2/refunds/route.ts` |
| 114 | needs a live Firestore re-probe of store configs | Ian/BOSS probe |
| 152 | `sync-firestore/src/index.ts:77` `process.cwd()` | a CI build of sync-firestore |
| 260 | `terminals.ts:117` no production caller | device or emulator |
| 324 | no `router.replace` in the cited files | browser repro |
| 325 | `position-defaults.test.ts:713` 120 s timeout cause | timed full-suite runs (T-604) |
| 377 | `remittance.ts:134,138,139,360` hedges | integration run |
| 388 | dev renderer + emulator sign-in | local runtime |
| 391 | `constraint-messages.ts:181` one sentence for 160 columns | measure reachable columns |
| 451 | throw-census classifier | plant test run |
| 503 | client-side 404 | browser network panel |
| 567, 593, 639, 722 | timeouts/flakes under load | T-604 (CI speed and flaky tests) owns them |
| 629, 637, 638 | hydration / reload / timing | browser smoke on a private port |
| 655 | `/srv` group-write on production | production check (Ian/BOSS) |

## 4. Builder slices (class B)

Each slice is one Sonnet builder in its own worktree from `origin/main`, one PR. No two slices share a file.
Every refusal test shows its mutant red (quote the red output in the PR). Integration tests on any `_test` DB.
After each slice run: `tests/unit/t343-throw-ratchet.test.ts`, `tests/unit/t371-numeric-write-guard.test.ts`,
`apps/erp/tests/action-link-sweep.test.ts`, `apps/erp/tests/editable-record-baseline.json` guard, touch-target
baseline, toc-freshness; **re-measure a pin only by its own script, never hand-edit**.

### S1 — finish worktree 1 + findings/scheduler (DEF-856, 858, 860, 863, 864, 285, 251, 252)
Files: the 11 worktree-1 files, `packages/domain/src/attendance/sweep.ts`, `.playwright-mcp/` (untrack).
1. Keep worktree 1 as is (§2). Its tests: `month-end-period.test.ts` (mutant: regex accepts `1[0-3]` -> red);
   `findings.test.ts` "DEF-860" (mutant: back to `created_at::date` -> red under `timezone = 'UTC'`);
   `rules.test.ts` "DEF-863" (mutant: drop `hasOnly` -> red; needs the Firestore emulator job in CI).
2. DEF-864: `git rm -r --cached .playwright-mcp` and add `.playwright-mcp/` to `.gitignore`. No test.
3. DEF-285: `packages/db/src/repo/findings.ts:566` detail says "Generate the next year"; the monthly
   `fiscal_period_seed` job (T-276, `schema/scheduler.ts:103`) does it. Reword to name the job. Test: assert the
   new sentence in the existing findings test; mutant: old sentence.
4. DEF-251/252: `packages/domain/src/scheduler/index.ts:370` inner-joins `store_attendance_config`, so a store with
   no live config is silently skipped; `attendance/sweep.ts:119` returns `{ leftOpen: 0 }` with no policy. Make
   the join `left join`, and for a store with no config record a per-store failure named by store (T-343 S4
   wording) instead of `leftOpen: 0`. Test (integration): org with one unconfigured store -> the run reports
   `hadFailures` naming that store; mutant: restore the inner join -> red.

### S2 — payroll premiums in exact money (DEF-859) — money, Sonnet auditor
Files: `packages/core/src/money.ts`, `packages/core/tests/money-exact.test.ts`, `packages/domain/src/payroll/compute.ts`,
`packages/domain/src/payroll/compute.test.ts`. Take worktree 2's diff for these four files unchanged.
Tests: the two in that diff (100.02 x 1.5 h x 0.50 / 9 = 8.335 -> 8.34 on OT, night and holiday). Mutant: replace
`premium(...)` with the old `multiply(rate, factor(...))` -> red. Run the whole payroll unit + integration set
and the golden-corpus replay; any golden total that moves must move by at most one centavo, and each is named.

### S3 — money shown or read through `Number()` (DEF-537, 681, 726, 501)
1. DEF-537 `packages/db/src/repo/owners.ts:167,168,173,562,607`: `Number()` on money -> `money()`/centavo helpers
   from `@shareat/core/money`. Test: 14-digit and 0.1+0.2-shaped values come back exact; mutant: `Number` back.
2. DEF-681 `apps/erp/src/app/ap/suppliers/page.tsx:180`, `payroll/separations/page.tsx:157-159`: format with the
   exact peso formatter. Test: render 90071992547409.93 exactly; mutant: `Number` back.
3. DEF-726 `apps/erp/src/app/channel-settlements/SettlementForm.tsx:90,591-602` (confirm path by grep): same
   change, zero checks via `compare(x, ZERO)`.
4. DEF-501 `apps/erp/src/components/money/MoneyLines.tsx:361`: terms 0 renders "0 day terms"; render "due on the
   invoice date". Render test; mutant: template back.
Pins: `t371-numeric-write-guard` if a comparison moves.

### S4 — AP correctness (DEF-505, 507, 531, 532, 404, 449, 627) — auth, Sonnet auditor
1. DEF-505 `packages/domain/src/ap/index.ts` (~998, `recordExpenseForInvoice`): authorize `approve_expense`
   before `createExpense` validates. Test: staff with only `create_expense` is refused with the capability
   sentence and no validation text; mutant: remove the authorize.
2. DEF-507 `ap/index.ts` after `updateSupplier` (~286) + `packages/db/src/audit/catalogue.ts:96`: append a
   `set_supplier_name` audit row when the trimmed name changes. Test: rename audits before/after; same name -> no
   row; mutant: drop the append.
3. DEF-532 `packages/db/src/repo/ap.ts:108` `getSupplierById` gets a `forUpdate` option used by `editSupplier`.
   Test: two-connection concurrent edit, second waits; mutant: drop the lock.
4. DEF-531 `apps/erp/src/app/ap/actions.ts:123-128`: read address/contactNo/notes/vatStatus/status only when
   `fd.has(k)`. Test: a partial form leaves the others and keeps `status`; mutant: restore `|| 'active'`.
5. DEF-404 `repo/ap.ts:771` select `due_date`, `invoice_no`; show them in `AutoAllocatePaymentForm.tsx`. Render
   test with two invoices of different due dates; mutant: drop the field.
6. DEF-449: add `mediumBusinessDate(d)` to `packages/core/src/datetime`; `repo/ap.ts` and the domain human-date
   copy call it. Unit test same output; mutant: inline one copy back (the census of copies goes red).
7. DEF-627 `apps/erp/src/lib/constraint-messages.ts:148`: add `suppliers_org_name_key` -> "Another supplier is
   already called that." Test: duplicate save shows it; mutant: delete the entry.

### S5 — trade and stock returns (DEF-525, 561, 562, 608)
1. DEF-561 `packages/domain/src/trade/returns.ts:563-568`, `trade/index.ts:807-824`: `FOR UPDATE`, re-read status,
   one "already voided" sentence without the uuid. Two-connection test; mutant: remove the re-read.
2. DEF-562/608 `packages/domain/src/stock/supplier-returns.ts:160,162,197,340`: name the line by item name; the
   not-found refusal carries no id and comes after `authorize`. Test: refusal text has no uuid; mutant: id back.
3. DEF-525 `trade/index.ts:572` `dispatchedOn: order.orderDate` -> today's business date (`toBusinessDate()`).
   Before building, read the row: if dispatch-on-order-date is deliberate (back-dated orders), stop and report.
   Test: an order dated last month dispatches today; mutant: `orderDate` back.

### S6 — owners and people: lock and refusal order (DEF-544, 504) — auth/money, Sonnet auditor
1. DEF-544 `packages/domain/src/owners/index.ts:310-324`: parse and `assertMonthOpen` before the lock; re-read the
   owner after `lockOwnerForUpdate`. Two-connection update-vs-drawing test; mutant: remove the re-read.
2. DEF-504 `packages/domain/src/people/index.ts:361,446`: authorize before the "No employment" throw so an unknown
   id and a foreign id get the same refusal (as 61ea2e0 did elsewhere). Test: both refusals equal; mutant:
   restore the order.

### S7 — repos and domain helpers (DEF-510, 542, 425, 367, 439, 554, 411)
1. DEF-510 `packages/db/src/repo/prepaid.ts:362`: the raw `a = x or b like y` sits inside `and(eq(org), ...)`; wrap
   it in `or(eq(...), like(...))` so the org filter binds both. Test: a second org with the same key base never
   appears; mutant: restore the raw `or` (RLS still backstops; run the test as the system role to see it red).
2. DEF-542 `packages/db/src/repo/fiscal-periods.ts:143-150`: delegate to core `addDays(parseBusinessDate(d), ±1)`.
   Test: years 0099/3000 refused as core does; mutant: keep the `Date.UTC` copy.
3. DEF-425 `packages/db/src/repo/position-defaults.ts:165-187`: join `positions` and filter `is_active`. Test: a
   deactivated position grants nothing; mutant: remove the filter.
4. DEF-367 `packages/domain/src/people/position-defaults.ts:440-443`: count people whose effective capability set
   changed, not any grant/revoke. Test: two positions sharing one capability, remove one -> affected 0; mutant:
   any-grant count.
5. DEF-439 `packages/domain/src/findings/index.ts:383`: `closeReadiness` returns not ready when no open period
   exists. Test: a month with no period; mutant: `ready: true` back.
6. DEF-554 `apps/erp/src/app/files/[fileId]/route.ts:38` + `domain/files/index.ts:267`: authorize and read inside
   the transaction, sign the URL after commit. Test: a slow stub signer holds no connection; mutant: sign inside.
7. DEF-411: rename the private `manilaToday` in `recurring-expenses/index.ts:59` and `job.ts:69` to
   `manilaTodayFromClock` so the name is unique; zero-caller census stays green.

### S8 — ERP pages and actions (DEF-609, 566, 514, 468, 635, 280, 533, 271, 253, 255)
1. DEF-609 `apps/erp/src/app/sales-days/[id]/page.tsx:386`: add `&& storeLink` to the recheck button. Render test.
2. DEF-566 `reports/cash-flow/page.tsx:49`: catch `RefusalError`, render its sentence. Test `from=2026-02-30`.
3. DEF-514 `statutory-discounts/page.tsx:38,51-52`: `parseBusinessDate` instead of the regex. Same test shape.
4. DEF-468 `payroll/thirteenth-month/page.tsx:42` `Number(sp.year) ||`: refuse a non-year by name.
5. DEF-635 `setup/page.tsx:5`: use `components/feedback/SubmitButton`; delete `setup/SubmitButton.tsx`.
6. DEF-280 `inventory/transfers/actions.ts:33,64,72`: catch and `redirectWithFlash({ error })` as `:84-96` does.
7. DEF-533 `expenses/actions.ts:257` hard-codes `['create_expense']`: export the domain list and use it. Test:
   a source-scan test that the two lists are one; mutant: add a capability to the domain list only.
8. DEF-271 `components/shell/{AppShell,Sidebar,TopBar}.tsx`: show "Sign out (<display name>)". Render test.
9. DEF-253 `apps/erp/src/app/attendance/lib.ts:85` returns today..today silently with no config: return
   `noPolicy: true`; `attendance/page.tsx:69` shows a banner naming the settings page. Render test.
10. DEF-255 `packages/domain/src/attendance/config.ts:37-42`, `packages/db/schema/attendance-config.ts:118`: fix the two
    false comments ("fails quietly"; "seedAttendanceConfig inserts"). Comment only.
Each item: mutant = revert that line; test red. Pins: action-link-sweep, editable-record, touch-target, PAGES.md.

### S9 — scripts, guards and config (DEF-300, 410, 402, 403, 373, 094, 634, 372, 502, 455, 355, 845)
1. DEF-300 `scripts/bootstrap-org.ts:168`: `transaction` -> `systemTransaction`.
2. DEF-410 `scripts/backfill-fiscal-periods.ts:109`: per-org try/catch, collect failures, exit 1. Test: org 2
   fails, org 3 still runs; mutant: remove the catch.
3. DEF-402/403 `scripts/production-caller-census.mjs:122` (ROOT takes the `--probe` value) and `:87` (JSX text
   counted): skip the arg after `--probe`; strip JSX text; add a `Card` control positive.
4. DEF-373 `scripts/deploy-preflight.ts`: fail when a dev-only variable is set (`FIREBASE_AUTH_EMULATOR_HOST`,
   `NEXT_PUBLIC_FIREBASE_EMULATOR_HOST`). Test each; mutant: empty list.
5. DEF-094 `packages/db/migrate.ts:41-43`: after `migrate()`, compare the journal's last `when` with the max
   `created_at` in `drizzle.__drizzle_migrations`; throw on a skipped entry. Integration test on a fresh DB.
6. DEF-634 `packages/core/src/logger.ts:17,74`: use `pino-pretty` only if it resolves; else JSON. Unit test.
7. DEF-372 `apps/erp/src/lib/terminal/firebase.ts:101`: `if (host && process.env.NODE_ENV !== 'production')`.
   Copy `sign-in-emulator-wiring.test.ts`'s shape; mutant: drop the term.
8. DEF-502 `tests/unit/no-committed-secrets.test.ts:52`: add a 30_000 timeout.
9. DEF-455 `tests/unit/client-bundle-boundary.test.ts:159-164`: use the transitive helper at `:105` for the db
   rule. Plant a client file importing `./lib` that imports `@shareat/db`; mutant: direct-only.
10. DEF-355 `apps/erp/tests/withorgprincipal-chokepoint.test.ts:149-161`: correct the stale reason comment.
11. DEF-845 `apps/erp/next.config.js`: `poweredByHeader: false` and `headers()` with `X-Frame-Options: DENY`,
    `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, HSTS `max-age=31536000`
    (no `includeSubDomains`, no preload). CSP is out (needs testing). Unit test imports the config and asserts
    the four headers on `/(.*)`; mutant: delete one. Smoke: `curl -sI` on the private port.

### S10 — one migration (DEF-415, 548). Number from BOSS before claiming; FULL suite on a fresh gate DB.
Hand-authored per ADR-012 §5, `SET LOCAL lock_timeout = '5s'`.
1. DEF-415: `clock_terminals` revoke-reason check -> `btrim(revoke_reason) <> ''` (pre-check counts blank rows
   and refuses naming them, never rewrites; precedent 0158).
2. DEF-548: `REVOKE DELETE ON trade_orders FROM shareat_app`.
Tests (`packages/db/tests/integration/t598-migration.test.ts`): `'   '` reason refused; app-role DELETE on
`trade_orders` raises 42501; mutants: omit `btrim`, omit the revoke.

### S11 — documents (DEF-375, 526, 335, 154; planner-only: 102, 153, 625)
Builder: `docs/GLOSSARY.md` add owed / remittable / settleable / variance / float / overdraft with
`repo/remittance.ts:99` (DEF-375); `GLOSSARY.md:160` say the admin override (bible row 193) is the only way into a
closed period (DEF-526); `docs/ops/README.md` SESSION_SECRET rotation runbook: revoke, deploy, sign-in again
(DEF-335); `docs/tasks/176-production-and-prep-conversion.md:183` the three figures (DEF-154).
Opus planner, not a builder: bible `PROJECT_BIBLE.md:969` second `### 5.3` -> `5.5` (DEF-102, toc-freshness);
bible `:723` and ADR-002 lines 10-29, 206-212 Cloud SQL -> DigitalOcean Postgres + droplet (DEF-153);
`docs/POSTING-PATTERNS.md:1736-1768` clear to 3300 per row 109, not 3100 (DEF-625).

### S12 — scripts argument parser (DEF-423), last, alone
18 scripts define `arg()` that reads only `--org=`; `--org x` silently runs every org. One shared parser in
`scripts/lib/args.ts` that refuses the space form by name; fix the stale "2 GB" lines in 10 `.service` headers.
Test: `--org x` exits non-zero with the sentence; mutant: accept it.

## 5. Slice R — register clean-up (Opus or Haiku; docs only, one commit)
Mark each row below `fixed` (or `closed — by design` where noted) with the evidence given; the original
text stays (register rule). Also take worktree 2's DEF-841/857 edits. Evidence is main 9892641.
- A-D (rebuild already does the Disposition): 001 0238:27 UNIQUE(terminal,seq) · 002 0238:27 + pos-terminal-links.ts:35 ·
  003 core/money.ts:12 · 005 pos-v2.ts:66 take_out · 006 journal tables 0003 · 007 ADR-003 · 008 bible 4.2 r7 ·
  009 person spine · 010 one stores table · 012/013 no client rules in apps/customer · 014 deploy.yml · 015
  core/production-hosts.ts · 016 key only in etl/capture.ts · 017 use-online-status.ts:5 (T-425) · 018 0003
  triggers · 019 authorize() · 023/024 by design · 025 pos-v1.ts:195 · 038 73927d6 T-368 · 042 audit/groups.ts:25 ·
  043/044 Ian 25 Aug · 048 numeric(14,2) · 050 ADR-008 · 051 RLS + authorize · 052 remittance/actions.ts:70 ·
  059 pos-v1.ts:68 FK · 062 env.ts:122 · 063 9264324 + 6d02b14 · 065 journal_lines rows · 068 a8a3881 · 071 d75a1e7 ·
  072 d75a1e7 · 074 16cfab6 · 075 customers.ts:13 · 076 repo/ap.ts:660 · 077 0044 · 079 bf6741c · 082 9a4e78a ·
  084 5e149a3 · 085 no opening_budget · 093 unit-conversion.ts · 099 payroll recovers 1230 · 100 closed, by design ·
  103 capture.ts:148 · 110 compute-day single path · 116 93408a7 T-199 · 120 6a526cf · 125 trade/index.ts:568 ·
  166 T-209/210 · 191 996220a · 318 employment.ts:32 · 319 position-defaults.ts:111 · 587 0238:27 ·
  588/589 schema/pos-bridge.ts:192.
- E (to DEF-280): 171 lane-health.test.ts:452 · 180 00d75f6 · 182 roles.ts:57 · 192 nav-route-reachability test ·
  195 dad2053 · 197 settings/page.tsx:113 · 200 996220a · 202 trial-balance/page.tsx:39 · 205 0134 · 206 wastage-monitor ·
  207 0133 · 208 0135 · 209/210 7487d91 · 211 T-231 s2 · 214 expenses/lib.ts:60 · 215 getDb gone · 217 0136 ·
  219 4ecc08b · 230 constraint-messages.ts:208 · 233 b911cd6 · 234 5116c66 · 235 ccef651 · 237 fddef02 · 243 3cccd1e ·
  244 eba3c15 · 246 65f232c · 247 users/[personId]/page.tsx:229 · 248 dead class gone · 257 d0efcd9 · 259 d162380 ·
  269 c885b60 · 270 ConfirmDestructive · 274 e619893 · 275 ratified note, close · 276 dev overlay, close ·
  277 33dbd3f · 278 min="0" gone.
- E (284-505): 284 5706a06/6a9ed65/018af6f · 286 f0aebed/627a856 · 288 9d39070 + a381b84 · 304 e00549a · 305 23be5ca ·
  309 7a1e46a · 313 2ed10e5 · 329 e0d0646 · 330 8d61d41 · 348 banners fixed · 350 ROADMAP weeks computed ·
  351 timeout 60_000 · 354 ops README:471 · 358 3601126 · 362 9066147 · 363 37d9011 · 365 120000 ceilings ·
  382 3558e52 · 383 core/money.ts:55 · 384 e62ef27 · 397 money.ts:144-148 · 408 money-input.ts:114 · 414 0159 ·
  418/419 items/index.ts:689 · 421 60a1ee0 · 422 0160 · 438 cutover/purge.ts (T-347) · 440 b08d8c8 ·
  463 int() fallback gone · 466 parseIntList gone · 475 access.ts:974 · 484 f32fb24 · 489 0169/0170.
- E (507-814): 515 7bfccca · 521 ee2ffe1 · 522/523/524 ad08751 · 528 5b8aeb7 · 565 route gone · 586 7a33eea + 7de5232 ·
  594 0213:486 · 628 6e81d7e · 630 1abcb9f · 636 ad427f9 · 640 49d6e05 · 641/642 686c7b2 · 657/658/659/661 d9567d8 ·
  663 e367fe5 · 665/666/667 ad427f9 · 676 28357fa · 677 (both rows) 407f5bc · 680 bible row 380 · 689 loading.tsx ·
  690 ChannelDonut.tsx:33 · 694/696/697/699/700/701/702/708/717 c33ecef family (T-343 S5.5) · 695/703 1aa73d6 ·
  704/705/706/709/710/711/713/714/715/719/720/721 apps/pos T-44x on main (407f5bc, de620ec) · 723/724 4e9a127 ·
  727/728/729 3e7f2b3 · 730 b920839 · 733 9cca215 · 736 126542c · 741 e1192b4 · 806 67f6778 · 807 c3b0075 ·
  808 b5ea3e1 · 809 064247c · 814 5866312.
- 13 Nov audit rows: 833 14a8a4f (T-576) · 834 327891a (T-577) · 836 close, not reachable (rules refuse) ·
  837 23aa479 (T-578) · 838/857 fbc48ab (T-574) · 840/841 428cac3 (T-573) · 843 2335046 + 7c6d83c (T-575) ·
  847 c24fda2 (T-579; the remaining advisories are DEF-718) · 854 closed, by design (bible rows 453-457).
- Change log line: "T-598 R: 207 rows marked from the sweep; 116 C rows listed for Ian; 21 D."

## 6. For Ian (class C) — one question each; recommendation in brackets
Top five first:
1. DEF-850: The health page shows which build is live (needed to check a deploy). Keep it public? [yes; it shows no secret]
2. DEF-250/416: Should production refuse to start without its own system database address? [yes, after a dry run]
3. DEF-078/632: May we install the monthly month-end timer and heartbeats for the 7 silent nightly jobs? [yes]
4. DEF-066: Block a cashier-cash expense once that day's sales are verified, as v1 did? [yes]
5. DEF-190: Which income account does a manually entered credit sale go to? [sales, 4000]
Money and accounting:
- 509/539: When a shortage is later paid in cash, does it close the gap, and which days may a charge settle?
- 060: The POS link keeps its own VAT type beside the company's. Which one is the truth?
- 061: Keep gross-vs-net sales basis parked until the copied POS returns?
- 067: Add a reference number and note to each split payment of an expense?
- 096/155: Add a "prepped" item kind so sliced meat posts to 1330, or keep it in 1310?
- 117: Should open invoices and unposted expenses block month close?
- 124: Is "invoice arrived" per stock batch or per delivery?
- 040: Add a database check that a journal line's party really exists?
- 407: After a full service-charge payout, should a second submit say "already paid"?
- 530: Which lock comes first when a sales day is withdrawn during a handover?
- 585: Create fiscal periods before Oct 2026 now, or when back-dated loads start?
- 595: Package tables never use up stock until ADR-015 P1. Leave it until then?
Security and access:
- 846: Store the server's SSH host key as a GitHub secret (you add the secret)? [yes]
- 861/339: Tighten deploy triggers and stop docs-only pushes restarting production?
- 862: Turn off Android backup in both apps and refuse a debug-key release build?
- 668: Make onboarding documents a sensitive file type with audited, short links?
- 673: The retiring POS shows staff photos by public link. Fix it (security) or let it retire?
- 674: Accept that PNG/WebP photos keep their metadata (cameras send JPEG)?
- 267: Refuse to start if a server secret has stray spaces?
- 369: Should the clock terminal keep a fake emulator mode at all?
- 718: Book a dependency-advisory review (36 advisories, `xlsx` has no fix)?
- 848: Carry the customer app's session/lockout rules into the customer server spec?
- 070, 651, 652: Leave the v1 storage, POS void and POS rules holes until v1 retires?
Production and ops steps only you can take:
- 249/256: Run the attendance-config backfill on production?  · 317: Was the Caddy upload limit raised?
- 336: Create the GitHub token for the CI lag check?  · 340/341: Firebase project step and authorised domain?
- 387/401: Run the elevated install that fixes the dev-server crash?  · 643: Who resets the clock mirror after the 1 Jan purge?
- 026: Rotate the unused OpenAI key in the Website `.env`?  · 660: Close the YANIYOW port clash (folder gone)?
- 672: Close DEF-672 after one clean nightly sweep?  · 245: Accept CI as the only full-suite run and close?
Features to keep, wire or drop:
- 169: Which actions must reach the audit log, and do you want a viewer?
- 173: The cook engine has never run. Keep or park?  · 261/262: Wire or remove `adjudicateRange`, `editPostedProduction`, `applyCredit`?
- 320: Which unused upload types are real (collection proof, memo, wastage dispute, onboarding)?
- 315: Use the app-timezone setting for real, or delete it?  · 443: Can a voided internal order still take messages?
- 011, 020, 021, 022, 342, 343: Website and customer-loyalty items wait for their phases. Agreed?
- 087: Malvar and Banay-Banay real shift hours and grace periods?  · 033: Which v1 cron routes should run?
Engineering choices (one yes covers each line):
- 027 adopt ESLint in CI · 258 repaint 49 dark-mode text classes + guard · 266 schema/ or SQL is the definition ·
  306 a "capped" scheduler outcome · 312 org-first orphan-file index · 316 stock-model change trigger ·
  322 one shared touch-safe link · 356 boot canary for SESSION_SECRET · 381 widen the money census ·
  385 cashier-friendly DB messages · 400 cite anchors not line numbers · 491 same-org FKs before org two ·
  493 boundary guard exempts apps/pos · 254 non-retryable "no config" quarantine · 273 merge two sentences ·
  264 guard for shared-tree commits · 364/390 lane tooling fixes · 268 cap sessions for memory.
Defer or accept (recommend accept; one yes covers all): latent until a caller exists 527, 536, 549, 563, 543, 540;
retiring `apps/pos` non-security 707, 712, 735, 737, 738, 750, 772, 773, 835, 842, 844; until P1 / T-534 /
T-475 / shared Table 751, 752, 832, 855, 745, 743, 851; parked by ruling 092, 263, 265, 693, 417; v1 lessons
and ops 032, 034, 331, 370; v1 CUSTOMER refill 647.

## 7. Order and done
S1-S9 and S11 in parallel (no shared files). S10 after BOSS reserves the number. S12 last. R any time (docs).
Done per slice: its tests + mutants red-then-green, typecheck, guards above, one PR, CI green, Sonnet audit
for S2/S4/S6/S7. After merge, slice R marks the B rows `fixed` with the PR.

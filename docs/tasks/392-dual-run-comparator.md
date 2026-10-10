# T-392: Dual-run comparator, v1 vs v2, per store per week (absorbs T-114b)

**Status:** SPEC DRAFT 2026-10-11 (Opus planner) — awaiting a fresh Opus review (money).
(≈4.5 lane-days, five slices, matching the plan's M-L 4.5.) Migration **0NNN, the next free number at merge**
(0194 is reserved for T-398 S1). Four questions for Ian below; the recommended option is what gets built.

## Goal

**One report per store per week** that says, line by line, where v1 and v2 agree to the centavo, and names every
difference as either a known class or a defect with a register row. Ian signs the dual run on **15 Nov** from it.

The tie set is bible row 303 (plan-q2 = b), and nothing wider: **cash and bank, sales by tender, expenses by
category, AP per supplier**, to the centavo, per store-week. **Inventory and COGS are one named policy difference,
never a failure.** A whole-trial-balance tie is impossible by design (v1 expenses stock on purchase; v2 is perpetual
FIFO, ADR-011) and is out of scope.

## Source

- `docs/plans/remaining-build-plan.md` §1.1 C4, §0b, §2.1 (Lipa double-enters from **Mon 19 Oct**, all four stores
  from **Mon 2 Nov**; first week report by 6 Nov; **15 Nov go/no-go needs ≥ 15 compared trading days, every
  difference classed**), §3.3 (L3, wave 2, M-L 4.5), R5.
- Bible rows **303** (the tie set, encoders and verifiers), **302** (payroll stays on v1 until cutover), **283**
  (v1 owns the goal, not the method), **§1.3** (a v1-vs-v2 accounting difference is a *finding*; v1 is a comparison
  subject, never the oracle), **§1.4**, **§16.2**.
- T-112 (run ledger, landing), T-113 (`leg-mapping.ts`), T-114a (`@shareat/etl-firestore` reader and the read-only
  ERP key), T-117 (corpus), **T-114b** (`packages/etl/src/audit/*`, built `b5ccbed`).
- T-391 S1 (`v1_master_links`, migration 0193): the v1 to v2 key for suppliers. T-391 §Contract: `extract` runs on
  Ian's machine and refuses `NODE_ENV=production`; `run` on the droplet (DEF-634).
- `docs/STORE-ROSTER.md` (four operating stores; Padre Garcia and the two test stores excluded, and the exclusion
  printed), `docs/GLOSSARY.md` (the v1 field traps), `docs/POSTING-PATTERNS.md`, `docs/reviews/v1-audit-2026-08-24.md`.
- v1, read as requirements (`ERP-rebuild/src`, read-only): `types/financial.ts:25-175` (journal leg, sourceTypes,
  account families `cash__cashier|office|staff`, `online__{paymentAccountId}`, `ap__{supplierId}`),
  `lib/financial/ledger/journal-writer.ts:139-262` (void **mutates** the leg to `status: 'voided'`, no offset),
  `lib/actions/sales-report-adjustment.actions.ts:1-25` (a post-verify edit re-posts the same ids, delta on the
  original date), `lib/actions/sales-day.actions.ts:84-297` (sale legs post at verify: cash and online only; channel
  AR is a separate `channel_sales` flow), `lib/financial/journal/builders/{sale,expense,ap-payment,remittance}.builder.ts`,
  `types/index.ts:523-606` (expense: `status 'posted'|'voided'`, `expenseEntryGroup`, `payments[]`, `dayKey`),
  `lib/actions/expense.actions.ts:187-212` (a linked receipt's date **overrides** the expense's `dayKey`),
  `app/api/cron/reconcile/route.ts` + `lib/financial/balancer/balancer.ts:143-200` (v1's own reconcile).

## Research (row 283: research, evaluate, propose)

### v1's goal, and v1's method

v1 has no dual run; its nearest relative is `api/cron/reconcile`: nightly, per store, it compares each `accounts`
counter with Σin − Σout over posted `journal` legs, logs drift of ≥ ₱0.005 to `reconciliationLogs/{date}`, and on
the 1st runs `runStoreTieOut` (GL, AP, AR, loans) into `tieOutLogs`. **Goal:** know when two derivations of the same
money disagree. **Method's flaw:** it compares v1 with itself, logs and never classifies, so a drift is seen every
night and explained never. The T-114b run proved the counters drift (34 of 115 account/store pairs disagree,
`v1-audit-2026-08-24.md` §6). **So the v1 figure in this comparator is always derived from legs and documents,
never from `accounts/`**; the counter appears only as an informational column.

### The industry pattern

**Parallel-run reconciliation** (the "parallel simulation" of systems-conversion audit practice, and what Odoo and
ERPNext implementation partners run before go-live): the old and new systems process the same period; the comparison
is **control totals per period per dimension**, then **exception analysis** on the totals that do not agree, each
exception classified the way a bank reconciliation classifies its reconciling items: **timing** (clears itself),
**permanent / policy** (documented once, carried every period) or **error** (fixed at source, then re-run). Sign-off
is "every exception is explained", not "zero exceptions".

**Adopted:** control totals per store-week per line kind; a closed catalogue of named classes; document-level
candidate matching **only** under a total that does not tie; re-runnable, versioned weekly results; a disposition
that classifies a difference without hiding it (the T-135 findings model: an acknowledged condition is still shown).

**Not adopted, and why:**

| Not doing | Why |
|---|---|
| Whole trial-balance tie | Impossible by design (row 303); turns the sign-off into an argument |
| Transaction-level matching of everything | v1 and v2 documents are typed independently and **share no id**. Matching runs only beneath a total that does not tie |
| Fuzzy / name / ML matching | A guessed match certifies a difference as explained. Candidate keys are exact (store, date, centavos, mapped key) |
| Reading v1's `accounts/` counters as "v1's figure" | They drift (T-114b §6). Shown as information only |
| Correcting either system automatically | The comparator is read-only on v1 and on v2's books. Fixes go through the normal screens, then a re-run |
| An off-the-shelf recon tool (datacompy, dbt `audit_helper`, Great Expectations) | Python/dbt runtimes this repo does not have; the comparison logic is a few hundred lines of pure TS over figures we already parse |
| Reading v1 through the ETL landing table | `etl_source_documents` lands only changed documents, so a **deleted** v1 leg (v1 hard-deletes, DEF-065) stays "current" forever. A dual run needs v1's state *now*. See R2 |

### What is already in the tree (verified 2026-10-11)

1. **T-114b is BUILT, not spec-only** (`b5ccbed`, 24 Aug; `docs/reviews/v1-audit-2026-08-24.md`). The plan's C4 row
   ("T-114b audit report is spec-only and on no board") is stale. Absorbing it here means **reusing** it:
   `parseJournalLeg`, `resolveV1Account`, `accountIdEncodedParty`, `OPERATING_STORES`/`EXCLUDED_STORES`
   (`audit/balances.ts`) and the polarity rule through T-107's `adaptLegacyLegs`. Its open tail (4,145 groups
   *ambiguous*, ₱19.2M, a gap in **our** mapping coverage) is **not** on the dual run's path: the tie set reads
   legs per account and documents per category, never the synthesised nominal leg. It stays T-114b's.
2. `@shareat/etl-firestore` (`client.ts`, `reader.ts`): read-only ERP client from `CAPTURE_ERP_SA_KEY_FILE`, cursor
   paging. Reused as is.
3. `v1_master_links` (0193): `(org, 'supplier', v1_store_id, v1_id) → v2 supplier`. **INSERT-only for the app
   role** (a fact about the load), so it is the wrong home for a mapping Ian may need to correct. Money accounts and
   expense categories have **no** v1 key anywhere in v2 (checked: `money_accounts`, `expense_categories`).
4. bible §1.3 names `docs/decisions/ACCOUNTING-DIVERGENCES.md` as a deliverable; **it does not exist**. This task's
   class catalogue is its seed (R11); the planner writes the doc (outside this task's Scope).

### Where this spec disagrees with the plan or with row 303

1. **Row 303 double-enters expenses and deliveries only. A cash-and-bank tie and an AP-per-supplier tie need more:**
   a v1 supplier payment, remittance, transfer, cash-request release or salary advance moves cash or AP, and if it
   is not entered in v2 the week cannot tie. Q1 decides the scope; the comparator handles either answer by
   classing out-of-scope flows by v1 `sourceType` (R6).
2. **"≥ 15 compared trading days" is reachable only for Lipa by 15 Nov.** The other three start 2 Nov; 2-14 Nov is
   **13** days, and 15 Nov's own sales import at 06:00 on 16 Nov. If the gate means per store, it fails for three
   stores on the calendar alone. Q4 asks; the recommendation is "≥ 15 in total and ≥ 10 per store".

## Rulings

| # | Ruling |
|---|---|
| R1 | **Week = Monday to Sunday, Manila business dates** (19 Oct and 2 Nov are Mondays). A run may stop early (`--through`), so a week-to-date report exists; the report shows its `through` date. |
| R2 | **v1 is read fresh from Firestore for each run, not from the landing table.** The four operating stores, collections `journal`, `expenses`, `salesDays`, plus `suppliers` and the store's payment accounts for labels only. Whole collections are paged (≈ 25k docs, cents of read cost) and filtered client-side to `[weekStart − 7, through + 7]` so a date shift across a week boundary can be seen. **Field whitelist** in `snapshot.ts`; no staff names, no contact data; `employeeId`, `staffId` are dropped. |
| R3 | **Credentials stay on Ian's machine (Q2 a).** `extract` refuses `NODE_ENV=production` and writes `v1-dual-run-<from>-<through>.json` + `.sha256` (no key material in any output). `compare` runs on the droplet as `sudo -u shareat env NODE_ENV=production npm run dual-run -- compare …` (DEF-634), reading the snapshot file and production. The orchestrator can run both steps (scp between them); Ian's hands are not needed. |
| R4 | **The v1 figure comes from legs and documents, never counters.** Legs: `status == 'posted'` only (a voided leg is still in the collection). Polarity through `adaptLegacyLegs`. Documents: `expenses.status == 'posted'`; `salesDays.status` in `verified|partially_remitted|remitted` (`submitted` is a legacy `open`). |
| R5 | **The v2 figure comes from the posted ledger only** (bible row 118): `journal_lines` joined to `journal_entries` by `entry_date` in the week, `store_id` = the store. A draft, unverified or unposted v2 document contributes nothing and is surfaced by matching (class `PENDING_V2`). |
| R6 | **Tie-set line kinds and their keys** (§Contract 2). Out-of-scope v1 flows are classed by `sourceType`, never silently dropped: every posted leg in the window lands in exactly one line or one named class. |
| R7 | **Crosswalk = `dual-run-keys.csv`, per org**, pre-filled by `extract` (every v1 payment account and expense entry seen, with a suggested v2 money account / category by exact normalised name) and ticked by Ian (Q3). Its sha256 is stored on each report. Suppliers come from `v1_master_links`; a v1 supplier with no link is a line keyed `v1:<id>` classed `UNMAPPED_KEY`. Stores map by `stores.legacy_code`. |
| R8 | **Idempotent weekly runs.** A report version is identified by `(org, store, week_start, through, v1_snapshot_sha, keys_sha, v2_fingerprint)` where `v2_fingerprint` is sha256 over the sorted v2 figures. Same identity: no insert, exit 0, "unchanged". Anything changed: a **new version**; the latest by `created_at` is current (a query, no `is_current` flag, as `etl_source_documents`). Versions are never updated or deleted. Re-running any past week is normal: v1 restates in place (edits re-post on the original date, voids mutate). |
| R9 | **Candidate matching beneath a non-tying total only.** Documents in that line, both sides, greedy one-to-one on `(store, business_date, centavos, mapped key)`, deterministic order (date, centavos, id). Then relaxed passes, each producing a named class: same centavos and key, other date within ±7 → `DATE_SHIFT`; same date and key, other centavos → `KEYING_DIFFERENCE`; same date and centavos, other key in the same kind → `MISCLASSIFIED`; v1 only, in double-entry scope → `NOT_DOUBLE_ENTERED`; v2 document unposted → `PENDING_V2`. Whatever is left is `UNEXPLAINED`. |
| R10 | **Dispositions classify; they never hide.** A person (the orchestrator via CLI, or an admin on screen) records `class` + `ref` (`DEF-nnn` required for `V1_DEFECT` / `V2_DEFECT`) + note against `(store, week_start, line_key)` and the delta at that moment. It applies to later versions **only while the delta is unchanged to the centavo**; otherwise the line shows "re-check" and counts as `UNEXPLAINED`. Append-only; the latest live one wins. |
| R11 | **The class catalogue is closed and lives in one file** (`packages/etl/src/dual-run/classes.ts`): code, family (`tie`, `policy`, `timing`, `encoder`, `defect`, `scope`, `open`), one-line meaning, its authority (bible row / ADR / glossary). A line's class is never derived by matching prose. |
| R12 | **Verdict per store-week:** `ties` (every tie-set line Δ = 0) · `explained` (every Δ ≠ 0 line is `policy`, `scope`, `defect` with a ref, or `timing` dated within the last 2 days of `through`) · `open` (anything else). **Signable dual run = every compared store-week `ties` or `explained` (Q4).** |
| R13 | **A compared trading day** = a store-date where v1 has a posted-status salesDay, v2 has a posted sales day, and the report covering it is not `open` on any line of that date. Counted per store and in total on the pack. |
| R14 | **A defect becomes a register row the normal way** (RULES §3, three doors): v1 wrong → `DEFECTS-REGISTER.md` A-D with `file:line`; v2 wrong → section E. The disposition carries the `DEF-nnn`; the comparator never writes the register. A `V2_DEFECT` line is also a C6 open-defect-list entry for the go/no-go pack. |

## The class catalogue (seed; R11)

| Code | Family | Meaning | Authority |
|---|---|---|---|
| `TIES` | tie | Δ = 0 to the centavo | row 303 |
| `INVENTORY_BASIS` | policy | v1 expenses stock on purchase (COGS-group expense, no inventory asset); v2 debits `1310`/GRNI and recognises COGS at usage, FIFO. Shown as one line per store-week: v1 COGS-group spend vs v2 inventory receipts, and v1 "COGS" vs v2 COGS, with Δ = change in v2 inventory | row 303, ADR-011, §16.11 |
| `PAYROLL_ON_V1` | scope | Payroll payout and salary-expense legs (`payroll_payout`, `payroll_salary_expense`) exist in v1 only until cutover | row 302 |
| `NOT_IN_DUAL_RUN_SCOPE` | scope | A v1 `sourceType` outside the double-entry scope Q1 sets (e.g. `depreciation`, `amortization`, `loan_*`, and per Q1 `remittance`, `transfer`, `cash_request_*`) | row 303, Q1 |
| `V2_ONLY_EVENT` | policy | A v2 posting with no v1 equivalent (supplier return/credit, channel-settlement fees, service-charge float) | rows 166, T-150 |
| `V1_CASH_RESIDUAL` | policy | v1's cash tender is `remitted − online − credit − other`, **floored at 0**; a negative residual is hidden in v1 and visible in v2 | GLOSSARY `cashPayments` |
| `CHANNEL_AR_FLOW` | timing | v1 posts non-remitted channel sales through a separate `channel_sales` flow keyed by sales date; v2 posts them inside the sales day to `1220`. **S2 proves it on a fixture or removes it** | v1 `sales-day.actions.ts:270-297` |
| `PENDING_V2` / `PENDING_V1` | timing | The other side's document exists but is not posted / verified yet | R9 |
| `DATE_SHIFT` | timing | Same document, different business date (v1's receipt date overrides `dayKey`) | R9 |
| `NOT_DOUBLE_ENTERED` | encoder | In scope, v1 only, no candidate in v2 | row 303 |
| `KEYING_DIFFERENCE` | encoder | Candidate found, centavos differ | R9 |
| `MISCLASSIFIED` | encoder | Same centavos under another category / supplier / money account | R9 |
| `UNMAPPED_KEY` | encoder | A v1 key with no crosswalk row or `v1_master_links` link | R7 |
| `V1_DEFECT` / `V2_DEFECT` | defect | By disposition only, with `DEF-nnn` | R10, R14 |
| `UNEXPLAINED` | open | Default. Blocks sign-off | R12 |

Informational columns, never a class: `v1_counter` (v1's `accounts/` balance at `through`) and `opening_gap` (the
v1 balance before `week_start`; v2 has no opening during the pilot, which is why money lines compare **movements**).

## Contract

### 1. Command (`scripts/dual-run.ts`, `npm run dual-run`)

```
npm run dual-run -- extract --from 2026-10-19 --through 2026-10-25 --out <dir> [--stores LIPA,MLVR]   # Ian's machine; refuses NODE_ENV=production
npm run dual-run -- compare --snapshot <dir>/v1-dual-run-….json --keys <dir>/dual-run-keys.csv \
    --org <uuid> --actor <person uuid> [--stores LIPA] [--apply]                                    # droplet
npm run dual-run -- classify --org <uuid> --actor <uuid> --store LIPA --week 2026-10-19 \
    --line <line_key> --class V1_DEFECT --ref DEF-640 --note "…"                                    # droplet
```

- `extract` prints the store count beside the list (STORE-ROSTER rule), per-collection counts, the window, the
  sha; writes the snapshot, its `.sha256`, and `dual-run-keys.csv` (pre-filled rows added, ticked rows kept).
- `compare` without `--apply` prints the per-store-week verdicts and the line table and writes nothing. With
  `--apply` it writes one report version per store-week (R8) under an advisory lock, and one `audit_log` row per
  run (actor, snapshot sha, keys sha, counts). Exit **0** all `ties`/`explained`, **2** some `open` (not a
  failure), **1** error or refusal (unknown store, snapshot sha mismatch, keys sheet invalid, snapshot older than
  the latest applied version's for that week).
- No credential, key or token is ever printed or written.

### 2. Line kinds (R6)

| Kind | v1 side | v2 side | Key |
|---|---|---|---|
| `cash_bank` | Net movement (in − out) per v1 money account (`cash__cashier`, `cash__office`, `cash__staff`, `online__{id}`) over posted legs in the week, **in-scope sourceTypes only**; gross in and gross out shown | Net movement on the crosswalked `money_accounts` row's lines | crosswalk money account |
| `sales_tender` | Per verified salesDay: `onlineBreakdown[acct]` per wallet, cash from the `sale` legs on `cash__cashier` (not the floored field), `creditSales`, `otherPaymentSales` | Debits per money account / receivable on posted `sales_day` entries | crosswalk money account, or `credit` / `other` |
| `expense_category` | Posted expenses by `dayKey`, `expenseEntryGroup` ≠ `COGS`, per v1 expense entry | Posted expense lines per `expense_categories` row | crosswalk category |
| `ap_supplier` | Per supplier: incurred (IN on `ap__{sid}`) and paid (OUT) over posted legs | `2110` lines with `party_type = 'supplier'`, credits and debits | `v1_master_links` supplier |
| `inventory_basis` | COGS-group spend | `1310` + GRNI receipts; COGS | store (one line, always `INVENTORY_BASIS`) |

Every amount is integer centavos in code, `numeric(14,2)` in the database; v1 floats go through
`moneyFromLegacyFloat` (DEF-046/047), and a sub-centavo v1 value is reported, never rounded silently.

### 3. Migration 0NNN (S3, hand-authored, ADR-012 §5)

`dual_run_reports` (id, org_id, store_id, week_start date, through date, v1_snapshot_sha, keys_sha, v2_fingerprint,
v1_extracted_at, verdict `ties|explained|open`, compared_days int, created_by, created_at; unique on the R8
identity; CHECK `week_start` is a Monday, `through` within the week) · `dual_run_lines` (report_id FK, kind, line_key,
label, v1_amount, v2_amount, delta, class, auto_reason, per-day deltas `jsonb`, v1_counter, opening_gap; unique
`(report_id, kind, line_key)`; CHECK delta = v2 − v1, class in the catalogue) · `dual_run_dispositions` (org,
store, week_start, line_key, delta_at, class, ref, note, created_by, created_at; CHECK ref matches `^DEF-[0-9]+$`
when class is a defect). All three: RLS ENABLE + FORCE, org isolation, app role **SELECT, INSERT only**. Classified
in `classification.ts` as **purge, notBefore 2027-01-31** (the dual run is pilot data, ADR-007, but it is the 15 Nov
evidence, as `etl_*`) and registered in `rls/registry.ts`.

### 4. Screens (S5)

`/reports/dual-run`: one row per store-week (current version), verdict chip, compared days, Δ count by family;
a **Go/no-go pack** view (all store-weeks, compared days per store and total, class totals in pesos, every
`V2_DEFECT` ref, printable). `/reports/dual-run/[store]/[week]`: lines grouped by kind, v1 / v2 / Δ / class, per-day
deltas, version history ("v1 changed since last version"). Read: `view_financial_reports`. Recording a disposition:
**`run_cutover`** (existing; no new capability). 375 px wide, the reports family's components.

## Invariants (the tests prove each; a mutant named per leg)

**v1 figures (S1, pure)**
1. A voided leg and a voided expense contribute nothing. *Mutant: no status filter.*
2. Polarity comes from `adaptLegacyLegs`; `ap__` is credit-nature. *Mutant: raw `direction` sign.*
3. An expense with a linked receipt lands on the receipt date. *Mutant: `createdAt` date.*
4. Cash tender is read from `sale` legs, not the floored doc field; a fixture with a negative residual shows the
   difference. *Mutant: `cashPayments`.*
5. A salesDay `submitted` is not a sale. *Mutant: `submitted` treated as verified.*
6. Week boundary: Sunday 23:59 Manila is in the week, Monday 00:00 is not. *Mutant: UTC dates.*
7. Padre Garcia and the test stores are excluded **and named** in the output. *Mutant: silent exclusion.*
8. The whitelist: no staff name, `employeeId` or contact field in the snapshot. *Mutant: whole payload kept.*
9. Every posted leg in the window lands in exactly one line or one scope class (Σ in = Σ out of the classifier).
   *Mutant: an unknown `sourceType` dropped.*

**Comparator (S2, pure)**
10. Equal figures give `TIES` and no candidate run. *Mutant: matching always runs.*
11. Each relaxed pass yields its class (R9) on a fixture built for it, and a document is matched at most once.
    *Mutants: two-to-one match; `DATE_SHIFT` window unbounded.*
12. Deterministic: shuffled input gives the same lines and the same fingerprint. *Mutant: insertion order.*
13. `INVENTORY_BASIS` never counts toward `open`. `UNEXPLAINED` always does. *Mutant: policy counted open.*
14. Verdict rules R12, including `timing` older than 2 days before `through` → `open`. *Mutant: timing always ok.*
15. A disposition applies only while the delta is unchanged; a changed delta re-opens the line. *Mutant: keyed on
    line_key alone.*
16. `UNMAPPED_KEY` for a v1 supplier with no link, never a silent merge into another supplier.

**v2 figures and storage (S3, real Postgres)**
17. Only posted entries count; a draft expense and an unverified sales day contribute nothing. *Mutant: from
    documents.*
18. Store scoping: another store's and another org's lines never appear (RLS org B sees nothing). *Mutant: no
    `store_id` filter.*
19. Append-only: the app role cannot UPDATE or DELETE any of the three tables; CHECKs refuse a non-Monday week, a
    bad class, a defect without a ref.

**Run (S4)**
20. Same inputs twice: the second `--apply` inserts nothing and says "unchanged". One centavo changed in v2: a new
    version, the old one intact. *Mutant: upsert.*
21. Dry run writes nothing and prints what `--apply` writes.
22. `extract` refuses `NODE_ENV=production`; `compare` refuses a snapshot whose sha does not match its file, and an
    older snapshot than the week's latest version. Neither prints key material (fake key, grep the output).
23. A Firestore fake with a leg deleted between two extracts: the second report no longer counts it. *Mutant: read
    through the landing table.*

**Screens (S5)**
24. A manager without `run_cutover` cannot record a disposition (server action refused, `authorize` ✗ fires); with
    `view_financial_reports` only, the pages render read-only. Smoketested on 9008 at 375 px.

## Slices

| Slice | What | TESTER writes (first) | BUILDER owns | Size |
|---|---|---|---|---|
| **S1** | Snapshot shape + whitelist, week maths, v1 figures per line kind, keys sheet parse/pre-fill, shared types | `packages/etl/tests/t392-s1-v1-figures.test.ts`, `packages/etl/tests/fixtures/t392-v1-snapshot.json` (synthetic, invented names, every trap above present) | `packages/etl/src/dual-run/{types,snapshot,week,v1-figures,keys,index}.ts`, `packages/etl/src/index.ts` (one export line) | 1.0 |
| **S3** | Migration, schema, RLS, classification, repo: v2 figures query and the three inserts | `packages/domain/tests/integration/t392-s3-v2-figures.test.ts` | `packages/db/migrations/0NNN_t392_dual_run.sql` + `meta/_journal.json`, `packages/db/schema/{dual-run.ts,index.ts}`, `packages/db/src/repo/{dual-run.ts,index.ts}`, `packages/db/src/rls/registry.ts`, `packages/db/src/cutover/classification.ts` | 1.0 |
| **S2** | Class catalogue, candidate matching, compare, verdict, compared days | `packages/etl/tests/t392-s2-compare.test.ts` | `packages/etl/src/dual-run/{classes,match,compare,verdict}.ts` | 0.75 |
| **S4** | CLI `extract` / `compare` / `classify`, domain orchestration (lock, idempotence, audit row) | `packages/etl/tests/t392-s4-extract.test.ts` (Firestore fake), `packages/domain/tests/integration/t392-s4-run.test.ts` | `scripts/dual-run.ts`, `scripts/lib/dual-run-extract.ts`, `packages/domain/src/dual-run/index.ts`, `packages/domain/src/index.ts` (one line), `package.json` (one script line) | 0.75 |
| **S5** | Screens and the disposition action | `packages/domain/tests/integration/t392-s5-disposition-authz.test.ts`, `apps/erp/tests/t392-s5-dual-run-page.test.tsx` | `apps/erp/src/app/reports/dual-run/**`, the reports nav entry in `apps/erp/src/app/reports/lib.ts` | 1.0 |

**S1 and S3 run in parallel** (no shared path, no shared DB: S1 is pure). S2 needs S1's `types.ts`. S4 needs S2 and
S3. S5 needs S3 and S4's domain module. **Dates:** S1+S3 by 22 Oct, S2 by 24 Oct, S4 by 28 Oct, so **Lipa's first
two weeks report by 28 Oct** (ahead of the plan's 6 Nov line), S5 by 4 Nov. Until S5 lands, `compare` prints the
report and the orchestrator posts it to Ian's board. S3 carries a migration: its own PR, or a precheck with Ian
before wrap-up (row 296); full suite on a fresh gate DB.

## Questions for Ian (Open Questions page; the recommended option is built)

| Id | Question | Options | Recommended |
|---|---|---|---|
| **t392-q1** | Cash and AP cannot tie unless every money movement is in v2. Row 303 double-enters expenses and deliveries. What else does the encoder enter in v2 during the dual run? | (a) everything that moves cash, bank or AP: supplier payments, remittances, transfers, cash requests, advances · (b) **expenses, deliveries and supplier payments**; remittances, transfers and cash requests stay v1-only and are shown as "not in dual-run scope" · (c) row 303 as written; AP payments and all other movements out of scope | **(b).** AP per supplier needs payments (weekly, few). Remittances and transfers are daily and move money between your own accounts: tying the sales and expense flows to the centavo proves the books without doubling the cashier's work. |
| **t392-q2** | Where is v1 read from? | (a) **your machine** (the read-only key never leaves it); the comparison runs on the server; the orchestrator does both steps · (b) the read-only key goes on the server and a timer runs every Monday 07:00 | **(a).** Same as the master-data load. Switch to (b) later if you want Monday reports with your laptop off; it is one config change. |
| **t392-q3** | v1's wallets and expense entries must be matched once to v2's (e.g. "GCash Lipa" to "GCash — Lipa cashier"). Who? | (a) **pre-filled by name; you tick or correct a sheet per store** · (b) you fill it from blank | **(a).** About 10 wallets and 40 expense entries per store. |
| **t392-q4** | "≥ 15 compared trading days" by 15 Nov: in total or per store? Malvar, Banay-Banay and Davao start 2 Nov, so they have 13 days by 14 Nov. | (a) **≥ 15 in total and ≥ 10 per store**, every week tied or explained · (b) ≥ 15 per store (the three stores' go/no-go then moves to 18 Nov) · (c) Lipa's ≥ 15 alone | **(a).** Lipa carries the depth (27 days); the other three prove the setup works at each store. |

## Risks to 15 Nov

1. **T-391 S4 late** → no v2 suppliers → no AP tie for those days (every line `UNMAPPED_KEY`). Mitigation: S4 is
   in T-391's 17 Oct path; the comparator still reports the other three kinds.
2. **Verification lag in v2** (row 303: verify is human) → `PENDING_V2` piles up; anything older than 2 days is
   `open` (R12). The pack is run on the morning of 15 Nov through 14 Nov; a lagging manager costs compared days.
3. **v1 restates past weeks** (edits re-post on the original date; voids mutate) → a "tied" week can re-open on a
   later run. That is correct behaviour; every week in the pack is re-run on 15 Nov.
4. **Q1 unanswered by 19 Oct** → the encoder's habits form without supplier payments; AP lines for Lipa's first
   week fall to `NOT_DOUBLE_ENTERED`.
5. **The key on Ian's machine** (Q2 a) → a run needs it present; if the laptop is away on 15 Nov, the pack is the
   last applied versions.
6. **The calendar** (Q4): per-store 15 days is unreachable for three stores by 14 Nov.

## Out of scope

Any change to v1 or to v2 posting · whole-TB comparison · T-114b's ambiguous-mapping tail · the
`ACCOUNTING-DIVERGENCES.md` doc and any bible or plan edit (the planner's; R11 seeds it) · Padre Garcia (not
dual-running) · payroll comparison (row 302) · a timer (Q2 b would add one unit file later).

## Done when

- [ ] All 24 invariants pass, each red leg shown red on HEAD or against its mutant.
- [ ] typecheck clean · affected tests locally · the full suite green in CI on the PR · `build` with the dev server
      stopped · smoketested on 9008 at 375 px.
- [ ] **Run against real data:** Lipa's week of 19 Oct extracted and compared on production, and its verdict, line
      count by class and top 5 deltas reported. *The report against real data is the deliverable, not the code.*
- [ ] Any spec defect reported, not worked around.

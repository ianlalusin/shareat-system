# T-392: Dual-run comparator, v1 vs v2, per store per week (absorbs T-114b)

**Status:** S1, S2 DONE (on main). **S3 BUILT** 2026-10-12 on `lane/t392-s3` (`5eb5c7b`, pushed; migration **0195**; integration 102/102 on a fresh DB). It sits on lane/t398-s1 (0194) and **merges after PR #20**. Two Opus rulings rounds and the money audit applied (see the S3 rulings sections at the end). Repo functions insertReport/insertDisposition/linesOf/v2Figures have test callers only until S4/S5. Next: S4 (CLI + domain run), S5 (screens). | Earlier: SPEC APPROVED WITH CHANGES 2026-10-11 (fresh Opus review applied). Drafted 2026-10-11 by the Opus planner.
(≈5.5 lane-days, five slices; the plan says M-L 4.5, see §Research "Where this spec disagrees".) Migration **0NNN,
the next free number at merge** (0194 is reserved for T-398 S1). Five questions for Ian below; the recommended option
is what gets built.

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
  printed), `docs/GLOSSARY.md` (the v1 field traps), `docs/POSTING-PATTERNS.md` (`expense.credit.ap`,
  `ap_payment.overpayment`, `supplier.credit-applied`, `sale.pos-correction`), `docs/reviews/v1-audit-2026-08-24.md`.
- v1, read as requirements (`ERP-rebuild/src`, read-only): `types/financial.ts:25-175` (journal leg, sourceTypes,
  account families `cash__cashier|office|staff`, `online__{paymentAccountId}`, `ap__{supplierId}`,
  `supplier_advance__{supplierId}`), `lib/financial/ledger/journal-writer.ts:139-262` (void **mutates** the leg to
  `status: 'voided'`, no offset), `lib/actions/sales-report-adjustment.actions.ts:1-25` (a post-verify edit re-posts
  the same ids with new amounts, delta on the original date), `lib/actions/sales-day.actions.ts:84-297` (sale legs
  post at verify; channel AR is a separate `channel_sales` flow), `lib/financial/journal/builders/sale.builder.ts:24-37`
  (**the `cash:cashier` leg's amount IS `salesDay.cashPayments`**, the floored residual),
  `.../{expense,ap-payment,remittance}.builder.ts`, `types/index.ts:523-606` (expense: `status 'posted'|'voided'`,
  `expenseEntryGroup`, `payments[]`, `dayKey`), `types/index.ts:1191` (salesDay status union **includes
  `partially_remitted`**, verified 2026-10-11), `lib/actions/expense.actions.ts:187-212` (a linked receipt's date
  **overrides** the expense's `dayKey`), `app/api/cron/reconcile/route.ts` + `lib/financial/balancer/balancer.ts:143-200`.

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
   role** (a fact about the load), so it is the wrong home for a mapping Ian may need to correct. **Stores, money
   accounts and expense categories have no v1 key anywhere in v2** (checked: `stores` has `code` but no legacy id;
   `money_accounts`, `expense_categories` have none). Hence the keys sheet (R7).
4. v2 money: `journal_lines` carries `store_id` and `party_type`/`party_id`, with `party_type = 'money_account'`
   naming the wallet; `money_accounts.gl_account_code` + `custodian` (`cashier|office|staff`). Reversals:
   `journal_entries.status 'reversed'` and `reversal_of_entry_id`.
5. bible §1.3 names `docs/decisions/ACCOUNTING-DIVERGENCES.md` as a deliverable; **it does not exist**. This task's
   class catalogue is its seed (R11); the planner writes the doc (outside this task's Scope).

### Where this spec disagrees with the plan or with row 303

1. **Row 303 double-enters expenses and deliveries only. A cash-and-bank tie and an AP-per-supplier tie need more:**
   AP *incurred* never ties unless the encoder also records the **supplier invoice** in v2 (v2 incurs AP at the
   invoice, not at the delivery), and AP *paid* and cash never tie without supplier payments. Q1 decides the scope;
   the comparator handles any answer by classing out-of-scope flows by v1 `sourceType` (R6).
2. **"≥ 15 compared trading days" is reachable only for Lipa by 15 Nov.** The other three start 2 Nov; 2-14 Nov is
   **13** days, and 15 Nov's own sales import at 06:00 on 16 Nov. Q4 asks.
3. **Size 5.5, not 4.5.** The review added a store key sheet, v2 correction dating, per-day line states, the cash
   residual rule and on-screen-only dispositions; each is a real money or sign-off risk, so none is cut.

## Rulings

| # | Ruling |
|---|---|
| R1 | **Week = Monday to Sunday.** Every date is a **Manila business-date string `YYYY-MM-DD`**: v1 leg `businessDate` (normalised by v1's own `toBusinessDate`, legacy `YYYYMMDD` accepted), v1 expense `dayKey`, v1 salesDay doc id; v2 `journal_entries.entry_date`, `business_date`. **No timestamp (`createdAt`, `createdAtMs`, `receivedAt`) is ever used to place a figure in a week.** A run may stop early (`--through`); the report shows its `through` date. |
| R2 | **v1 is read fresh from Firestore for each run, not from the landing table.** The four operating stores, collections `journal`, `expenses`, `salesDays`, plus `suppliers` and the store's payment accounts for labels only. Whole collections are paged (≈ 25k docs, cents of read cost) and filtered client-side to `[weekStart − 7, through + 7]` so a date shift across a week boundary can be seen. **Field whitelist** in `snapshot.ts`; no staff names, no contact data, no free text (`particulars`, payee, `memo`, `notes`), and `employeeId`, `staffId`, `payments[].staffId` are dropped. |
| R3 | **Credentials stay on Ian's machine (Q2 a).** `extract` refuses `NODE_ENV=production` and writes `v1-dual-run-<from>-<through>.json` + `.sha256` (no key material in any output). The snapshot is copied to **`/srv/shareat-shared/dual-run/`** on the droplet, `chmod 600`, owner `shareat`; `compare` refuses a snapshot whose mode is wider than `600` or whose owner is not the running user, and **deletes the snapshot after a successful `--apply`** (the sha stays on the report as provenance). `compare` runs as `sudo -u shareat env NODE_ENV=production npm run dual-run -- compare …` (DEF-634). The orchestrator can run both steps. |
| R4 | **The v1 figure comes from legs and documents, never counters.** Legs: `status == 'posted'` only. Polarity through `adaptLegacyLegs`. Documents: `expenses.status == 'posted'`; `salesDays.status` in `verified|partially_remitted|remitted` (all three in v1's union, `types/index.ts:1191`); `submitted` is a legacy `open` and is not a sale. |
| R5 | **The v2 figure comes from the posted ledger only** (bible row 118): `journal_lines` joined to `journal_entries` with `status = 'posted'` (a `reversed` original and its reversal both count, so they net), `entry_date` in the week. A draft, unverified or unposted v2 document contributes nothing and is surfaced by matching (`PENDING_V2`). **A v2 line with `store_id` null in the week on a tie-set account is counted on a named `unassigned_store` line per org-week and shown on every store's report of that week; it is never dropped.** |
| R5a | **v2 corrections take the source document's date.** For `sales_tender` and `expense_category`, a posted v2 entry that corrects or reverses another (`reversal_of_entry_id` set, or same `source_type`/`source_id` as an earlier entry, e.g. `sale.pos-correction`) is placed on the **original** document's business date, as v1 places its restatement. Where the original cannot be resolved, the entry stays on its own date and is paired with its source as `V2_CORRECTION_DATED_LATER` (timing, paired). `cash_bank` and `ap_supplier` use the entry's own date on both sides (money moves when it moves). |
| R6 | **Tie-set line kinds and their keys** (§Contract 2). Out-of-scope v1 flows are classed by `sourceType`, never silently dropped: every posted leg in the window lands in exactly one line or one named class. |
| R7 | **Crosswalk = `dual-run-keys.csv`, per org, three sections:** `store` (v1 storeId → v2 `stores.code`), `money` (v1 `cash__*` / `online__{id}` per store → v2 GL code or money account), `category` (v1 expense entry → v2 `expense_categories` row). `extract` pre-fills every key seen with a suggested v2 match by exact normalised name; **Ian ticks** (Q3). Its sha256 is stored on each report. **A v1 operating store with no ticked `store` row refuses the run (exit 1).** Suppliers come from `v1_master_links`; a v1 supplier with no link is a line keyed `v1:<id>` classed `UNMAPPED_KEY`. |
| R8 | **Idempotent weekly runs.** A report version is identified by `(org, store, week_start, through, v1_fingerprint, keys_sha, v2_fingerprint)`, each fingerprint = sha256 over that side's **sorted figures** (and matched documents). The snapshot file's sha is **provenance only**: two extracts of an unchanged v1 give the same identity. Same identity: no insert, exit 0, "unchanged". Anything changed: a **new version**; the latest by `created_at` is current (a query, no `is_current` flag). Versions are never updated or deleted. Re-running any past week is normal: v1 restates in place. |
| R9 | **Candidate matching beneath a non-tying total only.** Documents in that line, both sides, greedy one-to-one on `(store, business_date, centavos, mapped key)`, deterministic order (date, centavos, id). Relaxed passes, each producing a named class: same centavos and key, other date within ±7 → `DATE_SHIFT` (paired); same date and key, other centavos → `KEYING_DIFFERENCE`; same date and centavos, other key in the same kind → `MISCLASSIFIED`; v1 only, in double-entry scope → `NOT_DOUBLE_ENTERED`; the other side's document exists but is unposted → `PENDING_V2` / `PENDING_V1` (unpaired). Whatever is left is `UNEXPLAINED`. |
| R10 | **Dispositions are recorded ON SCREEN ONLY, by a `run_cutover` holder (Ian; orchestrator ruling 2026-10-11).** The CLI never records one and has no subcommand for it. A disposition may assign **only `V1_DEFECT` or `V2_DEFECT`, with a `DEF-nnn` ref**; policy and scope classes (`INVENTORY_BASIS`, `NOT_IN_DUAL_RUN_SCOPE`, `PAYROLL_ON_V1`, `V2_ONLY_EVENT`, `V1_CASH_RESIDUAL`, `SUPPLIER_ADVANCE_1240`) are assigned by rule only, never by a person. Key: `(org_id, store_id, week_start, kind, line_key)` plus the delta at that moment. It applies to later versions **only while the delta is unchanged to the centavo**; otherwise the line shows "re-check" and counts as `UNEXPLAINED`. Append-only; the latest wins. |
| R11 | **The class catalogue is closed and lives in one file** (`packages/etl/src/dual-run/classes.ts`): code, family (`tie`, `policy`, `timing`, `encoder`, `defect`, `scope`, `open`), one-line meaning, its authority. A line's class is never derived by matching prose. |
| R12 | **Verdict per store-week:** `no_data` (0 compared days: never counted toward sign-off, never `ties`) · `ties` (every tie-set line Δ = 0) · `explained` (every Δ ≠ 0 line is `policy`, `scope`, `defect` with a ref, a **paired** `timing` class (`DATE_SHIFT`, `AP_AT_INVOICE`, `V2_CORRECTION_DATED_LATER`, `CHANNEL_AR_FLOW`), or an **unpaired** `PENDING_V1`/`PENDING_V2` whose document date is within the last 2 days of `through`) · `open` (anything else). A pair whose two documents are both present is explained wherever the week boundary falls. **Signable dual run = every store-week with data is `ties` or `explained`, and Q4's day count is met.** |
| R13 | **Per-day line state and compared trading day.** For each line and day: `tied` if the per-day Δ = 0, `classed` if not but the week line's class is non-open, else `open`. A **compared trading day** = a store-date where v1 has a salesDay in an R4 status, v2 has a posted sales day, **and** at least one tie-set line has a figure on that date, and no line is `open` on that date. Counted per store and in total on the pack. |
| R14 | **A defect becomes a register row the normal way** (RULES §3, three doors): v1 wrong → `DEFECTS-REGISTER.md` A-D with `file:line`; v2 wrong → section E. The disposition carries the `DEF-nnn`; the comparator never writes the register. A `V2_DEFECT` line is also a C6 open-defect-list entry for the go/no-go pack. |

## The class catalogue (seed; R11)

| Code | Family | Meaning | Authority |
|---|---|---|---|
| `TIES` | tie | Δ = 0 to the centavo | row 303 |
| `INVENTORY_BASIS` | policy | v1 expenses stock on purchase (COGS-group expense, no inventory asset); v2 debits `1310`/GRNI and recognises COGS at usage, FIFO. One line per store-week: v1 COGS-group spend vs v2 inventory receipts, and v1 "COGS" vs v2 COGS, with Δ = change in v2 inventory | row 303, ADR-011, §16.11 |
| `PAYROLL_ON_V1` | scope | `payroll_payout`, `payroll_salary_expense` legs exist in v1 only until cutover | row 302 |
| `NOT_IN_DUAL_RUN_SCOPE` | scope | A v1 `sourceType` outside the double-entry scope Q1 sets (always `depreciation`, `amortization`, `loan_*`; per Q1 `remittance`, `transfer`, `cash_request_*`, `salary_advance`) | row 303, Q1 |
| `V2_ONLY_EVENT` | policy | A v2 posting with no v1 equivalent (supplier return/credit, channel-settlement fees, service-charge float) | row 166, T-150 |
| `V1_CASH_RESIDUAL` | policy | v1's sale cash leg = `cashPayments` = `remitted − online − credit − other`, **floored at 0** (`sale.builder.ts:24-37`). Assigned **only** when the unfloored residual is negative and **Δ(cash line, that day) = −(that negative residual)** exactly | GLOSSARY `cashPayments` |
| `AP_AT_INVOICE` | timing (paired) | v1 incurs AP when the credit expense posts (dated by its receipt, `dayKey`); v2 incurs AP at the verified supplier invoice (a received delivery sits in GRNI until then). Paired by the receipt document: same supplier, same centavos, v2 invoice date ≠ v1 `dayKey` | POSTING-PATTERNS `expense.credit.ap`; T-130 GRNI |
| `SUPPLIER_ADVANCE_1240` | policy | An overpayment is a 1240 / `supplier_advance__` asset on both sides and is shown on its own sub-line, excluded from the 2110 tie; a difference caused by v1 applying an advance where v2 needs an explicit `supplier.credit-applied` is this class | POSTING-PATTERNS `ap_payment.overpayment`, `supplier.credit-applied` |
| `V2_CORRECTION_DATED_LATER` | timing (paired) | A v2 correction whose original cannot be resolved stays on its own date, paired with its source (R5a) | R5a, POSTING-PATTERNS `sale.pos-correction` |
| `CHANNEL_AR_FLOW` | timing (paired) | v1 posts non-remitted channel sales through a separate `channel_sales` flow keyed by sales date; v2 posts them inside the sales day to `1220`. **S2 proves it on a fixture or removes it** | v1 `sales-day.actions.ts:270-297` |
| `PENDING_V2` / `PENDING_V1` | timing (unpaired) | The other side's document exists but is not posted / verified yet | R9, R12 |
| `DATE_SHIFT` | timing (paired) | Same document, different business date (v1's receipt date overrides `dayKey`) | R9 |
| `NOT_DOUBLE_ENTERED` | encoder | In scope, v1 only, no candidate in v2 | row 303 |
| `KEYING_DIFFERENCE` | encoder | Candidate found, centavos differ | R9 |
| `MISCLASSIFIED` | encoder | Same centavos under another category / supplier / money account | R9 |
| `UNMAPPED_KEY` | encoder | A v1 key with no keys-sheet row or `v1_master_links` link | R7 |
| `V1_DEFECT` / `V2_DEFECT` | defect | By on-screen disposition only, with `DEF-nnn` | R10, R14 |
| `UNEXPLAINED` | open | Default. Blocks sign-off | R12 |

Informational columns, never a class: `v1_counter` (v1's `accounts/` balance at `through`), `opening_gap` (the v1
balance before `week_start`; v2 has no opening during the pilot, which is why money lines compare **movements**),
and `v1_cash_residual_unfloored` (per day, on the cash tender line).

## Contract

### 1. Command (`scripts/dual-run.ts`, `npm run dual-run`)

```
npm run dual-run -- extract --from 2026-10-19 --through 2026-10-25 --out <dir> [--stores <v1 ids>]   # Ian's machine; refuses NODE_ENV=production
npm run dual-run -- compare --snapshot /srv/shareat-shared/dual-run/v1-dual-run-….json \
    --keys /srv/shareat-shared/dual-run/dual-run-keys.csv --org <uuid> --actor <person uuid> [--stores LIPA] [--apply]   # droplet
```

- **There is no `classify` subcommand.** Any other subcommand, including `classify`, is a usage error (exit 1), and
  the domain's disposition writer is reachable only from the server action (R10).
- `extract` prints the store count beside the list (STORE-ROSTER rule), per-collection counts, the window, the
  sha; writes the snapshot, its `.sha256`, and `dual-run-keys.csv` (pre-filled rows added, ticked rows kept).
- `compare` without `--apply` prints the per-store-week verdicts and the line table and writes nothing. With
  `--apply` it writes one report version per store-week (R8) under an advisory lock, one `audit_log` row per run
  (actor, snapshot sha, keys sha, fingerprints, counts), then deletes the snapshot (R3). Exit **0** all `ties` /
  `explained` / `no_data`, **2** some `open` (not a failure), **1** error or refusal (unmapped store, unknown store,
  snapshot sha mismatch, snapshot mode/owner wrong, keys sheet invalid, snapshot older than the week's latest
  version's extract).
- No credential, key or token is ever printed or written.

### 2. Line kinds (R6)

| Kind | v1 side | v2 side | Key |
|---|---|---|---|
| `cash_bank` | Net movement (in − out) per v1 money account over posted legs in the week, **in-scope sourceTypes only**; gross in and out shown | Cash: net movement keyed **`(gl_account_code, journal_lines.store_id)`**. Online: keyed by the **`party_type = 'money_account'`** party on the line | keys sheet `money` row |
| ↳ staff cash | `cash__staff` legs | Lines with `party_type = 'employee'` on the GL code of the store's `custodian = 'staff'` money account(s), summed per store | stated mapping, no sheet row; anything else on that code is `UNEXPLAINED` |
| `sales_tender` | Per salesDay in an R4 status: cash from the `sale` legs on `cash__cashier` (= `cashPayments`, floored), `onlineBreakdown[acct]` per wallet (= its `online__` legs), `creditSales`, `otherPaymentSales`; plus the **unfloored residual** `remitted − online − credit − other` per day (informational, drives `V1_CASH_RESIDUAL`) | Debits per money account / receivable on posted `sales_day` entries, corrections dated per R5a | keys sheet `money` row, or `credit` / `other` |
| `expense_category` | Posted expenses by `dayKey`, in the groups Q5 sets, per v1 expense entry | Posted expense lines per `expense_categories` row, corrections dated per R5a | keys sheet `category` row |
| `ap_supplier` | Per supplier: incurred (IN on `ap__{sid}`) and paid (OUT); `supplier_advance__{sid}` on its own sub-line | `2110` lines with `party_type = 'supplier'`, credits and debits; `1240` on its own sub-line | `v1_master_links` supplier |
| `inventory_basis` | COGS-group spend | `1310` + GRNI receipts; COGS | store (one line, always `INVENTORY_BASIS`) |
| `unassigned_store` | (none) | Tie-set lines with `store_id` null in the week, per org | org (R5) |

Every amount is integer centavos in code, `numeric(14,2)` in the database; v1 floats go through
`moneyFromLegacyFloat` (DEF-046/047), and a sub-centavo v1 value is reported, never rounded silently.

### 3. Migration 0NNN (S3, hand-authored, ADR-012 §5)

`dual_run_reports` (id, org_id, store_id, week_start date, through date, v1_fingerprint, v2_fingerprint, keys_sha,
v1_snapshot_sha (provenance), v1_extracted_at, verdict `no_data|ties|explained|open`, compared_days int, created_by,
created_at; unique on the R8 identity; CHECK `week_start` is a Monday, `through` within the week, `compared_days = 0`
iff verdict `no_data`) · `dual_run_lines` (report_id FK, kind, line_key, label, v1_amount, v2_amount, delta, class,
paired bool, auto_reason, per-day `jsonb` of `{date, v1, v2, delta, state}`, v1_counter, opening_gap; unique
`(report_id, kind, line_key)`; CHECK delta = v2 − v1, class in the catalogue) · `dual_run_dispositions` (org_id,
store_id, week_start, kind, line_key, delta_at, class, ref, note, created_by, created_at; **CHECK class in
(`V1_DEFECT`,`V2_DEFECT`) and ref matches `^DEF-[0-9]+$`**; FK `(org_id, store_id)` to the store's org). All three:
RLS ENABLE + FORCE, org isolation, app role **SELECT, INSERT only**. Classified in `classification.ts` as **purge,
notBefore 2027-01-31** (pilot data per ADR-007, but the 15 Nov evidence, as `etl_*`) and registered in
`rls/registry.ts`.

### 4. Screens (S5)

`/reports/dual-run`: one row per store-week (current version), verdict chip, compared days, Δ count by family;
a **Go/no-go pack** view (all store-weeks, compared days per store and total, `no_data` weeks listed apart and not
counted, class totals in pesos, every `V2_DEFECT` ref, printable). `/reports/dual-run/[store]/[week]`: lines grouped
by kind, v1 / v2 / Δ / class, per-day states, version history ("v1 changed since last version"). Read:
`view_financial_reports`. **Recording a disposition: `run_cutover`, on the line's page only** (existing capability;
no new one). 375 px wide, the reports family's components.

## Invariants (the tests prove each; a mutant named per leg)

**v1 figures (S1, pure)**
1. A voided leg and a voided expense contribute nothing. *Mutant: no status filter.*
2. Polarity comes from `adaptLegacyLegs`; `ap__` is credit-nature. *Mutant: raw `direction` sign.*
3. Dates are the strings: an expense with a linked receipt lands on its `dayKey` (the receipt date) even when its
   `createdAt` is in another week; a leg lands on its `businessDate`, and a legacy `YYYYMMDD` one is normalised.
   *Mutants: `createdAt`-derived date; `createdAtMs`-derived date.*
4. Cash residual: a day with remitted 10,000, online 7,000, credit 3,500, other 0 has v1 cash leg 0 and unfloored
   residual −500. With v2 cash −500 for that day, the line is `V1_CASH_RESIDUAL`; with v2 cash −499.99 it is not
   (`UNEXPLAINED` or a matching class); with residual ≥ 0 the class never fires. *Mutants: cash read from the
   unfloored residual; class assigned on any negative residual regardless of Δ.*
5. A salesDay `submitted` is not a sale; `partially_remitted` is. *Mutants: `submitted` counted; `partially_remitted`
   dropped.*
6. Week boundary on strings: `businessDate` `2026-10-25` (Sunday) is in the week of 19 Oct, `2026-10-26` is not,
   whatever the leg's `createdAtMs`. *Mutant: week computed from a timestamp in UTC.*
7. Padre Garcia and the test stores are excluded **and named** in the output. *Mutant: silent exclusion.*
8. The whitelist: no staff name, `employeeId`, `staffId`, `payments[].staffId`, `particulars`, payee, `memo`,
   `notes` or contact field in the snapshot. *Mutant: whole payload kept.*
9. Every posted leg in the window lands in exactly one line or one scope class (Σ in = Σ out of the classifier).
   *Mutant: an unknown `sourceType` dropped.*
10. Keys sheet: a v1 operating store with no ticked `store` row is a refusal, not a skipped store. *Mutant: skip.*

**Comparator (S2, pure)**
11. Equal figures give `TIES` and no candidate run. *Mutant: matching always runs.*
12. Each relaxed pass yields its class (R9) on a fixture built for it, and a document is matched at most once.
    *Mutants: two-to-one match; `DATE_SHIFT` window unbounded.*
13. A `DATE_SHIFT` pair across the week boundary (v1 Sunday, v2 next Monday) makes **both** weeks `explained`, at
    any age. An unpaired `PENDING_V2` dated 3 days before `through` makes the week `open`; 1 day before, `explained`.
    *Mutants: age rule applied to pairs; age rule dropped.*
14. `AP_AT_INVOICE` pairs a v1 credit expense with the v2 invoice for the same supplier and centavos on another
    date; with different centavos it does not pair. `SUPPLIER_ADVANCE_1240` sub-lines are excluded from the 2110 tie.
15. Deterministic: shuffled input gives the same lines and the same fingerprints. *Mutant: insertion order.*
16. `INVENTORY_BASIS` never counts toward `open`; `UNEXPLAINED` always does. *Mutant: policy counted open.*
17. **Vacuous ties:** a store-week with no salesDay on either side and no tie-set figure is `no_data` with 0
    compared days, and the pack does not count it. *Mutant: all-zero lines read as `ties`.*
18. Per-day states: a week line that nets to 0 over two days with +100 and −100 per-day Δ is `ties` for the week,
    but neither day is a compared day unless the pair is classed. *Mutant: compared days from the week Δ only.*
19. A disposition applies only while its delta is unchanged and only to the same `(org, store, week, kind,
    line_key)`; a same `line_key` under another kind is untouched. *Mutants: keyed on line_key alone; ignores delta.*
20. `UNMAPPED_KEY` for a v1 supplier with no link, never a silent merge into another supplier.

**v2 figures and storage (S3, real Postgres)**
21. Only posted entries count; a draft expense and an unverified sales day contribute nothing; a reversed entry and
    its reversal net to 0. *Mutant: figures from documents.*
22. Corrections: a `sale.pos-correction` posted on 28 Oct for the 24 Oct sales day lands on 24 Oct in
    `sales_tender`; an unresolvable one stays on 28 Oct, paired as `V2_CORRECTION_DATED_LATER`. *Mutant: entry date
    used.*
23. Cash keys: two money accounts on one GL code at one store sum on the cash key; an online line is keyed by its
    `money_account` party; a staff-custodian line with an employee party lands on staff cash. A tie-set line with
    `store_id` null appears on `unassigned_store`. *Mutants: null-store line dropped; online keyed by GL code.*
24. Store scoping: another store's and another org's lines never appear (RLS org B sees nothing). *Mutant: no
    `store_id` filter.*
25. Append-only: the app role cannot UPDATE or DELETE any of the three tables; CHECKs refuse a non-Monday week, a
    bad class, a `no_data` verdict with days, a disposition of `INVENTORY_BASIS` or `NOT_IN_DUAL_RUN_SCOPE`, a defect
    without a ref.

**Run (S4)**
26. Same inputs twice: the second `--apply` inserts nothing and says "unchanged"; a **re-extracted** unchanged v1
    (new file sha) is also "unchanged". One centavo changed in v2: a new version, the old one intact. *Mutants:
    upsert; identity on file sha.*
27. Dry run writes nothing and prints what `--apply` writes. `--apply` deletes the snapshot and keeps its sha on the
    report.
28. `extract` refuses `NODE_ENV=production`; `compare` refuses a sha mismatch, a snapshot with mode wider than 600 or
    another owner, and an older extract than the week's latest. Neither prints key material (fake key, grep output).
29. **The CLI cannot record a disposition:** `dual-run classify …` exits 1 with a usage error and writes nothing; no
    script imports the disposition writer (import-graph assertion). *Mutant: a `classify` subcommand.*
30. Firestore fake, two extracts of one week: (a) a leg deleted between them is no longer counted; (b) a leg
    **edited in place** (same id, new amount, original `businessDate`) restates that week, which gets a new version
    with the new figure. *Mutants: read through the landing table; delta placed on the extract date.*

**Screens (S5)**
31. A manager without `run_cutover` cannot record a disposition (server action refused, `authorize` ✗ fires); with
    `view_financial_reports` only, the pages render read-only; the form offers only `V1_DEFECT` / `V2_DEFECT` and
    requires a `DEF-nnn`. Smoketested on 9008 at 375 px.

## Slices

| Slice | What | TESTER writes (first) | BUILDER owns | Size |
|---|---|---|---|---|
| **S1** | Snapshot shape + whitelist, date-string week maths, v1 figures per line kind incl. the unfloored residual, keys sheet (store / money / category) parse and pre-fill, shared types | `packages/etl/tests/t392-s1-v1-figures.test.ts`, `packages/etl/tests/fixtures/t392-v1-snapshot.json` (synthetic, invented names, every trap above present) | `packages/etl/src/dual-run/{types,snapshot,week,v1-figures,keys,index}.ts`, `packages/etl/src/index.ts` (one export line) | 1.25 |
| **S3** | Migration, schema, RLS, classification, repo: v2 figures (cash keys, staff cash, null store, correction dating), report/line inserts, disposition insert | `packages/domain/tests/integration/t392-s3-v2-figures.test.ts` | `packages/db/migrations/0NNN_t392_dual_run.sql` + `meta/_journal.json`, `packages/db/schema/{dual-run.ts,index.ts}`, `packages/db/src/repo/{dual-run.ts,index.ts}`, `packages/db/src/rls/registry.ts`, `packages/db/src/cutover/classification.ts` | 1.25 |
| **S2** | Class catalogue, candidate matching and pairing, per-day states, verdict incl. `no_data`, compared days, fingerprints | `packages/etl/tests/t392-s2-compare.test.ts` | `packages/etl/src/dual-run/{classes,match,compare,verdict,fingerprint}.ts` | 1.0 |
| **S4** | CLI `extract` / `compare` (no `classify`), snapshot file rules, domain orchestration (lock, idempotence, audit row) | `packages/etl/tests/t392-s4-extract.test.ts` (Firestore fake), `packages/domain/tests/integration/t392-s4-run.test.ts` | `scripts/dual-run.ts`, `scripts/lib/dual-run-extract.ts`, `packages/domain/src/dual-run/index.ts`, `packages/domain/src/index.ts` (one line), `package.json` (one script line) | 0.75 |
| **S5** | Screens, go/no-go pack, the on-screen disposition action | `packages/domain/tests/integration/t392-s5-disposition-authz.test.ts`, `apps/erp/tests/t392-s5-dual-run-page.test.tsx` | `apps/erp/src/app/reports/dual-run/**`, `packages/domain/src/dual-run/dispositions.ts`, the reports nav entry in `apps/erp/src/app/reports/lib.ts` | 1.25 |

**Total 5.5.** **S1 and S3 run in parallel** (no shared path, no shared DB: S1 is pure). S2 needs S1's `types.ts`. S4
needs S2 and S3. S5 needs S3 and S4's domain module. **Dates:** S1+S3 by 22 Oct, S2 by 24 Oct, S4 by 28 Oct, so
**Lipa's first two weeks report by 28 Oct** (ahead of the plan's 6 Nov line), S5 by 5 Nov. Until S5 lands, `compare`
prints the report and the orchestrator posts it to Ian's board; no disposition can be recorded before S5, so Lipa's
defect lines stay `UNEXPLAINED` until then (correct: nothing is signed before 15 Nov). S3 carries a migration: its
own PR, or a precheck with Ian before wrap-up (row 296); full suite on a fresh gate DB.

## Questions for Ian (Open Questions page; the recommended option is built)

| Id | Question | Options | Recommended |
|---|---|---|---|
| **t392-q1** | Cash and AP cannot tie unless the money movements are in v2. Row 303 double-enters expenses and deliveries. What else does the encoder enter in v2 during the dual run? | (a) everything that moves cash, bank or AP: supplier invoices, supplier payments, remittances, transfers, cash requests, advances · (b) **expenses, deliveries, supplier invoices and supplier payments**; remittances, transfers, cash requests and advances stay v1-only and are shown as "not in dual-run scope" · (c) row 303 as written (AP will not tie) | **(b).** v2 records what you owe a supplier at the invoice, not at the delivery, so without the invoice "AP incurred" never ties; without payments "AP paid" and cash never tie. Remittances and transfers are daily moves between your own accounts: tying the sales, expense and supplier flows to the centavo proves the books without doubling the cashier's work. |
| **t392-q2** | Where is v1 read from? | (a) **your machine** (the read-only key never leaves it); the comparison runs on the server; the orchestrator does both steps · (b) the read-only key goes on the server and a timer runs every Monday 07:00 | **(a).** Same as the master-data load. Switch to (b) later if you want Monday reports with your laptop off; it is one config change. |
| **t392-q3** | v1's stores, wallets and expense entries must be matched once to v2's (e.g. "GCash Lipa" to "GCash — Lipa cashier"). Who? | (a) **pre-filled by name; you tick or correct one sheet** · (b) you fill it from blank | **(a).** 4 stores, about 10 wallets and 40 expense entries per store. |
| **t392-q4** | "≥ 15 compared trading days" by 15 Nov: in total or per store? Malvar, Banay-Banay and Davao start 2 Nov, so they have 13 days by 14 Nov. | (a) **≥ 15 in total and ≥ 10 per store**, every week tied or explained · (b) ≥ 15 per store (their go/no-go moves to 18 Nov) · (c) Lipa's ≥ 15 alone | **(a).** Lipa carries the depth (27 days); the other three prove the setup works at each store. |
| **t392-q5** | "Expenses by category": which v1 expense groups are tied? Stock purchases (COGS) are already the inventory policy line. | (a) **OPEX, CAPEX and PERSONAL** (every non-stock group; OTHERS listed by category too) · (b) OPEX only; CAPEX and PERSONAL shown, not tied | **(a).** CAPEX and PERSONAL are money leaving the store like any expense; v1 and v2 both post them at the expense, so they can tie to the centavo, and leaving them out would hide owner spending from the check. |

## Risks to 15 Nov

1. **T-391 S4 late** → no v2 suppliers → no AP tie for those days (every line `UNMAPPED_KEY`). The comparator still
   reports the other kinds.
2. **Verification lag in v2** (row 303: verify is human) → unpaired `PENDING_V2` older than 2 days is `open`. The pack
   is run on the morning of 15 Nov through 14 Nov.
3. **v1 restates past weeks** (edits re-post on the original date; voids mutate) → a tied week can re-open on a later
   run. Correct behaviour; every week in the pack is re-run on 15 Nov.
4. **Q1 unanswered by 19 Oct** → Lipa's encoder starts without invoices and payments; Lipa's first week AP lines fall
   to `NOT_DOUBLE_ENTERED`.
5. **Dispositions need S5 and Ian** (R10): defect lines cannot be classed before ~5 Nov, and only Ian can class them.
6. **The key on Ian's machine** (Q2 a) → a run needs it present; if the laptop is away on 15 Nov, the pack is the last
   applied versions.
7. **The calendar** (Q4): 15 days per store is unreachable for three stores by 14 Nov.

## Out of scope

Any change to v1 or to v2 posting · whole-TB comparison · T-114b's ambiguous-mapping tail · the
`ACCOUNTING-DIVERGENCES.md` doc and any bible or plan edit (the planner's; R11 seeds it) · Padre Garcia (not
dual-running) · payroll comparison (row 302) · a timer (Q2 b would add one unit file later) · recording a
disposition from any script.

## Done when

- [ ] All 31 invariants pass, each red leg shown red on HEAD or against its mutant.
- [ ] typecheck clean · affected tests locally · the full suite green in CI on the PR · `build` with the dev server
      stopped · smoketested on 9008 at 375 px.
- [ ] **Run against real data:** Lipa's week of 19 Oct extracted and compared on production, and its verdict, line
      count by class and top 5 deltas reported. *The report against real data is the deliverable, not the code.*
- [ ] Any spec defect reported, not worked around.

## S3 rulings (fresh Opus planner, 2026-10-12, binding; supersede the text above where they differ)
1. **Correction dating.** `postPosCorrection` posts `source_type 'sale'`, `source_id = sales_day_pos_corrections.id`. Resolve, in order: (a) `reversal_of_entry_id` → the original's resolved date, recursively; (b) `source_type 'sale'` and the source_id found in `sales_day_pos_corrections` → that sales day's `business_date`; (c) same source as an earlier POSTED entry → the earliest one's `entry_date`. Unresolvable entries keep their own date and are listed in `datedLater`. Only `sales_tender` and `expense_category` re-date; `cash_bank` and `ap_supplier` keep the entry's own date. (R5a's "e.g. `sale.pos-correction`" under same-source is wrong per the posting code.)
2. **Staff cash** is its own kind `staff_cash`, keyed by the GL code of the store's `custodian='staff'` money account. Employee-party lines are summed per store. Any other party on that code goes to `staff_cash` under its real party, and S2 classes it UNEXPLAINED. The 1110 cash line excludes staff cash.
3. **no_data `=>` compared_days = 0**, not iff. `ties`, `open` or `explained` with 0 compared days are valid. R12 should read "no data on either side" (inv 17).
4. Disposition `ref` is NOT NULL plus the regex CHECK.
5. **Expense key is per category**, joined via `source_type='expense_payment'`, `source_id = expenses.id` → `category_id`. A line with no expense source carries no `categoryId`, is keyed by GL code, and S2 classes it UNMAPPED_KEY.
6. `kind` CHECK on lines and dispositions: `cash_bank, staff_cash, sales_tender, expense_category, ap_supplier, inventory_basis, unassigned_store`. `v2Figures` also returns `inventory_basis` (1310 + GRNI receipts, COGS; §2).
7. **Store and person FKs use 0194's same-org composite FKs** (`<table>_store_id_same_org_fk`, `created_by` → persons `(org_id, id)`). S3 does not add its own and does not use a trigger. **S3 = migration 0195 and merges after 0194 (T-398 S1).** If 0194 slips, S3 waits.
Money columns, `v1_counter` and `opening_gap` included, are `numeric(14,2)`.

## S3 money rulings (fresh Opus planner, after the S3 audit, 2026-10-12; binding)
- **v2 amount sign.** `amount` = debit − credit, except on account 2110, where it is credit − debit. That is each line's natural balance and the same sign v1-figures uses for that kind. `debit` and `credit` stay raw, and `byDay` follows `amount`.
- **inventory_basis codes:** 1310, 1320, 1330, 1340, 5100, 5110–5170, 5175, 5200, 5300, 5400, 5450. 2120 (GRNI) is **excluded**: with it, a receipt would net to 0. **expense_category** covers lines on `expense_categories.account_code` minus that list, only from entries whose reversal-chain root is `source_type 'expense_payment'`. Lines from any other source on those codes (depreciation, amortisation, payroll, drawings, disposals, prepaid write-offs) are outside the tie set and are not emitted. A guard test checks that every COGS-group category code is in the list.
- **A correction** is one of: an entry with `reversal_of_entry_id`; a POS correction (`sales_day_pos_corrections.id = source_id`); a later entry from a source that already has an earlier entry of any status, ordered by (entry_date, id). **datedLater** holds corrections with no posted original. The earliest entry of its source is never a correction.
- **dual_run_lines.org_id** is NOT NULL, with a composite FK `(org_id, report_id)` → reports `(org_id, id)`, and **no trigger**. The repo copies org_id from the report (`INSERT … SELECT r.org_id …`). A report id from another org inserts nothing and raises.

## S4 rulings (orchestrator, at S4 RED, 2026-10-12)
The tester's pins stand:
- A compare run is authorized by **`run_cutover`** (org-scoped; the dual run is a cutover activity), checked before the lock or any write.
- Every apply run writes one audit row (`dual_run.compare`), including a run where every week is `unchanged`.
- The snapshot file's mode/owner check is POSIX-only by default; an injected `stat` is always enforced.
- A snapshot spanning several weeks gives one report per Monday-week, with `through` = min(Sunday, snapshot.through).
- R13's "posted sales day" means `sales_days.status = 'verified'`.
- The `ap_supplier` `line_key` is the v2 supplier UUID, or `v1:ap__<id>` when unmapped.
- `extract` runs with no v2 catalogue (`v2?`, empty by default).
- "Older extract" is strict: an equal `extractedAt` is allowed.
- `no_data` means no data on either side.
- *(orchestrator, at S4 READY)* A store-week with 0 compared days is `open` (S2's pinned coordinator ruling), or `no_data` when there is no data on either side; it is never `explained` by default.
- **Gap, its own slice S4b:** document-level matching (R9) is not wired. `runDualRun` passes empty `v1Docs`/`v2Docs`, because S3's repo has no v2 document reader, so an unmatched delta stays UNEXPLAINED and never becomes NOT_DOUBLE_ENTERED. S4b adds the v2 document reader and wires R9 before the go/no-go pack (S5) relies on those classes.
- *(orchestrator, at the S4 audit-fix READY, 2026-10-12)* `v2Figures` (the repo) keeps one `inventory_basis` line per GL code, as S3 F14-F16 pin. The domain keys them all `COGS`, so the comparator sees one line per store-week, as the tender-keys ruling requires. v2 credit comes only from `ar_charge` 1210 debits, so 1210 is taken out of the `source_type='sale'` branch to avoid counting it twice.
- The builder chose these keys: money/category sheet `v2Key` is the GL code or the account/category UUID; v1 `supplier_advance__x` maps to `1240:<supplier uuid>`; inventory_basis is keyed by GL code on the v2 side and `COGS` on the v1 side (always INVENTORY_BASIS). The audit row's entity_id is a fresh UUID per run.

## S4 tender keys (fresh Opus planner, 2026-10-12; binding)
- **sales_tender keys.** `cash__cashier` and `online__{id}` use the keys sheet's `money` rows.
- **`credit`** is a stated mapping with no sheet row:
  - v1: `salesDay.creditSales`.
  - v2: debits to 1210 at the store from entries whose reversal-chain root is `source_type 'ar_charge'`, summed over customers and dated by entry date. 1210 credits are excluded.
  - v2Figures must add these lines to `sales_tender` under `credit`.
- **`other`** has one `money` row per store (v1_key `other`):
  - its v2_key is a money account, `channel:<id>` or `none`;
  - `none` makes a non-zero v1 `other` NOT_DOUBLE_ENTERED;
  - an unticked row is UNMAPPED_KEY.
- **Channel receivables.** v2 1220/1221/1222 sales-day debits are keyed `channel:<channelId>`. The v1 side comes from the `channel_sales` flow.
  - **Orchestrator decision (2026-10-12): S1 reads that flow. This is new slice S1b, which adds the `channel_sales` arTransactions to the whitelist and v1 figures.**
  - Until S1b lands, those lines are UNEXPLAINED (CHANNEL_AR_FLOW).
  - S1b must land before the 2 Nov dual run.
- **Staff cash** is a stated mapping with no sheet row: v1 `cash__staff` (re-kinded) ↔ v2 `staff_cash`, line key `cash__staff`. Pre-fill skips it, and a sheet row for it is refused.
- **inventory_basis** is one line per store-week, key `COGS`. v2 = Σ(debit − credit) over the S3 inventory_basis codes, with byDay summed per date. Store-less lines stay on `unassigned_store`.

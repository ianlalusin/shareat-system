# T-447 — Audit, test, merge and deploy unmerged work

Status: IN PROGRESS. Ian, 2026-10-19: merge all unmerged branches once green, then deploy so he can see them live.

## Inventory at 22:33 Manila

| Branch | Unmerged work | Initial evidence |
|---|---|---|
| codex/compact-form-fields | T-445 compact controls; T-446 plain white content and related rows | Draft PR #38; 212 affected unit tests + 67 PostgreSQL tests pass; 56 caller/census guards pass; full CI running |
| lane/t442-l1 | Committed T-441 lightbox containment correction, two files | Source matches T-441 L1 contract; 34 wiring checks pass; uncommitted T-442 backfill work is separate |
| lane/t440-sweep | Live field checks and authorization-first validation | Working tree contains uncommitted S9 corrections; initial focused run 318 passed / 11 failed (conditional rules not implemented, stale baseline); must finish/audit before merge |
| claude/pos-v2-907a29 | T-425 offline work; T-426/T-427 approved specs and red tests | Full POS unit run started; T-426/T-427 source implementations absent; not merge-ready |

All other local/remote branch heads are already ancestors of origin/main. Historical branches need no duplicate merge.
Do not include unrelated root docs/operations/. Preserve other worktree changes and distinguish committed branch work
from uncommitted next-slice work before staging anything.

## Execution and scope

Audit each diff against its existing task contract, run affected checks, fix real defects without weakening tests,
and use PR CI for the full suites. No merge while red. Merge only reviewed green work; deployment remains the normal
CI-built artifact workflow, never a build on either droplet. Existing task specs own implementation file scope:
T-445/T-446 for the workspace; T-441 L1 for Lightbox.tsx and its wiring test; T-440 S9 for auth/conditional field rules;
T-425/T-426/T-427 for POS. This task owns this inventory and docs/reviews/t447-unmerged-branches.md.

Browser automation is denied by a saved permission/managed policy even after Ian enabled access. No alternate browser
surface/network workaround is allowed. Ian was offered the synthetic localhost preview for manual screenshots. Its
two-hour session had expired and was refreshed on 19 Oct without linking a real identity into the synthetic database.
Ian chose: **deploy green work first, then continue unfinished branches** (19 Oct). After reviewing the refreshed local
preview he approved: **"better now go"**. PR #38 passed full CI on 8cc3925 and merged as 758a48c; main CI 39272611434
and Deploy 39275146755 succeeded. Compact white UI is live. No automated visual-verification claim is made.
POS baseline: 14 failed / 59 passed files; 161 failed / 635 passed / 1 skipped tests. T-426/T-427 modules are missing.
T-440 S9 B now implemented in wt-t386; the existing conditional tests plus three new state regressions were red first.
Broader T-440 unit run: 1,403 passed; focused PostgreSQL integration: 55 passed. A subsequent audit found G6 accepted
`if (!record || await can(...))`, including paths where can never runs; a new control was red before tightening this proof
and removing four ungated fallbacks in money-transfer/trade actions. G6 then passed 14 tests with no baseline file.
Additional supporting files outside S9 B's short list: check-dom.ts, check-state.ts and FieldCheck.tsx are required for
controller reads, applicability state and disabled-control ownership; three existing supplier regression files and the
S4 parity fixture update the explicitly revised blank sentence without removing their data/rollback assertions.

## 2026-10-20 continuation
Post-commit combined guard/affected run: 605 passed across 13 files. Final ERP build passed on 1cb70ce.
PR #40 CI on 1cb70ce: POS/customer builds passed; main unit job found 48 failures in 11 files, predominantly older
action-wrapper mocks reaching the now-auth-first database capability check (`tx.select is not a function`). Held.
The published head is 683669b (adds the T-447 audit inventory); its full CI is required. New user priority is T-448,
applying the supplied multi-device UI skill to dashboards and details in an isolated worktree.

### T-440 CI harness repairs
The auth-first change requires the existing wrapper unit harnesses to supply the permission they already assume:
`staff-positions-action`, `t438-hire-action`, `t343-s5-1d-wrapper-refusals`, `t343-s5-5m-remittance-rewrap`,
`t374-s2-posted-dates`, `t343-s7-wrapper-refusals`, `t376-s2-return-banners`, `t343-s7-admin-refusals`
(all under apps/erp/tests). Only these unit files stub can(); real PostgreSQL auth-first tests retain real authorization.
The remittance harness also supplies its missing fake principal. Sentence and domain-call assertions remain unchanged.
`t342-no-null-tx-from-actions` updates the existing per-asset depreciation exception from line 225 to 228, not its scope.
DEF-682's literal OR pipes are escaped for the register table; the loan interest input retains explicit decimal mode.
Local reproduction: 47 failed / 94 passed; after repair, all 141 checks across the same 11 files passed.

## Release progress, 20 October
PR #39 passed full CI 39349212629 and merged as e34a979. T-449 repairs the eager payroll refusal-test promises without weakening assertions. PR #41 passed full CI 39351822583 and merged as fd8af80; Ian approved its dashboard corrections in be47f67. Production CI 39353485354 and Deploy 39355100476 passed; public health verified fd8af80, valid configuration and reachable database on 20 October.
T-440 now includes fd8af80: preserve both register additions; the action scanner measures 1390 after Books moves into StatCard. Combined build and root/ERP typechecks passed; 43 focused UI/auth/census checks passed. Number-field checks: 58 passed / four 5-second cold-import timeouts; the affected file passes all 20 with a local 30-second test budget. Repository/CI timeout settings and assertions are unchanged. Full CI must verify this combined head.

Supporting cost-regression scope: packages/domain/src/shared/manual-cost-pattern.ts, commissary/catalogue.ts, field-rules/cutover.ts, apps/erp/src/app/cutover/count/page.tsx and t440-s5-stock-rules.test.ts. The existing cost pattern is extracted unchanged so live rules accept the same .5 / 1. shapes; this is outside the original S9 short list, recorded explicitly. Money-refusal wording remains pending Ian's ruling because the original exception and later Opus audit disagree.

Full validation CI 39354321744: 77 failed / 8,856 passed across 553 PostgreSQL files (33 failed / 520 passed). Held from merge. Existing partial-recurring edits and a new explicit-blank/unchanged-row control were red first (DEF-696); patch-presence handling now preserves omission and refuses supplied blanks. Existing cost .5 regression and a new .5 / 1. / precision control were red first (DEF-697); an unchanged shared cost pattern fixes the valid shapes. Unit stock-rule checks: 295 passed; G3/G6 checks: 56 passed; recurring/catch-up tests: 40 passed / two remaining old diagnostic expectations failed; leading-dot PostgreSQL control passed. Root/ERP typechecks passed; new build pending.
Question sent in chat: redact invalid amounts as the later Opus audit does, or quote money only as the earlier task exception/older tests require (DEF-698). The external Open Questions artifact has no connected ArtifactData tool in this session; question is recorded here pending sync. No money-oracle rewrite while the ruling is pending.

## Exact refusal-oracle reconciliation after Ian's ruling
Ian chose quoted invalid money amounts only on 20 October. Eight updated money controls were red before restoring parseMoneyInput's exact userMessage. All raw field-rule diagnostics stay value-free; non-money field requirements and progress retain their privacy checks. Older tests now judge the public sentence and the new field diagnostic separately. Blank shape refusals use RefusalError; LEAVE status codes, prerequisite counters, row snapshots, valid controls and all permission assertions are retained. No failure is replaced with an arbitrary-error assertion.
Supporting test scope:
- `apps/erp/tests/integration/t328-trade-inputs-refused-by-parser.test.ts`
- `apps/erp/tests/integration/t343-s5-5m-money-labels.test.ts`
- `apps/erp/tests/integration/t343-s5-5s-followups.test.ts`
- `apps/erp/tests/integration/t351-review-followups.test.ts`
- `apps/erp/tests/integration/t374-s5-fixed-asset-life.test.ts`
- `apps/erp/tests/t440-s3-people-rules.test.ts`
- `apps/erp/tests/t440-s4-ap-ar-rules.test.ts`
- `apps/erp/tests/t440-s5-stock-rules.test.ts`
- `apps/erp/tests/t440-s6-money-rules.test.ts`
- `apps/erp/tests/t440-s7-settings-rules.test.ts`
- `packages/domain/tests/integration/attendance-credentials.test.ts`
- `packages/domain/tests/integration/cash-requests.test.ts`
- `packages/domain/tests/integration/customers.test.ts`
- `packages/domain/tests/integration/cutover.test.ts`
- `packages/domain/tests/integration/expenses.test.ts`
- `packages/domain/tests/integration/lane-health.test.ts`
- `packages/domain/tests/integration/loans.test.ts`
- `packages/domain/tests/integration/owners.test.ts`
- `packages/domain/tests/integration/recurring-expenses.test.ts`
- `packages/domain/tests/integration/sales-days.test.ts`
- `packages/domain/tests/integration/service-charge-distribution.test.ts`
- `packages/domain/tests/integration/t344-create-missing-period.test.ts`
- `packages/domain/tests/integration/t345-missed-month.test.ts`
- `packages/domain/tests/integration/t350-s4-owner-percentage.test.ts`
- `packages/domain/tests/integration/t351-review-followups.test.ts`
- `packages/domain/tests/integration/t368-asset-terms-store.test.ts`
- `packages/domain/tests/integration/t371-owners-nan.test.ts`
- `packages/domain/tests/integration/t374-s5-whole-number-refusals.test.ts`
- `packages/domain/tests/integration/t436-leave.test.ts`
- `packages/domain/tests/unit/t440-field-rules.test.ts`

### Final local repair checkpoint, 20 October
DEF-696–702 corrected locally. All 33 previously failed PostgreSQL files pass (615 tests); final blank/absent sales-date and real authorization controls pass (46 tests). Final rule/refusal/responsive checks pass (1,326), guards/censuses pass (217), root/ERP typechecks and production build pass. Number-box rendering checks pass (62) with a local 30-second cold-import budget; no repository/CI timeout settings changed. The DB refusal's unchanged UUID/whitespace sanitizer is extracted into import-free core/sentence for hint/server parity; its core subpath, Vitest alias, DB caller and parity checks explicitly extend S9 scope. The new UUID/newline matrix was red before this extraction.
Synthetic validation preview is running at 127.0.0.1:9008, using only shareat_test_codex_ui_smoke and a synthetic session. Ian was asked to check COD/credit applicability at desktop/phone sizes; runtime verification remains pending, with no saved-policy workaround. Exact-head full PR CI and post-commit guards are still required; draft PR #40 must not merge yet.

### Second full CI and manual runtime result
Ian answered **Works correctly at both sizes** for /ap COD/credit applicability on 20 October; this is manual synthetic-preview evidence, not automated browser verification. Post-commit c33ecef checks passed 1,499 guards/affected units and 46 real PostgreSQL tests. Full CI 39379359169 passed typecheck/unit/POS/customer builds but PostgreSQL ended with four failures / 8,931 passes in two failed / 551 passed files. Three T-343 sentence helpers were passed a different value from the submitted input (DEF-708); independent exact parser sentences now target the actual 1,5 / 1.234 / abc values. The T-440 people refusal keeps DEF-699's established drawing range sentence. Supporting test scope extends to apps/erp/tests/integration/t343-s5-5v-followups.test.ts and packages/domain/tests/integration/t440-s3-people-refusals.test.ts; production source and rollback assertions are unchanged. Full CI must run again on the new head before merge.

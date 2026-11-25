# T-639: expense alerts: rules that flag unusual spending (no AI), shown as findings that never block

**Owner:** builder (Sonnet). Auditor: Sonnet (money). **Spec:** BOSS (Opus), 25 Nov 2026. **No migration expected** (findings are derived on read). If a setting table is needed for the thresholds, STOP and ask BOSS for a migration number.

**Ian, 25 Nov 2026:**
- "it can evaluate the expense record. if something goes off like the regular meat expense per week is 100k now its 200k so it flags that not block".
- "Both now".

## Today (facts, origin/main)

- Findings: `packages/domain/src/findings/index.ts` + README, detectors in `packages/db/src/repo/findings.ts`, screens `apps/erp/src/app/findings/*` and the scorecard.
- Findings are DERIVED on every read, never stored. They nag, never block. Only acknowledgements are stored, and they expire after 30 days. `finding_views` records who looked.
- Budgets: `packages/domain/src/budgets/index.ts`: "a cap never refuses an expense: a finding nags".
- The planned detectors are listed in docs/discovery/ai-business-brain-assessment.md:83-101; none are built. That doc recommends SQL, not an LLM, for numeric anomalies. Bible rows 248/251: rules first; "looks personal" is owner/admin only; no receipt photos to any AI.

## Rule

New detectors in the existing findings mechanism (same shape, same screens, same acknowledge flow), each per store:

1. **Category spend spike (Ian's example):** this week's spend in an expense category is more than **X×** its usual weekly spend.
   - Usual = the median of the previous 8 full weeks, excluding weeks with 0.
   - Defaults: X = 1.5, and only flag when the difference is ≥ ₱5,000.
   - Text: "Meat: ₱200,000 this week, usually about ₱100,000 (2.0×)".
2. **Single expense outlier:** an expense far above the usual for its category at that store (median + k·MAD over 90 days; k = 5 by default; needs ≥ 10 history rows).
3. **Frequency spike:** count of expenses in a category this week > 2× the trailing 8-week mean (minimum 4 this week).
4. **Over budget:** reuse budgets if a budget finding doesn't already exist; otherwise skip and say so.
5. **Possible duplicate:** same store, supplier, amount within 3 days.
6. **Self-approved:** creator = approver (if the approval flow allows it).

**Thresholds have a screen** (STANDING: no hard-coded business settings):
- an org default and an optional per-category override for X, the peso floor and k
- on the findings settings or the expense categories screen, whichever fits
- if that needs a table, STOP for a migration number

Then:
- **Who sees them:** the same visibility the findings module uses for expense findings today (managers and admins at their stores). Staff don't see peso amounts (v1 practice).
- **Never block** any expense; the acknowledge-with-reason flow applies.
- **Weeks** are Monday-Sunday in the store's business day (reuse the existing business-date helper).

## Not in this task

- AI.
- The "looks personal" judgement.
- Receipt photos.
- Notifications by message (findings only).

## Tests (each with a mutant that goes red)

- Each detector flags on a crafted spike and stays quiet on normal data. Thresholds are respected (the per-category override beats the default). An empty-history store raises no false alarm.
- Exact peso maths (Money, no floats).
- Staff can't see amounts. Nothing refuses an expense save.
- The 8-week median excludes zero weeks.

census:write; typecheck per shareat-builder.md.

## As built (builder, 25 Nov 2026; not yet run, see "To run")

- **Detectors:** `packages/db/src/repo/expense-alerts.ts` (SQL + the pure maths), wired into `listFindings` by `expenseAlertFindings` in `packages/domain/src/findings/index.ts`. Kinds: `expenseCategorySpike`, `expenseFrequencySpike`, `expenseOutlier`, `expenseDuplicate`, `expenseSelfApproved`, `expenseOverBudget`. All soft, derived on read, per store; spike and frequency are keyed by store, category and week, so an acceptance covers one week. Over budget was NOT an existing finding, so it is built on the budgets' own `consumptionWindow` (now exported from `repo/budgets.ts`).
- **Thresholds, no migration:** five business rules in the registry (`expenses.alert_spike_multiplier` 1.5, `expenses.alert_min_amount` 5,000, `expenses.alert_outlier_multiplier` 5, `expenses.alert_frequency_multiplier` 2, `expenses.alert_frequency_min_count` 4), edited on /settings/business-rules under "Expense alerts". Two new rule units (`times`, `count`). No seed row (the reader falls back to the default), so the four `*-seed-matches-registry` pins now exclude the `expenses.` namespace.
- **Per-category override: NOT built.** It needs a table (or a column on `expense_categories`), which the spec says to stop for. The detectors already take a resolver `thresholdsFor(categoryId)`; today it returns the organisation default. With a table, only that resolver in `expenseAlertFindings` changes.
- **Decisions beyond the spec text:** (1) statistical detectors read OPEX and COGS only (CAPEX is lumpy, PERSONAL is a drawing); (2) a "usual week" needs at least 3 earlier weeks with spending; (3) the peso floor also applies to outliers, duplicates and self-approved (otherwise ₱50 differences and daily small purchases would flag); (4) outliers, duplicates and self-approved judge the last 30 days only (the life of an acknowledgement); (5) drafts count, voided never; (6) window sizes (8 weeks, 90 days, 10 rows, 3 days, 30 days) are named constants, not screen settings.
- **Visibility:** unchanged mechanism. The alerts live only in the feed behind /findings (`view_financial_reports`, store-limited); staff hold neither that right nor `close_period`.

### To run
`npx vitest run packages/db/tests/unit/t639-expense-alert-math.test.ts packages/domain/tests/unit/t639-registry.test.ts packages/domain/tests/unit/t639-never-blocks.test.ts apps/erp/tests/t639-*.test.ts packages/domain/tests/unit/t512-registry.test.ts apps/erp/tests/t539-business-rules-lib.test.ts`, then integration (own `_test` DB): `packages/domain/tests/integration/t639-expense-alerts.test.ts`, `t512-business-rules.test.ts`, the four `t539/t558/t575/t576-seed-matches-registry` tests, `findings.test.ts`, `oil-wave-2.test.ts`, `budgets.test.ts`. Then `npx tsc -p apps/erp/tsconfig.json --noEmit` plus a temp tsconfig over the new package test files, and `npm run census:write`.

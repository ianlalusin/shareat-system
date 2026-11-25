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

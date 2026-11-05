# T-512 (T-511 S5c) — Business rules table, reader, screen, and wiring

Status: spec (Opus, 6 Nov 2026). Builders write nothing before this file is committed.
Owner rule (Ian, 5 Nov, STANDING): no business setting in the ERP may be hard-coded; each needs a UI door.
BOSS rulings (5 Nov): ship S5b, then S5c before slice 6; migration **0235**; ONE generic table `business_rule_values`
(T-519 adds `payroll.deduction_cap_percent` to it later); closed key registry in code; capability
`manage_business_rules` (admin); screen Settings -> "Business rules"; snapshot semantics (a staged line keeps the figure
computed at upload; a change applies to files uploaded after it); intake flags EVERY difference and uses the limit only to
mark "large"; account codes 1220/6400/6420/7100 stay for now and slice 6 adds no new hard-coded account.

Branch `lane/t511-s5c` off the S5b commit (after rebase onto main). Worktree `C:\Users\ianla\webapps\wt-t511`.
LF only; no `npm install` through the junction; Git Bash first on PATH; slow HDD: run tests one at a time.

## What is a rule and what stays a constant

Business rules (move to the table): variance floor and percent (`channel-settlements/index.ts` `toleranceMillsFor`,
`pastTolerance`), loan final tolerance (`settlement-intake/loan-check.ts` `FINAL_TOLERANCE`), withholding rate
(`stage.ts` 5n/1000n) and the VAT base divisor (`stage.ts` 112n = 100 + 12).
Stay constants, with reason: file and parse caps, worker limits, display and validation lengths (protect the 4 GB server or
describe a file format); values the files carry (per-charge VAT percent, commission, dates, codes); money column width.
Out of S5c: account codes, `payroll.deduction_cap_percent` (T-519), `organizations.usage_tolerance` migration onto the table
(later, own task).

## Table `business_rule_values` (migration `0235_t511_business_rule_values.sql`)

Hand-authored, ADR-012 s5 checklist. Columns: `id`, `org_id`, `key text`, `value numeric(18,6)`, `effective_from date`,
`set_by` (person; null only for the seed), `reason text` (non-empty CHECK), `created_at`.
Append-only, copy precedent `pay_rates` (schema `packages/db/schema/payroll.ts:60-100`, migrations 0105 and 0221): RLS
`app_current_org()` ENABLE and FORCE; BEFORE UPDATE OR DELETE refuse trigger ENABLE ALWAYS; grants SELECT and INSERT only.
Registry entries: `triggers/registry.ts` (history_guard), `rls/registry.ts` (org_column), `cutover/classification.ts`
(keep, reason required). Schema file carries `// NOTE: ... hand-added in migration 0235` for hand-added items.
Rule in force on a date = row with the greatest `(effective_from, created_at, id)` where `effective_from <= date`.
No unique index: a same-day correction is a newer row.
Seed: one row per existing org per key, `effective_from 2000-01-01`, reason "starting value (migration 0235)". The reader
still falls back to the registry default when a row is absent (new org, tests). A test pins that the seed values in the SQL
equal the registry defaults.
Journal: idx 235, `when` = previous `when` + 86,400,000 x (235 - previous idx) (never wall clock). Builder verifies the
journal head and ordering against 0229-0231 (reserved for slice 6) and 0233/0234 (other lanes). Prove on a scratch DB.

## Closed registry `packages/domain/src/business-rules/registry.ts`

Key literal union -> `{ label (plain words), help, unit: 'money' | 'percent', default, min, max, capability, namespace }`.
Keys now (all capability `manage_business_rules`):
| Key | Default | Unit | Replaces |
|---|---|---|---|
| `settlement.variance_floor_amount` | 50.00 | money | T-150 floor 50_000 mills |
| `settlement.variance_percent` | 10 | percent | T-150 10% |
| `settlement.loan_final_tolerance` | 0.01 | money | `FINAL_TOLERANCE` |
| `tax.withholding_rate_percent` | 0.5 | percent | 5n/1000n |
| `tax.vat_percent` | 12 | percent | divisor 112n (= 100 + 12) |
A typo is a compile error and a runtime refusal. T-519 adds one entry. Bounds: money 0..100000; percent 0..100;
loan tolerance at most 1.00; the registry holds them.

## Reader and writer

`ruleValue(tx, orgId, key, onDate)` for one-off use. `loadRuleBook(tx, orgId, keys)` -> pure `RuleBook.valueOn(key, date)`:
ONE query, so batched paths such as `listReviewDays` stay flat (36 queries at 30 or 90 days + at most 1). Typed accessors keep
money as bigint: `centavos()` for money, `basisPoints()` (percent x 100) for percent. SQL only in
`packages/db/src/repo/business-rules.ts`.
`setBusinessRule(tx, actor, { key, value, effectiveFrom, reason })`: capability from the registry, bounds from the registry,
reason required (field rules + `capAuditText`), `effectiveFrom >= today` (Manila business date through `packages/core`
datetime, never UTC: t374 census), no backdating (a mistake is fixed by a newer row), insert-only, audit
`business_rule.changed` (key, value in force before, new value, effective_from, reason) in the same tx. A refusal is a
branded RefusalError with a plain sentence.

## Capability, audit, screen

Capability `manage_business_rules`: all six touchpoints in `packages/auth/src/capabilities.ts` (union, CAPABILITIES, SCOPE
org, AREA, MATRIX admin only, LABEL), row in `docs/decisions/CAPABILITY-MATRIX.md`, route `/settings/business-rules` in
`apps/erp/src/lib/route-capability.ts`, hub card in `apps/erp/src/app/settings/page.tsx`, pinned-cell test. Every check mark
has a test proving the refusal fires (manager, staff, other org), pattern `t401-s2-capabilities.test.ts:184-196`.
Audit catalogue +1 `business_rule.changed` (category settings, sensitivity high, scope org, ADMIN): ceilings in
`t402-s1b-catalogue` and `t453-item-audit-catalogue` re-measured after rebase (dated comment, measured number only).
Screen `apps/erp/src/app/settings/business-rules/{page,actions,lib}.tsx` (pattern `settings/usage-tolerance` and
`payroll/rates`): groups by namespace (Settlement, Tax); each key shows plain label, value in force today, scheduled
changes, history (who, when, from-date, reason), and a "Change from <date>" form (value, date >= today, reason) in
`EditableRecord` with `SubmitButton`; phone via cards; refusals show their own sentence. Use the `impeccable` skill; learn
from the S5b render defects (cut names, clipped amounts, hidden hints: check with a real render at 375, 1024, 1440).
Census: t411, t450 JSON, action-link-sweep total, G7/G8 (t384-s3), touch-target baseline: measured numbers only, dated
comments, each old -> new listed in the hand-back.

## Wiring (defaults make behaviour identical)

1. **T-150 variance**: `gatherSettlementContext` (has tx, org, businessDate) loads the RuleBook and passes
   `{ floorCentavos, percentBp }` into pure `computeSettlement`, as `outstanding` is passed; preview and record both.
   T-150 money module: Sonnet builder, Sonnet auditor, differential test (old function vs new at defaults over a wide gross
   sweep incl. half-centavo edges) and channel-settlements, t351, t440, t507 integration tests green.
2. **Intake "large" mark**: `review.ts` marks a difference "large" with the same rule on the sales date. Every non-zero
   difference is still flagged; large is not a blocker.
3. **Loan final tolerance**: value passed in per day from the RuleBook (loaded once in list, detail, blockers paths); the
   S5b audit fix (tolerance only on the final loan) stays.
4. **Staging**: `withholdingRounding` takes `{ withholdingBp, vatBp }`; divisor `10000 + vatBp` (11200n at defaults), rate
   `withholdingBp / 10000n` (5n/1000n at defaults). `ingestSettlementFile` resolves them on the invoice's LAST sales day and
   passes plain numbers into the pure `stage*` functions; the `review.ts` caller likewise. Per-charge VAT percent stays from
   the file. The five-PDF tie test (`t511-s5a-pdf-tie`) must stay exact.
5. Tidy: the 3 MB upload cap read from one place (`files/limits.ts`) instead of three copies
   (`upload/actions.ts` MAX_FILE_BYTES, `ingest.ts`).

## Order and models

Tester (Sonnet, tests first, failing): registry closed, reader resolution (latest effective_from <= date; ties by
created_at; future row unused; absent -> default), writer (capability, bounds, reason, no backdating, audit), append-only
(UPDATE and DELETE blocked, including as superuser via ENABLE ALWAYS), RLS org isolation, capability refusals, seed equals
defaults, default-equivalence tests (T-150 differential, five-PDF tie, loan-check unchanged), effective-date behaviour (change
withholding from D: a file whose last sales day is before D uses the old rate, after D the new), query count flat, source scan
(no leftover literals `5n/1000n`, `112n`, `FINAL_TOLERANCE`, `50_000` outside registry defaults). Builder A (Sonnet):
migration, registry, reader, writer, capability, audit, screen. Builder B (Sonnet): wiring 1-5. Auditor (Sonnet,
adversarial): refusal gates, backdating, append-only bypass, org isolation, default equivalence, query counts, leftover
literals, wording, census edits. Opus: spec and rulings only. BOSS commits and merges.
Models are passed explicitly; Haiku for discovery, sweeps, count bumps and simple fixes.

## Exit

`npx tsc --noEmit`; new tests on a fresh test DB with the migration applied through the journal; channel-settlements, t351,
t440, t507, t511-s5a-pdf-tie and all S5b suites unchanged and green; production-caller-ratchet (new exports need callers),
domain-actions-have-callers, no-ungated-read-surface, route-capability-coverage, client-bundle-boundary, throw ratchet,
t398-s2, capability-matrix, t402 and t453, t411, t450, action-link-sweep; plain `next build` with the dev server stopped;
a rendered check of the screen (forged session, scratch DB, port 9008 only if free else 9028, stopped after); full suite at CI.

## Known limits (accepted)

A rate change does not restate staged lines or posted settlements (snapshot rule); a re-upload restates a staged file.
The withholding and VAT values are resolved on the invoice's last sales day for the whole invoice. Account codes remain
constants until their own sweep.

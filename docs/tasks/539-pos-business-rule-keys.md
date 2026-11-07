# T-539 — POS business rule keys: senior/PWD %, business-day start hour, VAT, and the POS rules reader

> **Status:** spec written 7 Nov 2026 by the POS design lane (Opus planner). Not built.
> **Migration:** **0241** (reserved on the board). **Risk:** high (a tax figure feeds every bill), so a Sonnet builder
> and a Sonnet auditor are used.
> **Depends on:** T-512 S5c (`business_rule_values`, migration 0239, on `main` as 27ba97a). Slice S2 also depends on
> T-524 and T-525 being on `main`.
> **Why (Ian, 5 Nov, standing):** no business value is hard-coded. Every one needs a database row, an ERP screen, a
> capability and an audit trail. T-524 deliberately reads its three POS numbers only through an injected
> `deps.readRules`. Until this task lands, the default reader refuses with `RULES_NOT_WIRED`, and the POS cannot price a
> senior discount or pick a business day.

## Goal

1. Add the two POS rules to the T-512 registry: `pos.senior_pwd_discount_percent` and `pos.business_day_start_hour`.
2. Make `tax.vat_percent` the one VAT rate for both Foodpanda checks and POS bills.
3. Seed the new rows for existing orgs, and show them on the existing **Settings → Business rules** screen.
4. Give the POS one reader that returns T-524's `PosRules` shape.

**v1's goal (§1.2d):** v1 typed `0.20` and `1.12` into `lib/tax.ts`. A rate change meant an app release, and nobody
could see when it had changed. **v2:** the rates are dated rows with a reason and an audit record, changed by
`manage_business_rules` on a screen that already exists. A change takes effect from a stated day, so old receipts keep
their old rate.

## Out of scope

| Out | Why |
|---|---|
| A per-store rule | The registry is per org (T-512). The VAT rate and the statutory senior/PWD rate are national |
| Whether a store is VAT-registered | That is a store fact, not a rate. T-524 reads it from the store |
| A new capability | `manage_business_rules` (T-512) covers every rule. No change to `log_break_glass_approval` |
| Any POS screen | The values reach the tablet through the T-525 snapshot `rules` key |

## Slice S1 — keys, unit, seed, screen, reader (build now, on `main`)

### R1. Registry (`packages/domain/src/business-rules/registry.ts`)

- `RuleDefinition.unit` widens to `'money' | 'percent' | 'hour'`, and `namespace` widens to add `'pos'`.
- New entries:

| key | label | help | unit | default | min | max |
|---|---|---|---|---|---|---|
| `pos.senior_pwd_discount_percent` | Senior citizen and PWD discount (%) | The discount the law gives a senior citizen or a person with disability on their own share of the bill, after VAT is taken out of that share. The law sets it at 20. Change it only when the law changes. | percent | `20` | `0` | `100` |
| `pos.business_day_start_hour` | Hour a new POS business day starts (0–23) | Until a store closes its first day on the POS, a sale made before this hour belongs to the day before. 4 means a sale at 3:30 in the morning counts for yesterday. After the first day close, the day runs from close to close. | hour | `4` | `0` | `23` |

- `tax.vat_percent` keeps its key and value. Change only its label and help:
  - label: **"VAT included in prices (%)"**;
  - help: "Prices and platform order amounts already include VAT. 12 means an amount is divided by 1.12 to take the VAT
    out. The POS uses it for every bill and senior/PWD discount, and the settlement checks use it for Foodpanda
    statements."
  - One VAT rate for the law, not two rows that could drift apart.

### R2. The `hour` unit, everywhere `unit` is switched on

- **`book.ts`:** add `RuleValue.hour(): number`. It throws `internalFault` when the unit is not `hour` or the value is
  not a whole number from 0 to 23. `centavos()` and `basisPoints()` throw for an hour, as they do across the other
  units.
- **`rules.ts`**, the writer (`checkedBounds` or next to it): an `hour` value must have no fraction. Refuse it with
  `"<label> must be a whole hour from 0 to 23."` (the min and max still apply).
- **`apps/erp/src/app/settings/business-rules/lib.ts`:**
  - `showValue('hour', '4.000000')` → `"4:00 a.m."` and `'16.000000'` → `"4:00 p.m."`; `'0.000000'` → `"12:00 a.m."`
    and `'12.000000'` → `"12:00 p.m."`.
  - `inputValue('hour', …)` → the whole number (`"4"`).
  - Add `{ namespace: 'pos', heading: 'POS' }` to `RULE_GROUPS`, after Tax.
  - The form's input for an hour rule is a whole number (step 1, min 0, max 23). Follow how the page already renders an
    input per unit.
- Grep for every other `'money' | 'percent'` switch (`rules.ts:121` and any type exhaustiveness check), and extend each
  one. A switch with no default must fail typecheck if `hour` is missing.

### R3. Migration `0241_t539_pos_rule_keys.sql` (hand-authored, ADR-012 §5)

- **Data only:** the 0239 seed pattern for the two new keys. That is `INSERT … SELECT` over `organizations`, with
  `effective_from DATE '2000-01-01'`, `set_by NULL` and reason `'Starting value'`. Values `20` and `4`.
- `ON CONFLICT DO NOTHING` only if the table has a unique key that fits. Otherwise a plain insert (the migration runs
  once).
- Header comment: why; that the values equal the registry defaults (pinned by test); and that there is no schema change.
- Journal entry idx 241, with `when` on the grid after 0240's. Check the journal on `main` at build time. If 0240 is
  not on `main` yet, still use 241 and leave a one-line note for BOSS: the rebase order is 0239, 0240, 0241.
- Data needs no new trigger, audit action, RLS policy or cutover class.

### R4. The POS rules reader (`packages/domain/src/business-rules/pos-rules.ts`, exported from the business-rules index)

```ts
export interface PosRules { vatPercentBasisPoints: bigint; scPwdPercentBasisPoints: bigint; businessDayStartHour: number }
export async function readPosRules(tx: Tx, orgId: string, onDate: string /* YYYY-MM-DD, Manila */): Promise<PosRules>
```

- One `loadRuleBook(tx, orgId, ['tax.vat_percent', 'pos.senior_pwd_discount_percent', 'pos.business_day_start_hour'])`.
  Then `valueOn` each key for `onDate`: `.basisPoints()`, `.basisPoints()`, `.hour()`.
- The shape must be **exactly** T-524's `PosRules` (`packages/domain/src/pos/shared.ts` on `lane/t524-tests`). Do not
  import from `pos/`, which is not on `main` yet. S2 makes the two meet.
- `onDate` for the business-day hour is the Manila calendar date of the event time. That is the rule in force that
  day; a doc comment says so.

### R5. Tests (the tester writes them first; every ✅ needs its ✗)

- `packages/domain/tests/unit/t539-pos-rule-keys.test.ts`:
  - The registry has the two keys with the exact defaults, bounds, units and namespace.
  - `hour()` returns 4. `hour()` throws on a percent rule, and on `'4.5'`.
  - `basisPoints()` throws on an hour.
  - The `tax.vat_percent` label is the new one.
- `apps/erp` unit test for `lib.ts`:
  - `showValue` for the hours 0, 4, 12 and 16;
  - `inputValue('hour', '4.000000')`;
  - `RULE_GROUPS` has POS last.
- `packages/domain/tests/integration/t539-pos-rules.test.ts`:
  - `readPosRules` on a fresh org (no rows) returns `{1200n, 2000n, 4}`.
  - After `setBusinessRule('pos.senior_pwd_discount_percent', '25', from 2026-12-01)`: the reading on 2026-11-30 is
    `2000n`, and on 2026-12-01 it is `2500n`.
  - `setBusinessRule` of the hour to `4.5` is refused with the whole-hour sentence; to `24` it is refused by the bounds.
  - A person without `manage_business_rules` is refused (the existing T-512 ✗, run for a POS key).
- **Seed pin:** extend `t512-seed-matches-registry` (or add `t539-seed-matches-registry`), so that 0239's rows and
  0241's rows together equal **every** registry default. A key with no seed row anywhere fails the test. Do not weaken
  the existing five-row assertion. Narrow it to "0239 seeds the five T-512 keys".
- Any census the new unit trips (catalogue, capability matrix): bump it honestly. Never weaken a guard.

### R6. Gates

- `npm run typecheck`, the unit project, the t512 and t539 integration files, and t354-trigger-registry.
- Run on the lane's own `_test` DB, migrated to 0241.
- Never print a value from `.env.local`. Build the DB URL inside the command.

## Slice S2 — wire the POS to it (after T-524 and T-525 are on `main`)

1. In `packages/domain/src/pos/shared.ts`, the default `readRules` becomes `readPosRules`. Delete the
   `RULES_NOT_WIRED` default refusal and its sentence. Remove `RULES_NOT_WIRED` from `RETRYABLE_POS_CODES` in
   `inbox.ts`, and remove the code from the T-525 spec rulings when the doc is next touched.
2. In `apps/erp/src/lib/pos-api.ts`, delete the empty `posDeps` seam and let the routes use the domain default. The
   route tests that mocked it now run against seeded rules.
3. Tests:
   - flip the T-524/T-525 tests that asserted `RULES_NOT_WIRED` (the default reader refuses / `retry` / snapshot 503) to
     assert real values from the seed;
   - keep the injected-reader tests as they are;
   - add one end-to-end test: a `sale.completed` with a senior through `/api/pos/events`, with no injected reader,
     prices the bill with 12% VAT and 20% from the DB.

S2 is small. Build it as soon as T-525 merges, on its own branch, with the same Sonnet builder and auditor.

## Open (for the planner)

- **O1.** Should changing a POS rate also need a second approver? T-512 has none for any rule. It is unchanged here and
  can be raised with Ian if wanted.

## Slice S3 — table warning minutes (REQUIRED before the Lipa go-live; BOSS, 7 Nov 2026)

T-527 ships with a hard-coded 90-minute "table seated too long" warning. It is marked `shortcut:` with this slice named.
Ian's 5 Nov rule allows no hard-coded business value at go-live, so S3 must land **before the soak (T-533)**.

1. **Registry:** a new key `pos.table_warn_minutes`.
   - label: "Minutes before a table tile turns red";
   - help: "A table seated longer than this shows a red time bar on the POS Orders screen, so staff check on it.";
   - unit `minutes` (new), default `90`, min `1`, max `600`, namespace `pos`.
2. **The `minutes` unit,** everywhere `unit` is switched on:
   - `RuleValue.minutes(): number`: a whole number;
   - the writer's whole-number check;
   - the display: `showValue('minutes','90')` → "90 min";
   - the input: step 1.
3. **Migration `0245_t539_pos_table_warn_minutes.sql`:** data only, following the 0239/0241 seed pattern. 0242–0244 belong
   to the settlement lane.
4. **POS:**
   - `readPosRules` returns `tableWarnMinutes` as well;
   - the T-525 snapshot `rules` carries it;
   - T-527 drops `POS_TILE_WARN_AFTER_MINUTES` and reads the snapshot value.
5. **Tests:**
   - the registry, unit, display and seed pins (all keys);
   - the snapshot carries it;
   - a tile with the rule set to 30 turns red at 31 minutes.

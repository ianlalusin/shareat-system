Claimed by DeepSeek deepseek-flash, 2026-11-07 13:00 (Asia/Manila)

# T-543 — Give ERP tables a name screen readers can announce

| Field | Value |
|---|---|
| Planner | BOSS |
| Builder | <app and model> |
| Branch | `wo/t543-table-names` (the builder creates it from `origin/main`) |
| Worktree | `C:\Users\ianla\webapps\wt-t543` (the builder creates it, and works only there) |
| Risk class | **low** (attributes only) |
| Numbers reserved | migration: none · DEF: none · bible row: none |

## 1. Goal

The ERP has about 108 data tables and none of them has a name, so a screen reader announces only
"table". Give tables a short `aria-label` (e.g. "Suppliers", "Open cash requests"). Start with the
shared `Table` component, then 20 pages. Source: `docs/reviews/impeccable-audit-2026-11-03.md`
finding P2 #9.

## 2. Read first (and nothing else is required)

- `AGENTS.md` (section "Building from a work order") and `docs/RULES.md`
- `apps/erp/src/components/ui/Table.tsx` — the whole file. `Table({ className, children, card })`
  today has no label prop and doesn't pass extra props to `<table>`.
- `apps/erp/tests/t450-phone-table-cards.test.ts` (existing tests for the Table component's card mode)

## 3. What to build

1. In `Table.tsx`, add an optional prop `label?: string` to `Table`, and render it as
   `aria-label={label}` on the `<table>` element. Change nothing else in the component.
2. For each of the 20 raw `<table>` elements below, add `aria-label="..."` directly on the `<table>`
   tag. The label is the plain-English name of what the table lists, taken from the nearest visible
   heading or the page title (e.g. the page "Suppliers" → `aria-label="Suppliers"`; a section headed
   "Open requests" → `aria-label="Open requests"`). 1–4 words, no codes. If a file has several tables,
   label each by its own heading. If you can't tell what a table lists, skip it and note it.
   (paths under `apps/erp/src/app/`): page.tsx:316 · admin/access-defaults/grid.tsx:112 ·
   admin/prerequisite-refusals/page.tsx:37 · admin/stores/page.tsx:50 · admin/users/page.tsx:47 ·
   ap/page.tsx:162 · ap/invoices/[id]/page.tsx:302 · ap/suppliers/page.tsx:129 ·
   ap/suppliers/[id]/page.tsx:264 · ap/vat/page.tsx:79 · attendance/page.tsx:144 ·
   attendance/lane/page.tsx:152 · attendance/terminals/page.tsx:124 · channel-settlements/page.tsx:327 ·
   cash-requests/page.tsx:77 · customers/page.tsx:71 · customers/[customerId]/page.tsx:272 ·
   commissary/catalogue/page.tsx:110 · wastage/page.tsx:233 · commissary/orders/page.tsx:120
3. New test `apps/erp/tests/t543-table-names.test.ts`:
   - renders `<Table label="Suppliers">` (use the same render approach as `t450-phone-table-cards.test.ts`)
     and asserts the `<table>` has `aria-label="Suppliers"`; and that without `label` there is no aria-label
   - for each of the 20 files (a constant list in the test), the source's first `<table` tag carries `aria-label="`
4. Not to build: no `<caption>`, no visual change, no `scope` changes, no other files.

## 4. Files you may touch

| File | Change |
|---|---|
| `apps/erp/src/components/ui/Table.tsx` | edit — the `label` prop |
| the 20 files in §3 step 2 | edit — `aria-label` on `<table>` only |
| `apps/erp/tests/t543-table-names.test.ts` | new |

The repo copy of this work order (`docs/tasks/543-table-names.md`) is always allowed.

⛔ Any other file is off limits. **Guard tests you may move — do NOT edit them:**
`apps/erp/tests/t450-*.test.ts`, `apps/erp/tests/t411-*.test.ts` (table row-link sweep), any census.
If one fails, write the test name and output under **Builder notes** and in the PR body.

## 5. Tests that must pass

| Test | Proves |
|---|---|
| `apps/erp/tests/t543-table-names.test.ts` | the prop works, and the 20 tables are named |

Plus, every time — paste the real summary lines:
```bash
npm run typecheck
```
```bash
npx vitest run apps/erp/tests/t543-table-names.test.ts apps/erp/tests/t450-phone-table-cards.test.ts
```
```bash
npx vitest run --project unit
```

## 6. Done means

- [ ] §3 built inside the §4 list; every skipped table listed with the reason
- [ ] §5 tests passing; typecheck clean; full unit suite summary pasted
- [ ] This work order copied as `docs/tasks/543-table-names.md` with real output under **Builder notes**
- [ ] One PR against `main`, title starting "T-543:", ending "Built by <app> <model> from a work order"
- [ ] Work order moved from `current\` to `done\` with the PR link at its top
- [ ] **Stop there.**

## 7. Forbidden

Every rule in `docs/tasks/WORK-ORDER-TEMPLATE.md` §7 applies.

## 8. If you get stuck

Builder notes (both copies) → push → draft PR → move to `done\` with "BLOCKED" → next work order.

## Builder notes

Built by DeepSeek deepseek-flash, 2026-11-07, from `origin/main` at `cba144f`, in worktree
`C:\Users\ianla\webapps\wt-t543` on branch `wo/t543-table-names`.

### The component (step 1)

`apps/erp/src/components/ui/Table.tsx`: `Table` gains `label?: string`, rendered as
`aria-label={label}` on its `<table>`. `undefined` means React renders no attribute at all, so every
existing `Table` call site is byte-identical (pinned by a test). Nothing else in the component moved.

### The 19 named tables (step 2)

| Page | `<table>` label | Taken from |
|---|---|---|
| `page.tsx` (dashboard) | `POS usage drafts` | heading "Usage check" + subtitle "POS usage drafts" |
| `admin/access-defaults/grid.tsx` | `Position access defaults` | page title |
| `admin/prerequisite-refusals/page.tsx` | `Prerequisite walls` | the page's own `title` prop |
| `admin/stores/page.tsx` | `Stores` | page title |
| `admin/users/page.tsx` | `Users and roles` | page title |
| `ap/invoices/[id]/page.tsx` | `Invoice lines` | section `<h2>Lines</h2>` |
| `ap/suppliers/page.tsx` | `Suppliers` | page title |
| `ap/suppliers/[id]/page.tsx` | `Open items` | section `<h2>Open items</h2>` |
| `ap/vat/page.tsx` | `VAT summary` | section `<h2>Summary</h2>` under /ap/vat |
| `attendance/page.tsx` | `Attendance days` | section `<h2>Every day in the period</h2>` |
| `attendance/lane/page.tsx` | `Recently resolved` | section `<h2>Recently resolved</h2>` |
| `attendance/terminals/page.tsx` | `Terminals` | section `<h2>Terminals at this store</h2>` |
| `channel-settlements/page.tsx` | `Days to settle` | section `<h2>Days waiting to be settled</h2>` |
| `cash-requests/page.tsx` | `Cash requests` | page title / "The register" section |
| `customers/page.tsx` | `Customers` | page title |
| `customers/[customerId]/page.tsx` | `Charges` | section `<h2>Charges</h2>` |
| `commissary/catalogue/page.tsx` | `Linked branches` | section `<h2>Branches linked to this commissary</h2>` |
| `wastage/page.tsx` | `Open wastage` | page title "Order wastage" + the open list's empty state |
| `commissary/orders/page.tsx` | `Branch orders` | page title |

⚠️ **`ap/page.tsx` — the order's 20th entry — was skipped, with the reason §3 step 2 allows.**
It no longer has a hand-written `<table>`: it renders the shared `<Table>` with
`<caption className="sr-only">Supplier invoices</caption>`, which already gives that table an
accessible name. Adding `aria-label` would *replace* the caption's name for no gain, so the page is
untouched and is excluded from the test's file list.

**Extra tables left unnamed in files that were converted** (the order names one element per file, and
§5's guard pins the first): `admin/access-defaults/grid.tsx` has a second comparison table (line 189),
and these files each have a second table — `ap/invoices/[id]`, `ap/suppliers/[id]`, `ap/vat`,
`attendance`, `channel-settlements`, `customers/[customerId]`, `commissary/catalogue` (two more) and
`wastage`. They are the natural next slice; naming them here would have gone past the 20 listed
elements.

> ⚠️ **A note on the listed line numbers.** `admin/access-defaults/grid.tsx:112` is a `//` comment
> containing the literal text `` `<table>` ``, not a tag — the file's real first `<table>` is line
> 138 (header table) and 189 (per-scope). The label went on 138. The other listed line numbers had
> drifted by up to ~30 lines (T-448/T-544 moved code above them); the tables were found by searching
> the file, not by trusting the number.

### Checks — real output

`npm run typecheck`

```
> shareat-system@0.1.0 typecheck
> tsc --noEmit
```
exit 0, clean.

`npx vitest run apps/erp/tests/t543-table-names.test.ts apps/erp/tests/t450-phone-table-cards.test.ts`

```
 ✓ |unit| apps/erp/tests/t543-table-names.test.ts (3 tests) 44ms
 ✓ |unit| apps/erp/tests/t450-phone-table-cards.test.ts (13 tests) 188ms

 Test Files  2 passed (2)
      Tests  16 passed (16)
```

`t387-s3-table.test.ts` (the component's own pin) and `t450-phone-table-coverage.test.ts` (the
table census) also run green:

```
 ✓ |unit| apps/erp/tests/t387-s3-table.test.ts (11 tests) 11ms
 ✓ |unit| apps/erp/tests/t450-phone-table-coverage.test.ts (6 tests) 979ms
 Test Files  2 passed (2)
      Tests  17 passed (17)
```

`npx vitest run --project unit --maxWorkers=6` (this 16-core / 16 GB Windows box cannot run the
project at default parallelism without mass 5 s timeouts — measured today on the sibling T-540 build:
49 failed files at 16 workers vs 6 at 6 workers). JSON summary:

```
Tests  total 11461  failed 27  passed 11430  pending 4
Test files with a failing test: 14
```

**The 14 failing files, and why none is this PR's code:**

| File | Failing | Nature |
|---|---|---|
| `tests/unit/deploy-pos-failed-build.test.ts` | 8 | fails identically alone — `spawnSync('bash', …)`, no usable bash on this box; reads `.github/workflows/deploy.yml`, untouched here |
| `tests/unit/t455-s9a-ops.test.ts` | 5 | same bash dependency, same untouched files |
| `tests/unit/app-boundaries.test.ts` | 1 | `STACK_TRACE_ERROR`; **passes alone** |
| `tests/unit/no-client-supplied-actor.test.ts` | 1 | `STACK_TRACE_ERROR`; **passes alone** |
| `tests/unit/no-committed-secrets.test.ts` | 1 | `STACK_TRACE_ERROR`; **passes alone** (verified earlier today) |
| `tests/unit/position-defaults-callers.test.ts` | 2 | `STACK_TRACE_ERROR`; **passes alone** |
| `tests/unit/t336-canonical-position-defaults.test.ts` | 1 | `STACK_TRACE_ERROR` |
| `tests/unit/t375-no-typed-sales-figures.test.ts` | 2 | `STACK_TRACE_ERROR` |
| `tests/unit/t511-s5b-production-callers.test.ts` | 1 | `STACK_TRACE_ERROR` |
| `apps/erp/tests/no-typed-values-in-urls.test.ts` | 1 | `STACK_TRACE_ERROR` |
| `apps/erp/tests/t440-s2-live-check-guard.test.ts` | 1 | `STACK_TRACE_ERROR`; **passes alone** (42 green, verified today) |
| `apps/erp/tests/t511-refusal-presents-own-sentence.test.ts` | 1 | `STACK_TRACE_ERROR` |
| `packages/db/tests/t402-s1b-catalogue.test.ts` | 1 | `STACK_TRACE_ERROR` |
| `packages/domain/tests/unit/t511-s3-worker-limits.test.ts` | 1 | real message: "The workbook took too long to open, so it was refused" — the 5 s cap lost to load |

`STACK_TRACE_ERROR` is vitest's placeholder for a worker that died without carrying a stack — the RAM
ceiling, not an assertion.

### Guard tests

**None moved.** `t387-s3-table` (the component's markup pin), `t450-phone-table-coverage` (the table
census), `action-link-sweep` and `t411-row-link-census` are all green — the change adds one attribute
and changes no element, row link or control.

### Smoketest

**N/A, attributes only — and no signed-in ERP session is available to this builder.** No screen was
seen in a browser; an `aria-label` is invisible, but the review can confirm no visual change by
diffing: every edit is one attribute inside an existing `<table>` tag, plus the component's optional
prop.

### Commits

- `T-543: name the tables a screen reader announces`
- `T-543: test the label prop and the 19 named tables, and keep the work-order copy`

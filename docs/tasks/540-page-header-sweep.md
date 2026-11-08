Claimed by DeepSeek deepseek-flash, 2026-11-07 11:28 (Asia/Manila)

> **Claim notes (read this first).**
>
> 1. The `open\` copy held only the RE-OPENED note and the title (384 bytes) — the spec body was
>    missing. The body from `## 1. Goal` to `## 8. If you get stuck` below was recovered
>    **verbatim** from the coord copy of this same work order,
>    `C:\Users\ianla\webapps\shareat-coord\docs\tasks\540-page-header-sweep.md`. Nothing in it was
>    invented or re-scoped by the builder. The previous attempt's Builder notes in that copy
>    describe the closed, unmerged PR that deleted ~4,438 files; they are dropped here on purpose
>    and replaced with this attempt's own notes at the bottom.
> 2. Branch/worktree follow the RE-OPENED note: new branch `wo/t540b-page-header-sweep`, new
>    worktree `C:\Users\ianla\webapps\wt-t540b`, cut fresh from `origin/main` (NOT the old
>    `wo/t540-page-header-sweep` / `wt-t540`).
> 3. The deletion safety check from `work-orders\BUILDER-PROMPT.md` step 8 runs before any push:
>    `git diff --stat origin/main...HEAD` must show only the listed files, no deleted file.

---

# ⟳ RE-OPENED (BOSS, 7 Nov): the first attempt (branch wo/t540-page-header-sweep, commit cc88a32) DELETED ~4,438 files and was closed unmerged. Start again on a NEW branch wo/t540b-page-header-sweep in a NEW worktree wt-t540b, cut fresh from origin/main. Before pushing, run the deletion check in FREEBUFF-PROMPT.md step 8.

# T-540 — Put 25 ERP pages on the standard page header

| Field | Value |
|---|---|
| Planner | BOSS |
| Builder | DeepSeek deepseek-flash, 2026-11-07 (re-opened attempt) |
| Branch | `wo/t540b-page-header-sweep` (created from `origin/main`; the RE-OPENED note renames it from `wo/t540-page-header-sweep`) |
| Worktree | `C:\Users\ianla\webapps\wt-t540b` (the RE-OPENED note renames it from `wt-t540`) |
| Risk class | **low** (screens only; no logic, no data) |
| Numbers reserved | migration: none · DEF: none · bible row: none |

## 1. Goal

Every ERP page hand-writes its own title row, so titles, descriptions and buttons sit in slightly different places page to page. The shared `<Page>` component already has `title`, `description` and `actions` props that render the standard header, but **no page uses them**. Move the 25 simplest pages onto those props. Source: `docs/reviews/impeccable-audit-2026-11-03.md` finding P1 #2.

## 2. Read first (and nothing else is required)

- `AGENTS.md` (section "Building from a work order") and `docs/RULES.md`
- `apps/erp/src/components/shell/Page.tsx` — the whole file. `Page` props: `density` (required), `title?: string`, `description?: string`, `actions?: ReactNode`, `view`, `sectioned`, `className`. `PageHeader` (same file, ~line 121) is what `title/description/actions` render.
- `apps/erp/src/components/shell/PageDescription.tsx` (what the hand-written pages use today)
- `docs/reviews/impeccable-audit-2026-11-03.md` finding 2

## 3. What to build

For EACH page in the list below:

1. Open the file. Find the hand-written header: an `<h1 ...>Title</h1>`, usually followed by `<PageDescription>...</PageDescription>`, often wrapped in a `<div>` / flex `<div>`.
2. **Convert it only if ALL of these hold** (otherwise SKIP the page and list it under Builder notes with the reason):
   - the h1 is a direct part of the page's top `<Page ...>` (not inside a card, tab or conditional)
   - the h1 text is static plain text
   - the PageDescription's content is **plain text only** (no `<strong>`, `<em>`, `<a>`, `{expressions}`), because `description` is a `string`
   - there is **no** action button/link next to the title (this work order does not move actions)
3. Convert: delete the hand-written h1 / PageDescription / their now-empty wrapper `<div>`s, and put `title="..."` and `description="..."` on the existing `<Page ...>`. Keep the exact same words (copy them; join a multi-line description into one string with single spaces). Keep every other prop on `<Page>` unchanged.
4. Remove the `PageDescription` import from a file only if nothing else in that file uses it.
5. Not to build: no changes to `Page.tsx`, `PageHeader`, `PageDescription.tsx`, any wording, any page not on the list, any action button.

**The 25 pages** (all under `apps/erp/src/app/`; line = the h1 today):
admin/stores/page.tsx:40 · admin/users/page.tsx:29 · attendance/leave/page.tsx:116 ·
cash-requests/page.tsx:51 · channel-settlements/page.tsx:144 · cutover/opening/page.tsx:81 ·
expenses/page.tsx:49 · expenses/reimbursements/page.tsx:56 · fixed-assets/page.tsx:73 ·
items/page.tsx:65 · liabilities/unpaid/page.tsx:38 · loans/page.tsx:39 · owners/page.tsx:53 ·
prepaid/page.tsx:60 · sales-days/page.tsx:62 · settings/expense-categories/page.tsx:71 ·
settings/pos-link/page.tsx:56 · settings/usage-tolerance/page.tsx:38 · settings/organization/page.tsx:72 ·
settings/pos-tablet/page.tsx:56 · reports/trial-balance/page.tsx:65 · reports/income-statement/page.tsx:65 ·
reports/balance-sheet/page.tsx:54 · payroll/rates/page.tsx:44 · statutory-discounts/page.tsx:67

Note: `expenses/page.tsx` has a description containing "(docs/tasks/122-expenses.md)" and an action link — so it will be SKIPPED by rule 2. That is expected.

## 4. Files you may touch

| File | Change |
|---|---|
| the 25 `page.tsx` files listed in §3 | edit — header only |
| `apps/erp/tests/t540-page-header-sweep.test.ts` | new — the test below |

The repo copy of this work order (`docs/tasks/540-page-header-sweep.md`) is always allowed.

⛔ Any file not in this table is off limits. **Guard tests you will probably move — do NOT edit them:**
`apps/erp/tests/t348-page-description-sweep.test.ts` (counts PageDescription uses),
`apps/erp/tests/action-link-sweep.test.ts` (census of controls), any page-container / prose census.
If one fails, write the test name, the old and new number and the output under **Builder notes**, and say so in the PR body. BOSS approves the new numbers. Do not open the PR as a draft for this reason alone.

## 5. Tests that must pass

| Test | Proves |
|---|---|
| `apps/erp/tests/t540-page-header-sweep.test.ts` — "converted pages use the Page title prop" | for each page you converted (list them in the test as a constant array), its source contains `<Page` with `title="` and contains no `<h1` |
| same — "no converted page lost its words" | for each converted page, the original title text appears in the `title="..."` value |

Plus, every time — run ALL of these and paste the real summary lines:

```bash
npm run typecheck
```

```bash
npx vitest run apps/erp/tests/t540-page-header-sweep.test.ts
```

```bash
npx vitest run --project unit
```

(the full unit suite takes several minutes; known local-only failures: `packages/etl/tests/capture.test.ts` when `.env.local` is missing, and timing tests under load — note them, don't fix them)

## 6. Done means

- [ ] Every convertible page converted; every skipped page listed with its reason
- [ ] §5 tests written and passing; typecheck clean; full unit suite run and its summary pasted
- [ ] Not smoketested in a signed-in browser (you can't sign in) — say so in the PR
- [ ] This work order copied as `docs/tasks/540-page-header-sweep.md` with real output under **Builder notes**
- [ ] One PR against `main`, title starting "T-540:", body listing converted / skipped pages and any guard numbers that moved, ending "Built by DeepSeek deepseek-flash from a work order"
- [ ] Work order moved from `current\` to `done\` with the PR link at its top
- [ ] **Stop there.**

## 7. Forbidden

Every rule in `docs/tasks/WORK-ORDER-TEMPLATE.md` §7 applies.

## 8. If you get stuck

Builder notes (both copies) → push → draft PR → move to `done\` with "BLOCKED" → next work order.

## Builder notes

Built by DeepSeek deepseek-flash, 2026-11-07, from `origin/main` at `975159a`, in worktree
`C:\Users\ianla\webapps\wt-t540b` on branch `wo/t540b-page-header-sweep` (RE-OPENED names).

### Brief provenance — read this first

The `open\` copy of this work order held only the RE-OPENED note and the title (384 bytes); the spec
body was missing. The body from §1 to §8 above is the coord copy
(`shareat-coord\docs\tasks\540-page-header-sweep.md`) copied **verbatim** — nothing was re-scoped by
the builder. The previous attempt's Builder notes (the closed PR whose diff deleted ~4,438 files)
described work this branch does not contain, so they are replaced by these notes. Branch and
worktree follow the RE-OPENED note, not the stale `wt-t540` / `wo/t540-page-header-sweep` names.

### Converted (7)

| Page | Title moved to `title=` |
|---|---|
| `admin/users/page.tsx` | Users and roles |
| `attendance/leave/page.tsx` | Leave |
| `expenses/reimbursements/page.tsx` | Reimbursements |
| `liabilities/unpaid/page.tsx` | Everything unpaid |
| `reports/trial-balance/page.tsx` | Trial Balance |
| `reports/income-statement/page.tsx` | Income Statement |
| `reports/balance-sheet/page.tsx` | Balance Sheet |

In each: the wrapper `<div>`, the `<h1>`, and the `<PageDescription>` block are gone; `title=` and
`description=` sit on the existing `<Page>` with the original words (multi-line descriptions joined
with single spaces); the `PageDescription` import is removed because nothing else in the file used
it; every other prop (`density`, `className`) is untouched.

⚠️ One string needed care: `reports/balance-sheet`'s description contained `&ldquo;`/`&rdquo;`
entities. A `description` prop is a **string**, not JSX text, so the entities became the literal
`“` / `”` characters — the same words, still rendered as curly quotes, instead of the literal text
`&ldquo;` appearing on screen.

### Skipped (18) — §3 rule 2, page by page

`Rule 2` converts a page only if all four conditions hold. The table names the condition each page
fails. Several fail more than one.

| Page | Fails because |
|---|---|
| `admin/stores/page.tsx` | action: `<FormModal trigger="+ Add store">` sits beside the title in the same flex row |
| `cash-requests/page.tsx` | action (`+ Ask for cash` modal) **and** rich text: description contains `<strong>` |
| `channel-settlements/page.tsx` | rich text: description contains `<span>` |
| `cutover/opening/page.tsx` | action (`+ Add opening figure` modal) **and** a `← Back to the conversion` link inside the same header block |
| `expenses/page.tsx` | action: a `New expense` `<a>` beside the title (this is the skip §3 of the work order already expects) |
| `fixed-assets/page.tsx` | action (`Add asset` `<a>`) **and** rich text: description contains `<strong>` |
| `items/page.tsx` | action: two controls beside the title (`Import items from a file` link + `+ Request item` modal) |
| `loans/page.tsx` | action (`+ Record loan` modal) **and** rich text: `<strong>` |
| `owners/page.tsx` | action (`+ Record owner` modal) **and** rich text: `<strong>` |
| `prepaid/page.tsx` | action: `+ Record prepaid item` modal beside the title |
| `sales-days/page.tsx` | action (`New sales day` `<a>`) **and** rich text: `<strong>` |
| `settings/expense-categories/page.tsx` | rich text (`<strong>`) **and** a `Settings / …` breadcrumb link inside the same header `<div>` |
| `settings/pos-link/page.tsx` | breadcrumb: the header `<div>` also holds the `Settings / POS link` link |
| `settings/usage-tolerance/page.tsx` | breadcrumb: the header `<div>` also holds the `Settings / Usage tolerance` link |
| `settings/organization/page.tsx` | breadcrumb **and** rich text: the description contains `<a href="/admin/stores">` |
| `settings/pos-tablet/page.tsx` | breadcrumb: the header `<div>` also holds the `Settings / POS tablet` link |
| `payroll/rates/page.tsx` | breadcrumb: the header `<div>` also holds the `Payroll / Rates` label |
| `statutory-discounts/page.tsx` | action (`+ Add record` modal) **and** rich text (`<strong>`); the block is a `<header>` element |

**Why the breadcrumb pages are skipped rather than converted.** §3 rule 3 says to delete the h1, the
`PageDescription` **and their now-empty wrapper `<div>`s**. In those six pages the wrapper is not
empty: it also holds the breadcrumb. Deleting it would remove navigation the work order never named
(and RULES §1.2 says a capability is not deleted by an implementer); keeping it would render the
breadcrumb *below* the title, because `Page` renders `PageHeader` before `{children}`. Neither is
the work order's intent, so they are listed here for BOSS to rule on.

> **Scope note for BOSS.** The work order calls these "the 25 simplest pages" and expects only
> `expenses` to be skipped. On `origin/main` today, 18 of the 25 fail rule 2 — in most cases
> because the T-448 modal work moved an action control into the title row, or because the
> description is no longer plain text. This is a fact about the tree, not a decision to narrow the
> task: the rule was applied as written. If you want the other 18 on the standard header, they need
> either an `actions`-prop pass (rule 5 currently forbids moving actions) or a `description` that
> accepts rich text — both are new work orders, not this one.

### Checks — real output

`npm run typecheck`

```
> shareat-system@0.1.0 typecheck
> tsc --noEmit
```

(exit 0 — clean, no diagnostics)

`npx vitest run apps/erp/tests/t540-page-header-sweep.test.ts`

```
 ✓ |unit| apps/erp/tests/t540-page-header-sweep.test.ts (3 tests) 19ms

 Test Files  1 passed (1)
      Tests  3 passed (3)
```

`npx vitest run --project unit` — **four runs, because this box cannot run it at default parallelism**
(16 cores, 16 GB, other worktrees building at the same time). The headline is the 6-worker run; the
two default-worker runs are shown because hiding them would be dishonest.

Run 1, default workers (11:37–11:48):

```
 Test Files  49 failed | 493 passed (542)
      Tests  100 failed | 11313 passed | 33 skipped (11446)
   Duration  648.96s
```

Run 2, default workers (12:00–12:10):

```
 Test Files  35 failed | 507 passed (542)
      Tests  95 failed | 11330 passed | 21 skipped (11446)
   Duration  600.52s
```

Run 3, `--maxWorkers=6` (12:10–12:18) — **the meaningful number**:

```
 Test Files  6 failed | 536 passed (542)
      Tests  20 failed | 11422 passed | 4 skipped (11446)
   Duration  462.66s
```

Run 4, `--maxWorkers=6 --reporter=json` (12:19–12:29), to name the 6 files:

```
Tests  total 11446  failed 21  passed 11421  pending 4
Suites total 2717   failed 15   (files with a failing test: 6)
```

**The 6 failing files, and why each is not a regression to this PR's code:**

| File | Failing | Nature |
|---|---|---|
| `tests/unit/deploy-pos-failed-build.test.ts` | 8 | fails identically when run alone — it `spawnSync('bash', …)` and this Windows box has no usable bash; reads only `.github/workflows/deploy.yml`, which this PR does not touch |
| `tests/unit/t455-s9a-ops.test.ts` | 5 | same `bash` dependency, same files, same failure alone |
| `apps/erp/tests/t343-s5-5s-number-boxes.test.ts` | 4 | every failure is `Test timed out in 5000ms` rendering `SettlementForm` / the transfer form (files this PR does not touch); slow Windows FS, not logic |
| `tests/unit/position-defaults-callers.test.ts` | 1 | `Error: STACK_TRACE_ERROR` (vitest's placeholder when a worker dies/ loses the stack); **passes when run alone** (`2 passed`) |
| `tests/unit/no-committed-secrets.test.ts` | 1 | same `STACK_TRACE_ERROR`; **passes when run alone** — re-ran twice, green both times |
| `apps/erp/tests/t348-page-description-sweep.test.ts` | 2 | **caused by this change** — SW3 and SW4, below. Not edited. |

`packages/etl/tests/capture.test.ts` (the work order's known local failure) **passed** here, 22 tests.

### Guard tests that moved — NOT edited

1. **`apps/erp/tests/t348-page-description-sweep.test.ts` — SW4** ("exactly 130 `<PageDescription>`
   call sites exist under app/"): **135 → 128**. Pinned line `expect(count).toBe(135)`; actual now
   128. Seven call sites left the tree with the seven converted pages. Output:

   ```
   AssertionError: expected 128 to be 135
   - Expected  135
   + Received  128
    ❯ apps/erp/tests/t348-page-description-sweep.test.ts:175:19
   ```

2. **`apps/erp/tests/t348-page-description-sweep.test.ts` — SW3** (`admin/users`'s `<h1>` is paired
   with a `<PageDescription>`): now fails because the page has no `<h1>`. `admin/stores` still
   passes (it is a rule-2 skip). Output:

   ```
   AssertionError: admin/users/page.tsx: expected an <h1>-then-<PageDescription> pair:
   expected undefined to be 'PageDescription'
    ❯ apps/erp/tests/t348-page-description-sweep.test.ts:148:75
   ```

   SW3 and SW4 are the same file and the same cause (the converted page's h1 + description moved
   into `Page`'s props). BOSS approves the new numbers.

3. `apps/erp/tests/action-link-sweep.test.ts` — **passed unchanged** (18 tests). No control was
   added or removed; only the `<div>` around the title, which holds none.

### Smoketest

**Not done — N/A, screens only.** There is no signed-in ERP session available to this builder (the
work order says the same for this screen-only class of task). Nothing was seen in a browser, so no
claim is made about how the seven headers look; the tests read source and the typecheck is clean.

### Diff check (BUILDER-PROMPT step 8)

`git fetch origin main`, then `git diff --stat origin/main...HEAD -- apps/`:

```
 apps/erp/src/app/admin/users/page.tsx              | 15 ++--
 apps/erp/src/app/attendance/leave/page.tsx         | 15 ++--
 apps/erp/src/app/expenses/reimbursements/page.tsx  | 15 ++--
 apps/erp/src/app/liabilities/unpaid/page.tsx       | 15 ++--
 apps/erp/src/app/reports/balance-sheet/page.tsx    | 17 ++--
 apps/erp/src/app/reports/income-statement/page.tsx | 15 ++--
 apps/erp/src/app/reports/trial-balance/page.tsx    | 15 ++--
 apps/erp/tests/t540-page-header-sweep.test.ts      | 92 ++++++++++++++++++++++
 8 files changed, 127 insertions(+), 72 deletions(-)
```

The ninth file in `git diff --stat origin/main...HEAD` is this work order copy
(`docs/tasks/540-page-header-sweep.md`) — 9 files in total. **No deleted file, and nothing outside
§4** (7 listed pages, the new test, the docs copy). No file outside the work order's file list was
touched.

### Commits

- `T-540: 7 ERP pages use the Page title/description header`
- `T-540: test the converted page headers, and the work order copy`

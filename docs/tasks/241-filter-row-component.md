# T-241 — A real `<FilterRow>` component (DEF-199's deferred item)

> **Status**: ✅ **APPROVED — building.** Written by lane E (`ianla-60`, Sonnet 5), 2026-09-08, as
> a spec reserving task number 239; renumbered to **T-241** by the orchestrator (`ianla-44`) after
> three lanes reserved 239 within the same minute (D → 239 DEF-229, B → 240 two-column, E → 241,
> by arrival order). DEF-199 (`docs/DEFECTS-REGISTER.md:269`) closed the overflow bug in T-234
> slice 2 and named the component still owed: *"A real `<FilterRow>` component is still owed —
> extracting it and migrating 22 pages is the right end state and was deliberately kept out of a
> mechanical sweep."* This spec is that follow-up. All four open questions below were ruled on by
> the orchestrator before build — see **§9 Rulings**.

---

## 0. Assessment first (bible §13 row 163 style)

| | |
|---|---|
| **Utilisation** | Every list/report screen that lets a person narrow what they see by store, date, or status — 25+ routes today, and the default shape for every new list page from here on |
| **Effort** | Small — one ~40-line component, a mechanical per-page swap (delete a `<form>` tag and its close, keep every field exactly as authored), no new dependency, no migration |
| **Adopt or build** | Build. This is in-house Tailwind-only JSX matching the rest of `apps/erp`, same reasoning as `Page`/`PageHeader` (T-234): no shared UI kit exists in this app to adopt from |
| **Recommendation** | Build the component now; migrate **Family A** (defined below) now; **Family B** (defined below) is a separate task, logged by the orchestrator — not built here |

---

## 1. Census — counted at HEAD, not trusted from T-234's prose

Counted at `0e41ae1` (`git rev-parse HEAD`), no `page.tsx`/`components/**.tsx` files changed since
T-234 slice 2's commit `6a3b9ac` (`git diff --stat 6a3b9ac..HEAD -- apps/erp/src/app` is empty), so
this count is current.

**Known hit, printed first, so a script matching nothing cannot pass as zero:**
```
apps/erp/src/app/attendance/lane/page.tsx:76:  <form method="get" className="flex flex-wrap items-center gap-2">
```

**Method**: `grep -rio 'method="get"' apps/erp/src --include="*.tsx"`, counted two ways that must
agree — total occurrences (`grep -ro | wc -l`) versus the sum of per-file counts
(`grep -rc | awk -F: '{sum+=$2} END{print sum}'` after excluding zero-matches) — because
`reference_shareat_count_elements_not_files` records three defects on this exact task caused by
counting files instead of rows (a page can hold two). Both methods agree at **37** total
(26 lowercase + 11 uppercase — the two families below).

**⭐ `apps/erp/src/app/commissary/catalogue/page.tsx` is the one file carrying TWO filter rows
(lines 74 and 248) — stated here on its own line because that single fact is the whole lesson of
yesterday's three count-elements-not-files defects, and the next person to recount this needs to
find it in ten seconds, not rediscover it.** Every other Family A file carries exactly one.

**26 vs. T-234's "25", confirmed by the orchestrator as the correct current figure** (T-234's
register entry explicitly declined to pin its "already wrapped" count down to a single number —
*"varies from 7 to 15 with how widely the scan is drawn, so it is deliberately not quoted"*; my
positional recount, every line printed and read, not just `grep -c`, found 26 and could not find a
26th row that shouldn't count). The orchestrator is correcting DEF-199's register row to 26; not
done by this lane.

### 1.1 Two visually and structurally distinct families exist — this was not visible from T-234's docs

**Family A — lowercase `method="get"`, no card, the DEF-199 population, IN SCOPE for this task.**
`flex flex-wrap items-end gap-3[, gap-y-2]` directly on the `<form>`, no background/border,
`<label className="text-sm"><span className="block text-neutral-600 dark:text-neutral-400">…</span>
<select|input …/></label>` fields, a bare `<button type="submit">` in a page-local `BTN_SM`/`BTN`
class. **26 rows, 25 files** (`commissary/catalogue` carries two — see above):

```
attendance/lane, attendance/terminals, budgets, commissary/catalogue (×2), commissary/discrepancies,
commissary/orders, expenses/recurring, inventory/counts, inventory/deliveries, inventory/locations,
inventory/low-stock, inventory (root), inventory/pos-map, inventory/pos-usage, inventory/production,
inventory/returns, inventory/transfers, inventory/usage, settings/sales-channels,
settings/wastage-monitor, staff/hire, staff (root), trade/orders, trade/returns, wastage
```

Sampled 21 of the 26 rows directly (not grepped-and-trusted). Field shapes found: a single
`<select>` (majority — Store/Commissary/Branch/Channel), two `<select>`s (`inventory/pos-usage`:
store + sales day; `budgets`: store + period), a `<select>` + `<input type="checkbox">`
(`commissary/discrepancies`: "Include resolved"), a `<select>` + free-text `<input>`
(`staff/hire`: "Find a person", submit label "Search" — the one row that is not labelled "Show"),
and one row (`commissary/catalogue` second form) carrying a preceding `<input type="hidden">`.
`attendance/lane` additionally wraps its whole form in `{stores.length > 1 && (…)}` — the page
still owns that conditional; the component does not need to know about it.

**Family B — uppercase `method="GET"`, a bordered card, mostly pre-componentised. OUT OF SCOPE —
logged by the orchestrator as its own task.** `flex flex-wrap items-end gap-4 rounded-lg border
border-neutral-200 bg-neutral-50 p-4 text-sm dark:border-neutral-800 dark:bg-neutral-900`, `<label
className="flex flex-col gap-1"><span className="text-xs font-medium text-neutral-500
dark:text-neutral-400">…</span>…</label>` fields, sometimes an explicit `action="/…"` instead of
relying on the current URL. **11 occurrences**:

- Four already extracted into shared components — `apps/erp/src/components/reports/ReportFilters.tsx`
  (used by `cash-flow`, `income-statement`, `trial-balance`; `ap-aging`/`ar-aging` use
  `AgingFilters.tsx`, which itself renders `BalanceSheetFilters.tsx` internally; `balance-sheet`
  uses `BalanceSheetFilters.tsx` directly) and `apps/erp/src/components/dashboard/RangeForm.tsx`
  (used by `/`, the dashboard). **Reason this stays a separate task, per the orchestrator**: folding
  an already-partly-extracted family into a new generic component turns an extraction into a
  redesign of a family that already has components — one shape at a time.
- Seven inline in their own `page.tsx`, not sharing a component: `expenses`, `fixed-assets`,
  `sales-days`, `statutory-discounts`, `reports/pos-reconciliation`, `reports/sales-rollup`,
  `reports/store-comparison`. Two of these (`fixed-assets`, `sales-days`) build fields through a
  small `Picker` helper **duplicated in both files** (not shared); `reports/store-comparison`'s
  filter is a `<fieldset>` of same-named checkboxes (`stores`), not a `<select>` — structurally the
  furthest from Family A of anything found.

**Why this matters**: DEF-199's register text and T-234's task doc both describe "the shared filter
row" as one pattern and one number. It is two patterns. Some Family B members (`expenses`,
`fixed-assets`) were in DEF-199's *original* 24-route overflow list alongside Family A members, so
the two families are not unrelated — but by the time of the fix they already carried `flex-wrap`
(confirmed by reading both files), so nothing here is currently broken; this task is about
*extraction*, not the overflow bug DEF-199 already closed.

---

## 2. Scope — the exact files touched, and the collision guard

**Create** `apps/erp/src/components/FilterRow.tsx` — sits beside `nav.tsx`, `scheduler-status.tsx`,
`two-way-picker.tsx` (generic, not chrome — not under `shell/`; not report-specific — not under
`reports/`).

**Modify** — exactly the 25 Family A files listed in §1.1, deleting each one's `<form method="get"
className="…">…<button type="submit" className="…">Show|Search</button></form>` and replacing with
`<FilterRow>…children unchanged…</FilterRow>`. Every field inside (labels, selects, inputs, the
hidden field, the checkbox) is carried over **verbatim** — no option list, name attribute,
`defaultValue`, or label text changes.

**⛔ Collision guard (lane B holds six `[id]` detail pages — cash-requests, fixed-assets,
liabilities, loans, owners, prepaid; lane D holds `admin/users/[personId]/page.tsx` — same tree,
concurrent build): I do not glob `apps/erp/src/app/**/page.tsx`. I touch only the 25 paths named in
§1.1, individually, by the file tool.** Lane B measured that none of the 25 detail pages carries a
GET filter row, so on this file list the overlap is zero — a glob is the one thing that would break
that.

**Not touched — Family B** (7 inline files + 4 shared components — separate task). Not touched —
any `[id]`/detail route. Not touched — `nav.tsx`, `AppShell`/`Page`/`PageHeader`, any page's data
loading, server action, or table/section content.

**Tests**: `apps/erp/tests/filter-row.test.tsx` (new, unit) — see §6.

---

## 3. Contract

```tsx
export interface FilterRowProps {
  /** The field controls — each an already-labelled <label> (or hidden input), unchanged from
   *  today's per-page markup. FilterRow does not know what a field looks like. */
  readonly children: ReactNode;
  /** Default "Show" (24 of 26 rows today). staff/hire is the one caller passing "Search". */
  readonly submitLabel?: string;
  /** Escape hatch for the ~6 rows that carry a leading `mt-6` before the flex row today
   *  (commissary/discrepancies, inventory/low-stock, inventory (root), inventory/returns,
   *  inventory/transfers, trade/orders) — FilterRow does not guess outer spacing; the page states
   *  it, exactly as it does today, so migrating a row changes nothing about its position on the
   *  page. */
  readonly className?: string;
}

export function FilterRow({ children, submitLabel = 'Show', className }: FilterRowProps) {
  return (
    <form method="get" className={`flex flex-wrap items-end gap-3 gap-y-2 ${className ?? ''}`}>
      {children}
      <button type="submit" className={SUBMIT_BTN}>{submitLabel}</button>
    </form>
  );
}
```

- **`gap-y-2` becomes unconditional.** Today 7 of the 26 rows omit it (they were already
  single-line and didn't need it); folding it into the component is inert when a row never wraps
  and is the fix when it does — the exact class DEF-199 needed, applied uniformly instead of by
  per-page judgement, which is how DEF-199 happened in the first place.
- **The submit button's className is NOT preserved per-page — approved by the orchestrator
  (2026-09-08) as a named, visible change, not a silent one.** Today's button styling is not one
  string: `staff/page.tsx`'s `BTN_SM` is `px-3 py-2 text-sm`, `commissary/catalogue`'s `BTN_SM` is
  `px-2 py-1 text-xs` (visibly smaller), `settings/wastage-monitor`'s `BTN` is `rounded … px-4 py-2
  text-sm font-medium hover:bg-neutral-100` (bold, different hover, square-er corners). The
  majority shape — appearing verbatim, inline, with no named constant, in ~10 of the 25 files
  (`inventory/deliveries`, `wastage`, `trade/returns`, `inventory/returns`, `inventory/transfers`,
  `inventory/low-stock`, `inventory/counts`, `inventory (root)`, and close variants elsewhere) — is:

  ```
  rounded-md border border-neutral-300 px-3 py-2 text-sm hover:bg-neutral-50
  dark:border-neutral-700 dark:hover:bg-neutral-900
  ```

  `SUBMIT_BTN` in the component is this string. **`commissary/catalogue` and
  `settings/wastage-monitor` are the two screens whose buttons visibly change** — done-condition
  (§8): both appear in the screenshot set at phone and laptop width, so "visibly changes" is
  something looked at, not predicted.
- **No `action` prop.** All 26 Family A rows omit `action` today (GET defaults to the current
  page); nothing in the census needs it, so it is not added on spec — see the project norm against
  building for hypothetical requirements.
- **Field markup itself is out of scope** (label wrapper class, `text-sm` vs `text-xs`, `SELECT`
  vs `INPUT` vs `FIELD` page-local constants) — FilterRow owns the row, not the field. Unifying
  field styling is a larger, separable call (bible §1.2c: UI/UX changes want their own reasoning)
  and is named as a follow-up in §7, not attempted here.

---

## 4. Overlap with lane B's two-column detail-page task (T-240) — checked, not assumed

None of Family A's 25 files is a dynamic `[id]`/`[…Id]` route — they are all top-level list pages.
Lane B's own measurement (relayed by the orchestrator) confirms none of its 25 `[id]` detail pages
carries a GET filter row — the two populations are disjoint by route shape AND confirmed by direct
measurement on both sides. The collision guard in §2 is what keeps that true through the build (no
glob).

---

## 5. Invariants

1. Every migrated page submits the same GET params, in the same names, with the same
   `defaultValue`s, to the same implicit destination (current URL) as today — verified per file by
   diffing the rendered field list, not just "it compiles."
2. No page's visible field content, option list, or label text changes.
3. `document.documentElement.scrollWidth − clientWidth === 0` at 390px holds on all 25 routes after
   migration (DEF-199 stays closed — this task must not reopen it).
4. The submit button's visible size/shade changes on `commissary/catalogue` and
   `settings/wastage-monitor`, and nowhere else — both screenshotted per §8.
5. `commissary/catalogue`'s second form keeps its leading `<input type="hidden" name="commissary"
   value={commissaryStoreId} />` working exactly as today.
6. `attendance/lane`'s `{stores.length > 1 && (…)}` guard around the whole row is preserved by the
   page, not moved into the component.

---

## 6. Tests

- **Unit** `apps/erp/tests/filter-row.test.tsx`: renders `<FilterRow>` with children and asserts
  `method="get"`, children present, default submit label "Show", a custom `submitLabel` override,
  and that a passed `className` appears alongside the fixed layout classes. Static-import (the 5s
  `resetModules` trap — memory `reference_vitest_resetmodules_import_timeout`).
- **Guard** (orchestrator wires it, per T-234's own pattern with `page-container.test.ts`): the 25
  target files contain `<FilterRow` and no longer contain a raw `<form method="get"` — enumerated
  from the list in §1.1, not from a live grep, so a file quietly dropped from scope is a red test
  rather than a silent gap.
- **Browser**: re-run the 390/768/1280 sweep on the 25 affected routes (reuse
  `~/.claude/skills/orchestrator/tools/smoke-t234.mjs`'s method) confirming 0px overflow — proving
  invariant 3. Screenshot set includes `commissary/catalogue` and `settings/wastage-monitor`, each
  at 390px and 1280px, per the orchestrator's done-condition on the button-style change.

---

## 7. Out of scope

Family B (its own task, logged by the orchestrator). Unifying field markup (`SELECT`/`INPUT`/`FIELD`
constants) across pages. A "clear filters" affordance — none of the 26 rows has one today, and
adding one is a behaviour change, not an extraction. Multi-select or date-range field types beyond
what's already in the 26 rows.

---

## 8. Done when

typecheck · the new unit test · the guard (if the orchestrator wires it) · the 25-route browser
sweep at three widths, 0px overflow, screenshots incl. `commissary/catalogue` and
`settings/wastage-monitor` at 390px + 1280px · self-reviewed · `docs/DEFECTS-REGISTER.md`'s DEF-199
row gets a closing note that the component now exists and the 25→26 correction (orchestrator) ·
`docs/ROADMAP.html` line (orchestrator).

---

## 9. Rulings (orchestrator `ianla-44`, 2026-09-08)

1. **26 confirmed** as the correct count; T-234's register "25" was the stale number, corrected by
   the orchestrator, not this lane. Requirement: name the two-row file on its own line — done in §1.
2. **Scope split approved**: Family A (lowercase) only. Family B (uppercase, card, partly
   pre-componentised) is a separate task, logged by the orchestrator.
3. **Majority submit-button style approved as canonical**, with `commissary/catalogue` and
   `settings/wastage-monitor` named as the two visibly-changed screens and both required in the
   screenshot set at phone + laptop width.
4. **Task number**: 239 → **241** (D took 239 for DEF-229, B took 240 for the two-column task, both
   reserved in the same minute I wrote 239 — earliest-arrival kept its number, this lane renumbers).
5. **Collision guard**: touch only the 25 named files, never a glob over
   `apps/erp/src/app/**/page.tsx` — B's six `[id]` pages and D's `admin/users/[personId]/page.tsx`
   are the same tree, concurrently in flight.

Re-ran `node ~/.claude/skills/orchestrator/tools/make-test-dbs.mjs shareat_test_def219` before
touching anything, per the re-adopt brief (0137 landed since this lane's last session).

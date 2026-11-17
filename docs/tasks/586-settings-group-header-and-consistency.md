# T-586 — Settings group: one page header, one empty state, honest READMEs

**Status:** spec · 2026-11-17 · written by the planner (lead). Not started.

## Scope boundary (read this first)

This is the **non-settlement** simplification of the `/settings` group. Claude currently owns the
store-code / settlement-wiring rework on `/settings/sales-channels` and `/channel-settlements`
(the T-515 follow-up). **Do not touch `settings/sales-channels/**` or `channel-settlements/**`
here** — folding those two pages into the shared header is listed in §6 as a follow-up for after
Claude lands. This task never enters the settlement data model, the store-key / partner-code fields,
or any domain/schema file.

## The problem

Seven settings pages hand-roll the same header — a "Settings / X" breadcrumb, an `<h1>`, and a
`<PageDescription>` — while `Page`/`PageHeader` (`components/shell/Page.tsx`) already own
`title` + `description` + `actions`. The one thing that keeps them hand-rolling is the
**breadcrumb**, which `PageHeader` does not support. `Page.tsx`'s own comment names this:
*"`PageHeader` exists for new pages and for a later, deliberate pass"* — this is that pass, scoped
to the settings group.

The six divergent crumb implementations:

| Page | Crumb shape |
|---|---|
| `organization`, `expense-categories` | inline `<p>`, anchor `className="underline"` |
| `pos-link`, `pos-tablet`, `usage-tolerance` | inline `<p>`, anchor `className={ACTION_LINK}` |
| `sales-channels`, `wastage-monitor` | local `function Crumb()` |
| `attendance` | **no crumb at all** |

## Decisions

1. **Extend `PageHeader`/`Page`** with an optional `crumb?: ReactNode` rendered **above** the
   `<h1>`. Widen `Page`/`PageHeader`'s `description` prop from `string` to `ReactNode`
   (`PageDescription` already accepts `ReactNode`; a `string` is a valid `ReactNode`, so this
   is inert for existing callers).
2. **Migrate the seven in-scope pages** to pass `title`/`description`/`crumb` through `<Page>`
   and delete each page's hand-rolled `<div><crumb/><h1/><PageDescription/></div>`. `attendance`
   gains a crumb for the first time.
3. **One "no stores yet" empty state** for the store-scoped settings screens (`wastage-monitor` +
   `attendance`; `sales-channels` folds in later).
4. **Dedupe `wastage-monitor`'s add-vs-edit `<Select>`** — the same Monitor field is written
   twice (an `EditableRecord` branch and an open add-form branch).
5. **Fix the stale, generic README Overview** across the settings READMEs.
6. **Add an accurate "who can edit" note** to each settings-hub card.

## Files this task may touch

Component:
- `apps/erp/src/components/shell/Page.tsx` — add `crumb` to `Page` + `PageHeader`; widen
  `description` to `ReactNode`.

Pages (migrate to `<Page density="table" title crumb description>`):
- `apps/erp/src/app/settings/organization/page.tsx`
- `apps/erp/src/app/settings/expense-categories/page.tsx`
- `apps/erp/src/app/settings/pos-link/page.tsx`
- `apps/erp/src/app/settings/pos-tablet/page.tsx`
- `apps/erp/src/app/settings/usage-tolerance/page.tsx`
- `apps/erp/src/app/settings/wastage-monitor/page.tsx` (also decisions 3 + 4)
- `apps/erp/src/app/settings/attendance/page.tsx` (add crumb; also decision 3)

Hub:
- `apps/erp/src/app/settings/page.tsx` — add a `restriction` note to `SettingsCard`. ⛔ Keep
  every `href` a **literal string at the call site** (the `nav-route-reachability` guard); do not
  rebuild the card list from a data array.

Docs:
- `apps/erp/src/app/settings/README.md` + the eight `settings/*/README.md` — replace the
  copy-pasted *"Configuration screens for organization, attendance, POS links, sales channels and
  monitoring"* Overview sentence (which names only 5 of the 8 screens) with each screen's own
  one-liner; make the parent's child list current.

## Contract (crumb)

```tsx
// components/shell/Page.tsx
export interface PageProps {
  // …existing…
  /** Optional breadcrumb rendered ABOVE the title, e.g. <><a href="/settings">Settings</a> / X</>. */
  readonly crumb?: ReactNode;
  readonly title?: string;
  readonly description?: ReactNode; // widened from string
}
```

`PageHeader` renders `{crumb && <p className="text-xs text-neutral-500 dark:text-neutral-400">{crumb}</p>}`
immediately before the title/description flex row. A caller passes the crumb as literal JSX so the
`href="/settings"` stays visible to the reachability guard:

```tsx
<Page
  density="table"
  crumb={<><a href="/settings" className="underline">Settings</a> / Organisation</>}
  title="Organisation"
  description={<>The registered identity the books are kept under … each branch&apos;s TIN code lives on <a href="/admin/stores" className="underline">its store</a>.</>}
>
```

## Invariants

1. Every migrated page keeps its exact `<h1>` text and description copy. No wording changes except
   the crumb (unified) and `attendance` gaining a crumb.
2. The crumb's `<a href="/settings">` stays a **literal `href=` string at each call site** so
   `nav-route-reachability` still sees it. Do not build the crumb from a data array.
3. No page's GET params, form field names, server actions, or data loading change — presentation only.
4. The only named visual deltas: the description gains the header's `mt-1` (was bare), and the
   crumb anchor style is unified (previously `underline` vs `ACTION_LINK`).
5. `density` stays `table` on every page; no width changes (T-384 made `table` full width).
6. The `wastage-monitor` add-vs-edit dedupe keeps both branches' exact `<option>` list, `name`,
   `defaultValue` and the "— nobody (the store absorbs after 15 days) —" sentinel.

## Tests

- `nav-route-reachability` (literal-href guard) — green.
- `page-description` sweep — every settings route still carries a `PageDescription`.
- `apps/erp/tests/t348-page-description.test.ts`, `t348-resolver-page-description.test.ts` — green.
- `apps/erp/tests/t444-compact-workspace.test.ts`, `t446-white-workspace.test.ts` — green.
- New unit test for `Page`/`PageHeader`: `crumb` renders above the `<h1>`, and `description`
  accepts ReactNode (a link) — `apps/erp/tests/page-crumb.test.tsx`.
- `npm run typecheck` clean; focused ERP unit run green.

## Out of scope / deferred

- **`settings/sales-channels/**` and `channel-settlements/**`** — Claude owns the settlement
  rework now. After it lands: fold sales-channels' local `Crumb()` into the shared header and
  re-apply the shared store-field. Log as a follow-up; do not do it here.
- **`settings/pos-link` add-vs-edit dedupe** (the link form is rendered twice) — larger and riskier
  on a 532-line page already restructured by T-512; a separate task if wanted.
- **A shared "store `<Select>` field"** (the `{s.name} ({s.code})` field inside `FilterRow`) —
  T-241's deferred field-unification; with `sales-channels` excluded the population is only
  `wastage-monitor` + `attendance` and they differ, so not now.
- **T-585's "one store screen with sections"** — explicitly deferred until the settlement / switch /
  tablets work stops moving. This task does not start it.

## Done when

`npm run typecheck` · the new `page-crumb` unit test · the suites above green · self-reviewed ·
before/after screenshots of two migrated pages (phone + desktop) showing the header is unchanged
except the crumb · committed.

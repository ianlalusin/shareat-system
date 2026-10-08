/**
 * **The one container every route uses.** T-234 slice 2, `docs/tasks/234-responsive-shell-sidebar-nav.md` §3.
 *
 * ## ⛔ Why one container, and why few widths (now one: see T-384 S2a below)
 *
 * Before this, page width was ad hoc: 101 routes chose between six different `max-w-*` values with
 * no rule behind any of them — `5xl` ×48, `4xl` ×32, `3xl` ×13, `md` ×3, `6xl` ×3, `2xl` ×2. A
 * report and a two-field form were the same width; two sibling lists were not. The density is the
 * rule those six were standing in for, and it is chosen by what the page IS, never by what it
 * happens to be today (§3.2, as amended 2026-09-08).
 *
 * ## ⚠️ This renders a `<div>`, NOT a `<main>` — deliberately
 *
 * Slice 1's `AppShell` owns the single `<main>` landmark for the document. Every page used to BE a
 * `<main>`, so if this one were too we would ship two per document — an invalid landmark structure
 * and an a11y defect that no test in this repo would have caught. Settled with lane E before either
 * slice was built. ⛔ Do not "tidy" this into a `<main>`.
 *
 * ## T-384 S2a (2026-10-08): one width
 *
 * Ian: "i want all forms to adjust based on screen size and always use full width". So `form` is
 * gone from `PageDensity` (any `density="table"` stops compiling), and `table` and `wide` carry no
 * cap: the content box is the viewport minus the sidebar and the page padding, at every size.
 * `wide` is kept as a documented alias of `table`; it is identical to it now. `narrow` stays for
 * the sign-in, setup and clock cards. Forms adapt to the space with `FormGrid` and `Field`
 * (`components/ui/FormGrid.tsx`).
 */
import type { ReactNode } from 'react';
import { PageDescription } from './PageDescription';

export type PageDensity = 'narrow' | 'table' | 'wide';

/**
 * ⛔ `narrow` HAS NO CALLER TODAY, and that is recorded rather than left to be found.
 *
 * The only three `max-w-md` pages are `/sign-in`, `/setup` and `/clock`, and all three are
 * pre-session or kiosk screens that own their own layout and are allowlisted out of the sweep. It
 * is kept because the next confirmation or single-field screen is its first caller and the
 * alternative is that page inventing a seventh width. **A documented intent with a written reason
 * is a different thing from a silent orphan** — if you are reading this because nothing uses it,
 * that is expected, not a leftover.
 */
const WIDTH: Record<PageDensity, string> = {
  /** 28rem — a single field or a confirmation. */
  narrow: 'max-w-md',
  /** No cap: every page uses the full width (Ian, 2026-10-08). The default. */
  table: '',
  /** Alias of `table`, kept so the 14 report pages are not churned. Identical to `table` now. */
  wide: '',
};

export interface PageProps {
  readonly density: PageDensity;
  /**
   * ⚠️ Optional, and the T-234 sweep passes NEITHER this nor `actions`.
   *
   * All 101 routes already render their own heading, and they are not uniform — some carry a
   * breadcrumb, a description, a status badge, or the title inside a flex row with a button. Moving
   * them into this prop is a content change, which slice 2's own invariant forbids (§3.4.3), and it
   * is the same reason the two-column detail aside was dropped from this slice. `PageHeader` exists
   * for new pages and for a later, deliberate pass; the candidates are nominated in T-234's report.
   */
  readonly title?: string;
  readonly description?: string;
  readonly actions?: ReactNode;
  /**
   * The page's own vertical rhythm, carried forward verbatim so the sweep changed width and
   * padding and nothing else.
   *
   * Across the **132 wrappers** swept (98 routes; 34 of them have early-return branches with a
   * wrapper of their own): `space-y-6` ×86 — the default, so those pass nothing — `space-y-4` ×9,
   * `space-y-8` ×8, and **29 with no vertical spacing at all**, which pass `className=""`.
   *
   * ⛔ **That empty string is load-bearing, not noise.** `??` treats `''` as a value and only
   * `undefined` as absent, so omitting the prop on those 29 would silently add 24 px of spacing to
   * pages that never had any — a third visual change nobody approved. It was missed twice: once
   * per-file, once per-branch, because 17 of the 29 are early returns whose parent page DID have
   * spacing. If you are tempted to "clean up" a `className=""`, this is what it is doing.
   *
   * ⚠️ `space-y-5` exists in this app exactly once, on `/clock`, which is allowlisted and never
   * swept — so no caller passes it and you will not find one.
   */
  readonly className?: string;
  readonly children: ReactNode;
}

export function Page({ density, title, description, actions, className, children }: PageProps) {
  return (
    <div
      // ⚠️ `w-full` matters: without it a short page inside a flex shell can shrink-to-fit and the
      // `mx-auto` centring silently stops applying.
      className={`mx-auto w-full${WIDTH[density] ? ` ${WIDTH[density]}` : ''} px-4 py-4 md:px-6 md:py-6 xl:px-8 ${className ?? 'space-y-6'}`}
    >
      {title !== undefined && (
        <PageHeader title={title} description={description} actions={actions} />
      )}
      {children}
    </div>
  );
}

export interface PageHeaderProps {
  readonly title: string;
  readonly description?: string;
  readonly actions?: ReactNode;
}

/**
 * Title and description on the left, actions on the right.
 *
 * ⚠️ **`flex-wrap`, so a phone stacks them rather than squeezing.** This is DEF-199's lesson one
 * layer up: a label beside a button in a row that cannot wrap is what made twelve routes scroll
 * sideways at 390 px. A header is the same shape and would fail the same way.
 */
export function PageHeader({ title, description, actions }: PageHeaderProps) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
      <div className="min-w-0 flex-1">
        <h1 className="text-2xl font-semibold">{title}</h1>
        {description && <PageDescription className="mt-1">{description}</PageDescription>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

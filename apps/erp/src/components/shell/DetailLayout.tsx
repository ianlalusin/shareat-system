/**
 * **The two-column detail page.** T-240, `docs/tasks/240-two-column-detail-pages.md`.
 *
 * A record's long content on the left, its position pinned on the right — so the number you came
 * to the page for stays on screen while you read a forty-row schedule. Six pages use it
 * (`cash-requests`, `fixed-assets`, `liabilities`, `loans`, `owners`, `prepaid`, all `/[id]`); the
 * other nineteen detail pages have no summary block to put in a rail, which is why this is six
 * pages and not a sweep.
 *
 * Goes INSIDE `<Page density="table">`, never instead of it. `Page` owns the width, this owns the
 * split.
 *
 * ## ⛔ Why this renders `<div>` and not `<aside>`
 *
 * `<aside>` announces *complementary* content — tangential to the document. The outstanding
 * balance of a loan is not tangential to the loan; it is the most important thing on the page, and
 * calling it complementary tells a screen-reader user the opposite of the truth. It is also not a
 * `<main>` — `AppShell` owns the document's one landmark, and `tests/unit/page-container.test.ts`
 * asserts the shell's total is exactly one. ⚠️ **This file lives in the directory that guard
 * scans**: the word `<main>` is free in a comment (it strips them first) and turns the suite red
 * in code.
 *
 * ## ⭐ The summary is FIRST in the DOM and SECOND on screen
 *
 * Placed by explicit grid lines (`col-start`/`row-start`), not by source order. Below 1440 there is
 * no grid at all, so the summary is simply where it has always been — first — and a phone, a
 * tablet and a 1280 laptop change by exactly nothing. Reading order and tab order are what they
 * were before this component existed.
 *
 * ⛔ **Do not "simplify" this into source-order-plus-`order-first`.** That reverses what a screen
 * reader reads on every phone in the business to save one utility class on a laptop.
 *
 * ## The breakpoint is 1440, and it is not a taste
 *
 * With the sidebar expanded (its default at ≥1280) and `table` density, the content box is
 * `min(viewport − 320, 1280)` and this splits it into `box − 344` plus a `20rem` rail:
 *
 * | Viewport | Content box | Record column | |
 * |---|---|---|---|
 * | 1280 | 960 | **616** | ⛔ `liabilities`' `min-w-[680px]` and `loans`' `min-w-[640px]` tables begin scrolling sideways — which they do not today |
 * | 1366 | 1046 | 702 | clears 680 by 22 px; too close to ship on |
 * | **1440** | 1120 | **776** | ✅ every page clears its widest content by ≥96 px |
 * | 1536 | 1216 | 872 | ✅ |
 * | ≥1600 | 1280 (capped) | 936 | ✅ |
 *
 * ⚠️ At 1280 that overflow would **not** have failed T-234's invariant: those tables sit in
 * `overflow-x-auto`, so the *page* still measures zero. The DOM assertion passes and the screen is
 * worse. That is the tablet rail's lesson, and it is why the rail starts at 1440 — also the
 * machine `Page`'s `table` cap was tuned for. A 1280 or 1366 laptop keeps today's single column.
 *
 * `min-[1440px]` is an arbitrary variant rather than a named breakpoint on purpose:
 * `tailwind.config.ts` is shared, T-234 left it untouched, and one variant in one file is the
 * smaller footprint.
 *
 * ## ⚠️ What every caller has to remember
 *
 * **Tailwind breakpoints are VIEWPORT queries, not container queries** (and this app has no
 * container-query plugin). A `sm:grid-cols-4` strip does not become one column because it is now
 * in a 320 px rail — at a 1440 viewport `sm` is still active, and four tiles render at 74 px each.
 * Nothing overflows, every DOM measurement passes, and it is unreadable.
 *
 * So **every grid moved into `summary` carries `min-[1440px]:grid-cols-1`**, and the same applies
 * one level in: `fixed-assets` had a `lg:grid-cols-2` block *inside* the record column whose fields
 * fell to 164 px once the rail took 344 px away, and it carries the same class for the same reason.
 * ⛔ This is the failure mode that no test in this repo can see. If you add a seventh page, the
 * proof is a screenshot at 1440, not a green suite.
 *
 * ## Why `summary` is required
 *
 * A rail with nothing in it is a record column 344 px narrower for no gain. An optional prop
 * invites exactly that, which is why the five pages whose trailing `<dl>` renders only on a
 * terminal status are deliberately NOT callers (T-240 §6) — a draft would show an empty rail.
 */
import type { ReactNode } from 'react';

export interface DetailLayoutProps {
  /**
   * The record's position: figures, and the paragraph that explains them. **Read-only content
   * only.** Actions stay in `children` — see the class comment.
   */
  readonly summary: ReactNode;
  /** The record itself, in the order it is already in. */
  readonly children: ReactNode;
}

export function DetailLayout({ summary, children }: DetailLayoutProps) {
  return (
    <div className="space-y-6 min-[1440px]:grid min-[1440px]:grid-cols-[minmax(0,1fr)_20rem] min-[1440px]:gap-6 min-[1440px]:space-y-0">
      {/*
        `self-start`, because a grid item stretches to the row by default and a stretched item
        cannot stick. `top-6` matches the page's own `md:py-6`; `TopBar` is `md:hidden`, so at these
        widths there is no bar for the rail to slide under.
      */}
      <div className="min-[1440px]:sticky min-[1440px]:top-6 min-[1440px]:col-start-2 min-[1440px]:row-start-1 min-[1440px]:self-start">
        {summary}
      </div>
      {/*
        ⚠️ `min-w-0` is load-bearing: without it a `min-w-[680px]` table forces the `1fr` track
        wider than its share and pushes the rail off the screen. DEF-149's shape, two levels in.
        `space-y-6` reproduces the gap these sections had as direct children of `Page`.
      */}
      <div className="min-w-0 space-y-6 min-[1440px]:col-start-1 min-[1440px]:row-start-1">
        {children}
      </div>
    </div>
  );
}

# T-249 — DEF-239: an action link is a 16px tap target on a touch-first product

> **Status**: ✅ **APPROVED — building, with a corrected §4.** Written by lane B (`ianla-3a`) in
> plan mode on Opus, 2026-09-09. Fixes the 4 instances the register named; §3 reports 5 more found
> in passing, not fixed here — filed by the orchestrator as **DEF-243**.
>
> ⚠️ **§4's original design (`min-h-11 -my-3.5`, 44px) is superseded — measured, not assumed, to
> cause destructive overlap** in `customers/[customerId]`'s two consecutive-row instances: two
> adjacent "entry" links' tap boxes overlapped by 3.2px, and probing the visual gap between rows
> returned the WRONG row's link — a large target firing the wrong customer's journal entry, worse
> than the 16px defect it replaced. Measured with a static repro compiled through the project's own
> installed Tailwind CLI (real generated CSS, not hand-approximated classes) and
> `document.elementFromPoint()` in a live browser at 390px — see §4a. The other two contexts
> (`expense-categories`' Rename/Retire pairing, and the readiness panel's worst case of two red
> checks stacked) measured clean at 44px; only the customers-table row height is the actual
> constraint. **Ruling (orchestrator, 2026-09-09): `py-2 / -my-2`, 32px, uniformly across all 4** —
> a context-dependent size is the exact decision that produced DEF-239 in the first place, so the
> uniform property outranks the extra pixels. §4/§5/§9 below reflect the built value; §4a is the
> measurement that produced the ruling. **32px is stated honestly as NOT meeting the 44px
> Apple/Material/T-241 bar** — it is the best available while holding invariant 2 (zero visible
> layout change); giving the customers-table rows more room is a layout change and its own future
> task, logged by the orchestrator, not decided here.

---

## 0. Assessment

| | |
|---|---|
| **Utilisation** | Every one of these 4 screens, every time a manager taps the link instead of typos-and-retries. Also every FUTURE action link, once the shared class exists to reach for |
| **Effort** | Small. 1 new file (~10 lines), 4 one-line className edits, 1 guard test |
| **Adopt or build** | Build — one shared className string, matching this app's existing `SUBMIT_BTN`/`BTN_SM` convention (`FilterRow.tsx`, `locations/page.tsx`), not a new UI kit |
| **Recommendation** | Build. Fix all 4 named instances with one shared, reusable class (§4) rather than four bespoke fixes — directly answers "how does a future link avoid this" by making the safe choice the easy one |

---

## 1. Goal

Every action link/button sharing the undersized `text-xs underline underline-offset-2` idiom gets a
real ≥32px tap target (§4a — 44px was the goal, measured unsafe in one context, see the status
banner), with **zero visible layout change** — no row grows, nothing shifts — and a
shared class any future instance reaches for instead of retyping the bare combo.

---

## 2. Two things this is not, confirmed by re-reading rather than assumed

1. **Not a T-243 regression.** `git show 523be5b^ -- apps/erp/src/app/admin/stores/\[id\]/page.tsx`
   — the two hand-wired links T-243 replaced already carried this exact class. T-243's invariant 3
   promised "same text, same URL, same place" and delivered it; the defect predates the task.
2. **Not the viewport-breakpoint trap.** Lane C measured 118×16 and 127×16 identically at 390 and
   1280 — a globally undersized target, not a responsive failure. No breakpoint is added.

---

## 3. Census — the named population, and what else the exact string search missed

**Known hit printed first** (`reference_sweep_needs_nonzero_control`):
```
apps/erp/src/app/admin/stores/[id]/page.tsx:119
```

**The 4 named in DEF-239**, re-confirmed at current HEAD (line numbers match the register exactly,
so nothing has drifted since lane C measured):

| File:line | Element | Context |
|---|---|---|
| `admin/stores/[id]/page.tsx:119` | `<Link>` "Add a sales channel →" / "Issue a PIN from Staff →" (T-243's `remedy`) | Own line, beneath a detail sentence, generous `space-y-3` list |
| `customers/[customerId]/page.tsx:336` | `<Link>` "entry" | Inline in a `<td>`, immediately after `{c.referenceNo}` |
| `customers/[customerId]/page.tsx:455` | `<Link>` "entry" | Inline in a `<td>`, immediately after `{c.collectionDate}` |
| `settings/expense-categories/page.tsx:127` | `<button type="submit">` "Rename" | Inline in a `flex` row beside a text `<input>`, inside a table cell |

**⭐ Found in passing, re-grepping for the SHAPE (`text-xs` + `underline`, zero padding) rather than
trusting the exact literal string** — this is the same "count elements, not files" discipline the
register itself invokes, applied one level further: the literal-string search the register ran
undercounts, because 5 more instances use the identical shape with an extra class spliced in
(`text-neutral-500`), which breaks an exact-substring match but not the geometry:

| File:line | Text | Same 16px shape? |
|---|---|---|
| `cutover/count/page.tsx:48` | "← Back to the conversion" | Yes — `text-xs …underline underline-offset-2`, no padding |
| `cutover/opening/page.tsx:50` | "← Back to the conversion" | Yes, identical |
| `settings/expense-categories/page.tsx:153` | "Retire"/"Reinstate" (a second, different button on the same page) | Yes |
| `settings/sales-channels/page.tsx:241` | "Retire this channel" | Yes |
| `staff/[employmentId]/credentials/page.tsx:76` | "← Back to employment" | Yes (`underline-offset-4`, same zero-padding height) |

**Not fixed here — reported in §10.** These weren't in DEF-239's stated population or this task's
stub, and pulling them in would turn a 4-instance, 3-file sweep into a 9-instance, 8-file one
without a ruling. The shared class this task builds (§4) is exactly what a follow-up would apply to
all 5 in an afternoon — named so nobody re-discovers them from scratch.

---

## 4. The fix — one shared class, self-cancelling padding, no visual movement

```ts
// apps/erp/src/components/action-link.ts — new, pure, zero imports
/**
 * DEF-239 / T-249. A small underlined action link or submit button with a REAL tap target and NO
 * visible size change: `py-2` (8px each side) sets the true hit box to 32px; `-my-2` (the same
 * Tailwind step, so it cancels exactly by construction rather than by hand-computed arithmetic)
 * pulls the box back to sit exactly where the bare 16px-tall text sat, so no row grows and no
 * sibling shifts — `getBoundingClientRect` still reports the full padded height, because negative
 * margin repositions a box, it does not shrink it.
 *
 * ⚠️ **32px, not 44px — a measured ruling, not the higher bar.** `min-h-11 -my-3.5` (44px) was
 * this task's original design and is WRONG: measured (§4a) to make two adjacent
 * `customers/[customerId]` "entry" links overlap by 3.2px, so a tap in the visual gap between two
 * rows opens the WRONG customer's journal entry — worse than the 16px target it replaced. 32px is
 * the largest size that stays safe in that context without growing the row (orchestrator ruling,
 * 2026-09-09). It clears WCAG 2.5.8 AA (24×24) but NOT the 44px Apple/Material/T-241 bar — giving
 * the customers-table rows more room to reach 44px safely is a layout change, its own future task.
 *
 * Drop this on any future small text action instead of typing `text-xs underline
 * underline-offset-2` by hand — that bare combo is how DEF-239 reached 4 instances, and (§3) 5
 * more (DEF-243) found while building this fix.
 */
export const ACTION_LINK =
  'inline-flex items-center py-2 -my-2 text-xs underline underline-offset-2';
```

### 4a. The measurement that produced the ruling

Built a static repro compiling the project's own installed Tailwind CLI (v3.4.19) against the exact
markup shapes of all 3 files — real generated CSS, not hand-approximated classes — served over a
throwaway localhost port (no `npm run dev`, no project build), opened in Chrome at 390px.
`document.elementFromPoint()` at each link's visual centre, plus the midpoint of every adjacent gap:

| Context | Size tested | Result |
|---|---|---|
| `customers/[customerId]` — 2 "entry" links, consecutive table rows | 44px (`min-h-11 -my-3.5`) | ⛔ **Overlap confirmed**: row 1 box `top=47.6 bottom=91.6`, row 2 box `top=88.4 bottom=132.4` — 3.2px overlap. Gap probe at y=90.0 returns row 2's link, not neutral space. Reproduced for both adjacent pairs. |
| Same rows | 32px (`py-2 -my-2`) | ✅ No overlap either pair. Gap probes land on the neutral `<td>`. |
| `expense-categories` — Rename (fixed) above Retire (unfixed, DEF-243) | 44px | ✅ No overlap — 6.4px gap remains. |
| `admin/stores/[id]` readiness panel — worst case, 2 checks red at once (`salesChannel` + `signIn`), both remedies stacked via `space-y-3` | 44px | ✅ No overlap — 28px gap remains. |

**Why 32px uniformly, not 44px on the 2 safe contexts + 32px on customers**: the mixed option
reintroduces the exact context-dependent choice that produced DEF-239 — a future author has to know
which context they're in before picking a class. Monotonicity makes the uniform choice free: a
32px box cannot newly overlap anywhere a 44px box didn't, so the other two contexts don't need
re-measuring.

**Verified against this app's own Tailwind config, not assumed**: `apps/erp/tailwind.config.ts`'s
`content` is `['./src/**/*.{ts,tsx}']` — no `lib`/`components` exclusion (the
`reference_tailwind_content_globs_skip_lib` landmine does not apply to this glob), so a `.ts` leaf
file is scanned exactly like a page.

**The 4 edits** — each a className change only, copy and href untouched:

| File | Before | After |
|---|---|---|
| `admin/stores/[id]/page.tsx:119` | `className="text-xs underline underline-offset-2"` | `className={ACTION_LINK}` |
| `customers/[customerId]/page.tsx:336` | `className="ml-2 text-xs underline underline-offset-2"` | ``className={`ml-2 ${ACTION_LINK}`}`` |
| `customers/[customerId]/page.tsx:455` | `className="ml-2 text-xs underline underline-offset-2"` | ``className={`ml-2 ${ACTION_LINK}`}`` |
| `settings/expense-categories/page.tsx:127` | `className="text-xs underline underline-offset-2"` | `className={ACTION_LINK}` |

`ml-2` stays literal and separate (it is spacing from the preceding sibling text, unrelated to the
tap target) rather than folded into the shared constant, so a caller that doesn't need it doesn't
inherit it.

**Why one class for both contexts (own-line panel and dense table row), not two:** a growing-padding
variant for the panel and a cancelled-padding variant for the rows would mean a future author has to
know which context they're in before picking a class — exactly the judgment call that let the bare
literal get hand-typed 9 times. One class that is always visually inert and always correct removes
the decision entirely.

---

## 5. Invariants

1. Rendered box height at every one of the 4 sites is **≥32px** (`py-2`'s value, §4a's ruling) —
   the measurable pass the task itself demands, not a class name in a diff.
2. **Zero visible layout change**: no table row grows, no sibling shifts, no panel spacing changes.
   `-my-2` exactly cancels `py-2`'s added 16px (8px each side) by construction — same token, both
   properties.
3. ⛔ **No two adjacent instances' tap boxes overlap** — the invariant this task exists to hold,
   after §4a found it broken at 44px. Re-checked at build time in the real app, not re-derived.
4. Copy, `href`, and `type="submit"` are unchanged on all 4 — this is a className-only sweep.
5. T-243's invariant 4 still holds: the readiness remedy still renders only while `!c.ok`; nothing
   about *when* it renders changes, only its own box.
6. Sideways overflow stays 0px at 390px on all 4 routes — DEF-199/DEF-239's own clean baseline is
   not reopened.

---

## 6. Tests

**Unit** `apps/erp/tests/action-link-sweep.test.ts` — text-based, same reasoning as the
`READINESS_REMEDY_ROUTE` and `proxy.ts` guards (no Next/DOM rendering needed to check a class
string):
1. Known hit printed first, then fixed to 0: before the edit, `grep`-equivalent count of the bare
   literal `text-xs underline underline-offset-2` across `apps/erp/src` is **4** (proves the sweep
   started from the real population); after, **0**.
2. Each of the 4 target files contains `ACTION_LINK` (imported and used) — enumerated from §3's
   table, not from a live grep, so a file quietly dropped from the sweep is a red test.
3. `ACTION_LINK`'s own string contains `py-2` and a `-my-` cancellation — a drift guard, so a
   future edit cannot silently shrink the shared constant back toward 16px.

**Deliberately not built**: a guard catching the 5 near-variants in §3 — they use a different
literal string on purpose (not this task's population), and building a guard against them here
would either false-fail on landing (if scoped to catch them) or promise coverage it doesn't have
(if it silently excludes them). Left to whatever task adopts §10's finding.

**Not unit-testable**: the actual rendered pixel height and the "nothing moved" claim — no existing
harness renders a real page with Tailwind's generated CSS. Verified by the browser pass in §9.

---

## 7. Out of scope

The 5 found-in-passing instances (§3, §10) · unifying `text-xs`/label styling generally (T-241 §7
already named this as its own future call) · a `<ActionLink>` component that renders the element
itself (the 4 sites are 3 different tag/prop shapes — `<Link>` with `href`, `<Link>` with `ml-2`, a
`<button type="submit">` — a shared **class**, not a shared **component**, is the right size for
what's actually common between them) · WCAG citation as the argument (register's own instruction —
cite T-241 and Ian's rule, WCAG as corroboration only).

---

## 8. Done when

**Mine:** typecheck clean (`--incremental false`) · `npm test` green including the new guard,
watched to fail (4 found) before the edits and pass (0 found) after · diff self-reviewed line by
line, confirming only classNames changed · READY report with real numbers.

⚠️ **This is a rendered-size defect — a green suite proves nothing, stated plainly rather than
implied.** §4a's static-repro measurement is real (compiled through the project's own Tailwind CLI,
checked with `elementFromPoint` in a live browser) but it is not the actual app — both DoD steps
that would prove it there (browser smoketest, `npm run build`) are on my NEVER list. **Exact steps
for the orchestrator**, matching what caught DEF-239 in the first place and what the ruling asked
for:
(a) at 390px, measure the rendered box (computed height, not just `getBoundingClientRect` on the
text) of all 4 links/button — expect ≥32px, up from 16px, confirming §4a's finding holds in the
real app;
(b) `elementFromPoint` at each of the 4 visual centres returns that link/button, and the gap probes
between the two `customers/[customerId]` rows return the neutral `<td>`, not either link — the
assertion that the ruling actually held, not just the repro;
(c) confirm no row/panel visibly grew — screenshot each of the 4 sites before/after, same as T-241's
own before/after discipline;
(d) confirm the readiness panel's remedy still renders only while its check is red (T-243 invariant
5 — this task must not reopen it);
(e) 0px sideways overflow at 390 on all 4 routes, unchanged from DEF-199/DEF-239's baseline.

**Orchestrator's:** DEF-239's register row → `fixed`, recording the 44px→32px correction and why ·
DEF-243 (the 5-instance finding, §3/§10) · the browser pass above · `docs/ROADMAP.html`.

---

## 9. What I did not verify

The actual computed pixel geometry **in the real app** (no rendering harness available to me there)
— §4a's numbers are a real browser measurement, but of a static repro built to match the markup, not
the live pages themselves. `py-2` = 0.5rem = 8px, `-my-2` = -0.5rem = -8px, `text-xs` line-height =
1rem = 16px are Tailwind's documented scale values, confirmed by reading
`node_modules/tailwindcss/defaultTheme.js` directly rather than assumed. The orchestrator's browser
pass on the real app is what turns §4a's repro into a fact about production.

---

## 10. Found in passing, reported not fixed (RULES §13 row 164)

The 5 instances in §3 share DEF-239's exact defect shape and were missed by the register's own
literal-string count. Recommended register entry: *"DEF-239's fix pattern (`ACTION_LINK`,
`apps/erp/src/components/action-link.ts`) is unapplied at 5 more sites: `cutover/count:48`,
`cutover/opening:50`, a second `expense-categories` button at `:153`, `sales-channels:241`,
`staff/[employmentId]/credentials:76`. Same shape, found while building T-249, not in its scope."*

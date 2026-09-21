# T-334 — the v2 theme: brand red, a manual dark toggle, and one colour system instead of 65

**Status:** ⭐ **SPECCED 2026-09-21 by the orchestrator (`system32-df`), NOT BUILT.**
**Authority:** `docs/decisions/ADR-013-v2-erp-theme-and-brand-colour.md` — **Ian's ruling, 2026-09-19.**
⛔ **The colours are RULED and CLOSED. This task builds them; it does not revisit them.**
**Migration slot:** ⛔ **none — no schema change. A cookie is not a migration.**
**Depends on:** nothing.

> ⛔ **READ ADR-013 FIRST, INCLUDING ITS AMENDMENT 1.** It carries the nine-token palette, the
> measured surface, the contrast figures and the one blocking gap. This task is the *how*; the ADR
> is the *what* and the *why*, and it wins any disagreement.
> ⚠️ **Source of both:** the Claude Doc *"Support System Build Plan"* (2026-09-19), section **"V1
> visual restoration"**. ⛔ **The rest of that document — the support system itself — is OUT OF
> SCOPE and is not being actioned.** Ian, 2026-09-21.

---

## 1. The problem, measured — not "it looks wrong"

| Measured 2026-09-21 | Value |
|---|---|
| Colour tokens in `apps/erp/src/app/globals.css` | ⛔ **none.** It declares `color-scheme: light dark` and sidebar geometry, nothing else |
| `darkMode` key in `apps/erp/tailwind.config.ts` | ⛔ **absent — so Tailwind is on its default `media` strategy.** ⭐ **THIS IS THE BUG** |
| `theme: { extend: {} }` | empty |
| `dark:` utility usages | **3,485** across **152 files** |
| Concentration | top 15 files = **22.5%** of them. ⛔ **There is no spine; this cannot be fixed by touching ten files** |
| Files with a local `BTN`/`INPUT` constant | **65** |
| Distinct literal values behind those 65 | ⭐ **~8 `BTN` + ~9 `INPUT`** ("12+ distinct primary-button strings" in the source) |
| Colour families | neutral 4,763 · **red 781** · **amber 649** · emerald 370 · white 291 · green 200 |

⭐⭐ **THE TWO NUMBERS THAT DECIDE THE SHAPE OF THIS TASK:**
1. **~8–12 distinct strings across 65 files.** This is a **mechanical sweep**, not 65 judgement
   calls — which is what makes slice 3 safe to spread across commits and a candidate for a
   `Workflow` rather than a lane.
2. **No concentration.** 22.5% in the top 15 files means there is no "fix the shell and you are
   done". ⛔ **Anyone who promises this in one pass has not run the numbers.**

---

## 2. ⭐ THE FINDING THAT CHANGES THE PLAN — the theme CANNOT copy the sidebar's cookie pattern

ADR-013 §3 says to reuse the `data-sidebar-state` pattern. ⭐ **Reuse its SHAPE; it cannot reuse its
PLACEMENT, and the difference is load-bearing.** Measured:

- The sidebar attribute is written on **a `div` inside `AppShell`** (`Sidebar.tsx:104`,
  `data-sidebar-state={state ?? 'auto'}`), from a cookie read at `AppShell.tsx:34`.
- ⛔ **`AppShell` returns `<>{children}</>` early** when there is no session or the kiosk header is
  present (`AppShell.tsx:31`). **So sign-in, and every kiosk screen, never reach that attribute.**
- The theme needs `data-theme` on **`<html>`**, which lives in **`layout.tsx:12`** — a **different
  file**, currently **not `async`** and reading **no cookies**.

⭐ **Therefore the theme cookie is read in `layout.tsx`, not `AppShell`.** Two consequences, both
good, both to be stated rather than discovered:
1. ⭐ **Sign-in and kiosk screens get themed too** — they are currently outside the shell entirely.
2. ⚠️ **`layout.tsx` becomes `async` and dynamic.** ⛔ **Nothing is lost:** its own comment already
   records that *"every page under it is dynamic… each one calls `requireSession`, so nothing was
   static to lose."*

⛔ **Do NOT put the theme attribute inside `AppShell`.** It would leave `/sign-in` unthemed and
flashing, which is the first screen anyone sees.

---

## 3. Scope — four slices, in this order, and slice 1 ships alone

⛔ **Do not do this all at once.** Other lanes work in this tree. Each slice is independently
committable and independently revertible.

### ⭐ SLICE 1 — the half-day that carries most of the visible win

**This is the whole point of the ordering.** The source document's own words: *"`:root {
color-scheme: light }`, with `dark` only under `[data-theme="dark"]`. **This one change is what
makes v2 read as v1 immediately**, before any refactor."*

1. **`apps/erp/src/app/globals.css`** — declare the nine tokens on `:root`, and change
   `color-scheme: light dark` → `color-scheme: light`, with a `[data-theme="dark"]` block.
2. **`apps/erp/tailwind.config.ts`** — `darkMode: ['selector', '[data-theme="dark"]']`, and map the
   tokens into `theme.extend.colors`.
   ⭐⭐ **This is what keeps all 3,485 existing `dark:` classes working. NOTHING IS DELETED in this
   slice.** A `dark:` class stops firing from the OS and starts firing from the attribute.
3. **`apps/erp/src/components/shell/theme-state.ts`** (NEW) — `THEME_COOKIE_NAME`, `parseTheme`.
   ⭐ Copy the shape of `shell/sidebar-state.ts` exactly; that module exists for this reason.
4. **`apps/erp/src/app/layout.tsx`** — `async`, read the cookie, `<html data-theme={theme}>`.
   **Default `light` when the cookie is absent.**

**The nine tokens (ADR-013 A1.1, ruled — do not adjust):**
| Token | Value | Used for |
|---|---|---|
| `--brand` | `#d40909` | The **one** primary action per view, active nav, focus ring, wordmark. ⛔ Nothing else |
| `--brand-hover` | `#b00707` | Hover/pressed on the above |
| `--danger` | `#a00606` | Destructive actions and error text. ⛔ **Always outlined, never filled, always with an icon** |
| `--danger-surface` | `#fde7e7` | Error banner backgrounds, with a left bar |
| `--warning` | `#f4b942` | Pending, attention, needs-review. ⭐ **Where today's 649 ambers go.** ⛔ **Surface only, NEVER text** (1.77:1) |
| `--success` | `#059669` | Posted, verified, tied |
| `--canvas` | `#ffffff` | Page background |
| `--surface` | `#ffffff` + `#e5e5e5` border | Cards |
| `--ink` | `#1a1a1a` | Body text — the brand's own `shareat-black` |

### SLICE 2 — the components, used nowhere yet
`apps/erp/src/components/ui/{Button,Input,Card}.tsx` carrying the tokens. ⛔ **Not adopted by any
screen in this slice.** ~half a day.

### SLICE 3 — retire the 65 local constants
**A few files per commit**, highest-traffic first: the shell, `/`, `/sign-in`, `/staff`,
`/expenses`. ~2–3 days spread out. ⭐ **Because the 65 files share only ~8–12 distinct strings, this
is a mapping exercise, and a `Workflow` (one agent per file, deterministic, resumable) fits it
better than a lane.**

### SLICE 4 — the semantic sweep, last
Re-point the **781 `red-*` usages that mean *error*** onto `--danger` / `--danger-surface`, so brand
red is left holding only chrome. ~1 day.
⛔ **Last, not first:** until slices 1–3 exist there is nothing to re-point *onto*.

---

## 4. Invariants — what must be true at every commit

1. ⛔ **NO FLASH, NO LAYOUT SHIFT.** The theme must be correct in the **first server-rendered
   paint**, before any JS runs. `globals.css`'s own comment states this invariant for the sidebar
   (§2.4.4) and it is the reason the cookie is read server-side rather than in an effect.
2. ⛔ **A viewer with no cookie gets LIGHT**, regardless of their operating system. That is the
   ruling and it is the entire user-visible point of slice 1.
3. ⛔ **All 3,485 existing `dark:` classes keep working** through slices 1–2. Deleting them is
   slice 3/4 work, file by file, never a sweep.
4. ⭐ **One primary action per view.** `--brand` is not a decoration.
5. ⛔ **`--warning` never carries text** (1.77:1 on white — fails every standard).
6. ⛔ **Danger is a TREATMENT, not a hue** — outlined, with an icon. Brand red can no longer double
   as the error colour, and an outline is what keeps a destructive button from reading as the
   primary one.

---

## 5. Tests — and how you test a theme without asserting pixels

⚠️ **This is the part most likely to be done badly**, so the contract is named rather than left to
the lane. ⛔ **Do not screenshot-diff.** Assert the mechanism:

1. **Default is light with no cookie** — render `layout.tsx` server-side, assert `<html>` carries
   `data-theme="light"` (or no dark attribute), ⭐ **asserting the ATTRIBUTE VALUE as a literal, not
   the absence of a dark one.** *An assertion about an absence is satisfied by every cause of it,
   including the layout not rendering at all.*
2. **Cookie `dark` produces `data-theme="dark"`** in the first server-rendered HTML — same literal
   assertion, opposite value. ⭐ **These two are each other's positive control.**
3. **`parseTheme` rejects junk** — an arbitrary cookie value falls back to `light`, never to dark
   and never to a crash.
4. ⭐ **A `dark:` class still resolves under the selector strategy.** The cheapest real proof: a
   unit test over the built CSS, or a single component rendered under `[data-theme="dark"]`
   asserting the dark rule applies. ⛔ **Without this, slice 1 can silently neutralise 3,485
   classes and every other test still passes.**
5. **Contrast is a unit test, not a review note** — assert `--brand` ≥ 4.5:1 and `--danger` ≥ 7:1
   on `--canvas`, computed, so a future palette edit that breaks accessibility fails a gate rather
   than a reviewer's eye. ⭐ The figures are in ADR-013 §1: 5.47, 8.32, 1.77.
6. **§9.4 in a real browser** — ⛔ **and this is the one gate that cannot be argued away for a
   visual change.** Load `/sign-in` (outside the shell — §2) and one shell screen, in both themes,
   and **look at the screenshots**. ⚠️ Cite `docs/SMOKETEST.md` §3: the forged session **bypasses
   sign-in on purpose** and proves things about screens, **nothing about authentication**.

---

## 6. Out of scope

- ⛔ **Re-opening the palette.** Ruled. ADR-013.
- ⛔ **The support system** the source document is otherwise about. Ian, 2026-09-21.
- ⛔ **Touching `ERP-rebuild`, `POS`, `CUSTOMER` or `Shareat Website`** — read-only, always.
- **Deleting `dark:` classes en masse.** File by file in slices 3–4, or not at all.
- **`packages/ui`.** ⚠️ It **does not exist** (measured). Whether tokens eventually live there is
  undecided and is not this task's to decide — slice 2 puts components in `apps/erp` because that
  is where the only consumer is today.
- **Where the toggle lives in the UI**, and whether it is per-person or per-device. ⚠️ Slice 1
  ships the **mechanism and the default**; a control that flips the cookie is a later slice.

---

## 7. ⛔ The one blocking gap — dark mode's own text reds are NOT chosen

ADR-013 §1: `#d40909` is **3.84:1** on black and `#a00606` is **2.52:1** — ⛔ **both FAIL AA as text
on a dark surface.** The ruled palette is specified for **light**.

⚠️ **This does not block slices 1–4**, because slice 1 makes light the default and dark opt-in, and
the existing `dark:` classes keep whatever they do today. ⛔ **But dark mode must not be presented
as a supported theme until dark text reds are chosen**, and this task does not choose them — that
is a decision for Ian, not a value for a lane to pick.

---

## 8. Done when

Every §9 gate, per slice, including **§9.4 in a real browser with the screenshots actually looked
at** — for a visual change, a green build proves nothing a reader cares about.

⭐ **And specific to slice 1, the acceptance criterion in one sentence:**
**a machine set to OS-dark loads the app and sees it LIGHT, in the first paint, with no flash** —
and every one of the 3,485 `dark:` classes still resolves when `data-theme="dark"` is set.

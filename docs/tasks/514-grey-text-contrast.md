# T-514 — Faint grey text: every caption clears AA

Status: SPEC (Opus), 2026-11-03. Ian: "Start with grey text" (Impeccable audit 3 Nov, P1-1,
`docs/reviews/impeccable-audit-2026-11-03.md`). Branch `t-grey-text-contrast`, worktree `wt-t448-sweep`.
Queue row 72, after #137 (BOSS). Builds on T-387 S1 (warm-neutral ramp).

## Problem (measured on main b119272)

T-387 S1 re-valued `neutral` so the two common caption pairs pass: `text-neutral-500` on light (5.68:1) and
`dark:text-neutral-400` on dark (6.64:1). Their neighbours were never swept:

| Class | Uses | Contrast | Where it fails |
|---|---|---|---|
| `text-neutral-400` (no `dark:`) | 115 | 2.38–2.61:1 on canvas/surface/white | light mode — sidebar group names on every page (`SidebarNav.tsx:161`), "(inactive)", codes, secondary lines |
| `text-neutral-300` (no `dark:`) | 3 | lower still | light mode |
| `dark:text-neutral-600` / `-700` | 59 / 3 | 2.22 / 1.67:1 on dark surface | dark mode (latent: no toggle yet) |

The rendered Impeccable scan found 18 low-contrast hits on 12 routes, all this one pair (#a89f92).

## Fix

1. Light: `text-neutral-300|400` → `text-neutral-500` (= `--muted`), keeping any variant prefix
   (`hover:`, `group-hover:`, `placeholder:` …).
2. Dark: `dark:text-neutral-600|700` → `dark:text-neutral-400` (= dark `--muted`). Where the light half was
   also wrong (`text-neutral-400 dark:text-neutral-600`), the pair becomes `text-neutral-500 dark:text-neutral-400`.
3. **Exception — text on a dark fill.** When the same element or its nearest filled ancestor has a dark
   background in light mode (`bg-neutral-700..950`, `bg-ink`, `bg-brand`, `bg-danger` …), the light grey
   is legible and correct: leave it and add the site to the guard's named allow list with a one-line reason.
   Judge each with the Impeccable craft floor; do not guess from the class string alone.
4. `dark:text-neutral-800|900` are NOT in scope (used on light chips in dark mode; context-dependent).
5. `placeholder:` stays out of scope unless a site sets a faint placeholder explicitly.

## Guard

Extend `apps/erp/tests/t387-s1-warm-neutral.test.ts` rule 4 ("captions clear AA where they are used") with a
usage scan over `apps/erp/src/**/*.{ts,tsx}`: bare `text-neutral-300|400` (no `dark:` in the same variant
chain) and `dark:…text-neutral-600|700` fail, except entries in a named `DARK_FILL_ALLOWED` list
(`file` + exact snippet + reason). Each allow-list entry must still match its file (no stale entries).

## Contract

No behaviour change. Classes only; no layout, copy, token or ramp values change. Touch-target and action-link
baselines are re-measured, never hand-edited; any change in their numbers goes to BOSS for approval.

## Verification

Typecheck; the full unit project; the guard red on a reintroduced `text-neutral-400` and green after; a
re-run of the Impeccable rendered scan on the same 12 routes showing 0 `low-contrast`; before/after
screenshots of the sidebar and /sales-days.

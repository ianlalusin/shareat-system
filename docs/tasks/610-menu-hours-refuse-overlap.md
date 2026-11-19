# T-610: refuse overlapping menu hours at save time

**Owner:** builder (Sonnet). **Spec:** BOSS (Opus), 19 Nov 2026. **Ian, 19 Nov 2026:** "yes queue it, refuse overlapping hours".
**No migration.** Domain and screen only. **Risk:** low.

## Today

- On `/menu/hours` a store's menu hours (`menu_dayparts`) save even when one overlaps another, for example Lunch 10:00–15:00 and Dinner 14:00–22:00.
- The clash shows up only later. Migration 0233's offer guard refuses a second time-of-day price for the same package whose windows overlap, and `/menu/prices` shows "Two time-of-day prices … cover the same hours" (`apps/erp/src/app/menu/prices/page.tsx:196`).
- `daypartsOverlap` (`packages/domain/src/menu/daypart.ts:194`) already exists, matches the SQL twin `menu_daypart_windows_overlap` (proved by an integration test), and has **no production caller**.

## The rule

- Creating, editing (days, start, end) or re-activating a menu hour is **refused** when its window overlaps another **active** menu hour of the **same store**.
  - Use `daypartsOverlap`: half-open, so back-to-back windows (15:00 / 15:00) are allowed; overnight windows and the Saturday-to-Sunday wrap are handled there.
  - Retired (inactive) hours don't count.
- **Message** (plain words, names both): "Dinner (Mon–Sun 14:00–22:00) overlaps Lunch (Mon–Sun 10:00–15:00). Change one so they meet or leave a gap."
- **Concurrency:** take a per-store lock (or row lock on the store's dayparts) before checking, so two admins saving at once can't both slip through. Reuse whatever lock the daypart writers already take; if none, lock the store row `FOR UPDATE`.
- **Existing overlapping hours in the live data:** don't touch them.
  - Saving any change to one of them is refused until the overlap is fixed. The message says which hour it clashes with.
  - BOSS runs a read-only count on production after deploy and reports any found to Ian.

## Where

- The writers are `createDaypart` (`packages/domain/src/menu/dayparts.ts:99`), `updateDaypart` (`:118`) and any re-activate path; the screen is `apps/erp/src/app/menu/DaypartsSection.tsx`. Call the check there, inside the transaction, so every path (screen, CLI, future copy-to-store) is covered.
- `/menu/hours`: show the refusal through the page's existing error or flash pattern. Optionally, warn live in the form while times are typed (pure client check using the same function), but the server refusal is the rule.

## Tests (each with a mutant that goes red)

1. Lunch 10–15 exists; Dinner 14–22 is refused, with both names in the message.
2. Dinner 15–22 (back-to-back) is accepted.
3. Overnight 22:00–02:00 against an early 01:00–05:00 on the next day is refused; against 02:00–05:00 it's accepted.
4. A retired overlapping hour doesn't block.
5. Editing an existing hour into an overlap is refused; editing it without overlap is accepted.
6. Another store's hour never blocks.
7. Two concurrent saves that would overlap: one wins and one is refused (integration, two connections).

- **Mutants:** use a closed interval (back-to-back refused) → red; drop the store filter → red.
- **Pins:** domain-actions-have-callers (`daypartsOverlap` gains a caller; remove any UNWIRED row), t343, the production-caller ratchet.

## Out

- **A database trigger for the same rule:** the domain check plus a lock is enough. Offers already have the SQL guard.
- **Auto-fixing existing overlaps:** that's Ian's call per store.

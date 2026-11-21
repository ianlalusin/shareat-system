# T-616: the route map is enforced at runtime, not only by a test

**Owner:** builder (Sonnet). An auth auditor (Sonnet) reviews it. **Spec:** BOSS (Opus), 21 Nov 2026. **No migration, no new capability.**

## Why

- T-603 S5 made the route map deny-by-default **in CI only**. `tests/unit/route-capability-coverage.test.ts` fails a PR that adds an unmapped page.
- At runtime, `requirePageAccess` (`apps/erp/src/lib/page-access.tsx` ~45) still **allows** any signed-in person when `capabilitiesForRoute` returns `[]`. A page that slips past CI renders for everyone.

## The rule

1. Change `requirePageAccess` to refuse a route with no map entry. The viewer gets the existing no-access card, with an extra line for admins: "This page has no access rule yet."
2. **Except** routes on the approved-open list (`/`, `/sign-in`, `/setup`, `/clock`, with their citations) and routes on the **awaiting list** (the 13 routes T-603 S5 parked for Ian's decision).
   - The awaiting routes **keep today's behaviour** until Ian rules on each. Read both lists from the single source the coverage test already uses, so they can't drift apart.
   - A comment on the awaiting list names it as temporary and points to Ian's pending decision.
3. Server actions in an unmapped `'use server'` folder: the coverage test already guards them. Add no runtime check for actions in this task; actions keep their domain `authorize()`.
4. `/copy-from-store` (a shared action folder) is unchanged.

## Tests

- **A synthetic unmapped route** is refused at runtime for a signed-in manager, and the admin sees the extra line.
- **An approved-open route** (`/setup` rendering path, or `/clock`) still works.
- **An awaiting route** (e.g. `/items`) still renders for a signed-in person, as today.
- **A mapped route** is unchanged: allowed with the right word, refused without it.
- **Mutant:** let unmapped routes through → red.
- **Pins:** route-capability coverage, no-ungated-read-surface, t577, and the t343 auth census.

## Out

- Deciding the 13 awaiting routes: Ian answers, then each moves to the map in a small follow-up.

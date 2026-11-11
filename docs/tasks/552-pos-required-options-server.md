# T-552 - the POS server enforces required menu options (audit P-003)

Owner: AUDIT. Number given by BOSS 10 Nov 2026 (block T-552..T-557, DEF-819..820). No migration. Source finding:
`shareat-audits/OPEN/2026-11-09-pos-domain.md` (P-003). Base: origin/main d50a4e0.

## Defect (re-located on main d50a4e0)

`packages/domain/src/pos/order.ts` `optionDelta` (line 97) is the only server check on a line's chosen options.

- Line 98: `if (!chosen || chosen.length === 0) return { delta: 0, names: [] }`. A line with NO choices is accepted even when
  an offered group has `minSelections >= 1`.
- Lines 100-111 count only groups the caller actually chose from and check the MAXIMUM. Choosing from group A satisfies
  nothing about required group B.
- Caller: `writeLines` (order.ts:160). The tablet screen validates minimum and maximum (`apps/erp/src/app/pos/_orders/menu-filter.ts`
  `isOptionChoiceValid`) but the server owns validation and pricing; a stale or replayed event can omit the choice, and the
  paid option delta is silently dropped from the price.

## Fix

In `optionDelta`, after the existing per-value checks (keep every existing refusal: unknown, not on item, not orderable at
the store, too many, single-mode > 1), judge EVERY option group of the variant, not only chosen ones:

- For each group in `variant.optionGroups` with `minSelections > 0`: the number of distinct chosen values belonging to it must be
  `>= minSelections`, otherwise `refuse('pos: option required', '<Group name>: choose at least N for <item name>.')`
  (words a cashier can read; N singular/plural not required).
- The early return for an empty `chosen` must only skip the work when NO group is required.
- Match the screen's rule: read `isOptionChoiceValid` in `menu-filter.ts` and use the same treatment for a required group whose
  values are not orderable at this store (the screen and server must agree; if the screen cannot satisfy it the screen
  decides which, and the test pins that decision).
- Nothing else changes: price, names, replay behaviour, the `sameLine` check (that is T-556, not this task).

Files: `packages/domain/src/pos/order.ts`; test `packages/domain/tests/integration/t552-required-options.test.ts` (new, real
PostgreSQL). Reuse the fixture style of `t524-pos-domain.test.ts` (the `optionOn` helper near line 261 and the ruling-9 test near
line 708); a required group needs `min_selections = 1` on the group row.

## Tests (write FIRST, see them fail on d50a4e0, then fix)

Real-Postgres, direct domain call (`addLines`/the function the ruling-9 test uses) AND one case through the inbox path
(`t525-pos-inbox.test.ts` style: a `lines.added` event that omits `optionValueIds` for a required group is refused/quarantined, not
applied). Cases: required group, no `optionValueIds` -> refused; required group, choices only from ANOTHER group -> refused;
required group with its minimum -> accepted with the delta in the price; optional group (min 0) omitted -> still accepted at zero
delta; max still refused; a two-group item where only one is required.

## Out of scope

P-001 sameLine/replay content (T-556), P-002 payment rule (Ian), refills carrying flavour (P-007, spec first).

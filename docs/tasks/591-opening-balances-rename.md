# T-591: "Cutover" becomes "Opening balances" (labels + links), then a better stock-count screen

Ian, 17 Nov 2026: *"fix the ref to all cutover must be opening balance including the link"*, and earlier
*"update that to be labeled as opening balances … and improve the ui"* (about `/cutover/count`).

BOSS advised against it once (the page is one-time and locks org-wide after the books open,
`packages/domain/src/cutover/opening-stock.ts:167`; new stores start at zero and need no opening count).
Ian overrode that. This task carries out his ruling. No migration. No change to any number or posting.

## Slice A: rename what users see, and move the links (Sonnet builder)

### Routes (move the folders; old URLs redirect permanently)

| Old | New | Page title / h1 |
|---|---|---|
| `/cutover` | `/opening-balances` | "Opening balances" (h1: "Opening balances: 1 January 2027") |
| `/cutover/count` | `/opening-balances/stock-count` | "Opening stock count" |
| `/cutover/count/sheet` | `/opening-balances/stock-count/sheet` | "Opening stock count sheet" |
| `/cutover/opening` | `/opening-balances/balance-sheet` | "Opening balance sheet" |

- `apps/erp/next.config.js` `redirects()`: each old path → its new path, `permanent: true`, query string kept
  (`/cutover/count?store=X&room=Y` must land on `/opening-balances/stock-count?store=X&room=Y`). Explicit
  rules per path; no catch-all that maps `count` to `count`.
- Every `href`, `redirectWithFlash(...)`, `requirePageAccess(...)`, `requireSession(...)` and
  `revalidatePath(...)` that names an old route moves to the new one (`actions.ts`, the four pages).
- `apps/erp/src/lib/route-capability.ts`: the new paths keep `run_cutover` (same gate, same capability key).
  Remove the old keys. The redirect happens before the page, so the gate still applies on the new path.
- Nav (`apps/erp/src/components/nav.tsx`): `Opening stock count` → `/opening-balances/stock-count`,
  `Opening balance sheet` → `/opening-balances/balance-sheet`. If the hub `/opening-balances` has no nav entry
  today, leave that as it is (reachability is through the two links).

### Wording users see

- Every visible word "cutover", "conversion", "the 31 December conversion" on these four pages, their
  flash/refusal messages, and the capability's display label (if `run_cutover` has a human label anywhere in the
  access grid or users page) becomes "opening balances" wording. Examples: "← Back to the conversion" →
  "← Back to opening balances"; capability label → "Enter opening balances".
- Step text shown on the hub from `packages/domain/src/cutover/steps.ts`: drop "v1", "POST" and step codes
  like "C3P" from what the user reads (flagged by UI UX on T-589). Keep the codes in data; change only the
  visible titles/descriptions. Plain words, per `docs/GLOSSARY.md`.
- Refusal messages in `packages/domain/src/cutover/*.ts` that a user reads: same rule. Do not change the
  internal message prefix (`'opening: …'`) tests may key on, only the user-facing half.

### Deliberately OUT (with the reason)

- **Internal names stay**: `packages/domain/src/cutover/`, `packages/db/src/repo/cutover.ts`, table names,
  the `run_cutover` capability key, `CUTOVER_*` rule/typed-form constants, test file names. Renaming them
  touches the database, the capability matrix and hundreds of tests and changes nothing a user sees.
- Bible/ADR/discovery text keeps "cutover" as the project's word for the 1 Jan 2027 switch. README files next to
  the moved pages are updated (they describe routes).
- No behaviour change: the page still locks once the books are opened.

### Tests

- `apps/erp/tests/flash.test.ts`, `apps/erp/tests/integration/t390-s5-audit-web.test.ts` and any test or census
  that names an old route: move to the new route.
- New unit test: each of the four old paths (with a query string on `/cutover/count`) redirects permanently to
  its new path with the query kept; mutant: drop one rule and the test fails.
- Nav reachability and route-capability censuses must stay green with the new paths (no orphan, no ungated page).
- Grep proof in the hand-back: `git grep -n -i "cutover" -- 'apps/erp/src/**/*.tsx'` shows only identifiers,
  comments and imports, no visible text.
- `docs/ui-review/PAGES.md`: move the four rows to the new paths (the T-589 guard requires a row per page).

## Slice B: the stock-count screen (after A merges; design via the impeccable skill, Sonnet builder)

`/opening-balances/stock-count`:
1. One compact table per room (item, unit, quantity, cost per unit, value), replacing one tall card per item.
   Phone width: rows stack as today's cards.
2. A "Not counted yet" filter and an item search (URL parameter, server-rendered; no client state required).
3. A progress line kept in view while scrolling: counted N of M in this room, store total at cost.
4. Real visible labels for quantity and cost (not placeholder-only, not sr-only).
5. Room and store switches use the app's shared tab/pill component and colour tokens (the room switch hard-codes
   `neutral-900`).
6. A line under the title: one-time count for the stores moving to this system on 1 January 2027; a new store
   starts at zero and records stock through deliveries, transfers and its first normal stock count.
7. After the books are opened, the page shows the counts read-only with that date, instead of forms that refuse on
   save.

Keeps every rule on the page today: blank is not zero, a real zero is typed on purpose, merged multi-room items are
read-only, one cost per item per store. Screenshots before and after at desktop and phone width.

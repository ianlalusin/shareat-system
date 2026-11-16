# T-583 — Stock locations: room cards, and an empty room says so with a picture

Status: SPEC (Opus), 2026-11-15. Ian (direct, with erp2.shareat.net/inventory/locations and a screenshot of the Stock on
hand empty state): "make this cards instead of table. add something like on the screenshot if room is empty".
Impeccable refinement of an Operate surface. Number from BOSS.

## Today (origin/main c7c5275)
`apps/erp/src/app/inventory/locations/page.tsx` renders the rooms as a `Table` (Room, Type/role, Purpose, Default, Status,
Actions: EditableRecord edit, Make default, Deactivate/Reactivate, the default room's HelpTip). The page reads no stock.

## Design
- **Data:** `locationsPageData` also returns, per location, the number of items with a non-zero balance there, from the
  EXISTING `stockLedgerRepo.onHandByStore(tx, storeId)` (group its rows by `locationId`; count). No new SQL, same
  transaction.
- **Cards:** the `Table` becomes a grid (1 col phones, 2 from `sm`, 3 from `xl`), kit tokens (`rounded-[20px]
  border-surface-border bg-surface`). Each card:
  - Header: room name (font-medium) with the code under it (mono, muted); top-right pills: `Default` (when default),
    `Receiving` (purpose receiving), and `Inactive` for an inactive room (word + tone; inactive cards also `opacity-70`).
  - A muted line: `{type} · {role}`.
  - **Stock line:** `{n} items in stock` (singular "1 item"), linking to `/inventory?store={storeId}`.
    When n = 0 the card shows a SMALL empty state instead: the kit `EmptyState` look scaled for a card — the truck
    illustration (extend `EmptyState` with an optional `size="sm"` that draws the same SVG at ~60×45 and tighter spacing;
    do not fork the SVG), title `Nothing stored here yet`, body `Stock lands here through a delivery, a transfer or a count.`,
    action a secondary link-button `Record a delivery` → `/inventory/deliveries?store={storeId}`. Inactive rooms show only
    the line `Inactive — holds nothing new.` instead of the empty state.
  - Footer actions, unchanged in behaviour and order: the EditableRecord (Edit), Make default, Deactivate (retype confirm) /
    Reactivate, and the default room's HelpTip.
- **No rooms at all:** keep the warning banner and `Set up rooms` button as today (it is a setup step, not an empty room).
- The `+ Add room` FormModal, the store filter, the stock-model note and the header stay as they are.

## Contract
No behaviour change: same actions, fields, rules, confirm tiers, flash. One read added (existing repo function). No
migration. Censuses (action-link-sweep, touch-target, t450 phone-table-cards inventory if it lists this page,
editable-record) re-measured, never hand-edited.

## Verification
- `npx tsc --noEmit` (erp). The unit tests that read this page and the census tests; update only old-drawing assertions.
- New unit test: a room with 0 items renders the empty state with its Record a delivery link; a room with 3 renders
  "3 items in stock"; an inactive room renders neither empty state nor Deactivate; `EmptyState size="sm"` keeps one SVG.
- Integration tests that render `/inventory/locations` (grep): update old-drawing assertions; CI runs them.
- Rendered check at 1440 and 390 (Opus).

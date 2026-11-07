# T-527 — POS v2 Orders: open stands, seat a party, add items, heads (local-first)

> **Status:** spec written 7 Nov 2026 by the POS design lane (Opus planner). Not built.
> **Depends on:**
> - T-526 (the shell, `usePosState`, the drain, the offline actor);
> - T-530a (outbox `enqueue`, snapshot cache);
> - T-525 (`/api/pos/events`, `/api/pos/state`);
> - T-524 (`openStand`, `addLines`, `setHeadsCashier`, `cancelLine`, `listOpenStands`, `getSessionBill`).
>
> **Migration:** none. **Risk:** medium. It writes no money and no auth: every write is an outbox event that the server
> re-authorizes and re-prices. The builder is Sonnet. **Design:** §5.2 A2/A3, §5.4, §7 (`orders.png`,
> `orders-offline.png`, `new-order.png`). **Bible:** rows 307 (sold out), 313 (one billing tablet), 358 (package plus à
> la carte in the first order), 371 (tap, never type), 430. Use the `impeccable` skill.

## Goal

The cashier sees every open stand as a tile, seats a new party in a few taps, adds dishes, and corrects the head count.
This works the same whether the tablet is online or offline, because every change is written to the tablet's outbox
first and shown at once (A2, one code path). Payment (T-528) opens from the same screen.

**v1's goal (§1.2d):** `active-sessions-grid` + `start-session-form` + `family-order-modal` in `POS/src/components/cashier/`.
They show every live table with its time and guest counts, seat a package or à la carte party, and add items by category.
**v2 beats it:**
- stands are tapped and never typed (row 371);
- a sold-out item shows but cannot be tapped (row 307);
- the first order can mix a package with à la carte (row 358);
- nothing is written straight to a shared database: the server re-checks and re-prices every action.

## Out of scope

| Out | Why |
|---|---|
| Payment, discounts, the bill total | T-528. T-527 shows each line's qty × unit price for the cashier's eye only; it never totals the bill |
| Kitchen and refill queues | T-529 |
| Waiters adding items from a phone | Server and Kitchen positions do not hold `record_sale` (0240 defaults), and phones have no outbox. Open O1 |
| Keeping open stands across an **offline reload** | T-530 adds a persisted copy of the last state. T-527 keeps the server lists in memory only. Offline after a reload, only stands opened from this tablet's pending events show, with a note saying so |
| Take-out by customer name (v1's à la carte "customer") | Take-out opens with no stand (T-524). A name field is the one typed field, and it is optional. Release 1: a "Take-out" button with an optional name kept in the event's note |

## R1 — Reads

- **Open stands:** from T-526's `usePosState` (`openStands`, the T-524 `listOpenStands` shape).
- **Stand list and menu:** from the cached snapshot (`stands`, `menu`).
- **One table's lines:** a new read route `GET /api/pos/session/[sessionId]`.
  - It needs a person session and calls T-524 `getSessionBill` under `withOrgPrincipal`. The store comes from the pairing,
    else `?storeId`.
  - Capability `record_sale`; store scope is checked by the domain.
  - It answers 401, 403, or 404 for an unknown session, and `cache-control: no-store`.
  - It returns `lines` and `session` only, **without `pricing`**, because pricing is T-528's to show.
  - The tablet keeps the last body per session in memory.
- **The local view:** a pure reducer `projectOrders(server, pending, snapshot)` in `app/pos/_orders/project.ts`.
  - `server` is the last `openStands` plus the cached session bodies; `pending` is the outbox events from `listPending`.
  - It returns `{ tiles, sessions }` with the pending events applied on top:
    - `stand.opened` adds a tile;
    - `lines.added` appends lines marked **pending**;
    - `heads.set` changes the count;
    - `line.cancelled` marks a line cancelled.
  - It never invents server facts. A pending item shows a small "sending" dot until the server's next state includes it.
  - Once the outbox removes an event (applied, duplicate, quarantined or conflict), the reducer stops applying it.
  - When a quarantined event drops out of the view, the cashier's change disappears, so the shell's Toaster says "A change
    to Stand 4 was refused. A manager will see it." Use the drain report's results.

## R2 — Orders tab (`app/pos/page.tsx` plus `app/pos/_orders/*`)

- **The grid** of open stands, as in `orders.png`.
  - Each tile shows: the stand number, heads (cashier count; the server count beside it when they differ), the package
    name, time seated, and a time bar that turns to the warning colour past 1 h 30.
  - A **Heads?** tag shows when `headsServer` is null on a dine-in package table.
  - Order: oldest first.
  - Free stands do not show as tiles. They appear in the seat dialog.
  - Tapping a tile opens the **table panel** on the right.
- **Two main buttons:** **Seat a party** (red, the one primary action) and **Take-out**. Both are at least 60 px tall
  (design §7).
- **The offline band** (`orders-offline.png`) comes from T-526's pill state. Its text: "Offline. You can seat, add items,
  take cash and print. Card, refunds and day close wait for the internet."

## R3 — Seat a party (dialog, `new-order.png`)

1. **Stand:** a grid of the snapshot's stands. Stands in use (an open tile, including a pending one) are greyed out and
   cannot be tapped.
2. **Heads:** a stepper, 1–200, starting at 2.
3. **First order:** the menu picker (R4). It may hold a package and à la carte together (row 358). A package needs at
   least one head.
4. **Send:** one tap does all of this:
   - it creates `sessionId` with `crypto.randomUUID()`;
   - it enqueues **one** `stand.opened` event: `{sessionId, mode:'dine_in', standId, headsCashier, openedAtDevice, lines}`,
     where each line is `{lineId: randomUUID(), menuItemId, variantId?, qty, note?, addedAtDevice, optionValueIds?}`;
   - it closes the dialog and triggers the drain.
- For a package, `qty` = heads (T-524 ruling 3). The server derives the bundle's extra-heads line, so the tablet sends one
  line.
- **Take-out:** the same dialog without a stand or heads, using `mode:'take_out'`. A package cannot be picked (T-524
  refuses one on take-out). The optional name goes in the first line's note as "For: <name>".

## R4 — Menu picker (`app/pos/_orders/MenuPicker.tsx`)

- Categories run down the left (snapshot `categories`, by `sortOrder`), with item tiles on the right.
- Show items where `itemType` is `package` or `a_la_carte`, **and** `soldALaCarte` (or `soldInPackageSession` while a
  package session is open), **and** a variant whose `channels.store.orderable` is true. Never show `refill` items here;
  refills belong to T-529.
- An item with `orderable:false` shows greyed out, and it says "Sold out", or "From HH:MM" when the reason is
  `outside_hours` and `availableFrom` is set. It cannot be tapped (row 307).
- Tapping an item does one of these:
  - with one variant and no option groups, it adds 1;
  - otherwise it opens a small sheet with the variant choice and each option group (`single` as radio tiles, `multi` as
    toggles), obeying `minSelections` and `maxSelections`.
- The shown unit price is `amount` + Σ `priceDelta`, formatted by the kit's peso formatter. It is for display only; the
  server sets the real price.
- **Qty** uses a stepper. **Note** is the one typed field: optional, at most 120 characters.
- Item and category names come from the menu as they are.

## R5 — Table panel (right side)

- **Header:** the stand number, mode, heads with **− / +**, and the seated time.
  - Changing heads enqueues `heads.set {sessionId, headsCashier}`.
  - A decrease that the server will refuse (T-524: below the senior count, or a served package) is still sent. The
    refusal comes back as a quarantine (R1), so the screen stays honest about what the server decides.
- **Lines** (from the session body plus pending lines): qty × name, the options, the note, the kitchen status, and
  qty × unit price.
  - A pending line has the sending dot.
  - A cancelled line is struck through.
- **Add items** opens the menu picker. **Send** enqueues `lines.added {sessionId, lines}`.
- **Cancel a line:** only for an unserved, unpaid line. It needs a reason picked from a short list ("Wrong item",
  "Customer changed mind", "Duplicate"), or "Other" with typing. It enqueues `line.cancelled {lineId, reason}`.
- **Pay** (red, at least 60 px) opens T-528's payment. In T-527 it is a disabled button with the tooltip "Payment comes in
  the next update". Remove that wording when T-528 lands.

## R6 — Events: the one write path

- Every write goes through `enqueue({kind, personId, occurredAtDevice: new Date().toISOString(), payload})`.
  - `personId` is the offline actor when one is set (T-526 R5), else the online session's person.
  - The payload follows the T-524 input shapes, never with `storeId` or `pairingId` (T-525 R3).
- After `enqueue` resolves, call the shell's `requestDrain()`. A failed `enqueue` (no IndexedDB, quota) shows "This
  tablet could not save that. Nothing was sent. Try again." and changes nothing on screen.
- On a **phone or kitchen browser** (no pairing), the Orders tab is **read-only**. It has tiles and the table panel, but
  no Seat, Add, heads or cancel buttons, and it shows the note "Orders are taken on the store tablet."

## R7 — Tests (the tester writes them first)

- **Unit:**
  - `projectOrders`:
    - each event kind applied;
    - a removed event no longer applied;
    - a pending stand greys its stand out in the seat list;
    - a server tile and a pending event for the same session merge without a duplicate tile;
    - the cancelled and pending markers.
  - The menu filter:
    - refill items hidden;
    - sold out and outside hours shown greyed with the right label;
    - `soldInPackageSession` items show only with an open package;
    - the display price adds the option deltas.
  - The seat payload:
    - the exact `stand.opened` event shape for a package plus à la carte;
    - a package's `qty` = heads;
    - take-out refuses a package;
    - the payload never carries `storeId` or `pairingId`.
  - A failed `enqueue` changes nothing.
- **Integration** (route, real Postgres):
  - `GET /api/pos/session/[id]` gives 200 for a cashier with `record_sale`;
  - 401 with no session, 403 for another store, 404 for an unknown id;
  - the body has no `pricing` key.
- **End to end** (integration, through the real `/api/pos/events` with the T-525 fixtures): seat → add → heads → cancel
  shows in `listOpenStands` and `getSessionBill` as the screen expects.
- **Render (standing rule):** screenshots at 1280×800 of the grid online and offline, the seat dialog with a used stand
  greyed and a sold-out item, and the table panel with a pending line. Compare them with the mocks and attach them.

## R8 — Gates

Typecheck, the unit project, the integration files above, and the T-526 census files. Use the lane `_test` DB, and
never print `.env.local` values.

## Open

- ✅ **O1 RULED (Ian, 7 Nov; bible row 447): no phone ordering in release 1; the Orders tab is read-only on phones.** Original question: should waiters add dishes from their phones in release 1? It needs two things: a capability
  (give Server `record_sale`? or a narrower `add_pos_items`), and an online Server Action path for phones (no outbox).
  Proposal: not in release 1. At Lipa the cashier enters every order today (one tablet, row 313), and the waiter's phone
  does refills and heads (T-529).

## Addendum (planner, 7 Nov 2026, after the T-526 renders)

- **Store:** every read and write resolves the store through T-526's `effectiveStore(pairing, ?storeId)`. That includes
  `GET /api/pos/session/[id]` and `/api/pos/state`. On a paired tablet a different `?storeId` gets 403.
- **Phones (row 447):** Orders is read-only on any browser without a pairing.
- **Fixes from the T-526 renders:**
  - the disabled Sign in must look disabled: a muted fill, `aria-disabled`, and text contrast of at least 4.5:1;
  - the offline pill shows elapsed minutes at every width.
- **Not in T-527:**
  - the header's Printer item (T-528) and Till item (the Till slice);
  - `optionLabels`. The panel shows the stored line name, which already carries the chosen options.
- **The 90-minute warning** is a marked shortcut until T-539 S3 (migration 0245) lands, which must happen before go-live.

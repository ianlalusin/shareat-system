# T-529 — POS v2 Kitchen and Refills: tickets by station, mark served, ask for refills, confirm heads, printed tickets offline

> **Status:** spec written 7 Nov 2026 by the POS design lane (Opus planner). Not built.
> **Depends on:**
> - T-524: `serveLine`, `requestRefill`, `confirmHeads`, `listKitchenQueue` and `listRefillQueue`.
> - T-525: `/api/pos/state` (it already returns `kitchenQueue` and `refillQueue` when the person holds the capability).
> - T-526: the shell, plus the Kitchen theme rule from row 433.
> - T-527: the outbox write path.
> - T-528a: `formatKitchenTicket` and `formatRefillSlip`.
> - T-528: the print adapter.
> - T-546: the per-till printer settings.
>
> **Migration:** none. **Risk:** medium. The kitchen and refill actions are not money and no sale changes. Model: a
> Sonnet builder and a Sonnet auditor.
>
> **Design:** §5.4 (the kitchen prints offline), §7 `kitchen-dark.png`, `kitchen.png` and `refill.png`.
> **Bible rows:** 313 (one billing tablet), 433 (Kitchen defaults to dark), 447 (phones do refills and heads, not
> orders).
>
> Use `impeccable` for every screen.

## Goal

**Kitchen staff**, on a kitchen tablet or TV browser:
- see each table's unserved dishes for their station, oldest first;
- see late tickets in red;
- tap **Served**, or **All out** for a whole ticket.

**Servers**, on their phones:
- see the refill queue;
- ask for a refill for a table;
- confirm a table's head count.

**When the internet is down**, the store tablet prints the kitchen ticket and the refill slip on paper as each order
is sent (v1's outage print), and the kitchen screen catches up afterwards.

**v1's goal (§1.2d):** route food to the right station, pace refills, and keep the kitchen working through an outage.

**v2 beats it:**
- one server-held queue that every screen polls (A5);
- station routing from the menu (T-508);
- refills are price-0 lines, so they are never billed by mistake;
- a printed copy is used only when the tablet is offline, so the kitchen never gets a duplicate during normal running.

## Out of scope

| Out | Why |
|---|---|
| Waiters adding dishes from a phone | Row 447 |
| Bump bars, kitchen display hardware, or a sound alert | The browser screen is enough at Lipa's volume (design §3.2). Add later on a measured need |
| Cooking times and SLA reports | A later reporting slice. T-529 only colours a ticket late, using the station's `slaMinutes` from the menu |
| A per-station printer for each ticket while online | Online, the kitchen screen is the source of truth. Paper is the outage backstop (§5.4) |

## R1 — Kitchen tab (`app/pos/kitchen/page.tsx` plus `_kitchen/*`)

- **Reads:** `kitchenQueue` from `usePosState`. The `stationId` filter is passed to `/api/pos/state?stationId=` when one
  is chosen.
- **Layout (`kitchen-dark.png`):**
  - One card per table, oldest first by the first unserved line's `addedAtDevice`.
  - Each card shows: the stand number (or "Take-out"), the elapsed time, and the lines (qty × name, the options as
    stored in the name, and the note).
  - Each line has a **Served** button. **All out** marks every line on that card served.
  - Station filter chips run across the top: All plus each station from the snapshot's `menu.stations`. The chosen
    filter is remembered per device in `localStorage` (a per-viewer convenience, wrapped in try/catch).
  - **Late:** a card turns to the warning colour when its oldest line passes that station's `slaMinutes`. That value
    comes from the menu (master data), so it is not hard-coded.
  - Refill lines show with a "Refill" tag on the same card. They are served the same way.
- **Writes:** this is the kitchen screen's browser, with no pairing, online only (A9). Each action is a **Server
  Action** calling T-524 `serveLine` with `pairingId: null`. It authorizes `serve_pos_ticket` and scopes by
  `effectiveStore`.
  - **All out** calls `serveLine` once per line, inside one Server Action and one transaction per line. A partial
    failure reports which lines did not save.
  - A served line leaves the card at once (optimistic), then the poll confirms. A refusal brings it back and shows the
    domain's sentence.
- **On the store tablet:** the Kitchen tab is read-only (no Served buttons) unless the signed-in person holds
  `serve_pos_ticket`. There is **no** `line.served` outbox kind (T-525 R3), so serving from the tablet works online
  only. Offline, the tab says "The kitchen screen updates when the internet is back. Use the printed tickets."
- **Theme:** dark by default (row 433, already in T-526).

## R2 — Refills tab (`app/pos/refills/page.tsx` plus `_refills/*`)

- **Left, the queue (`refill.png`):** refill lines not yet served, from `refillQueue`, oldest first. Each shows the
  stand, the meats with their qty, who asked, and the time. A **Served** button appears for people with
  `serve_pos_ticket`.
- **Right, ask for a refill:**
  1. Pick a stand: one sliding row, as row 448 requires. Only open dine-in package tables can be picked.
  2. Step the meats: the snapshot's package `refillItemIds` for that table's package, each with a − and + stepper.
  3. **Send.**
  4. There are no prices.
- **Confirm heads** (phones, row 447): on the same tab, a "Heads" control per open table: a stepper plus **Confirm**,
  which calls T-524 `confirmHeads` (`confirm_pos_heads`).
- **Writes:**
  - **On a phone** (no pairing): Server Actions `requestRefill` and `confirmHeads` with `pairingId: null`. Online only:
    offline, the tab says "Refills need the internet on this phone. Ask at the till."
  - **On the store tablet:** `refill.requested` goes through the outbox (the T-525 kind), so it works offline too.
    Confirm heads on the tablet is not offered, because the tablet uses `heads.set`.
- Ids are made on the device as T-527 `ids.ts` UUIDv7, so a double tap or a resend is harmless (T-524 replay rules).

## R3 — Printed tickets when the tablet is offline (the outage backstop)

- When the store tablet enqueues `stand.opened` or `lines.added` **while offline**, it prints one kitchen ticket per
  station. It groups the new lines by the menu item's `stationId`, and prints only for stations whose
  `printOnOutage` is true in the snapshot. It uses `formatKitchenTicket` and the T-528 print adapter, with the paper
  width and copies from T-546.
- A `refill.requested` sent while offline prints one `formatRefillSlip`.
- A ticket number, for example `K-<terminalNo>-<seq>`, comes from a device counter kept in the T-530a `meta` store
  (`app.kitchenTicketSeq`). It is a print reference only, never stored on the server.
- **While online, nothing prints.** The kitchen screen is the source of truth.
- A print failure shows "Kitchen ticket did not print. Tap Reprint." with a Reprint action. The order is already saved.

## R4 — Tests (the tester writes them first; every ✅ needs its ✗)

- **Unit:**
  - kitchen card grouping and ordering;
  - the late colour at `slaMinutes` + 1 but not at `slaMinutes` − 1;
  - the station filter, and it is remembered;
  - refill lines tagged;
  - the refill stand picker shows only open dine-in package tables, in one row;
  - the meats come from `refillItemIds`;
  - the outage print groups lines by station and skips stations with `printOnOutage: false`;
  - printing happens only when offline;
  - the device ticket counter never repeats across a reopen;
  - read-only Kitchen on the tablet for a person without `serve_pos_ticket`.
- **Integration (real Postgres):**
  - The `serveLine` Server Action: works for Kitchen Staff, is refused for a Server, and is refused for another store.
  - All out with one line already served elsewhere gives a partial report.
  - The `requestRefill` and `confirmHeads` actions: a Server can, a Cashier without `confirm_pos_heads` cannot (0240
    defaults), and another store is refused.
  - A tablet `refill.requested` through `/api/pos/events` lands in `listRefillQueue`.
  - Serving it removes it from the queue.
- **Render (standing rule):** `kitchen-dark.png` and `refill.png` recreated at 1280×800 with real data, and the refill
  tab at 390. Attach them.

## R5 — Gates

Typecheck · the unit project · the integration files above, plus t524, t525, t526 and t527 · the census set. Flag any
action-link-sweep change for BOSS. Use the lane's own `_test` DB. **Never print any `.env.local` value.**

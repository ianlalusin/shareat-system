# T-559 — ERP `/pos`: switch lunch/dinner prices on the tablet while offline

> **Status:** spec written 11 Nov 2026 by the POS design lane (Opus planner). Not built. **Required before go-live**
> (bible row 454; audit item P-006).
> **Migration:** none. **Risk:** medium. It changes the price the tablet shows and sends; the server still re-prices
> every sale (T-524). The builder is Sonnet, and the auditor is Sonnet because it touches money display.
> **Model:** T-510 S4b, already done on 7 Nov for `apps/pos`. This task **ports the same behaviour** into the ERP `/pos`
> (T-526 to T-528).
> **Read:** `docs/tasks/510-menu-dayparts.md` R6 and the S4b line; `apps/pos/src/lib/menu/daypart-client.ts` and its
> parity test; `apps/pos/src/lib/menu/clock.ts`, `from-erp.ts`, `menuStore.ts` and `refresh.ts`. They are references:
> read them, then write the ERP versions. Never import from `apps/pos`.

## The gap

The T-525 snapshot carries the menu as the server resolved it **when the snapshot was fetched**. That covers the price
live at that moment, the `outside_hours` flags, and `nextChangeAt`. When dayparts exist, it also carries `hours` and
per-variant `slots` (T-510 S4/S4b).

Online, the tablet refetches at `nextChangeAt`. Offline across 17:00 it keeps the lunch price, so it bills dinner at
lunch prices and the server records a mismatch every time.

## Goal

The tablet works out, from its own clock, which daypart slot applies and prices with that slot. It switches at the
boundary and when the app resumes, offline or online, the same as `apps/pos` does since S4b.

## R1 — Device daypart resolver (`apps/erp/src/lib/pos-device/daypart-client.ts`)

- A pure copy of the window logic in the domain resolver (T-510 S2, `daypart.ts`): store-local time `Asia/Manila`,
  day of week at midnight.
- `resolveSlot(variant, hours, at)` returns the one slot whose window holds `at`.
  - **Fail closed:** zero slots holding, or two holding, gives "not orderable" with the reason
    `'no_price_for_this_time'`.
  - A variant with no `slots` falls back to its `channels.store` offer, which is how a menu without dayparts works
    unchanged.
  - Slots with no store row count as no slots.
- `nextBoundary(hours, at)` returns the next window edge.
- **Parity test** against the domain resolver: the same inputs over a table of times give the same answer. That
  covers both sides of 17:00 and 08:00, midnight, a weekend day missing from `days`, and overlapping or tied windows.
  This test is the guard that keeps the copy honest.

## R2 — Use it everywhere the tablet prices

- **T-527:**
  - The menu picker's orderable, greyed and price state uses `resolveSlot` at **now**.
  - A pending line's display price is the slot at its `addedAtDevice`. The server prices at the same time, T-524's
    `menus.at(lineTime)`.
  - A package whose window has closed shows as **one muted line** under the package picker, as in S4b.
  - A selected package whose window closes while the seat panel is open is cleared, with a note.
  - **Refills and flavours are NOT window-gated:** a running session keeps refilling, as S4b and T-510 R5 decided.
- **T-528:** `projectBill` uses each line's slot price at its `addedAtDevice`, for pending lines and for server lines
  that carry their own `unitPrice`. That way the device total equals the server total and no mismatch row is written.
- **T-529:** refill catalogue items are not gated.

## R3 — Re-check at the boundary, and on resume (the shell)

- A timer fires at `nextBoundary(hours, now)` and re-renders the priced views. It also re-arms on
  `visibilitychange → visible` and on `online`.
- **The 304 handoff** is the S4 audit's item (1). On a 304, the snapshot sync must update the cached `nextChangeAt`
  from the `x-next-change-at` header. Add it to `touchSnapshot` (T-530a contract: `touchSnapshot(fetchedAtMs)` gains
  an optional `nextChangeAt`). Otherwise a boundary that changes nothing visible leaves the timer dead.
  Coordinate with T-530a's real module: extend its signature in this task, if T-530a has merged, keeping it backward
  compatible.

## R4 — Tests (the tester writes them first)

- **Unit:**
  - the resolver parity table;
  - fail closed on zero and on two slots;
  - no slots falls back to the channel;
  - a pending line keeps the price of its `addedAtDevice` slot after the boundary passes;
  - the picker flips at 17:00 with an injected clock;
  - a closed package shows as a muted line;
  - a selected package is cleared at its window's close;
  - refills are not gated;
  - the timer re-arms on resume;
  - the 304 updates `nextChangeAt`.
- **Integration (real Postgres, real `/api/pos/events`):** a sale with a line added at 16:59 and another at 17:01,
  offline, prices each at its own slot. The server's recompute matches the device, so no mismatch audit row is
  written.
- **Render:** the menu picker at 16:59 and 17:01, with an injected clock, at 1280×800, attached.

## R5 — Gates

Typecheck, unit, the integration test above, plus t510, t526, t527, t528 and t529. Use the lane's own `_test` DB and
its **own `npm ci`**. **Never print any `.env.local` value.**

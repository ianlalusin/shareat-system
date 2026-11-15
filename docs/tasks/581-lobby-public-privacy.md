# T-581 — Lobby public page: no waiting count, any-case store code, no false Demo banner

> **Status:** spec written 15 Nov 2026 by the POS session (Opus) from Ian's live test at Lipa. No migration. Customer app
> only (`apps/customer`) plus one repo query; no `apps/pos` change, so the POS merge window does not apply.
> **Ian's ruling (15 Nov 2026, POS session):** option A — "yes A. only show how many is ahead of them". The public lobby
> page must never tell anyone how many parties are waiting; a diner who has checked in still sees their own place.

## Why

Anyone with the link `order.shareat.net/lobby?s=LIPA` could see "N parties waiting", i.e. how busy a store is. Ian does
not want the public to read that at any time. Found in the same test:
- `?s=lipa` (lower case) answers "Please check in at the counter." while `?s=LIPA` opens the line. Phones re-type links
  from history in lower case, so diners who type the link get sent to the counter.
- Every customer page shows "Demo - sample data, nothing is sent to the store", including `/lobby`, which is live and
  does send check-ins to the store.

## R1 — No waiting count on the public store answer

- `GET /api/lobby/store` (`apps/customer/src/server/lobby/handlers.ts`, `handleStore` and `closedStore`) stops sending
  `partiesWaiting`. The answer is `{ ok, store: { storeName, accepting }, error? }`. Remove the `countLive` call from
  that handler (keep the repo function if anything else uses it; delete it if nothing does).
- `LobbyStoreView` / `http-lobby-data.ts` / `lobby-data.ts` / `fixture-lobby-data.ts`: drop `partiesWaiting`.
- `lobby-view.ts`: `storeScreenView` no longer has `waitingText`; delete `waitingText()` and the page line that renders it.
- **Keep** `partiesAhead` / `positionText()` on the diner's own wait screen (`/api/lobby/me`): "You are next",
  "1 party ahead of you", "N parties ahead of you". That answer is per diner (cookie-bound) and is Ian's chosen view.

## R2 — Store code in any letter case

- `getStoreIdByCode` (`packages/db/src/repo/lobby.ts`) matches the code case-insensitively
  (`lower(stores.code) = lower($code)`), still scoped to the org. Store codes are unique per org; if two codes of one
  org differ only by case, the lookup must refuse (return undefined) rather than pick one — test it.
- Every lobby route that takes `?s=` / `storeCode` goes through this lookup, so `lipa`, `Lipa` and `LIPA` all behave
  the same. The check-in links the page builds keep the code as typed.

## R3 — Demo banner only where it is true

- The menu, cart, orders, bill, account and join screens still run on fixture data, so the banner stays there.
- `/lobby` and everything under it is live: `DemoBanner` must not render on any path starting with `/lobby`
  (`usePathname()` in `app-shell.tsx`, which is already a client component).

## Tests (tester writes them red first)

1. Store route: an open store's JSON has no `partiesWaiting` key (and no number anywhere in `store`); a closed store's
   JSON has none either.
2. View: the store screen has no waiting text; the wait screen still says "2 parties ahead of you" / "You are next".
3. Repo (integration, any `_test` DB): `LIPA` stored → `lipa`, `Lipa`, `LIPA` all resolve; another org's `LIPA` never
   resolves; two codes in one org differing only by case → undefined.
4. Banner: rendered on `/menu`, not rendered on `/lobby`, `/lobby/check-in`, `/lobby/birthday`.

## Gates

`npm run typecheck`, the customer unit tests, the lobby integration tests touched. Update any existing test that pins
`partiesWaiting` (it is the old behaviour, now refused by Ian). Auditor: Sonnet (public endpoint, privacy).

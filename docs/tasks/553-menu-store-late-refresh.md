# T-553 - a late menu refresh for the old store never replaces the new store's menu (audit MC-001)

Owner: AUDIT. Number given by BOSS 10 Nov 2026 (block T-552..T-557, DEF-819..820). No migration, apps/pos only. Source finding:
`shareat-audits/OPEN/2026-11-09-menu-cache.md` (MC-001). Base: origin/main d50a4e0.

## Defect (re-located on main d50a4e0)

`apps/pos/src/lib/menu/menuStore.ts`:

- `refresh(storeId)` (line 25) awaits `refreshMenuCache` and then publishes `set({ ...state, cached: r.cache })` (line 31) with no
  check that `storeId` is still the store this device is working at.
- `start(storeId)` (line 38) clears a cache that belongs to another store, but its `stop()` (line ~62) only clears timers and
  sets a local `stopped` flag; it does not stop or invalidate a `refresh(A)` already waiting on the network.
- Sequence: start A, stop A while A's fetch waits, start B, B's menu arrives and is cached, THEN A's fetch finishes and publishes
  A's menu into the singleton. `useErpMenu` (useErpMenu.ts:57) returns `s.cached.menu` with no store check, so staff at B sell
  A's dishes and prices until the next refresh repairs it.

## Fix (smallest change, one variable)

In `createMenuStore` keep `let activeStoreId: string | null = null`. `start(storeId)` sets it to `storeId`; the function `start`
returns sets it back to `null` ONLY if it still equals that `storeId` (a newer `start` for another store must not be undone by an
older stop). In `refresh(storeId)`, after the await, publish only when ALL hold: `activeStoreId === storeId` and
`state.source === 'erp'` (source can flip to firestore while a fetch is in flight). Otherwise drop the result silently (the
cache write inside `refreshMenuCache` is keyed per store and stays; it is correct for that store).

The public `refresh` has no caller outside `start`'s own triggers; do not change its signature.

Read side: `useErpMenu` has no store id and the store now only ever holds the active store's cache (start clears a foreign one;
refresh refuses a foreign result), so no read-side change. Say so in the PR.

Files: `apps/pos/src/lib/menu/menuStore.ts`; test added to `apps/pos/src/lib/menu/refresh.test.ts` (existing file, describe
`menu store: the switch and the triggers`) using its `harness` pattern (fake timers, injected fakes, no network). The harness
`load` returns one cache for every store; the new tests need `load` keyed by store id and `fetchMenu` returning controllable
deferred promises per store.

## Tests (write FIRST, see red on d50a4e0)

(a) start A, A's fetch pending, stop A, start B, B's fetch resolves with menu B, then A's resolves with menu A: the store still
holds B (`getState().cached.storeId === 'B'`); (b) opposite order (A resolves before B): ends with B; (c) stop A with no
replacement, A resolves late: cached stays what it was (null / A's loaded cache is not replaced by a result published after stop);
(d) source flips to `firestore` while a fetch is in flight: the late result is not published. Existing tests in the file must
stay green.

## Out of scope

MC-002 (mutable daypart windows vs offline orders, needs Ian's written policy); any change to `refresh.ts` or `useErpMenu.ts`.

# T-508 — Kitchen stations in the ERP, and the ERP menu feeds the POS

**Status:** SPEC (Opus, 3 Nov 2026). **Owner:** orchestrator. **Migration:** one (0232, hand-authored, ADR-012).
**Lanes:** Sonnet tester → builder → auditor per slice (auditor Sonnet: schema + auth code). Discovery slices Haiku.

## Why (Ian, 3 Nov)
Practice POS refused to open a table: *"Package with ID pkg-classic does not have a kitchen location assigned."*
> "where to set this up" … "there must be a ui door on erp for this. the pos must get the package list from erp"

Already decided: bible **row 307** (11 Oct) — master data incl. **kitchen routing** is edited in ERP v2 only; the POS
has no admin panel. ADR-015 :55/:128 — menu and prices are ERP reference data the till reads. T-462 step 4 — *"Read
menu, prices … from ERP through server APIs; keep local snapshots versioned."* This spec is that step for the menu,
plus the kitchen-routing store setting T-401 left out (T-401 :60, R13 :204, §7 :429-437).

## v1 goal (requirements, not design — §1.2d)
**Goal:** every sellable thing reaches the right kitchen screen, and the till sells exactly what head office set up.
v1 POS (`POS/src/components/manager/store-settings/kitchen-locations-settings.tsx`, `StorePackageEditDialog.tsx:125`,
`store-refills-settings.tsx:219`, `edit-inventory-dialog.tsx:524`; types `POS/src/lib/types.ts:325,362,404,411`):
- Station = name, sortOrder, isActive, slaMinutes (default 10, 1–240), printOnOutage (default false). No delete.
- Package/refill/inventory item each carry `kitchenLocationId` + a **copied** `kitchenLocationName`.

**v1 defects this design removes:**
| v1 | Effect | v2 rule |
|---|---|---|
| Station name copied onto every item; rename touches one doc | Old name on tickets after a rename | Name resolved at projection time, never copied (R4) |
| Package/refill may have no station; found only when a cashier opens a table | Table refused mid-service (today's error) | Unrouted items never reach the POS, and the ERP lists them in red (R5) |
| Deactivating a station leaves items pointing at it; picker shows blank | Tickets to a station no screen shows | Retire refused while anything routes to it (R3) |
| Menu copied per store in Firestore, edited in the POS | Two editors, drift | One ERP menu; POS reads a projection (R6) |

## Rulings
- **R1 — Two tables, store-scoped.** `kitchen_stations` (id, org_id, store_id, name, sort_order, sla_minutes default 10
  check 1–240, print_on_outage default false, status `active|retired`, created_by, timestamps; unique (store_id,
  lower(name)) where active). `kitchen_routes` (id, org_id, store_id, menu_item_id, station_id, created_by,
  timestamps; unique (store_id, menu_item_id)). Same-org composite FKs like menu.ts; station's store_id must equal
  route's store_id (composite FK on (store_id, station_id)). Classify both in `cutover/classification.ts` and
  `rls/registry.ts`. Migration 0232, hand-authored, ADR-012 §5 checklist.
- **R2 — Route per item, not per variant.** All variants of a dish go to one station (a kids' package is cooked where
  the adult one is). T-401 :60 suggested variant keys; overruled for simplicity — a variant split, if ever needed, is
  an additive override table later. Packages, refills, à la carte and add-ons all route the same way.
- **R3 — Retire, never delete.** Retiring a station with routes is refused with the count and a link to the routing
  screen. Rename is free (R4 makes it safe). Last active station of a store can be retired only when it has no routes.
- **R4 — No copied names.** Projection resolves `station: { id, name, slaMinutes, printOnOutage }` from the live row.
- **R5 — Unrouted means not on the POS.** The projection leaves out (for that store) any item with a store-channel offer
  but no route, and returns it in a `notOnPos: [{ itemId, name, reason: 'no_station' }]` list. ERP shows this list as
  a red "Not on the POS yet" panel on the routing screen and the store page. A missing route never blocks a price
  change for the rest of the menu. (Ian may overrule to "block the whole menu"; default chosen because it never stops
  a store from selling what is ready.)
- **R6 — Carrier = POS server API + versioned device snapshot (T-462 step 4).** No Firestore mirror entity; no
  `MIRROR_ENTITIES` change. The POS server (`apps/pos/src/app/api/pos2/`) gains `GET /api/pos2/menu`: authenticates
  exactly like the existing pos2 routes (`lib/pos2/client.ts` token + device id → terminal link → store; **never** a
  client-supplied store id), loads the live snapshot, calls `projectStoreMenu`, returns `{ menu, contentHash,
  nextChangeAt }` with `ETag: contentHash`; `If-None-Match` equal → 304. No publish button: a saved ERP change is live
  at the next fetch (v1 behaviour; one fewer step to forget).
- **R7 — Device cache.** The device stores the last good projection in IndexedDB (same DB family as the outbox,
  `lib/outbox/*`), keyed by store, with contentHash and fetchedAt. Refresh on app start, on connectivity regained
  (`useConnectivity`), every 5 minutes while online, and at `nextChangeAt`. Offline → keep selling from the cached
  copy; never blank the menu. A fetch error never replaces a good cache.
- **R8 — Adapter, not a POS rewrite.** One module `apps/pos/src/lib/menu/from-erp.ts` maps `StoreMenuV1` to the shapes
  the POS screens already use (`StorePackage`, `StoreRefill`, add-on inventory rows, `KitchenLocation`, flavors), so
  the session form, refill modal, add-on modal and kitchen tabs change only their data source. Mapping:
  package = itemType `package` (one StorePackage per orderable variant; price from `channels.store`; bundle fields
  from bundleHeads/extraHeadAmount); `refillsAllowed` = variant `refillItemIds`; flavors = values of the option groups
  linked to the package's refill items (builder S0 confirms how flavors are modelled in T-401 data; if not as option
  groups, stop and report); add-ons = items with `soldInPackageSession`; à la carte = `soldALaCarte`;
  `menuScheduleId` = null (dayparts out of scope).
- **R9 — Source switch, default OFF.** `POS_MENU_SOURCE=erp|firestore`, server env, read once, default `firestore`.
  Live stores stay `firestore` until P2 (sales events) is planned: with `erp`, sessions carry ERP variant UUIDs as
  `packageId`, and the v1 day-feed bridge (T-375) / `menu_pos_v1_links` expect v1 keys. The practice copy runs `erp`.
  **Second gate — dayparts (SETTINGS live check, 3 Nov):** Lipa has Lunch 08:00-17:00 / Dinner 17:00-08:00 and 10 of
  12 packages exist as LT/DT pairs at different per-head prices (e.g. 338 vs 358). v2 offers are effective-dated only,
  with no repeating daily window, so with `erp` every pair would show all day and the wrong price could be started.
  No live store flips to `erp` until a daypart spec (name, start, end, days, overnight; packages gated by it) is built.
  This does not affect 7 Dec: Lipa launches POS v2 on the `firestore` source, whose schedules keep working.
- **R10 — Who may edit.** Stations and routes use the existing `manage_store_settings` capability (store-scoped;
  CAPABILITY-MATRIX :163 — admin ✅, owner ✅, manager ✅, cashier ✗). Every ✅ has a test proving the ✗ fires
  (cashier, and a manager of another store). The menu endpoint needs a valid linked terminal, nothing more.
- **R11 — Projection bump.** `StoreMenuV1` → `StoreMenuV2` (schemaVersion 2): adds `stations[]`, `ProjectedItem.stationId`,
  and `notOnPos[]`. `MenuSnapshot` gains `stations` and `routes`. Still pure, still hashed. V1 has no production reader
  (T-401 :22), so no compatibility shim.

## Slices (each: tester writes failing tests → builder → auditor; one PR per slice through the queue)
- **S0 (Haiku, read-only):** confirm flavor modelling in T-401 data and seed (R8); list every POS consumer of
  `storeConfig.packages`, `storePackages`, `storeRefills`, `storeFlavors`, add-on inventory and `kitchenLocations`
  with file:line (agent report of 3 Nov is the start); confirm the pos2 auth helper that yields the store.
- **S1 schema:** migration 0232 (R1), classification + RLS registry rows, repo in `packages/db/src/repo/kitchen.ts`
  (list/create/rename/retire station, set/clear route, list routes for store). Tests: R3 refusal, cross-store route
  refused by FK, unique active name, RLS store scope. **Full suite on a fresh gate DB** (migration rule).
- **S2 domain + ERP screens:** `packages/domain/src/kitchen/` (authorize `manage_store_settings`, audit log rows).
  ERP: store page `admin/stores/[id]` gains **Kitchen stations** (list, add, rename, SLA, print-on-outage, retire) and
  **Kitchen routing** (every item with a store offer at this store, its station picker, a "set every item in this
  category to…" action, and the R5 red panel at top). Plain labels; match the existing ERP form density (T-448).
- **S3 projection v2 (R4, R5, R11):** `packages/domain/src/menu/project.ts` + its loader for live data. Tests: rename
  changes hash and name; unrouted item absent and listed; retired route target impossible by S1.
- **S4 POS endpoint (R6):** `apps/pos/src/app/api/pos2/menu/route.ts`. Tests: unlinked/unknown device 401, store from
  link only (spoofed query param ignored), ETag/304, projection for the linked store only.
  Later (T-510 S4, 6 Nov): `StoreMenuV2` gained `outside_hours` and a daypart-aware `nextChangeAt`; see `docs/tasks/510-menu-dayparts.md` R6 (device offline resolution is S4b, built: `hours` + per-variant `slots` on the projection, resolved on the tablet; see the S4b line there).
- **S5 POS device (R7, R8, R9):** IndexedDB cache, refresh triggers, `from-erp.ts` adapter, data-source switch in the
  consumers listed by S0, kitchen station tabs from projected stations. `startSession` unchanged except its package
  now comes from the adapter. Tests: adapter mapping table; offline keeps cache; failed fetch keeps cache; switch off
  = today's Firestore path byte-for-byte.
- **S6 practice proof:** practice ERP seed gets a menu, two stations and routes for Practice Co; practice POS runs
  `POS_MENU_SOURCE=erp`; demo: rename a station in the ERP → POS ticket shows the new name after refresh; remove a
  route → item disappears from the POS and appears in the red panel; open a table → ticket lands on Grill. Screenshots.

## S0 findings (Haiku, 3 Nov) — binding on S4/S5
- Flavours ARE option values (menu.ts:208, domain/menu/options.ts:5); R8's stop branch does not fire. **No seed or
  fixture creates flavours** — S3/S5/S6 tests must build their own flavour group linked to a refill item.
- `authenticate` (apps/pos/src/server/pos2/identity.ts:22) takes `storeId` **from the request body** and checks staff
  assignment; it does not check the device. S4 therefore must NOT reuse it alone: after the token check, resolve the
  store with `resolvePosTerminalLink(tx, { orgId, posStoreId, deviceId })` (packages/auth/src/pos-terminal-link.ts:23)
  as the lobby route does (server/pos2/lobby.ts, deps.ts:127-135), and serve the link's `erpStoreId` only. A request
  whose staff store and linked store differ is refused (403).
- DB access from the POS server: `withOrgPrincipal(orgId, tx => …)` via deps (deps.ts:101-112).
- Consumers to switch in S5 (all v1 Firestore today): `useStoreConfigDoc` packages/flavors (session-list-view.tsx:223-240
  → StartSessionForm); `storePackages` (ServerPageClient.tsx:123, request-change-dialog.tsx:95, RefillPOSModal.tsx:118);
  `storeRefills`/`storeFlavors`/global `refills` (RefillPOSModal.tsx:84-186); global `flavors` (kitchen/page.tsx:264);
  add-ons (store-context.tsx:307); `kitchenLocations` (kitchen/page.tsx:248 tabs; printOnOutage reads at
  RefillPOSModal.tsx:233, session-detail-view.tsx:377, AddonsPOSModal.tsx:435, cashier/firestore.ts:358;
  HistoryPageClient.tsx:87; SyncKdsTicketsTool.tsx:53). Option groups via legacy `/api/products/{id}/option-groups`
  (AddonsPOSModal.tsx:245, family-order-modal.tsx:104) are out of S5 — note only.

## Out of scope (each a later spec)
sold-out overlay (stays a POS action, row 307) · discounts, charges, tenders, loyalty
on the same carrier (next spec, same R6 pattern) · Customer app menu (online channel) · `store_menu_versions` history
table (T-401 K4; add when receipts must cite the menu version, P2) · sales events carrying ERP variant ids (P2) ·
retiring the POS's Firestore menu path (after every store runs `erp`) · per-variant routing (R2).

## Acceptance
S6 demo passes on the practice copy with screenshots; gates green per slice; the error in "Why" cannot occur with
`POS_MENU_SOURCE=erp` because an unrouted package is never offered to the cashier.

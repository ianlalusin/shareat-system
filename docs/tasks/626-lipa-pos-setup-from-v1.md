# T-626: copy Lipa's POS setup from v1, and prove POS v2 reads it

**Owner:** builder (Sonnet), laptop (`_test` database). Auditor: Sonnet (money: prices). **Spec:** BOSS (Opus), 22 Nov 2026.
**Ian, 22 Nov 2026:** "set up erp2 of shareat lipa to have same packages, flavors, refill, kitchen location, table number
and other settings like the live in v1 and check if they are picked up by posv2." **No migration expected** (if one turns
out to be needed, stop and ask BOSS). Lipa goes live on POS v2 on 7 Dec (bible row 431).

## Today

`pos:load-setup` (`packages/etl/src/pos-v2/load-store-setup.ts`, T-533 S2) copies only **stands** and **discount
presets** from v1. The menu (packages, variants, refills and their package links, flavours, a-la-carte items, categories),
**kitchen stations and routes**, **lunch/dinner prices** and **tenders** are entered by hand in the ERP; nothing records that
anyone has typed Lipa's. The pre-flight (`/admin/stores/[id]/pos-preflight`) does not block an empty menu.
v1 paths (POS repo, read-only reference): `packages` + `stores/{id}/storePackages`, `refills` + `storeRefills`, `flavors` +
`storeFlavors`, `products` / `stores/{id}/inventory` / `addonCategories`, `stores/{id}/menuSchedules`,
`stores/{id}/kitchenLocations`, `stores/{id}/storeModesOfPayment`. Builder confirms each path and field in the POS repo
before mapping; v1 is read as REQUIREMENTS (bible §1.2d), the v2 model is the authority.

## Rule

- **Extend the same loader** (same safety shape: read-only source interface, writes ONLY through the existing audited domain
  functions for menu items, variants, option groups, package refills, offers/prices, dayparts, kitchen stations/routes and
  tenders; idempotent, matched by name within the store; `dryRun` in a rolled-back savepoint; report names and counts only,
  never Firestore ids). One command still: `npm run pos:load-setup -- --store <code> [--confirm]`.
- **Copy:** kitchen stations (name, SLA minutes, print-on-outage if v2 has it) → packages (per-head price, kitchen station,
  daypart prices) → refill items and each package's refill list → flavours as option groups/values on their packages →
  a-la-carte items and categories → item→station routes → lunch/dinner prices per row 443's windows (dayparts already
  exist for Lipa? create only if missing, with the windows of row 443) → tenders (Cash, Gcash, QRPH, Bank Transfer, with
  `pos_v1_alias` for the December bridge).
- **Never overwrite** a value someone already set in the ERP: if a same-name item exists with a different price/station,
  report it as a **difference** and leave it. Ian decides.
- **Not copied** (report only): service/other charges and reservation deposits (Ian decides separately), staff and PINs
  (already loaded / set in the ERP), printers (per tablet), receipt text (org/store settings).
- **Parity check** `npm run pos:setup-check -- --store <code>` (read-only): compares v1 vs v2 for every copied kind
  (counts; names; per-head and lunch/dinner prices to the centavo; refill-to-package links; flavour groups per package;
  station per item; tenders) and then builds the real POS v2 snapshot + store menu for the store (`buildPosSnapshot`,
  `loadStoreMenu`) and checks every copied item is in it with the right price for now's daypart and a route. Prints a
  plain table and exits 1 on any gap or difference.
- **Pre-flight:** add a **blocking** check "the store has packages on sale and each has a price for both lunch and dinner
  and a kitchen station" so the live switch cannot pass with an empty or half menu.

## Tests (each with a mutant that goes red)

1. Loader integration with a fake v1 source holding a realistic small Lipa: first run creates everything; second run writes
   nothing; a hand-changed price is reported as a difference and not overwritten (mutant: overwrite → red).
2. Parity check integration: green after a load; one missing refill link → exit 1 naming it (mutant: skip refill links → red).
3. Snapshot check: a copied package appears in `buildPosSnapshot` / `loadStoreMenu` with the lunch price at 12:00 and the
   dinner price at 18:00 (mutant: wrong daypart mapping → red).
4. Pre-flight blocks an empty menu and a package missing a dinner price (mutant: warn instead of block → red).
- Typecheck `apps/erp` and the loader/scripts/tests via a temp tsconfig (package tests are not in the app tsconfig).
- Runbook additions to `docs/runbooks/pos-lipa-switch.md`: the dry run, the real run, the check, all on the droplet (it has
  the v1 reader key `POS_BRIDGE_SA_KEY_FILE`), plain steps for Ian.

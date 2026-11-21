# T-601 — POS soak readiness for Lipa, Sat 21 Nov 2026 (fallback Sat 28 Nov)

Status: SPEC (Opus), 2026-11-18. Source: `docs/reviews/2026-11-18-pos-v2-soak-readiness.md`. Risk: **medium** (no money
moves; TEST mode books nothing). Builder: Sonnet, ONE builder at a time. No migration, no schema, no new capability, no
bible change. Line numbers are main 9892641. Owner checklist: `docs/ops/pos-soak-2026-11-21-checklist.md`.

## First: what "Lipa's menu must be in the ERP" means in work

- **There is no loader.** `/pos` sells only what `loadStoreMenu` returns (`packages/domain/src/pos/snapshot.ts:47`).
  `npm run pos:load-setup` (`scripts/pos-load-setup.ts` → `packages/etl/src/pos-v2/load-store-setup.ts:1-12`) loads
  **stands and discount presets only**; it reports, never fills, menu gaps. No v1 menu import exists anywhere
  (`docs/tasks/510-menu-dayparts.md:126`: "No v1 menu loader exists anywhere"; deferred 6 Nov). `packages/etl` has no
  menu writer (grep `menu_items` in `packages/etl*`: none).
- **So the menu is typed in by hand** on ERP `/menu/items` (items, packages with per-head and extra-head price, refills,
  flavours as option values), `/menu/prices` (store prices), `/menu/hours` (lunch/dinner windows) and `/kitchen`
  (stations and routes). Writing an importer is NOT in this task: it is a multi-day ETL with mapping decisions (T-510 S5)
  and cannot land and be checked by Saturday.
- **v1 counts are not in code.** v1 keeps the menu only in live Firestore (project of the v1 POS): global `products`,
  `packages`, `refills`, `flavors` (`POS/src/app/admin/menu/*`), and per store `stores/<lipa>/menu`,
  `stores/<lipa>/storePackages`, `stores/<lipa>/kitchenLocations` (`POS/src/app/admin/stores/page.tsx:49`). BOSS counts
  them read-only: open the v1 admin screens `Admin > Menu > Products / Packages / Refills / Flavors` with Lipa selected
  and count active rows, or run a Firestore `count()` on those paths with the read-only `POS_BRIDGE_SA_KEY_FILE` key.
- **What the ERP already holds for Lipa** (read-only, BOSS runs on production; approximate, offers are versioned; S1's
  check is exact):
```sql
with s as (select id, org_id from stores where name ilike '%lipa%')
select i.item_type, count(distinct i.id) items, count(distinct v.id) variants
from s join menu_offers o on o.store_id = s.id and o.channel = 'store' and not o.withdrawn
join menu_item_variants v on v.id = o.variant_id join menu_items i on i.id = v.menu_item_id and i.status = 'active'
group by 1
union all select 'stations', count(*), null from kitchen_stations k join s on k.store_id = s.id where k.status = 'active'
union all select 'dayparts', count(*), null from menu_dayparts d join s on d.store_id = s.id where d.status = 'active';
```
  If it returns no `package` row, Saturday cannot sell a package. Owner decision D1 below.

## The cut line

| Rank | Slice | Size | Tier |
|---|---|---|---|
| 1 | S1 Soak checklist on the pre-flight page | M | **Must have for 21 Nov** |
| 2 | S2 Read-only Receipts list on `/pos/receipts` | M (3 h) | **Must have for 21 Nov** |
| 3 | S3 TEST band on every `/pos` screen | S | **Must have for 21 Nov** |
| 4 | S4 TEST line on receipt, X and Z slips | S | Can wait for 28 Nov |
| 5 | S5 One receipt number on paper and server (`LIP-01-000123`) | S | Can wait for 28 Nov |
| 6 | S6 Promote terminal-link and approver checks to BLOCKING for the live switch | S | Can wait for 28 Nov |
| — | Data, not code: menu, grants, link, rules, tenders, issuer (file B, "Before Saturday") | — | **Must have for 21 Nov** |

If the builder runs short, cut from the bottom of the must-haves: S3, then S2 (file B gives the fallback for step 27:
the Till X reading count plus a database count after the soak). S1 is never cut: without it nobody can see what is missing.

## S1 — Soak checklist on the pre-flight page (M) — MUST

Why a separate list, not new blocking items: `evaluatePreflight` items gate the switch to live (`store-mode.ts:141`) and
the integration tests assert exact item lists (`t533-s3-preflight.test.ts:54`, `:157`). New blocking items would break
every one of them and the S1 mode-switch tests by Saturday. So S1 adds a **pass/fail list beside** the pre-flight and
changes nothing it decides. S6 promotes two checks to blocking after the soak.

Files:
- `packages/domain/src/pos/soak-checks.ts` (new). `posSoakChecks(tx, actor, { storeId }, deps: PreflightDeps):
  Promise<SoakCheck[]>`; `SoakCheck = { code, label, ok, sentence, href }`. It calls `posPreflight` FIRST (that is the
  `manage_stores` gate and the facts already gathered), then reads the extra facts below, then returns
  `evaluateSoakChecks(preflight, extra)` (pure, exported for the unit test). A READ: no audit row, no write.
- `packages/domain/src/pos/index.ts`: export `posSoakChecks`, `evaluateSoakChecks`, `type SoakCheck`.
- `apps/erp/src/app/admin/stores/lib.ts:102`: `posSoakChecksFor(actor, storeId)` beside `posPreflightFor`, same
  `withOrgPrincipal` and `keyFilePresent`.
- `apps/erp/src/app/admin/stores/[id]/pos-preflight/page.tsx`: after the warnings section, a section "Soak checklist
  (TEST run)": one row per check, `Pass` / `Fail` as a `Badge` (tone success / danger), the label, and on a failed row the
  sentence and the existing `Fix this →` link. Header line: "N of M ready".

Extra facts (all through existing repos; no new SQL except where named):
- `menu = (await loadStoreMenu(tx, orgId, storeId)).menu` (`packages/domain/src/menu/load-store-menu.ts:12`). Store
  channel only: `v.channels.store.orderable && v.channels.store.amount !== null`.
- `posV2Repo.getPosStore` → `mode`; `posV2Repo.getActiveTerminalPersonId` (`pos-v2.ts:179`) → link present.
- Approvers: the same sign-in list as `preflight.ts:120-123` (rebuild it; do not change `preflight.ts`), each with
  `can(tx, person, 'approve_pos_correction', { storeId })` and a live PIN (`posPreflightRepo.personIdsWithLivePin`).
- Sellers: sign-in people with `record_sale` (as `preflight.ts:125`), keep the ids.
- Rules: `businessRulesRepo.listRuleValueRows(tx, orgId, ['pos.require_pin_line_actions'])` → saved and true.
- Tenders: `posV1Repo.listTendersByStore` active rows (as `preflight.ts:113`).
- Issuer: `organizationsRepo.identityOf(tx, orgId)` and `storesRepo.getById` (as `snapshot.ts:63`).

The checks, in this order (code — pass when — fail sentence — href):
1. `menu_items` — at least one `a_la_carte` item sold here at a price — "No dish is on sale at this store. Add the
   menu in the ERP." — `/menu/items`
2. `menu_packages` — at least one `package` sold here with a per-head price — "No package with a per-head price is on
   sale here." — `/menu/items`
3. `menu_refills` — at least one `refill` item, and pre-flight has no `packages_without_refills` — "Refills are missing
   or not linked to every package." — `/menu/items`
4. `menu_flavours` — some package variant has `optionGroups.length > 0` — "No package offers a flavour choice." — `/menu/items`
5. `kitchen_stations` — `menu.stations.length > 0` and no `items_without_station` — "Some dishes have no kitchen
   station, or there are no stations." — `/kitchen?store=<id>`
6. `menu_dayparts` — `menu.hours` is present — "No lunch/dinner windows are set; one price applies all day." — `/menu/hours`
7. `stands_presets` — pre-flight has neither `no_stands` nor `no_discount_presets` — "Load the stands and discount
   presets (pos:load-setup)." — null
8. `tablet_till` — no `no_linked_till` — "Pair the tablet and link it to a till." — `/settings/pos-tablet`
9. `terminal_link` — an active `pos_terminal_links` row — "The tablet is not registered for manager approvals, so the
   end-of-day close will fail." — `/admin/pos-tablets`
10. `approver` — at least one approver with a PIN, AND some seller who is not that approver (`approvers.size >= 2 ||
    sellers.some(id => !approvers.has(id))`) — "Nobody but the cashier can approve the close. Give a manager 'approve a
    POS refund or correction' and a PIN." — `/admin/users`
11. `rules` — no `rules_not_seeded` and the line-PIN rule saved On — "Save the business rules, and turn on 'manager PIN
    for line actions'." — `/settings/business-rules`
12. `test_mode` — `mode === 'test'` — "The store is not in TEST mode." — `/admin/stores/<id>`
13. `tenders` — an active cash tender and an active `wallet` tender — "Add Cash and at least one wallet method (GCash)." —
    `/settings/pos-link?store=<id>`
14. `receipt_issuer` — `receiptIdentityOf(...)` gives a non-empty business name, a TIN and at least one address line —
    "The receipt will print the store name only. Fill in the legal name, TIN and address." — `/settings/organization`
15. `people` — no `no_record_sale_person` and no `staff_without_pin` — "Someone who must sign in has no PIN, or nobody
    can sell." — `/staff`

Tests:
- `packages/domain/src/pos/soak-checks.test.ts` (unit, no DB): a GREEN input gives 15 `ok: true`; each check flipped
  alone gives exactly that code `ok: false` (table-driven, as `preflight.test.ts:37`). Approver cases: one approver who is
  also the only seller → fail; that approver plus another seller → pass. **Mutant:** change rule 10 to `approvers.size >= 1`
  → the "only seller" case goes green, red.
- `packages/domain/tests/integration/t601-soak-checks.test.ts`: reuse `ready()` from `t533-s3-preflight.test.ts` (copy it;
  do not import across test files). (a) a store manager is refused (the `manage_stores` gate); (b) with no
  `pos_terminal_links` row `terminal_link` fails, after inserting one (pattern: the t525 fixture) it passes;
  (c) the manager with a PIN but no grant → `approver` fails (default `manager: false`, `capabilities.ts:928`); a
  `person_grants` row for `approve_pos_correction` at the store → passes; (d) writes nothing (audit count unchanged, as
  `t533-s3-preflight.test.ts:58-70`). **Mutant:** drop the `can(...)` check in `soak-checks.ts` → (c) first half goes green, red.
- `t533-s3-preflight.test.ts` and `preflight.test.ts` stay green **unchanged** (proof that S1 decided nothing new).

Pins: `tests/unit/domain-actions-have-callers.test.ts` (the new export has a caller, the page; add no UNWIRED row);
`tests/unit/t343-throw-ratchet.test.ts` (no new `throw new Error`). Out: manager access to the list (needs a new route and
its `ROUTE_CAPABILITY` entry; admin runs it for Saturday); changing `evaluatePreflight` (S6).

## S2 — Read-only Receipts list on `/pos/receipts` (M) — MUST

Today: `apps/erp/src/app/pos/receipts/page.tsx:17` renders a placeholder. `listTodaysSalesReceipts`
(`packages/domain/src/pos/sale.ts:434-442`) exists with no caller (`domain-actions-have-callers.test.ts:353`), but its rows
lack the table, the tenders and the till number.

Change:
- `packages/db/src/repo/pos-v2.ts`, after `listReceiptsSince` (line 599): `listReceiptsSinceForList(tx, orgId, storeId,
  since)` — one query: `pos_sales_receipts r` join `pos_terminals t` on `t.id = r.terminal_id`, join `table_sessions s`
  on `s.id = r.table_session_id`, left join `pos_stands st` on `st.id = s.stand_id`, left join
  `pos_sales_receipt_payments p` on `p.receipt_id = r.id`, left join `tenders td` on `td.id = p.tender_id`; same org,
  store and `since` filter; group by receipt; select `r.id, t.terminal_no, r.receipt_seq, r.issued_at_device, r.total,
  r.offline, s.mode, st.number, string_agg(distinct td.name, ' + ' order by td.name)`. Newest first. Money stays text.
- `sale.ts:434`: `listTodaysSalesReceipts` uses the new query, keeps every existing field, adds `terminalNo`,
  `receiptNo` (`${storeCode}-${pad(terminalNo,2)}-${pad(seq,6)}`, the `sale.ts:253` format, `getStoreCode`),
  `table` (`'Take-out'` or `Stand <n>`), `tenders` (text). Additive: `t524-pos-domain.test.ts:1567` stays green.
- `apps/erp/src/app/pos/receipts/page.tsx`: replace the placeholder. Keep lines 10-14 (gate). Resolve the store as
  `effectiveStore(pairing, storeId)` (`pos/lib.ts:28`); on a paired tablet keep only rows of its terminal
  (`posV2Repo.getTerminalForPairing`, via a small read in `pos/lib.ts`). Render with the house `Page`/table pattern used by
  `pos/till/page.tsx`: a heading "Receipts since the last close", a line "N receipts · total ₱X · Numbers: no gaps" (or
  "Missing numbers: 000124, 000127 — write these down"), then a table: Receipt no · Time (Manila, `formatBusinessDateTime`) ·
  Table · Total · Paid by · Status (`Sent while offline` / `Online`). Empty: "No receipts yet since the last close."
  No buttons (reprint of an old receipt is after the soak).
- `apps/erp/src/app/pos/_till/receipt-gaps.ts` (new, pure): `missingSeqs(rows: {terminalNo, terminalSeq}[]):
  {terminalNo, seq}[]` — per till, every number between min and max not present. Comment: a gap can be a number spent by
  a failed save (`_payment/logic.ts:397-399`), so it is a finding to write down, not proof of a lost sale.

Tests:
- `apps/erp/tests/t601-receipt-gaps.test.ts` (unit): `[1,2,4]` → `[3]`; two tills counted apart; empty → `[]`; one row →
  `[]`. **Mutant:** compare across tills (drop the per-till grouping) → the two-till case red.
- `packages/domain/tests/integration/t524-pos-domain.test.ts` beside line 1567, new `it`: a dine-in sale paid Cash +
  GCash and a take-out sale → two rows, `table` `Stand <n>` and `Take-out`, `tenders` contains both names,
  `receiptNo` matches `/^[A-Z0-9]+-\d{2}-\d{6}$/`; a receipt from before the last Z is absent. **Mutant:** drop the
  `since` filter → the old receipt appears, red.
- Remove the `listTodaysSalesReceipts` UNWIRED row (`domain-actions-have-callers.test.ts:353`); that file must pass.

Out: reprint, refunds, receipt detail view, quarantine (after the soak).

## S3 — TEST band on every `/pos` screen (S) — MUST

Today nothing on the tablet says TEST (review line 41); the mode is in the snapshot (`snapshot.ts:63`) but unread.
Use the server, not the snapshot, so the kitchen and refills phones (no snapshot) show it too.
- `apps/erp/src/app/pos/lib.ts:18-21` `posShellFacts`: each store gains `mode` from `posV2Repo.getPosStore` (`'off'`
  when no row). Type: `{ id; name; mode: 'off' | 'test' | 'live' }`.
- `apps/erp/src/app/pos/_shell/PosShell.tsx`: below the header (line 240), before the offline band, when
  `store?.mode === 'test'`: `<div role="status" className="w-full bg-info-soft px-4 py-2 text-center text-sm font-bold
  text-info">TEST MODE — practice only. Nothing here is a real sale.</div>` (`bg-info-soft` and `text-info` are existing
  tokens in `apps/erp/src`). Text in a constant in `_shell/messages.ts`.
Tests: `apps/erp/tests/t601-test-band.test.ts` — render `PosShell`'s band helper (extract
`testBandText(mode): string | null` into `_shell/messages.ts`): `'test'` → the sentence; `'live'`, `'off'` → null.
**Mutant:** return the sentence for every mode → red. Smoketest on 9008: a TEST store shows the band on Orders, Kitchen,
Refills, Receipts, Till. Pins: none. Out: slips (S4).

## S4 — TEST line on receipt, X and Z slips (S) — 28 Nov

No printer in the soak, but the receipt screen shows the slip lines (`ReceiptScreen.tsx:14`). `ReceiptHeader`
(`apps/erp/src/lib/pos-print/types.ts:24`) gains `test?: boolean`; `receiptHeaderOf` (`header.ts:7`) takes `mode?` and
sets `test: mode === 'test'`. `formatReceipt` (`receipt-text.ts:47`, beside REPRINT) and `pushHeader`
(`reading-text.ts:25`) print `TEST - NOT A SALE` centred when set. Callers pass the mode: `PaymentPanel.tsx:345` (new prop
`storeMode` from `Orders.tsx:241` `payment.store.mode`), `_till/slips.ts:52` (`SlipContext.mode`), filled in
`pos/till/page.tsx:42` from `getPosStore`, passed through `TillPanel.tsx:116` and `TillView.tsx:41`. Tests in
`apps/erp/src/lib/pos-print/receipt-text.test.ts` and `reading-text.test.ts`: the line present for test, absent
otherwise. **Mutant:** print it unconditionally → red.

## S5 — One receipt number (S) — 28 Nov

Cause: the tablet formats `T<terminalNo>-<seq6>` (`_payment/logic.ts:104-106`, pinned by `apps/erp/tests/t528-payment-logic.test.ts:335-339`,
T-528 line 141) because the snapshot carries no store code; the server formats `<store code>-<terminal 2>-<seq6>`
(`sale.ts:252-253`, T-524 line 145, the schema comment `schema/pos-v2.ts:471`) and writes that into the senior/PWD
register (`sale.ts:261`). Same sequence, two spellings. **For the soak it does not matter:** TEST books nothing, and
step 27 compares the last six digits (file B says so). It matters before go-live: the paper must match the register.
Fix: `snapshot.ts:26,63` store gains `code` (`storeRow?.code`); `receiptNoOf(storeCode | undefined, terminalNo, seq)`
returns the server format, and `T<n>-...` only when an old cached snapshot has no code. Update the t528 pin to the new
format plus a no-code case. **Mutant:** drop the code → red.

## S6 — Link and approver block the live switch (S) — 28 Nov

Add `no_terminal_link` and `no_approver` to `evaluatePreflight` blocking; replace `managersWithPin`
(`preflight.ts:82`, which counts managers by role although managers do not hold the capability) with the S1 approver
count. Extend `ready()` in `t533-s3-preflight.test.ts` with a link row and a granted approver. Needs D2 decided first.

## Decisions for the owner (Ian)

- **D1 — Who types Lipa's menu into the ERP, and by when?** No importer exists. Options: (a) Ian or an admin types it on
  `/menu` by Fri 20 Nov from the v1 admin screens (recommended for Saturday: a soak can run on a subset, for example 2
  packages, 5 refills, 10 dishes, if the full menu is not done; say which); (b) commission a v1 menu importer (several
  days, needs T-510 S5 mapping decisions) and run the soak on 28 Nov. Pick: (a), with a subset if needed.
- **D2 — Should managers hold `approve_pos_correction` by default?** Today `manager: false` (`capabilities.ts:928`), yet the
  Z (`day-close.ts:253-268`), line PINs (row 460) and deposit voids (row 463) all ask for "the manager PIN", and row 449
  makes a store manager the senior verifier. Options: (a) keep the default, grant it per person on `/admin/users/<id>`
  (no code; works for Saturday); (b) set `manager: true` (one matrix line, a capability-matrix test proving staff still
  ✗; every store manager can then approve corrections at their stores); (c) grant it through the Store Manager position
  default on `/admin/access-defaults` (no code; managers by position, not by role). **Pick: (a) for Saturday whatever
  is decided; (c) as the standing rule** — it follows who runs the floor without widening every `manager` role holder.
  No slice changes the matrix until Ian rules.
- **D3 — Real or made-up senior/PWD numbers in TEST?** TEST sales still write the statutory register (review line 39).
  Pick: made-up numbers only (file B says so).

## After the soak (one line each, not in T-601)
- Void an unpaid table: screen button for the existing `voidUnpaidSession` (`sale.ts:49-82`, `inbox.ts:147`).
- Quarantined sales review: manager screen over `listPosQuarantine` / `replayQuarantinedEvent` (DEF-851); before go-live.
- Tender correction and refunds: T-534 (DEF-832, DEF-855); before go-live.
- Deposits and reservations on `/pos` (DEF-842): owner decides whether go-live needs them; Lipa takes deposits in v1.
- Offline reload without a service worker: decide on a service worker or the APK shell (T-532); watch soak steps 21-26.
- Reprint an old receipt from the Receipts list; manager access to the soak checklist.
- Retire or relabel `docs/ops/pos2-runbook.md` and `docs/ops/pos2-soak.md` (they describe frozen `apps/pos`).

## Build order and commands
One commit per slice, S1 → S2 → S3; LF endings; record each mutant's red line in the commit message. Memory rule: the
machine stays under 90%: targeted test files only, `--maxWorkers=2`, no whole-repo `tsc` locally (CI runs typecheck),
no dev server while tests run (stop it first; start it on 9008 only for the smoketest).
```
npx vitest run --project unit packages/domain/src/pos/soak-checks.test.ts packages/domain/src/pos/preflight.test.ts --maxWorkers=2
npx vitest run --project integration packages/domain/tests/integration/t601-soak-checks.test.ts packages/domain/tests/integration/t533-s3-preflight.test.ts --maxWorkers=2
npx vitest run --project unit apps/erp/tests/t601-receipt-gaps.test.ts apps/erp/tests/t601-test-band.test.ts tests/unit/domain-actions-have-callers.test.ts tests/unit/t343-throw-ratchet.test.ts --maxWorkers=2
npx vitest run --project integration packages/domain/tests/integration/t524-pos-domain.test.ts --maxWorkers=2
```
Smoketest (dev server on 9008, tests stopped): the pre-flight page shows the soak list with at least one Fail on a
half-set-up store; `/pos/receipts` lists a sale made on Orders with its stand and tender; a TEST store shows the band on
all five tabs. Full suite runs in CI on the PR.

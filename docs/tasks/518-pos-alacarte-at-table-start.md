# T-518 — POS v2: add à la carte while taking the package order

**Status:** SPEC (Opus, POS session, 2026-11-04). Approved by Ian 4 Nov ("Yes, build it", option A).
**Area:** `apps/pos/**` only. **No migration.** Merge before 20 Nov or after 14 Dec (T-455 R1, Lipa soak).
**Lanes:** Sonnet tester -> builder -> auditor.

## Why (Ian, 4 Nov)
"on POS when taking a package order on first customer interaction i want cashier to be enabled to add ala carte
orders upon taking the package order. current v1 does not allow this."

## What exists (discovery, 4 Nov; paths under apps/pos/src)
- `components/cashier/start-session-form.tsx` package tab -> `startSession(storeId, payload, user)` in
  `components/cashier/firestore.ts` (one `writeBatch`, `commitLocalFirst`, not awaited): session (status
  `pending_verification`), table, activeSessions, package bill line, optional Extra Pax line, package kitchen ticket +
  rtKdsTickets, then the offline backup print and SESSION_STARTED log.
- À la carte after opening: `components/shared/AddonsPOSModal.tsx` `performAdd` (inline closure). Online: one
  transaction creating/incrementing `sessionBillLines/addon_{itemId}_{price}[_modHash]` (type `addon`) + kitchen ticket
  via `createKitchenTickets(..., "addon", ..., {tx})`; offline: `stageOfflineAddonLine` + `createKitchenTickets({batch})`.
  Locked while `session.status !== 'active'` (`session-detail-view.tsx` `isBillingLocked`), so a new package table
  cannot take à la carte until the server verifies pax. That lock is the reason v1 needs a second step.
- No stock is deducted on either path today.

## Rulings
1. **Where.** The package (unlimited) tab of the New Session form gets an optional "À la carte" section: an
   "Add à la carte" button and the list of chosen lines (name, modifiers, note, qty, line total; qty +/- and remove).
   The separate "Ala Carte" tab (à-la-carte-only bill) is unchanged.
2. **One picker.** The button opens `AddonsPOSModal` in a **collect mode** (a prop such as
   `onCollect(line)`): same item list, search, option groups/modifiers, note, qty and validation as today (price > 0,
   required modifiers), but "Add to Order" hands the line back to the form instead of writing, and needs no session
   and no unlock. The modal's normal write path is unchanged. Item source stays the modal's (`storeAddons` today), so
   T-508 S5's adapter swap covers both.
3. **One line builder.** Extract from `performAdd` a pure function that builds an add-on bill line (id key
   `addon_{itemId}_{price}[_modHash]`, type, unitPrice, qty, kitchenLocationId/Name, modifiers, note, line totals) and
   use it in BOTH the modal's paths and `startSession`. Same item + price + modifiers chosen twice = one line with the
   qty summed (same as the modal's increment).
4. **Same save.** `startSession` takes optional `initialAddons` and writes, in the SAME batch as the package:
   the add-on bill lines, and for each line with a `kitchenLocationId` a kitchen ticket via
   `createKitchenTickets(..., "addon", ..., { batch })` (a line without a station is billed, not ticketed, as today).
   Session `billingRevision` and any bill totals the session doc carries must come out exactly as if the same items had
   been added after opening (tests compare with the modal path). ADDON_ADDED activity log per line after commit, as the
   modal does. The offline backup kitchen print lists the à-la-carte items too.
5. **Unchanged:** the `pending_verification` lock and the server's pax check; pax verification must not touch add-on
   lines; the Ala Carte tab; the lobby pre-fill (`textLines` stay a caption; turning phone pre-orders into lines waits
   for T-455 S4b); stock (none deducted, as today).
6. **Offline:** works through the same batch + `commitLocalFirst`. If the option-groups fetch fails offline the picker
   falls back to no modifiers, as the modal does today.
7. **Copy:** POS v2 files edited here are logged in `apps/pos/V1-COPY.md` (the `pos-v2-copy` test requires it).

## Tests (tester writes first; mutants they must kill)
- Line builder: same key and fields as the modal produced before the extraction (golden cases incl. modifiers hash);
  duplicate pick sums qty (kills two lines for one item).
- `startSession` with `initialAddons`: the batch holds the package line AND each add-on line AND one add-on kitchen
  ticket per stationed line, all in the one batch (kills a second batch/commit or a missing ticket); a station-less
  line is billed with no ticket; billingRevision/totals equal the modal path's result; no `initialAddons` = today's
  batch exactly (kills a regression for every normal table start).
- Form: collect mode adds/removes/edits lines and passes them to `startSession`; the Ala Carte tab is untouched.
- Modal: normal (non-collect) path still writes as before; collect mode performs no Firestore write (source guard
  acceptable where the POS test setup has no DOM).

## Out of scope (with reasons)
- Unlocking à la carte during `pending_verification` (option B): weakens the server's pax check and still needs two
  steps.
- Stock deduction: neither path does it today; changing it is a separate inventory decision.
- Phone pre-order lines -> bill lines: needs the lobby menu (T-455 S4b) first.
- Item source / kitchen routing: T-508 S5 owns it.

## Orchestrator notes (BOSS, 4 Nov)
- Item source in ONE place: the picker reads whatever `AddonsPOSModal` reads. T-508 S5 swaps it behind
  `POS_MENU_SOURCE=erp|firestore` (default firestore) for both. No new reader of `storeAddons`.
- Kitchen routing: tickets read the station from the item (`kitchenLocationId` today, T-508's `stationId` later), never
  a hard-coded location.
- The mixed package + à-la-carte start is all-or-nothing: one batch, one commit; a failed write saves nothing and makes
  no tickets (tests assert a single batch and a single commit, and no write outside it).

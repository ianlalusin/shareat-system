# T-546 — POS till numbers and receipt printer settings per terminal

> **Status:** spec written 7 Nov 2026 by the POS design lane (Opus planner). Not built. **REQUIRED before the soak
> (T-533)** (BOSS, 7 Nov).
> **Migration:** **0246** (reserved). **Risk:** high (schema plus admin auth), so a Sonnet builder and a Sonnet
> auditor are used.
> **Depends on:** T-523 (`pos_terminals`, on main), T-525 (the snapshot), and T-528 (the print adapter and its two
> marked shortcuts).
> **Why:** Ian's standing rule (5 Nov) is that no business or device setting is hard-coded. T-528 ships with
> `PRINT_LAYOUT = 58 mm, Font A` and `RECEIPT_COPIES = 1`, each marked `shortcut:`. A store with an 80 mm printer, or one
> that wants a kitchen copy, needs a screen.
> It also needs an owner for one gap: **nothing in the ERP creates a `pos_terminals` row or links it to a paired tablet**.
> Today only test fixtures do. Without a row, the tablet's snapshot answers 409 ("This tablet has no till number yet").

## Goal

On **Admin → POS tablets**, a manager of the store, or an admin, can:
- see each store's tills;
- add a till number;
- choose which paired tablet acts as that till;
- set the receipt printer's paper width and the number of copies.

Every change is audited. The tablet reads its settings from the snapshot and prints accordingly.

**v1's goal (§1.2d):** v1 kept the paper width and the font mode in each tablet's local settings. When a tablet was
replaced, the settings were lost, and nobody else could see them. **v2:** the settings live on the **till** (terminal),
not on the tablet. A replaced tablet takes over the till's number series (DEF-587) **and** its printer settings.

## Out of scope

| Out | Why |
|---|---|
| Font mode (small, normal) | Release 1 prints normal Font A (T-528a's columns). Add a column later if a store asks |
| A kitchen printer per station | T-529/T-530 (printed tickets offline) |
| Deleting a till | A till's receipts reference it, so it is never deleted. Un-linking the tablet is allowed |

## R1 — Migration `0246_t546_pos_terminal_printer.sql` (hand-authored, ADR-012 §5)

- `ALTER TABLE pos_terminals ADD COLUMN receipt_paper_mm smallint NOT NULL DEFAULT 58`
  with `CHECK (receipt_paper_mm IN (58, 80))`.
- `ALTER TABLE pos_terminals ADD COLUMN receipt_copies smallint NOT NULL DEFAULT 1`
  with `CHECK (receipt_copies BETWEEN 1 AND 3)`.
- `GRANT UPDATE (receipt_paper_mm, receipt_copies) ON pos_terminals TO shareat_app`. This adds to the existing
  `(pairing_id, updated_at)` grant.
- No new table. Its cutover and RLS classification are unchanged. Follow the journal grid. The header comment says why.
- Existing rows get the defaults.

## R2 — Domain (`packages/domain/src/pos/terminals.ts`)

Every function is `(tx, actor, input)` and calls `authorize` first. The capability is the one `/admin/pos-tablets`
already uses (`provision_clock_terminal`, `ROUTE_CAPABILITY`), and it is checked against the **store's** scope.

- `listTerminals(tx, actor, {storeId})` returns, for each till:
  - `{id, terminalNo, pairingId, pairingLabel, receiptPaperMm, receiptCopies}`;
  - the store's live pairings with no till yet, so they can be chosen.
- `createTerminal(tx, actor, {storeId, terminalNo})` takes a number from 1 to 99 that the store does not already use.
  - The sentence for a used number: "Till N already exists at this store."
- `linkTerminal(tx, actor, {storeId, terminalId, pairingId | null})`:
  - the pairing must be a live pairing of the same store;
  - a pairing can serve only one till (the `pos_terminals_pairing_key` index), with the sentence "That tablet already
    acts as till N.";
  - `null` un-links the tablet.
- `setTerminalPrinter(tx, actor, {storeId, terminalId, receiptPaperMm, receiptCopies})` takes paper 58 or 80 and copies
  from 1 to 3.
- **Audit actions:** `pos.terminal_created`, `pos.terminal_linked`, `pos.terminal_printer_set`. Register them in the
  catalogue and record before and after for each.
- A change bumps the store's `pos_stores.state_version`, if that row exists, so tablets refresh.

## R3 — Snapshot and tablet

- The T-525 snapshot's `store` gains `receiptPaperMm` and `receiptCopies` (closed-list keys). The ETag changes when
  either changes.
- T-528:
  - deletes the `PRINT_LAYOUT` and `RECEIPT_COPIES` shortcuts;
  - prints with `{width: store.receiptPaperMm, font: 'normal'}` and `copies: store.receiptCopies`;
  - when an old cached snapshot lacks them, keeps Pay blocked with the existing "connect once to refresh" sentence.

## R4 — Screen (`/admin/pos-tablets`)

- Add a **Tills** section per store, under the existing pairings list. It is a table with columns: Till, Tablet, Paper
  and Copies, plus actions.
- Actions:
  - **Add till**: a number input from 1 to 99, defaulting to the next free number;
  - **Choose tablet**: a select of the store's free live pairings, plus "No tablet";
  - **Printer**: paper as 58 mm / 80 mm radio buttons, and copies 1–3.
- The screen uses the ERP kit, flash messages, `requirePageAccess`, and refusals shown in the domain's sentences.
- The census guards cover the new controls. Bump them honestly and flag the bumps for BOSS.

## R5 — Tests (the tester writes them first; every ✅ needs its ✗)

- **Migration and DB:**
  - the defaults on existing rows are 58 and 1;
  - CHECK refuses 70 for the paper width and 0 or 4 copies;
  - the grant: UPDATE of `terminal_no` is refused (42501), and UPDATE of the printer columns works.
- **Domain:**
  - create, link, un-link and set printer each succeed for a store manager, and each is audited;
  - a duplicate number is refused;
  - a pairing from another store is refused;
  - a pairing already linked to another till is refused;
  - a manager of another store is refused;
  - a cashier is refused;
  - `state_version` bumps.
- **Snapshot:**
  - it carries `receiptPaperMm` and `receiptCopies`;
  - changing the printer changes the ETag;
  - a tablet whose pairing has no till still answers 409.
- **T-528:**
  - the receipt prints at 48 columns when paper is 80;
  - copies 2 calls the adapter with `{copies: 2}`;
  - an old snapshot without the keys blocks Pay.
- **Screen:**
  - the page refuses a person without the capability;
  - an integration test runs the actions through the real domain.

## R6 — Gates

Typecheck · the unit project · the integration files above, plus t523, t525 and t528 · the census set. Use the lane's
own `_test` DB. **Never print any `.env.local` value**, not even a name check.

# T-643: Flavours chosen at seating (like v1), which then lead the refill flavour pills

**Owner:** builder (Sonnet). **Auditor:** Sonnet. **Spec:** BOSS (Opus), 26 Nov 2026. **No migration.** Live POS = ERP `/pos` (apps/erp/src/app/pos). Not apps/pos (frozen, being deleted by T-644).

**Ian, 26 Nov 2026:** "yes plan the flavours at seating like v1".

## v1, read as requirements (C:\Users\ianla\webapps\POS)
- The start-session form asks for 1 to 3 "Initial Flavors" (`start-session-form.tsx:44`, :399-430). The list is every store flavour, not filtered by package.
- They are saved on the session and on the package kitchen ticket (`firestore.ts:197,254,337`). They cannot be edited later.
- What they do afterwards:
  - Kitchen: shown as badges on the package ticket.
  - Refill modal: those flavours sort FIRST in the pill list and are highlighted, with the default flavour names shown beside the package name (`RefillPOSModal.tsx:192-199, 640-669, 806`). This is a sort only, never a limit, and nothing is pre-selected.
  - They are not printed on the bill and not used in reports.

## v2 today (origin/main)
- A package variant can carry option groups with min/max (`menu_option_groups`). The seat dialog's MenuPicker already enforces them (`MenuPicker.tsx:43-100`, `menu-filter.ts:154`), and the server re-checks in `optionDelta` (`domain/pos/order.ts:99-125`).
- The chosen ids are stored on `table_session_lines.option_value_ids`, and the line name becomes "Package + Flavour1, Flavour2", which the kitchen already shows.
- Refills (T-566): one flavour per meat, taken from the refill item's own option group (`_refills/meats.ts`, `Refills.tsx:214-232`). The session's package-line flavours never reach the refill screen.

## Rule
1. **Seating = data, not code.** A "Flavours" option group on a package variant (multi, min 1, max 3, values ₱0.00) makes the seat dialog demand 1 to 3 flavours. That is v1's rule. No domain or schema change.
   - The builder checks that tapping a package that has such a group OPENS the choice sheet straight away (`needsChoiceSheet`). Required groups must show "(choose 1 to 3)", so the cashier cannot add the package without picking.
   - The header text of a multi group reads "Choose up to N" / "Choose N to M", never just "(choose)".
2. **Refills lead with the table's flavours (the v1 sort).**
   - Carry each open session's package-line flavour NAMES into the refill tables source: `refillTables` in the snapshot / `listRefillableTables`. Add `seatFlavours: string[]` to `RefillTable` in `_refills/tables.ts`.
   - In `Refills.tsx`, for the selected table, sort each meat's flavour pills so the ones whose name matches a seating flavour come first. Matching is case-insensitive and trimmed, because the package group and the refill group are different value rows. Mark those pills with a small "Table's pick" dot or label, without relying on colour alone.
   - Show the seating flavours as one quiet line under the table name ("Flavours: Spicy, Garlic").
   - **Never pre-select, never hide or limit the pills** (v1 only sorts). Do not change `refillFlavour` server rules (T-566: one flavour, refill free).
3. Kitchen: there is nothing to add. The package line name already carries the flavours. The builder only verifies that the KDS card and the outage print show them.
4. Take-out cannot hold a package, so this applies to dine-in only.

## Not in this task
- Editing flavours after seating (v1 has none).
- A schema column for session flavours (the package line already holds them).
- Limiting refill flavours to the seating ones.
- Ian's menu setup itself (the guide below goes to Ian).

## Ian's setup (goes into the PR description, in plain words)
Menu → open a package → Choices → add group **Flavours**, "pick several", minimum 1, maximum 3, then add each flavour at ₱0. Repeat for each package. Name the flavours exactly as on the refill items' flavour groups, so the refill screen can put them first.

## Tests (each with a mutant that goes red)
1. A package with a min-1 / max-3 group: seat with 0 flavours is refused (client and `openStand`), and 4 is refused. 1 to 3 is accepted and stored on `option_value_ids`.
2. The refill table source carries `seatFlavours` from the package line, and an empty list when the package has no group.
3. Pill sort: matching names (case/space-insensitive) come first, and the order of the rest is unchanged. Nothing is pre-selected. No pill is removed.
4. Send is still blocked when a required refill flavour is missing (the T-566 regression guard).

census:write; tsc -p apps/erp plus the new test files; impeccable for the pill marker; browser check on BIBO if possible.

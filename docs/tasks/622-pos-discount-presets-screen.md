# T-622: edit the POS named discounts in the ERP (list, add, change, retire)

**Owner:** builder (Sonnet), laptop (`_test` database). Auditor: Sonnet. **Spec:** BOSS (Opus), 21 Nov 2026.
**No migration** (`pos_discount_presets.status` already holds `active`/`retired`, migration 0238). **No new capability**
(`manage_store_settings` at the store, as `packages/domain/src/pos/store-setup.ts:5` already uses). **No Ian decision.**

## Why

The cashier's named discounts (e.g. "Staff meal 20%") reach the till in the snapshot
(`apps/erp/src/app/pos/_shell/payment-part.ts:9`), but they can only be created by the v1 loader script or copied from
another store. Nobody can add, change or retire one from a screen, which breaks the no-hard-coded-business-settings rule
(Ian, 5 Nov). T-523's spec handed this screen to T-535 (`docs/tasks/523-pos-v2-schema.md`, "Not in this slice"); this task
does it. **Out of scope:** a whole-bill discount (release 1 has none; "apply to all lines" already exists), senior/PWD
(fixed by law, not presets).

## What to build

1. **Domain** `packages/domain/src/pos/store-setup.ts`:
   - Reuse `upsertPosDiscountPreset` (create, or change the value of the active preset with that name) for add/change, with
     `source: 'web'`.
   - New `retirePosDiscountPreset(tx, actor, { storeId, presetId })`: `authorize` FIRST (same capability, at the store),
     sets `status = 'retired'` and `updated_at`, audit row `pos.discount_preset_retired` (before: name/type/value), bumps
     the store's snapshot version the same way upsert does (`bump`). Retiring an already-retired preset is a no-op.
     Repo function in `packages/db/src/repo/pos-store-setup.ts` (the only place SQL is written).
   - **Rename** is retire + add (keeps history simple); say so in the screen's help text.
   - Add the audit action to `packages/db/src/audit/catalogue.ts` (copy `pos.discount_preset_set`'s entry shape) and raise
     the catalogue ceiling pins honestly (t402-s1b, t453).
2. **Screen**: the existing "Discounts" section of `apps/erp/src/app/admin/pos-tablets/page.tsx` (~line 243) becomes:
   - A list of the store's active presets: name, "20%" or "₱50.00 off each", with Change and Retire.
   - "Add discount" opens a modal (the house add-form-in-a-modal pattern, T-589 B7): name (1-40), Percent / Peso amount,
     value (the house number box that groups thousands). Change opens the same modal with the name locked.
   - Retire uses the house light-confirm ("Retire Staff meal? Cashiers stop seeing it at once. Past sales keep it.").
   - The Copy-from-another-store button stays in the section. Show the section whenever the person may manage the store's
     settings (today it shows only when `copyStores` exists).
   - Refusals show the domain's sentence (it already words them plainly).
   - Server actions in a sibling `actions.ts`, each a thin call into the domain; request keys per form as the other admin
     forms do.
3. A retired preset must disappear from the till's snapshot (check the snapshot query filters `status = 'active'`; if it
   does not, fix it there).

## Tests (each with a mutant that goes red)

1. Integration (domain): add → listed in the snapshot; change value → audit before/after; retire → gone from the snapshot,
   audit row written; a cashier (no `manage_store_settings`) is refused for all three (mutant: drop the `authorize` in
   retire → red).
2. Integration: retire then add the same name works (the unique index is on active names only).
3. Unit: the page renders the list, the Add button, and hides Change/Retire for a person without the right.
4. Capability matrix tests: no new capability, so only check `route-capability-coverage` still passes.

- Pins: `npm run census:write` (action-link-sweep, touch-target baseline, T-343 ratchet, domain-actions-have-callers).
- Browser check on port 9008 with a forged session (`docs/SMOKETEST.md` §3): add, change, retire one preset; screenshot.

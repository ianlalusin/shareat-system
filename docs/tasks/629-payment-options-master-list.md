# T-629: one master list of payment options; each store switches them on

**Owner:** builder (Sonnet), laptop. Auditor: Sonnet (money + schema). **Spec:** BOSS (Opus), 23 Nov 2026.
**MIGRATION 0277** (reserved on the board).
**Ian, 22-23 Nov 2026:**
- The payment options are Cash, GCash, Maya, QRPH, Credit card and Debit card.
- Cards are kept simple: a card is a `wallet` tender tied to the bank money account the card machine pays into, and the bank fee is booked later as a bank charge.
- Vouchers stay a discount (row 45). Store credit is not on the POS.
- "can the payment options be centralized that each store enables in setting" → "go".

## Today

`tenders` (`packages/db/schema/pos-v1.ts:195`) are per-store rows: name, kind cash|wallet, money_account_id (wallet only), pos_v1_alias, is_active. They are edited per store on Settings > POS link (`apps/erp/src/app/settings/pos-link`, `TendersSection`). Domain code is `packages/domain/src/pos/tenders.ts`. The same option can therefore have different names at different stores ("Gcash" / "GCash" / "G-Cash"), and nothing ties them together for company-wide reports.

## Rule (v2)

- **Master list** `payment_options` (org-level):
  - columns: org, name (1-40, unique per org case-insensitively), kind cash|wallet, sort order, status active/retired, created/updated
  - **one cash option per org at most**
  - edited on a new ERP screen (Settings > Payment options, or a section on an existing org-settings page if one fits better). Pick a capability that matches who edits org-wide money settings today; check `docs/decisions/CAPABILITY-MATRIX.md` and the existing settings pages; do not invent a new one unless none fits, and say which you chose.
  - add / rename / retire, with authorize() first and audit rows
  - retiring is refused while any store has it switched on
  - the kind cannot change once any store uses the option
- **Store switch:** `tenders` gains `payment_option_id` (NOT NULL after backfill, same-org composite FK). A store tender IS the store's switch for that option:
  - unique per (store, payment_option_id)
  - the tender's `name` and `kind` come from the option; drop them or keep them as a mirror, builder's call, but there must be ONE source of truth for the name and the kind
  - the store still owns `money_account_id`, which is required for a wallet, must be one of THIS store's active accounts (existing rule kept), and is null for cash
  - the store also keeps `pos_v1_alias` and `is_active` (= switched on)
  - Settings > POS link shows the master list with an on/off switch per option; switching on a wallet option asks for the money account
- **Backfill in 0277:**
  - every existing tender gets an option matched by normalised name within its org (lower, a-z0-9 only, the same normalisation as the alias)
  - an option is created when none matches
  - two tenders at one store that map to the same option: STOP and report to BOSS (do not merge money rows)
  - the migration prints nothing; write a test that runs the backfill on realistic rows ("Gcash" and "GCash" at two stores become one option)
- **Seed:** a new org gets the six options of Ian's list. Existing orgs get any of the six that are missing, matched by normalised name.
- **Readers keep working:** the POS snapshot (`pos/snapshot.ts:73`), day close, convert, refunds, the v1 bridge alias, the T-626 loader (`packages/etl/src/pos-v2/load-store-setup.ts`: wallet matched by v1 name; it must now match through the option and never create a master option silently, only report) and T-623 wallet checks.
- **Company-wide report hook (small):** wherever a report already lists amounts by tender (X/Z, day close, sales day), it must now be able to group by `payment_option_id`. Do not build a new report.

## Not in this task

- Card clearing or MDR (Ian chose simple).
- Sold gift vouchers.
- Store credit at the POS.
- A new report screen.
- Changing remittance.

## Tests (each with a mutant that goes red)

1. Backfill: "Gcash" (store A) and "GCash" (store B) become one option; Cash at both stores becomes one option; a lone "Bank Transfer" becomes its own option.
2. A store cannot switch the same option on twice (unique). A wallet without a money account, or with another store's account, is refused.
3. Retiring an option in use is refused. A kind change on an option in use is refused. A second cash option is refused.
4. ERP actions: authorize first, the audit row written, a cashier / store manager refused for the master list.
5. Snapshot and day close still produce the same tender names and amounts after the migration (pin an existing day-close test).
6. The T-626 loader matches an existing wallet option and reports a missing one without creating it.

Migration 0277 is hand-authored (ADR-012 §5): classification + RLS registry + journal (`when` = 0276's + 86400000). The full CI suite is required. Run `npm run census:write`. Typecheck apps/erp, plus the package tests via a temp tsconfig.

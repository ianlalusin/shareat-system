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
  - ~~one cash option per org at most~~ **DROPPED by BOSS ruling, 23 Nov:** Lipa's live tenders are Cash AND "Collected" (bible row 292, docs/tasks/396): an org may hold several cash options
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

## As built (builder, Sonnet, 23 Nov 2026)

**BOSS rulings applied, 23 Nov:** (1) the one-cash-option rule is gone everywhere (domain, DB index, migration STOP, seed, screen): Cash and Collected are two cash options. (2) The raw-INSERT shim is gone: a tender insert without `payment_option_id` fails on NOT NULL; tests insert through one helper, `packages/db/tests/integration/_fixtures/t629-tender.ts`.

**Capability.** `manage_chart_of_accounts`, org scope (admin and super-admin; manager and below refused). It is what already gates a store's tenders, the money accounts and every other org-wide "where money is booked" setting (CAPABILITY-MATRIX), so no new capability. Master list writes call `authorize(tx, actor, 'manage_chart_of_accounts', {})` first; the store switch keeps `{ storeId }`.

**Migration 0277** (`packages/db/migrations/0277_t629_payment_options.sql`, journal idx 277, `when` 1810006307084 = 0276's + 86400000):
- `payment_options` (org, name 1-40 unique per org by `lower(btrim(name))`, kind cash|wallet, sort_order, status active|retired); no limit on cash options; RLS ENABLE + FORCE, `app_current_org()` policy, SELECT/INSERT plus column UPDATE grants, no DELETE.
- `tenders.payment_option_id` NOT NULL, composite same-org FK, `UNIQUE (store_id, payment_option_id)`.
- ONE source of truth: the option owns name and kind; `tenders.name` / `tenders.kind` stay as a MIRROR forced by trigger `tenders_mirror_option` (BEFORE INSERT/UPDATE: the option cannot change, name/kind are set from the option, a retired option cannot be switched on). `payment_options_guard` (kind frozen while any tender uses it, retire refused while any store has it ON) and `payment_options_rename_tenders` (a rename copies onto the tenders). All three are origin triggers (registered: derivation / validator / derivation), so the ALWAYS count is unchanged. Every reader (snapshot, day close, convert, refunds, bridge alias, T-623) keeps reading `tenders.name` / `kind`.
- Backfill inside the file (prints nothing): matched by normalised name inside the org; the Ian-list spelling wins; the six are then added to every org that lacks them. A store with Cash and Collected gets two cash options. It RAISES (nothing applied) in THREE cases: two tenders of one store map to one option; one option's tenders disagree on cash/wallet; one of the six names is held with the other kind. Run the read-only pre-check on production before deploy (below).
- Seed for a new org: `packages/db/seed/payment-options.ts`, called from `seedReferenceData` (so `createOrganization` gets the six).

**Screens.** Both on Settings > POS link (same page, same capability, no new route): an org-level "Payment options (all stores)" section above the store cards (add / rename / retire-restore; Cash is not offered while a cash option exists; kind locked once a store uses it), and each store card now lists every active option as ON (the old tender record: money account and POS name editable, Switch off) or OFF (Switch on dialog, money account required for a wallet). The free-typed "Add a tender" form and the Name / Kind fields of the tender record are gone.

**Readers.** `TenderLine` (X/Z reading) and `DayCloseListItem.byTender` carry `paymentOptionId`; `groupByPaymentOption` sums any such lines per option and `listDayCloses` returns `byPaymentOption` (the report hook, with a production caller). The T-626 loader matches a v1 method THROUGH the org's option (v1 "G-Cash" finds GCash), switches a CASH option on, lists a wallet option as needing a money account, and lists a method with no master option under `optionsMissing` (never creates one).

**Tests (mutants proven red by hand).** Backfill `t629-payment-options-migration.test.ts` (B1/B2 one option per name across stores, tenders renamed to the option; B3 same-store STOP; B4 kind STOPs; B5 Cash and Collected become two cash options; B6 six for an org with no tenders; B7 prints nothing; mutants M1-M6 each red). Rules `t629-payment-options.test.ts` (12 cases: unique switch, wallet account rules, retire/kind/second-cash refused in domain AND database, rename cascade, authorize-first for manager and cashier, audit rows; mutants S1, T1-T3, O1-O5 each red). Readers `t629-day-close-options.test.ts` (names and amounts unchanged, option on each line, snapshot names, grouping; mutants D1-D3 red). Loader: two new cases in `t626-lipa-menu-load.test.ts` (L1, L2 red). Older tender tests were rewritten where they edited a tender's name or kind (now the option's).

**Production pre-check for BOSS (read-only, run before deploy; each must return 0 rows; three STOP cases):**
```sql
-- (a) two tenders of one store with one normalised name
select store_id, regexp_replace(lower(name),'[^a-z0-9]','','g') k, count(*) from tenders group by 1,2 having count(*) > 1;
-- (b) one normalised name that is cash somewhere and a wallet elsewhere
select org_id, regexp_replace(lower(name),'[^a-z0-9]','','g') k from tenders group by 1,2 having count(distinct kind) > 1;
-- (c) a tender named like one of Ian's six with the wrong kind (Cash must be cash; GCash, Maya, QRPH, Credit card, Debit card must be wallets)
select org_id, name, kind from tenders
 where (regexp_replace(lower(name),'[^a-z0-9]','','g') = 'cash' and kind <> 'cash')
    or (regexp_replace(lower(name),'[^a-z0-9]','','g') in ('gcash','maya','qrph','creditcard','debitcard') and kind <> 'wallet');
```

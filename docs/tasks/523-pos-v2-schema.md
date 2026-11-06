# T-523 — POS v2 schema: stands, table sessions, sales receipts, day close, the event inbox, the per-store switch

**Status:** SPEC (Opus planner, POS design lane, 6 Nov 2026). Due Mon 9 Nov. **Owner:** orchestrator (BOSS).
**Migration:** one, **0238**, hand-authored (ADR-012 §5). 0237 is T-511 S5c; recompute `when` from the journal head at
authoring time. **Own PR** (migration rule; full integration suite on a fresh DB, then CI).
**Lanes:** Sonnet tester → Sonnet builder → Sonnet auditor (schema + money: auditor is always Sonnet). Branch from
`claude/pos-design-f9d926` (PR #165) until it merges.
**Authority:** `docs/plans/pos-v2-design.md` §5 and §9 · bible rows 430, 431, 435, 270, 272, 276, 313, 356, 371, 390 ·
ADR-015 §5 and Amendment 2 · ADR-012 · GLOSSARY ("session", "receiptSeq", "receipt").

## Why

Ian, 6 Nov: *"pos is a piece of erp"*, *"no firebase db now"*; Lipa on the new POS on **7 Dec** (row 431). Today
every floor record (sessions, bill lines, kitchen tickets, receipts, Z readings) lives in Firestore
`shareat-hub-v2`. No Postgres table holds any of it (discovery: no `table_sessions`, `pos_events`, stands, Z or sales
receipt table exists). This slice creates the tables release 1 needs and **nothing else**. Every later slice
(T-524 domain, T-525 APIs, T-531 day close) builds on it.

## v1 goal (requirements, §1.2d) and the v1 flaws this schema removes

**Goal:** a party is seated on a free stand, orders a per-head package and à la carte, gets refills and kitchen
tickets, pays any tender with correct change, and the day closes into the ERP's sales day. Every action is tied to a
person, and a sale made offline is never lost or counted twice.

| v1 (discovery 39) | Effect | v2 rule here |
|---|---|---|
| `sessions` + `activeSessions` + `closedSessions`, `tables` twice, KDS fan-out (flaw E) | Copies drift | One row per thing; screens read queries, not copies (R4, R5) |
| `receiptSeq` from two allocators, refunds write 0 (DEF-001/002/587) | Not a key | `UNIQUE (terminal_id, receipt_seq)`, continuous per terminal, never reset (R7) |
| Paid receipts edited in place (13 in 91 days) | No audit trail | Sales receipt rows immutable after insert, except the two named columns (R7, R9) |
| A stand used twice (row 371) | Two bills on one stand | Partial unique: one open session per stand (R4) |
| Offline queue in localStorage, Firestore writes as ops | Loss, double apply | Event inbox with `UNIQUE (pairing_id, seq)`; replay is a no-op (R10) |
| Tender keyed by display name | Renames split history | `tender_id` FK (R8) |

## Rulings

Conventions for every table below (discovery 6 Nov, `packages/db/migrations/0232_*`, `0212_*`, `0221_*`):
- `id uuid PRIMARY KEY DEFAULT uuidv7()`; `org_id uuid NOT NULL` → `organizations` RESTRICT; `store_id` where stated,
  with the single-column FK **and** the `(org_id, store_id)` same-org composite FK (DEF-491 census).
- Every `person` reference gets both FKs as well (`persons(id)`, and `(org_id, x)` → `persons(org_id, id)`).
- Money is `numeric(14,2)` (RULES §1 rule 6: numeric in the DB, integer centavos in code). Quantities and heads are
  `integer`.
- Device times are `*_at_device timestamptz NOT NULL`; server times are `*_at timestamptz NOT NULL DEFAULT now()`.
  **The business day never comes from a device clock** (v1 flaw O). It is fixed by the day close (R9).
- RLS: `ENABLE` + `FORCE` + `<t>_org_isolation` via `app_current_org()`. Register each table in
  `src/rls/registry.ts` (`org_column`) and classify it in `src/cutover/classification.ts`.
- Grants: SELECT, INSERT only unless a column-level `GRANT UPDATE (...)` is named below. No DELETE anywhere.
- Every trigger is registered in `src/triggers/registry.ts` (an immutability or forward-only guard is
  `kind: 'history_guard'`, `mode: 'always'`, `ENABLE ALWAYS TRIGGER`).
- Ids of session, line and sales receipt rows **may be supplied by the device** (uuidv7 made offline). The default
  still applies when the server creates a row.

- **R1 — `pos_stores`: the per-store switch and the polling counter.** One row per store (`store_id` UNIQUE): `mode`
  `text NOT NULL DEFAULT 'off' CHECK in ('off','test','live')`, `live_from date` (NULL unless live;
  `CHECK ((mode='live') = (live_from IS NOT NULL))`), `state_version bigint NOT NULL DEFAULT 0 CHECK (>= 0)`,
  `changed_by` person, `changed_at`. Column UPDATE grant on (`mode`, `live_from`, `state_version`, `changed_by`,
  `changed_at`). Classified **keep** (configuration). Row 435: every store is `off` until its go-live. `test` is for
  the soak and emulator stores. Mode changes are audited by the domain (T-524), not by a trigger.
  `state_version` is bumped **by the domain in the same transaction** as any change a screen polls for (T-524 tests
  it); the poll route (T-525) answers 304 when it is unchanged.
- **R2 — `pos_stands`: the store's fixed stand set (row 371).** `store_id`, `number smallint NOT NULL CHECK (between
  1 and 999)`, `status text NOT NULL DEFAULT 'active' CHECK in ('active','retired')`, `created_by`, `created_at`,
  `updated_at`. `UNIQUE (store_id, number)` (retired numbers are never reused, so no partial index). Also
  `UNIQUE (store_id, id)`, the target of R4's same-store FK. Column UPDATE grant on (`status`, `updated_at`).
  **keep**. Lipa's stands are loaded from v1's `stores/{id}/tables` by an ops script in T-533; no screen in release 1
  (the ERP master-data screen is T-535 or later; until then the set is changed by script, and the change is audited).
- **R3 — `pos_terminals`: the stable receipt-number identity.** `store_id`, `terminal_no smallint NOT NULL CHECK
  (between 1 and 99)`, `pairing_id uuid NULL` → `pos_tablet_pairings(id)` (the tablet currently acting as this
  terminal), `created_by`, `created_at`, `updated_at`. `UNIQUE (store_id, terminal_no)`, `UNIQUE (store_id, id)`, and a
  partial `UNIQUE (pairing_id) WHERE pairing_id IS NOT NULL`. Column UPDATE grant on (`pairing_id`, `updated_at`).
  **keep**. *Why a separate row:* the receipt series must continue when a dead tablet is replaced (DEF-587), but the
  outbox `seq` restarts on a new install. So receipts key on the **terminal** and events key on the **pairing**.
  The soak's two tablets are two TEST stores, each with one live pairing (`pos_tablet_pairings` allows one per store).
- **R4 — `table_sessions`: a seated party or a take-out order** (GLOSSARY "session": not an auth session).
  `store_id`, `stand_id uuid NULL` (composite FK `(store_id, stand_id)` → `pos_stands(store_id, id)`), `mode text NOT NULL
  CHECK in ('dine_in','take_out')`, `CHECK ((mode='dine_in') = (stand_id IS NOT NULL))`, `heads_cashier integer NOT
  NULL CHECK (between 0 and 200)` (0 only for take-out), `heads_server integer NULL CHECK (between 1 and 200)`,
  `status text NOT NULL DEFAULT 'open' CHECK in ('open','paid','voided')`, `opened_by` person, `opened_at_device`,
  `opened_on_pairing_id` → `pos_tablet_pairings(id)`, `opened_at` (server), `voided_by` person NULL,
  `voided_at_device` NULL, `void_reason text NULL`, `voided_offline boolean NOT NULL DEFAULT false`,
  `CHECK ((status='voided') = (voided_by IS NOT NULL AND void_reason IS NOT NULL AND length(trim(void_reason))>0))`,
  `CHECK (voided_offline = false OR status='voided')`.
  **One open session per stand:** `CREATE UNIQUE INDEX ... ON table_sessions (stand_id) WHERE status='open' AND
  stand_id IS NOT NULL` (hand-added). **Forward-only trigger:** `open → paid | voided` only; `paid` and `voided` are
  final, and `id`, `org_id`, `store_id`, `stand_id`, `mode`, `opened_*` never change. Column UPDATE grant on
  (`heads_cashier`, `heads_server`, `status`, `voided_by`, `voided_at_device`, `void_reason`, `voided_offline`).
  `UNIQUE (store_id, id)`. **purge** (row 379: pre-2027 POS data is test data). The billed head count is
  `greatest(heads_cashier, coalesce(heads_server, 0))` (v1 rule), computed by T-524, never stored.
- **R5 — `table_session_lines`: what was ordered, including kitchen state and refills.** `store_id`, `session_id`
  (composite FK `(store_id, session_id)` → `table_sessions(store_id, id)`), `kind text NOT NULL CHECK in
  ('package','item','refill')`, `menu_item_id` + `menu_item_variant_id NULL` (same-org FKs), `name text NOT NULL`
  (the name as sold, for the ticket and the slip), `qty integer NOT NULL CHECK (qty > 0)`, `unit_price numeric(14,2)
  NOT NULL CHECK (unit_price >= 0)`, `CHECK (kind <> 'refill' OR unit_price = 0)`, `kitchen_station_id uuid NULL`
  (composite FK `(store_id, kitchen_station_id)` → `kitchen_stations`), `kitchen_status text NOT NULL DEFAULT 'queued'
  CHECK in ('queued','served','cancelled')`, `served_at_device NULL`, `served_by` person NULL,
  `CHECK ((kitchen_status='served') = (served_at_device IS NOT NULL))`, `note text NULL CHECK (length(note) <= 200)`,
  `added_by` person, `added_on_pairing_id NULL` (NULL when added from a phone browser), `added_at_device`,
  `added_at`. Forward-only trigger on `kitchen_status` (`queued → served | cancelled`, both final); every other
  column is immutable. A line of a `paid` or `voided` session is refused on INSERT (same trigger function, the row 272
  rule pulled down to lines). Column UPDATE grant on (`kitchen_status`, `served_at_device`, `served_by`). **purge**.
  *Package heads:* a `package` line's `qty` is the billed head count at payment. T-524 sets the line's qty from R4's
  rule when it records the sale (the line is replaced by a cancelled + new line, never edited).
- **R6 — `pos_sales_receipts`** (GLOSSARY: never bare "receipt"; this is the **sales receipt**, not
  `pos_bridge_receipts`, which stays the read-only v1 copy). `store_id`, `terminal_id` (composite FK `(store_id,
  terminal_id)` → `pos_terminals`), `receipt_seq integer NOT NULL CHECK (> 0)`, `UNIQUE (terminal_id, receipt_seq)`,
  `table_session_id` UNIQUE (composite same-store FK), `cashier_id` person, `issued_at_device`, `received_at`,
  `subtotal`, `discount_total numeric(14,2) NOT NULL DEFAULT 0 CHECK (>= 0)` (in release 1 only senior/PWD, R12; that
  it equals the sum of R12's rows is a T-524 rule and test, since a CHECK cannot sum child rows), `total numeric(14,2)
  NOT NULL CHECK (total >= 0)`,
  `CHECK (total = subtotal - discount_total)`, `device_total numeric(14,2) NOT NULL` (as the tablet computed it),
  `offline boolean NOT NULL`, `day_close_id uuid NULL` → R9. **Immutable** (`history_guard` trigger): every column is
  frozen at insert, except `day_close_id`, which may go from NULL to a value **once**. Column UPDATE grant on
  (`day_close_id`) only. A mismatch (`total <> device_total`) is not a constraint: T-524 records the sale with the
  **server's** figure and raises a finding (row 276). **purge**. The printed number is `<store code>-<terminal_no
  2 digits>-<receipt_seq 6 digits>`, formatted by the app and never stored.
- **R7 — `pos_sales_receipt_lines`.** `receipt_id`, `line_no smallint NOT NULL`, `UNIQUE (receipt_id, line_no)`,
  `session_line_id NULL` → R5, `kind`, `name`, `qty`, `unit_price`, `amount numeric(14,2) NOT NULL`,
  `CHECK (amount = qty * unit_price)`. The frozen copy of what was billed (refills appear with amount 0). Append-only
  (SELECT, INSERT; `history_guard` trigger refuses UPDATE/DELETE). **purge**.
- **R8 — `pos_sales_receipt_payments`.** `receipt_id`, `tender_id` (same-org FK; the tender's store equals the
  sales receipt's store, checked by T-524 because `tenders` has no `(store_id, id)` unique), `amount numeric(14,2) NOT
  NULL CHECK (> 0)`, `change_given numeric(14,2) NOT NULL DEFAULT 0 CHECK (>= 0)`, `reference_no text NULL CHECK
  (length(reference_no) between 4 and 40)`, `to_check boolean NOT NULL DEFAULT false`,
  `CHECK (NOT to_check OR reference_no IS NOT NULL)` (A3: an e-wallet taken offline needs its reference),
  `checked_by` person NULL, `checked_at NULL`, `CHECK ((checked_at IS NULL) = (checked_by IS NULL))`,
  `CHECK (checked_at IS NULL OR to_check)`. Change is given from cash only: enforced by T-524 against `tenders.kind`
  (a CHECK cannot see the tender). Trigger: every column frozen except `checked_by` and `checked_at`, NULL → value once.
  Column UPDATE grant on (`checked_by`, `checked_at`). **purge**.
- **R9 — `pos_day_closes` (the Z, row 390) and `pos_day_close_tenders`.** `pos_day_closes`: `store_id`,
  `terminal_id`, `z_no integer NOT NULL CHECK (> 0)`, `UNIQUE (terminal_id, z_no)`, `business_date date NOT NULL`
  (the date the window opened, Manila; rows 348 and 390), `window_start timestamptz NOT NULL`, `window_end timestamptz
  NOT NULL`, `CHECK (window_end > window_start)`, `receipt_count integer NOT NULL CHECK (>= 0)`, `gross_total
  numeric(14,2) NOT NULL CHECK (>= 0)`, `closed_by` person, `approved_by` person (a manager, row 390),
  `closed_at` (server). `UNIQUE (store_id, business_date, terminal_id)`.
  `pos_day_close_tenders`: `day_close_id`, `tender_id`, `amount numeric(14,2) NOT NULL`, `UNIQUE (day_close_id,
  tender_id)`. Both are append-only (`history_guard`). **purge**. The window chaining (each Z starts where the last
  ended; a late sales receipt lands in the next Z, row 393) is T-531's domain rule, tested there.
- **R10 — `pos_events`: the outbox inbox (bible §5.1 Lane B, row 430).** `store_id`, `pairing_id` →
  `pos_tablet_pairings(id)`, `seq bigint NOT NULL CHECK (> 0)`, **`UNIQUE (pairing_id, seq)`** (a replay is a silent
  no-op, §5.4 rule 4), `kind text NOT NULL CHECK (kind ~ '^[a-z]+(\.[a-z_]+)+$')` (e.g. `stand.opened`,
  `lines.added`, `sale.completed`; the closed list lives in T-525's code, not a CHECK, so adding a kind needs no
  migration), `payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object')`, `person_id` person NULL,
  `occurred_at_device`, `received_at`, `status text NOT NULL CHECK in ('applied','quarantined')`, `error text NULL`,
  `CHECK ((status='quarantined') = (error IS NOT NULL))`, `resolved_by` person NULL, `resolved_at NULL`,
  `resolution text NULL CHECK in ('replayed','discarded')`, `CHECK ((resolved_at IS NULL) = (resolved_by IS NULL)
  AND (resolved_at IS NULL) = (resolution IS NULL))`, `CHECK (resolved_at IS NULL OR status='quarantined')`. Trigger:
  every column frozen except the three resolution columns, NULL → value once. Column UPDATE grant on (`resolved_by`,
  `resolved_at`, `resolution`). Index `(store_id, status) WHERE status='quarantined'` (the manager's list).
  **purge** (row 436). *Payload rule:* raw facts only (§5.1). No computed business outcome is trusted from a payload; T-524
  recomputes.
- **R11 — `sales_days` learns its third source.** Drop and re-add `sales_days_source_check` as `source in
  ('legacy_typed','pos_v1_day_feed','pos_receipts')` (the 0209 drop/re-add pattern). Add `pos_day_close_id uuid NULL`
  → `pos_day_closes(id)` (+ same-org twin), and `CHECK ((source='pos_receipts') = (pos_day_close_id IS NOT NULL))`.
  **Do not touch** the 0185 figure-lock or the 0188 verify triggers. T-531 makes the derivation; this slice only lets
  the row exist. ⚠️ A store with several terminals would have several Zs a day; release 1 has one terminal per store
  (row 313), so one Z per sales day. T-531 refuses a second Z for the same store and business date until a
  multi-terminal rule is written (flagged, not designed here).

- **R12 — Senior/PWD is in release 1 (BOSS ruling, 6 Nov: a legal requirement; ADR-015 §5 lists it as working
  offline).** New `pos_sales_receipt_discounts`: `receipt_id`, `kind text NOT NULL CHECK in ('senior','pwd')`,
  `share_amount numeric(14,2) NOT NULL CHECK (> 0)` (the qualifying diner's share before discount, VAT included),
  `vat_removed numeric(14,2) NOT NULL CHECK (>= 0)`, `discount_amount numeric(14,2) NOT NULL CHECK (> 0)`,
  `CHECK (vat_removed + discount_amount <= share_amount)`, `statutory_record_id uuid NOT NULL` →
  `statutory_discount_records(id)` (+ same-org twin), `UNIQUE (statutory_record_id)`. Append-only (`history_guard`).
  **purge** (row 436). ⛔ **The holder's name and ID number are NOT stored here** (row 353): they live only in
  `statutory_discount_records` (T-137), written by T-524 with `source = 'pos'` and `invoice_number` = the printed
  sales receipt number, in the same transaction as the sale. Offline, the tablet carries name and ID inside the
  `sale.completed` event payload; T-525 must keep payloads out of logs, and the payload of a quarantined event is
  shown only to people with the statutory-record capability.
  **Changes an existing index:** `statutory_discount_records_live_invoice_key` is `(org_id, store_id, business_date,
  invoice_number) WHERE voided_at IS NULL`, so it allows ONE senior/PWD per bill, built for v1's whole-bill discount.
  The approved PC-7 payment screen (Ian, 17 Oct) discounts per qualifying diner, so two seniors at one table need two
  rows. Replace it with `(org_id, store_id, business_date, invoice_number, id_number) WHERE voided_at IS NULL`: still
  one discount per card per bill (a PWD who is also a senior presents one card and claims one 20%). Update the schema
  comment in `statutory-discounts.ts` that says "one live row per invoice".
  *Share rule (row 437, Ian 6 Nov):* the diner's own package head plus dishes ordered only for them; shared dishes are
  not discounted. Add `for_diner smallint NULL CHECK (between 1 and 200)` to `table_session_lines` (R5): the diner
  number a dish was ordered for, NULL = shared. T-524 computes `share_amount` from it.

## Not in this slice (and where it goes)

Refunds and `parent_receipt_id`, tender corrections, Convert → **T-534** (own migration) · preset (non-statutory)
discounts → **T-535** (2 bill discounts in 91 days across all four stores, 0 at Lipa: discovery 42 §4) · stock-usage drafts from sales receipts → **T-535** · the offline thresholds (₱50,000 warning, X-slip every
4 h, verifier expiry 24 h) → `business_rule_values` (0237, T-511 S5c) read by T-530, so **no column here** (Ian's
no-hard-coded-values rule, 5 Nov) · X-slips (printed locally; their `xslip.printed` event lands in R10) · loyalty
(row 432) · PIN verifiers (made on the device; no server table, design §5.2 A6) · a stand-editing ERP screen.

## Files (the only ones the builder may touch)

- `packages/db/migrations/0238_t523_pos_v2_schema.sql` (new) and `packages/db/migrations/meta/_journal.json`
- `packages/db/schema/pos-v2.ts` (new) · `packages/db/schema/sales-days.ts` (R11 only) · `packages/db/schema/statutory-discounts.ts` (R12's index and comment only) · `packages/db/schema/index.ts`
- `packages/db/src/rls/registry.ts` · `packages/db/src/cutover/classification.ts` · `packages/db/src/triggers/registry.ts`
- `packages/db/src/rls/same-org-fk-exemptions.ts` only if the census demands an exemption (say why in the report)
- `packages/db/src/repo/pos-v2.ts` (new): **typed read helpers only** (by id; open sessions of a store; lines of a
  session; quarantined events of a store). No write helpers; T-524 owns writes. Plus its line in `packages/db/src/index.ts`
- Tests: `packages/db/tests/integration/t523-pos-v2-schema.test.ts` (new) · `tests/unit/` guards only where a census
  count must move (name each in the report)

## Tests (written first; each must fail for the right reason before the migration exists)

1. A second open session on the same stand is refused (23505); a paid one frees the stand; take-out needs no stand,
   dine-in must have one.
2. `table_sessions` forward-only: `paid → open` and `voided → paid` refused; `opened_by` cannot change.
3. A line cannot be added to a paid or voided session; a refill with a price is refused; `served → queued` refused.
4. Sales receipts: `UNIQUE (terminal_id, receipt_seq)`; a second sales receipt for one session refused; UPDATE of
   `total` refused even by the table owner (trigger is ALWAYS); `day_close_id` set once, then refused.
5. Payments: `to_check` without a reference refused; `checked_*` set once; `amount` frozen.
6. Events: the same `(pairing_id, seq)` twice → 23505 (the domain treats it as "already applied"); a quarantined row
   needs `error`; resolution only on a quarantined row and only once.
7. `sales_days`: `source='pos_receipts'` without `pos_day_close_id` refused, and the reverse; existing legacy and
   feed rows still satisfy every CHECK (run against the fixture set).
8. RLS: a second org sees none of these rows; a cross-org composite FK is refused (same-org census passes).
9. Grants: `shareat_app` cannot DELETE from any new table, and cannot UPDATE a column outside the named lists.
10. `pos_stores.mode` defaults to `off`; `live` needs `live_from`.
10a. Two seniors on one sales receipt: two `statutory_discount_records` rows (different id numbers) are accepted; the same
    id number twice on one invoice is refused; a `pos_sales_receipt_discounts` row whose `vat_removed + discount_amount`
    exceeds its share is refused; existing `manual` statutory rows still satisfy the new index.
11. Journal guard (`tests/migration-journal.test.ts`), the trigger registry tests (t354), the cutover-classification
    and RLS-registry unit tests, and the same-org FK census all pass.

**Done when:** the tests above pass against a fresh scratch DB (`shareat_scratch_t523`, never a shared or lane-pinned
DB); the full integration suite passes; CI is green on the PR; the auditor's findings are closed; the migration
applies to production **before** T-524 merges (it is inert: nothing reads these tables until the switch is on, row
435). Report the real test output.

## Rulings on the tester's questions (Opus planner, 6 Nov; the builder follows these and tightens the tests to them)

1. **Error codes.** A status transition a forward-only trigger refuses raises `check_violation` (23514). A change to
   a frozen column (`opened_by`, `qty`, `for_diner`, any sales receipt figure, an event's payload, and so on), a
   second write to a once-only column, an UPDATE or DELETE of an append-only row, and a line inserted into a paid or
   voided session all raise `restrict_violation` (23001), as `pay_rates_append_only` does. The tests' loose
   `FROZEN_OR_FORWARD` (23514 or 23001) is narrowed to these exact codes.
2. **Name of the new `sales_days` CHECK:** `sales_days_pos_day_close_link_check`.
3. **Nullability and defaults the spec left unstated:**
   - `table_session_lines.menu_item_id` is NOT NULL for every kind (refills are menu items too); `menu_item_variant_id`
     stays NULL-able.
   - `table_sessions.opened_on_pairing_id` is NOT NULL: a stand is opened only on the till (design A9).
   - `pos_stores.changed_by` and `changed_at` are NOT NULL (the row is created by an admin at store set-up).
   - `updated_at` is NULL-able with no default, set by the app (repo convention).
   - Child tables (`pos_sales_receipt_lines`, `pos_sales_receipt_payments`, `pos_day_close_tenders`,
     `pos_sales_receipt_discounts`) carry `org_id` but **no `store_id`**; their store follows from the parent. Each has
     the `(org_id, parent_id)` same-org composite FK, so each parent gets `UNIQUE (org_id, id)`.
4. **`pos_tablet_pairings` references** get the same-org twin as well, if `pos_tablet_pairings` has an `(org_id, id)`
   unique. If it does not, the builder adds one in 0238, or lists an exemption with its reason (census rule).
5. **Not covered by the tester, so the builder adds them:** a `pos_v1_day_feed` row still satisfies the new
   `sales_days` CHECKs (reuse the T-375 fixture), and the 0185 and 0188 triggers are unchanged (assert by name from
   `pg_trigger`).

## Ruled since the first draft (6 Nov)

- **Cutover class:** `purge` for R4–R10 and R12 (row 436). v1 receives Lipa's December day totals through T-531's
  bridge, so no booked figure lives only in these tables. R1–R3 stay `keep`.
- **Senior/PWD share:** row 437 (R12, and `for_diner` on R5).

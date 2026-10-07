# T-375: POS v1 day feed — sales days derived, locked, never typed

**Status:** APPROVED 2026-10-04 after three independent Opus reviews (✎V, ✎W, ✎Y); S1 SHIPPED `2c9b0f2` (migration 0183); S2 SHIPPED `88bd16d` (tender master + POS v1 method resolver); **S3 SHIPPED `7a33eea` 2026-10-05 (import + derived sales day; 11/11 mutants; FULL integration 5178/5178) and smoked on 9008 with the dev fake POS (typed form on an unlinked store; Import D1 → figures and "Imported from POS"; refund day → Dr 4950 on verify; linked edit refused). On screen not driven: re-import with changed figures (I2) and the not-configured sentence (W1)**; **S4 SHIPPED `7de5232` (0185, the figure lock; 17/17 mutants)**; **S5-lite SHIPPED (stored sold items, no live POS call; 17/17 spec mutants; four audit-added race guards X1-X4 are review-verified only, no test can force the interleaving)**; **S6 SHIPPED 2026-10-06 (rechecks, drift findings, the POS correction entry, the corrected-day void, T-210 without live POS; 18/18 mutants; FULL integration 320/5297)**. S4-S6 smoked on 9008 2026-10-06 with the dev fake POS (all legs passed; DEF-596, 597 logged). S5 replaced by S5-lite (bible rows 281-282), APPROVED 2026-10-05 after an independent Opus review (two HIGH holes fixed, ✎S5L-R) and a confirming pass; build note: the ₱0 check re-reads totalSales after the day lock is held**; migrations 0183/0185 (S4). Earlier: SPEC WRITTEN 2026-10-04 (Opus planner, plan mode). Amended the same day three times: an independent Opus
review (✎V1–✎V13), the orchestrator's per-store ruling (✎V2b), and a second-pass review (✎W1–✎W11). **This text is
consolidated: every slice, test and table line below already carries the amendments, and the Review log at the end
says where each one landed.** Not approved; not started. Fixes DEF-586 store by store. Proposes one new section-E defect
(✎N1) and three POS defects (✎V1) for the orchestrator to number.
Written at HEAD `ca852eb`, with T-367 S5's uncommitted work in the tree (`0182`, `expenses/*`, `_journal.json`). Every
line number below was read there. **T-367 S5 (`0182`) must be committed before S1 adds `0183` to the journal.**
**Model:** Sonnet per slice, tester first, then builder. Any amendment is written in plan mode (Opus).
**Migrations:** **0183** (S1: structure, no enforcement; shipped) and **0185** (S4: enforcement; renumbered from 0184 on 2026-10-05 because T-316 takes 0184). **Rule (migration order): the next migration takes the next index at build time; never build a higher index before a lower reserved one is committed.** Drizzle orders by `when`, and a higher-index file applied first can leave the lower one silently skipped (DEF-039's failure mode). Reservations: **0184 = T-316, 0185 = T-375 S4.** Journal head after T-367 S5 is
0182, `when` 1801798307084 → **0183 `when` = 1801884707084**. 0185's `when` is re-derived by the builder from the journal head at build time (ADR-012 §5 step 5).
Both are gated on the FULL integration suite on a fresh gate DB, tree frozen while it runs. Both need a production
read-only precheck run **before the push** (bible row 278).
**Merging and go-live (✎V2b):** every slice merges to `main` normally; nothing changes for a store until it is LINKED.
Linking a store on production is the go-live act, done with Ian, store by store, after Q1 (the key) and S0 pass for it.
**Bible:** rows 269–271 and ADR-015 §3 already record every ruling this task builds. This spec amends neither.

## Goal
For every store linked to POS, a sales day is a closing DERIVED from what POS v1 reported, never a set of typed figures
(bible row 270, DEF-586):
- the day's figures come from a stored, immutable copy of POS's response (the **day feed**), and nothing else;
- a POS payment method the ERP does not know refuses the import (tenders fail closed);
- the database refuses a figure write on a linked store's day unless the derivation made it (✎V5 states the limit),
  and a linked store's new day must name its feed;
- platform sales (Foodpanda, Grab) stay a separate typed entry outside the locked figures, behind one small seam
  (row 271 q1 (b));
- the usage pull reads the stored POS snapshot, never a live call;
- a POS change after verify becomes a finding, and a manager posts a correcting entry in an open month (q3 (a));
- if POS cannot be reached, the day waits; there is no manual fallback (q4 (a)).

A store NOT yet linked keeps today's typed path, labelled "not linked to POS" (✎V2b); that is DEF-586's remaining
exposure until every store is linked. The feed is interim. It retires per store at P2, when that store's receipts reach
Postgres (ADR-015 §2). Nothing else built here is torn out then (ADR-015 §7).

## v1 as requirements (§1.2d)

### How v1 ERP reads POS today: over HTTP, never Firestore
- **v1 ERP never reads POS's Firestore.** It calls POS's key-scoped REST bridge: `GET {POS_API_URL}/api/external/sales?
  storeId=&date=` with `x-api-key` (`ERP-rebuild/src/lib/server/pos-api.ts:143-168`). POS validates the key against
  `POS_EXTERNAL_API_KEY` or a per-consumer, per-store map `POS_EXTERNAL_API_KEYS_JSON`
  (`POS/src/lib/server/external-auth.ts:29-72`). Discovery 12 §7 has the full contract.
- **POS reads ONE Firestore doc for the day:** `stores/{posStoreId}/analytics/{yyyymmdd}` (`POS/src/app/api/external/sales/
  route.ts:21-26`). The response fields (`:78-98`):
  - `totalSales` ← `payments.totalGross` (`:42`). ✎ **This is NOT gross food sales.** It sums each receipt's `total`
    (`POS/src/lib/analytics/daily.ts:160-169`), and a receipt's `total` is the amount due
    (`POS/src/components/cashier/firestore.ts:658`): `grandTotal = subtotal − discounts (+ VAT if exclusive) + charges`
    (`POS/src/lib/tax.ts:182,214`). So the field is what customers PAID.
  - the package-only figure (the glossary's ⚠️ trap name) ← `sales.dineInSalesGross`, else a fallback sum (`:46-52`,
    DEF-061: gross or net, and nothing says which).
  - `paymentsByMethod` ← `payments.byMethod`, keyed by the POS payment-method NAME (`:43, :90`). Cash is already net of
    change (`firestore.ts:642`), so the methods sum to what was paid.
  - `discountsTotal`, `chargesTotal` (one figure each, `:91-92`); the voided-receipt cash field (`:95`); counts.
  - `found: false` when the analytics doc does not exist (`:28-35`).
  - Values are JSON floats (POS sums floats, DEF-003).
- The payment-method list: `stores/{posStoreId}/storeModesOfPayment` (name, not archived) plus any method seen in the
  last 14 analytics days (`POS/src/app/api/external/payment-methods/route.ts:23-41`).
- Sold items: `GET /api/external/sold-items` aggregates `stores/{posStoreId}/receipts` per item (`sold-items/route.ts:44-101`);
  `found` is false on a day with no receipts.

### v1's mapping (`ERP-rebuild/src/lib/financial/posSalesPull.ts`)
- **The store link is a hand-set `posStoreId` on the ERP store** (`src/components/admin/PosIntegrationSection.tsx:85`),
  with a per-store `posPaymentMethodMap` (method name → account id, or a cash sentinel, `:137`).
- The WHOLE `totalSales` goes to one sales channel: the store's `posSalesChannelId`, else the first channel whose name
  contains "dine" (`:243-251`). A name match is DEF-059's failure shape.
- Methods resolve by (1) the stored map, (2) a cash-name whitelist, (3) an exact normalized NAME match against the
  store's cashier accounts (`:80-133`). Normalization: lowercase, strip every non-alphanumeric, which also undoes POS's
  `safeKey` substitutions (`:42-44`). Unroutable methods are reported as "gaps", not refused (`:255-262`).
- A ₱1 tolerance on "methods sum to total" (`:316-337`); the result is a diagnostic only.
- The form is then editable by hand (`SalesReportForm.tsx:556-627`): v1 pre-fills and lets staff overwrite.
- v1 books POS `totalSales` (net, charges included) as the channel's revenue; the charges and discounts are display
  figures only (`totalChargeCollected`, `totalDiscountsGiven`).

**The goal v1 serves:** the books carry exactly what the till took, per store per day, with each payment method landing
in the right custody (drawer cash vs a named wallet), without retyping. **v2 beats it:** the figures are not editable
at all; a method nobody mapped refuses instead of becoming a gap; no name matching; the source document is kept; the
revenue is posted gross with discounts and charges on their own lines (T-123, Ian 2026-08-25, `routing.ts:26-31`).

### ✎ Not v1: Firebase projects and credentials
- POS (and CUSTOMER) run on `shareat-hub-v2`; v1 ERP on `studio-7300228488-a394e` (`docs/CROSS-APP-MAP.md:51-60`;
  `.env.example:182-183`). **POS is not on v1 ERP's project.**
- `scripts/capture.ts` reads v1 ERP's Firestore (`createErpFirestoreClient`, `packages/etl-firestore/src/client.ts:51`).
  A hub key exists only as `CAPTURE_HUB_SA_KEY_FILE`, marked **LOCAL ONLY — never in a deployed environment**
  (`.env.example:176-185`). Reading POS's Firestore from production would need a full Admin credential to
  `shareat-hub-v2` (discovery 12 §7: a strictly larger blast radius than the API key). **Rejected**, as the proposal
  §11 already rejects it.
- **So production reads POS the way v1 does: the HTTP bridge with `POS_API_URL` / `POS_API_KEY`**, which v2 already
  declares (`packages/core/src/env.ts:112-119`, optional). Whether production holds a key is not recorded anywhere in
  this repo (`docs/ops/README.md` names neither variable). **Q1 for Ian.**

## Census, verified at source (corrections marked ✎)

### The typed path today (DEF-586)
- `createSalesDay` (`packages/domain/src/sales-days/create.ts:121`) authorizes `submit_sales_day` (`:131`), runs the
  create-block (`:133-210`), parses twelve typed figures (`:214`, `parseSalesDayFigures` `:388-423`) and the checkbox
  (`:218`, stored with `new Date()` at `:225`), then writes channels and tenders (`:241-246`).
- `editSalesDay` (`sales-days/edit.ts:30`) rewrites figures, channels, tenders and the flag (`:51-83`), audited (`:90-99`).
- Screens: `SalesDayForm.tsx` (figure inputs `:80-126`, checkbox `:238`), shared by `/sales-days/new` and
  `/sales-days/[id]/edit`; the action reads the checkbox at `actions.ts:74`; the day page links "Edit this day"
  (`[id]/page.tsx:244-250`).
- **The only writers of `sales_days` figures, channels and tenders are `create.ts` and `edit.ts`** (grep of
  `insertSalesDay|updateDraft|replaceChannels|replaceTenders` outside tests). ETL and seeds write none.
- The flag pair: `pos_sourced`, `pos_sourced_at` (`schema/sales-days.ts:197-198`) and their pair CHECK (`:299-302`).
  `salesDayUnposted` reads `pos_sourced = true` (`repo/findings.ts:1968`).
- Verify routes `sales_days` columns + channel rows + tender rows (`verify.ts:93-118`) through `routeSalesDay`, which
  enforces three identities: revenue split (`routing.ts:170-178`), channels = total (`:189-200`), and collected +
  discounts + comps = gross + service charge + other charges (`:235-255`).

### ✎N1 (new, section E, for the orchestrator to number): v2 calls POS with its OWN store uuid
- `fetchPosSoldItemsLive` (`packages/domain/src/pos/usage-pull.ts:70-71`) and `fetchPosSalesLive`
  (`pos/sales-pull.ts:31-32`) put the v2 `stores.id` (a uuidv7) in `?storeId=`. POS keys stores by its own Firestore id.
- v2 has no store link: no `posStoreId` counterpart anywhere in `packages/db/schema` (grep). Discovery 23:141 noted
  "`posStoreId` disappears" when the two store records merge, but that merge is P1; today two records still exist.
- Effect: with the global POS key, POS returns `found: false` for an unknown id, so **the T-177 usage pull plans an empty
  day** (`usage-pull.ts:79`) and the T-210 screen says "No POS analytics" for every store. Silent, not a crash.
  (With a store-scoped key, POS answers 403.)
- Fixed here by the store link (S1) and by every fetch taking the POS store id from it (S1, S5).

### What the payload can and cannot give (drives the derivation, R4)
- Has: paid total, package-only sales, ONE discount total, ONE charge total, per-method paid amounts, voided-receipt cash.
- Does not have: senior vs PWD vs other discounts (pos-q2 (a): one 4900 line); service charge vs other charges (Q2);
  comps (POS excludes comped quantity from line gross; comps are not in the paid total); the VAT removed on a VAT-exempt
  (SC/PWD) bill, which is in neither discounts nor charges (`tax.ts:135-153`) — see Risk K3.
- Contains two glossary trap names on the wire. `tests/unit/glossary-trap-names.test.ts` fails on any v2 source naming
  them outside `ALLOWED_PREFIXES` (`:44-57`). R12 confines them to one directory.

### Tests that touch sales days today (under ✎V2b only the linked-store ones change; see the note below)
- Call `createSalesDay` with typed figures (19): `apps/erp/tests/integration/{t343-s5-5m-money-labels,t369-s3-sales-day-web,
  t369-s7-audit-web,t373-s1-pos-usage-picker,t374-s7-pos-usage-void-action}.test.ts`, `apps/erp/tests/{t339-sales-day-new-
  store-picker,t343-s5-action-guard}.test.ts`, `packages/domain/tests/integration/{pos-day-reconciliation,pos-usage-pull,
  sales-days,sales-rollup,t369-s3-sales-day-edit-void,t369-s7-audit-reentry,t369-s7-voided-date-reentry,
  t372-receipt-discrepancy,t373-s1-voided-day-writers,t374-s4-wastage-date,t374-s7-void-pos-usage-pull}.test.ts`,
  `tests/unit/domain-actions-have-callers.test.ts` (names `createSalesDay`/`editSalesDay` at `:105,:116`).
- Pin the edit path: `t369-s3-sales-day-edit-void.test.ts` (domain), `t369-s3-sales-day-web.test.ts` (edit page and
  action), `oil-wave-2.test.ts` (sets `posSourced`).
- Insert `sales_days` by raw SQL or `insertSalesDay` (18): `apps/erp/tests/integration/{constraint-message-lookup,
  t343-s5-5s-followups,t343-s5-5v-followups,t373-s4-remittance-loader}.test.ts`, `packages/db/tests/integration/
  {t346-migrations,t369-s7-migration,t374-s7-pull-void-shape}.test.ts`, `packages/domain/tests/integration/{channel-settlements,
  oil-wave-2,order-wastage,remittance,sales-channels-admin,t346-opening-readers,t346-store-opening-date,
  t366-s1-cash-custody-locks,t366-s2-variance-charge,t366-s3-overage-income,t373-s4-reversed-remittance-variance,
  wastage-monitor}.test.ts` (plus the two above that also call `createSalesDay`).
- Live POS fetchers: `pos-usage-pull.test.ts` (injects `fetchSnapshot`), `pos-day-reconciliation.test.ts`.

**Census note (✎V2b):** the test lists above are the files that TOUCH sales days. Under ✎V2b only the tests that link a
store change their setup; the tester re-reads the list and reports which files changed.

### ✎V1 / ✎W1 — what POS does with a refund (verified at source)
- `createRefundReceipt` (`POS/src/components/cashier/firestore.ts:1451-1524`) writes a receipt with `isRefund: true`,
  `parentReceiptId`, `total: −refundTotal`, `totalPaid`, and `sessionMode` copied from the parent (`:1470-1494`,
  `:1475`). It writes **no `analytics` block and no payments.** The dialog splits the refund across the parent's
  `analytics.mop` in proportion (`POS/src/components/receipts/RefundReceiptDialog.tsx:91-96`), but only the sum reaches
  the receipt. **No POS record says which method a refund went out of.**
- `refundTotal` is line gross, ignoring the parent's discounts (`firestore.ts:1463-1466`).
- In the day doc, `getPaymentContribution` adds the negative `total` to `totalGross` and nothing to `byMethod`
  (`POS/src/lib/analytics/daily.ts:151-170`). `getSalesContribution` has **no refund branch** (`daily.ts:243-320`; the
  only `isRefund` test is the item-stats one at `:603`): a refunded package or add-on line on a dine-in session ADDS to
  the package-only figure at full value.
- Change of one centavo or less is not taken out of the cash method (`firestore.ts:629`, `changeCents > 1`), so a day's
  methods can exceed its paid total by up to ₱0.01 per receipt with no refund at all (✎W11).

**POS defects for the orchestrator to log (`reported`, P0 fixes in the copy, row 272):** (i) a refund receipt records no
payment methods; (ii) refund lines add positively to package and add-on sales; (iii) a refund's amount ignores the
parent's discounts.

## Rulings (planner)
- **R1. Structures.** Names are glossary-checked; "receipt" is not used.
  - `pos_v1_store_links`: one row per linked v2 store: `org_id`, `store_id`, `pos_store_id` (POS's Firestore store id),
    `pos_store_name` (display), `sales_channel_id` (the channel POS's sales land in; this store's, remitted daily),
    `pos_tax_type` (`vat_inclusive` | `vat_exclusive` | `non_vat`, NOT NULL, copied by the admin from POS's store
    settings, ✎V9), `created_at/by`, `updated_at/by`. Never deleted (no DELETE grant); `store_id` never changes (0185
    trigger). **Its existence is the per-store switch (✎V2b).**
  - `pos_v1_day_feeds`: the source document, one row per HTTP response: `org_id`, `store_id`, `business_date`,
    `kind` (`sales` | `sold_items`), `purpose` (`import` | `recheck` | `usage`), `batch_id` (the rows captured together),
    `pos_store_id` (the POS id actually called, ✎W9), `body` (exact response text), `payload` (jsonb of `body`),
    `content_hash` (sha256 hex of `body`), `fetched_at`, `fetched_by`. **Append-only** (trigger refuses UPDATE and
    DELETE; precedent `0009`). No dedupe: each fetch is a fact. An `import` or `recheck` batch always holds BOTH kinds
    (✎V11); a `usage` batch holds `sold_items` only.
  - `tenders`: the tender master the till will sell against at P1 (ADR-015 §7). Store-scoped: `name`, `kind`
    (`cash` | `wallet`), `money_account_id` (required iff `wallet`; same org by composite FK as `0171`; same store by
    the domain, as `writeTenders` does, `create.ts:339-352`), `pos_v1_alias` (nullable; dropped at P2), `is_active`.
  - `sales_day_pos_corrections`: `org_id`, `store_id`, `sales_day_id`, `from_feed_id` (the basis at the time),
    `to_feed_id`, `entry_date`, `journal_entry_id`, `reason`, `posted_by`, `posted_at`. Append-only.
  - On existing tables: `sales_days.source` (`legacy_typed` | `pos_v1_day_feed`, NOT NULL DEFAULT `legacy_typed`,
    kept by 0185, ✎V2b), `sales_days.pos_v1_day_feed_id` (the `sales` feed of the import), **`sales_days.refunds`
    (numeric(14,2) NOT NULL DEFAULT 0, ≥ 0, finite; posts to 4950, ✎W11)**; `pos_usage_pulls.pos_v1_day_feed_id`
    (the `sold_items` feed a pull is pinned to). Every feed reference is one nullable column named
    `pos_v1_day_feed_id`; retiring the feed is "stop writing, keep the frozen rows".
  - **P2 maps 1:1:** `source` gains `pos_receipts` by its own migration then; the derivation's inputs map to receipt
    aggregates as in R4's table.
- **R2. 0183 is structure only; 0185 is enforcement.** 0183 adds the four tables and the columns, CHECKs included.
  0185 adds the link-aware triggers (R6). Every commit between S1 and S4 stays green; no default is dropped (✎V2b).
- **R3. Tender mapping fails closed, by explicit alias only.** A POS method resolves to the store's ACTIVE tender whose
  normalized alias equals the method's normalized name (v1's normalization: lowercase, strip `[^a-z0-9]`). No name
  matching, no cash whitelist, no gaps. An unresolved method with a non-zero amount refuses the import; a zero-amount
  method is ignored; a negative method total refuses; methods resolving to one tender are summed. Unique normalized
  alias among a store's ACTIVE tenders (expression index, hand-added in 0183, with the schema `// NOTE`).
- **R4. The derivation, from one `sales` payload (pure, no I/O).** Each JSON number `x` becomes integer centavos
  `c = round(x × 100)`, accepted only if `|x × 100 − c| ≤ 0.001` and `x ≥ 0` (method totals: R3); otherwise refused by
  field. After that, only `@shareat/core/money`. Names below: P = paid total, D = discounts, C = charges,
  K = package-only figure, M = Σ method totals, N = the receipt count (`totalSessions`).

  | v2 figure | From the feed | At P2, from receipts |
  |---|---|---|
  | difference `X = M − P` | `X < 0` refuses (methods short of the total) | — |
  | rounding vs refunds (✎W11) | `X ≤ ₱0.01 × N` → rounding: `refunds` = 0 and X is added to `other_charges` (cash kept, 4500); else `refunds` = X | refund documents |
  | `refunds` (4950, ✎V1/✎W11) | as above | Σ refund receipts |
  | `cash_collected` | Σ cash-tender methods − `refunds` (refuse if negative; Q3 default (a)) | Σ cash payments net of cash refunds |
  | `online_collected` + `sales_day_tenders` | Σ wallet-tender methods, one row per money account | Σ payments per tender |
  | `other_discount` | D (q2 (a); senior/PWD stay 0) | per discount type (row 218) |
  | `other_charges` | C (+ rounding X) (Q2 default) | per charge type |
  | `total_sales` (gross, before refunds) | P + D − C + `refunds` (+ rounding X is NOT added: it sits in charges) | Σ line gross |
  | `unli_sales` | `min(K, total_sales)` (✎W1 cap) | Σ package line gross |
  | `ala_carte_sales` | `total_sales − unli_sales` (never the POS residual field) | Σ other line gross |
  | `comps`, `service_charge`, `senior_discount`, `pwd_discount`, `credit_sales` | 0 | per type |
  | channel row (the link's channel) | `total_sales` | per channel |

  - **Rounding band limit (✎Y-minor):** on a day with many receipts, `₱0.01 × N` can swallow a genuine small refund
    (e.g. a ₱1.50 refund on a 300-receipt day): it is booked to 4500 as rounding and the till reads short by it. POS's
    refund count is not on the bridge, so S0 reports the days with `0 < X ≤ ₱0.01 × N` separately (its count (r)),
    with their largest X, so the size of this blind spot is known before a store is linked.
  - With rounding: cash + online = M = P + X; collected + D + refunds(0) = P + X + D = gross (P + D − C) + C + X ✓.
    With refunds: cash + online = M − X = P; P + D + X = gross (P + D − C + X) + C ✓. Check 1 (split) and 1b (channels)
    hold by construction. `routeSalesDay` gains `refunds` on the collected side and a `Dr 4950` line memo *"refunds
    (POS)"* (S3, `routing.ts`); a legacy day has `refunds = 0`, so its routing is unchanged.
  - **✎W1 cap:** when K > `total_sales` (refunded package lines counted positive by POS, or VAT removed on SC/PWD bills,
    K3), `unli_sales` = `total_sales` and à la carte = 0. The day page shows *"POS's package figure was ₱e higher than
    the day's sales; the difference is not booked."* (computed from the feed's payload against `unli_sales`; no column).
    The total, the tenders and the discount line are unaffected.
  - **Refusals, before anything is written:** `found` false; X < 0; refunds > cash methods; a `vat_exclusive` link (✎V9);
    a non-centavo or negative value; an unresolved method (R3).
  - The voided-receipt cash figure stays in the feed and is not derived (DEF-161 keeps `2900` reserved).
- **R5. `importSalesDay(tx, actor, { storeId, businessDate }, fetchers?)`** is the only way a LINKED store gets or
  changes a sales day. Order: `authorize('submit_sales_day', store)` → read the link (unlinked → refuse) → read active
  tenders → **fetch both kinds over HTTP, holding no lock** (T-373 R2) → derive (pure; refuse) → lock the live day
  `FOR UPDATE` if one exists, then:
  - none (or only voided days on the date): the create-block, moved unchanged from `create.ts:133-210` into a shared
    helper both paths call (a voided date still needs `void_sales_day`, row 270 "re-IMPORT, never re-type"); insert the
    batch (`purpose = 'import'`) and the day (`source = 'pos_v1_day_feed'`, `pos_sourced = true`,
    `pos_sourced_at = fetched_at`), the link's channel row and the tender rows;
  - `open` / `submitted`, feed-sourced: re-import (a `submitted` day also needs `verify_sales_day`, as `edit.ts:40`):
    insert the new batch; replace the figures, the REMITTED channel rows and the tender rows; keep status and platform
    rows; audit `reimport_sales_day` (before/after figures, both feed ids);
  - `open` / `submitted`, `legacy_typed`: refuse. **Unreachable in practice:** a store cannot be linked while it has
    such a day (✎W6). Kept as a defensive refusal: *"This day was typed in before the store was linked to POS. Ask the
    office."*
  - `verified`: refuse; a later change is S6's finding.
  - Every figure, channel and tender write goes through `withSalesDayDerivation(tx, fn)` (R6).
  - The prior-7-days recheck is NOT part of this function (✎V4, R10).
- **R6. The lock, in the database (0185), per store (✎V2b).**
  - **The flag.** `withSalesDayDerivation(tx, fn)` runs `select set_config('app.sales_day_derivation', 'on', true)`,
    awaits `fn`, then sets it `off` **on success only** (✎W4). On an error the transaction is already aborted
    (a further statement would raise 25P02 and hide the real constraint name) and the rollback discards the flag, so
    nothing is reset there. Transaction-local, like `app.reversal_posting` (`repo/journal.ts:410`).
  - **How the database knows a store is linked.** Each trigger looks up `pos_v1_store_links` for the row's store, as
    the invoker, under RLS. **No `SECURITY DEFINER`** (✎W2, reason corrected ✎Y1): the owner (`doadmin` on production,
    `postgres` locally) has `rolbypassrls` / `rolsuper` (`0171:41`, `docs/ops/README.md`), so a definer function would
    see EVERY org's links; the invoker lookup stays scoped to the caller's org, and 0162's no-definer precedent holds.
    The lookup is trustworthy because the row being written must itself pass RLS for the same org
    (`org_id = app_current_org()`), so a caller who can write the store's day can see the store's link. **Fail closed
    on a missing context (defence in depth, ✎Y3):** if `app_current_org()` is NULL and the session's role is neither
    superuser nor BYPASSRLS (`select coalesce(rolsuper or rolbypassrls, false) from pg_roles where rolname =
    current_user`, the `cutover/purge.ts:321` precedent, ✎Y2), the trigger refuses the write
    (`sales_days_figures_locked`). In practice RLS already stops such a session first (an INSERT fails its WITH CHECK;
    an UPDATE sees no rows, so the trigger never fires); the guard exists for a future policy change. A superuser or
    BYPASSRLS session sees every link, so its answer is right too.
  - `sales_days` BEFORE INSERT: linked store → refuse unless the flag is `on` AND `source = 'pos_v1_day_feed'`.
    Unlinked store → refuse `source = 'pos_v1_day_feed'` (a feed day needs a link); allow `legacy_typed`.
  - `sales_days` BEFORE UPDATE, when any protected column changes (`store_id, business_date, source,
    pos_v1_day_feed_id, pos_sourced, pos_sourced_at`, the twelve figures and `refunds`): a feed day needs the flag AND
    `OLD.status in ('open','submitted')`; a `legacy_typed` day is writable only while its store is UNLINKED; `source`
    never changes on an existing row. Status, sign-off and journal columns stay writable (submit, verify, void).
  - `sales_day_tenders`, and `sales_day_channels` rows whose channel is remitted daily (INSERT/UPDATE/DELETE): on a feed
    day they need the flag; on a typed day they need the store unlinked. Non-remitted (platform) rows: their day must be
    `open` or `submitted` (R8).
  - `pos_v1_store_links` BEFORE UPDATE: refuse a change of `store_id`.
  - Raised as `ERRCODE '23514'` with `CONSTRAINT 'sales_days_figures_locked'` (`…_tenders_locked`,
    `…_channels_locked`, `pos_v1_store_links_store_fixed`), mapped in `apps/erp/src/lib/constraint-messages.ts` to
    *"Sales figures for this store come only from POS and can't be changed here. A wrong sale is refunded on the POS."*
  - CHECKs (0183): `source in ('legacy_typed','pos_v1_day_feed')`; `(source = 'pos_v1_day_feed') =
    (pos_v1_day_feed_id is not null)`; `source <> 'pos_v1_day_feed' or pos_sourced`; `source = 'pos_v1_day_feed' or
    refunds = 0`; `refunds >= 0` and finite.
  - **What the lock is (✎V5):** the database refuses every figure write on a linked store's day made without the flag.
    `shareat_app` can set the flag itself (`set_config` is not privileged), so the lock stops mistakes and every
    ordinary path, not a hostile query on the app's own connection; guard G1 and review cover that remainder.
  - TRUNCATE (the cutover purge, `cutover/purge.ts:353`) fires no row trigger. No purge change.
- **R7. Capabilities: none new.** Import `submit_sales_day` (+ `verify_sales_day` on a submitted day, + `void_sales_day`
  on a voided date). Store link and tenders: `manage_chart_of_accounts` (admin, super admin): the mapping decides where
  money is booked and whose custody it is, so a manager, whose custody is measured, does not set it (the
  `set_cash_policy` reasoning, CAPABILITY-MATRIX:153). Route `/settings/pos-link` → `manage_chart_of_accounts` in
  `apps/erp/src/lib/route-capability.ts`. Platform sales: as `editSalesDay` today (`submit_sales_day` open,
  `verify_sales_day` submitted). Recheck and correction: `verify_sales_day`.
- **R8. Platform sales: typed, separate, one removable seam (q1 (b)).** They are `sales_day_channels` rows for the
  store's NON-remitted channels, which T-150's queue already reads (`repo/channel-settlements.ts:311-347`).
  - Written on a feed day only by `setPlatformSales(tx, actor, { salesDayId, rows: { channelId, amount, noSales }[] })`:
    day `FOR UPDATE`, open/submitted only, refuses a remitted channel, audited `set_platform_sales`.
  - At verify and in R10, `routeInputForDay(day, channels, tenders)` (`sales-days/compose.ts`) adds the platform total
    to `totalSales` and `alaCarteSales` **only when `source = 'pos_v1_day_feed'`** (platform orders are take-out,
    always à la carte, 4150; the receivable is `1220`, ✎V10). Legacy days route exactly as today.
  - **Removing it** when Ian rings platforms through POS: delete `setPlatformSales`, the screen section and the two
    lines in `compose.ts`; the trigger's non-remitted branch becomes "needs the flag".
- **R9. Usage reads stored sold items (✎V11, ✎W5).**
  - `buildPlan` reads the day's LATEST stored `sold_items` feed (any purpose) and pins it on the pull. A day with none
    (a `legacy_typed` day of a linked store, or a feed day captured before S5) captures one through `fetchPosV1Day`
    with the link's `pos_store_id` (`purpose = 'usage'`, fetched before any lock) and pins it. An unlinked store →
    refused (*"{Store} isn't linked to a POS store yet, so its usage can't be pulled. An admin links it under Settings ›
    POS link."*).
  - `finalizeSections` re-reads the pinned feed, never HTTP. It refuses only when a NEWER `sold_items` feed for the day
    differs from the pinned one in the **items projection** (item key → physical quantity), not merely by being newer:
    *"POS's sold items for {d MMM YYYY} changed after this plan was built. Build the plan again."* `SNAPSHOT_MAX_AGE_MS`
    and PLAN_CHANGED stay (they guard mapping changes).
- **R10. Drift after verify, rechecks, and the correction (q3 (a)).**
  - **Basis feed** of a day = the `to_feed_id` of its latest correction, else `pos_v1_day_feed_id`.
  - **Rechecks are captured outside any import transaction (✎V4):** the **Check POS again** button
    (`recheckPosDay(actor, { salesDayId }, fetchers)`) and the automatic `recheckRecentDays(actor, storeId, beforeDate,
    fetchers)`, which the import's server action calls AFTER the import commits (the store's verified feed days in the
    7 days before D; planner's choice, since POS voids and closed-receipt edits change past days). Both take no `tx`:
    one short transaction to authorize and read, then the fetches with no transaction open, then one short transaction
    writing every batch (both kinds, `purpose = 'recheck'`). A failure is logged and never reaches the import's result.
  - **Rechecks and corrections call POS with the basis feed's stored `pos_store_id`** (✎W9), not the link's current
    one, so relinking a store never redirects an old day.
  - **Finding `posDayFeedDrift`:** a verified feed day whose latest `sales` feed is newer than its basis and differs in
    the MONEY projection (P, K, D, C, the methods map), not merely the hash. Key `posDayFeedDrift:{salesDayId}`, hard.
  - **Finding `posDaySoldItemsDrift`:** a pull with ANY finalized section (✎S5L-R; status `finalized`, or `planned` with a
    section stamped) whose pinned feed is older than a `sold_items` feed for the day
    that differs in the items projection. Fixed by voiding the pull and pulling again (T-374 S7), never by a correction.
  - **Correction** `postPosCorrection(tx, actor, { salesDayId, feedId, entryDate, reason })`: `authorize
    ('verify_sales_day')`; day `FOR UPDATE`; verified and feed-sourced; the feed is this day's `sales` feed, newer
    than the basis, not already corrected to. **Old = what was POSTED** (✎V7): the net per (account, party) of the day's
    entry plus its prior correction entries, from `journal_lines`. **New** = R4 on the feed (current tenders), composed
    with the current platform rows (R8), routed. Delta = new − old; all-zero → refused. `entryDate ≥ businessDate`, in
    an open month (`postEntry`'s closed-period refusal). Posted `sourceType 'sale'`, `sourceId` = the correction id,
    idempotency `sales_day:{dayId}:pos_correction:{feedId}`. The day's own figures never change.
  - **Voiding a corrected day (✎V3):** `voidSalesDay` reverses the day's entry and then every correction entry of the
    day, newest first, through `reverseEntry`, in the same transaction. A reversal keeps `sourceType 'sale'` and the
    correction's `sourceId` (`reverse-entry.ts:188-197`).
- **R11. No schedule.** The import stays a button (T-123 Open 1).
- **R12. Trap names live in one place.** `packages/db/src/pos-v1/` holds the wire field names (`wire.ts`) and the test
  payload builder (`fixtures.ts`); it is added to `ALLOWED_PREFIXES` in `glossary-trap-names.test.ts` with the ETL's
  reason. Every other file reads fields through `POS_V1_SALES_FIELDS` / `POS_V1_SOLD_ITEMS_FIELDS`. The POS residual
  field is never read.
- **R13. The switch, linking, and the race (✎V2b, ✎W6, ✎W7).**
  - An UNLINKED store keeps `createSalesDay` / `editSalesDay` with typed figures (`source = 'legacy_typed'`,
    `pos_sourced` always false: the "From POS" checkbox is removed for everyone). The day page and the list show
    **"Typed — store not linked to POS"**. The board counts unlinked active stores as DEF-586's remaining exposure.
  - A LINKED store: typed create and edit refuse (*"{Store} takes its sales from POS. Import the day instead."*), and
    the trigger refuses anything else.
  - `linkStoreToPos` takes the store row `FOR UPDATE`, then refuses while the store has any `open` or `submitted`
    `legacy_typed` day: *"{Store} still has typed sales days that aren't verified ({dates}). Verify or withdraw them
    before linking it to POS."* So no typed day is left half-way on a linked store (the withdraw dead end at
    `verify.ts:213` cannot arise).
  - `createSalesDay` and `editSalesDay` take the store row `FOR KEY SHARE` right after `authorize()`, then read the link.
    A typed create and a link of the same store therefore serialize (FOR UPDATE conflicts with FOR KEY SHARE): either
    the typed day commits first and the link then refuses it, or the link commits first and the typed create refuses.
    **Why the trigger cannot backstop this (✎Y4):** without the lock, A reads "no link", B links (holding the store
    `FOR UPDATE`, uncommitted), A's BEFORE INSERT trigger also sees no link, A's FK check then waits for B, B's
    open-typed-day check never saw A's uncommitted day, and both commit: a typed open day on a linked store. **The lock
    is defence in depth with no killing mutant:** the INSERT's own FK check takes KEY SHARE too, but only after the
    link read, and no test can reliably pause A between its link read and its insert without a production test seam,
    which this spec does not add. L5 proves the behaviour; review proves the lock is first.
- **R14. Reports keep reconciling (✎V8, ✎W8).** `getSalesByChannelAndMode` (`repo/reports.ts:376-421`):
  - modes: à la carte adds Σ non-remitted channel amounts on feed-sourced days; and, for the range, the 4100 and 4150
    net of every `source_type = 'sale'` entry whose `source_id` is a `sales_day_pos_corrections.id` (this picks up
    corrections AND their reversals, since a reversal keeps the source id) is added to the two modes;
  - channels: the same correction total as one synthetic line "POS corrections" (`channelId` null);
  - refunds: they post to 4950, outside 4100/4150, so they do not enter either side.
  - `getSalesRollup` (`domain/src/reports/sales-rollup.ts:85`) then reconciles on platform days, corrected periods and
    voided corrected days.

## Parallel plan
| Slice | What | Files (BUILDER) | Shared state | Order |
|---|---|---|---|---|
| S0 | census of live POS data | `scripts/pos-v1-feed-census.ts` | read-only HTTP | needs Q1; before any production link |
| S1 | 0183, fetcher, store link, channel guard | migration 0183, `_journal.json`, `db/schema/{pos-v1,sales-days,pos-mapping,index}.ts`, `db/src/repo/pos-v1.ts`, `db/src/pos-v1/{wire,fixtures}.ts`, `db/src/{index,cutover/classification,rls/registry}.ts`, `domain/src/pos/{v1-feed,store-link}.ts`, `domain/src/sales-channels/index.ts`, `apps/erp/src/app/settings/pos-link/*`, `route-capability.ts`, `glossary-trap-names.test.ts`, `docs/GLOSSARY.md` | journal | first |
| S2 | tender master + resolver | `domain/src/pos/{tenders,v1-methods}.ts`, `db/src/repo/pos-v1.ts` (tender fns), `settings/pos-link/*` | `tenders` | after S1 |
| S3 | derivation, import, typed path gated, fake POS | `domain/src/pos/v1-derive.ts`, `domain/src/sales-days/{import,create,edit,create-block,routing,index}.ts`, `db/src/repo/sales-days.ts`, `apps/erp/src/app/sales-days/{actions.ts,new/page.tsx,[id]/page.tsx,SalesDayForm.tsx,[id]/edit/page.tsx}`, `apps/erp/src/app/api/dev/fake-pos/**`, `apps/erp/dev-fixtures/pos-v1/**` (the TESTER owns `_fixtures/pos-day.ts`, ✎Y-minor) | `sales_days`, feeds | after S2 |
| S4 | 0185 link-aware lock, platform seam, report modes | migration 0185, `_journal.json`, `domain/src/sales-days/{verify,compose,platform}.ts`, `db/src/repo/reports.ts`, `apps/erp/src/app/sales-days/[id]/page.tsx`, `constraint-messages.ts` | `sales_days` + children; journal | after S3 |
| S5 | usage from stored sold items | `domain/src/pos/usage-pull.ts`, `db/src/repo/pos-mapping.ts`, `apps/erp/src/app/inventory/pos-usage/*` | `pos_usage_pulls` | after S3; parallel with S4 (file-disjoint; frozen during S4's full-suite gate) |
| S6 | rechecks, drift findings, correction, corrected-day void, T-210 | `domain/src/pos/v1-recheck.ts`, `domain/src/sales-days/{correction,verify}.ts`, `domain/src/reports/pos-day-reconciliation.ts`, `domain/src/pos/sales-pull.ts` (deleted), `db/src/repo/{findings,reports}.ts`, `domain/src/findings/index.ts`, `apps/erp/src/app/reports/pos-reconciliation/page.tsx`, `components/reports/PosReconciliationCard.tsx`, `apps/erp/src/app/sales-days/{actions.ts,[id]/page.tsx}`, `docs/POSTING-PATTERNS.md` | ledger, corrections | after S4 and S5 |

- Every slice merges to `main` normally (✎V2b). Production go-live is linking a store, not a merge.
- S3, S4 and S6 all touch `sales-days/[id]/page.tsx` or `actions.ts`: sequential.
- Only S1 and S4 touch the journal. Each runs its FULL-suite gate on a fresh gate DB with every other lane frozen.
- Each lane has its own lane DB (§3.4 row 94).

## Invariants (every slice)
- I1. `authorize()` before any read-for-write, lock, fetch, parse sentence or business refusal (T-364). The ✗ is proven.
- I2. No new capability (R7). Every ✅ used has a test proving the ✗ fires.
- I3. The database enforces the lock and the shapes (R6). The domain refuses earlier with a sentence (R13) but never
  stands in for the trigger.
- I4. No lock or transaction is held across HTTP (T-373 R2; ✎V4 for rechecks).
- I5. Fail closed: an unlinked store (for import and usage), an unmapped method, `found` false, X < 0, refunds above
  cash, a `vat_exclusive` link, POS unreachable or not configured → a sentence, and **nothing** written (no feed row).
- I6. Feed rows and correction rows are never updated or deleted.
- I7. Money: one float → centavo conversion at the wire (R4); `@shareat/core/money` after it; SQL `numeric`.
- I8. Sentences via `refuse(raw, sentence)`; no ids, no column names; dates via `humanDate`; Manila dates
  (`toBusinessDate`). `tests/unit/t343-throw-ratchet.test.ts` keeps `packages/domain/src/sales-days` at 0 bare throws.
- I9. **On a linked store** no figure is typed: no screen offers a figure input, and nothing outside
  `withSalesDayDerivation` writes one (G1, S3; trigger, S4). **On an unlinked store** the typed path stays, labelled.
- I10. A store's switch is its link row, nothing else (no flag column, no env var).

---

## S0: census of live POS data (read-only; before any production link)
**Why:** R4's refusals and caps are right only if they rarely fire. T-367 S0 is the precedent.
**BUILDER:** `scripts/pos-v1-feed-census.ts`: for `--pos-store <id>` (repeatable) and each of the last 90 days,
`GET /api/external/sales` and `/payment-methods`; counts only, no bodies, no writes, the key never echoed:
(a) days `found`; (e1) X < 0; (e2) days with refunds (X > ₱0.01 × N), and of those, days where refunds exceed cash
methods; (r) days with 0 < X ≤ ₱0.01 × N (booked as rounding; may hide a small refund, ✎Y-minor), with the largest X; (c) days where K > P + D − C + refunds (the ✎W1 cap fires),
with the largest excess; (d) a non-centavo value; (e) a negative method; (f) distinct method names; (g) days with C > 0.
(h) DEF-061's gross-or-net basis is not measurable through the bridge; say so.
**Gate (per store, before it is linked on production):** (e1), (d), (e) and (e2)'s second count are 0 over 90 days, or
the planner amends R4. (c) and (r) are reported, not gating (they are capped or booked by rule). (f) is the admin's
mapping list; (g) feeds Q2. **Needs Q1.** Run locally by whoever holds the key; numbers go in the status line.
✎S0-A (orchestrator ruling): (n) days with a negative total (P + D + refunds - C < 0; charges exceed sales, the import refuses these) is counted separately, is GATING, and those days are excluded from (c).

---

## S1: structure (0183), the fetcher, the store link, the channel guard
**Goal:** the tables exist with RLS, grants and classification; v2 can fetch a POS day with the right store id; an
admin can link a store safely; the linked channel cannot be changed under the link.

**BUILDER:**
- `packages/db/migrations/0183_t375_s1_pos_v1_day_feed_structure.sql` (ADR-012 §5; header names T-375, DEF-586, ✎N1):
  - the four R1 tables, RLS `org_column` via `app_current_org()`, FORCE; grants: feeds and corrections `SELECT, INSERT`;
    links and tenders `SELECT, INSERT, UPDATE` (no DELETE anywhere). **REVOKE explicitly** whatever the schema's
    default privileges grant beyond that set (`0011:72` grants `SELECT, INSERT, UPDATE, DELETE` on new tables; read
    the later defaults, e.g. `0169`, and revoke the rest: DELETE on all four, UPDATE on feeds and corrections) (✎Y-minor);
    M1 asserts the exact set;
  - feeds: CHECKs `kind in ('sales','sold_items')`, `purpose in ('import','recheck','usage')`, `content_hash ~
    '^[0-9a-f]{64}$'`, `btrim(pos_store_id) <> ''`; unique `(batch_id, kind)`; index `(org_id, store_id,
    business_date, kind, fetched_at desc)`; trigger `pos_v1_day_feeds_append_only` refusing UPDATE and DELETE;
  - links: unique `(store_id)`, unique `(pos_store_id)`, FK `sales_channel_id → sales_channels(id)`, CHECK
    `pos_tax_type in ('vat_inclusive','vat_exclusive','non_vat')`;
  - tenders: CHECKs `kind in ('cash','wallet')`, `(kind = 'wallet') = (money_account_id is not null)`,
    `btrim(name) <> ''`, `pos_v1_alias is null or btrim(pos_v1_alias) <> ''`; unique `(store_id, lower(btrim(name)))`
    (all rows, the `sales_channels` precedent, `schema/sales-days.ts:138-148`); unique `(store_id,
    regexp_replace(lower(pos_v1_alias), '[^a-z0-9]', '', 'g')) where is_active and pos_v1_alias is not null`; FK
    `(org_id, money_account_id) → money_accounts(org_id, id)` (`0171`);
  - corrections: unique `(sales_day_id, to_feed_id)`; FKs to `sales_days`, feeds (both), `journal_entries`;
    append-only trigger; `btrim(reason) <> ''`;
  - `sales_days`: `source text not null default 'legacy_typed'`, `pos_v1_day_feed_id uuid references
    pos_v1_day_feeds(id) on delete restrict`, `refunds numeric(14,2) not null default '0'`, the R6 CHECKs, an index on
    the feed id;
  - `pos_usage_pulls.pos_v1_day_feed_id uuid references pos_v1_day_feeds(id) on delete restrict` (nullable).
- `packages/db/schema/pos-v1.ts` (new) with every hand-added item's `// NOTE … migration 0183`;
  `schema/sales-days.ts`, `schema/pos-mapping.ts`: new columns and CHECKs; `schema/index.ts` exports.
- `classification.ts`: links and tenders `keep` (configuration, as `pos_item_maps`); feeds and corrections `purge`.
  `PURGE_ORDER_HINT`: corrections before `sales_days`; feeds after `sales_days` and `pos_usage_pulls`.
  `rls/registry.ts`: four `org_column` entries.
- `packages/db/src/pos-v1/wire.ts` (field-name constants, incl. the receipt count) and `fixtures.ts`
  (`posV1SalesBody(figures)`, `posV1SoldItemsBody(items)` from v2-named inputs, for tests). `glossary-trap-names.test.ts`:
  add `'packages/db/src/pos-v1/'` to `ALLOWED_PREFIXES` with the reason.
- `packages/db/src/repo/pos-v1.ts`: links (get, getForUpdate-by-store, insert, update), feeds (insertBatch, getById,
  latestForDay(kind), basisFor(day)), tenders (S2), corrections (S6).
- `packages/domain/src/pos/v1-feed.ts`: `fetchPosV1Day({ posStoreId, businessDate, kind })` → `{ body, payload }`; env
  as today (`env().POS_API_URL/KEY`); unset → `PosNotConfiguredError`; non-2xx or network → `PosUnreachableError` (POS's
  `error` text in the raw half only); type `FetchPosV1Day`. Also `fetchPosV1PaymentMethods`, `fetchPosV1Stores`.
- `packages/domain/src/pos/store-link.ts`: `linkStoreToPos(tx, actor, { storeId, posStoreId, posStoreName,
  salesChannelId, posTaxType })`: `manage_chart_of_accounts`; then the store row `FOR UPDATE` (R13); refuses an open or
  submitted `legacy_typed` day (R13 sentence), a channel of another store, a non-remitted channel, a POS store linked
  elsewhere. Relinking updates `pos_store_id`, name, channel, tax type (never `store_id`). Audited `link_store_to_pos`.
- `domain/src/sales-channels/index.ts` (✎V6): `updateSalesChannel` (`:189`) and `setSalesChannelActive` (`:222`) refuse
  a flip to non-remitted, or a retire, of a channel a link names: *"POS's sales land in this channel, so it has to stay
  remitted daily and active. Change the POS link first."*
- `apps/erp/src/app/settings/pos-link/{page.tsx,actions.ts,lib.ts}`: per store: link (POS store picker from
  `fetchPosV1Stores`, else a text box with a "not configured" note), channel picker, tax type. Route entry
  `'/settings/pos-link': 'manage_chart_of_accounts'`; nav link under Settings.
- `docs/GLOSSARY.md`: **day feed**; **tender (master)** vs `sales_day_tenders` (a day's wallet rows); **platform
  sales**; **refunds (sales day)** — POS refunds of the day, contra-revenue 4950, never comps (✎W11; comps keep their
  meaning, GLOSSARY:138); **linked store**.

**TESTER:** `packages/db/tests/integration/t375-s1-migration.test.ts`, `packages/domain/tests/integration/
t375-s1-store-link.test.ts`, `packages/domain/tests/unit/t375-s1-fetch.test.ts` (injected `fetch`).

**Tests:**
- M1 (red on HEAD): the four tables exist, RLS enabled and forced; `shareat_app` privileges exactly R1's.
- M2 (red): feed UPDATE and DELETE refused. Control: INSERT and SELECT work.
- M3 (red): tenders: wallet without account, cash with account, aliases `'G-Cash'` and `'gcash'` on two ACTIVE tenders
  of one store → each refused. Controls: same alias on an inactive row; on another store.
- M4 (red): existing `sales_days` rows read `legacy_typed`, feed id null, refunds 0; feed source with null feed id,
  feed source with `pos_sourced = false`, `legacy_typed` with refunds 5 → each refused. Control: a well-formed feed row.
- M5: corrections UPDATE/DELETE refused.
- L1 (red): admin links a store → row. Manager → `AuthorizationError` (✗). Staff → ✗.
- L2: channel of another store → *"That sales channel belongs to a different store."*; non-remitted → *"POS's sales are
  paid at the till, so they need a channel whose money is remitted daily."*; POS store linked elsewhere → *"That POS
  store is already linked to {store}."* Control: relinking the same store to a new POS id updates it.
- L3 (✎V6, red): flipping the linked channel to non-remitted, or retiring it → the ✎V6 sentence. Control: another
  channel of the store flips freely.
- L4 (✎W6, red): a store with an OPEN typed day → link refused naming the date. Controls: after that day is verified
  → linked; a store with only verified or voided typed days → linked.
- L5 (✎W7): two connections: A runs `createSalesDay` (holding the store `FOR KEY SHARE`, not committed); B runs
  `linkStoreToPos` and blocks; A commits; B then refuses (the new open typed day). Reverse order: B links first and
  commits; A's `createSalesDay` refuses (S3 owns that sentence; here assert the refusal and zero new days). A
  behaviour test, not a mutant-killer for the lock (✎Y4).
- F1 (red): `fetchPosV1Day({ posStoreId: 'abc', businessDate: '2027-01-05', kind: 'sales' })` requests
  `{url}/api/external/sales?storeId=abc&date=2027-01-05` with `x-api-key`; returns body and payload. `sold_items` →
  `/sold-items`.
- F2: env unset → `PosNotConfiguredError`; 403 `{error:'Forbidden for this store.'}` → `PosUnreachableError`.
- Existing guards go red until done (the proof): `cutover-classification`, the RLS registry test,
  `migration-journal`, `glossary-trap-names`, `route-capability-coverage`.
- Mutants: no append-only trigger → M2; alias index without normalization → M3; send the v2 store id → F1; link
  capability `manage_store_settings` → L1 manager leg; no store-row lock in link → L5 red; no open-typed-day check → L4. (No mutant is claimed for `createSalesDay`'s
  `FOR KEY SHARE`, ✎Y4.)

**Precheck (production, before the push, row 278):** `select count(*) from sales_days;`
`select store_id, status, count(*) from sales_days group by 1, 2;` and the stores creating days lately:
`select store_id, count(*) from sales_days where created_at > now() - interval '30 days' group by 1;` Read-only.
**Smoke (9008):** `/settings/pos-link` as admin: link a store (text box, bridge not configured) with a channel and tax
type; a non-remitted channel refused in words; a store with an open typed day refused with its date; manager refused.
Screenshots.

---

## S2: the tender master and the method resolver
**Goal:** an admin maps each POS payment method to a tender; the resolver refuses anything unmapped.

**BUILDER:**
- `packages/domain/src/pos/tenders.ts`: `createTender`, `updateTender` (name, alias, account), `setTenderActive`;
  `manage_chart_of_accounts` on the store; a wallet's money account must be an ACTIVE account of this store; audited.
- `packages/domain/src/pos/v1-methods.ts` (pure): `toCentavos` (R4) and `resolvePosV1Methods(byMethod, tenders)` →
  `{ ok: true, cash: Money, wallets: Map<moneyAccountId, Money> } | { ok: false, sentence, raw }` per R3.
- `settings/pos-link`: a Tenders section per store (list, add, edit, retire) and "POS methods not mapped yet" from
  `fetchPosV1PaymentMethods(link.posStoreId)` minus the active aliases (hidden with a note when not configured).

**TESTER:** `packages/domain/tests/integration/t375-s2-tenders.test.ts`, `packages/domain/tests/unit/t375-s2-methods.test.ts`.

**Tests:**
- T1 (red on HEAD): admin creates `Cash` (cash, alias `Cash`) and `GCash` (wallet → the store's GCash account, alias
  `GCash`). Manager → ✗. A wallet account of another store → *"That money account isn't one of this store's."*
- T2: a second active tender aliased `g cash` → *"Another tender of this store already answers to "GCash" from POS."*;
  control: after retiring the first, accepted.
- R1 (red): `{ Cash: 700, 'G·Cash': 350 }` → cash 700.00, wallets {GCash: 350.00}.
- R2 (red): `{ Cash: 700, Maya: 50 }`, no Maya alias → *"POS took ₱50.00 as "Maya", which isn't set up as a tender for
  this store. An admin maps it under Settings › POS link, then import again."* Control: `{ Maya: 0 }` ignored.
- R3 (v1 contrast): `Cash` with no tender aliased `Cash` → refused. Control: alias it → accepted.
- R4: `{ GCash: -20 }` → refused (*"POS shows ₱20.00 more refunded than taken as "GCash" that day, so the day can't be
  imported."*).
- R5: `{ GCash: 100, 'GCash ': 50 }` → GCash 150.00; an inactive tender's alias is not matched.
- R6: `0.30000000000000004` → 0.30; `10.005` → refused naming the method.
- Mutants: name auto-match → R3; refuse a zero unknown → R2 control; `Math.floor` for `round` → R6.

**Migration:** none. **Smoke (9008):** two tenders on `/settings/pos-link`; duplicate alias refused in words; manager
refused. Screenshots.

---

## S3: the derivation, the import, the typed path gated by the link, the fake POS
**Goal:** a linked store gets its days only by importing from POS (re-import while unverified); an unlinked store keeps
the typed path, labelled, without the "From POS" checkbox.

> ✎ 2026-10-05 (from the S2 audit): the import must re-check that each wallet tender's money account is still ACTIVE at import time (`resolvePosV1Methods` is pure and does not), refusing by name; and `resolvePosV1Methods` gets its production caller here. Orchestrator note (S2 audit): tender management is org-scoped by the `manage_chart_of_accounts` capability (an admin scoped to one store can manage another store's tenders), consistent with the chart of accounts; recorded, not changed.

**BUILDER:**
- `packages/domain/src/pos/v1-derive.ts` (pure): `deriveSalesDay(payload, { channelId, taxType, tenders })` → figures
  (incl. `refunds`), one channel row, tender rows, the ✎W1 cap excess, or a refusal (R4).
- `packages/domain/src/sales-days/routing.ts`: `refunds` in `RouteSalesDayInput`, on the collected side of check 3, and
  a `Dr 4950` line *"refunds (POS)"* when non-zero. `SALES_DAY_ACCOUNTS.REFUNDS = '4950'`.
- `packages/domain/src/sales-days/create-block.ts`: the create-block moved verbatim from `create.ts:133-210`
  (`SalesDayBlockedError`, `TransitShortfallBlockedError`, `canBypassBlock` re-exported); called by both paths.
- `packages/domain/src/sales-days/import.ts`: `importSalesDay` per R5; `ImportFetchers = { sales; soldItems }`, live by
  default. Sentences:
  - unlinked: *"{Store} isn't linked to a POS store yet, so its sales can't be imported. An admin links it under
    Settings › POS link."*
  - not configured: *"The POS connection isn't set up on this server, so sales can't be imported."*
  - unreachable: *"POS couldn't be reached, so {d MMM YYYY} wasn't imported. Try again later — sales only come from
    POS."*
  - not found: *"POS has no sales for {store} on {d MMM YYYY}. The day waits until POS has them."*
  - methods short: *"POS's payments for {d MMM YYYY} (₱m) are less than its sales (₱p), so the day can't be imported.
    This has to be fixed on the POS."*
  - refunds above cash: *"POS shows ₱r refunded on {d MMM YYYY} but only ₱c cash taken, so the day can't be imported.
    Tell the office; this needs a ruling."*
  - VAT exclusive: *"This store adds VAT on top of its prices in POS. Importing it needs a ruling on where that VAT goes.
    Ask the office."*
  - verified: *"{d MMM YYYY} is already verified. If POS changed since, it shows under Findings and is corrected
    there."*
  - legacy (defensive, R5).
- `sales-days/create.ts` and `edit.ts`: kept for unlinked stores. After `authorize()`: store row `FOR KEY SHARE`, then
  the link → linked refuses (R13 sentence). `posSourced` removed from both inputs; `pos_sourced = false`,
  `source = 'legacy_typed'` always. `index.ts` also exports `import`.
- `packages/db/src/repo/sales-days.ts`: `withSalesDayDerivation(tx, fn)` (R6, reset on success only);
  `insertSalesDay` takes `source`, `posV1DayFeedId`, `refunds`; `replaceRemittedChannels`; `updateDerivedFigures`;
  `lockStoreKeyShare(tx, storeId)`.
- apps:
  - `actions.ts`: `importSalesDayAction` (store, date) and `reimportSalesDayAction` (day). (S6 later adds the
    post-commit `recheckRecentDays` call to `importSalesDayAction`; S3 adds no placeholder.)
    `createSalesDayAction` and `editSalesDayAction` stay (unlinked); the `posSourced` read (`actions.ts:74`) goes.
  - `new/page.tsx`: store picker + date; a LINKED store shows **Import from POS** only; an UNLINKED store shows the
    typed `SalesDayForm` with the label *"Typed — this store isn't linked to POS yet."*
  - `SalesDayForm.tsx`: the checkbox (`:238`) goes.
  - day page: **Re-import from POS** while open/submitted on a feed day; "Imported from POS at {time}" or "Typed —
    store not linked to POS" in place of `[id]/page.tsx:112`'s flag text; the ✎W1 cap note when it applies; the
    "Edit this day" link only on a typed day of an unlinked store; the edit page refuses otherwise (R13 sentence).
- **The dev fake POS (✎V13, ✎W10)**, inside the ERP on 9008 (no new port):
  `apps/erp/src/app/api/dev/fake-pos/api/external/[route]/route.ts` serves `sales`, `sold-items`, `stores`,
  `payment-methods` from `apps/erp/dev-fixtures/pos-v1/stores.json` and `apps/erp/dev-fixtures/pos-v1/{posStoreId}/
  {date}.sales.json | {date}.sold-items.json | payment-methods.json`. `posStoreId` must match `^[A-Za-z0-9_-]{1,64}$`
  and `date` `^\d{4}-\d{2}-\d{2}$` (else 400; no path is built from anything else). 404 unless
  `NODE_ENV !== 'production'` AND `POS_FAKE_ENABLED === '1'`; 401 unless `x-api-key` equals `POS_API_KEY`. No session
  exemption is needed: `proxy.ts:31` matches only `/clock`, and the route asks for no session; it is a server-to-self
  call. JSON is outside the trap-name guard's extensions; the route never names a field.
- `tests/unit/t375-no-typed-sales-figures.test.ts` (G1, by the TESTER first).

**TESTER:**
- `packages/domain/tests/integration/_fixtures/pos-day.ts` (new): `linkTestStore`, `seedTestTenders`,
  `importTestDay(tx, actor, { storeId, businessDate, figures, soldItems? })`. Used by NEW tests and by any existing test
  whose store gets linked; unlinked-store tests keep `createSalesDay` (✎V2b). Report every changed file and assertion.
- `packages/domain/tests/unit/t375-s3-derive.test.ts`, `packages/domain/tests/integration/t375-s3-import.test.ts`,
  `apps/erp/tests/integration/t375-s3-import-web.test.ts`, `apps/erp/tests/integration/t375-s3-fake-pos.test.ts` (new).
- Update `tests/unit/domain-actions-have-callers.test.ts` (`importSalesDay` gains a caller; `createSalesDay` and
  `editSalesDay` keep theirs), `t339-sales-day-new-store-picker.test.ts` (linked vs unlinked render),
  `t369-s3-sales-day-edit-void.test.ts` and `oil-wave-2.test.ts` (no `posSourced` input; `salesDayUnposted` legs seed a
  feed day through the helper so `pos_sourced` is true).

**Tests:**
- D1 (red on HEAD; unit): P 1,050.00, D 100.00, C 50.00, K 600.00, methods {Cash 700.00, GCash 350.00}, N 20 →
  total 1,100.00, unli 600.00, à la carte 500.00, other discount 100.00, other charges 50.00, refunds 0, cash 700.00,
  online 350.00, one tender row 350.00, one channel row 1,100.00; routes to Dr 1110 700, Dr 1140 350 (GCash),
  Dr 4900 100, Cr 4100 600, Cr 4150 500, Cr 4500 50.
- D2 (red): methods 1,049.99 vs P 1,050.00 → methods-short refusal. Control: float noise that rounds equal → accepted.
- D2a (✎W11, red): methods 1,050.03, P 1,050.00, N 20 → rounding: refunds 0, other charges 50.03, cash 700.03; routes,
  no 4950 line. Control: N 2 → 0.03 > 0.02 → refunds 0.03.
- D2b (✎V1, red): P 950.00 (a 100.00 refund), methods {Cash 700.00, GCash 350.00}, D 100.00, C 50.00, K 600.00 →
  refunds 100.00, total 1,100.00, cash 600.00, online 350.00, à la carte 500.00; routes with Dr 4950 100. Refunds
  800.00 with cash 700.00 → the refunds-above-cash refusal.
- D2c (✎V9): `vat_exclusive` → refused before deriving. Controls: `vat_inclusive` and `non_vat` → D1's result.
- D3 (✎W1, red): K 1,200.00 > total 1,100.00 → unli 1,100.00, à la carte 0.00, cap excess 100.00; routes. Control:
  K = total → excess 0.
- D3r (✎W1, red): a dine-in refund day: P 900.00, methods {Cash 1,000.00}, D 0, C 0, K 1,000.00 (900 kept + 100
  refunded counted positive) → refunds 100.00, total 1,000.00, unli 1,000.00 (not capped, equal), à la carte 0.00.
  And with K 1,100.00 → capped at 1,000.00, excess 100.00; imports (never refused).
- D4: `found: false` → refused.
- I1 (red): `importSalesDay` for a new date on a linked store → one day, feed source, feed id = the `sales` feed,
  `pos_sourced` true, `pos_sourced_at` = its `fetched_at`; two feed rows sharing a `batch_id`, `purpose 'import'`, body
  byte-identical to the fetcher's, hash = sha256(body); figures as D1; verify posts D1's lines.
- I2 (red): re-import of the open day with P 1,150.00 → figures replaced; a Foodpanda platform row untouched; status
  kept; audit `reimport_sales_day` with both feed ids; four feed rows.
- I3: re-import of a verified day → the verified sentence; zero new feed rows.
- I4 (I5): unmapped method, not configured, unreachable (fetcher throws), not found, VAT exclusive → refused; zero days,
  zero feed rows.
- I5 (I1): no `submit_sales_day` → `AuthorizationError`; the fetchers recorded zero calls.
- I6: an older open day blocks a newer import (create-block); controls: an admin is not blocked; an older date is not.
- I7: a voided date: an importer without `void_sales_day` refused (*"…Only a manager can enter that date again…"*);
  manager → imported.
- I8: re-import of a submitted day with `submit_sales_day` only → ✗; with `verify_sales_day` → ok.
- I10 (✎V2b, red): a LINKED store: `createSalesDay` → *"{Store} takes its sales from POS. Import the day instead."*;
  `editSalesDay` on a verified typed day of that store → the same. Control (unlinked): `createSalesDay` creates a
  `legacy_typed` day with `pos_sourced = false` even when the old `posSourced: true` is passed; `editSalesDay` edits it.
- I11 (✎V2b): an UNLINKED store: `importSalesDay` → the unlinked sentence; zero feed rows.
- W1 (apps): with `fetch` stubbed (`vi.stubGlobal`) to D1's bodies, `importSalesDayAction` on a linked store creates
  the day and redirects to it (positive); with `POS_API_URL` unset → the not-configured sentence (negative). The new-day
  page renders the Import button and no figure input for a linked store, and the typed form (without `posSourced`) for
  an unlinked one.
- FP1 (✎W10): the fake POS: under `NODE_ENV=production` with `POS_FAKE_ENABLED=1` → 404; a `posStoreId` of
  `../../etc` or `a/b` → 400 and no file read; wrong key → 401. Control: dev + flag + key → D1's body.
- G1 (red on HEAD; unit, pure `fs`): no file under `apps/erp/src` contains `posSourced`; the figure inputs exist only in
  `SalesDayForm.tsx`; `app.sales_day_derivation` appears only in `packages/db/src/repo/sales-days.ts`, the 0185 migration
  and test files; outside `sales-days/import.ts` no domain file calls `salesDaysRepo.updateDerivedFigures |
  replaceRemittedChannels`, and `insertSalesDay` is called only from `import.ts` and `create.ts`. Positive controls: the
  scanner flags fixture strings `name="posSourced"` and `set_config('app.sales_day_derivation'`.
- Mutants: à la carte from the POS residual field → D1 red; refunds into `comps` → D2b red (4950 line memo and the
  `comps` column); no rounding threshold → D2a red; refuse instead of cap → D3/D3r red; fetch inside the day lock →
  the lock-order leg of I2 (a second connection holds the day `FOR UPDATE` with `lock_timeout`; assert the fetcher was
  called before the import blocks) red; drop the verified refusal → I3; write feed rows before deriving → I4's zero-feed
  leg. (`createSalesDay`'s `FOR KEY SHARE` has no killing mutant; R13, ✎Y4.)

**Migration:** none.
**Smoke (9008):** unlinked store: the typed form shows, no "From POS" checkbox, saving labels the day "Typed — store not
linked". Linked store with the fake POS (`POS_FAKE_ENABLED=1`, `POS_API_URL=http://localhost:9008/api/dev/fake-pos`)
and D1's JSON: Import → D1's figures and "Imported from POS"; edit the JSON (P 1,150), Re-import → figures change;
add an unmapped method → the R3 sentence; a refund day JSON (D2b) → refunds shown, 4950 on verify. With `POS_API_URL`
unset → the not-configured sentence. Screenshots.

---

## S4: the link-aware lock (0185), the platform seam, report modes
**Goal:** on a linked store, no path but the derivation can write a figure; platform sales are their own small entry;
the sales report still reconciles.

**BUILDER:**
- `packages/db/migrations/0185_t375_s4_sales_day_figure_lock.sql`: the R6 trigger functions and triggers
  (`sales_days` insert and update, `sales_day_tenders`, `sales_day_channels`, `pos_v1_store_links` update), each reading
  `coalesce(nullif(current_setting('app.sales_day_derivation', true), ''), 'off')` and the link via an invoker lookup,
  with the NULL-org fail-closed guard (R6); raising `23514` with the named constraint. The `source` default is KEPT.
  Schema files carry `// NOTE … migration 0185`.
- `packages/domain/src/sales-days/platform.ts`: `setPlatformSales` per R8. Sentences: remitted channel → *"{channel} is
  paid at the till, so its sales come from POS, not from here."*; verified/voided → *"Platform sales can only be
  changed before the day is verified."*
- `packages/domain/src/sales-days/compose.ts`: `routeInputForDay` per R8 (incl. `refunds`); `verify.ts:96-118` calls it.
- `verify.ts:213`'s wastage sentence becomes *"Wastage is recorded against this day, so it can't be withdrawn."* plus,
  on a feed day, *" Re-import it from POS instead."*, on a typed day of an unlinked store, *" Edit its figures
  instead."* (✎V13; both remain true under R13).
- `repo/reports.ts` `getSalesByChannelAndMode`: feed-day platform totals in à la carte (R14).
- day page: a **Platform sales** section (non-remitted channels; amount or "no sales") on a feed day while open/submitted.
- `constraint-messages.ts`: the four sentences (R6).

**TESTER:** `packages/db/tests/integration/t375-s4-lock.test.ts`, `packages/domain/tests/integration/
t375-s4-platform.test.ts`, `apps/erp/tests/integration/t375-s4-day-page.test.ts`. Add `insertDerivedSalesDayRow(tx, row)`
to `_fixtures/pos-day.ts` for raw-SQL feed days on linked stores. Existing raw inserts on unlinked stores stay as they
are; any that now fail are reported, not patched around.

**Tests (every "linked" leg links the store first with `linkTestStore`):**
- K1 (red on HEAD; LINKED store, feed day): with the flag off, `update sales_days set <col> = …` → refused
  (`sales_days_figures_locked`) for **each** of the twelve figures, `refunds`, `store_id`, `business_date`, `source`,
  the feed id, `pos_sourced`, `pos_sourced_at` (a loop). Control: `markSubmitted`, `markVerified`,
  `markUnverifiedVoided` succeed.
- K2 (red; LINKED): INSERT with the flag off → refused; flag on but `legacy_typed` → refused. Control: flag on + feed.
- K3 (LINKED): flag on, feed day verified → a figure UPDATE refused. A `legacy_typed` VERIFIED day of the now-linked
  store: a figure UPDATE (flag on or off) → refused.
- K4 (red; LINKED feed day): `sales_day_tenders` INSERT/UPDATE/DELETE with the flag off → refused; on → allowed.
- K5 (red; LINKED feed day): a remitted channel row write with the flag off → refused. Controls: a non-remitted row on
  an open day without the flag → allowed; on a verified day → refused.
- K6: the flag is transaction-local: after a derivation transaction commits, a new transaction on the same pooled
  connection updating a figure → refused.
- K7: `errorMessage()` maps each constraint name to its sentence.
- K8 (✎V5, red): in ONE transaction, after `withSalesDayDerivation` returns, a figure UPDATE → refused.
- K11 (✎W4, red): `withSalesDayDerivation(tx, fn)` where `fn` violates `sales_days_revenue_identity_check` → the error
  that surfaces names `sales_days_revenue_identity_check` (not 25P02).
- K10 (✎V2b, red): LINKED: raw INSERT `legacy_typed` → refused; feed insert without the flag → refused. UNLINKED
  (controls): raw INSERT with no `source` → `legacy_typed`, accepted; a typed day's figure UPDATE while open → allowed;
  a feed insert → refused (needs a link). After linking: that typed day's figure UPDATE → refused. **Here the link row
  is inserted by raw SQL as the test's own fixture (not through `linkStoreToPos`, which would refuse a store with an
  open typed day, ✎W6), precisely to leave an open typed day under a linked store for the trigger to judge (✎Y-minor).**
  `pos_v1_store_links.store_id` UPDATE → refused.
- K12 (✎W2, ✎Y3): as `shareat_app` with `app.org_id` unset: a raw INSERT of a `legacy_typed` day for a LINKED store
  fails and **0 rows are inserted**; a raw figure UPDATE of an unlinked store's typed day **updates 0 rows** and the
  figure is unchanged (RLS hides the row; the trigger never fires). The NULL-org guard is defence in depth; no test
  claims to reach it and no mutant is claimed. Control: as a superuser/BYPASSRLS test role with `app.org_id` unset, the
  link is seen: a `legacy_typed` INSERT for the linked store → refused by the trigger; for an unlinked store →
  accepted.
- P1 (red): a feed day (D1) + Foodpanda (non-remitted, receivable `1220`) 500.00 via `setPlatformSales` → verify posts
  D1's lines plus Dr 1220 500 (party Foodpanda) and Cr 4150 1,000 (500 + 500); balances; T-150's
  `listSettleableChannelDays` lists Foodpanda 500.00.
- P2: Walk-in (remitted) via `setPlatformSales` → the sentence; nothing written.
- P3: on a verified day → refused. P4: staff without `submit_sales_day` ✗; a submitted day needs `verify_sales_day`.
- P5 (control): a `legacy_typed` day of an unlinked store with typed channel rows verifies with exactly today's lines.
- P6 (✎V8, red): P1's verified day → `getSalesRollup` for that date `reconciles: true`; à la carte includes the 500.
- W1 (apps): a feed day: no "Edit this day"; `/sales-days/{id}/edit` refuses with the R13 sentence; "Platform sales"
  shown while open. Control: an unlinked store's typed day keeps "Edit this day" and the edit page saves.
- Mutants: trigger checks `total_sales` only → K1 on the other columns; `set_config(…, false)` → K6; reset in `finally`
  → K11; a lookup that ignores the link under a BYPASSRLS role → K12's control; composition on legacy days → P5; platform total into `unliSales` →
  P1 (4100); channel trigger ignoring `is_remitted_daily` → K5 control; trigger ignoring the link → K10's unlinked
  control red.

**Precheck (production, before the push):** `select count(*) from pos_v1_store_links;` (expected 0 unless a store was
linked after S1) and S1's store/status counts again. No row changes meaning: no store is linked by this push.
**Smoke (9008):** a feed day (fake POS): no edit link; the edit URL refused in words; Platform sales: Foodpanda 500
saves, Walk-in refused; verify → 1220/4150 lines; a forged figure UPDATE in `psql` as `shareat_app` with the org set →
the lock error. An unlinked store's typed day still edits. Screenshots.

---

## S5 (S5-lite, ✎ 2026-10-05): usage reads the sold items the import stored
> ✎ 2026-10-05 (S5 audit, orchestrator): finalize's "changed" refusal on a pull that already has a finalized section uses the partly-posted sentence ("… Void the pull and build the day again."), since buildPlan would refuse a plain rebuild there; a pull with no finalized section keeps "Build the plan again.". The pinned-feed guard (kind, store, date) runs in buildPlan as well as finalize.

> ✎ 2026-10-05 (bible row 281): Ian asked for the POS pulls to be **redesigned** for the unified backend, planned with `/research-evaluate-propose`. ✎ 2026-10-05 later: proposal written (`docs/discovery/pos-pull-redesign-proposal.md`) and answered (bible row 282). **This section is the S5-lite amendment, written in plan mode by the Opus planner; it replaces the earlier S5 text entirely.** Rulings honoured: Q-C (a) the void stays as built; Q-D (a) a typed day gets no POS usage pull; no live POS call; no migration (0186 stays free).
> **Where this section and R9 differ, this section wins.** R9's capture path (`purpose = 'usage'`, a fetch for typed days), the parallel-plan row's file list and the Goal's "usage pull reads the stored POS snapshot" bullet are superseded by the text below; so is I5's "`found` false → a sentence" **for usage only** (✎S5L-R: a stored `found: false` sold-items feed plans empty only on a ₱0 day, below). R10's drift scope is widened to a partly finalized pull (✎S5L-R). Nothing else in R1–R14 or the Invariants changes.

**Goal:** a day's POS usage pull plans and finalizes from the `sold_items` feed that the day's import (or a later S6
recheck) already stored. Nothing is fetched. A typed day and an unlinked store refuse in a sentence. Finalize, the
pull void and the permissions are unchanged.

**What the code does today (read at HEAD `9c42734`):**
- Plan and finalize each call POS live: `rebuildLines` calls `fetchSnapshot` (`packages/domain/src/pos/usage-pull.ts:98-99`),
  from `buildPlan` (`:187`) and again from `finalizeSections` (`:272`); both default to `fetchPosSoldItemsLive`
  (`:160`, `:254`).
- `fetchPosSoldItemsLive` sends the v2 `stores.id` as `?storeId=` (`:70-71`); POS answers `found: false` and the plan is
  silently empty (`:79`). This is ✎N1. v2 production has never produced a non-empty plan (proposal §6).
- The import already stores both kinds in one batch: `fetchBoth` (`packages/domain/src/sales-days/import.ts:113-123`)
  calls POS with the LINK's `pos_store_id` (`:167`), and `insertBatch` writes the `sales` and `sold_items` rows with
  `purpose 'import'` and that `pos_store_id` (`:200-212`).
- `posV1Repo.latestForDay(tx, orgId, storeId, businessDate, kind)` already exists, unused (`packages/db/src/repo/pos-v1.ts:275-296`),
  ordered `fetched_at desc, id desc` (`:293`) and served by `pos_v1_day_feeds_store_day_kind_fetched_idx`
  (`packages/db/schema/pos-v1.ts:128`). `getFeedById` (`repo/pos-v1.ts:265`).
- `pos_usage_pulls.pos_v1_day_feed_id` already exists, nullable (`packages/db/schema/pos-mapping.ts:190`, migration 0183),
  but `pullColumns` does not select it (`packages/db/src/repo/pos-mapping.ts:268-279`) and `insertPull` /
  `refreshPlannedPull` do not write it (`:329-351`).
- The day lock is `lockLiveSalesDay` → `getByIdForShare` (`packages/domain/src/sales-days/live-day.ts:15-20`); a re-import
  holds the same day `FOR UPDATE` (`import.ts:195`) before it inserts its batch (`:200`). The two serialize.
- Finalize skips a quantity ≤ 0 (`usage-pull.ts:329`) and posts each location in a savepoint (`:340`).

**Decisions (planner):**
- **"Latest" means** the day's newest stored `sold_items` feed: the row of `pos_v1_day_feeds` with this org, store and
  business date and `kind = 'sold_items'` that has the greatest `(fetched_at, id)` (`latestForDay`, unchanged). In
  practice that is the import's row or a later S6 recheck's row: after S5-lite nothing writes `purpose = 'usage'`
  (the CHECK still allows it, harmlessly; R1). A re-import of an open day adds a newer import row, so "latest" follows
  it. Feeds are keyed by (store, date), not by sales day, so a replacement day re-imported after a void reads its own
  newer batch. S6 needs no extra "import or recheck" lookup (proposal §7b's one-liner): `latestForDay` already is it.
  **Newest fetch, not newest commit (✎S5L-R):** an import's `fetched_at` is the app clock taken right after the fetch
  returns (`import.ts:168-169`), and a tie falls to the larger uuidv7 `id`. Two concurrent re-imports of one day can
  therefore leave the day's figures from one fetch while usage pins the other's `sold_items` row. Rare (two people
  re-importing the same open day at once); no code change.
- **✎N1 disappears for usage because nothing is fetched.** The only POS call left is the import's (and S6's recheck),
  which uses the link's (or the basis feed's) POS store id and stores it on the row. `fetchPosSoldItemsLive`
  (`usage-pull.ts:63-85`) is deleted, and with it the line that sent the v2 uuid.
- **The live-fetch path is removed, not kept for unlinked stores.** (1) It has never worked in v2 (✎N1), so there is no
  behaviour to keep. (2) A POS call needs POS's store id, and only the link has one; an unlinked store has none by
  definition. (3) Every day of an unlinked store is typed (R13), and Q-D refuses typed days. (4) Row 282: no live call.
  So an unlinked store refuses with R9's sentence. **Effect on production today (told, not asked):** every store is
  unlinked (no production key yet, row 279), so the v2 POS usage pull refuses on every store with that sentence,
  where it used to plan an empty day in silence. v1 still records usage for the business until a store is linked.
- **`SNAPSHOT_MAX_AGE_MS` stays (`usage-pull.ts:88`, `:264-267`), unlike proposal §7b.** The stored feed no longer goes
  stale, but finalize still rebuilds against CURRENT maps and recipes and posts the confirmed keys at the rebuilt
  quantities; the hour bounds how far a mapping or recipe change can move a confirmed line. `PLAN_CHANGED` stays.
  Both keep their existing tests.
- **Finalize refuses on a newer DIFFERENT feed, not on any newer feed** (R9, ✎W5, kept): a re-import or recheck whose
  items projection (item key → physical quantity) equals the pinned one posts; one that differs refuses. After
  finalize, a differing recheck is S6's `posDaySoldItemsDrift`.
- **The newer-feed check runs under the day lock.** With no HTTP left, both functions take the day lock (`FOR SHARE`) and
  the pull lock FIRST, then read the feeds. A concurrent re-import (day `FOR UPDATE`) therefore either committed
  before the read (seen) or waits for the pull to commit. A recheck (S6) does not lock the day; a recheck that lands
  between the read and the commit is caught by `posDaySoldItemsDrift`, which (✎S5L-R) watches any pull with a finalized
  section, not only a fully finalized one.
- **A partly finalized pull never moves its pin (✎S5L-R).** Rebuilding a pull with a finalized section (T-374 S7 audit 1,
  `usage-pull.ts:195-207`: only unfinalized sections are rewritten) reads the pin from the LOCKED row. Latest = pin, or
  latest's items projection equals the pin's → the pin is KEPT and the unfinalized sections are rebuilt from the pinned
  feed. Latest differs (or is unreadable) → refused: re-pinning would leave one pull claiming F3 while its posted
  section came from F1, and nothing would flag it. A partly finalized pull with no pin (made before S5-lite) is refused
  too. The fix is the void (T-374 S7) and a fresh build.
- **A `found: false` sold-items feed plans empty only on a ₱0 day (✎S5L-R, I5).** POS answers `found: false` for a day
  with no receipts; an empty plan is right only when the day's own `total_sales` is 0. On a day with sales it is the
  ✎N1 shape again (silent empty usage), so it refuses. The parser stays pure; `buildPlan` makes the call.
- **A pull made before S5-lite** (`pos_v1_day_feed_id` null) is refused at finalize and fixed by building the plan
  again. Production holds only empty pulls, if any.
- **The void (T-374 S7) is unchanged** (`voidPosUsagePull`, `usage-pull.ts:402-445`): it reads no feed. A void frees the
  date (R11, the partial unique index `pos_usage_pulls_store_day_live_key`), and the next plan reads and pins the
  latest feed.
- **Permissions unchanged:** plan `record_stock_movement` (`usage-pull.ts:162`), finalize `finalize_pos_usage_pull`
  (`:258`), void `void_usage_record` (`:415`). No new capability (I2).
- **Told, not asked (DEF-595 and POS v1's refunds):** POS v1's sold items count add-on lines only
  (`POS/src/lib/analytics/sold-items-core.ts:113`), so this pull never depletes what a package (unli) table eats; that
  stock is measured by counts (DEF-595; fixed at ADR-015 P1/P2, when every menu item carries a depletion rule). **Refunds
  and voids (✎S5L-R, corrected):** POS drops voided receipts (`sold-items-core.ts:102`) and nets every refund receipt
  with sign −1 against the sold items of the REFUND's date (`:106-134`). So a refunded item that also sold that day
  silently reduces that day's usage: an automatic put-back, contrary to Ian's Q-B ruling (bible row 282: a manager or
  admin decides each refunded item; nothing is restocked automatically). Only when the refunds exceed that day's sales
  of the item does the quantity go negative; the plan shows it and finalize skips it (`usage-pull.ts:329`). This is an
  interim limitation of POS v1's report, not fixed here: the next count shows the difference as variance, and P2's
  pending-restock queue (one decision per refunded or voided receipt line) replaces it.

**BUILDER:**
- `packages/domain/src/pos/v1-sold-items.ts` (new, pure, no I/O). Reads fields only through `POS_V1_SOLD_ITEMS_FIELDS`
  (`packages/db/src/pos-v1/wire.ts:41-52`, R12):
  - `soldItemsFromFeed(payload: unknown): { ok: true; items: PosSoldItemInput[] } | { ok: false; raw: string }`.
    `found === false` → `{ ok: true, items: [], found: false }` (every ok result carries `found`; the ₱0 rule is
    `buildPlan`'s, not the parser's). Otherwise
    `items` must be an array; each entry needs a non-empty string item key and a finite JSON **number** physical
    quantity exact to 3 dp (`quantity()`, `packages/domain/src/stock/quantity.ts:54`; negatives accepted, see above);
    the name is the item's string name, else the key. Two entries with one key are summed. Anything else →
    `{ ok: false, raw }` naming the failing field and index. Returns `PosSoldItemInput` (`plan.ts:48`).
  - `sameItemsProjection(a: readonly PosSoldItemInput[], b: readonly PosSoldItemInput[]): boolean`: true iff both have
    the same set of item keys with equal quantities (compared with `compareQuantity`); names, order and every other
    field are ignored.
- `packages/domain/src/pos/usage-pull.ts`:
  - Delete `PosSoldItemSnapshot`, `FetchPosSnapshot`, `fetchPosSoldItemsLive` (`:44-85`), the `env` import (`:30`), and
    the 4th parameter of `buildPlan` (`:160`) and `finalizeSections` (`:254`). `rebuildLines` (`:90-113`) takes
    `posItems: readonly PosSoldItemInput[]` in place of `fetchSnapshot` and reads only maps and recipes. Rewrite the
    header's "re-fetches POS live" paragraph (`:9-14`) to "re-reads the pinned stored feed"; T-373 R2's "after the
    fetch" comments (`:115-119`, `:189`, `:277-279`) say "first, then read".
  - `buildPlan` order: `authorize('record_stock_movement')` (unchanged) → the day read and its existing refusals
    (`:164-171`, unchanged) → **the link** (`posV1Repo.getLinkByStore`; none → the unlinked sentence) → **the source**
    (`legacy_typed` → the typed-day sentence) → the existing live-pull checks (`:173-185`, unchanged) →
    `lockDayOutcome` → the pull lock and its re-checks (`:195-202`, unchanged) → `latestForDay(…, 'sold_items')`
    (none → `internalFault`: unreachable, the import writes both kinds, `import.ts:200-212`) → **when the locked pull
    has a finalized section** (`finalizedSections.length > 0`, `:201`): read the pin from the LOCKED row
    (`getPullForUpdate`); pin null → the no-pin partly-posted sentence; latest ≠ pin and (latest unreadable or a
    different items projection) → the partly-posted sentence; nothing written either way; otherwise the feed used
    below is the PIN and the pin is kept → `soldItemsFromFeed` (refused → the unreadable sentence) → `found: false`
    and the day's `totalSales` ≠ 0 → the no-items sentence (`found: false` on a ₱0 day → zero lines, `ok`) →
    `rebuildLines` → `insertPull` / `refreshPlannedPull` with `posV1DayFeedId` = that feed's id → `replacePullLines`
    (unchanged). The ok outcome gains
    `soldItemsFeed: { id: string; fetchedAt: Date; purpose: PosV1FeedPurpose }`.
  - `finalizeSections` order: `getPull` → `authorize('finalize_pos_usage_pull')` → void and `SNAPSHOT_STALE` checks
    (`:260-267`, unchanged) → the day read → `lockDayOutcome` → the pull lock and void re-check (`:280-282`) →
    **the pin is read from the LOCKED row** (`getPullForUpdate`, `:280`), never from the unlocked `getPull` (`:256`) →
    pin null → the rebuild sentence → `getFeedById(pin)`; defence in depth (no mutant claimed): the pinned row must be
    `kind = 'sold_items'` with the pull's store and the sales day's business date, else `internalFault` →
    `soldItemsFromFeed(pin)` (refused → the unreadable sentence) → `latestForDay(…, 'sold_items')`; if the latest is
    not the pinned row: latest unreadable → the unreadable sentence (✎S5L-R: never "no change"), else
    `!sameItemsProjection(latest, pin)` → the changed sentence; either way nothing posted, no section stamped →
    the pin's items → `rebuildLines` → **from `PLAN_CHANGED` (`:284`) to
    the end (`:379`) unchanged.**
  - Every refusal stays a `{ ok: false, reason }` Outcome (this module's convention). Sentences, word for word
    (`{Store}` = the store's name; dates via `humanDate`):
    - unlinked: *"{Store} isn't linked to a POS store yet, so its usage can't be pulled. An admin links it under
      Settings › POS link."*
    - typed day (Q-D): *"{Store}'s sales for {d MMM YYYY} were typed in before it was linked to POS, so there are no
      POS sold items to pull. Record that day's usage by hand under Inventory › Usage & wastage."*
    - changed: *"POS's sold items for {d MMM YYYY} changed after this plan was built. Build the plan again."*
    - pre-S5-lite pull: *"This plan was built before usage read POS's stored sold items. Build the plan again."*
    - partly posted, feed changed (✎S5L-R): *"POS's sold items for {d MMM YYYY} changed after part of this pull was
      posted. Void the pull and build the day again."*
    - partly posted, no pin (✎S5L-R): *"Part of this pull was posted before usage read POS's stored sold items. Void
      the pull and build the day again."*
    - no items on a day with sales (✎S5L-R, I5): *"POS sent no sold items for {d MMM YYYY}, but the day has ₱{total}
      in sales, so usage can't be pulled. Tell the office."* (`₱{total}` formatted through `@shareat/core/money`)
    - unreadable: *"POS's stored sold items for {d MMM YYYY} can't be read, so usage can't be pulled. Tell the
      office."* (the raw half, logged, names the feed id and `raw`).
  - `voidPosUsagePull` (`:402-445`): no change.
- `packages/db/src/repo/pos-mapping.ts`: `pullColumns` (`:268-279`) and `PosUsagePullRow` gain `posV1DayFeedId`;
  `insertPull` (`:329`) and `refreshPlannedPull` (`:346`) take and write `posV1DayFeedId: string`. No other change.
- `packages/db/src/repo/pos-v1.ts`: **no change** (`latestForDay`, `getFeedById` are used as they are).
- `apps/erp/src/app/inventory/pos-usage/lib.ts`: `PullView` gains `soldItemsFeed: { fetchedAt: Date; purpose:
  PosV1FeedPurpose } | null`, read in `pullView` (`:71-112`) with `posV1Repo.getFeedById`. `buildPlanForDay` (`:39-45`)
  unchanged (it never passed a fetcher).
- `apps/erp/src/app/inventory/pos-usage/page.tsx:254-256`: the snapshot line becomes *"Built {time} from POS's sold
  items fetched {time} (at import)."* or *"… (at a later check)."* for `recheck`, followed by *"A plan older than an
  hour is refused at finalize."*; with no feed: *"Built before usage read POS's stored sold items — build the plan
  again before finalizing."* Times via `formatBusinessDateTime`. `actions.ts`: no change.
- `packages/domain/src/index.ts:98` (`export * from './pos/usage-pull'`): no change; the three deleted names simply stop
  being exported. `v1-sold-items.ts` is not exported. `pos/sales-pull.ts`'s comment naming `fetchPosSoldItemsLive`
  is left for S6, which deletes that file.

**TESTER (first; builder after):**
- New: `packages/domain/tests/unit/t375-s5-sold-items.test.ts`, `packages/domain/tests/integration/t375-s5-usage-from-feed.test.ts`,
  `apps/erp/tests/integration/t375-s5-pos-usage-page.test.ts`, `tests/unit/t375-s5-no-live-usage-fetch.test.ts`, and the
  helper file `packages/domain/tests/integration/_fixtures/pos-sold-items.ts`:
  `insertRecheckBatch(tx, { orgId, storeId, businessDate, posStoreId, fetchedBy, soldItems, fetchedAt? })`, which writes
  a `recheck` batch holding BOTH kinds (✎V11; the `sales` body copied from the day's basis feed) through
  `posV1Repo.insertBatch`. **`_fixtures/pos-day.ts` is not edited** (S4's tester owns it now; S4 and S5-lite stay
  file-disjoint); its `linkTestStore` and `importTestDay(…, { soldItems })` are used as they are.
- Convert (assertions stay; every changed file and assertion reported): `packages/domain/tests/integration/pos-usage-pull.test.ts`,
  `t374-s7-void-pos-usage-pull.test.ts`; `apps/erp/tests/integration/t373-s1-pos-usage-picker.test.ts`,
  `t374-s7-pos-usage-void-action.test.ts`; and **only the usage legs** of `t373-s1-voided-day-writers.test.ts` (✎S5L-R:
  T4 `:318-341`, T5 `:343-382`, T8 `:430-452`, T10's buildPlan leg `:494`, T12 `:507-581`), moved onto a SECOND,
  LINKED store in that file; its typed-path wastage, withdraw and race legs (T1–T3, T6, T7, T9, T10's wastage leg) stay
  exactly as they are. Each converted file links its store with `linkTestStore` and makes its day with
  `importTestDay(…, { soldItems })` in place of `createSalesDay` + an injected snapshot. A leg that changed the snapshot
  between plan and finalize to make `PLAN_CHANGED` now changes the MAPPING instead (a changed snapshot hits the
  changed sentence first). A leg that voided the day from inside the injected fetcher (there is no fetcher) is recast
  as the day voided before the call. `SNAPSHOT_STALE` legs (`pos-usage-pull.test.ts:333-346`,
  `t374-s7-void-pos-usage-pull.test.ts:757`) stay.
- `apps/erp/tests/t343-s7-wrapper-refusals.test.ts` mocks `buildPlanForDay` / `finalizeSections`: expected unchanged;
  report if not.

**Tests.** Fixture for U-tests unless stated: a linked store; maps `A` → item Cheese direct ×1, `B` → item Buns direct
×0.5; day D imported with sold items {A: 3, B: 2} (the import's `sold_items` row = F1); `fetch` stubbed with
`vi.stubGlobal` to a spy that records calls and throws; `POS_API_URL` unset.
- SI1 (unit): `{ found: true, items: [{ key a, name 'A', physicalQty 3 }, { key b, no name, physicalQty 2.5 }] }` →
  `[a 'A' 3, b 'b' 2.5]`. Two entries for `a` (1, 2) → one `a` 3. `physicalQty −2` → accepted as −2 (control for SI3).
- SI2 (unit): `found: false` → `ok`, `[]`, `found: false`. Control: SI1's result carries `found: true`.
- SI3 (unit; positive control SI1): refused, each naming its field: payload `null`; `items` not an array; an empty key;
  `physicalQty` `"3"` (a string); `physicalQty` 1.2345 (not exact to 3 dp).
- SI4 (unit): `sameItemsProjection` true for {A 3, B 2} vs {B 2, A 3} with different names and billable quantities;
  false for {A 4, B 2}; false for {A 3} vs {A 3, B 0} (key sets differ).
- U1 (red on HEAD): `buildPlan` on D → lines direct:A 3, direct:B 1.000; the pull's `pos_v1_day_feed_id` = F1;
  `soldItemsFeed` = { F1, F1's `fetched_at`, `import` }; the fetch spy recorded **0** calls. `finalizeSections`
  (direct, both keys) → one usage record at the pull's location, Cheese 3 and Buns 1.000, dated D; 0 fetch calls.
- U2 (red): a recheck batch for D with {A: 4, B: 2} inserted after F1 (row F2) → `buildPlan` pins F2 and plans A 4.
  Control: with no recheck, U1's pin is F1.
- U3 (red, ✎W5): plan on D (pinned F1); then re-import D with {A: 4, B: 2} (row F3) → `finalizeSections` → the changed
  sentence; 0 usage records; no section stamped. Control 1: re-import with IDENTICAL items {B 2, A 3} (row F3′) →
  finalize posts Cheese 3. Control 2: after F3, build again (pin = F3, the refresh rewrites the pin) → finalize posts
  Cheese 4.
- U4: finalize U1's pull, void it (`voidPosUsagePull`, a manager, a reason) → both records reversed (as built); then a
  recheck F2 {A 5, B 2} and `buildPlan` → a NEW pull pinned to F2, A 5; 0 fetch calls. The voided pull keeps F1.
- U5 (red; Q-D): a store with a VERIFIED typed day (created and verified while unlinked, then `linkTestStore`) →
  `buildPlan` → the typed-day sentence; no pull row. Control: the same store's imported day D′ → plans.
- U6 (red; R9): an unlinked store's typed open day → the unlinked sentence; no pull row; 0 fetch calls. Control: U1.
- U7 (red): a planned pull with `pos_v1_day_feed_id` null (made by raw SQL as the test's own fixture: a pre-S5 pull) →
  `finalizeSections` → the pre-S5-lite sentence; nothing posted. Control: `buildPlan` again → pinned F1 → finalize posts.
- U8 (red; lock order): plan on open day D (pin F1). Connection B: begin; `reimportSalesDay` with {A: 4, B: 2},
  uncommitted (it holds D `FOR UPDATE`). Connection A: start `finalizeSections`; wait until `pg_stat_activity` shows A
  waiting on a lock; commit B → A returns the changed sentence; 0 usage records.
- U9: a `sold_items` row for D whose `physicalQty` is `"x"` (inserted through `posV1Repo.insertBatch` as a recheck) →
  `buildPlan` → the unreadable sentence; no pull row. Control: U1.
- U10 (✎S5L-R, I5): a ₱0 imported day (sales P 0, no methods) whose `sold_items` row is `found: false` → `buildPlan` →
  `ok`, zero lines, pinned to it. Negative: day D (₱1,100.00 in sales) with a later `found: false` recheck → the
  no-items sentence naming ₱1,100.00; no pull row.
- U12 (✎S5L-R, red): plan D (pin F1); finalize Direct (Cheese 3 posted); re-import D with {A: 4, B: 2} (F3); Recipe
  finalize → the changed sentence; `buildPlan` again → the partly-posted sentence; the pin is still F1; no line
  rewritten. Positive control: re-import with IDENTICAL items (F3′) → `buildPlan` → `ok`, the pin stays F1 (not F3′),
  the Direct lines and their usage-record links untouched (T-374 S7 T13's invariant), and Recipe then finalizes.
  Leg b: a partly finalized pull with a null pin (raw SQL fixture) → the no-pin partly-posted sentence.
- U13 (✎S5L-R): plan D (pin F1); then a recheck whose `physicalQty` is `"x"` → `finalizeSections` → the unreadable
  sentence; 0 usage records; no section stamped. Control: a readable identical recheck → finalize posts.
- U11 (I1, I2): a person without `record_stock_movement` on an UNLINKED store → `AuthorizationError` (not the unlinked
  sentence); without it on D → `AuthorizationError`, no pull row. With `record_stock_movement` but not
  `finalize_pos_usage_pull` → finalize ✗; control: the manager posts (U1). Void ✗ without `void_usage_record`
  stays in the converted `t374-s7-void-pos-usage-pull.test.ts`.
- W1 (apps, `t375-s5-pos-usage-page.test.ts`): with `fetch` stubbed to a recording spy, `buildPlanAction` on D redirects
  with "Plan built"; the page for the pull shows *"from POS's sold items fetched"* and *"(at import)"*; after a recheck
  and rebuild, *"(at a later check)"*; 0 fetch calls throughout. Negative: an unlinked store → the redirect carries the
  unlinked sentence.
- G5 (red on HEAD; unit, pure `fs`): `packages/domain/src/pos/usage-pull.ts` contains no `fetch(`, no
  `@shareat/core/env` import, no `fetchPosV1Day`, no `POS_API_URL`. Positive control: the scanner flags a fixture
  string `await fetch(` and `import { env } from '@shareat/core/env'`.

**Mutants (each killed by the named test):**
- Plan pins the day's IMPORT feed only (ignores rechecks) → U2.
- Finalize skips the newer-feed check → U3.
- Finalize refuses on any newer feed (no projection) → U3 control 1.
- `refreshPlannedPull` keeps the old pin → U3 control 2.
- The newer-feed read moved before `lockDayOutcome` → U8.
- Typed-day check removed → U5 (reaches the `internalFault`, not the sentence).
- Link check removed → U6 (the typed-day sentence instead of the unlinked one).
- Link check before `authorize` → U11's first leg.
- A null pin falls back to `latestForDay` → U7.
- `found: false` treated as unreadable → SI2, U10's positive leg.
- `found: false` plans empty whatever the day's sales → U10's negative leg.
- A rebuild of a partly finalized pull re-pins to latest → U12 (the pin stays F1 in its control).
- A partly finalized rebuild refuses even on identical items → U12's positive control.
- An unreadable newer feed at finalize treated as "no change" → U13.
- Quantities rounded instead of refused → SI3 (1.2345).
- Projection compares names → SI4's first leg.
- A live fetch reintroduced in plan or finalize → U1's zero-call legs and G5.

**Migration:** none. Proved not needed: the pin column exists (`schema/pos-mapping.ts:190`, 0183), the feed rows are
already written by every import (`import.ts:200-212`), the lookup and its index exist (`repo/pos-v1.ts:275`,
`schema/pos-v1.ts:128`), and no CHECK or trigger changes (`purpose = 'usage'` stays allowed and unwritten). **0186 stays
free.** Gate: typecheck, unit, and the usage-pull and `t375-*` integration files on a fresh lane DB; the FULL suite is
not required (no migration), and S5-lite is frozen while S4's full-suite gate runs.

**Smoke (9008, the dev fake POS from S3: `POS_FAKE_ENABLED=1`, `POS_API_URL=http://localhost:9008/api/dev/fake-pos`,
`apps/erp/dev-fixtures/pos-v1/fake-lipa/`):** with Fake Lipa linked and `item-a` mapped direct, import 2026-10-05
(`2026-10-05.sold-items.json`: item-a 3). `/inventory/pos-usage` → Build plan → item-a 3 and *"fetched … (at import)"*;
the dev server log shows **no** `/api/dev/fake-pos` request during Build plan or Finalize. Before finalizing,
edit the JSON to 4 and Re-import the (open) day; Finalize the old plan → the changed sentence; Build again → 4;
Finalize direct → one usage record of 4. Void the pull → Build again → a new pull from the newest feed. Set
`POS_FAKE_ENABLED=0`: Build plan on an imported day still works (nothing is fetched). An unlinked store's typed day →
the unlinked sentence. Screenshots.

---

## S6: rechecks, drift findings, the correction, the corrected-day void, T-210
> ✎S6-A 2026-10-05 (orchestrator rulings on the S6 audit): (2) drift projects payment-method keys normalized exactly as the tender resolver does, so a relabel is not drift; a method-mix-only change says so in the detail; the rare residue (a change that routes to identical lines) is a known limit. (3) the import's 7-day recheck runs under the import's own capability, not verify_sales_day (it stores feeds and posts nothing). (5) a correction derives against the DAY's own remitted channel row, not the link's current channel; a tender remapped to a DIFFERENT money account after verify reclasses that wallet inside the correction (Ian told). (8) a recheck whose sales fetch is found:false on a verified day with sales is not stored; a warning is logged. Also: the correction re-checks wallet accounts are active; corrections are ordered exactly; the recheck runs after the response (Next after()).

> ✎ 2026-10-05 (from the S5-lite audit): **the recheck's feed insert must hold the day FOR UPDATE, as the import does (`import.ts:195`).** S5-lite's U3/U8 serialization relies on every feed insert taking the day lock; a recheck that does not can commit a feed between usage's `latestForDay` read and its post, unseen. Add a test that a recheck waits on a held day lock.

**Goal:** a POS change after verify is visible as a finding and fixable by a correcting entry in an open month; usage
drift is visible and fixed by a pull void; voids and reports stay right.

**BUILDER:**
- `packages/domain/src/pos/v1-recheck.ts` (R10): `recheckPosDay(actor, { salesDayId }, fetchers)` and
  `recheckRecentDays(actor, storeId, beforeDate, fetchers)`; no `tx` parameter; authorize-and-read transaction, fetches
  with nothing open, one write transaction; each batch holds both kinds; POS is called with the basis feed's
  `pos_store_id`. `actions.ts`: `importSalesDayAction` calls `recheckRecentDays` after its transaction commits (errors
  logged); a **Check POS again** action on the day page and the T-210 screen.
- `packages/db/src/repo/findings.ts`: `posDayFeedDrift` and `posDaySoldItemsDrift` (R10; projections built from the
  wire constants via `payload -> ${key}`), registered in `domain/src/findings/index.ts`. Details:
  *"{Store}'s POS figures for {d MMM YYYY} changed after the day was posted: ₱a paid then, ₱b now. Post a correction
  from the day's page."* and *"{Store}: POS's sold items for {d MMM YYYY} changed after usage was posted. Void the POS
  usage pull and pull it again; the new pull reads the latest check."*
- `packages/domain/src/sales-days/correction.ts`: `postPosCorrection` (R10). Sentences: no change → *"POS's figures for
  {d MMM YYYY} haven't changed since they were posted."*; early date → *"A correction can't be dated before the day it
  corrects ({d MMM YYYY})."*; repeated → *"That POS check has already been posted as a correction."*
- `sales-days/verify.ts` `voidSalesDay`: reverse the correction entries too (R10, ✎V3).
- `repo/reports.ts`: corrections in modes and the "POS corrections" channel line, by `source_id` (R14, ✎W8).
- `packages/domain/src/reports/pos-day-reconciliation.ts`, the T-210 page and card: "At import" (basis) beside "Latest
  check" (stored), the delta, **Check POS again**. No HTTP at render. `pos/sales-pull.ts` deleted.
- day page: a Corrections section (list; for a manager with a drift: date, reason, **Post correction**).
- `docs/POSTING-PATTERNS.md`: `sale.pos-correction` (new posted state minus posted lines, netted per account and
  party, dated in an open month, `source_type 'sale'`, `source_id` = the correction), with C1's lines.

**TESTER:** `packages/domain/tests/integration/t375-s6-drift.test.ts`, `t375-s6-correction.test.ts`,
`apps/erp/tests/integration/t375-s6-reconciliation-web.test.ts`; convert `pos-day-reconciliation.test.ts`.

**Tests:**
- R1 (red on HEAD): verified D1 day; `recheckPosDay` with P 1,000.00 (a voided ₱50 cash receipt, K 550.00) → one
  `posDayFeedDrift`; the recheck batch holds both kinds. Controls: a recheck differing only in guest count → none; an
  unverified day with a newer feed → none (it re-imports).
- R2 (✎V4, red): `importSalesDayAction` for day D on a store with verified feed days D−1…D−8 → one recheck batch
  each for D−1…D−7 (not D−8), written after the import committed; a fetcher that throws for D−3 → D imported, the
  other six rechecked, the error logged.
- R3 (✎W9): relink the store to a new POS id, then recheck an old day → the fetcher receives the OLD id (from the basis
  feed).
- C1 (red): `postPosCorrection` with R1's feed, dated today (open) → Dr 4100 50 / Cr 1110 50; a correction row; the
  finding is gone; the day's figures unchanged.
- C2: the same feed again → *"already been posted"*. C3: a date before the business date → refused; a closed month →
  the posting's closed-period sentence; control: an open month → posts.
- C4: a recheck identical in money → *"haven't changed"*. C5: staff → ✗; manager → ok.
- C6: the new feed has an unmapped method → R3's sentence; nothing posted.
- C7: a Foodpanda row on the day → the delta has no 1220/4150 platform lines.
- C8 (✎V8): a period holding a correction → `getSalesRollup` reconciles, with a "POS corrections" channel line.
- C9 (✎V7): retire the GCash tender after verify, map a new one to the same account, correct → no 1140 line beyond the
  real change.
- V3 (✎V3, ✎W8, red): a corrected verified day is voided → the day entry AND the correction entry are reversed;
  `getSalesRollup` over the date reconciles (correction and its reversal both matched by `source_id`); re-import +
  verify → the ledger's 4100 + 4150 for the date equals the new feed once.
- S1d (✎V11, ✎W5): a finalized pull, then a recheck whose sold items differ → `posDaySoldItemsDrift`. Controls:
  identical items → none; void the pull and pull again (reads the latest feed) → the finding clears.
- W1 (apps): the T-210 page shows "At import" and "Latest check" without calling POS on render (fetch stub records 0
  calls); Check POS again (fetch stubbed) adds a batch and shows the new figures.
- Mutants: detector on `content_hash` → R1's guest-count control; delta sign flipped → C1; correction not moving the
  basis → C1's finding-gone leg; platform composition on one side only → C7; correction add-back by
  `journal_entry_id` → V3's reconcile leg; recheck inside the import transaction → R2's committed-before leg; recheck
  with the link's id → R3.

**Migration:** none. **Smoke (9008):** fake POS: import and verify a day; edit its JSON (P 1,000); Check POS again;
`/findings` shows the drift; post a correction; the finding clears; T-210 shows both columns; void the day → both
entries reversed. Screenshots.

---

## Out of scope
- Receipt, receipt-line, payment and menu tables; the P2 `pos_receipts` source (ADR-015, proposal §11).
- Senior/PWD split, service-charge split, loyalty (4910), comps: arrive with receipts.
- The voided-receipt cash mechanic (DEF-161, `2900` reserved).
- A scheduled import or scheduled recheck (R11).
- Merging the two store records (P1); the link table dissolves then.
- DEF-061's gross-or-net basis: not measurable through the bridge; its "unknown basis blocks" rule is superseded for the
  interim (✎V12, Review log).
- `CAPABILITY-MATRIX.md`: no new capability; the orchestrator adds the `/settings/pos-link` route note.

## Risks
- K1. **No production key = no linked store** (Q1). Unlinked stores keep typing (✎V2b), so nothing stops; DEF-586 stays
  partly open.
- K2. A store with open typed days cannot be linked until they are verified or withdrawn (R13). Linking is planned with
  the store, after S0.
- K3. **The package figure can exceed derived gross** (VAT removed on SC/PWD bills, `tax.ts:135-153`; refunded package
  lines, ✎V1): R4 caps unli at gross and shows the excess. 4100 is overstated by at most the refunded package lines
  and understated by at most the capped excess; totals are right. S0 (c) measures the excess.
- K3b. Refunds go to 4950 out of cash by default (Q3); a refund paid back by wallet shows as a till variance.
- K4. Charges booked to 4500 are wrong if a store bills a service charge (RA 11360, 2160). Q2.
- K5. Fixture churn is limited to linked-store tests (✎V2b); the tester reports every changed file.
- K6. Platform sales stay typed (q1 (b)); the seam is three files (R8).
- K7. Unlinked stores keep typing until linked; the board shows how many remain.

## Done when
- S1–S6 shipped tester-first, each with its reds, controls and mutants; typecheck 0; unit and FULL integration green on
  a fresh gate DB after S1 and after S4; build 0; each slice's 9008 smoke with screenshots.
- On a linked store no screen can type or edit a sales figure, and the trigger proves it in SQL (within R6's stated
  limit); an unlinked store's typed path works and is labelled.
- Production go-live, per store, with Ian: Q1's key installed; S0 run for that store with its gate met (or R4 amended);
  tenders mapped; then the link. The orchestrator records the date per store; the board shows the unlinked count.
- The orchestrator: logs ✎N1 and the three ✎V1 POS defects; marks DEF-586 partly fixed (fully when every active store
  is linked); **updates DEF-061's disposition to cite ✎V12**; updates `docs/CROSS-APP-MAP.md` §1/§1b, ROADMAP, the
  board; reports bible row 271's line citation (✎V13).

## Questions for Ian (Open Questions page)
> **✎ 2026-10-05 — ALL FOUR ANSWERED (bible row 279).** Q1 **new store-scoped key** (ops step; Ian needs the steps before a production link). Q2 **(a) other income 4500**. Q3 **(a) refunds from the cash drawer**. Q4 **no store is VAT-exclusive; VAT is a label only, remitted manually (row 75)** — the VAT-exclusive refusal stays as a never-firing guard. Defaults built so far all stand; nothing to change.

- **Q1 (high; blocks linking any store on production, not building).** v2 reads POS the way v1 does, over POS's
  key-protected API. Does production (`/srv/shareat-shared/.env.local`) already hold `POS_API_URL` and `POS_API_KEY`?
  If not, a new key is needed: a scoped entry in POS's `POS_EXTERNAL_API_KEYS_JSON` listing the store ids, and the same
  value on our server. Example: without it, Import for 5 Jan says "POS couldn't be reached". (a) **Recommended:** a new
  store-scoped key for v2. (b) Reuse v1's key.
- **Q2 (medium; default built (a)).** POS sends one "charges" figure per day, e.g. ₱300 on 5 Jan. (a) **Recommended for
  now:** other income (4500), as v1 counts charges in revenue. (b) The service-charge float (2160, staff's money).
  Does any store bill a "Service Charge" in POS?
- **Q3 (high; default built (a)).** POS v1 does not record which payment method a refund went out of. Example: a ₱300
  GCash bill refunded on 5 Jan; POS's day shows ₱300 less in total but still ₱300 of GCash. (a) **Recommended:** treat
  every refund as paid from the cash drawer; the till count shows it if it went back by GCash. (b) Spread it across the
  day's methods in proportion. (c) Hold refund days until the copied POS records the method (P0); those days wait.
- **Q4 (medium; default built: refuse).** Is any store "VAT exclusive" (VAT added on top) in POS? If one is, where
  should that VAT go: (a) **Recommended:** an output-VAT liability account; (b) revenue, as v1 does. Until answered,
  that store's days refuse to import.
- **Told, not asked (✎V12):** DEF-061's "a day whose gross/net basis is unknown blocks" is set aside for the interim,
  because POS's API can never say which it is and every day would block. The effect is limited to the 4100/4150 split.

## Review log (where each amendment landed)
| Tag | What | Where now |
|---|---|---|
| ✎V1 / ✎W1 | refunds (verified at POS source); cap the package figure instead of refusing | §"what POS does with a refund", R4, S0, S3 D2b/D3/D3r, K3/K3b, Q3 |
| ✎V2 → ✎V2b | branch gate dropped; the store link is the per-store switch | header, Goal, R1, R6, R13, plan, I9/I10, S1/S3/S4, Done when |
| ✎V3 | voiding a corrected day reverses its corrections | R10, S6 V3 |
| ✎V4 | rechecks outside the import transaction | R5, R10, S6 R2, I4 |
| ✎V5 / ✎W4 | flag reset on success only; honest limit; G1 scans the flag | R6, S3 G1, S4 K8/K11 |
| ✎V6 | linked channel cannot flip or retire | S1 builder, L3 |
| ✎V7 | correction delta against posted lines | R10, S6 C9 |
| ✎V8 / ✎W8 | sales-mode report reconciles; corrections matched by `source_id` | R14, S4 P6, S6 C8/V3 |
| ✎V9 | VAT-exclusive stores refuse | R1, R4, S3 D2c, Q4 |
| ✎V10 | channel receivable 1220 | R8, S4 P1, S6 C7 |
| ✎V11 / ✎W5 | recheck batches hold both kinds; usage reads the latest sold items; refuse finalize only on a different projection | R1, R9, R10, S5 U2, S6 S1d |
| ✎V12 | DEF-061 rule superseded for the interim; bound includes refunded package lines | Out of scope, K3, Done when, told-not-asked |
| ✎V13 / ✎W10 | wastage sentence; feed columns; bible citation; fake POS hardened | R1, S3 builder + FP1, S4 builder, Done when |
| ✎W2 | link lookup without SECURITY DEFINER; NULL-org fails closed | R6, S4 K12 |
| ✎W3 | stale text swept: this document is consolidated | whole document |
| ✎W6 / ✎W7 | link refuses open typed days; store-row locks serialize typed create vs link | R13, S1 L4/L5, S3 builder |
| ✎W9 | rechecks and corrections use the feed's stored POS id | R1, R10, S6 R3 |
| ✎W11 | rounding threshold; refunds in their own column; glossary; VAT controls; DEF-061 in Done when | R1, R4, S1 glossary, S3 D2a/D2c |
| ✎Y1 / ✎Y2 | invoker lookup kept; reason corrected (owner bypasses RLS); bypass test is `rolsuper or rolbypassrls` | R6 |
| ✎Y3 | K12 asserts 0 rows; NULL-org guard is defence in depth, no mutant | R6, S4 K12 |
| ✎Y4 | `FOR KEY SHARE` kept as defence in depth; why the trigger cannot backstop; no mutant claimed | R13, S1 L5, S3 mutants |
| ✎Y-minor | fixture owned by the tester; K10 links by raw SQL; explicit REVOKE in 0183; rounding-band limit | plan table, S4 K10, S1 builder, R4 |
| ✎S5L | S5 replaced by S5-lite (rows 281/282): usage reads the latest stored `sold_items` feed (import or recheck), pinned; nothing fetched (live path deleted, ✎N1 gone for usage); typed day and unlinked store refused; finalize refuses only a newer DIFFERENT feed, read under the day lock; `SNAPSHOT_MAX_AGE_MS` and `PLAN_CHANGED` kept; void and permissions unchanged; no migration (0186 free); DEF-595 and later-day refunds told | S5 (supersedes R9, the plan-table S5 row and the Goal's usage bullet where they differ) |
| ✎S5L-R | Independent Opus review of S5-lite (APPROVE WITH CHANGES): (1) a partly finalized pull never re-pins; refuse on a changed feed (U12, mutant); R10 drift widened to any finalized section; (2) `found: false` plans empty only on a ₱0 day, else refused (U10 recast; I5 named in the supersede list); (3) an unreadable newer feed at finalize refuses (U13); (4) pin read from the locked row, pinned row's kind/store/date asserted (internalFault, no mutant); (5) only t373-s1's usage legs converted, onto a second linked store; (6) refunds note corrected: POS nets refunds against the refund date's sales, an automatic put-back contrary to Q-B, interim, caught by counts; (7) "latest" = newest fetch (app clock, uuidv7 tie), concurrent re-import caveat | S5 (Decisions, BUILDER, TESTER, Tests, Mutants), R10 |

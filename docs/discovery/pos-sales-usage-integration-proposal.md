# POS, CUSTOMER and the ERP on one backend: synthesis and proposal

> Opus planner, 2026-10-04, rewritten the same day under Ian's two new directions. Uses the
> `research-evaluate-propose` skill. Research only: it decides nothing and amends nothing. The
> bible and ADR text in §9 is a DRAFT for the orchestrator to apply after Ian agrees.
> **Status: DECIDED 2026-10-04.** Ian ruled pos-q0..q5, Q-A..Q-C; recorded as bible §13 rows 269–273 and
> `docs/decisions/ADR-015-pos-and-customer-on-the-shared-backend.md`. Note pos-q1 went (b), not the recommended (a).
> Ian (verbatim): *"pos v1, customer v1 will also be reworked since we intend them to share same
> backend postgres db shared auth for 3 projects. so the shape of erp shall assume this"* and
> *"im thinking of copying the pos v1 coz i have no issue about it just some hardening and bug
> fixes also with customer app. then improve that and modify so it fits the backend of erpv2"*.

## Summary (read this alone)

1. **This premise is not new. It is ADR-003, accepted 2026-08-23.** That ADR already says one Postgres for four apps,
   revenue posted from the receipt, and the sales pull deleted (`ADR-003:42-47`, row 78). The
   earlier draft of this file reasoned from ADR-005's bridge table and treated the bridge as the design.
2. **Copying POS v1 and CUSTOMER v1 into `apps/pos` and `apps/customer` is the right way to deliver it.** Row 80
   already uses Ian's words *"copy them into a new project"*. Discovery 22 found that the screens are the good part.
   The work is moving the rules out of the browser: 139 POS files import client Firestore, with 233 client write sites.
3. **Swap the data layer by strangler, using the Firestore two-lane edge that already exists.** Postgres takes ownership of one entity at a time.
   The copied POS keeps reading Firestore, which becomes a Lane A mirror. Sales leave the device as Lane B inbox events.
   When the swap ends, Firestore holds only the bible §5 edge, and POS still sells offline.
4. **POS v2 cannot replace POS v1 on Postgres before 1 Jan 2027.** The copy can, but it sits on the same Firebase, so it changes nothing for the books.
   Receipts reach Postgres in Q1 2027 at the earliest.
5. **The interim is the smallest one possible: a "POS v1 day feed".** It is stored as a source document. The sales day is
   DERIVED from it, nobody types or edits a figure, and it retires store by store when receipts arrive.
6. **What the ERP builds now:** the figure lock, the sales day as a derived closing with a `source`, a tender master that
   POS v2 will sell against, and the usage plan read from the stored snapshot. About 6 slices and 2 migrations, before 15 Nov.
   **Not now:** receipt tables, menu tables, a diner principal, offline POS. Their shape comes from the POS ADR, not from guessing.
7. **This supersedes:** ADR-005's sales bridge ("POSv2 is far out"), ADR-003's "never two at once" for the POS+CUSTOMER pair,
   the §5.3 closed hot set and §5.4 rule 1 (for POS only), §8's ports 9003/9004 for `apps/pos` and `apps/customer`, and part of
   §1.2b. Draft rows are in §9.
8. **Five questions for Ian (§10).** Retire pos-q0. Keep pos-q1 to pos-q4, reworded as interim-only. Reshape pos-q5 (we can now fix POS).
   Three are new: when the copied POS goes live, POS and CUSTOMER flipping together, and loyalty across the franchise.

## 1. Verdict

**Build the copy-and-swap.** Phase it as P0 copy and harden, P1 reference data, P2 receipts, P3 live tables with
CUSTOMER. Until P2 reaches a store, run a minimal, derived, non-editable day feed in the ERP. **Do not** build a
receipt-level v1 ingestion (old option B). It would be a third data path, built only to be thrown away.

## 2. The stated reasons, and whether they hold

- *"Shared backend, so the pull can be replaced."* **This holds as the end state. It does not hold for January.**
  The ERP side is unified. The till stays on `shareat-hub-v2` until P2 reaches each store (`CROSS-APP-MAP.md:51-60`).
- *"Copy, because v1 has no issues beyond hardening."* **This holds for the screens, and only half holds for the code.**
  - Discovery 22 §1 lists most of the app under PRESERVE and calls the staff fluent in it.
  - §1.2c makes POS the presentation benchmark.
  - But the register has **21 open POS/CUSTOMER defects (7 critical)**: DEF-001..005, 007..009, 012..015, 017..019, 021..023, 025, 342, 343.
  - Discovery 22 §0 counts **73 client files writing straight to Firestore**. The 1,526-line sale engine runs in the
    browser (`POS/src/components/cashier/firestore.ts`).
  - "Some hardening" is accurate for the UI. It understates the data layer, which **is** the project.

## 3. What exists

### Already built in v2 that fits three apps

| Piece | Where | Fit |
|---|---|---|
| One identity spine | `persons` (`schema/persons.ts:20`), `person_identities` kinds `firebase_uid, phone, email, staff_no, device_hash` (`:66`) | Already has `phone` and `device_hash`, the diner identities CUSTOMER uses |
| Credentials and auth sessions | `person_credentials` kind `pin, firebase, biometric` (`schema/sessions.ts:54`); `sessions` bound to `store_id` and `device_id` (`:196-240`) | This is POS's PIN login done right (bible §7.1, ADR-002 §2). POS v1 keeps it in `localStorage` |
| Authorization | `authorize()` (`packages/auth/src/authorize.ts:106`), capabilities | Shared as-is |
| Tenancy | org RLS, principal `staff, customer, system` (`packages/db/src/rls/principal.ts:19-24`); registry (`rls/registry.ts`); cutover classification | `customer` means a **wholesale buyer**, not a diner |
| Firestore edge | `packages/sync-firestore` publisher and ingestor; device identity and rules (T-159, built); quarantine | Built for the clock. It can carry POS |
| Item master | `items.sellable_retail` (`schema/items.ts:117-119`, "POS owns the menu"); `pos_item_maps` direct, recipe or no_stock (`schema/pos-mapping.ts:65-109`) | The mapping becomes the menu item's depletion rule |

### What v2 lacks

- No order, receipt, payment or refund tables.
- No menu or price-list for the till.
- No diner principal. ⚠️ `persons.org_id` is NOT NULL (`persons.ts:24`), while a loyalty diner today spans every store,
  including the franchise org (ADR-008). See Q-C.
- No POS offline ADR (discovery 22 §4).
- POS has no hot-set entries (bible §5.3).
- ⚠️ **Name clash:** `sessions` already means AUTH session in v2, and *session* means a table of diners in POS
  (`GLOSSARY.md:80-84`). The copied POS's data layer must call the diner one `table_sessions`.

### The current sales and usage seam (the interim's starting point)

- **Figures are typed.** `createSalesDay` (`packages/domain/src/sales-days/create.ts:121`) takes every figure from the
  form. `posSourced` is a checkbox (`SalesDayForm.tsx:238`) checked against nothing.
- **Figures can be edited.** `editSalesDay` (`sales-days/edit.ts:30`).
- **POS is called only to compare, and to pull usage.** `fetchPosSalesLive` (`packages/domain/src/pos/sales-pull.ts:26`);
  `fetchPosSoldItemsLive`, `buildPlan`, `finalizeSections` and `voidPosUsagePull` (`pos/usage-pull.ts:63,156,250,402`);
  migration 0181 is on production.
- **POS v1 exposes 8 read-only endpoints and no receipt endpoint** (`POS/src/app/api/external/*`).
  - The daily feed gives one `discountsTotal` (`sales/route.ts:93-94`).
- **There is an existing per-receipt Postgres archive design.** `webapps/POS MIGRATION` (`schema.sql`, `scripts/backfill.ts`)
  maps receipts, lines and session-nested payments, offline `OL` receipts included.
  - It is **reference** for P2's mapping. It is not a dependency.

### What the copy brings (measured 2026-10-04)

| | POS (`sev5_advanced`) | CUSTOMER (`main`) | `apps/erp` |
|---|---|---|---|
| next / react | 16.1.6 / 18.3.1 | **15.5.9 / 19.2.1** | 16.1.6 / 18.3.1 |
| firebase / admin | **10.12** / 13.6 | 11.10 / 13.7 | 11.10 / 13.0 |
| tailwind / capacitor | 3.4 / **6.0 (APK, printers)** | 3.4 / none | 3.4 / none |
| src files | 639 (~98,900 LOC, discovery 22) | 256 | |
| files importing client Firestore | **139** | 10 | |
| server files on the Admin SDK | 68 | 31 | |
| client Firestore call sites (writes) | **494 (233)** | 39 (32) | |

- **POS is in lockstep with `apps/erp`.** It needs one SDK bump.
- **CUSTOMER is a Next 15/React 19 app.** It must align with the monorepo's React. Copy it later, at P3.
- **Offline in POS** comes from Firestore `persistentLocalCache` (`POS/src/lib/firebase/client.ts:18`) plus the `OL`
  writeBatch path (`offlinePayment.ts:42-244`).
- **CUSTOMER's server routes are already server-side.** The swap there is mostly Admin SDK calls becoming
  `packages/domain` calls. Most of the risk is in POS.

## 4. What the industry does, and open source

- **Offline selling is store-and-forward:** a local queue of completed sales keyed by a device-generated id, pushed when online.
  - Square offline payments: https://squareup.com/help/us/en/article/7777
  - Toast offline mode: https://central.toasttab.com/s/article/Offline-Mode
  - Odoo POS keeps orders in the browser and syncs them by uid (LGPL-3):
    https://github.com/odoo/odoo/tree/master/addons/point_of_sale
  - ERPNext POS does the same (GPL-3).
- **Posting is a daily summary over per-sale documents.** ERPNext POS Closing Entry:
  https://docs.erpnext.com/docs/user/manual/en/pos_invoice_consolidation
- **Refunds are reversing documents.** Nobody edits a closed sale.
- **Stock is depleted by recipe from item sales**, compared against counts.
- **Open source: nothing to adopt.**
  - Odoo and ERPNext POS are tied to their own ORMs. ERPNext is copyleft.
  - The pattern they prove (an idempotent outbox of finished sales) is exactly Lane B. **Firestore's offline persistence
    is the queue** (https://firebase.google.com/docs/firestore/manage-data/enable-offline), and the copied POS already depends on it.

## 5. Target shape the ERP assumes

| Entity | Owner | Note |
|---|---|---|
| Table session, order, kitchen ticket | **POS** (CUSTOMER writes orders through the same domain functions) | Online-only state in Postgres at P3. Fixes DEF-007's six dual-written collections by construction |
| **Receipt, receipt line, payment, refund** | **POS, source documents, immutable** | A refund is a new receipt with `parent_receipt_id`. There is **no post-close edit or void** (Ian's ruling), and the copy removes them in P0 |
| Receipt numbering | POS | `(device_id, local_seq)` plus a server sequence (ADR-003, DEF-001/002) |
| **Sales day** | **ERP, derived** | A closing over a `source`: `pos_v1_day_feed` until P2, then `pos_receipts`. Figures are written only by the derivation. Verify posts as today. Drift becomes a T-135 finding |
| Stock usage | ERP, derived | From receipts times the depletion rule. The pull and its button retire at P2 |
| Menu, prices, tenders, discounts | ERP reference data | Mirrored to the till by Lane A. `sellable_retail` and the depletion rule live on the item |
| SC/PWD name and ID | Captured at POS (row 218) | Carried on the receipt. This unblocks T-137's ERP half at P2 |
| Retail diner and loyalty | CUSTOMER and POS | A **person** with a `phone` identity. **Not** an AR customer (`schema/customers.ts:4-11`). Points and redemptions become ledgered rows; points redeemed post to 4910 |
| People, credentials, auth sessions, PINs | Shared spine | One `authorize()`. Firebase Auth is one credential kind. ⛔ Diners do NOT become Firebase users (DEF-343 minted 7,000 of them) |
| Tenancy | org and store, RLS | A new `diner` principal is needed (Q-C) |

## 6. Offline: the recommendation and what it costs

**Recommendation: the existing two-lane Firestore edge, with one write path for a finished sale.**

- **The device always writes a completed sale as a Lane B event, online or offline.** Online, it is ingested in seconds.
  Offline, the event waits in Firestore's local cache and replays on reconnect.
  - The idempotency key is `(device_id, local_seq)`.
  - The server **recomputes the bill from the lines and compares** (discovery 22 §4). A mismatch is a finding, never a silent accept.
- **Lane A mirrors what the till needs to sell:** menu, prices, tenders, the discount list, the store config, and the
  cashier roster. The roster carries no PIN hashes.
- **Offline scope:**
  - A cashier already signed in keeps selling.
  - There is **no offline sign-in**.
  - KDS and CUSTOMER ordering pause, because CUSTOMER is online-only (row 77).
  - This matches v1, whose offline path only completes payments.
- **Why this over a hand-rolled IndexedDB queue:** §5.2 already chose Firestore over v1's hand-rolled queue for the clock,
  T-159 device identity and the ingestor are built, and the copied POS already runs on it. Two edges would be two of everything.
- **Cost:**
  - Firestore remains a Google dependency for the till.
  - The hot set grows by about 5 entries.
  - §5.4 rule 1 needs a POS carve-out. The device RECORDS a sale; it does not adjudicate one.
  - One ADR, about 3 slices of rules, mirror and ingestor work on top of what exists.
- **Rejected:**
  - A local Postgres per store (row 77).
  - Server Actions on the sale path, because they cannot run offline (§5.2).

## 7. Sequencing against 15 Nov and 1 Jan

**Can a copied POS replace POS v1 on Postgres before 1 Jan? No.**

- Nothing reaches Postgres until P1 and P2 are done: about 15–18 slices plus an ADR, on top of a Phase 2 that is still
  closing for the 15 Nov go/no-go.
- ADR-005's December is the 2026 close and the dual-run.
- **December is also the restaurants' peak, and a till change then is the worst-timed risk in the plan.**

| Phase | When | Slices (estimate) | Delivers |
|---|---|---|---|
| **E: ERP now** | before 15 Nov | **6, 2 migrations** | E1 `pos_v1_day_feeds` source document (raw payload, hash, fetched by and at, kind `sales` or `sold_items`); classification and RLS · E2 tender master: money account, plus `pos_v1_alias` for the feed. An unmapped tender **refuses** the import · E3 `importSalesDay` derives figures from the feed (button; re-import while unverified, audited) · E4 lock: form inputs, `posSourced` checkbox and figure edit removed; trigger refuses figure UPDATE outside the derivation; CHECK `source is not null` on new days; log the checkbox as a section-E defect · E5 the usage plan reads the stored `sold_items` feed · E6 drift after verify becomes a finding; T-210 screen becomes "POS now vs at import"; suite and smoke |
| **P0: copy and harden** | start after 15 Nov; **live after 1 Jan (Q-A)** | 8–10 | `apps/pos` copied at a pinned commit; new port; firebase 11; builds in CI; Capacitor APK pipeline; fix the critical register rows in the copy (DEF-001..004 money/numbering, DEF-012/014/015 rules/env, DEF-017 reachability); remove post-close edit and void; capture SC/PWD name and ID. **Still on `shareat-hub-v2`** |
| **P1: reference data and auth** | Q1 2027 | 6–8 | ADR-015; T-309 project (§8); Postgres owns stores, staff, PIN sessions, menu with depletion rule, tenders, discounts; Lane A publishes them into the till's Firestore |
| **P2: receipts** | Q1 to Q2 2027 | 8–10 | Lane B sale event → `receipts`, lines, payments, refunds; recompute and compare; sales day `source = pos_receipts` per store; usage from receipts; **the day feed and the usage pull retire for that store** |
| **P3: live tables and CUSTOMER** | Q2 2027 | 10–15 | Table sessions, orders and KDS in Postgres (online); `apps/customer` copied, aligned to the monorepo React, swapped; loyalty ledgered; `shareat-hub-v2` retired |

**Side by side during the swap: yes, by owner and never by dual-write (§15.4).** Each entity flips its owner once.
Before the flip, Firestore is the truth for it. After the flip, Postgres is, and Firestore is a mirror (A) or an inbox (B)
for it. A store flips at P2 as a unit, behind a per-store flag (row 20).

**Nothing built in E is torn out.**
- The lock and the derived-closing contract are the end state.
- The tender master is the till's tender list.
- The feed table freezes as archived source documents for the 2027 days it posted (invariant 4).
- Only `importSalesDay`'s fetcher and the usage pull's fetcher are deleted at P2.

## 8. Impact on in-flight work

| Item | Call | Why |
|---|---|---|
| T-123 sales day | **Reshape (E3/E4)** | It becomes a derived closing with a `source`. Verify and posting are unchanged |
| T-177 usage pull | **Keep until P2, then retire per store** | `pos_item_maps` survives as the menu item's depletion rule at P1 |
| T-374 S7, `voidPosUsagePull`, migration 0181 | **Keep** | Still needed for a wrong-day or wrong-map pull in the interim. Kept for history after P2 |
| T-150 channel settlement | **Keep** | Platform payouts are external whatever the till is. P2 receipts must carry the channel (DEF-005) |
| T-367 S5 (DEF-054, retire `ar_collection`/`other` methods, 0182) | **Keep** | Expense methods, unrelated to POS. S6 is already withdrawn (`docs/tasks/367-ap-ar-money.md:609`) |
| T-210 reconciliation screen | **Reshape (E6)** | It becomes a drift report |
| Firebase clock terminal | **Keep** | It is the precedent. Its device identity and ingestor are reused by POS |
| T-309 own Firebase project | **Reshape and bring forward to before P1** | The new project becomes the **platform** identity and edge project for all three apps, not ERP-only. Moving it before POS terminals multiply keeps re-issue cheap (row 202). Its precondition still holds: two ways to sign in. Diners stay out of Firebase Auth |
| T-137 SC/PWD register | **Unblocked at P2** | P0 captures the name and ID in the copy |

## 9. Superseded decisions, with draft amendment text

| Rule or ADR | Change |
|---|---|
| ADR-005 bridge table, "Sales … Survives the cutover — POSv2 is far out" (`ADR-005:129`) | **Amend:** the mechanism is a stored POS v1 day feed, derived and never typed; it retires **per store at P2** |
| ADR-003 "never two at once" (`ADR-003:66-82`) | **Amend:** POS and CUSTOMER share 6 collections (DEF-007), so their live table and order state flips together at P3 |
| Bible §5.3 hot set "closed" and §5.4 rule 1 | **Amend:** POS entities added; a till RECORDS a completed sale and the server recomputes and compares |
| §8 ports and both app READMEs (9003/9004) | **Collision:** 9003 and 9004 are POS v1's and CUSTOMER v1's reserved ports (§8: "9002–9007 … off limits"). Give `apps/pos` and `apps/customer` new ports |
| §1.2b "read v1 as requirements, not design"; RULES #1 | **Amend (narrow):** POS and CUSTOMER **UI and interaction** are copied (§1.2c, discovery 22 §1). Their **rules and data layer** stay requirements-only and are rebuilt in `packages/domain` |
| §2 rule 6, no floats (DEF-003) | **Not waived:** the copy violates it until P0 fixes it. P0 is not done while float money remains |

**Draft row 269:** *2026-10-04. POS and CUSTOMER v1 are COPIED into `apps/pos`/`apps/customer` at a pinned commit, then
hardened and swapped onto the shared Postgres and auth by entity-owner flips through the §5 two-lane edge. The
reference repos stay read-only; the copy is this repo's code from the moment it lands. UI is copied (§1.2c); rules
and data are rebuilt as requirements (§1.2b). Ian: "copying the pos v1 … then improve that and modify so it fits the
backend of erpv2". | Discovery 22 §1: the screens are the good part; 139 files of Firestore coupling are the work.*

**Draft row 270:** *The ERP assumes ADR-003's end state now. The sales day is a DERIVED closing over a source (POS v1 day
feed, then receipts); no figure is typed or edited, and a database trigger enforces it. The usage pull, the day feed and
`shareat-hub-v2` retire per store as receipts arrive. Supersedes ADR-005's "far out" sales bridge.*

**Draft ADR-015, "Offline selling on the two-lane edge":**
- Context: discovery 22 §4.
- Decision: §6 of this file.
- Consequences: §5.3 rows 7–11 (menu, prices, tenders, discounts, store POS config); §5.4 rule 1 POS carve-out; receipt
  numbering per ADR-003.
- Written in plan mode before any P1 code.

## 10. Questions only Ian can answer

**Retire pos-q0** (adopt the interim). It is now this sequencing. **pos-q1..q4 stay, reworded as interim-only.**
They stop mattering per store at P2.

- **pos-q1, Foodpanda/Grab through POS: keep.** (a) is recommended: ring every platform order in POS. With POS v2 the
  channel is a receipt attribute.
- **pos-q2, discount split: keep, interim only.**
  - Example: the feed says ₱900 of discounts. (a) is recommended: post one line to 4900.
  - The real split arrives with P2 receipts (row 218).
- **pos-q3, POS changes after verify: keep, interim only.** (a) is recommended: a finding plus a correcting entry. Under P2
  this disappears, because a refund is dated today.
- **pos-q4, POS unreachable: keep.** (a) is recommended: the day waits, with no typed fallback.
- **pos-q5, edits to closed receipts: reshape.** We now own the copy, so the fix is in the code, not a staff policy.
  - Example: a ₱1,200 receipt from 2 Oct is "fixed" on 5 Oct by editing it.
  - (a) **Recommended:** P0 removes post-close edit and void. Mistakes are refunded.
  - (b) Keep void-after-close for managers only, as an audited reversing document.

**New questions:**

- **Q-A. When does the copied POS go live in the stores?**
  - (a) **Recommended:** after 1 Jan, at least one store first. December is peak trade and the 2026 close.
  - (b) In November, before the go/no-go. This competes with Phase 2 for the same lanes.
  - (c) Only at P2, when it also writes Postgres. This means a bigger change in one step.
- **Q-B. POS and CUSTOMER table ordering flip together. Do you accept that?**
  - Today a diner's phone order and the cashier's bill are the same Firestore records.
  - (a) **Recommended:** yes, per store at P3.
  - (b) Keep CUSTOMER v1 on Firestore and bridge it. That is a new integration, the kind ADR-003 deletes.
- **Q-C. Loyalty across owners.** A diner earns ₱50 of points at Lipa (yours) and redeems at Padre Garcia (franchise,
  separate books, ADR-008).
  - (a) **Recommended:** one loyalty programme across all orgs, with points as a liability of the issuing org, settled between orgs.
  - (b) Loyalty per owner.
  - (c) Keep one programme and ignore who owes whom. This is not recommended.

## 11. Not adopting, and why

- **Receipt-level ingestion of POS v1 (old option B).**
  - It needs a production read key into `shareat-hub-v2`, and `.env.example:177` says the deployed app "has no reason to hold" one.
  - It adds change detection for mutated receipts.
  - P2 delivers the same receipts natively, one quarter later.
- **Building receipt and menu tables now.** They would have no writer, and their shape depends on ADR-015. That is
  "built and never called".
- **A big-bang POS cutover, or a till change in December.** Row 20, and peak trade.
- **A hand-rolled IndexedDB queue, or a local Postgres per store.** See §6 and row 77.
- **Diners in Firebase Auth.** DEF-343. Diners are persons with a phone identity.
- **Per-receipt ledger posting.** The sales day stays the posting document (§4).
- **Dual-writing Firestore and Postgres during the swap.** §15.4. Owner flips only.
- **A scheduled automatic import in the interim.** The button stays, and the create-block depends on it (T-123 Open 1).

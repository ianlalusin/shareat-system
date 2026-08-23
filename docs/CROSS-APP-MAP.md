# Cross-app map — POS · ERP · CUSTOMER · Website

> **Living document.** Ian, 2026-08-23: *"document every finding, reference, connection across
> apps — POS, website, ERP and customer; as we go along we will touch them 1 by 1."*
>
> This is the index of every seam between the four applications. It is **added to as work
> touches each connection**, never written once. When you verify a connection, move it from
> ⬜ to ✅ and cite `file:line`. When you find a new one, add a row before you forget it.

> ### ⚠️ This document's purpose changed on 2026-08-23
> The four apps are being rebuilt onto **one shared backend**, so the seams below are no
> longer integrations to maintain — they are a **deletion list**, and simultaneously the
> **requirements inventory** for what the unified backend must absorb natively.
>
> Read every entry as two questions: *what business rule does this encode?* (harvest it) and
> *what plumbing exists only because the apps are separate?* (delete it). Bible §13 row 78.
>
> **Not app-to-app linking, and not for deletion:** the Lane A/B Firestore edge cache, which
> exists for offline POS selling and ERP biometrics only (row 77).

## Maintenance rules

1. **Cite or mark unverified.** Every claim carries a `file:line`, or an explicit ⬜.
   A remembered fact is not a verified one.
2. **Direction matters.** Record who calls whom. "They share data" is not a finding.
3. **Record the contract, not the vibe.** Fields, auth, failure mode.
4. **Never edit ANY of the four reference repos** — `ERP-rebuild`, `POS`, `CUSTOMER`,
   `Shareat Website`. Standing rule, Ian 2026-08-23 (bible §2 rule 1, §13 row 80). They are
   read-only references. Everything is rebuilt in the new project by copying, keeping what is
   clean, cleaning what is not, omitting what is not needed, and adding what is missing.
5. A connection that turns out to matter for the ledger gets a line in `PROJECT_BIBLE.md` §13.

| | Status |
|---|---|
| ✅ | Verified this session, with citations |
| 🟡 | Partially verified — shape known, details open |
| ⬜ | Believed to exist, **not yet verified** — do not rely on it |

---

## The four apps

| App | Folder | Port | Role |
|---|---|---|---|
| **POS** | `webapps/POS` | 9003 | Point of sale. Owns receipts, sessions, daily analytics. Branch `sev5_advanced` |
| **ERP** (v1) | `webapps/ERP-rebuild` | 9002 | Back office, books, payroll, inventory. **READ-ONLY to us** |
| **CUSTOMER** | `webapps/CUSTOMER` | 9004 | Diner-facing ordering, refills, loyalty |
| **Website** | `webapps/Shareat Website` | 9007 | Public site, storefront, reservations (Astro) |
| **Shareat System** | `webapps/shareat-system` | 9008 | **This project.** One backend for all four |

### Firebase projects — THREE, not four ✅ verified 2026-08-23

Full detail in `docs/discovery/12-shared-infrastructure.md`.

| App | Runtime Firebase project | Isolated? |
|---|---|---|
| **POS** | `shareat-hub-v2` | shared with CUSTOMER |
| **CUSTOMER** | `shareat-hub-v2` | shared with POS |
| **ERP-rebuild** | its own project | ✅ fully isolated |
| **Website** | `shareat-website` | ✅ own project |

CUSTOMER's `.firebaserc` *default* points at an apparently-unused scaffold project
(`studio-9137697931-f4a93`), but its hardcoded client config, its Admin SDK fallback, and its
`.env.local` all resolve to **`shareat-hub-v2`**. The `.firebaserc` default is misleading —
do not trust it as the answer to "which project is this".

### ⛔ The overwrite path is confirmed, and one-directional ✅

CUSTOMER ships its own 85-line `firestore.rules` **plus a `.firebaserc` alias
`customerapp` → `shareat-hub-v2`**. A deploy from the CUSTOMER repo therefore replaces POS's
**800+ line production ruleset**. POS has no reverse path into CUSTOMER.

Two independent proofs that CUSTOMER's checked-in rules are *not* what is deployed:
1. They deny `activeSessions`, which CUSTOMER's own live dashboard reads — deploying them
   would break CUSTOMER itself.
2. They expect custom claims **POS never sets** — POS's staff model reads a Firestore doc,
   not claims.

### ⛔ NEW BUG — flash-ad image upload is denied in production ✅

CUSTOMER uploads to `flashAdImages/{storeId}/...`
(`CUSTOMER/src/app/admin/flash-ads/page.tsx:234`). POS's `storage.rules` is the only file
governing that shared bucket, and it has **no match block for `flashAdImages`**. The
catch-all is:

```
match /{allPaths=**} {
  allow read;
  allow write: if false;   // storage.rules:61-64
}
```

So the upload **fails closed**. Distinct from the known flash-ads Firestore fix, which
addressed *displaying* ads — this breaks *uploading their images*.

### Auth is shared in BOTH directions ✅

Already known: CUSTOMER → POS. **New:** a POS manager's browser calls
`customer.shareat.net`'s own API using a **POS-minted Firebase ID token, verified by
CUSTOMER's Admin Auth**. Staff and diners sit in one Auth tenant, used both ways.

### Local dev reaches production ⚠️ ✅

POS's and CUSTOMER's `.env.local` both reference a service-account key file with the
**identical basename (`POS.json`)** — both repos' local environments can write to the live
production Firestore project. Also: **no repo's CI ever runs `firebase deploy`.** Every rules,
index, and storage deploy is a human at a terminal.

### ERP-rebuild is the isolated one ✅

Fully separate at project, database, bucket, and Auth level. Its only couplings are the scoped
`x-api-key` REST bridge into POS and a wastage-email webhook — **neither can overwrite rules,
indexes, or storage on either side.** Ironically the legacy app is the best-fenced of the four.

---

## 1. POS → ERP — the daily books feed ✅

**The most load-bearing seam in the business.** ERP's entire revenue recognition depends on it.

| | |
|---|---|
| Mechanism | HTTP GET, POS `api/external/sales` |
| Auth | External API key → `resolveExternalKeyScope` + `storeAllowed` (`POS/src/lib/server/external-auth.ts`) |
| Consumer | `ERP-rebuild/src/lib/financial/posSalesPull.ts` → `mapPosSalesToFormFields` |
| Source of truth | POS doc `stores/{storeId}/analytics/{yyyymmdd}` (`POS/src/app/api/external/sales/route.ts:25`) |
| Lands in | ERP `salesDays/{YYYY-MM-DD}`, recognised only at `status='verified'` |

### Fields returned

`totalSales` · `totalSessions` · `dineInSales` · `takeOutSales` · `cashPayments` ·
`eWalletPayments` · `creditCardPayments` · `otherPayments` · `paymentsByMethod` ·
`discountsTotal` · `chargesTotal` · `voidCashRetained`

### Two semantics you must not get wrong ✅

**1. `dineInSales` means *unlimited package only*, not "all dine-in".**

```ts
// POS/src/lib/analytics/daily.ts:263
const isDineIn = r.sessionMode === 'package_dinein';
const mode = isDineIn ? "dineIn" : "walkIn";
```

À la carte and online both fall into `walkIn`. This is why Shareat System can map `dineInSales`
straight to **4100 Food sales — dine-in, unlimited** with no reconstruction (T-113 §6.1).

**2. `takeOutSales` is a residual, not a measurement.**

```ts
// POS/src/app/api/external/sales/route.ts:53
const takeOutSales = Math.max(0, totalGross - dineInSales);
```

It absorbs everything `totalGross` counts that `dineInSales` does not. Today that is à la
carte only — **because no online transactions exist yet** (Ian, 2026-08-23). The day online
launches, this figure mixes dine-in à la carte with take-out — which no longer matters for
revenue classification (both are 4150) but does matter for the `channel_id` dimension. See §2.

**3. Payment-method classification is string matching.** `cashKeys`/`eWalletKeys`/`cardKeys`
are hardcoded lowercase substring lists (`route.ts:61-63`); anything unmatched falls to
`otherPayments`. A new payment method name silently lands in "other" until someone adds it.
🟡 *Risk noted, not yet quantified.*

### Void cash ✅

`voidCashRetained` — cash collected on a voided receipt and **not** refunded. It sits in the
drawer with no backing sale, so ERP carries it into *expected* remittance and reclassifies it
to `liability__void_cash_suspense` at posting. Receipt-level fields: `voidCashPaid`,
`voidCashRefunded`, `voidCashRetained`, `voidCashDisposition`, `reRingReceiptId`,
`voidCashRetainedReversed` (`POS/src/lib/types.ts`).

---

## 2. POS online orders — not yet live ⚠️ ✅

Ian, 2026-08-23: **no online transactions as of now** — so there is no historical online data
to migrate. (An earlier note here said POS could be changed to fix this; **superseded** by the
standing rule — POS is read-only. The fix lands in the rebuild, not in POS.)

`POS/src/app/api/admin/online-orders/route.ts:503` writes a receipt with
`sessionMode: "alacarte"`, then line 518:

```ts
(receipt as any).source = "online";
```

An **untyped field bolted on via an `as any` cast** — absent from the `Receipt` type. Once
online volume exists, that cast becomes the only thing separating take-out revenue (4200)
from dine-in à la carte (4150), and nothing type-checks it.

**Recommendation (T-113 §6.7):** add a typed, required `fulfilment` discriminator to
`Receipt` before online launches. `sessionMode` answers *how it was sold* (package vs à la
carte); fulfilment answers *where the food went*. The COA needs both.

**This is the cheapest it will ever be to fix** — there is no historical online data to
migrate.

---

## 3. POS external API — the full surface ✅

All eight are key-scoped through `resolveExternalKeyScope` + `storeAllowed`.

| Route | Direction | Believed consumer | Status |
|---|---|---|---|
| `api/external/sales` | POS → ERP | Daily sales / books feed | ✅ §1 |
| `api/external/sold-items` | POS → ERP | Inventory usage pull | ⬜ |
| `api/external/inventory-items` | POS → ERP | Item master sync | ⬜ |
| `api/external/payment-methods` | POS → ERP | Payment-method mapping | ⬜ |
| `api/external/staff-metrics` | POS → ERP | Performance scoring | ⬜ |
| `api/external/staff-profiles` | POS → ERP | Staff identity | ⬜ |
| `api/external/stores` | POS → ERP / Website | Store roster | ⬜ |
| `api/external/feedback` | POS ← ? | Customer feedback capture | ⬜ |
| `api/admin/storefront-catalog` | POS → Website | Public menu/catalogue | ⬜ |
| `api/webhooks/paymongo` | PayMongo → POS | Payment provider callback | ⬜ |

> **Each ⬜ becomes a section as we touch it.** Do not assume the consumer named above is
> correct — it is inferred from the route name, not verified.

---

## 4. CUSTOMER ↔ POS ✅ — verified 2026-08-23

Full detail in `docs/discovery/10-customer-app.md`. **This is the densest coupling of the
four** and the one that most justifies a single backend.

### 4a. Six collections written by BOTH apps — the dual-writer set ⚠️

`stores/{s}/activeSessions` · `stores/{s}/sessions` ·
`stores/{s}/sessions/{id}/kitchentickets` · `stores/{s}/rtKdsTickets/{loc}` ·
`customers/{phone}` · `loyaltyRedemptions`

Confirmed on the POS side in `POS/src/lib/server/loyalty.ts` and
`POS/src/lib/kitchen/customer-order-billing.ts`.

> **This is the exact bug class bible §4.2 rule 8 exists to kill** — "one writer per table.
> If two code paths write the same table, one of them is wrong." Six shared collections
> across two apps is the single strongest argument in this whole map for one backend.

### 4b. The ordering handshake ✅

diner cart → server **re-prices everything** from POS `catalogCache/main` → writes a
`kitchentickets` doc only, with `billOnServe: true` and **no bill line** → **POS** creates the
`sessionBillLines` doc on serve. The contract is published in
`POS/src/lib/kitchen/customer-order-billing.ts`.

**Harvest this rule, do not delete it:** the bill is created on *serve*, not on order. Revenue
recognition in the unified backend must preserve that, or unserved orders become revenue.

### 4c. Identity — three separate schemes ✅

| Scheme | Key | Used for |
|---|---|---|
| Session participant | hashed device id, no password, PIN/QR join | Ordering at a table |
| Loyalty account | **phone number as document id**, bcrypt password | Points, rewards |
| Game device | `d_`-prefixed device id | Games only |

A unified backend has to reconcile these three into the one `person` spine (bible §13 row 14).
Phone-as-primary-key is the awkward one — it is a natural key that changes.

### 4d. Refills and loyalty ✅

- **Refill cooldown 60s, anchored on SERVE not order**, plus two independent safety valves
  (10 min "still in kitchen", 20 min "first serving pending"). **All magic numbers in app
  code, not configuration.** Harvest the rules; make them config in v2.
- **Loyalty spend is split across two apps:** CUSTOMER *holds* points at redemption and issues
  a code; **POS** applies the code and performs the actual spend at payment finalisation.

### 4e. Firestore rules divergence ⚠️ ✅

The checked-in `firestore.rules` in the CUSTOMER repo denies nearly everything under
`stores/{storeId}` except `catalogCache`/`flashAds` — yet the live dashboard does a client-SDK
read of `activeSessions` that **no rule in that file permits**. The deployed ruleset is
therefore POS's, not this file's.

> **RISK:** deploying this repo's rules with `-P customerapp` would both break the live app and
> overwrite POS's ruleset. Matches the known landmine.

> **Corrected, 2026-08-23.** The discovery agent flagged "no client-side role gate on
> `/admin`". True but **not a vulnerability**. Every `api/admin/*` route enforces
> authorization server-side: Bearer token → `verifyIdToken` → reject `customer` claim → require
> `staff/{uid}.status === 'active'` or a `platformAdmin` claim, else 403
> (`src/app/api/admin/pos-products/route.ts:14-28`). That is precisely where bible §7 rule 6
> says the gate belongs; the missing client redirect is cosmetic.

---

## 5. Website ↔ POS ✅ — verified 2026-08-23

Full detail in `docs/discovery/11-website.md`.

**Shape:** the Website is a *fully static* Astro site plus a single Cloud Functions backend
(`functions/index.js`, ~2,335 lines, region `asia-southeast1`, Firebase project
`shareat-website`). **The browser never touches the POS database directly** — every read and
write goes through that Functions layer.

**The coupling that matters:** those Functions hold **`HUB_SA_KEY`**, a *cross-project
service-account credential into the POS database* (`shareat-hub-v2`). That is the real seam
between Website and POS — not an HTTP contract but a borrowed identity into another project's
datastore. `MENU_BUILD_SA_KEY_PATH` is a second such credential used at build time.

| Surface | Behaviour | Consequence for one backend |
|---|---|---|
| `/shop` (à la carte) | Live-fetched every load, `no-store`, **server-repriced at order placement** | Already goes through a server boundary → swapping Firestore for Postgres behind it is straightforward |
| `/menu` (unli packages) | **Baked at build time** via a `prebuild` script pulling **3 hardcoded branch IDs** from POS | Stale between deploys; build fails hard on a missing price. Needs a publish step, not a live query |
| Online ordering | cart → OTP verify → `placeOrder` → **manual GCash/Maya confirmed by a POS cashier** | No automated payment capture, despite `PAYMONGO-GOLIVE.md` claiming otherwise |
| Store data | Address/hours hand-typed in markdown; phone optionally live-pulled from POS at build | **Three independently-synced sources of branch identity** — content collection, a hardcoded `BRANCHES` array, and the live POS store doc |
| Reservations / enrolment | Driven live by three booleans on the POS store doc | Legacy `reservationLocations` collection retired; it caused a real production incident while still load-bearing |

**Public writes into shared data** — the highest-risk items to absorb: reservations, online
orders, a merge-only `customers/{phone}` upsert, and two different chat-thread models
(bearer-id vs token-gated).

> **RISK — stale documentation.** `PAYMONGO-GOLIVE.md` in that repo describes a payment design
> the code has since abandoned. Do not trust it as current.

> **Corrected, 2026-08-23.** The discovery agent reported a live OpenAI key "committed in
> plaintext". **That is wrong.** `OPENAI_API_KEY` exists in a *local* `.env` which is
> gitignored (`.gitignore:15`), untracked, and has **no git history**. Only `.env.example` and
> docs reference the variable *name*, which is correct practice. Untidy, not a breach.

---

## 5b. POS ↔ Website legacy notes ⬜

- `api/admin/storefront-catalog` feeds the public menu
- Storefront online ordering and per-store menu selection
- Store enrolment / reservation surface

---

## 5c. POS internals — verified 2026-08-23

Full detail in `docs/discovery/09-pos-system.md`. **Scale:** 49 page routes, 62 API routes,
601 source files, ~98,900 LOC, 9 cron jobs, ~14 top-level collections + ~55 per-store
subcollections.

### The receipt-numbering answer ✅ — and it is already broken

POS has **two parallel sale-completion paths**:

| Path | Mechanism | Sequence source |
|---|---|---|
| Online | `completePaymentFromUnits`, `runTransaction` | Server-arbitrated `receiptSeq` counter |
| Offline | `completePaymentOffline`, `writeBatch` | **Local per-device daily counter**, number formatted `<store>-OL-<deviceTag>-<HHMM>-<NNN>` |

The offline design is actually the *right* pattern — device-tagged numbering needs no server.
**The defect is that both write the same `Receipt.receiptSeq: number` field from
non-comparable sequence spaces.** Any schema treating `receiptSeq` as a per-store monotonic
key is wrong on the offline half.

> **For the unified backend:** keep device-tagged allocation, but model it honestly — a
> composite (`device_id`, `local_seq`) plus a separate server sequence, never one integer
> column pretending to be both.

### ⛔ VERIFIED BUG — refund receipt numbers collide

```ts
// POS/src/components/cashier/firestore.ts:1484-1485
receiptSeq: 0,
receiptNumber: `RF-${parentReceipt.receiptNumber}`,
```

Every refund gets `receiptSeq: 0`, and the number is the parent's with an `RF-` prefix and
**no sequence suffix**. A **second partial refund against the same parent mints an identical
receipt number.** Real, current, and audit-relevant. **POS is read-only** (standing rule) —
logged in `docs/DEFECTS-REGISTER.md` as DEF-001 and fixed in the rebuild, never in POS.

### There is no take-out flag — at all ✅

`sessionMode` has exactly two values, and **walk-in à la carte and in-store take-out are the
same value.** Online orders live in a *separate* `onlineOrders` collection with its own status
machine and — importantly — a real **`fulfillment.type: pickup | delivery`** field. That
collection's orders get `sessionMode: "alacarte"` hardcoded onto a synthesised receipt purely
to satisfy the type.

**And `receipt.source` is written but never read by the analytics aggregation layer**, so
online sales silently fold into the `walkIn` bucket — which is what feeds ERP's
`takeOutSales`. This confirms the §1 prediction with its mechanism.

> **This settled T-113 §6.6/§6.7.** 4150 vs 4200 was not derivable from POS — and on
> 2026-08-23 Ian withdrew the split entirely: two food accounts only (4100 unli, 4150 à la
> carte incl. take-out). The chart now matches what the source data can support. Separately,
> `fulfillment.type` already exists on `onlineOrders` and is the right field to promote onto
> the receipt — the concept is present, just not carried where the ledger needs it.

### Offline — what actually shipped ✅

Firestore persistence is on, but the substantive fix was converting `startSession`, payment
and void from `runTransaction` (offline-incompatible by Firestore design) to `writeBatch`.
That shipped for the core write paths. Two gaps remain:

- Connectivity is judged by bare **`navigator.onLine`** — no reachability probe, so a
  captive portal or dead uplink reads as "online".
- The planned **Firestore-rules guardrail preventing a stale offline write from clobbering an
  already-finalised receipt/session was never implemented** — confirmed absent from
  `firestore.rules`.

### Money is float, twice ⚠️

Stored as JS floats in decimal pesos, not integer centavos — the same defect Shareat System's
`src/lib/money.ts` exists to eliminate (bible §12). Worse, there are **two duplicate rounding
implementations**: `lib/money.ts` and an inline copy in `lib/tax.ts`.

### Analytics rebuild ⚠️

`stores/{storeId}/analytics/{YYYYMMDD}` is built from incremental per-receipt deltas, plus a
**`merge:false` full-rebuild** path that reconstructs kitchen and staff stats purely from
surviving `kitchentickets` documents. Confirms in code the known risk: **purge the tickets and
a rebuild silently zeroes kitchen and per-staff stats.**

---

## 6. What this means for Shareat System

The ledger's **revenue** depends entirely on §1, and its **inventory cost** will depend on
`sold-items` / `inventory-items`. Two consequences already recorded in T-113:

1. Shareat System must treat the POS feed as a **source document with known semantics**, not as raw
   truth — `takeOutSales` in particular is derived, and derived figures need a reconciliation
   rule, not a direct posting.
2. The historical window is clean **only because online does not exist yet**. That is a
   time-limited property and it is the reason §2 is worth doing now.

---

## Open questions

| # | Question | Blocks |
|---|---|---|
| 1 | Is à la carte eaten in or taken away — does 4150 need to be a live account? | T-113 §6.6 |
| 2 | Which repo owns the Firestore ruleset in the shared POS/CUSTOMER project? | Any rules work |
| 3 | Do the seven unverified `external/*` consumers match their route names? | Phase 2/3 |
| 4 | What happens when a POS payment method name matches no key list? | Reconciliation |

## Change log

| Date | Change |
|---|---|
| 2026-08-23 | Created. Seeded from T-113 discovery: §1 POS→ERP sales feed verified with citations, §2 online-order gap, §3 API surface enumerated. |

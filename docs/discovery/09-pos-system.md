# 09 — POS System (Discovery)

Read-only discovery over `C:\Users\ianla\webapps\POS` (branch `sev5_advanced`; Next.js
+ Firebase/Firestore + Capacitor Android shell, app id `net.shareat.pos`, npm name `culinaryflow`). Purpose: an
entity/behaviour inventory a database architect can use to design the shared
PostgreSQL schema all four apps (POS, ERP, CUSTOMER, Website) will move onto. This
document does not propose a schema. No file under `POS` was modified. Every claim is
tagged `[VERIFIED]` (read the code) or `INFERRED` (reasoned from structure); citations
are `file:line` relative to the repo root above.

---

## Executive summary

POS is a single Next.js app serving four browser-based roles (cashier, server,
kitchen/KDS, admin/manager) plus a Capacitor Android APK for the cashier terminal.
State lives entirely in Firestore, organized as `stores/{storeId}/...` subcollections
per branch, with a handful of top-level collections for the global catalog
(`products`, `packages`, `refills`, `flavors`) and staff (`staff/{uid}`). Two
independent code paths write a sale: an **online** path using `runTransaction`
(server-arbitrated receipt numbering, atomic) and a purpose-built **offline** path
using `writeBatch` + a client-local receipt counter (committed to the local Firestore
cache without waiting for server ack). These two paths produce receipts whose
`receiptSeq` integer is **not** drawn from the same sequence space — see §5/§6 RISK.
Online orders placed on the public website live in a structurally separate
collection (`onlineOrders`, not `sessions`) and are folded into the same
`sessionMode: "alacarte"` bucket as in-store walk-ins for analytics purposes, with no
reliable channel field consulted downstream — see §3 RISK. Money is stored as
JS floating-point pesos (not integer cents), rounded to 2dp at multiple
independent call sites. The ERP integration surface is 8 read-only, static-API-key
`api/external/*` endpoints plus a staff-token-authenticated `admin/storefront-catalog`
route and a PayMongo webhook.

---

## 1. Core entities and Firestore paths

### 1.1 Path conventions
- Per-branch data: `stores/{storeId}/{collection}/{docId}` [VERIFIED, `src/lib/types.ts` throughout; collection names enumerated via repo-wide grep].
- Global catalog (shared across all stores): top-level collections `products`, `packages`, `refills`, `flavors`, `addonCategories`, `globalDiscounts`, `globalCharges`, `loyaltyRewards`, `productRequests`, `productPhotoRequests` [VERIFIED, grep of `collection(db, "...")` calls].
- Staff/auth: `staff/{uid}` is the authoritative profile doc, keyed by Firebase Auth uid — role, `assignedStoreIds`, status [VERIFIED, `src/context/auth-context.tsx:73` `doc(db, "staff", u.uid)`]. A `users` collection also appears in a few files (signup, admin/users) but was not traced further — INFERRED to be a secondary/legacy surface, not the runtime auth source.

### 1.2 Entity table

| Entity | Path | Key fields | Owner / writer |
|---|---|---|---|
| **Store** | `stores/{storeId}` | `taxType` (`VAT_INCLUSIVE`\|`VAT_EXCLUSIVE`\|`NON_VAT`), `taxRatePct`, `offersAlaCarte`/`offersUnlimited`, `acceptsOnlineOrders`, `onlineOrderMode`, `geo`, `loyaltyConfig`, `forecastConfig` [VERIFIED, `src/lib/types.ts:1109-1210`] | Admin (store CRUD); managers edit config subset |
| **Session** (dine-in/walk-in ticket) | `stores/{storeId}/sessions/{sessionId}` | `status` (`pending_verification`\|`active`\|`closed`\|`voided`), `sessionMode` (`package_dinein`\|`alacarte`), `guestCountCashierInitial`/`ServerVerified`/`Final`, `billingRevision`, `ownerTerminalId`, `revision` [VERIFIED, `src/lib/types.ts:1222-1321`] | Cashier (`startSession`), server (`handleVerify`), cashier (billing edits, close, void) — `src/components/cashier/firestore.ts` |
| **PendingSession/SessionDoc projections** | `stores/{storeId}/activeSessions/{id}`, `stores/{storeId}/closedSessions/{id}` | Denormalized copy of the session, kept in sync by every writer alongside the canonical `sessions/{id}` doc | Same writers as Session — dual-write, not a DB view [VERIFIED, e.g. `src/components/cashier/firestore.ts:232-252` (create), `:582-603` (close), `:949-959` (void)] |
| **SessionBillLine** | `stores/{storeId}/sessions/{sessionId}/sessionBillLines/{lineId}` | `type` (`package`\|`addon`), `unitPrice`, `qtyOrdered`, `discountQty`/`Type`/`Value`, `freeQty`, `voidedQty`, `lineAdjustments` (map), `modifiers[]` | Cashier/server order-entry UI [VERIFIED, `src/lib/types.ts:690-732`] |
| **KitchenTicket** | `stores/{storeId}/sessions/{sessionId}/kitchentickets/{id}` (dine-in) **or** `stores/{storeId}/onlineOrders/{orderId}/kitchentickets/{id}` (online) — mutually exclusive via `sessionId` xor `onlineOrderId` | `status` (`preparing`\|`ready`\|`served`\|`cancelled`\|`void`\|`partially_served`), `kitchenLocationId`, `billOnServe`/`pendingBillLine` (diner self-order path), `serveLog[]` (batch serve) | Cashier (package/addon order), server, KDS (serve/cancel), CUSTOMER app (self-order tickets) [VERIFIED, `src/lib/types.ts:545-658`; online-order path `src/lib/kitchen/online-order-tickets.ts:92`] |
| **RtKdsStationDoc** (KDS read-model) | `stores/{storeId}/rtKdsTickets/{kitchenLocationId}` | `tickets` map (ticketId → full KitchenTicket), `activeIds[]`, `sessionIndex` map | Denormalized fan-out written by every ticket-mutating op alongside the ticket doc itself [VERIFIED, `src/lib/types.ts:1713-1722`; write example `src/components/cashier/firestore.ts:338-348`] |
| **Table** | `stores/{storeId}/tables/{id}` **and** a mirrored projection `stores/{storeId}/storeConfig/current/tables/{id}` | `status` (`available`\|`occupied`\|`reserved`\|`out_of_order`), `currentSessionId` | Cashier (start/close/void session updates both copies in the same batch/transaction) [VERIFIED, `src/lib/types.ts:1212-1220`; dual-write `src/components/cashier/firestore.ts:210-228`] |
| **Product** (global catalog) | `products/{id}` | `kind` (`single`\|`group`\|`variant`), `groupId`, `optionGroupIds[]`, `isArchived` | Admin only (managers cannot write `products`; mediated via `/api/product-requests`) [VERIFIED, `src/lib/types.ts:26-107`] |
| **InventoryItem** (per-store activation of a Product) | `stores/{storeId}/inventory/{id}` | `productId` (FK to global Product), `cost`, `sellingPrice`, `onlineEnabled`/`onlinePrice`, `customerEnabled`, `isAddon` | Manager, per store [VERIFIED, `src/lib/types.ts:256-329`; path confirmed `src/app/api/external/inventory-items/route.ts:30`] |
| **OptionGroup** (modifiers) | `optionGroupIds` referenced by Product/InventoryItem; group docs global | `selectionMode` (`single`\|`multi`), `values[]` each with `priceDelta` | Admin [VERIFIED, `src/lib/types.ts:217-254`] |
| **Package / Refill / Flavor** (global) + **StorePackage / StoreRefill / StoreFlavor** (per-store activation, denormalized name+price) | `packages/{id}`, `refills/{id}`, `flavors/{id}` (global); `stores/{storeId}/storePackages`, `storeRefills`, `storeFlavors` | Per-store: `pricePerHead`, `isBundle`/`bundlePrice`/`bundleMaxCap`/`bundleExtraHeadPrice`, `kitchenLocationId` | Admin (global), manager (per-store enable+price) [VERIFIED, `src/lib/types.ts:339-409`] |
| **Discount / Charge** (store-scoped) + **GlobalDiscount / GlobalCharge** (platform-wide) | `stores/{storeId}/storeDiscounts`, `storeCharges`; top-level `globalDiscounts`, `globalCharges` | `type` (`fixed`\|`percent`), `scope` (`bill`\|`item`), `stackable`, `vatExempt` (senior/PWD) | Manager (store), admin (global) [VERIFIED, `src/lib/types.ts:778-850`] |
| **ModeOfPayment** | `stores/{storeId}/storeModesOfPayment/{id}` | `type` (`cash`\|`card`\|`online`\|`other`), `hasRef`, `gateway` (`paymongo_qrph`\|null) | Manager [VERIFIED, `src/lib/types.ts:852-866`] |
| **Payment** (tender line) | `stores/{storeId}/sessions/{sessionId}/payments/{id}` | `methodId`, `amount`, `reference` | Written inside the same tx/batch as receipt finalization [VERIFIED, `src/lib/types.ts:750-756`; write `src/components/cashier/firestore.ts:557-568`] |
| **Receipt** | `stores/{storeId}/receipts/{id}` (id = `sessionId` for a normal sale, or `orderId` for a completed online order, or a fresh uuid for a refund doc) | `status` (`final`\|`voided`), `receiptSeq`, `receiptNumber`, `analytics` (baked `ReceiptAnalyticsV2`), `analyticsApplied`, void/re-ring fields | Cashier (online/offline payment completion), online-orders route (on `completed` transition), refund flow [VERIFIED, `src/lib/types.ts:1501-1568`] |
| **DiscountEvent / ActivityLog** (audit) | `stores/{storeId}/activityLogsByDay/...`, discount events keyed similarly | Full before/after audit trail of session mutations | Every mutating cashier/server action via `writeActivityLog` [VERIFIED, `src/lib/types.ts:1570-1694`] |
| **CashHandover** (shift/drawer log) | `stores/{storeId}/cashHandovers/{id}` | `startingCash`, `cashSales`, `deductions[]`, `expectedCash = startingCash + cashSales − deductionsTotal`, `countedCash`, `variance` | Cashier, from `/cashier/handover` at shift change — explicitly "purely a log for accountability; inventory/accounting truth lives in the ERP" [VERIFIED, `src/lib/types.ts:433-468` incl. inline comment; helpers `src/lib/cash/handover.ts:1-50`] |
| **PosPaymentIntentDoc** (PayMongo QR Ph) | `stores/{storeId}/paymentIntents/{id}` | `status` (`awaiting_payment`\|`paid`\|`failed`\|`expired`\|`canceled`), `paymongoIntentId`, `processedEventIds[]` | `create-qr` route creates it; webhook updates it [VERIFIED, `src/lib/types.ts:758-776`] |
| **PaymentProof** | `paymentProofs/{storeId}/{proofId}` | Photo-only, no amount/reference — "the POS does not record what was received here" | Cashier, display-only QR wallet flow; 15-day TTL (Storage lifecycle + Firestore TTL, must stay in step) [VERIFIED, `src/lib/types.ts:950-993`] |
| **DailyMetric / analytics day doc** | `stores/{storeId}/analytics/{YYYYMMDD}` | See §8 | Client delta writer + server reconcile/backfill jobs |
| **OnlineOrder** | `stores/{storeId}/onlineOrders/{orderId}` | `status` lifecycle (§2.4), `fulfillment.type` (`pickup`\|`delivery`), `payment.paid`, `lines[]` | Public website (create) + `/api/admin/online-orders` (transition) [VERIFIED, `src/app/api/admin/online-orders/route.ts`] |

---

## 2. The sale lifecycle, end to end

### 2.1 Session start
`startSession(storeId, payload, user)` — **client-side `writeBatch`**, not a
transaction (converted from a transaction specifically to be offline-capable; see
§6) [VERIFIED, `src/components/cashier/firestore.ts:144-353`]. In one batch it:
1. Creates `sessions/{newId}` with `status: isAlaCarte ? 'active' : 'pending_verification'`, stamping `ownerTerminalId`/`revision` (offline conflict fields, §6) (`:170-198`).
2. Updates `tables/{tableId}` **and** its `storeConfig/current/tables/{tableId}` projection to `occupied` (`:210-228`).
3. Writes the `activeSessions/{id}` projection (`:232-252`).
4. For `package_dinein`, creates the initial package `sessionBillLines` line and a `preparing` KitchenTicket, plus the `rtKdsTickets` fan-out (`:256-349`). Bundle packages get a synthesized "Extra Pax" addon line when headcount exceeds `bundleMaxCap` (`:280-304`).
5. Commits local-first (`commitLocalFirst`, `:351-353`) — does not await server ack.

### 2.2 Verification (dine-in only)
`ServerPageClient.handleVerify` — another `writeBatch`, not a transaction
[VERIFIED, `src/components/server/ServerPageClient.tsx:153-193`]. Sets
`guestCountFinal = max(cashierInitial, serverCount)`, flips `status: 'pending_verification' → 'active'`, stamps `verifiedAt`/`verifyDurationMs`, and bumps `billingRevision` (an optimistic-concurrency counter later checked by payment completion). Reconciles the package bill line's `qtyOrdered` to the verified count (skipped for bundles, which stay at qty 1).

### 2.3 Ordering / billing
Bill lines and their `lineAdjustments` (discounts/charges) are edited via plain
`updateDoc`/small batches on `sessionBillLines` — already offline-capable per the
design doc's own read of the pre-existing code (`src/components/cashier/firestore.ts`
per-line functions; not itemized here as they were not the focus of this pass).
Guest-count and package-change requests go through a request/approve state machine
on the session doc (`guestCountChange.status`: `none`\|`pending`\|`approved`\|`rejected`; same shape for `packageChange`) [VERIFIED, `src/lib/types.ts:1247,1296-1320`].

### 2.4 Kitchen
KDS stations read `rtKdsTickets/{kitchenLocationId}` (the denormalized map, not the
per-session subcollection) for live queues. Ticket status: `preparing → ready → served`,
or `→ cancelled`/`void` at any point before serve. Addon tickets support **batch
serve** (`qtyOrdered`/`qtyServed`/`qtyCancelled`/`qtyRemaining` + a `serveLog[]`)
distinct from the single-shot package-ticket serve [VERIFIED, `src/lib/types.ts:541-658`].
Diner self-order tickets (CUSTOMER app) carry `billOnServe: true` and create their
bill line only when the kitchen serves them, not at order time (`pendingBillLine`)
[VERIFIED, `src/lib/types.ts:570-583`].

### 2.5 Billing / payment completion — two parallel code paths
- **Online**: `completePaymentFromUnits` — `runTransaction` [VERIFIED, `src/components/cashier/firestore.ts:421-870`]. Reads session/receipt/settings/**receipt counter**/table inside the tx; validates `billingRevision` hasn't moved (optimistic concurrency, `:477-480`); validates `totalPaidCents >= amountDueCents-1` and that any change is covered by a cash tender (`:511-638`); marks remaining active tickets `served`; writes the `payments` subcollection; closes the session (`status:'closed', isPaid:true`); moves the `activeSessions`→`closedSessions` projection; allocates the next `receiptSeq` from `counters/receipts` and mints `receiptNumber` (§5); computes and bakes `salesByItem`/`salesByCategory` analytics onto the receipt (`:659-696`).
- **Offline**: `completePaymentOffline` — a `writeBatch` mirroring the same core logic but reading from the local cache (`getDoc`, not `tx.get`) and minting a **local** OL receipt number instead of touching the server counter [VERIFIED, `src/components/cashier/offlinePayment.ts:41-244`]. Server-only aggregates (`salesByItem`, `guestCountSnapshot`, etc.) are explicitly deferred to sync-time (`:177-195`).
- Which path runs is decided in the UI purely by `useOnlineStatus()` (`navigator.onLine`) [VERIFIED, `src/components/cashier/payment-modal.tsx:115,367-412`] — see §6 RISK on the reliability of that signal.

### 2.6 Void (unpaid session) vs. Void Receipt (paid sale)
Two distinct operations exist:
- **`voidSession`** — voids a session that has **not** been paid: `runTransaction`, cancels active tickets, sets `status:'voided'`, frees the table, moves the projection [VERIFIED, `src/components/cashier/firestore.ts:872-1001`]. An **offline** twin, `voidSessionOffline`, does the same as a local `writeBatch` and stamps `offlineOrigin: true` on the session write [VERIFIED, `src/components/cashier/offlineVoid.ts:1-60`, and design intent in `docs/superpowers/backlog/2026-07-03-offline-pos-deferred-work.md:27`].
- **Void Receipt** — voids an already-**paid** receipt (a different, later-stage operation). `VoidReceiptModal` collects a cash disposition (`refunded`\|`retained`\|`partial`) and reason; the receipt gets `voidCashPaid`/`voidCashRefunded`/`voidCashRetained`/`voidCashDisposition` so drawer remittance can reconcile "cash stayed in the drawer with no sale behind it" [VERIFIED, `src/components/receipts/VoidReceiptModal.tsx:1-155`; fields `src/lib/types.ts:1547-1560`].

### 2.7 Re-ring
`ReRingLinkModal` links a voided receipt's **retained** cash to a later receipt that
re-rang the same money, setting `reRingReceiptId` on the void and (elsewhere)
`voidCashRetainedReversed` so expected-remittance math doesn't double-count it
[VERIFIED, `src/components/receipts/ReRingLinkModal.tsx:1-115`; fields `src/lib/types.ts:1555-1560`]. This is a **manual human link**, not an automatic system inference.

### 2.8 Refund
`createRefundReceipt` — `writeBatch`, creates a new `receipts/{uuid}` doc with
`isRefund: true`, `parentReceiptId`, `total`/`totalPaid` as **negative** numbers, and
increments `refundedQtys.{lineId}`/`totalRefunded`/`refundCount` on the parent receipt
[VERIFIED, `src/components/cashier/firestore.ts:1446-1520`].
> **RISK**: the refund receipt is assigned `receiptSeq: 0` and
> `receiptNumber: \`RF-${parentReceipt.receiptNumber}\`` with **no sequence suffix**
> (`:1484-1485`) — a second partial refund against the same parent receipt would mint
> an **identical** `receiptNumber` to the first. `receiptId` (a fresh uuid) is unique;
> the human-facing `receiptNumber` is not.

### 2.9 Online order lifecycle (separate state machine)
`onlineOrders/{orderId}.status` moves through a hand-written adjacency list
[VERIFIED, `src/app/api/admin/online-orders/route.ts:37-48`]:
```
pending_payment → cancelled
pending → accepted | cancelled | rejected
accepted → preparing | cancelled | rejected
preparing → ready | cancelled
ready → ready_for_pickup | out_for_delivery | completed | cancelled
ready_for_pickup → completed | cancelled
out_for_delivery → completed | cancelled
expired → pending   (reopen only; "cancelled" deliberately not offered)
```
All transitions run inside a single `db.runTransaction` (Admin SDK) driven by
`POST /api/admin/online-orders {op:"transition", toStatus}`. Completion
(`toStatus==="completed" && !order.receiptId`) synthesizes `SessionBillLine`s from
the order's `lines[]`, adds a `Delivery Fee` addon line when applicable, allocates
`receiptSeq` from the **same** `counters/receipts` document sessions use, and writes
`receipts/{orderId}` with `sessionMode: "alacarte"` hardcoded and `sessionId: orderId`
(there is no `sessions` doc backing an online order at all) [VERIFIED, `:379-522`].
A separate `op:"confirm-payment"` records which wallet a cashier saw money land in,
without minting a receipt (`:107-...`).

---

## 3. `sessionMode`

**Values**: exactly two — `'package_dinein' | 'alacarte'` [VERIFIED, `src/lib/types.ts:99,1230,1509,1800`, etc. — the type appears with this exact union in ~10 places].

**Set at**: session creation, from the cashier's chosen flow (`StartSessionPayload.sessionMode`) [VERIFIED, `src/components/cashier/firestore.ts:90-100,147`]. Never changes after creation for a real session. Online orders get the literal string `"alacarte"` hardcoded onto their synthesized receipt regardless of pickup/delivery (`src/app/api/admin/online-orders/route.ts:503`).

**What it controls**:
- Table binding: `alacarte` sessions get `tableId: 'alacarte'`/`tableNumber: null`; `package_dinein` sessions are bound to a real table (§1, Table entity) [VERIFIED, `firestore.ts:149,650-651`].
- Guest-count lock: `alacarte` sets `guestCountVerifyLocked: true` immediately (no server-verify step); `package_dinein` starts `pending_verification` and requires `handleVerify` [VERIFIED, `firestore.ts:179,188`].
- Bill line: only `package_dinein` gets the auto-created package line + kitchen ticket at start; `alacarte` sessions start empty and everything is added as an addon.
- Analytics bucketing: `modeKeyOf()` maps `package_dinein → "dineIn"`, **anything else → "walkIn"** [VERIFIED, `src/lib/analytics/daily.ts:133-137`]. This is the *only* place a channel distinction exists downstream.
- Receipt display: `computeSessionLabel` shows the customer name for `alacarte`, the table for `package_dinein` [VERIFIED, `src/lib/utils/session.ts`].

**How take-out, dine-in, and online orders are actually distinguished** — this is
**not** a single clean field:
- **Dine-in (unlimited/buffet package)** = `sessionMode: 'package_dinein'`, bound to a table.
- **Walk-in à la carte AND in-store take-out** are **the same value**, `sessionMode: 'alacarte'` — there is no separate flag anywhere in `PendingSession`/`SessionDoc`/`Receipt` distinguishing "eaten at a table with no package" from "boxed to go." `Store.offersAlaCarte`/`offersUnlimited` only gate which start-flow buttons the cashier sees, not a per-sale attribute [VERIFIED, `src/lib/types.ts:1195-1196`].
- **Online orders** are not a `sessionMode` at all — they are a structurally separate `onlineOrders/{id}` document with its own status machine and a `fulfillment.type: 'pickup' | 'delivery'` field [VERIFIED, `src/components/admin/online-orders/OnlineOrdersClient.tsx:47,138`; `src/lib/payment-label.ts:9-17`]. A completed online order's synthesized receipt is labeled `sessionMode: "alacarte"` purely because the `Receipt` type requires *some* value.
- A `Receipt.source = "online"` field is stamped on that synthesized receipt (`src/app/api/admin/online-orders/route.ts:519`)...

> **RISK**: ...but `receipt.source` is **never read** anywhere in the analytics
> aggregation layer — a repo-wide search for `source === "online"` / `receipt.source`
> found no consumer in `src/lib/analytics/daily.ts` or anywhere else in the
> aggregation path. Online-order sales are therefore folded into the same
> `"walkIn"` bucket as genuine in-store à-la-carte/take-out sales in the daily
> analytics doc, with no first-class channel dimension a relational schema could
> cleanly inherit. A real "sales channel" concept (dine-in / walk-in / take-out /
> online-pickup / online-delivery) does not exist as one column anywhere today.

---

## 4. Money handling

**Storage type**: JavaScript `number` (IEEE-754 double) throughout — `Receipt.total`,
`totalPaid`, `change`, `SessionBillLine.unitPrice`, `Payment.amount` are all typed
`number`, storing decimal pesos, **not** integer minor units (centavos) [VERIFIED,
`src/lib/types.ts:668-776,1501-1568`]. The one deliberate exception is
`PosPaymentIntentDoc.amountCentavos` for the PayMongo API, which requires integer
centavos on the wire (`:764`).

**Rounding**: two independent, textually-identical implementations of the same
half-up 2dp rounding exist:
- `roundMoney()` / alias `round2()` in `src/lib/money.ts:1-24` — `Math.round((n + Number.EPSILON) * 100) / 100`.
- A local, unexported `round()` with the identical formula inside `src/lib/tax.ts:24-26`.
Both are used across the codebase depending on which module a given file already
imports; this is a **duplication**, not a functional bug, but it means "the" rounding
rule is not a single importable source of truth.

**Bill computation** — `calculateBillTotals()` [VERIFIED, `src/lib/tax.ts:31-207`]:
1. Sums `billableQty × (unitPrice + modifiersTotal)` per line into `grossSubtotal`.
2. Applies per-line `lineAdjustments` (discount/charge, `fixed`\|`percent`, with a
   `qty` cap so a discount can target fewer units than the line's full quantity) —
   falls back to legacy single-discount fields (`discountType`/`discountValue`/`discountQty`) when no `lineAdjustments` map is present.
3. Applies one bill-level `Discount` (with a special `vatExempt` branch for
   senior/PWD: the *entire* bill becomes VAT-exempt and the discount is computed
   on the VAT-**removed** net price — a distinct code path, not just a flag on the
   normal branch, `:145-156`).
4. Stacks loyalty-reward discounts on top of remaining gross, compounding (`:172-181`).
5. Derives `vatableSales`/`taxTotal` from store `taxType` (`VAT_INCLUSIVE` backs tax
   out of the gross; `VAT_EXCLUSIVE` adds tax on top of net; `NON_VAT` zero tax) — a
   **single flat `taxRatePct` per store**, no per-item tax category/multiple rates.
6. Adds bill-level + line-level charges (service charge etc.), each either `fixed`
   or `percent`-of-(`subtotal`\|`total`) via `appliesTo`.
7. `grandTotal = totalBeforeCharges + chargesTotal`, rounded.

**Payment validation** temporarily works in **integer cents** purely to avoid
float-comparison bugs during tender/change math (`Math.round(amount*100)`,
compared with a 1-cent tolerance) [VERIFIED, `src/components/cashier/firestore.ts:511-638`; mirrored offline in `src/lib/offline/offlinePaymentSummary.ts`], then converts back to float pesos (`/100`) before writing `totalPaid`/`change`/`mop` onto the receipt. Change is only permitted against a **cash** tender; if change exists but no cash payment line covers it, the completion throws (`:625-637`).

> **RISK**: money is a float from creation to storage to every downstream
> aggregation (`increment()` calls in analytics deltas sum floats). Individual
> writes are rounded at 2dp, but nothing enforces that invariant at the storage
> layer — a relational rebuild should decide once (integer minor units are the
> conventional fix) rather than inherit the float-with-scattered-rounding pattern.

---

## 5. Receipt numbering

**Online**: allocated inside the same `runTransaction` as payment completion.
`counters/receipts` (path `stores/{storeId}/counters/receipts`) holds `{seq: number}`;
the tx reads it, computes `nextSeq = currentSeq + 1`, writes it back with
`{merge:true}`, and formats `receiptNumber` via `formatReceiptNumber(fmt, nextSeq)`
where `fmt` comes from `receiptSettings/main.receiptNoFormat` (default
`'SELIP-######'`, `#` run zero-padded to its own width) [VERIFIED,
`src/components/cashier/firestore.ts:109-116,459,606-616`]. **Uniqueness/monotonicity
guarantee**: Firestore transactions serialize (optimistic-concurrency retry) on a
contended document, so two concurrent completions against the same store's counter
cannot both read the same `currentSeq` — this holds even across the two different
call sites that increment the same counter (client SDK in `firestore.ts`, Admin SDK
in `src/app/api/admin/online-orders/route.ts:492-521`), since Firestore transactions
are SDK-agnostic at the storage layer.

**Offline**: does **not** touch the server counter at all. `nextDailySeq()` maintains
a **per-device, per-calendar-day** sequence in `localStorage`
(`pos_offline_seq`), resetting to 1 each local day; formatted as
`<storeCode>-OL-<deviceTag>-<HHMM>-<NNN>` (e.g. `SHT-OL-AB12-0320-001`) via
`formatOfflineReceiptNumber` [VERIFIED, `src/lib/offline/offlineReceiptNumber.ts:1-102`].
Corrupt/unparseable local state **throws** rather than silently reissuing a number
(`:78-89`) — the payment path must catch this, per the design doc, "never crash the
sale" (`docs/superpowers/specs/2026-07-01-offline-first-pos-cashier-design.md:76`).
OL numbers are retained **permanently** after sync — never retro-renumbered into the
server sequence (design doc `:73`).

> **RISK — two non-comparable sequence spaces share one field.** The offline
> receipt's `receiptSeq` is the **local daily counter value** (small integers: 1, 2,
> 3…) [VERIFIED, `src/components/cashier/offlinePayment.ts:91,168`], while the
> online receipt's `receiptSeq` is the **store-lifetime counter value** (also
> starting at 1, incrementing forever). Both are stored in the identical
> `Receipt.receiptSeq: number` field. A relational rebuild that treats `receiptSeq`
> as a per-store monotonic sequence (the field name and the online behavior both
> invite that assumption) will silently collide/misorder the moment any offline
> sale exists — the field alone cannot tell an early online receipt from a later
> offline one. Only `receiptNumber` (a formatted string) plus knowledge of the
> `-OL-` marker disambiguates origin, and even then the design doc itself notes OL
> numbers "recur across days" and are unique only within **(store, day)**, never
> globally (design doc `:74`) — they must always be paired with their finalize
> date.

> **RISK — no server-side guard against an offline write clobbering a later
> server-authoritative receipt.** Per
> `docs/superpowers/backlog/2026-07-03-offline-pos-deferred-work.md:22-30`
> ("Plan 4B — deferred, not yet planned"), the intended Firestore rule to reject a
> stale offline batch overwriting an already-finalized receipt or session was
> **never implemented** — `firestore.rules` was grepped for `offlineOrigin` and
> found no match [VERIFIED, confirmed absent from
> `C:\Users\ianla\webapps\POS\firestore.rules`]. Today the only protection is a
> client-side post-hoc detection in the sync drain (`use-payment-queue-sync.ts`)
> that surfaces a toast — **after** the conflicting write has already reached the
> server.

---

## 6. Offline behaviour (most important section)

### 6.1 What's on by default
Firestore client persistence is enabled unconditionally:
```ts
const db = initializeFirestore(app, {
  ignoreUndefinedProperties: true,
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});
```
[VERIFIED, `src/lib/firebase/client.ts:15-17`] — this is IndexedDB-backed and survives
reload/app-kill. `persistentMultipleTabManager` means multiple browser tabs/webviews
can share and race the same local cache.

### 6.2 The core problem this was built to fix
Per the design doc [VERIFIED, `docs/superpowers/specs/2026-07-01-offline-first-pos-cashier-design.md:9-20`]:
Firestore's `runTransaction` **requires a live server round trip and fails
outright when offline** — by design, not a bug. The original `startSession`,
`completePaymentFromUnits`, `voidSession`, and `createKitchenTickets` were all built
on transactions, so despite persistence being "on," a cashier **could not start a
session, bill, or take payment** with no network. Plain `updateDoc`/`writeBatch`
calls, by contrast, apply to the local cache synchronously and sync later — that's
the mechanism the whole redesign leans on.

### 6.3 What was actually shipped (verified against source, not just the design doc)
| Operation | Converted to batch/local-first? | Evidence |
|---|---|---|
| `startSession` | **Yes** | `writeBatch` + `commitLocalFirst`, `src/components/cashier/firestore.ts:205-353` |
| Payment completion | **Yes, as a separate function** — `completePaymentOffline` (offline) coexists with the original `completePaymentFromUnits` (online, still a `runTransaction`) | `src/components/cashier/offlinePayment.ts:41-244`; online path unchanged at `firestore.ts:455` |
| `voidSession` (unpaid) | **Yes, as a separate function** — `voidSessionOffline` | `src/components/cashier/offlineVoid.ts:1-190`; online `voidSession` at `firestore.ts:894` is still a `runTransaction` |
| Guest-count verify (`handleVerify`) | Already a `writeBatch`, not a transaction | `src/components/server/ServerPageClient.tsx:165` |
| Which path fires | UI-level branch on `useOnlineStatus()` | `src/components/cashier/payment-modal.tsx:367` |

`commitLocalFirst()` is the mechanism underpinning all of the above: it calls
`batch.commit()` but deliberately **does not await** the returned promise (which
only resolves on server ack, which never happens offline) — it fires and returns
immediately, routing any eventual server-side failure to an `onError` callback
[VERIFIED, `src/lib/offline/commit.ts:1-32`].

### 6.4 Receipt numbering offline
Covered in §5 — local per-device daily counter, `-OL-`-marked, never renumbered.

### 6.5 The deferred-effects queue (what replaces server-only side effects)
Loyalty earn/redeem, PIN finalize/disable, and analytics-delta application all
require `/api/*` server routes (Admin SDK), which are unreachable offline (and, per
the design doc, excluded from the Capacitor static-export build entirely) — these
are never allowed to block a sale. `completePaymentOffline` records a
`QueuedPayment` entry in `localStorage` (`offline_payment_queue`) with one status
per deferred effect (`analytics`\|`loyaltyFinalize`\|`loyaltyEarn`\|`pinFinalize`\|`loyaltyReverse`, each `pending`\|`done`\|`skip`) [VERIFIED,
`src/lib/offline/payment-queue.ts:1-91`; enqueue call `offlinePayment.ts:229-241`].
On reconnect, `usePaymentQueueSync` drains the queue, calling
`replayDeferredEffects()` per item, which POSTs each pending effect to its
`/api/*` endpoint and marks it `done` only on HTTP success, leaving it `pending`
(never re-recorded, never double-applied) on failure for the next retry pass
[VERIFIED, `src/lib/offline/replayDeferredEffects.ts:1-90`; drain loop
`src/hooks/use-payment-queue-sync.ts:1-80`, exponential backoff 2s→30s over 5
attempts]. A **thrown** error (vs. a plain HTTP failure) is treated as a
**terminal conflict** — the item is marked `status:"failed"` and surfaced via a
destructive toast, with **no retry and no UI to inspect or re-drive it**
(confirmed still true: `docs/superpowers/backlog/2026-07-03-offline-pos-deferred-work.md:19` "a terminal item sits `status:"failed"` in localStorage with no UI to inspect or retry it").

### 6.6 What is known to break / is explicitly deferred (all confirmed still true against current source)
- **Connectivity signal is naive.** `useOnlineStatus()` is bare `navigator.onLine`
  plus `online`/`offline` DOM events — no reachability probe [VERIFIED,
  `src/hooks/use-online-status.ts:1-21`]. `navigator.onLine` reports "attached to a
  network interface," not "Firestore/backend is actually reachable." The 4B
  "reachability service" the backlog doc calls out as the fix was **not** found in
  the codebase (no `connectivity.ts`, no ping-based hook). A device on a captive
  portal or with a flaky uplink will believe it's online and route sales through
  the `runTransaction` online path, which will then hang/fail differently than the
  offline path was designed to handle.
- **No server-side guardrail rules** for offline-write conflicts — §5's second RISK.
- **Loyalty earn/redeem never runs offline** — deliberately deferred to sync, to
  avoid point double-spend [VERIFIED, design doc §8 risk table; `payment-queue.ts` effect list].
- **KDS screens do not see offline-placed tickets in real time** — only the local
  Bluetooth/USB kitchen printer backup covers offline kitchen routing; the
  networked KDS "catches up on reconnect" (by design, not a bug) [VERIFIED, design
  doc §8].
- **Minor confirmed-open items** from the backlog doc, still unaddressed as of this
  read: an offline void with nothing to sync still enqueues a queue item and shows
  a misleading "will sync" toast (M2); the reconnect-drain success toast says
  "sale" even for a void (M3); an offline void's `rtKdsTickets` station-doc update
  is unguarded against the station doc being absent from cache, which would fail
  the *entire* void batch on sync (M1, "accepted as-is").
- **Multi-tab race window, acknowledged not closed.** The offline receipt-number
  allocator is a synchronous `localStorage` read-modify-write, explicitly
  documented as race-free only "within a single webview" — a multi-tab web context
  (as opposed to the single-webview Capacitor APK, the actual shipping target)
  could interleave two tabs and reuse a sequence number [VERIFIED,
  `src/lib/offline/offlineReceiptNumber.ts:53-62`, code comment].

### 6.7 Printing (works offline, not the risk area)
ESC/POS receipt text is built locally (`receiptFormatter.ts`) and sent over
Bluetooth (Capacitor plugin) or WebUSB — no network dependency beyond an
already-`localStorage`-cached logo image with a graceful skip [INFERRED from design
doc §1, not independently re-verified against `receiptFormatter.ts`/`printHub.ts` source in this pass].

---

## 7. Payments

**Configuration**: `ModeOfPayment` docs per store (`stores/{storeId}/storeModesOfPayment`), each with `type` (`cash`\|`card`\|`online`\|`other`), `hasRef` (whether a reference number is required), and an optional `gateway: 'paymongo_qrph'` marking it as an auto-confirming gateway tender [VERIFIED, `src/lib/types.ts:852-866`].

**Split payments**: fully supported at the UI level — `payment-modal.tsx` maintains
`payments: Payment[]`, letting the cashier `addPayment()` repeatedly to add
independent `{methodId, amount, reference}` rows before completing [VERIFIED,
`src/components/cashier/payment-modal.tsx:119-338`]. Both `completePaymentFromUnits`
and `completePaymentOffline` sum all payment rows per resolved method name into a
`mopMap` (§4) and validate the total against `amountDue` with a 1-cent tolerance.

**E-wallet / card handling**: two distinct patterns —
1. **Display-only static QR** (`SavedQrCode`, `stores/{storeId}/savedQrCodes/{id}`): a saved GCash/Maya/bank EMVCo QR payload shown to the customer; the cashier still rings the sale through the normal Mode-of-Payment flow. No amount/reference is captured from the scan itself — "showing a customer a photograph of a QR is exactly what this design avoids" [VERIFIED, `src/lib/types.ts:868-948`]. A `PaymentProof` photo (§1) is the only artifact, deliberately amount/reference-free, 15-day TTL.
2. **PayMongo QR Ph gateway** (auto-confirming): `POST /api/pos/paymongo/create-qr` builds a PayMongo Payment Intent + Payment Method + attach call, storing a `PosPaymentIntentDoc` at `stores/{storeId}/paymentIntents/{id}` with `status: awaiting_payment` [VERIFIED, `src/lib/payments/paymongo/qrph.server.ts:40-72`]. `GET /api/pos/paymongo/status` polls it; the webhook (below) also updates it. `mapIntentStatusToDocStatus` maps PayMongo's `succeeded → paid`, `awaiting_next_action`/`processing`/`awaiting_payment_method` → `awaiting_payment` [VERIFIED, `qrph.server.ts:89-102`].

**PayMongo webhook** — `POST /api/webhooks/paymongo` [VERIFIED,
`src/app/api/webhooks/paymongo/route.ts:1-52`]:
- Auth: HMAC signature verification on the raw body via the `paymongo-signature`
  header and `PAYMONGO_WEBHOOK_SECRET_POS` env secret; unverified requests get 401.
- **Correlates by `paymentIntentId` via a reverse index** at
  `paymongoIntentIndex/{paymentIntentId}` (written at create-qr time) —
  *"PayMongo does NOT echo the PaymentIntent's metadata onto the `payment.paid`
  resource, so gating on `ev.metadata` silently ignores every real POS payment.
  Index-doc existence IS the POS-vs-storefront filter now"* (code comment,
  `:30-33`). An event whose intent isn't in the POS's own index is presumed to be
  a storefront (website) event and silently ignored (`ok:true, ignored:true`).
  This means POS and the public Website apparently share the **same PayMongo
  account/webhook stream**, disambiguated purely by this index doc — relevant to
  the shared-backend design since both apps' payment intents currently live in
  the same external namespace.
- Applies the parsed webhook event to the `PosPaymentIntentDoc` inside a
  transaction, tracking `processedEventIds[]` for idempotency.

---

## 8. The analytics layer

**Path**: `stores/{storeId}/analytics/{YYYYMMDD}` — one document per store per
calendar day (Asia/Manila) [VERIFIED, `dailyAnalyticsDocRef()`,
`src/lib/analytics/daily.ts:129-131`]. Day boundaries are computed explicitly against
the `Asia/Manila` timezone via `Intl.DateTimeFormat`, with an inline comment warning
that using host-local `Date#getHours()` shifted every hourly bucket by −8h in
production (Cloud Run runs UTC) [VERIFIED, `daily.ts:44-58`].

**Shape**: matches the `DailyMetric` type — `payments` (gross, tx count, by-method
map, discounts/charges totals, split by dine-in/walk-in), `guests`, `sales` (by
package name, by addon category/item, by hour, by day-of-week, split by mode),
`kitchen` (served/cancelled counts and durations by ticket type/location/user),
`server` (order-confirm timing by user), `sessions` (closed count, total paid,
durations), `refills`, `items` (voided/free/discounted/refunded totals) [VERIFIED,
`src/lib/types.ts:1326-1427`].

**How it's built — two mechanisms that must agree**:
1. **Per-receipt delta**, applied at the moment of sale/void/refund:
   `applyAnalyticsDeltaV2` (client, `increment()`-based Firestore writes) or
   `applyAnalyticsDeltaServer` (Admin SDK server-first variant) compute a
   `ContributionSet` (payment/guest/sales/peak-hour/refill/closed-session/item-adjustment/day-of-week contributions, each a pure function over one receipt) and apply them as field-level `increment()`s onto the day doc — **incremental**, not a rewrite [VERIFIED, `src/lib/analytics/applyAnalyticsDeltaV2.ts:1-35`; contribution functions in `daily.ts`].
   `applyReceiptDeltaServerFirst` is the server-first-with-client-fallback wrapper used by, e.g., the refund flow (`firestore.ts:1509-1518`).
2. **Full rebuild / reconcile**, run by cron or manually:
   `aggregateDailyMetrics()` (pure aggregation core, SDK-agnostic) re-scans
   receipts + kitchen tickets + verified sessions for a date window and rebuilds
   each day's `DailyMetric` **from scratch** [VERIFIED, `src/lib/analytics/backfill-core.ts:1-119`]. The code comment is explicit:
   > *"day docs are written with **merge:false**, and materialising an out-of-window
   > day here would overwrite that day's real analytics with a near-empty doc."*
   (`backfill-core.ts:76-78`)

**Is it rebuilt/backfilled?** Yes, on two schedules:
- `reconcile-analytics` cron, every 15 minutes — a cheap **backstop**, not a full
  rebuild: it only sweeps receipts left `analyticsApplied:false` (or
  `analyticsReversed:false`) by a transient endpoint failure and applies just
  those via the idempotent server writer — "cheap single-field queries (≈0 docs on
  a healthy system)" [VERIFIED, `src/app/api/cron/reconcile-analytics/route.ts:1-36`].
- A separate, more destructive **full backfill** path exists
  (`src/app/api/analytics/backfill/route.ts`, `src/lib/analytics/backfillViaServer.ts`,
  admin-triggered) that reruns `aggregateDailyMetrics` over a date range and
  overwrites (`merge:false`) each day doc entirely — not independently re-verified
  line-by-line in this pass beyond confirming the `merge:false` contract in
  `backfill-core.ts`.

> **RISK (already known, reconfirmed in code)**: because a rebuild derives
> `kitchen`/per-staff stats **only from `kitchentickets` documents that still
> exist**, any operation that purges kitchen ticket history (a retention job, a
> manual cleanup) makes the next rebuild **silently zero** kitchen and per-staff
> serve-time stats for that window, while refill stats (sourced from the receipt's
> own baked `servedRefillsByName`, not from ticket docs) survive. This matches
> prior operational history for this system and is a direct consequence of the
> `merge:false`, ticket-sourced rebuild design confirmed at `backfill-core.ts:76-119`.

---

## 9. `api/external/*`, `api/admin/storefront-catalog`, `api/webhooks/paymongo`

### 9.1 Auth model for `api/external/*`
Static API key in the `x-api-key` header, checked in constant time
(`timingSafeEqual`) — **not** Firebase Auth [VERIFIED,
`src/lib/server/external-auth.ts:1-71`]. Two tiers:
- A single global key (`POS_EXTERNAL_API_KEY` env) → unrestricted, sees all stores.
- Optional per-consumer scoped keys (`POS_EXTERNAL_API_KEYS_JSON`, a `{key: [storeId,...]}` map) → restricted to their listed stores via `storeAllowed()`.
No misconfiguration silently passes: if neither env var is set, every request 500s
with "Server misconfigured."

### 9.2 The 8 routes

| Route | Returns | Consumer (per code comments) |
|---|---|---|
| `GET /api/external/feedback?storeId&date` | Day-level rollup of `stores/{id}/customerFeedbackDays/{MMDDYYYY[-NN]}` chunked docs (max 400/doc, walked until a chunk is missing) [VERIFIED, `route.ts:1-40`] | External aggregator (comment: "mirrors the sales endpoint's auth+param contract") |
| `GET /api/external/inventory-items?storeId` | The store's **full** sellable catalogue from `stores/{id}/inventory` (archived excluded, inactive included with their flag) [VERIFIED, `route.ts:1-40`] | ERP mapping screen — explicit: "you map a POS item to an ERP stock item BEFORE the first pull, including items that have never sold" |
| `GET /api/external/payment-methods?storeId` | Union of configured `storeModesOfPayment` names + any method names seen in the last 14 analytics day docs (covers legacy/renamed modes) [VERIFIED, `route.ts:1-40`] | ERP |
| `GET /api/external/sales?storeId&date` | One `stores/{id}/analytics/{YYYYMMDD}` doc's `payments`/`sales`/`guests` sections, or `{found:false}` [VERIFIED, `route.ts:1-40`] | ERP daily sales pull |
| `GET /api/external/sold-items?storeId&date` | Per-item sold quantities for one store/day, keyed by POS inventory doc id, computed from a **bounded receipts scan** (not the pre-aggregated analytics doc) — explicitly for "stable ids, correct refund netting, and comped units kept separate." Returns `physicalQty`/`billableQty`/`freeQty` per item and lets the ERP choose which to deduct [VERIFIED, `route.ts:1-35`] | ERP inventory-usage pull → posts consumption to ERP stock |
| `GET /api/external/staff-metrics?storeId&date` | Per-`serverProfileId` performance: serve/confirm timing from the analytics day doc + gross sales from a bounded receipts scan attributed via `createdByUsername` [VERIFIED, `route.ts:1-30`] | ERP, maps `profileId → staff.posProfileId`, sums monthly |
| `GET /api/external/staff-profiles?storeId` | `stores/{id}/serverProfiles` list (device-local staff sign-in profiles) [VERIFIED, `route.ts:1-32`] | ERP POS↔staff mapping picker |
| `GET /api/external/stores` | Active stores (id/name/address) from the shared `getActiveStores()` cache, filtered to the key's `allowedStoreIds` if scoped, capped at 500 [VERIFIED, `route.ts:1-37`] | ERP |

All 8 are **read-only GET**, all require `storeId`, all reject with 400/403/401 on
missing/forbidden/unauthenticated. None accept writes.

### 9.3 `api/admin/storefront-catalog`
Different auth model entirely: Firebase ID token Bearer auth
(`getAdminAuth().verifyIdToken`) + `requireActiveStaff` role check
(`admin`\|`manager`\|`cashier`, with cashiers restricted to two day-to-day toggle
ops only) [VERIFIED, `src/app/api/admin/storefront-catalog/route.ts:14-38`]. Ops:
`get` (read `storefrontCatalog/main` + `storefrontConfig/main` + store's
online-order flags), `rebuild` (rebuild the catalog via
`rebuildStorefrontCatalog`), `set-config`/`set-accepts`/`set-availability`/`set-delivery-enabled`. This is POS's **own admin UI** talking to its own backend — not
an ERP integration point — and the resulting `storefrontCatalog`/`storefrontConfig`
docs are what the public Website reads to render the online menu.

### 9.4 `api/webhooks/paymongo`
Covered in §7 — HMAC-signature auth, reverse-index correlation
(`paymongoIntentIndex/{paymentIntentId}`) as the POS-vs-storefront filter, idempotent
via `processedEventIds[]`.

---

## 10. Scale

| Metric | Count | How measured |
|---|---|---|
| Page routes (`page.tsx`) | **49** | `find src/app -name page.tsx \| wc -l` |
| API routes (`route.ts`) | **62** | `find src/app/api -name route.ts \| wc -l` |
| Source files (`.ts`/`.tsx`) | **601** | `find src -name "*.ts" -o -name "*.tsx" \| wc -l` |
| Total LOC (`src/`) | **~98,900** | `wc -l` over all `.ts`/`.tsx` under `src` |
| Firestore collections, top-level | **~14 confirmed** (`stores`, `products`, `staff`, `users`, `customers`, `packages`, `refills`, `flavors`, `addonCategories`, `productRequests`, `productPhotoRequests`, `globalDiscounts`, `globalCharges`, `loyaltyRewards`) + `paymongoIntentIndex`, `paymentProofs` | grep of literal `collection(db, "...")`/`doc(db, "...", ...)` calls; not exhaustive (dynamic paths excluded) |
| Firestore collections, per-store (`stores/{id}/...`) | **~55 distinct subcollection names confirmed** (`sessions`, `receipts`, `analytics`, `analyticsMonths`, `analyticsYears`, `onlineOrders`, `tables`, `inventory`, `kitchenLocations`, `rtKdsTickets`, `cashHandovers`, `reservations`, `savedQrCodes`, `paymentIntents`, `storeModesOfPayment`, `storeDiscounts`, `storeCharges`, `storePackages`, `storeRefills`, `storeFlavors`, `serverProfiles`, `weatherRecords`, `dashPresets`, `holidayCalendar`, `catalogCache`, `storefrontCatalog`, `storefrontConfig`, `activityLogsByDay`, `chatThreads`, `customerRequests`, `waitlist`, `optionOverrides`, `dailyContext`, `salesForecasts`, `menuSchedules`, `paymentConversions`, `qrWallet`, `qrWalletEvents`, plus per-session/per-order nested `sessionBillLines`, `kitchentickets`, `payments`) | grep of template-literal `stores/${storeId}/{name}` and `collection(db, "stores", storeId, "{name}")` call sites; not exhaustive |
| Cron jobs (Cloud Scheduler) | **9**, verified live against `gcloud scheduler jobs list` per `docs/CRON.md` | `log-weather` (hourly), `generate-daily-insight` (1–5am), `update-accuracy` (4am), `generate-forecast` (5–9am), `reconcile-analytics` (*/15min), `purge-expired-pins` (Sun 3am), `rebuild-customer-catalog` (3:15am), `rebuild-presets` (12:30am), `holiday-calendar` (monthly, 1st 2am) — split across two GCP regions (asia-southeast1 ×8, asia-east1 ×1 for `rebuild-presets`) |

---

## Appendix: files read for this pass (not exhaustive of the whole repo)

`src/lib/types.ts` (full, 1842 lines) · `src/components/cashier/firestore.ts` (key
sections, 1521 lines total) · `src/components/cashier/offlinePayment.ts` (full) ·
`src/components/cashier/offlineVoid.ts` (partial) · `src/lib/offline/*.ts` (all 9
non-test files, full) · `src/lib/money.ts`, `src/lib/tax.ts` (full) ·
`src/lib/firebase/client.ts` (partial) · `src/hooks/use-online-status.ts`,
`src/hooks/use-payment-queue-sync.ts` (full) · `src/app/api/admin/online-orders/route.ts`
(partial, ~350 of 654 lines) · `src/app/api/external/*/route.ts` (all 8, heads) ·
`src/lib/server/external-auth.ts` (full) · `src/app/api/admin/storefront-catalog/route.ts`
(partial) · `src/app/api/webhooks/paymongo/route.ts` (full) ·
`src/lib/payments/paymongo/qrph.server.ts` (full) · `src/lib/analytics/daily.ts`
(partial) · `src/lib/analytics/backfill-core.ts` (partial) ·
`src/app/api/cron/reconcile-analytics/route.ts` (full) ·
`src/components/receipts/VoidReceiptModal.tsx`, `ReRingLinkModal.tsx` (full) ·
`src/components/server/ServerPageClient.tsx` (partial) ·
`src/context/auth-context.tsx` (partial) · `docs/CRON.md`,
`docs/superpowers/specs/2026-07-01-offline-first-pos-cashier-design.md`,
`docs/superpowers/backlog/2026-07-03-offline-pos-deferred-work.md` (all full).

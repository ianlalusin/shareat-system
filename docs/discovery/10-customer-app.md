# 10 — CUSTOMER App Discovery

Scope: `C:\Users\ianla\webapps\CUSTOMER` (read-only). Cross-checked against `C:\Users\ianla\webapps\POS` (read-only) only where CUSTOMER's own code references a cross-repo contract. Every claim is tagged `[VERIFIED]` (read the code at the cited line) or `INFERRED` (reasoned from structure, not directly read). `RISK` callouts flag anything likely to bite a relational rebuild — no fixes proposed.

---

## 0. What this app is, in one paragraph

CUSTOMER is a Next.js 15 / React 19 diner-facing web app (no native client) that a guest opens on their own phone, either by scanning a table QR code or typing a 6-character PIN. It shares one Firebase project (`shareat-hub-v2`) with POS `[VERIFIED src/firebase/config.ts:1-9]`. It has no independent identity system for dine-in ordering — it borrows POS's `activeSessions` and issues a scoped custom-auth token per phone. It also carries a self-contained loyalty program ("Sharelebrator"), a flash-ad system, guest feedback capture, a small staff back office (`/admin`), and a mini-games shelf. It talks to a shared Postgres/relational future backend not at all today — everything is Firestore.

---

## 1. User-facing features and routes

`[VERIFIED]` — file listing at `find src/app -name "page.tsx" -o -name "route.ts"`.

| Route | Purpose |
|---|---|
| `/` (`src/app/page.tsx`) | PIN entry. 6-char customer PIN → session; PIN `000000` is an **admin shortcut** that redirects to `/admin/login` (`src/app/page.tsx:30-33`) — a bare string comparison, not a real gate. |
| `/join` (`src/app/join/page.tsx`) | QR-code join: reads `?t=` join token, exchanges it, redirects to `/dashboard`. |
| `/dashboard` (`src/app/dashboard/page.tsx`, 496 lines) | The whole ordering hub: menu/cart (`CustomerCatalog`), order history + running bill (`SessionOrdersPanel`), refill modal, "Add Griller" request, "Ask for assistance" button, loyalty card drawer, feedback bubble, flash-ad overlay, games shelf entry point. |
| `/closed` | Shown when the cashier disables customer access mid-session (session-ended landing page). |
| `/play`, `/play/flipit`, `/play/samgyup-recipe` | Mini-games shelf: a grilling reflex game (no session required) and a recipe-sharing/voting game (session required). |
| `/sharelebrator/card`, `/sharelebrator/redeem` | Standalone loyalty card access **outside** a table session (phone+password login). |
| `/admin/*` (login, PIN dashboard, categories, flash-ads, feedback, games moderation, preview) | Staff back office. Plain Firebase Auth, no client-side role gate on the pages themselves (see §9). |

**Scale** `[VERIFIED]`: 16 page routes, 45 API route handlers (`src/app/api/**/route.ts`), 66 components, 15 server-only lib modules under `src/lib/server/`, 19 test files, **~25,100 LOC** across `src/` (`find src -name "*.ts" -o -name "*.tsx" | xargs wc -l` → 25,086).

---

## 2. Identity and auth

**There is no persistent diner account for dine-in ordering.** Identity is a Firebase custom-auth token, minted server-side, scoped to one table session.

- **Device identity**: a random id in `localStorage["shareat_device_id"]`, created client-side (`src/lib/device-id.ts:15-35`). Falls back to a fresh (non-persistent) id in private-mode/storage-blocked browsers — by design, so it can never impersonate an existing participant (`device-id.ts:29-34`).
- **PIN join** (`src/app/api/customer/exchange-pin/route.ts`): looks up `pinRegistry/{PIN}` (root collection) `[VERIFIED :45]`, validates it's `active` and unexpired `[:51-56]`, loads the session via `loadAndValidateSessionAccess` (`src/lib/server/customer-session-access.ts:18-56`), then claims a **participant slot**.
- **QR join** (`src/app/api/customer/exchange-qr/route.ts`): verifies an HMAC-SHA256-signed, stateless join token (`src/lib/server/customer-join-token.ts:12-30`, secret in `CUSTOMER_JOIN_TOKEN_SECRET`), checks it against a `customerJoinVersion` counter on the session doc so an old printed QR slip stops working the moment a new one is issued (`exchange-qr/route.ts:62-65`).
- **Participant slot claim** (`src/lib/server/customer-participants.ts:26-119`): `hashDeviceId()` (SHA-256, truncated to 16 hex chars, `:15-17`) becomes the Firestore doc id under `stores/{storeId}/activeSessions/{sessionId}/customerParticipants/{participantId}` — so the same phone always maps to the same doc, making the join transaction idempotent with no query needed. A session has a `customerParticipantLimit` derived from guest count (`customer-session-access.ts:37-41`); exceeding it throws `"Session is full."` `[:80-85]`.
- **The token itself**: `auth.createCustomToken(claimedByUid, { customer: true, storeId, sessionId, participantId })` (`exchange-pin/route.ts:80-85`, mirrored in `exchange-qr/route.ts:82-87`). Every customer-facing API route decodes this and trusts `storeId`/`sessionId`/`participantId` from the **token claims**, never the request body — this is the app's entire authorization model for dine-in routes.
- **Loyalty ("Sharelebrator") identity is a separate system**: phone + bcrypt password, doc id = **normalized phone number** (`customers/{phone}`, `src/lib/phone.ts:6-20` — Philippine numbers → `+63XXXXXXXXXX`). Loyalty tokens carry `{ loyaltyCustomer: true, phone }` instead of `{ customer: true, ... }` (`signup/route.ts:80-83`). Password hash via `bcrypt.hash(password, 10)` (`signup/route.ts:46`).
- **Linking a loyalty account to a table session** (`sharelebrator/link-session/route.ts`) writes `linkedCustomerPhone` / `linkedCustomerName` / `linkedByParticipantId` onto **both** `stores/{storeId}/activeSessions/{sessionId}` and `stores/{storeId}/sessions/{sessionId}` `[:264-274]`. Only the participant who linked it is treated as the cardholder going forward (`linkedByParticipantId === decoded.participantId`, enforced in `sharelebrator/me/route.ts:53-66`); every other diner at a linked table is explicitly told "another diner" linked it rather than shown the card — this guard exists specifically because the link lives on the shared session doc `[me/route.ts:42-51 comment]`.
- **Admin identity**: plain Firebase Auth (email/password or Google popup, `src/app/admin/login/page.tsx:25-59`). `/admin/page.tsx` has **no client-side role check** — it renders for any signed-in Firebase user; authorization is enforced only downstream, by (a) Firestore rules checking custom claims `role`/`admin`/`platformAdmin`, and (b) individual API routes reading a `staff/{uid}` doc (e.g. `src/app/api/admin/my-stores/route.ts:27`, `.../cleanup-archived-pins/route.ts:28`). Nothing in this repo sets those custom claims or writes `staff/{uid}` — **INFERRED** they're provisioned by POS/ERP or an out-of-band script.
- **Games identity is a third, deliberately separate scheme**: same hashed device id, but under prefix `d_` (`src/lib/games/identity.ts:30,43-46`), explicitly NOT derived from phone/loyalty identity. The file's own header comment records that a phone-based key was designed and rejected, because `linkedCustomerPhone` is shared table-wide and would collapse every diner at a linked table onto one vote/authorship identity.

**RISK**: three parallel identity schemes (session-participant, loyalty-phone, game-device) that intentionally do NOT unify, plus an admin-shortcut PIN (`000000`) hardcoded in the client (`src/app/page.tsx:30-33`) that is a UX shortcut only — not itself an access grant, but a magic string in the client bundle for a `/admin/login` redirect is a smell in a rebuild that centralizes auth.

---

## 3. Core entities and Firestore paths

Every path below was found via `db.doc(`/`db.collection(` calls in `src/**/*.ts` (Admin SDK, server-side) plus the handful of direct client-SDK reads. **Bold** = collections CUSTOMER and POS (or ERP) both write to — the highest-risk items for a unified backend.

| Path | Owner / writer(s) | Key fields (as read/written here) | Notes |
|---|---|---|---|
| `pinRegistry/{pin}` (root) | POS/ERP writes; CUSTOMER reads (`exchange-pin/route.ts:45`) and **client-side deletes** via the admin UI (`src/app/admin/page.tsx:178`, `deleteDoc`) | `storeId`, `sessionId`, `status`, `expiresAtMs` | See RISK in §9 — client-side delete of an access-control doc. |
| **`stores/{storeId}/activeSessions/{sessionId}`** | POS owns session lifecycle; **CUSTOMER also writes** `linkedCustomerPhone/Name/ByParticipantId` (`link-session/route.ts:271`, `unlink-session/route.ts`), `customerParticipantActiveCount` (`customer-participants.ts:113-115`) | `customerAccessEnabled`, `customerAccessExpiresAtMs`, `customerJoinVersion`, `customerParticipantLimit`, `tableNumber`, `tableDisplayName`, `packageOfferingId`, `packageName`, `initialFlavorIds`, `sessionMode`, `status`, `guestCount*`, `customerPin`, `linkedCustomer*` | **Cross-write.** Also read directly by the client SDK for a live `onSnapshot` listener (`dashboard/page.tsx:170-191`) that detects the cashier closing the session. |
| **`stores/{storeId}/sessions/{sessionId}`** | POS's durable session record; **CUSTOMER writes** the same `linkedCustomer*` fields (`link-session/route.ts:236-237`, `unlink-session`, `update-profile`) | mirrors `activeSessions` link fields | **Cross-write.** |
| `stores/{storeId}/activeSessions/{sessionId}/customerParticipants/{participantId}` | CUSTOMER-only writer | `slotNumber`, `status`, `joinedAt`, `claimedByUid`, `deviceIdHash`, `joinMethod`, `pinSnapshot`, `refillCooldowns` (map), `orderClaims` (map) | Doc id = hashed device id. `refillCooldowns` and `orderClaims` are per-diner idempotency/rate-limit state stored on this doc, not a separate collection. |
| `stores/{storeId}/closedSessions/{sessionId}` | POS writes (session close); CUSTOMER reads only (`submit-feedback/route.ts:54`) | — | Feedback can be submitted after checkout, hence the fallback read here. |
| **`stores/{storeId}/sessions/{sessionId}/kitchentickets/{ticketId}`** | **Both POS and CUSTOMER write.** CUSTOMER via `writeKitchenTicket()` (`src/lib/server/kitchen-ticket-write.ts:51-124`) for `type: "refill"` and `type: "addon"`; POS writes other types (e.g. staff-placed, `"package"`) | `type`, `itemId`, `itemName`, `qty`, `qtyOrdered/Served/Cancelled/Remaining`, `status`, `createdByParticipantId`, `source` (`"customer_app"` on CUSTOMER writes), `billOnServe`, `pendingBillLine`, `flavorNote`, `refillIds` | **Highest cross-write risk collection in the app.** The comment at `kitchen-ticket-write.ts:12-13` explicitly instructs keeping `meta.source` as "POS's own writer sets it" so a CUSTOMER-written ticket is indistinguishable from a POS one. |
| **`stores/{storeId}/rtKdsTickets/{kitchenLocationId}`** | **Both** write, via a read-modify-write transaction over `activeIds`/`tickets`/`sessionIndex` maps | fan-out projection of live KDS tickets | Written by `writeKitchenTicket()` (`kitchen-ticket-write.ts:58-121`) **and** re-implemented inline (not via the shared helper) in `src/app/api/customer/repeat-first-order/route.ts:163-224` — see RISK below. |
| `stores/{storeId}/sessions/{sessionId}/sessionBillLines/{lineId}` | POS-owned; CUSTOMER reads only (`session-orders/route.ts:81`, `src/lib/catalog/running-bill.ts`) | `qtyOrdered`, `voidedQty`, `freeQty`, `unitPrice`, `modifiersTotal`, `lineAdjustments` | POS writes a bill line here when the kitchen marks a customer-app ticket served — confirmed cross-repo contract, see §4. |
| `stores/{storeId}/catalogCache/main` | POS-owned (`rebuildCustomerCatalog`); CUSTOMER reads only | `categories[]` (families/variants/option groups), `orderingEnabled`, legacy flat `items[]` | The **pricing authority** for every customer order — see §4/§7. |
| `stores/{storeId}/catalogCache/popularItems` | POS-owned; CUSTOMER reads only | `counts` (sold-item tally) | Drives the "Popular" menu section, resolved per-request, not baked into the cache. |
| `stores/{storeId}/storePackages/{packageOfferingId}` | POS/ERP-owned; CUSTOMER reads only | `refillsAllowed[]`, `packageName` | |
| `stores/{storeId}/storeRefills/{refillId}` | POS/ERP-owned; CUSTOMER reads only, via `refillOptionsCache` (see below) | `refillName`, `isOther`, `kitchenLocationId`, `isEnabled`, `sortOrder` | |
| `stores/{storeId}/storeFlavors/{flavorId}` | POS/ERP-owned; CUSTOMER reads only | `flavorName`, `isEnabled` | |
| `refills/{id}` (root, global) | POS/ERP-owned (chain-wide kill switch); CUSTOMER reads only | `isActive`, `requiresFlavor`, `allowedFlavorIds` | Two independent enable switches — see §5. |
| `stores/{storeId}/refillOptionsCache/main` | **CUSTOMER-owned cache**, self-rebuilding | `storeRefills[]`, `refills[]`, `storeFlavors[]`, `updatedAtMs` | Written by `rebuildRefillOptionsCache()` (`src/lib/server/refill-options-cache.ts:104-120`); self-heals if stale/missing (`:128-148`) so a POS/ERP edit that forgets to trigger a rebuild can't serve stale-forever. |
| `stores/{storeId}/customerRequests/{id}` | CUSTOMER-only writer (`request-assistance`, `request-griller` routes) | `type` (`assistance`\|`griller`), `sessionId`, `participantId`, `status`, `text` | INFERRED read by POS/KDS for staff alerting (code comments say so; not verified in POS). |
| **`customers/{phone}`** (root, doc id = normalized phone) | **Both write.** CUSTOMER creates it (`signup/route.ts:48-60`, `link-session` signup path) and increments/decrements `pointsBalance`/`pointsReserved` for transfers and redemption holds; **POS writes `pointsBalance` too** (confirmed: `POS/src/lib/server/loyalty.ts:78,219,238,386,533` — credits on paid receipts, debits on redemption apply/finalize) | `passwordHash`, `name`, `address`, `email`, `bday`, `pointsBalance`, `pointsReserved`, `visitCount`, `storeVisits` | **Confirmed cross-write** on a mutable balance both apps must agree on. |
| `customers/{phone}/pointsLedger/{id}` | CUSTOMER writes `transfer_in`/`transfer_out` entries (`transfer-points/route.ts:148-175`); POS writes point-earning entries (INFERRED — same subcollection referenced by rate-limit reads in `transfer-points/route.ts:24-35`, not independently verified in POS) | `type`, `points`, `amount`, `storeId`, `sessionId`, `createdAt` | |
| `loyaltyRewards/{rewardId}` (root, global) | POS/ERP-owned; CUSTOMER reads only | `name`, `pointsCost`, `type`, `value`, `isActive`, `applicableStoreIds`, `disabledStoreIds` | Scope logic mirrored byte-for-byte between the two repos — see §6. |
| **`loyaltyRedemptions/{id}`** (root, global) | **Both write.** CUSTOMER creates at claim time (`redeem/route.ts:117-125`) with `status:"active"`, `pointsSpent:false`, points only *held* (`reservedPoints`); POS applies it to a session and, at payment finalize, stamps `appliedReceiptId`/`pointsSpent:true` (confirmed `POS/src/lib/server/loyalty.ts:179-269, 426-469, 507-561`) | `code`, `phone`, `rewardId`, `pointsCost`, `status`, `appliedStoreId/SessionId/ReceiptId`, `pointsSpent`, `reservedPoints` | **Confirmed cross-write.** This is the exact hand-off point where a diner's phone-side redemption becomes a POS bill line — see §6. |
| `loyaltyStats/global` (root) | CUSTOMER increments `totalAccounts` on signup | — | |
| `loyaltyLogs/{id}`, `loyaltyLogsDaily/{dayId}_{part}` | CUSTOMER-only writer (`src/lib/server/loyaltyLog.ts`) | audit trail: login, signup, transfer, redemption events | Sharded daily doc, 500 entries/part cap (`loyaltyLog.ts:11`). |
| `staff/{uid}` (root) | POS/ERP-owned (INFERRED, not in this repo); CUSTOMER reads only, to gate admin API routes | role/permission fields (not enumerated here) | |
| `categories/{id}` (root, global) | Ambiguous — CUSTOMER's own admin UI does direct client CRUD (`src/app/admin/categories/page.tsx`); not verified whether POS also owns this collection | `name`, `sortOrder` | |
| `products` (root, global) | POS-owned; CUSTOMER admin reads only (`src/app/api/admin/pos-products/route.ts:36`) | — | |
| `stores/{storeId}` (root doc) | POS/ERP-owned; CUSTOMER reads only (name, `loyaltyConfig.redemptionExpiryMinutes`) | — | |
| `stores/{storeId}/flashAds/{id}` | **CUSTOMER-owned**, no evidence POS touches it | `imageUrl`, `active`, `clickBehavior`, `redirectUrl` | Admin UI does direct client CRUD (`admin/flash-ads/page.tsx`); dashboard reads directly via client SDK, gated by a `where("active","==",true)` query the rules require (`dashboard/page.tsx:240-243`, comment explains an unfiltered read was previously denied). |
| `stores/{storeId}/customerFeedbackDays/{dayKey[-NN]}` | CUSTOMER-only writer/reader | sharded array of feedback entries, 400/doc cap | |
| `miniGames/{id}`, `gameRecipes/{id}`, `gameFeeds/{id}`, `gameAuthors/{id}`, `gameStats/{dayId}` | CUSTOMER-only, no POS involvement found | game config/content | Collection names resolved from `src/lib/server/games/config.ts:6`, `recipe-store.ts:35-37`, `stats-store.ts:19`. |

---

## 4. The ordering flow, end to end

**Browse → cart → send → kitchen → serve → bill**, for a diner's self-service add-on order (not the cashier's opening package order):

1. **Browse**: `GET /api/customer/catalog-items` reads `stores/{storeId}/catalogCache/main` (POS-owned, one doc) and `catalogCache/popularItems`, projects through `projectCatalog()` which **whitelists every field** so internal kitchen routing never reaches the browser (`src/lib/catalog/project.ts:17-27`), and returns `{ categories, orderingEnabled }` (`catalog-items/route.ts:56-67`).
2. **Cart**: client-only state in `CustomerCatalog.tsx` (`src/components/customer/CustomerCatalog.tsx:82-236`). Client computes a display total but sends **no price** to the server — only `productId`/`variantId`/`qty`/`modifiers`/`note` (`CustomerCatalog.tsx:205-215`).
3. **Send**: `POST /api/customer/submit-addon-order`. Re-derives every price server-side from the **same raw catalog snapshot** (`resolveOrderLines()`, `src/lib/catalog/order-validation.ts:193-282`) — "the client sends ids and quantities only; every peso is recomputed here" (`order-validation.ts:8-11`). All-or-nothing validation before any write (`submit-addon-order/route.ts:75-80`). A `clientRequestId` (client-generated UUID) is claimed in a transaction on the participant doc so a double-tap cannot double-order (`src/lib/server/order-claim.ts:48-80`).
4. **Kitchen**: writes ONE `kitchentickets` doc per line via `writeKitchenTicket()` — **no bill line yet**. The ticket carries `billOnServe: true` and a full `pendingBillLine` snapshot (price, modifiers, kitchen routing) so a later catalog price change can't retroactively alter what the diner was quoted (`submit-addon-order/route.ts:117-138`, contract documented in `POS/src/lib/kitchen/customer-order-billing.ts:1-32`).
5. **Serve → bill**: on the POS side (confirmed, read-only), when the kitchen marks the ticket served, POS's `buildCustomerOrderBillLine()` (`POS/src/lib/kitchen/customer-order-billing.ts:114-141`) creates a `sessionBillLines` doc field-for-field identical to a staff-placed add-on, tagged `orderedVia: "customer_app"` for provenance only. `billLineId` on the ticket stays `null` until first serve — load-bearing, because the cancel path voids against `billLineId` and a never-served ticket must touch no bill line (`customer-order-billing.ts:26-32`).
6. **Diner-visible status**: `GET /api/customer/session-orders` polls (20s interval, `src/hooks/use-session-orders.ts:57`) rather than using a live Firestore listener, because "the client SDK cannot read kitchentickets (rules deny it)" (`use-session-orders.ts:54-56`). It collapses POS's ticket statuses into `preparing | partially_served | served | cancelled` (`session-orders/route.ts:38-44`) and computes a **running bill that is deliberately partial** — only the unambiguous line subtotal, explicitly NOT the POS-authoritative total with tax/discounts/loyalty (`src/lib/catalog/running-bill.ts:1-23`).

**Statuses that exist**: ticket-level `preparing`, `partially_served`, `served`, `cancelled` (kitchen ticket status, POS-owned state machine); order-claim de-dup keyed by `clientRequestId`; session-level `customerAccessEnabled`/`customerAccessExpiresAtMs` gate every write route.

**Who transitions them**: CUSTOMER only ever creates tickets in `preparing`. All status transitions (`partially_served`, `served`, `cancelled`) are POS/KDS-side — not in this repo.

**RISK**: `src/app/api/customer/repeat-first-order/route.ts` (245 lines) duplicates the entire `writeKitchenTicket`/`rtKdsTickets` fan-out logic inline (`:162-224`) instead of calling the shared `writeKitchenTicket()` helper every other write path uses — two independently-maintained writers of the same fan-out shape. The route's own comment says "No UI calls this route today... but it is a live endpoint that writes refill tickets" (`:98-100`) — a dead-but-reachable, drift-prone write path.

---

## 5. Refills

Rules are isomorphic/pure (no Firestore) in `src/lib/refill-cooldown.ts:1-30` and enforced server-side identically.

- **Eligibility gate**: a refill type is blocked for one participant while **either** (a) it's still "in the kitchen" (their last ticket for it not yet `served`/`cancelled`), **or** (b) under 60 seconds (`REFILL_COOLDOWN_MS`, `:32`) has passed since the *later* of their order and the kitchen serving it. Rule (a) has a 10-minute safety valve (`OUTSTANDING_BLOCK_MAX_MS`, `:43`) so a ticket the kitchen never closes can't lock a meat forever.
- **Anchor**: the minute anchors on the **serve**, not the order — deliberately, per the comment at `refill-cooldown.ts:19-24`, because anchoring on order time meant the cooldown had already expired before the food arrived.
- **Scope**: per-meat AND per-phone — `refillCooldowns` is a map keyed by refill id, stored on the **participant** doc, not the session (`readCooldownMap`, `src/lib/server/refill-cooldown.ts:40-43`).
- **First-serving gate**: the table's opening package order must have reached the table before ANY refill can be ordered — a 20-minute safety valve (`FIRST_SERVING_BLOCK_MAX_MS`, `src/lib/session-orders.ts:59`) so a package ticket the kitchen forgets doesn't lock refills for the whole meal. This valve is duplicated (by design, per comment) in both the client (`hasPendingFirstServing`, `dashboard/page.tsx:85`) and server (`refillTicketState`, `src/lib/server/refill-outstanding.ts:134-146,158-187`) — a test (`src/lib/__tests__/refill-cooldown.test.ts`, `src/lib/server/__tests__/refill-outstanding.test.ts`) pins them together.
- **Two independent enable switches** (`src/lib/refill-visibility.ts:1-10`): global `refills/{id}.isActive` (chain-wide kill switch) and store-level `storeRefills/{id}.isEnabled`. The file's own header notes this was a real bug: "Only the second was ever enforced on the displayed list, so deactivating an item in the global admin appeared to do nothing."
- **Claim/release**: `claimRefillCooldowns()` (`src/lib/server/refill-cooldown.ts:66-136`) is a single-doc transaction on the participant record — atomic double-submit protection for free. On a failed ticket write, `releaseRefillCooldowns()` rolls the stamps back so a failed order doesn't cost the guest their next attempt.
- **Storage**: no separate "refill order" collection — a refill is a `kitchentickets` doc with `type: "refill"`, plus its cooldown/outstanding bookkeeping on the `customerParticipants/{id}` doc (`refillCooldowns` map) and derived live from ticket scans (`refillTicketState()`, capped at 60 tickets scanned, `refill-outstanding.ts:32`).
- **"Other Refills"**: several side items bundle into ONE ticket whose `itemId` is the literal string `OTHER_REFILLS`; the real per-side ids ride in a separate `refillIds[]` array so the in-kitchen/cooldown block can still match them individually (`refill-outstanding.ts:34-49`, `submit-refill/route.ts:100-113`).

**RISK**: two safety valves (10 min, 20 min) and a 60-second cooldown are business rules encoded as magic numbers in application code, not configuration in either Firestore or (presumably) the future Postgres schema — a relational rebuild needs to decide where these constants live.

---

## 6. Loyalty ("Sharelebrator")

- **Earning**: happens entirely on the POS side (confirmed cross-write on `customers/{phone}.pointsBalance`, `POS/src/lib/server/loyalty.ts:78`) — not in this repo. CUSTOMER only *reads* the resulting balance.
- **Redemption (claim)**: `POST /api/customer/sharelebrator/redeem` — **does not spend points, it HOLDS them** (`redeem/route.ts:109-111`). Inside a transaction: validates `balance - reserved >= pointsCost`, increments `customers/{phone}.pointsReserved`, and creates a `loyaltyRedemptions` doc with a random 6-char code, `status:"active"`, `pointsSpent:false`, `reservedPoints:pointsCost` (`:116-125`). **Requires an active store session** — `storeId` is taken from the auth token only, never the request body, specifically so a member can't claim a reward their branch has switched off (`:58-70` comment + `isRewardOfferedAtStore` re-check inside the transaction, `:100-102`).
- **Per-store enablement**: `src/lib/loyaltyRewardScope.ts` — two fields, order matters: `applicableStoreIds` (admin allow-list, empty = every store) then `disabledStoreIds` (manager per-branch opt-out). The file's header states this **mirrors `POS/src/lib/loyaltyRewardScope.ts` byte-for-byte** and "must stay identical to it" — a duplicated business rule across two independently-deployed repos.
- **Reaching the POS bill**: the diner is given a **code**, not a redeemed reward — they hand the code to the cashier. POS's `applyLoyaltyVoucherByCode` looks the code up in `loyaltyRedemptions`, attaches it to the session's `loyaltyRedemptions` array, and only at payment finalize stamps `appliedReceiptId`, sets `pointsSpent:true`, and (if not already reserved) debits the balance (confirmed `POS/src/lib/server/loyalty.ts:426-469, 507-561`). So the actual point spend and bill discount are 100% POS-side; CUSTOMER's job ends at "hold points, hand out a code."
- **Expiry / release**: a claimed-but-unused voucher auto-expires after `expiresAtMs` (store-configurable via `stores/{storeId}.loyaltyConfig.redemptionExpiryMinutes`, default 60 min, `redeem/route.ts:9,73-80`); a 24-hour grace window (`RELEASE_GRACE_MS`, `rewards/route.ts:15`) lets the customer manually "Collect Points" (release their own hold) before an automatic sweep does it for them (`rewards/route.ts:24-50`, `collect-voucher/route.ts`).
- **Points transfer** (`transfer-points/route.ts`): diner-to-diner, phone-to-phone, atomic transaction debiting sender/crediting recipient plus two `pointsLedger` entries. Rate-limited: 50 pts/day sent, 100 pts/day received, computed by scanning that day's ledger entries (`:9-10, 24-48`) — not a maintained counter, so this cost scales with ledger volume per customer per day.
- **Card view / gating**: `/sharelebrator/me` only returns the card to the participant who linked it (§2); a "read-only view" path exists for other diners at an already-linked table who prove they own that same card via password (`link-session/route.ts:16-22, 209-250`).

---

## 7. Menu and product data

- **Single source of truth**: `stores/{storeId}/catalogCache/main`, a POS-owned, per-store, single-document cache. CUSTOMER is "strictly read-only with respect to it" (`src/lib/catalog/types.ts:6-8`). CUSTOMER never reads POS's underlying inventory/product collections directly for pricing — always this cache, one Firestore read per menu load regardless of catalogue size (`catalog-items/route.ts:39-51` comment).
- **Product identity**: two ids ride together on every entry/variant — `productId` (the catalogue/display key) and `inventoryId` (POS's actual store inventory doc id). Order resolution explicitly prefers `inventoryId` when present, falling back to `productId` for older snapshots (`order-validation.ts:229-241`), because "a customer order keyed on the product id would bucket separately from the identical item sold at the counter" in POS's sold-items analytics (`order-validation.ts:41-45` comment).
- **Families/variants**: a "group" entry (e.g. Kimbap) has multiple sellable `variants[]`, each with its own price/orderability/option-groups; a variant's option groups override the family's rather than merging with it (`optionGroupsFor()`, `src/lib/catalog/project.ts:83-88`) — the same resolver is shared by the menu UI and the pricing/validation route so a diner can never see an option the server would then reject.
- **Backward compatibility**: if POS hasn't shipped the family-aware cache format for a store yet, `projectCatalog()` derives categories from a legacy flat `items[]` array (`project.ts:139-176`) — CUSTOMER tolerates an older POS write shape.
- **Freshness**: catalog price changes require POS to rebuild the cache, which POS fires "on every manager inventory edit" (per comment at `catalog-items/route.ts:43`) — CUSTOMER has no independent cache-invalidation and simply trusts the doc is current.

---

## 8. Reads vs writes

| Collection / path | CUSTOMER reads | CUSTOMER writes | Also written by POS/ERP |
|---|---|---|---|
| `pinRegistry/{pin}` | Yes | **Yes (client-side `deleteDoc`, admin UI)** | Yes (creation) |
| `stores/{s}/activeSessions/{id}` | Yes (server + 1 direct client listener) | Yes (link fields, participant count) | Yes |
| `stores/{s}/sessions/{id}` | Yes | Yes (link fields) | Yes |
| `stores/{s}/.../customerParticipants/{id}` | Yes | Yes (sole writer) | No (not verified) |
| `stores/{s}/sessions/{id}/kitchentickets/{id}` | Yes (via API, not client SDK) | Yes | Yes |
| `stores/{s}/rtKdsTickets/{loc}` | No | Yes | Yes |
| `stores/{s}/sessions/{id}/sessionBillLines` | Yes | No | Yes |
| `stores/{s}/catalogCache/main`, `/popularItems` | Yes | No | Yes |
| `stores/{s}/refillOptionsCache/main` | Yes | Yes (self-rebuild) | No (mirrors POS/ERP source collections) |
| `stores/{s}/storeRefills`, `storeFlavors`, `storePackages` | Yes | No | Yes |
| `refills/{id}` (global) | Yes | No | Yes |
| `stores/{s}/customerRequests/{id}` | No | Yes (sole writer) | Read only (INFERRED) |
| `customers/{phone}` | Yes | Yes | **Yes (pointsBalance)** |
| `customers/{phone}/pointsLedger` | Yes (rate-limit scans) | Yes | Yes (INFERRED) |
| `loyaltyRewards/{id}` | Yes | No | Yes |
| `loyaltyRedemptions/{id}` | Yes | Yes (claim) | **Yes (apply/finalize)** |
| `loyaltyStats/global`, `loyaltyLogs*` | No | Yes (sole writer) | No |
| `staff/{uid}` | Yes (gate checks) | No | Yes (INFERRED) |
| `categories/{id}` (global) | Yes (admin UI, client SDK) | Yes (admin UI, client SDK) | Unclear |
| `products` (global) | Yes (admin UI) | No | Yes |
| `stores/{s}/flashAds/{id}` | Yes (client SDK) | Yes (admin UI, client SDK) | No (CUSTOMER-owned) |
| `stores/{s}/customerFeedbackDays/{id}` | Yes (admin UI) | Yes (sole writer) | No |
| Games collections (`miniGames`, `gameRecipes`, `gameFeeds`, `gameAuthors`, `gameStats`) | Yes | Yes | No |

**A client writes data a server later trusts**: none found for money. Every price is recomputed server-side from `catalogCache/main` (§4, §7); no route trusts a client-sent price or a client-computed cart total. The **loyalty points transfer/redemption paths do trust client-sent quantities** (`points`, `rewardId`) but validate them against server-read balances inside a transaction before committing — no unvalidated client numeric input reaches a balance field.

**The one place a client write is trusted without further validation downstream**: `customerParticipants/{id}.customerNameSnapshot` / `tableDisplayNameSnapshot` are snapshotted from the session doc at join time (server-side, not client-supplied — `customer-participants.ts:107-109`), so this is not actually a risk; flagged here only because it reads like client-controlled data at a glance.

---

## 9. Security rules

- **Ruleset file**: `firestore.rules` at repo root, deployed via `firebase deploy --only firestore:rules` against the `.firebaserc` alias `customerapp` → project `shareat-hub-v2` (`.firebaserc:1-7`) — **the same Firebase project POS deploys to**. This is the mechanism behind the standing memory landmine "CUSTOMER repo nukes POS rules": deploying from this repo with `-P customerapp` overwrites whatever ruleset POS last deployed, because both target the identical project.
- **RISK — this repo's `firestore.rules` looks stale/incomplete relative to what the live app needs.** It explicitly denies everything under `stores/{storeId}` except `catalogCache` and `flashAds` (`firestore.rules:74-77`: `match /{subpath=**} { allow read, write: if false; }`). But the dashboard's live session-status listener does a **direct client-SDK read** of `stores/{storeId}/activeSessions/{sessionId}` (`dashboard/page.tsx:170`, `SharelebratorCardView.tsx:96`), which is not covered by any explicit rule in this file and would be denied by the catch-all. Since the app demonstrably works in production, the **actually-deployed ruleset must differ from what's checked into this repo** — either POS's last deploy added the missing rule and this file is out of date, or this file has simply never been deployed. Either way, deploying this checked-in file as-is would very likely break the live dashboard's session-closed detection and the loyalty card's session read, on top of overwriting POS's rules for the shared project.
- **Everything else bypasses rules entirely**: the overwhelming majority of CUSTOMER's Firestore access goes through Next.js API routes using the **Admin SDK** (`src/lib/firebase/admin.ts`), which ignores security rules altogether. Authorization for those routes is 100% custom-token-claim checks in each route handler (`decoded.customer === true`, `decoded.storeId`, etc.) — not Firestore rules. Only the handful of routes listed in §2/§8 as "client SDK" reads/writes (dashboard session listener, flash ads, admin categories/pinRegistry/flash-ads CRUD, loyalty card view) are actually rules-governed.
- **Broader-than-needed client write access**: `src/app/admin/page.tsx:178` performs a raw `deleteDoc(doc(firestore, "pinRegistry", pinId))` straight from the browser, gated only by whatever role check the (possibly-stale) rules enforce for `pinRegistry` — no server-side audit trail, no soft-delete, no route-level validation. Every other admin mutation in this repo (categories, flash-ads) is likewise a direct client write, not routed through a server action.
- **Two custom-claim vocabularies coexist** in the rules file: `request.auth.token.role in ['admin','manager']`, `.admin == true`, and `.platformAdmin == true` are all treated as equivalent (`firestore.rules:8-16`) — three different ways staff privilege has apparently been expressed over time, none of them defined or set anywhere in this repo.

---

## 10. Scale summary

`[VERIFIED]` via direct counts on 2026-08-23.

| Metric | Count |
|---|---|
| Page routes (`page.tsx`) | 16 |
| API route handlers (`route.ts`) | 45 |
| React components | 66 |
| Server-only lib modules (`src/lib/server/`) | 15 |
| Test files | 19 |
| Total LOC (`src/**/*.ts(x)`) | ~25,100 |
| Distinct Firestore collections/roots touched (server + client) | ~30 (enumerated in §3) |
| Collections confirmed written by both CUSTOMER and POS | 5: `activeSessions`, `sessions`, `kitchentickets`, `rtKdsTickets`, `customers`, `loyaltyRedemptions` (6, counting `customers` separately from the balance-bearing subcollection) |

---

## Open questions this investigation could not resolve read-only

- Whether `categories` (root, global) is genuinely shared with POS or is a CUSTOMER-only leftover — only CUSTOMER's admin UI writes it in either repo's code I read.
- Whether `customerRequests` and `customers/{phone}/pointsLedger` (earn side) are actually read/written by POS as INFERRED, or by some third system (ERP) not in scope for this investigation.
- Whether the checked-in `firestore.rules` in this repo has ever actually been deployed, or whether POS's rules (not read in this investigation) are the ones truly live for `shareat-hub-v2`.

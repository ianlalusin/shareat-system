# 11 — Website (shareat.net) Integration & Data Inventory

Scope: `C:\Users\ianla\webapps\Shareat Website` (Astro project, Firebase-hosted, project id `shareat-website`). Read-only discovery for the ERPv2 unified-Postgres-backend architect. Every claim is `[VERIFIED]` (read in the code) or `INFERRED` (reasoned from structure); surprising/fragile behaviour is flagged **RISK**.

---

## 1. What the site is and how it's built

| Fact | Value | Source |
|---|---|---|
| Framework | Astro `^5.7.0` | `package.json:23` |
| Output mode | `output: "static"` — fully static-generated, **no SSR/hybrid** | `astro.config.mjs:8` |
| Styling | Tailwind CSS 4 via `@tailwindcss/vite` | `astro.config.mjs:3,11`, `package.json:22,26` |
| Site origin | `https://shareat.net` | `astro.config.mjs:7` |
| Sitemap | `@astrojs/sitemap`, excludes `/admin` | `astro.config.mjs:9` |
| Build assets dir | `_assets`, inlined stylesheets | `astro.config.mjs:13-16` |
| Hosting | Firebase Hosting, `public: "dist"`, `cleanUrls: true` | `firebase.json:9-17` |
| Deploy command | `npm run build && firebase deploy --only hosting` (manual, not CI-triggered from this repo) | `package.json:17` |
| Backend | Firebase Cloud Functions v2, Node 20, region `asia-southeast1`, single file `functions/index.js` (2,335 lines) | `firebase.json:2-5`, `functions/index.js:1-24` |
| Node engine | `>=22.9.0` | `package.json:8` |

**Routes** (18 `.astro` page files under `src/pages`):
`/` (`index.astro`), `/about`, `/admin`, `/events`, `/events/[slug]`, `/grill-at-home`, `/locations`, `/locations/[slug]`, `/menu`, `/menu/[slug]`, `/privacy`, `/promos`, `/reserve`, `/services`, `/shop`, `/shop/checkout`, `/shop/order`, `/shop/orders`. [VERIFIED — `Glob`/`find` of `src/pages`]

`/locations/[slug]` and `/menu/[slug]` are Astro `getStaticPaths()` routes pre-rendered at build time from a content collection — **every branch page is a static HTML file baked at build**, not rendered per-request. `[slug].astro:11-17` (locations), `menu/[slug].astro:11-15` (menu, additionally filtered to branches with generated pricing).

---

## 2. External data dependencies (full inventory)

The website is a thin static frontend over **one true backend it does not own**: the POS's Firestore project `shareat-hub-v2`. Nothing in the browser talks to `shareat-hub-v2` directly — every read/write goes through this repo's own Cloud Functions, which hold the only credential (a service-account key, `HUB_SA_KEY`) that can reach the hub project. `functions/index.js:1-15`.

### 2a. HTTPS API endpoints (browser → this repo's Cloud Functions)

All are Firebase Hosting rewrites in `firebase.json:18-75`, App-Check-gated (`appCheckOk()`, `functions/index.js:240-254`) except the PayMongo webhook.

| Route | Function | Auth | Reads/Writes (hub project unless noted) | Breaks-if-down |
|---|---|---|---|---|
| `GET/POST /api/reservation-locations` | `getReservationLocations` | App Check | Reads `stores` (`acceptsReservations==true`) + legacy `reservationLocations` fallback (site project) | Reserve page can't list branches — shows error, no reservation possible |
| `POST /api/reserve` | `createReservation` | App Check | Writes `stores/{id}/reservations` | Can't book a table |
| `GET/POST /api/chat-locations` | `getChatLocations` | App Check | Reads `stores` (`acceptsWebsiteChat==true`, open now) | Widget shows no branches |
| `POST /api/chat-send` | `chatSend` | App Check (+ order token for order-bound) | Writes `stores/{id}/chatThreads/{id}/messages`, rate-limits via site-project `otpRateLimits` | Can't message a branch |
| `POST /api/chat-poll` | `chatPoll` | App Check (+ order token) | Reads `chatThreads/{id}/messages` | Replies stop appearing (page still loads) |
| `POST /api/chat-resolve-order` | `chatResolveForOrder` | App Check + order `publicToken` | Reads/creates `stores/{id}/chatThreads/order_{orderId}` | Order-bound chat can't open |
| `GET/POST /api/storefront-catalog` | `getStorefrontCatalog` | App Check | Reads `stores/{id}`, `storefrontCatalog/main`, `storefrontConfig/main`, `collectionGroup("kitchentickets")` | `/shop` shows no menu — **whole storefront down** |
| `GET/POST /api/storefront-stores` | `getStorefrontStores` | App Check | Reads `stores` (`acceptsOnlineOrders==true`), filters open-now | Store picker on `/shop` shows nothing |
| `POST /api/storefront-otp-send` | `sendOtp` | App Check | Writes site-project `otpCodes`/`otpRateLimits`; calls Semaphore/UniSMS/Resend | Can't verify phone/email — checkout blocked |
| `POST /api/storefront-otp-verify` | `verifyOtp` | App Check | Reads/writes site-project `otpCodes` | Same |
| `POST /api/storefront-order` | `placeOrder` | App Check + checkout token | Writes `stores/{id}/onlineOrders/{id}`, `customers/{phone}` (hub); notifies via Resend/Semaphore | **Cannot place an order** |
| `GET/POST /api/storefront-order-status` | `storefrontOrderStatus` | App Check + order `publicToken` | Reads `onlineOrders/{id}`, `savedQrCodes` | Confirmation page can't poll status |
| `POST /api/storefront-customer-orders` | `getCustomerOrders` | App Check + session token | Reads `onlineOrders` where `customerPhone==` | "My Orders" empty/errors |
| `POST /api/storefront-paymongo-webhook` | `paymongoWebhook` | **PayMongo HMAC signature only — no App Check** | Writes `onlineOrders/{id}.payment.paid`, `paymentEvents` (idempotency doc) | A paid-via-PayMongo order never flips to `pending` — **but this path is effectively dead**, see §4/RISK below |
| (scheduled, not HTTP) | `expireStalePendingPayments` — `every 15 minutes` | n/a | Reads/writes `onlineOrders` where `status=="pending_payment"` | Abandoned wallet orders never auto-expire (currently **dry-run only**, see below) |

`resolveStoreId`/`resolveOrderStoreId` distinguish "browse/checkout" calls (must resolve a *currently valid, online* store) from "lookup an existing order/chat" calls (trust the order's own token, never re-validate the store) — `functions/index.js:208-220,656-667`.

### 2b. Firestore — direct client SDK access (no Cloud Function in between)

| Where | Collection | Project | Read/Write | Gate |
|---|---|---|---|---|
| `src/scripts/admin.ts:44-141` | `reservationLocations` | **this site's own project** (`shareat-website`) | Public read; admin-only write (Firebase Auth email allow-list) | `firestore.rules:13-23` — only `admin@shareat.net` / `ianlalusin@gmail.com` |

This is the **only** Firestore collection the browser touches directly. `firestore.rules:34-36` closes everything else (`allow read, write: if false`), including `otpCodes`/`otpRateLimits` (Admin-SDK-only, `firestore.rules:27-32`). The site's own Firestore database is otherwise unused by the public site.

### 2c. Env vars naming external services

| Var | Purpose | File |
|---|---|---|
| `PUBLIC_FIREBASE_*` (6 vars) | Client Firebase SDK config (site project) | `.env:4-9` |
| `PUBLIC_RECAPTCHA_V3_SITE_KEY` | App Check provider | `.env:13` |
| `PUBLIC_GA_MEASUREMENT_ID` | Google Analytics 4 | `.env:20`, `src/components/GoogleAnalytics.astro` |
| `PUBLIC_META_PIXEL_ID` | Meta Pixel (browser) | `.env:24`, `src/components/MetaPixel.astro` |
| `MENU_BUILD_SA_KEY_PATH` | **Build-time-only** service-account key path for `shareat-hub-v2` | `.env:34`, `scripts/fetch-store-packages.mjs:51-62` |
| `PUBLIC_RESERVATIONS_ENABLED` / `PUBLIC_CHAT_ENABLED` / `PUBLIC_SHOP_ENABLED` | Build-time feature flags, inlined at `astro build` | `.env:17-18,28` |
| `HUB_SA_KEY` (secret) | Admin SDK cross-project credential to `shareat-hub-v2` — the single credential that lets this repo write to the POS database | `functions/index.js:26,231-236` |
| `META_CAPI_TOKEN`, `CHECKOUT_TOKEN_SECRET`, `OTP_PEPPER`, `SEMAPHORE_API_KEY`, `UNISMS_API_KEY`, `RESEND_API_KEY`, `PAYMONGO_SECRET_KEY`, `PAYMONGO_WEBHOOK_SECRET` (secrets) | Meta Conversions API, HMAC signing, OTP hashing, 2× SMS providers, transactional email, PayMongo (unused, see below) | `functions/index.js:32,41-47`, `functions/.env.example:59-73` |
| `STOREFRONT_STORE_ID` | Non-secret pilot-store fallback id | `functions/.env.example:8-13` |
| `GCASH_ACCOUNTS` | JSON map `storeId -> {name, number}` for manual GCash rail | `functions/.env.example:41-46` |

**RISK — a live secret is committed in plaintext in the repo root `.env`.** `.env:4,9,13,21,34` contains a real Firebase API key, App ID, reCAPTCHA site key, and — critically — line 21 contains what appears to be a **live OpenAI service-account API key** (`sk-svcacct-...`) that has no corresponding reference anywhere in the codebase (grep found no `OPENAI_API_KEY` usage in `src/` or `functions/`). This key is unused dead config but sits in a file that, if this repo's `.gitignore` doesn't exclude `.env` (not verified here), would be committed. Flagging for the architect/owner to rotate/remove — out of scope to fix here.

---

## 3. The storefront (catalog/menu)

Two entirely separate "menu" surfaces exist and must not be confused:

### 3a. `/shop` — the live online-ordering catalog
- Fetched live at page-load from `GET /api/storefront-catalog`, never baked at build. `src/scripts/shop-catalog.ts:456-485`.
- Server resolves the store id (query param, from the store picker), reads `stores/{id}`, `storefrontCatalog/main` (**the price authority** — comment at `functions/index.js:1776`), `storefrontConfig/main`, and a live count of `kitchentickets` in `preparing` to compute a dynamic prep-ETA. `functions/index.js:1516-1567`.
- No caching: response header `Cache-Control: no-store` (`functions/index.js:1535`). Every page load is a fresh Firestore read fan-out (4 reads/queries) per storefront visit.
- **Price re-derivation happens twice**: display prices come from the catalog snapshot; `placeOrder` re-flattens the *same* snapshot server-side and recomputes every line/modifier total from scratch, rejecting anything the client didn't submit against it (`functions/index.js:1776-1832`). A tampered client cannot underpay.
- Store selection (`/shop`) is **not** URL/session based — it's `localStorage` (`shareat_store_id`), gated through `mountStorePicker()` which re-validates the cached id against the live open-branch list on every visit and clears it if stale. `src/scripts/shop-store.ts:16-32,183-196`.
- Store eligibility for delivery/pickup is computed **client-side by haversine distance** from browser geolocation against `deliveryRadiusKm`/`pickupRadiusKm` on each store. `src/lib/store-eligibility.ts:33-54`, mirrored server-side for the actual order-placement guard (`functions/index.js:75-86,1754-1771`).

### 3b. `/menu` and `/menu/[slug]` — the SEO/marketing menu (unli-samgyupsal packages)
- **Baked at build time**, not live. A `prebuild` npm hook (`scripts/fetch-store-packages.mjs`) runs before every `astro build`, pulls `storePackages` + `menuSchedules` + `contactNumber` from `shareat-hub-v2` for **3 hardcoded branches** (`lipa`, `malvar`, `davao` — `scripts/fetch-store-packages.mjs:14-18`), and writes a static JSON snapshot to `src/data/.generated/store-packages.json`. `package.json:13`.
- The build **fails hard** (throws, non-zero exit) if any enabled package is missing a valid price — `scripts/fetch-store-packages.mjs:88-101` — a deliberate refuse-to-ship-wrong-prices guard.
- Page copy (descriptions, meat lists) is merged in from a separate content collection (`src/content/packageCopy/*.md`), matched by a normalized base name stripped of an `LT-`/`DT-` prefix — `src/lib/menu-merge.mjs:1-17,45-69`. A package with no matching copy entry logs a build warning but still renders (price-only row).
- `hasMenuPage()` is the single gate for "does this branch get a `/menu/{slug}` page and menu link": both a `storeId` in frontmatter *and* a nonempty generated packages entry for that slug. `src/lib/menu-branches.mjs:15-17`.

**RISK — two independently-sourced prices for the same products can drift.** `/menu` (unli packages) is a build-time snapshot that goes stale between deploys; `/shop` (à la carte items) is live. There is no cross-check between them, and nothing forces a rebuild when POS pricing changes — see §8.

---

## 4. Online ordering — the exact path from site to POS

1. Browser loads `/shop`, picks a store (client geolocation → haversine, §3a), fetches live catalog via `getStorefrontCatalog`.
2. Cart is pure `localStorage` (`shareat_cart_v1`) — client display only, never trusted. `src/scripts/shop-cart.ts:27,38-57`.
3. At `/shop/checkout`, buyer must OTP-verify a phone (default) or email via `sendOtp`/`verifyOtp`, which mint a 15-minute HMAC `checkoutToken` (`functions/index.js:1095-1112,1683-1687`). Optionally a 30-day "save my info" twin token is saved for faster return checkout (`functions/index.js:1948-1954`).
4. `POST /api/storefront-order` (`placeOrder`, `functions/index.js:1696-1962`) is the **only write path that creates an order**. It:
   - Re-validates the checkout token, store openness, delivery radius (server haversine vs. `deliveryRadiusKm`).
   - Re-flattens and re-prices every cart line/modifier against the live `storefrontCatalog/main` snapshot (never trusts client-submitted prices).
   - Upserts `customers/{+63phone}` in the hub (merge-only, never overwrites loyalty fields) — `functions/index.js:1849-1858`.
   - Writes `stores/{storeId}/onlineOrders/{autoId}` with a random `publicToken` (the sole credential for all subsequent status/chat lookups) and initial `status`: `"pending_payment"` if `payment.method==="wallet"`, else `"pending"`. `functions/index.js:1860-1888`.
   - Fires a best-effort (2s-capped, never-throwing) email+SMS "order received" notification via Resend/Semaphore, recording the outcome back onto the order doc (`notifyOrderPlaced`, `functions/index.js:1461-1513`).
   - Fires a fire-and-forget server-side Meta Conversions API event.
   - Returns `{orderId, publicToken, redirectUrl: null, sessionToken?}` — the browser then redirects to `/shop/order?orderId=…&token=…`.
5. `/shop/order` polls `GET /api/storefront-order-status` every 6s using the `publicToken` as the sole bearer credential (no session/auth) — `src/scripts/shop-order-status.ts:169-198,222-223`. It also surfaces a payment QR (`loadPaymentQr`, `functions/index.js:2060-2104`) picked deterministically from the store's `savedQrCodes`, and an order-bound chat thread (§below) for GCash coordination.
6. **Payment is out-of-band and manual**: the customer sends GCash/Maya money to a number shown in the order-confirmation email/SMS/QR, then a **cashier in the POS confirms the transfer manually**, moving the order from `pending_payment` to `pending`. There is **no automated payment capture** in the current design. `functions/index.js:1732-1737,1862-1864` and confirmed in `PROJECT-BIBLE.md:174-184` ("GCash wallet-to-wallet Send Money is FREE and is the primary rail... The cashier confirms against the GCash app's Transactions tab, never a screenshot").
7. Order status thereafter is driven entirely by the **POS**, not this repo — this repo has no write path past order creation except the (effectively dead) PayMongo webhook and the abandoned-order sweeper.

**Collections/endpoints involved (hub project `shareat-hub-v2`):** `stores/{id}`, `stores/{id}/storefrontCatalog/main`, `stores/{id}/storefrontConfig/main`, `stores/{id}/onlineOrders/{id}`, `stores/{id}/onlineOrders/{id}/paymentEvents/{eventId}`, `stores/{id}/chatThreads/{id}/messages`, `stores/{id}/savedQrCodes`, `customers/{+63phone}`, `collectionGroup("kitchentickets")`.

**RISK — PayMongo (automated card/GCash-gateway payment) is dead code still wired into prod config.** `exports.paymongoWebhook` still exists and is deployed (`firebase.json:71-74`), still binds `PAYMONGO_WEBHOOK_SECRET`, and the repo's own `PAYMONGO-GOLIVE.md` describes it as "fully built... remaining work is config + deploy." But `functions/index.js:1699-1701` explicitly documents that `placeOrder` **no longer creates a PayMongo checkout session and deliberately does not bind `PAYMONGO_SECRET_KEY`** — `redirectUrl` is now hardcoded `null` (`functions/index.js:1894`), and `payMethod` collapses any non-`"wallet"` value (including the literal legacy string `"paymongo"`) to `"cod"` (`functions/index.js:1732-1737`). **`PAYMONGO-GOLIVE.md` is stale/describes a retired design** — do not use it as a source of truth for the current payment architecture; the code comments in `functions/index.js` are authoritative.

**RISK — the abandoned-payment sweeper is dry-run by default and its default window (120 min) assumes manual GCash, not gateway checkout, so it does not match the docs.** `expireStalePendingPayments` only *logs* what it would expire unless `EXPIRY_DRY_RUN=false` is explicitly set (`functions/index.js:2254-2257`) — no evidence in this repo of whether it's been flipped live.

---

## 5. Store data — names, addresses, hours, contact numbers

| Field | Source | Live or baked | Notes |
|---|---|---|---|
| Name, tagline, address, hours (dine-in/delivery/daily), `mapUrl`, features, social links | **Hand-typed markdown frontmatter**, `src/content/branches/{slug}.md`, schema in `src/content/config.ts:3-27` | Baked at build (content collection) | 4 branches: `lipa`, `malvar`, `davao`, `banay-banay`. A 5th (Padre Garcia) is hardcoded prose on `/locations`, not a content entry (`locations.astro:86-107`) — "coming soon" |
| Phone number | **Live POS `contactNumber`** (`stores/{id}` field) pulled at build time by `fetch-store-packages.mjs:76-78`, else falls back to the hand-typed `phone` in the branch's frontmatter | Build-time only | `resolvePhone()` (`src/lib/branch-phone.mjs:14-19`) prefers the live value only if it has ≥7 digits (filters POS data-entry junk like a stray `"0"`); `davao.md` has **no fallback phone at all** (`phone:` blank), so if the live pull ever fails or the branch's POS `contactNumber` is unset, the Davao page silently omits the phone block entirely (`{phone && (...)}`, `locations/[slug].astro:185-194`) |
| Package/menu pricing | Live POS `storePackages`/`menuSchedules`, only for `lipa`/`malvar`/`davao` (not `banay-banay`, which has no `storeId`) | Build-time only (`/menu`); live (`/shop`, separate item catalog) | See §3 |
| Store id (POS `stores/{id}` doc key) | Hand-typed in frontmatter (`storeId:`), kept "in sync by hand" per the script's own comment | Static | `fetch-store-packages.mjs:12-13`: *"Kept in sync by hand with the storeId field on each branch..."* |

**RISK — three parallel, manually-synced sources of branch identity that can silently diverge:** (1) hand-typed content-collection frontmatter (address/hours/mapUrl/phone-fallback), (2) the hardcoded `BRANCHES` array of `{slug, storeId}` in `scripts/fetch-store-packages.mjs:14-18`, and (3) the live POS `stores/{storeId}` doc (source of truth for `acceptsOnlineOrders`/`acceptsReservations`/`acceptsWebsiteChat`/geo/radii/hours used by the ordering, reservation, and chat gates). Adding a 5th branch in POS requires **manually editing this repo in two places** (content collection + the `BRANCHES` array) and rebuilding — nothing in POS can make a new branch appear on `/menu` or in the address/hours copy on its own. Contrast with online-ordering/reservations/chat eligibility, which read the POS flag live and need zero website changes (§6).

---

## 6. Reservations / enrolment

- **Currently gated off by a build-time flag**, not backend readiness: `PUBLIC_RESERVATIONS_ENABLED` (root `.env:17`, currently `"true"` in the working copy) controls whether `/reserve` shows the live form or a "Coming soon" overlay — `src/pages/reserve.astro:7,53,105-121`. Same pattern for `PUBLIC_CHAT_ENABLED` (`.env:18`) and `PUBLIC_SHOP_ENABLED` (`.env:28`).
- **Current source of truth for "is branch X bookable / chattable / orderable": three independent boolean flags directly on the POS `stores/{id}` doc** — `acceptsReservations`, `acceptsWebsiteChat`, `acceptsOnlineOrders` — queried live by the Cloud Functions on every request. `listWebsiteBranches()`, `functions/index.js:346-368`. No separate registration is needed in this repo; PROJECT-BIBLE.md is explicit that this is a locked decision (`PROJECT-BIBLE.md:249-262`).
- **Retired**: the website's own `reservationLocations` Firestore collection (this repo's own project) used to be the *primary* source — a branch had to be separately registered there or it was invisible even if enabled in POS. It caused a real incident (`PROJECT-BIBLE.md:254-262`: "SharEat Davao went missing from both pickers," 2026-08-19). It is now read only as a **transitional fallback for one field**, `fbPageLink` (Messenger link), when the POS store doc hasn't been given one yet — `functions/index.js:323-344,361,365`. The website's hidden `/admin` page (`src/pages/admin.astro`, `src/scripts/admin.ts`) still exists solely to manage this legacy collection and is explicitly slated for deletion "once every enrolled store has its link set in POS" (`functions/index.js:328-329`).
- Reservation-time validity is additionally checked against an optional `reservationSchedule` (days + time window) on the POS store doc, both client-side (`src/scripts/reserve.ts:35-46`) and server-side (`functions/index.js:303-321,518-519`) — cosmetic vs. authoritative pair, same pattern used throughout this repo.
- Reservation writes go to `stores/{storeId}/reservations` in the hub project (`functions/index.js:521-543`) — a collection this website never reads back from; confirmation is a static "we'll contact you" message plus the branch's Messenger link.

---

## 7. What the site writes into shared/POS data (highest risk for a unified backend)

Every one of these is a **public, unauthenticated (App-Check-only, no user login) write path into the shared database**:

| Write | Target (hub `shareat-hub-v2` unless noted) | Trigger | Trust boundary |
|---|---|---|---|
| New reservation | `stores/{id}/reservations` | Anyone submits `/reserve` | App Check + server-side re-validation of store flags/schedule; no rate limit beyond App Check itself |
| New/updated online order | `stores/{id}/onlineOrders/{id}` | Anyone completes checkout | App Check + OTP-verified checkout token + server-side re-pricing |
| Customer profile upsert | `customers/{+63phone}` | Every placed order | Merge-only (never overwrites loyalty fields), keyed by phone — **a public write path into the customer/loyalty record by phone number alone** |
| Chat messages (site-wide widget) | `stores/{id}/chatThreads/{id}/messages` | Anyone opens the floating widget | App Check + a 10-per-10-min per-IP new-thread rate limit (`checkChatCreateRateLimit`, `functions/index.js:837-849`); an *existing* threadId needs no further proof of ownership beyond holding the id |
| Chat messages (order-bound) | Same, but thread id derived from `orderId` | Customer on `/shop/order` | Order's own `publicToken`, re-checked on every call |
| OTP state | `otpCodes`/`otpRateLimits` (**site's own project**) | Checkout/reservation flows | Admin-SDK only; not client-writable |
| Legacy branch→link mapping | `reservationLocations` (**site's own project**) | Only via `/admin`, Firebase-Auth-gated | Not public |

**RISK — the site-wide chat widget's thread-continuation model is "possession of a bearer id, forever."** A general (non-order) thread, once created, is readable/writable by anyone who has the `threadId` string — no re-check against the original creator. This is called out as an accepted tradeoff in the code itself ("acceptable for a walk-in 'are you open?'", `functions/index.js:626-639`) but is a genuinely different trust model from the order-bound thread (token re-checked every call) and from anything a relational/authenticated backend would naturally offer — worth the architect's attention if chat threads migrate.

**RISK — `customers/{+63phone}` is a public write surface keyed purely by a phone number the caller supplied and OTP-verified.** Any OTP-verified phone can create/update a POS customer/loyalty record from the public internet, merge-only. In a unified Postgres backend this write path (unauthenticated internet → core customer table) needs an explicit trust boundary, not implicit "the merge is safe."

---

## 8. Build/deploy coupling — what's baked vs. live

| Surface | Baked (stale until rebuild) | Live (real-time) |
|---|---|---|
| `/menu`, `/menu/[slug]` (unli packages, pricing, schedules) | **Yes** — `prebuild` script snapshot, only re-pulled on `npm run build` | No |
| `/locations`, `/locations/[slug]` (address, hours, mapUrl, features) | **Yes** — content-collection markdown | No |
| Phone number on branch pages | **Yes** — pulled live from POS only at build time, then baked | No |
| `/shop` catalog (à la carte items, modifiers, prices) | No | **Yes** — fetched on every page load, `Cache-Control: no-store` |
| `/shop` store list/eligibility | No | **Yes** — fetched fresh each visit |
| Reservations/chat/online-ordering **enrolment** (which branches show up at all) | No | **Yes** — queried live from POS `stores/{id}` flags on every request |
| Order status, chat messages | No | **Yes** — polled (6s / 3.5s) |
| Feature on/off switches (`PUBLIC_SHOP_ENABLED` etc.) | **Yes** — Astro inlines `PUBLIC_*` env vars at build time | No |

**Implication for the Postgres migration (INFERRED):** the site is **not** a candidate for reading a Postgres backend directly for its marketing content (`/menu`, `/locations`) without a publish/build step — that content is deliberately static-generated for SEO/perf and gated by a `prebuild` fetch script tied to specific hardcoded branch ids. The transactional surfaces (`/shop`, chat, order status, reservations, enrolment flags) are already built around a live-fetch pattern through this repo's own Cloud Functions layer, so swapping their Firestore reads for Postgres reads (behind the same Cloud Functions, or a successor API) is architecturally straightforward — the browser never talks to the database directly today, everything already goes through a server boundary.

---

## 9. Scale

| Metric | Count | Source |
|---|---|---|
| Astro pages | 18 | `find src/pages -type f` |
| Components | 18 (`.astro`) | `find src/components -type f` |
| Client-side TS scripts (`src/scripts`) | 10 | `find src/scripts -type f` |
| Lib modules (`src/lib`) | 8 | `find src/lib -type f` |
| Content-collection entries | 4 branches, 2 events, 5 package-copy | `find src/content -type f` |
| Backend Cloud Functions file | 1 file, 2,335 lines | `wc -l functions/index.js` |
| Total site LOC (`.astro`/`.ts`/`.mjs`/`.js` under `src/`) | ~7,860 lines | `find src -type f ... | xargs wc -l` |
| Test files | 16 files, ~2,271 lines (`tests/`) | `find tests -type f` |
| API endpoints (HTTPS rewrites) | 13 + 1 scheduled function | `firebase.json:18-75` |
| Firestore collections touched (hub project) | ~11: `stores` (+ subcollections `reservations`, `storefrontCatalog`, `storefrontConfig`, `onlineOrders` (+`paymentEvents`), `chatThreads` (+`messages`), `savedQrCodes`, `storePackages`, `menuSchedules`), `customers`, `products` (global), `optionGroups` (global) | `functions/index.js` (throughout), `PROJECT-BIBLE.md:132-146` |
| Firestore collections owned by this repo's own project | 3: `reservationLocations`, `otpCodes`, `otpRateLimits` | `firestore.rules`, `PROJECT-BIBLE.md:119` |

---

## Appendix — key files for follow-up

- Backend contract: `C:\Users\ianla\webapps\Shareat Website\functions\index.js` (all endpoints, all hub Firestore paths)
- Runtime config surface: `C:\Users\ianla\webapps\Shareat Website\functions\.env.example`
- Build-time pricing pull: `C:\Users\ianla\webapps\Shareat Website\scripts\fetch-store-packages.mjs`
- Content schema: `C:\Users\ianla\webapps\Shareat Website\src\content\config.ts`
- Client Firebase/App-Check wrapper: `C:\Users\ianla\webapps\Shareat Website\src\lib\firebase-client.ts`
- Firestore rules (this repo's own project): `C:\Users\ianla\webapps\Shareat Website\firestore.rules`
- Narrative architecture doc (partially stale — cross-check against code): `C:\Users\ianla\webapps\Shareat Website\PROJECT-BIBLE.md`
- Stale payment doc (describes a retired PayMongo-hosted-checkout design — do not trust): `C:\Users\ianla\webapps\Shareat Website\PAYMONGO-GOLIVE.md`

# 12 — Shared Infrastructure Across POS / ERP / CUSTOMER / Website

Read-only discovery. Scope: the four live repos —
`C:\Users\ianla\webapps\POS`, `C:\Users\ianla\webapps\ERP-rebuild`,
`C:\Users\ianla\webapps\CUSTOMER`, `C:\Users\ianla\webapps\Shareat Website` — none of which
were modified to produce this document. Every claim is `[VERIFIED]` (read directly) or
`INFERRED` (reasoned from structure, not directly confirmed). This document complements
`docs/discovery/10-customer-app.md`, `docs/discovery/11-website.md`, and
`docs/CROSS-APP-MAP.md`; it does not repeat their per-app detail, and it directly answers
`CROSS-APP-MAP.md`'s **Open Question #2** ("which repo owns the Firestore ruleset in the
shared POS/CUSTOMER project?").

---

## 0. Executive summary

- **Three Firebase projects, not four.** POS and CUSTOMER's *live, actually-used* backend is
  the **same project**, `shareat-hub-v2`. ERP-rebuild (`studio-7300228488-a394e`) and the
  Website (`shareat-website`) each have their own, fully separate project. See §1.
- **The single most important finding:** CUSTOMER ships its own `firestore.rules` in its repo,
  and its `.firebaserc` carries an alias (`customerapp` → `shareat-hub-v2`) that lets someone
  run `firebase deploy --only firestore:rules -P customerapp` from inside the CUSTOMER repo and
  push CUSTOMER's own, much smaller ruleset onto POS's live project — **overwriting** the
  ruleset POS actually depends on. There is no reverse risk (POS cannot target CUSTOMER's own
  project by accident; nothing in POS's `.firebaserc` references it). See §2.
- **ERP-rebuild is fully isolated at the infrastructure layer.** Different Firebase project,
  different Firestore database, different Storage bucket, different Auth tenant. Its only
  couplings to the other three are two narrow, explicit bridges: a scoped REST API into POS
  (`x-api-key`), and a Gmail→Apps-Script→ERP HTTP webhook. Nobody can overwrite ERP's rules,
  indexes, or storage by deploying from POS, CUSTOMER, or the Website, and vice versa. See §1–§4, §7.
- **The Website never touches POS's database directly from the browser.** It reaches
  `shareat-hub-v2` exclusively through its own Cloud Functions, authenticated with a
  cross-project service-account credential (`HUB_SA_KEY`) that has full Admin SDK access —
  i.e. it bypasses POS's Firestore rules entirely, by design (Admin SDK always does). See §3, §7.
- **Six-plus Firestore collections are dual-written by POS and CUSTOMER** inside the same
  project — the densest coupling in the whole map (already flagged in
  `docs/discovery/10-customer-app.md` §4a; corroborated independently here with additional
  collections). See §5.

---

## 1. Firebase projects

| App | `.firebaserc` default | Other aliases | Client SDK `projectId` actually shipped | Live project |
|---|---|---|---|---|
| **POS** | `shareat-hub-v2` | `shareat` → `shareat-hub-v2`; `shareatv5` → `shareatv5` (no other reference found anywhere in the repo — `INFERRED` dead/legacy alias) | `shareat-hub-v2` (`src/firebase/config.ts:4`) | `shareat-hub-v2` |
| **ERP-rebuild** | `studio-7300228488-a394e` | none | `studio-7300228488-a394e` (`src/firebase/config.ts:3-4`) | `studio-7300228488-a394e` |
| **CUSTOMER** | `studio-9137697931-f4a93` | `customerapp` → `shareat-hub-v2` | **`shareat-hub-v2`** (`src/firebase/config.ts:5`) — **not** the `.firebaserc` default | `shareat-hub-v2` |
| **Shareat Website** | `shareat-website` | none | `shareat-website` (via `PUBLIC_FIREBASE_PROJECT_ID`, `.env:6`) | `shareat-website`, **plus** a second cross-project credential into `shareat-hub-v2` (§7) |

Sources: `POS/.firebaserc:1-9`, `ERP-rebuild/.firebaserc:1-5`, `CUSTOMER/.firebaserc:1-8`,
`Shareat Website/.firebaserc:1-6`, `POS/src/firebase/config.ts:1-9`,
`ERP-rebuild/src/firebase/config.ts:1-9`, `CUSTOMER/src/firebase/config.ts:1-11`,
`Shareat Website/src/lib/firebase-client.ts:14-21`.

**`[VERIFIED]` CUSTOMER's `.firebaserc` default project (`studio-9137697931-f4a93`) is not what
the app actually runs on.** The hardcoded client `firebaseConfig` in
`CUSTOMER/src/firebase/config.ts` — the config that ships in the deployed bundle — points at
`shareat-hub-v2`. The `admin.ts` Admin SDK fallback also defaults to `"shareat-hub-v2"`
(`CUSTOMER/src/lib/firebase/admin.ts:26`). `studio-9137697931-f4a93` appears to be an unused
leftover from Firebase Studio project scaffolding — nothing else in the repo's runtime code
references it.

Local dev confirms the same thing from the environment side:

```
POS/.env.local:      FIREBASE_PROJECT_ID=shareat-hub-v2
CUSTOMER/.env.local:  FIREBASE_PROJECT_ID=shareat-hub-v2
```
`[VERIFIED]` — both files, grepped directly. Both apps' local Admin SDKs target the **same
live production project** by default.

**RISK:** the `customerapp` alias and CUSTOMER's actual runtime `projectId` are the entire
mechanism behind §2. There is no comment, README, or doc anywhere in the CUSTOMER repo
explaining why `.firebaserc` carries a `customerapp` alias to a *different* project than its
own `default` — the only trace of intent is the alias itself.

---

## 2. Firestore security rules ownership — the overwrite risk

| Repo | Ships `firestore.rules`? | Size | What it actually governs (by its own content) | Deployable to `shareat-hub-v2`? |
|---|---|---|---|---|
| **POS** | Yes | 27,584 bytes (`POS/firestore.rules`, `ls -la`) | The full production ruleset: staff roles read from `staff/{uid}.role` (Firestore doc, not custom claims), `platformAdmin` custom claim as break-glass, store-scoped access via `assignedStoreIds` | Yes — this **is** the live ruleset, per `.firebaserc` default |
| **CUSTOMER** | Yes | 3,238 bytes / 85 lines (`CUSTOMER/firestore.rules`, full file read) | A narrow, explicitly-partial ruleset: `catalogItems`, `categories`, `users`, `staff`, `pinRegistry`, and under `stores/{storeId}` only `catalogCache` and `flashAds` — **everything else under `stores/` is `allow read, write: if false`**, with the file's own comment reading *"everything else under store is blocked for now (POS app rules should be added explicitly)"* (`CUSTOMER/firestore.rules:74`) | **Yes — via the `customerapp` alias** (`-P customerapp`) |
| **ERP-rebuild** | Yes | 31,547 bytes (`ERP-rebuild/firestore.rules`) | Its own, unrelated model: `users/{uid}.role`, `assignedStoreIds` list on the user doc, no `staff` collection | No — different project, `.firebaserc` has no alias to `shareat-hub-v2` |
| **Shareat Website** | Yes | 1,181 bytes (`Shareat Website/firestore.rules`, full file read) | Only `reservationLocations` (public read, allow-listed admin write) plus explicit `allow read, write: if false` on `otpCodes`/`otpRateLimits`. Own comment: *"reservations themselves live in the POS project (shareat-hub-v2) and are written by the Admin SDK function, not from clients"* (`Shareat Website/firestore.rules:7-8`) | No — different project, no alias found anywhere in the repo |

**This is the answer to `CROSS-APP-MAP.md` Open Question #2.** POS owns the ruleset that is
*actually live* in `shareat-hub-v2` today — proven two ways:

1. `[VERIFIED]` CUSTOMER's own checked-in rules **deny** `stores/{storeId}/activeSessions`
   outright (falls into the `stores/{storeId}/{subpath=**} { allow read, write: if false }`
   catch-all, `CUSTOMER/firestore.rules:75-77`), yet CUSTOMER's own admin dashboard reads
   `activeSessions` live (already established independently in `10-customer-app.md` §4e). If
   CUSTOMER's file were the deployed ruleset, CUSTOMER's own admin screen would be broken. It
   isn't — so POS's file is what's actually live.
2. `[VERIFIED]` CUSTOMER's rules gate staff access on **custom claims**
   (`request.auth.token.role`, `.assignedStoreIds`, `.admin`, `CUSTOMER/firestore.rules:7-13,17-18`).
   POS's own `isAdmin()` reads the **Firestore doc** `staff/{uid}.role` instead, and POS's rules
   file contains a long comment explaining that no code in the repo ever calls
   `setCustomUserClaims` for staff roles — only `platformAdmin` is a real claim, set manually by
   `POS/scripts/set-platform-admin.mjs` (`[VERIFIED]`, only 2 hits for `setCustomUserClaims` in
   the whole POS repo: `POS/firestore.rules` (a comment) and `POS/scripts/set-platform-admin.mjs`).
   CUSTOMER's checked-in rules therefore assume a claim shape production staff tokens don't
   carry — further evidence this file was never (or is no longer) the live ruleset, and reads
   as an early draft that was superseded by POS's file without ever being reconciled or deleted.

**RISK — the overwrite is real and one-directional.** Nothing in `POS/.firebaserc` references
CUSTOMER's project (there is only one: `shareat-hub-v2`, twice-aliased). CUSTOMER's
`.firebaserc`, by contrast, explicitly carries an alias into POS's project. A plain
`firebase deploy --only firestore:rules` run from inside CUSTOMER with `-P customerapp` (or
after `firebase use customerapp`) would replace POS's 800+-line production ruleset with
CUSTOMER's 85-line partial one — silently locking out every POS collection not in CUSTOMER's
file (inventory, receipts, sessions, payroll-adjacent staff data, kitchentickets writes beyond
what CUSTOMER touches, etc.), while simultaneously **not even fixing CUSTOMER's own** app,
per point 1 above. No deploy script, CI workflow, or npm script in any of the four repos runs
`firebase deploy` automatically (`[VERIFIED]` — no `.github/workflows` job in any of the four
repos invokes `firebase deploy`; only `Shareat Website/package.json:17`'s `deploy` script does,
and it is `hosting`-only, run manually). The risk is entirely a human-at-the-keyboard one: a
directory-context mistake (running the deploy command while `cwd` is CUSTOMER instead of POS),
not an automated pipeline hazard.

---

## 3. Storage rules and buckets

| Repo | Ships `storage.rules`? | Declares `storage` in `firebase.json`? | Bucket it governs |
|---|---|---|---|
| **POS** | Yes, `POS/storage.rules` (161 lines) | Yes (`POS/firebase.json:28-30`) | `shareat-hub-v2.firebasestorage.app` |
| **CUSTOMER** | **No file at all** | No `storage` key in `CUSTOMER/firebase.json` | — (see below) |
| **ERP-rebuild** | Yes, `ERP-rebuild/storage.rules` (85 lines) | Yes (`ERP-rebuild/firebase.json:6-8`) | `studio-7300228488-a394e.firebasestorage.app` |
| **Shareat Website** | No file, no `storage` key | — | — |

`[VERIFIED]` — file existence checked with `find`; `firebase.json` contents read for all four.

**Because CUSTOMER has no `storage.rules` of its own, it cannot deploy one and cannot overwrite
POS's storage rules — this half of the risk from §2 does not exist for Storage.** But CUSTOMER
**does** write to the shared bucket anyway: its client SDK is configured with
`storageBucket: "shareat-hub-v2.firebasestorage.app"` (`CUSTOMER/src/firebase/config.ts:5`),
and `CUSTOMER/src/app/admin/flash-ads/page.tsx:15,235-236` calls `uploadBytes()` directly
against that bucket at path `flashAdImages/${storeId}/${Date.now()}-${safeName}`
(`CUSTOMER/src/app/admin/flash-ads/page.tsx:234`).

**RISK — likely-broken upload, found by cross-referencing the two repos.** POS's
`storage.rules` — the only rules file that can ever govern this bucket — has no `match` block
for `flashAdImages/**` anywhere in its 161 lines. Its full set of `match` paths is:
`{allPaths=**}` (default: read-yes, write-no), `users/{userId}/avatar.jpg`, `Items/{productId}`,
`loyaltyRewardImages/{rewardId}/{fileName}`, `productPhotos/{productId}/{storeId}/{fileName}`,
`productRequestImages/{requestId}/{fileName}`, `stores/{storeId}/qrWallet/{qrId}/{fileName}`,
`paymentProofs/{storeId}/{fileName}`, `stores/{storeId}/{fileName}` (`POS/storage.rules:61-158`,
confirmed by full-file read, `grep -n "match /"`). None of these match
`flashAdImages/{storeId}/{fileName}` (a distinct top-level segment, not `stores/…`). Storage
rules are OR-composed and the default at `{allPaths=**}` is explicitly
`allow write: if false` (`POS/storage.rules:61-64`) — the same "no block can narrow a broader
one, only widen" mechanics documented (correctly) as a landmine in
`ERP-rebuild/storage.rules:1-14`'s own header comment. Best available reading: CUSTOMER's
flash-ad image upload has no permitting rule in the file that governs its bucket, and would
fail with `storage/unauthorized` in production unless a rule exists that this reading missed.
Not independently runtime-verified (read-only constraint) — flagged for whoever next touches
either repo's storage layer.

**Buckets are physically separate between the two clusters.** ERP-rebuild's bucket
(`studio-7300228488-a394e.firebasestorage.app`, `ERP-rebuild/src/lib/firebase/admin-init.ts:16`)
shares nothing with `shareat-hub-v2.firebasestorage.app`; its `storage.rules` paths
(`stores/`, `ar_POP/`, `users/`, `recipes/`, `ERP-rebuild/storage.rules:19-85`) are a fully
disjoint namespace. The Website has no Storage bucket of its own in play at all — its only file
storage need (menu build assets) is handled at Astro build time, not via Firebase Storage.

---

## 4. Firestore indexes

| Repo | Ships `firestore.indexes.json`? | Declared in `firebase.json`? | `collectionGroup` entries in the file |
|---|---|---|---|
| **POS** | Yes | Yes (`POS/firebase.json:26`) | 15 |
| **CUSTOMER** | **No file** | No `indexes` key | — |
| **ERP-rebuild** | Yes | Yes (`ERP-rebuild/firebase.json:4`) | 85 |
| **Shareat Website** | No file | No `indexes` key | — |

`[VERIFIED]` by `find`/`grep -c` against each file.

**No repo can delete another repo's indexes** — only POS and ERP-rebuild declare indexes at
all, and they're in different projects. The real index risk is **intra-POS, not cross-app**,
but it directly threatens the same project CUSTOMER also depends on, so it belongs in this
map: POS's own `firestore.indexes.json` is badly out of date against what's live. POS's own
plan doc states it precisely: *"The repo's `firestore.indexes.json` declares 13 indexes and
`"fieldOverrides": []`. Production has ~57 indexes and 2 fieldOverrides
(`kdsTickets.createdAt`, `kitchentickets.storeId`). A deploy would prompt to delete roughly 44
live indexes plus both field overrides"*
(`POS/docs/superpowers/plans/2026-08-12-post-session-consolidation-pos.md:31`). This repo's own
independent count of the current file found **15** `collectionGroup` entries and **0**
`fieldOverrides` — consistent with (slightly ahead of) that doc's "13" figure, confirming the
drift is real and ongoing, not a one-off. `firebase deploy --only firestore:indexes` from POS
is explicitly called out as dangerous in multiple POS planning docs (e.g. the same file,
line 519: *"Do NOT run `firebase deploy --only firestore:indexes`"*). This threatens
`collectionGroup("kitchentickets")` indexes that CUSTOMER's own code also depends on for reads
(`CUSTOMER/src/lib/server/refill-outstanding.ts:170` reads
`stores/{storeId}/sessions/{sessionId}/kitchentickets`) — so an index-deploy mistake in POS
would degrade CUSTOMER's ordering/refill flows too, even though CUSTOMER never touches the
indexes file itself.

---

## 5. Shared collections

Collections confirmed (by direct grep of both apps' source) to be read and/or written by more
than one app. All live in the single shared project `shareat-hub-v2` (POS ↔ CUSTOMER), or are
bridged into it by the Website's Cloud Functions (Website ↔ POS via `hubDb`/`hubApp`, §7). This
list is not exhaustive — it is what direct grep for the same collection names surfaced in the
apps' `src/` trees during this session.

| Path | POS | CUSTOMER | Website (via `hubDb`) | Notes |
|---|---|---|---|---|
| `stores/{id}` | R/W | R | R/W | Root store doc: flags (`acceptsOnlineOrders`, `acceptsReservations`, `acceptsWebsiteChat`), config. `Shareat Website/functions/index.js:357,512,611,1578,2267` |
| `stores/{id}/sessions/{sid}/kitchentickets` | R/W | R/W | — | Dual-writer; see `10-customer-app.md` §4a. `CUSTOMER/src/lib/server/kitchen-ticket-write.ts:57`, `.../refill-outstanding.ts:170`, `.../session-orders/route.ts:77`, `.../repeat-first-order/route.ts:162` |
| `stores/{id}/sessions/{sid}/sessionBillLines` | R/W | R | — | Bill created by POS on serve, per the ordering handshake in `10-customer-app.md` §4b. `CUSTOMER/src/app/api/customer/session-orders/route.ts:81` |
| `stores/{id}/catalogCache/main` (a.k.a. `catalogCache`) | W (cron + manager-triggered) | R | — | POS's `rebuild-customer-catalog` cron (§9) is the backstop writer; CUSTOMER is a pure reader. `POS/docs/CRON.md:109-135`; CUSTOMER rule at `CUSTOMER/firestore.rules:63-66` |
| `stores/{id}/storeRefills`, `stores/{id}/storeFlavors` | R/W (manager settings UI) | R (cache builder) | — | `CUSTOMER/src/lib/server/refill-options-cache.ts:45,86`; `POS/src/components/manager/store-settings/store-refills-settings.tsx`, `store-flavors-settings.tsx` |
| `refills` (root, global catalog) | R/W | R | — | `CUSTOMER/src/lib/server/refill-options-cache.ts:68`; `POS/src/app/admin/menu/refills/page.tsx` |
| `stores/{id}/customerRequests` | R (kitchen/assistance views) | W (diner-initiated) | — | `CUSTOMER/src/app/api/customer/request-griller/route.ts:55`, `.../request-assistance/route.ts:48`; `POS/src/components/kitchen/AssistanceAlerts.tsx`, `POS/src/app/admin/customer-requests/page.tsx` |
| `stores/{id}/customerFeedbackDays` | R (admin feedback view) | W (diner feedback) | — | `CUSTOMER/src/app/api/customer/submit-feedback/route.ts:65`, `.../api/admin/feedback/route.ts:64`; `POS/src/app/api/external/feedback/route.ts` |
| `pinRegistry` | W (`/api/pins/issue`) | R/W (diner login, cleanup) | — | The diner-session PIN bridge. `CUSTOMER/src/app/admin/page.tsx:111`, `.../api/customer/exchange-pin/route.ts:45`, `.../api/admin/cleanup-archived-pins/route.ts:38`; `POS/src/app/api/pins/{issue,revive,repair}/route.ts` |
| `products` | R/W (admin menu) | R (`pos-products` mirror) | — | `CUSTOMER/src/app/api/admin/pos-products/route.ts:36`; `POS/src/app/admin/menu/products/page.tsx` |
| `categories` | R/W | R/W | — | `CUSTOMER/src/app/admin/categories/page.tsx:35,55` |
| `loyaltyRewards`, `loyaltyRedemptions` | R/W | R/W | — | `CUSTOMER/src/app/api/customer/sharelebrator/{rewards,redeem}/route.ts`; `POS/src/lib/loyaltyRewardScope.ts`, `POS/src/app/admin/loyalty-rewards/page.tsx` |
| `customers/{phone}` (incl. `pointsLedger` subcollection) | R/W | R/W | W (`placeOrder`, merge-only upsert per `11-website.md` §2a) | `CUSTOMER/src/lib/server/loyalty-card.ts:56`, `.../sharelebrator/transfer-points/route.ts:26,39` |
| `stores/{id}/reservations` | R (front-of-house) | — | W | `Shareat Website/functions/index.js:522,524` |
| `stores/{id}/chatThreads/{id}/messages` | R (kitchen/manager) | — | R/W | `Shareat Website/functions/index.js:704,746,776,913,987,1014` |
| `stores/{id}/onlineOrders` | R/W | — | R/W (create + expire-sweep) | `Shareat Website/functions/index.js:1865,1989,2267,2274` |
| `stores/{id}/savedQrCodes` | R/W (QR wallet) | — | R | `Shareat Website/functions/index.js:2081`, `POS/storage.rules:117` (image side) |

`activeSessions` (dashboard live read, `10-customer-app.md` §4e) and `rtKdsTickets/{loc}` are
also dual-written per that doc — not independently re-verified here to avoid duplicating that
session's work, but consistent with everything found above.

---

## 6. Auth

| App | Firebase Auth tenant | Staff/admin identity model | Diner/customer identity model |
|---|---|---|---|
| **POS + CUSTOMER** | **Shared** — both projects' `firebaseConfig.authDomain` is `shareat-hub-v2.firebaseapp.com` (`POS/src/firebase/config.ts:3`, `CUSTOMER/src/firebase/config.ts:4`) | `staff/{uid}` Firestore doc, `role` field (`admin`/`manager`/…); `platformAdmin` custom claim as break-glass, set only by `POS/scripts/set-platform-admin.mjs` | Custom-minted Firebase Auth tokens: `CUSTOMER/src/app/api/customer/exchange-pin/route.ts` and `exchange-qr/route.ts` call `getAdminAuth()` (bound to `shareat-hub-v2`) to mint a session identity carrying `customer: true` + `storeId` claims, gated on a valid `pinRegistry` doc issued by POS |
| **ERP-rebuild** | Own, separate — `studio-7300228488-a394e` | `users/{uid}` Firestore doc, `role` field + `storeAccess` list (`ERP-rebuild/firestore.rules:9-38`) | N/A (no diner-facing surface) |
| **Shareat Website** | Own, separate — `shareat-website` | Hardcoded email allow-list on `request.auth.token.email` (`admin@shareat.net`, `ianlalusin@gmail.com`, `Shareat Website/firestore.rules:13-18`), for the hidden `/admin` page only | No Auth identity at all for public visitors — public storefront/reservation/chat flows are gated by **App Check** (reCAPTCHA v3) plus per-flow tokens (OTP, checkout token, order `publicToken`), never a signed-in Firebase user |

**`[VERIFIED]` — a concrete proof that POS and CUSTOMER share one Auth tenant, in the POS→CUSTOMER
direction (not just CUSTOMER→POS):** `POS/src/lib/manager/dataManagement.ts:171-181` has a POS
manager's **browser** call `getAuth().currentUser.getIdToken()` (a token minted against
`shareat-hub-v2`) and POST it as `Authorization: Bearer` straight to
`https://customer.shareat.net/api/admin/rebuild-refill-options-cache`. CUSTOMER's own route
handler at `CUSTOMER/src/app/api/admin/rebuild-refill-options-cache/route.ts:18-19` calls
`getAdminAuth().verifyIdToken(idToken)` — its Admin Auth instance, also bound to
`shareat-hub-v2` by the same fallback described in §1 — and this succeeds only because both
apps' Auth instances point at the identical tenant. The route then re-checks the decoded
token's `staff/{uid}` doc and rejects `customer: true` tokens (route.ts:22,27-33) — i.e.
CUSTOMER's backend is doing POS-shaped authorization on a POS-minted token, cross-project.

ERP-rebuild and the Website's admin identity are both fully disconnected from this pool — a
staff member's POS/CUSTOMER identity does not exist in either of those projects, and there is
no code anywhere that links a `staff/{uid}` in `shareat-hub-v2` to a `users/{uid}` in
`studio-7300228488-a394e` other than the manual per-store field noted in
`ERP-rebuild/src/types/index.ts:737-743` (`linkedUserUid`, described there as a one-way,
per-store, no-back-link mapping the ERP side maintains by hand).

---

## 7. Cross-app API contracts

| Endpoint(s) | Caller → Callee | Auth mechanism | Consumer / purpose |
|---|---|---|---|
| `GET /api/external/{stores,sales,sold-items,inventory-items,payment-methods,staff-metrics,staff-profiles,feedback}` (8 routes) | ERP-rebuild server → POS | `x-api-key` header, checked in POS by `resolveExternalKeyScope()`/`storeAllowed()` (`POS/src/lib/server/external-auth.ts:29-72`), constant-time compare. ERP sends `process.env.POS_API_KEY`; POS validates against `process.env.POS_EXTERNAL_API_KEY` (or a scoped-key JSON map, `POS_EXTERNAL_API_KEYS_JSON`) — **different env var names on each side, same secret value required** | `ERP-rebuild/src/lib/server/pos-api.ts:22-228` — daily sales/books feed, inventory usage pull, staff performance. Base URL from `POS_API_URL` (`ERP-rebuild/apphosting.yaml:26-27`, hardcoded to POS's App Hosting default domain) |
| `POST /api/ingest/wastage-email` | Google Apps Script (runs inside a Gmail mailbox, not a repo) → ERP-rebuild | Shared secret `WASTAGE_INGEST_SECRET`, same value required in ERP's Secret Manager and the Apps Script's Script Properties (`ERP-rebuild/scripts/apps-script/wastage-email-ingest/Code.gs:14-16,56-58`; `ERP-rebuild/apphosting.yaml:117-125`) | One-way ingest of FoodPanda/Grab wastage emails into ERP, idempotent |
| `POST https://customer.shareat.net/api/admin/rebuild-refill-options-cache` | POS (manager's browser) → CUSTOMER | POS-minted Firebase ID token, Bearer; verified by CUSTOMER's Admin Auth against the shared `shareat-hub-v2` tenant, then staff-doc/`platformAdmin` re-check (§6) | Best-effort cache-rebuild trigger; CUSTOMER route self-heals on a TTL if this never fires (`POS/src/lib/manager/dataManagement.ts:165-181`) |
| `GET/POST /api/{reservation-locations,reserve,chat-locations,chat-send,chat-poll,chat-resolve-order,storefront-catalog,storefront-stores,storefront-otp-send,storefront-otp-verify,storefront-order,storefront-order-status,storefront-customer-orders,storefront-paymongo-webhook}` (13 routes) | Public browser → Website's own Cloud Functions | App Check (reCAPTCHA v3) on nearly all; the PayMongo webhook instead verifies a PayMongo HMAC signature (`Shareat Website/firestore.rules` comment; `Shareat Website/firebase.json:18-75` for the route table; full detail already in `11-website.md` §2a) | Public storefront/reservation/chat surface |
| *(not an HTTP endpoint)* Cloud Functions "hub" Admin app | Website's Cloud Functions → POS's Firestore (`shareat-hub-v2`) directly | Service-account credential `HUB_SA_KEY` (Secret Manager), full Admin SDK — **bypasses POS's `firestore.rules` entirely**, by design of the Admin SDK | Reads store flags, writes reservations/onlineOrders/chatThreads/savedQrCodes (`Shareat Website/functions/index.js:1-15,224-236`) |
| *(build-time, not a runtime endpoint)* `MENU_BUILD_SA_KEY_PATH` | Website's `prebuild` script → POS's Firestore | A second, separate service-account key, used only at `astro build` time (`Shareat Website/.env:34`, `Shareat Website/scripts/fetch-store-packages.mjs`) | Bakes unli-package pricing into static `/menu` pages |

**RISK — two different credential shapes reach the same project with very different blast
radii.** ERP-rebuild's `POS_API_KEY` is scoped by `resolveExternalKeyScope()` to a specific,
auditable set of read-only-by-route endpoints, optionally further scoped to specific store IDs
(`POS/src/lib/server/external-auth.ts:24-27,58-64`). The Website's `HUB_SA_KEY`, by contrast,
is a full Firebase Admin credential — unlimited read/write across every collection in
`shareat-hub-v2`, constrained only by what the Cloud Functions code happens to call, not by any
security-rules or API-surface boundary. A leak or misuse of `HUB_SA_KEY` is strictly more
dangerous than a leak of `POS_API_KEY`.

**RISK — env-var/secret-name mismatches are the norm, not the exception, and are explicitly
called out in-repo as a known trap.** `ERP-rebuild/apphosting.yaml:37-43` documents this
pattern directly for its own secrets (`GROQ_API_KEY` variable ↔ `GROQ_INSIGHT_API` Secret
Manager name) and cross-references the same pattern in POS's `apphosting.yaml`
(`PAYMONGO_SECRET_KEY` variable ↔ `PAYMONGO_SECRET` Secret Manager name,
`POS/apphosting.yaml:57-66`). The ERP↔POS API key pair above (`POS_API_KEY` vs
`POS_EXTERNAL_API_KEY`) is the same pattern across a *repo* boundary rather than within one —
a rotation done on only one side silently breaks the integration with no compile-time signal.

---

## 8. Deploy topology

| App | Hosting mechanism | Trigger | Side effects on other apps |
|---|---|---|---|
| **POS** | Firebase App Hosting (`POS/apphosting.yaml`) | Push-to-deploy, per `POS/docs/CRON.md:146`'s statement *"POS deploys on push"* — backend/branch binding lives in the Firebase console, not the repo (`INFERRED` which branch) | `firestore:rules`/`firestore:indexes`/`storage` deploys are **separate, manual** commands (`firebase deploy --only …`, never auto-run — no CI workflow calls `firebase deploy`, `[VERIFIED]` by grep of `.github/workflows/*`) — but when run, they land on `shareat-hub-v2`, i.e. also CUSTOMER's live backend (§2, §3) |
| **ERP-rebuild** | Firebase App Hosting (`ERP-rebuild/apphosting.yaml`) | Push-to-deploy; CI (`ERP-rebuild/.github/workflows/ci.yml:1-6`) runs typecheck/lint/test on push to `upgrade-next16` and on PRs — that workflow does **not** deploy (no `firebase deploy` step, `[VERIFIED]`) | None on other apps — isolated project |
| **CUSTOMER** | Firebase App Hosting (`CUSTOMER/apphosting.yaml`) | Push-to-deploy (`INFERRED` from the presence of `apphosting.yaml` and the project's own doc convention noted in memory as "pushing `main` IS the deploy") | Its own App Hosting deploy only ships app code — the rules/indexes/storage risk in §2/§3 requires a **separate, manual** `firebase deploy --only firestore:rules` invocation, not the push itself |
| **Shareat Website** | Classic Firebase Hosting + Cloud Functions | **Manual only** — `npm run deploy` = `next build && firebase deploy --only hosting` (`Shareat Website/package.json:17`); Functions and rules require an explicit separate `firebase deploy --only functions,firestore:rules,hosting` run from a developer's machine (`Shareat Website/PAYMONGO-GOLIVE.md:34`, `Shareat Website/SETUP.md:131`) | None on other apps' infra — but a Functions deploy here changes what code holds `HUB_SA_KEY` and therefore what write behavior lands in POS's project (§7) |

No repo's CI performs a Firebase deploy of any kind (`[VERIFIED]` — `POS/.github/workflows/`
has only `build-apk.yml`; `ERP-rebuild/.github/workflows/` has `build-apk.yml`, `ci.yml`,
`generate-keystore.yml`, none deploying; `CUSTOMER` and `Shareat Website` have no
`.github/workflows` directory at all). Every deploy in this ecosystem, Firestore/Storage rules
included, is a human running a command from a terminal — which is precisely why the §2 risk is
about directory context (which repo's `cwd` you're in, which `-P`/`firebase use` alias is
active) rather than a pipeline misconfiguration.

---

## 9. Cron / scheduled jobs

### POS — 9 Cloud Scheduler jobs, project `shareat-hub-v2`

Full detail (verified against production 2026-08-22 via `gcloud scheduler jobs list`) already
lives in `POS/docs/CRON.md:45-55`; reproduced in summary:

| Job | Endpoint | Schedule | Writes |
|---|---|---|---|
| `weather_api_call` | `/api/cron/log-weather` | hourly | per-store weather log |
| `generate-daily-insight` | `/api/cron/generate-daily-insight` | 1–5 AM | AI insight docs |
| `update-accuracy` | `/api/cron/update-accuracy` | 4 AM | forecast accuracy backfill |
| `generate-forecast` | `/api/cron/generate-forecast` | 5–9 AM | `stores/{id}/salesForecasts/{date}` |
| `reconcile-analytics` | `/api/cron/reconcile-analytics` | */15 min | analytics deltas |
| `purge-expired-pins` | `/api/cron/purge-expired-pins?write=1` | Sun 3 AM | deletes expired `pinRegistry` docs — **the collection CUSTOMER's diner login reads** (§5) |
| `rebuild-customer-catalog` | `/api/cron/rebuild-customer-catalog?write=1` | 3:15 AM | `stores/{id}/catalogCache/main` — **the doc CUSTOMER's ordering UI reads** (§5) |
| `rebuild-presets` | `/api/cron/rebuild-presets` | 12:30 AM (asia-east1, the one job in a different region) | dashboard preset cache |
| `holiday-calendar` | `/api/cron/holiday-calendar` | monthly, 1st 2 AM | `stores/{id}/holidayCalendar/{year}` |

Auth: `Authorization: Bearer <CRON_SECRET>` (`POS/docs/CRON.md:167-171`).

### ERP-rebuild — 9 cron *routes* exist in code

`ERP-rebuild/src/app/api/cron/{attendance-sweep,budget-reissue,daily-insights,daily-snapshot,
loan-autodeduct,rebuild-performance,reconcile,recurring-expense-autopay,wastage-auto-charge}`
(9 route directories, `[VERIFIED]` by directory listing) all gate on
`process.env.CRON_SECRET` (`ERP-rebuild/src/app/api/cron/reconcile/route.ts:24-26`, same
pattern in each). No `docs/CRON.md`-equivalent exists in this repo, and per the user's own
project memory several of these are known to be code-complete but **not yet wired to an actual
Cloud Scheduler job** — this could not be independently verified here (no `gcloud` access, and
verifying live scheduler state was out of scope for a read-only repo discovery); treat "route
exists" and "runs on a schedule" as two separate, unconfirmed-together facts for this repo.

### Shareat Website — 1 scheduled Cloud Function

`expireStalePendingPayments`, `every 15 minutes`, region `asia-southeast1`
(`Shareat Website/functions/index.js:2259-2260`). Reads `hubDb.collection("stores")` (POS's
project) for `acceptsOnlineOrders == true`, then expires abandoned `pending_payment`
`onlineOrders` past a configurable age (`EXPIRY_MINUTES`, default 120 min) — **writes land in
POS's `shareat-hub-v2` project**, not the Website's own. Guarded by
`lastUpdateTime` preconditions so a late PayMongo webhook always wins over the sweep
(`Shareat Website/functions/index.js:2238-2240`). Currently defaults to dry-run
(`EXPIRY_DRY_RUN` defaults `true`, `.../index.js:2254-2256`).

### CUSTOMER — none found

`[VERIFIED]` — no `api/cron/*` directory, no `onSchedule`/Cloud Scheduler reference anywhere in
`CUSTOMER/src`. Its only self-healing background behavior is client/route-level TTL caching
(e.g. the refill-options cache mentioned in §7), not a true scheduled job.

---

## 10. Env var inventory (names only)

### POS
`.env.local` (`POS/.env.local`): `FIREBASE_ADMIN_SA_PATH`, `FIREBASE_PROJECT_ID`,
`CRON_SECRET`, `GEMINI_API_KEY`, `POS_EXTERNAL_API_KEY`, `CUSTOMER_JOIN_TOKEN_SECRET`,
`NEXT_PUBLIC_CUSTOMER_URL`, `OPENWEATHER_API_KEY`, `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`,
`NEXT_PUBLIC_STOREFRONT_STORE_ID`.
`apphosting.yaml` additionally declares: `PAYMONGO_SECRET_KEY`, `PAYMONGO_WEBHOOK_SECRET_POS`,
`RESEND_API_KEY`, `SEMAPHORE_API_KEY`, `SEMAPHORE_SENDER_NAME`, `NOTIFY_EMAIL_FROM`,
`NOTIFY_SMS_ENABLED`, `NOTIFY_SMS_STATUSES`.

### ERP-rebuild
`.env.local`: `POS_API_URL`, `POS_API_KEY`, `GOOGLE_GENAI_API_KEY`,
`FIREBASE_SERVICE_ACCOUNT_KEY`, `GROQ_API_KEY`, `DEEPSEEK_API_KEY`, `NVIDIA_API_KEY`.
`apphosting.yaml` additionally declares: `AI_PROVIDER`, `GROQ_MODEL`, `CRON_SECRET`,
`WASTAGE_INGEST_SECRET`, `NEXT_PUBLIC_GOOGLE_WEB_CLIENT_ID`.

### CUSTOMER
`.env.local`: `SERVICE_ACCOUNT_KEY_PATH`, `FIREBASE_PROJECT_ID`, `CUSTOMER_JOIN_TOKEN_SECRET`.
`apphosting.yaml` additionally declares: `SERVICE_ACCOUNT_KEY_JSON` (Secret Manager name
`FIREBASE_SERVICE_ACCOUNT_KEY`).

### Shareat Website
`.env` / `.env.example`: `PUBLIC_FIREBASE_API_KEY`, `PUBLIC_FIREBASE_AUTH_DOMAIN`,
`PUBLIC_FIREBASE_PROJECT_ID`, `PUBLIC_FIREBASE_STORAGE_BUCKET`,
`PUBLIC_FIREBASE_MESSAGING_SENDER_ID`, `PUBLIC_FIREBASE_APP_ID`,
`PUBLIC_RECAPTCHA_V3_SITE_KEY`, `PUBLIC_RESERVATIONS_ENABLED`, `PUBLIC_CHAT_ENABLED`,
`PUBLIC_GA_MEASUREMENT_ID`, `OPENAI_API_KEY`, `PUBLIC_META_PIXEL_ID`, `PUBLIC_SHOP_ENABLED`,
`MENU_BUILD_SA_KEY_PATH`.
`functions/.env.example` additionally: `STOREFRONT_STORE_ID`, `SITE_ORIGIN`, `OTP_EMAIL_FROM`,
`OTP_DEBUG`, `EXPIRY_MINUTES`, `EXPIRY_DRY_RUN`, `GCASH_ACCOUNTS`, `SEMAPHORE_SENDER_NAME`,
`NOTIFY_SMS_ENABLED`. (Secrets declared via `defineSecret()` in code rather than `.env.example`:
`HUB_SA_KEY`, `META_CAPI_TOKEN`, `CHECKOUT_TOKEN_SECRET`, `OTP_PEPPER`, `SEMAPHORE_API_KEY`,
`UNISMS_API_KEY`, `RESEND_API_KEY`, `PAYMONGO_SECRET_KEY`, `PAYMONGO_WEBHOOK_SECRET` —
`Shareat Website/functions/index.js:26,32,41-47`.)

### Names appearing in more than one app — the couplings

| Name | Apps | Same value required? | Evidence |
|---|---|---|---|
| `CUSTOMER_JOIN_TOKEN_SECRET` | POS, CUSTOMER | **Yes** — identical HMAC-SHA256 signing code in both repos, same file name (`customer-join-token.ts`), same `SECRET = process.env.CUSTOMER_JOIN_TOKEN_SECRET!` | `POS/src/lib/server/customer-join-token.ts:10`, `CUSTOMER/src/lib/server/customer-join-token.ts:10,13` |
| `FIREBASE_PROJECT_ID` | POS, CUSTOMER | Values happen to be identical (`shareat-hub-v2`) but the coupling is behavioral, not by design of the var name | §1 |
| `CRON_SECRET` | POS, ERP-rebuild | No — separate projects, separate Secret Manager stores; same *pattern* (`Authorization: Bearer`), not the same secret | `POS/apphosting.yaml:42-45`, `ERP-rebuild/apphosting.yaml:113-116` |
| `FIREBASE_SERVICE_ACCOUNT_KEY` | ERP-rebuild (as an env var name for a local SA JSON path), CUSTOMER (as the Secret Manager secret name behind `SERVICE_ACCOUNT_KEY_JSON`) | No — different projects; naming coincidence only, but a real risk for copy-paste error between repos | ERP: `.env.local` name list above; CUSTOMER: `CUSTOMER/apphosting.yaml:7-8` |
| `SEMAPHORE_API_KEY`, `RESEND_API_KEY` | POS, Shareat Website | **Intended to converge** — POS's own `apphosting.yaml` comment states these currently exist **only** in the `shareat-website` project's Secret Manager and must be separately created + granted in `shareat-hub-v2` before POS's own SMS/email notifications work: *"They do NOT exist in `shareat-hub-v2` yet"* | `POS/apphosting.yaml:78-95` |
| `SEMAPHORE_SENDER_NAME`, `NOTIFY_SMS_ENABLED` | POS, Shareat Website functions | Same variable names, same purpose (SMS master-arm / sender id), independent per-project values | `POS/apphosting.yaml:96-113`, `Shareat Website/functions/.env.example` |
| `PAYMONGO_SECRET_KEY` | POS, Shareat Website functions | No — each integrates its own PayMongo account/secret independently (POS's Secret Manager name is `PAYMONGO_SECRET`, `POS/apphosting.yaml:58-66`); same var *name* only | `POS/apphosting.yaml:63-64`, `Shareat Website/functions/index.js:46` |
| `PAYMONGO_WEBHOOK_SECRET` vs `PAYMONGO_WEBHOOK_SECRET_POS` | POS, Shareat Website | Deliberately disambiguated with a `_POS` suffix on POS's side — the one case in this survey where a naming collision was clearly anticipated and avoided | `POS/apphosting.yaml:67-73`, `Shareat Website/functions/index.js:47` |
| `POS_API_KEY` (ERP) / `POS_EXTERNAL_API_KEY` (POS) | ERP-rebuild, POS | **Yes**, same value required across the boundary despite different names — see §7 | `ERP-rebuild/apphosting.yaml:22-23`, `POS/apphosting.yaml:36-39` |

**RISK — no repo enforces at build/deploy time that a cross-repo secret pair actually matches.**
Every "same value required" row above is enforced only by convention and by whoever configured
Secret Manager by hand; a rotation on one side with no corresponding rotation on the other fails
silently at runtime (401/403 on the dependent integration) rather than at deploy time.

---

## Summary table — who can hurt whom

| Deploying from… | …can overwrite/break | Mechanism |
|---|---|---|
| **POS** | its own project's rules/indexes/storage (self-risk, §4) | own `.firebaserc` default |
| **CUSTOMER** | **POS's `firestore.rules`** (and therefore its own live app, per §2) | `customerapp` alias → `shareat-hub-v2` |
| **CUSTOMER** | nothing in Storage or indexes | no `storage.rules`, no `firestore.indexes.json` shipped |
| **ERP-rebuild** | only itself | fully separate project, no alias to any other project found |
| **Shareat Website** | only itself directly; but its Functions **write live data into POS's project** via `HUB_SA_KEY` (not a rules/indexes overwrite, but an unrestricted Admin SDK channel) | separate project + cross-project service-account credential |

This table is the concrete shape of the coupling the unified-Postgres-backend effort exists to
remove: three of the four apps (POS, CUSTOMER, Website) already behave as if they share one
backend — informally, unevenly, and without a single owner of the ruleset that governs it.

# CUSTOMER (diner app) v1 study — for the customer-app v2 phase plan
Read-only. 2026-10-15. Source: `C:\Users\ianla\webapps\CUSTOMER` (paths relative to it). No production access: anything needing a count is marked NEEDS COUNT.

## 0. Already documented (cited, NOT redone)
- `shareat-system/docs/discovery/10-customer-app.md` (2026-08-23): routes, identity (3 schemes), ~30 Firestore paths and who writes them, ordering flow, refill rules, loyalty hold/redeem, menu cache, rules divergence. Still accurate; this doc adds the gaps below.
- `docs/CROSS-APP-MAP.md` section 4 (CUSTOMER<->POS handshake, 6 dual-writer collections, firestore.rules landmine) and sections 1-2 (shared Firebase project `shareat-hub-v2`).
- `docs/CAPABILITY-GAPS.md`: no CUSTOMER-specific rows (only customer returns/store credit, a B2B/POS item). `docs/discovery/11-website.md` and `12-shared-infrastructure.md` not re-read here.
- Method: RULES.md section 3 / bible 1.2d (v1 owns the GOAL, not the method; count the data; design to beat the goal).

## 1. Corrections / additions to doc 10
- Now 51 API routes (doc says 45): new `api/manager/{pins,pins/cleanup,games}` and more `admin/*` (`ls src/app/api`). About 29.9k lines of ts/tsx including tests (`wc -l`).
- Staff gate is one module: `src/lib/server/admin/access.ts` (`resolveStaff`/`requireRole`/`requireStoreAccess`; decisions in `access-rules.ts`, unit-tested). Used by admin and manager routes (e.g. `api/admin/feedback/route.ts:32`). It fixed an older "unassigned staffer can read any branch" hole (comment in that file).
- NO service worker anywhere (grep). `src/app/manifest.json` only makes it installable. `docs/blueprint.md` promises "offline capabilities" — not built.
- Dead or unused: `src/ai/genkit.ts` (Genkit + Gemini) is imported only by `src/ai/*`, no route or page uses it. `repeat-first-order` route has no UI caller (doc 10 section 4). `marketing/` = video/ad assets, not app code.
- Build safety off: `next.config.ts:4-9` `typescript.ignoreBuildErrors: true`, `eslint.ignoreDuringBuilds: true` — type errors ship.
- Deploy: Firebase App Hosting, `apphosting.yaml` `maxInstances: 1`.

## 2. Capability by capability (goal / v1 at source / live-data signal / flaws)

### 2.1 Diner identity and join (dine-in)
- Goal: a guest at a table orders within seconds with no signup, and only people at THAT table can order onto THAT bill.
- v1: PIN (`api/customer/exchange-pin/route.ts:45-85`) or signed QR token (`exchange-qr/route.ts:62-87`, HMAC in `lib/server/customer-join-token.ts`) -> participant slot keyed by hashed device id (`lib/server/customer-participants.ts:15-119`) -> Firebase custom token with claims `{customer,storeId,sessionId,participantId}`. Seat limit from guest count. Cashier can disable access or bump `customerJoinVersion` to kill an old QR.
- Data: writes `customerParticipants/{hash}` and `activeSessions.customerParticipantActiveCount`. NEEDS COUNT: participants per session; QR vs PIN share.
- Flaws: PIN `000000` hardcoded admin redirect in client (`src/app/page.tsx:30-33`). Device id lives in localStorage (`lib/device-id.ts`): clearing storage = new seat (burns a slot and resets that diner's refill cooldowns). No PIN brute-force limit seen in exchange-pin (NEEDS COUNT of failed exchanges).

### 2.2 Ordering from the table
- Goal: diners self-serve refills and add-ons so staff walk less and orders reach the kitchen instantly while the bill stays correct.
- v1: two order types. (a) Refill (unlimited-package meats/sides): `submit-refill/route.ts` (288 lines) + refill cooldown. (b) Priced add-ons: `submit-addon-order/route.ts`, re-priced server-side from POS `catalogCache/main` (`lib/catalog/order-validation.ts:193-282`), idempotent via `clientRequestId` (`lib/server/order-claim.ts:48-80`). Writes only a kitchen ticket with `billOnServe:true` and a frozen `pendingBillLine`; POS creates the bill line on serve (`POS/src/lib/kitchen/customer-order-billing.ts:114-141`). Blocked while bill is closing (`submit-addon-order/route.ts:60-65`).
- The QR is at table/session level (join), not per item. The opening package order is the cashier's job; CUSTOMER cannot order a package.
- Data: ticket `source:"customer_app"` is deliberately made to look like POS (`lib/server/kitchen-ticket-write.ts:12-13`), so provenance survives only as `orderedVia` on the bill line. NEEDS COUNT: customer-app tickets vs staff tickets per day; refill vs add-on split; orders per diner.
- Flaws: duplicate KDS fan-out writer in `repeat-first-order/route.ts:162-224`; 60s/10min/20min refill rules are magic numbers (`lib/refill-cooldown.ts:32,43`, `lib/session-orders.ts:59`); rules duplicated client+server (pinned by tests); status polled every 20s (`hooks/use-session-orders.ts:57`).

### 2.3 Menu source
- Goal: diner sees the same menu and prices as the cashier, with variants/modifiers, without a second place to edit.
- v1: one POS-written doc `stores/{s}/catalogCache/main` (+ `popularItems`); CUSTOMER whitelists fields (`lib/catalog/project.ts:17-27`) and has a legacy flat-format fallback (`:139-176`). Its own admin `admin/categories` writes a global `categories` collection (ownership unclear, doc 10 open question).
- Flaws: freshness depends on POS rebuilding the cache; no invalidation here. `next.config.ts` allows placehold.co / unsplash / picsum image hosts (placeholder images in prod?). NEEDS COUNT: items with real images; staleness incidents.

### 2.4 Cart / checkout / payments
- Goal: diner builds an order and sends it; money is settled at the cashier at the end.
- v1: cart is client-only (`components/customer/CustomerCatalog.tsx:82-236`, 849 lines). NO checkout, NO online payment (grep gcash/paymongo/maya/payment: nothing real). "Running bill" is a deliberately partial subtotal, not the POS total (`lib/catalog/running-bill.ts:1-23`) — no tax, discounts or loyalty shown.
- Gap: diner cannot see the final amount, split the bill, or pay on phone. Candidate v2 feature; per RULES section 4 it must be ASSESSED before planned.

### 2.5 Order status to POS / kitchen
- Goal: diner knows if food is coming; staff get alerted to requests.
- v1: tickets collapse to preparing / partially_served / served / cancelled (`api/customer/session-orders/route.ts:38-44`). "Ask for assistance" (`request-assistance/route.ts`) and "Add Griller" (`request-griller`) write `stores/{s}/customerRequests`, deduped to one pending per session (`request-assistance/route.ts:60-72`); KDS/server consume them (INFERRED from comments; `docs/MANUAL.md` section 3 says response time is tracked). NEEDS COUNT: requests per day, average response time.
- Flaws: dedupe is read-then-write, not a transaction, so a double tap can create two.

### 2.6 Loyalty "Sharelebrator" (points, rewards, transfers)
- Goal: repeat visits -> points -> rewards redeemed at the till; build a phone-keyed member base.
- v1 (doc 10 section 6): earning is POS-side; CUSTOMER does signup/login, holds points and issues a 6-char code (`redeem/route.ts:109-125`), POS applies it at finalize. Phone-to-phone transfers with daily caps scanned from the ledger (`transfer-points/route.ts:9-48`). Audit in `loyaltyLogs*`.
- Data: `customers/{phone}`, `pointsLedger`, `loyaltyRedemptions`, `loyaltyStats/global.totalAccounts`. NEEDS COUNT: accounts, accounts with points > 0, active last 90 days, redemptions, transfers (is transfer used at all?), share of tables with a linked card.
- Flaws: login has NO lockout or rate limit, only logs failures (`sharelebrator/login/route.ts:15-50`); bcrypt cost 10; phone is the doc id; `pointsBalance` has two writers (CUSTOMER transfer, POS earn/spend); store-scope rule duplicated byte-for-byte across two repos (`lib/loyaltyRewardScope.ts`); no phone verification (no SMS/OTP anywhere), so anyone can register a number; `lookup-recipient` may reveal whether a number is a member (CHECK).
- Promos: no coupons or codes other than loyalty redemptions; flash ads are the only promo surface.

### 2.7 Flash ads
- Goal: staff-controlled promo overlay for diners (upsell).
- v1: `stores/{s}/flashAds` CRUD from the browser (`components/admin/FlashAdsPanel.tsx`, 563 lines), images in Storage `flashAdImages/`; dashboard overlay reads via client SDK with `where active==true` (`dashboard/page.tsx:240-243`). CUSTOMER-owned. No view/click counters found. NEEDS COUNT: ads per store.

### 2.8 Reservations
- None in CUSTOMER (grep matches are "reserved points"). CAPABILITY-GAPS has no reservation row. Website not checked here. New capability if wanted, not a v1 port.

### 2.9 Feedback / reviews
- Goal: capture a rating and suggestion per visit so managers see service quality.
- v1: modal -> `api/customer/submit-feedback/route.ts`: rating 1-5 + free text + optional name, stored as an array inside day-sharded docs `customerFeedbackDays/{MMDDYYYY[-NN]}`, 400 per doc (`:46-120`). Allowed after the session closes (`closedSessions` fallback `:54-64`). Admin read `api/admin/feedback/route.ts` takes only the latest 10 day-docs (`.limit(10)`), so older feedback is invisible; UI `FeedbackPanel.tsx` shared by admin and manager. One-per-session is enforced ONLY client-side via localStorage (`dashboard/page.tsx:58-61,120-160`); the server has no dedupe.
- Flaws: not linked to participant, server, or order; day key uses server `new Date()` (UTC host vs Manila day boundary, CHECK); no alert on 1-2 stars; no Google-review hand-off. `CROSS-APP-MAP.md:286` lists `api/external/feedback` "POS <- ?" as unresolved. NEEDS COUNT: feedback per month, rating spread, response rate (feedback / sessions).

### 2.10 Notifications
- None to the diner: no push/FCM, SMS or email (grep). Only 20s polling plus one live listener for session closed (`dashboard/page.tsx:170-191`). Staff alerts are Firestore docs, not push.

### 2.11 Games shelf (about a fifth of the code)
- Goal: keep guests engaged while grilling; user-generated recipes with votes; leaderboard.
- v1: `/play/flipit` (`lib/games/flipit/leaderboard.ts`), `/play/samgyup-recipe` (`lib/server/games/recipe-store.ts`, 552 lines; `admin/games/*`, `manager/games`), stats (`gameStats`). Christmas theming (`components/christmas/*`, two mp3s in `public/audio`) wired in `app/layout.tsx:6-10,53`.
- Data: `miniGames, gameRecipes, gameFeeds, gameAuthors, gameStats`. NEEDS COUNT: plays per week, recipes submitted, moderation rejects.
- Flaws: user-submitted text needs moderation; Christmas code is hardcoded and idle most of the year.

### 2.12 Staff back office inside CUSTOMER
- PIN list/cleanup (`admin/page.tsx`, `api/manager/pins*`), categories, flash ads, feedback, games moderation, catalog preview. Firebase Auth sign-in; authorization server-side via `staff/{uid}` (cross-map section 4e correction). Client-side Firestore writes remain for categories, flash ads and pinRegistry delete (`admin/page.tsx:178`).

### 2.13 How it talks to POS / Firestore
- Same Firebase project as POS; Admin SDK in route handlers (rules bypassed); client SDK for about five reads/CRUDs. All coupling is shared Firestore docs (doc 10 sections 3, 8). POS's browser calls CUSTOMER's admin API with a POS-minted token (cross-map).

### 2.14 Privacy / PII
- Collected: phone (as doc id), name, address, email, birthday, bcrypt hash (`customers/{phone}`); feedback name + text; hashed device id; session ids. `loyaltyLogs` record the phone on every login and failure.
- Risks: no consent screen seen (CHECK signup UI); PH Data Privacy Act (RA 10173) applies to birthday + address + phone; no retention/purge job found; member enumeration risk; feedback free text may hold PII. Guest ordering path stores no PII beyond a hashed device id (keep that).
- Secrets via App Hosting secrets (`apphosting.yaml`); same service-account key file reused by POS (cross-map).

## 3. Tech stack, size, hot vs dead
- Next.js 15.5 / React 19 / Tailwind + Radix, react-hook-form + zod, Firebase 11 + firebase-admin 13, bcryptjs, qrcode.react, recharts, exceljs, genkit (unused). Own `firebase.json` / `firestore.rules` / `.firebaserc` (landmine). Port 9004.
- Hot (diner loop): dashboard (`app/dashboard/page.tsx` 543 lines), CustomerCatalog (849), CustomerRefillModal (912), SessionOrdersPanel, exchange-pin/qr, submit-refill, submit-addon-order, session-orders, feedback modal, loyalty card.
- Probably cold (NEEDS COUNT before judging): points transfer, collect-voucher, standalone `/sharelebrator/*`, games, flash ads, request-griller. Dead: `repeat-first-order`, genkit. Seasonal: Christmas decor. Check use of exceljs/recharts.
- Tests: 19 files, mostly refill rules, catalog pricing, loyalty routes, access rules. None for UI.

## 4. Flaws, ranked (candidates; v1 owns the goal, not the method)
1. Shared Firebase project + rules file collision (deploy from CUSTOMER overwrites POS rules) — cross-map 4e.
2. Loyalty: no login rate limit, no phone verification, enumeration, phone as primary key, two writers on balance.
3. Feedback: client-only one-per-session, admin sees last 10 day-docs, array-in-doc, no alerting.
4. Six dual-writer collections; `source` erased on tickets; duplicate KDS writer.
5. `ignoreBuildErrors:true`; no service worker despite offline claim; maxInstances 1.
6. Business rules as magic numbers (60s, 10min, 20min, 50/100 pts per day, 24h grace, 60min voucher expiry).
7. No payment, no final bill view, no diner push.
8. Device id in localStorage resets cooldowns; PIN brute force unguarded.

## 5. Capability list for the v2 phase plan
(capability · goal · v2 note)
1. Join table by QR/PIN, seat-limited, revocable · only people at the table order onto its bill · keep model; server-issued session token; add PIN rate limit; drop client `000000` shortcut.
2. Refill ordering with cooldown / first-serving gate · fair, abuse-proof unlimited refills · keep rules; constants become per-store config; one ticket writer.
3. Priced add-on ordering, server re-priced, idempotent · correct bill, no double order · keep; bill-on-serve is revenue-recognition critical (cross-map 4b); keep `orderedVia`.
4. Menu (variants, modifiers, popular) from POS catalog · one menu truth · read from v2 catalog projection (Firestore edge mirror); no second admin.
5. Order status + running bill · diner knows what is coming and what it costs · live status instead of 20s polling; show full read-only bill.
6. Call staff / add griller · fast service · keep; transactional dedupe; response-time metric.
7. Loyalty account, points, rewards, code redemption · repeat visits · redesign identity (OTP or lockout, not phone-as-key); one balance writer (ledger in Postgres); keep hold-then-apply; decide transfers after count.
8. Flash ads / promo overlay · upsell · move admin into ERP; add view/click counts.
9. Feedback + rating · service quality signal · server dedupe per participant, link to session/table, low-rating alert, retention rule, flatten array-in-doc.
10. Diner notifications · know when food/bill ready · NEW (assess first): web push or in-app only.
11. Online payment / split bill · pay at table · NEW (assess first; accounting-systems review).
12. Reservations · bookings · NEW, not in v1 (assess first).
13. Mini-games + recipe community · engagement · keep only if counts justify; isolate as a module; seasonal theme becomes config.
14. Staff back office in CUSTOMER (PINs, categories, games moderation) · ops tools · fold into ERP/POS v2 admin.
15. Standalone loyalty card (no session) · check points anytime · keep, behind OTP/lockout login.
16. PII handling / consent · legal (RA 10173) · consent text, retention, deletion route, no PII in logs.
17. Cutover data: `customers/{phone}` + points, `loyaltyRedemptions`, `loyaltyLogs`, feedback days · history retained · classify in cutover classification; flatten feedback arrays.

## 6. Open questions for Ian
1. Can you get production counts for: loyalty accounts / active 90 days / redemptions / transfers; feedback per month; customer-app vs staff tickets; games plays? Several keep/drop calls depend on them.
2. Is diner-to-diner points transfer used and wanted? (Recommend: keep until counted.)
3. Phone verification for loyalty signup (SMS OTP costs money) or accept unverified phones with rate limit + lockout? (Recommend: lockout now, OTP if fraud appears.)
4. Should diners pay or split the bill from their phone (GCash/QR Ph)? Not in v1; large accounting impact.
5. Reservations from the app or website: wanted at all?
6. Push or in-app notice for "food served" / "bill ready": wanted?
7. Games and Christmas theme: keep, drop, or optional module? (Drop needs your OK.)
8. Feedback: alert managers on 1-2 stars; ask 5-star diners for a Google review?
9. Should staff tools (flash ads, categories, PIN cleanup, games moderation) live in ERP v2 instead of the diner app? (Recommend yes.)
10. Who owns `categories` and `api/external/feedback` today? Unresolved in doc 10 and cross-map; needs a POS/Website grep (not done here).

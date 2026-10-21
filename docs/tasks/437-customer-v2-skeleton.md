# T-437: Customer v2 minimum skeleton (diner phone app, fixtures only)

**Status:** LIVE 2026-10-17 (PR #35). Customer v2 skeleton, sample data only.
**Model:** Sonnet tester (slice T) -> Sonnet builder (B1-B3) -> Sonnet auditor (A). No money posting, no auth, no DB.
**Migration:** none. No schema, no `packages/**` source change.
**Authority:** plan `docs/plans/pos-customer-v2-phase-plan.md` §5 · ADR-015 Amendment A6 · bible rows 307 (no admin in
the app), 343 (round-2 answers), 349 (order.shareat.net, `net.shareat.order`), 350 (diners in the one people list) ·
T-417 (the shell: port 9010, two build modes, CI job) · T-422 rule 9 (per-app vitest) · discovery 40.

## Goal, in plain words
Ian asked (17 Oct) for "the minimum viable customer app v2, like the skeleton". Customer v2 goes live only in P3
(Q2 2027). Today we build the **walkable shape** of it: every diner screen exists, you can click through the whole
visit (join a table, browse the menu, order, watch the bill and the order status, leave feedback, sign up with the
consent tick), and it looks like part of the same family as the ERP and POS. **All data is made-up sample data
inside the app. Nothing reads or writes any live system.** The screens talk to a data layer through one interface,
so P3 swaps the sample data for the real server without rewriting a screen.

## "Minimum skeleton" means exactly this
| In | Out (named, so nobody adds it "while here") |
|---|---|
| 8 routes below, each a working screen on sample data | any real server, API route, server action, Firestore, Postgres |
| one `CustomerData` interface + one `FixtureCustomerData` | the real `HttpCustomerData` (P3) |
| the A6 rules the server will own, simulated by the fixture and pinned by tests (they become the server contract) | refill cooldowns (per-store settings, DEF-021), call-staff / add-griller, loyalty points, rewards, transfers, games, flash ads, Christmas theme |
| demo banner on every page | pay or split from the phone, push, reservations (A6: not in first release) |
| mobile-first layout in the POS/ERP token family | admin, manager, PIN-list screens (row 307) |
| unit tests + guard tests, web build + static export | the 3-year deletion job and diner-in-people-list (server work, P3; row 350) |

## Ruling: fixtures only, not v1 Firestore read-only (planner)
1. **Fixtures.** Reading v1's Firestore from this app needs the Firebase client SDK and a `shareat-hub-v2` config in
   a phone bundle. The client SDK can write as easily as read, and v1's rules let a diner token write tickets, so
   "read-only" would be a promise kept by care, not by construction. The skeleton must never write to live data; the
   only way to make that structural is for the app to hold no route to live data at all. v1's data shapes are also
   being replaced (Postgres, the one ERP menu, row 307), so mirroring them now would teach screens the wrong shape.
2. **Enforced by test:** no file under `apps/customer/src` imports `firebase`, `firebase-admin`, `@shareat/db`,
   `@shareat/domain`, `@shareat/auth` or any `@capacitor/*` (static or dynamic `import()`), or uses `fetch(`,
   `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon`, `CapacitorHttp`; `package.json` has no `firebase*`
   dependency; no `src/app/api/` dir; no `route.ts`; no `'use server'`. Scans skip `**/__tests__/**`.

## Routes (all static, export-safe: no `[param]` folders, no API routes)
| Route | Screen | Data calls |
|---|---|---|
| `/` | Join a table: 6-digit PIN pad; "Scan the table QR" note; lock message after 5 wrong tries | `joinByPin` |
| `/join` | QR landing: reads `?t=` (inside a `<Suspense>`, Next 16 static-export rule for `useSearchParams`), joins, goes to `/menu` | `joinByQr` |
| `/menu` | Store + table header; categories; items with price (or "Included" for refills of the package) and add button | `getMenu` |
| `/cart` | Lines, qty +/-, note "prices are checked by the store", Send order | `placeOrder` |
| `/orders` | Each order and its status (preparing / partly served / served / cancelled) | `getOrders`, `subscribe` |
| `/bill` | Running bill, read-only; "Estimate. Your final bill is at the cashier." No pay or split button | `getBill`, `subscribe` |
| `/feedback` | 1-5 stars + optional text; after send: thanks; 1-2 stars "a manager has been told"; 4-5 stars Google-review link if the store has one | `submitFeedback` |
| `/account` | Sign up (name, PH mobile `09XXXXXXXXX`, password >= 8, SMS code step, **consent tick unticked by default, required**) and sign in (phone + password); privacy notice: inactive 3 years = deleted | `requestSignUpCode`, `signUp`, `signIn` |

Every route except `/`, `/join`, `/account` needs a joined session; without one it shows "Join a table first" and a
link to `/`. Bottom tab bar on session pages: Menu · Cart (count) · Orders · Bill · Feedback; header link to Account.
**On-page notices:** a notice strip shows the newest status change pushed by `subscribe` (no polling, no push, A6).

## Data layer (`apps/customer/src/data/`)
- `types.ts`: `Store {id,name,googleReviewUrl:string|null}`, `TableSession {sessionId,participantId,store,tableLabel}`,
  `MenuItem {id,name,category,kind:'addon'|'refill',price:Money}` (`Money` from `@shareat/core/money`; refills price
  `'0.00'`), `OrderLine {itemId,qty}`, `Order {orderId,clientRequestId,lines,status,placedAt}`, `Bill {lines:{name,qty,
  amount:Money}[], subtotal:Money, isEstimate:true}`, `Result<T> = {ok:true,value:T} | {ok:false,reason:string}`
  (`reason` is plain diner-facing text). Names checked against `docs/GLOSSARY.md` before use.
- `customer-data.ts`: `interface CustomerData` with the methods in the table, all `Promise<Result<...>>`, plus
  `subscribe(sessionId, listener): () => void`.
- `fixture-data.ts`: `createFixtureCustomerData(options?: {now?: () => number})` - in-memory, one instance per page
  load, seeded from `fixtures.ts` (1 store "Shareat Lipa (demo)", 3 tables, PINs and QR tokens, ~12 items in 4
  categories incl. 3 refills). It enforces, as the P3 server must:
  1. PIN must be 6 digits. A wrong PIN matches no table, so wrong tries count **per device** (`joinByPin(pin,
     deviceId)`): **5 wrong in a row lock PIN joining on that device for 5 minutes** (uses `now`); a correct PIN resets
     the count; QR join is not blocked by a PIN lock. `000000` is an ordinary wrong PIN (no admin shortcut, discovery 40 §2.1).
  2. Seat limit per table (fixture: 4); the 5th distinct device is refused with a plain reason. **The same `deviceId`
     re-joining the same table gets the same `participantId`** and takes no new seat (v1 one slot per device).
  3. `placeOrder(sessionId, lines, clientRequestId)` takes **item ids and quantities only, never a price**; unknown item
     or qty not a whole number 1-20 is refused; the **same `clientRequestId` twice returns the first order, no second
     order** (v1 `order-claim.ts`).
  3b. **Bill-on-serve** (plan §5, discovery 40 §2.2): `getBill` counts only orders whose status is `served` or
     `partly_served` (fixture: partly served bills half the qty, rounded down); `preparing` and `cancelled` are not
     billed. Amounts = fixture menu price x qty in integer centavos via `@shareat/core/money`.
  4. `getBill` is always `isEstimate: true`; no method on the interface takes a payment.
  5. `submitFeedback(sessionId, participantId, rating, text)`: rating integer 1-5 else refused; **one per participant**
     (second refused); returns `{managerAlerted: rating <= 2, googleReviewUrl: rating >= 4 ? store.googleReviewUrl : null}`.
     `sessionId` stands in for "table + receipt" (A6) until P3, whose server contract adds `receiptId`.
  6. `signUp({name, phone, password, code, consent})`: refused unless `consent === true`; phone `^09\d{9}$`; password
     >= 8 chars; code must match the one from `requestSignUpCode`, whose fixture result returns the code so the demo
     screen can show "Demo code: ######" (nothing is texted). Duplicate phone refused. `signIn` refuses with ONE
     generic reason for unknown phone and wrong password (no member enumeration, discovery 40 §2.6); **5 wrong for one
     phone lock sign-in for that phone 15 minutes**, same generic reason. "Forgot password? Ask a manager at the store."
     and no self-service reset (row 314).
  7. An unknown `sessionId` on any call returns `{ok:false}` (happens after a reload, because the fixture is in memory).
  8. Status changes: `advanceOrderForDemo(orderId)` (fixture-only, not on the interface) moves an order
     preparing -> partly_served -> served and notifies subscribers; `cancelOrderForDemo(orderId)` (fixture-only) sets
     `cancelled` and notifies. A malformed PIN (not 6 digits) is refused and does NOT count toward the lock. A line
     carrying an extra `price` field is accepted, the field is ignored, and the menu price is billed.
  9. Fixture stores: TWO demo stores ("Shareat Lipa (demo)" with `googleReviewUrl` `https://g.page/r/demo`, and
     "Shareat Malvar (demo)" with `null`), tables spread across both; exports `DEMO_TABLES` (`{label, pin, qrToken}`) and
     `DEMO_MENU`. `requestSignUpCode` returns `Result<{code: string}>`.
- `provider.tsx`: `'use client'` React context holding the one `CustomerData`, a per-browser `deviceId`, and the joined
  `TableSession` (kept in `sessionStorage`, read **only in `useEffect`** so pre-rendered HTML matches, wrapped in
  try/catch; Money stored as its string, never a BigInt). If a call returns `{ok:false}` for an unknown session the
  provider clears it and the page shows "Join a table first". `useDemoControls(): {advanceOrder} | null` is non-null
  only when the source is the fixture; the Orders screen shows "Demo: advance" through it. Screens get data only
  through `useCustomerData()` / `useDemoControls()`; no screen imports `fixture-data.ts` (guard test).

## Visual family
Tailwind 3 (root's version, as `apps/pos`), `postcss.config.mjs` like POS, `tailwind.config.ts` with the same token
names as `apps/pos/src/app/globals.css` (`--background`, `--foreground`, `--card`, `--primary` 42 100% 50% Shareat
orange-yellow, `--muted`, `--border`, `--destructive`, `--radius`) and a dark set. Phone-first: one column, `max-w-md`
centred, 16 px gutters, tap targets >= 44 px, bottom tab bar fixed. Demo banner: "Demo - sample data, nothing is sent
to the store". Small shared kit in `src/components/` (Button, Card, Stars, TabBar, NoticeStrip, DemoBanner).
Icons: `lucide-react` at POS's version (already in the lockfile) or none.

## Slices (tester and builder paths are disjoint)
**T - tester, first; all red for the right reason before B1.** New files only, under `apps/customer/src/**/__tests__/`:
- `data/__tests__/fixture-data.test.ts` - every numbered rule above, each killing a named mutant (below).
- `data/__tests__/cart.test.ts` - `src/lib/cart.ts` pure helpers: add/remove/setQty, count, and that a cart line holds
  no price field (type-level + runtime).
- `__tests__/skeleton-guards.test.ts` - reads the tree, imports no app code: route set equals the 8 routes exactly
  (walks `src/app/**/page.tsx`); no `[` folder; no `api/` dir, no `route.ts`, no `'use server'`; forbidden imports and
  network calls (Ruling 2); `package.json` has no `firebase*`; no file under `src/app` or `src/components` imports
  `data/fixture-data`; the word `pay`/`split` appears on no button label in `src/app/bill/` (no `<button`/`Button` whose
  text matches `/pay|split/i`); `000000` appears nowhere outside tests; `/account` page source contains a checkbox
  bound to `consent` with no `defaultChecked`/`checked={true}`. **Each detector is a pure function in the test file
  and gets one hand-made bad sample string that it must flag** (pattern: `tests/unit/app-boundaries.test.ts` fixtures),
  so a detector that always returns `[]` cannot pass.
- `apps/customer/vitest.config.mts` - copy of `apps/pos`'s shape: `root: here`, `@` -> `src`, `@shareat/core/money`
  -> `packages/core/src/money.ts`, `include: ['src/**/*.test.ts']`, node env. And `"test"` script in package.json.
  (These two are test plumbing; the tester writes them so red runs are real.)

**B1 - plumbing.** `apps/customer/package.json` (deps `@shareat/core: "*"`, `lucide-react ^0.475.0`; devDeps
`tailwindcss ^3.4.1`, `postcss ^8.4.49`, `vitest ^4.1.8` - exactly `apps/pos`'s ranges so the lockfile gains no second
copy), `package-lock.json` via `npm install` at root, `tsconfig.json` (`paths` add `@shareat/core/money` ->
`../../packages/core/src/money.ts` only; must keep passing `tests/unit/app-workspaces.test.ts`), `next.config.mjs` (`transpilePackages:
['@shareat/core']`, nothing else changes), `tailwind.config.ts`, `postcss.config.mjs`, `src/app/globals.css`, root
`vitest.config.mts` **one exclude entry** `'apps/customer/**'` next to `'apps/pos/**'` with a one-line comment.

**B2 - data layer.** `src/data/{types,customer-data,fixtures,fixture-data}.ts`, `src/data/provider.tsx`, `src/lib/cart.ts`.

**B3 - screens.** `src/app/layout.tsx` (provider, banner, globals.css), the 8 `page.tsx` files (`/` keeps the
literal heading text "Shareat Customer v2": `tests/unit/app-workspaces.test.ts:112` checks it), `src/components/*`.
README updated (routes, "fixtures only", how to run).

**A - auditor (Sonnet, read-only)**: diff against this spec; checks every acceptance case with real output; looks for
a write path to anything live, a price sent from the client, a pay control, a pre-ticked consent; FINDINGS <= 30 lines.

Workers never run git. The lane commits on its own branch only. LF line endings. Dev port 9010 only.

## Acceptance (each case names the mutant it kills)
1. 5th wrong PIN on a device locks that device; a correct PIN during the lock is refused; another device is not locked; QR join still works; after 5 min (`now`) PIN works. Kills: no lock / lock never expires / lock global / lock blocks QR.
2. `000000` is refused like any wrong PIN. Kills: v1's admin shortcut.
3. 5th distinct device refused; the same device re-joining gets the same `participantId` and does not use a seat. Kills: no seat limit / re-join burns a seat.
4. `placeOrder` with the same `clientRequestId` twice -> one order, same `orderId`. Kills: double order on retry.
5. Bill: a `preparing` order and a `cancelled` order add nothing; after advancing to `served`, subtotal = fixture price x qty in exact centavos (e.g. 3 x 89.50 = 268.50); a cart line can't carry a price. Kills: unserved billed, cancelled billed, client-priced bill, float math.
5b. Any call with an unknown `sessionId` returns `{ok:false}`. Kills: a stale session silently ordering.
6. Rating 0, 6, 2.5 refused; second feedback by the same participant refused; rating 2 -> `managerAlerted`; rating 5 -> store URL; rating 4 with store URL null -> null; rating 3 -> neither. Kills: off-by-one thresholds, no dedupe.
7. Sign-up with `consent:false` or missing refused; bad phone, short password, wrong code, duplicate phone refused; `signIn` reason identical for unknown phone and wrong password; 6th try after 5 wrong is refused even with the right password, and works after 15 min. Kills: optional consent, member enumeration, no lockout.
8. Guard test (all items in slice T) passes. Kills: a firebase import, an API route, a dynamic segment, a pay button, a pre-ticked consent, a screen bypassing the interface.
9. `npx tsc -p apps/customer/tsconfig.json --noEmit` clean; `npm test -w @shareat/customer` green; root `npx vitest run --project unit` collects 0 files under `apps/customer`.
10. `npm run build -w @shareat/customer` and `npm run build:cap -w @shareat/customer` pass; `apps/customer/out/{index,menu/index,bill/index,join/index}.html` exist.
11. `npm run typecheck` (root) still passes and lists no `apps/customer` file; T-417 guard tests (`app-workspaces`, `app-boundaries`, `ci-app-jobs`, `ci-affected-apps`) still pass.
12. Smoke on 9010 (`npm run dev:customer`): PIN join -> menu -> add 2 items -> send -> orders shows it -> demo advance shows a notice -> bill shows the amount, no pay button -> feedback 5 stars shows the review link -> account sign-up blocked until consent ticked. Screenshot at phone width.
13. CI `app-customer` job green on the orchestrator's PR, APK step cleanly skipped while the keystore secrets are absent. No change to `ci.yml`, `app-build.yml`, `deploy.yml`.

## Must NOT change
`apps/pos/**`, `apps/erp/**`, `packages/**`, `.github/**`, root `package.json` scripts, root `tsconfig.json`,
`apps/customer/android/**`, `apps/customer/capacitor.config.ts`, the bible and ADR-015, CUSTOMER v1 (read-only),
any droplet.

## Open questions (none block this task)
1. Google-review link per store: Ian supplies (plan §9 Ian-only actions). Fixture uses `null` for one store-less case and a placeholder `https://g.page/r/demo` clearly marked demo.
2. Refills: the skeleton shows refill items as "Included"; cooldowns and the first-serving gate come with P3 per-store settings.

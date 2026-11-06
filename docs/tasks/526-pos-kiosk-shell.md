# T-526 — POS v2 kiosk shell at `/pos`: full screen, tabs, status, tablet sign-in, offline cashier switch

> **Status:** spec written 7 Nov 2026 by the POS design lane (Opus planner). Not built.
> **Depends on:** T-525 (the APIs, `af5a588`) and work order **T-530a** (the device store, `apps/erp/src/lib/pos-device/`,
> amended 7 Nov to add a `verifiers` store). T-526 may start on stubs of both and must rebase onto them before merging.
> **Migration:** none. **Risk:** high (sign-in and an offline PIN check), so a Sonnet builder and a Sonnet auditor are
> used. **Design:** `docs/plans/pos-v2-design.md` §5.2 (A1, A2, A6, A7, A9), §5.4 and §7; mocks `orders.png`,
> `orders-offline.png`, `kitchen-dark.png`. **Bible:** rows 313, 323, 371, 381, 430, 433. Run the `impeccable` skill
> for every screen choice (standing, 3 Nov).

## Goal

A cashier on the store's paired tablet signs in with Employee ID + PIN and lands in a **full-screen POS**, with no ERP
sidebar. The POS has tabs (Orders · Kitchen · Refills · Receipts · Till) and a top bar that says, at a glance:
- who is signed in;
- whether the tablet is online;
- how many actions are waiting to send.

When the internet drops, the cashier can still hand the tablet to the next cashier, who signs in with their own PIN.
That PIN is checked on the tablet against a verifier made when they last signed in online. T-526 builds this frame. The
Orders screen inside it is T-527, Payment T-528, Kitchen and Refills T-529, and the offline engine's remaining parts
T-530.

**v1's goal (§1.2d):** get a cashier selling fast on the one store tablet, attributably, even offline. v1 kept a store
Firebase login and a per-profile passcode inside the APK. **v2 beats it:**
- the tablet holds a revocable pairing secret (T-464), not a shared password;
- the offline PIN check uses a slow, salted, device-only verifier that never leaves the tablet and expires;
- the server re-checks every offline action's person (T-525 R4).

## Out of scope (each with its reason)

| Out | Why |
|---|---|
| The Orders, Payment, Kitchen, Refills, Receipts and Till bodies | T-527, T-528, T-529 and later. T-526 renders each tab with a plain placeholder card naming the slice |
| The Online tab | Built last (§7.2; 3 orders all-time). Not shown in release 1 |
| Picking one of two positions (row 323) | Nothing implements `acting_position_id` yet. Release 1 uses the person's grants as they are. Raised as Open O1 |
| The service worker, cold start with no internet, the APK shell | T-530 / A8 |
| The ₱50,000 unsent warning, X-slip, update gate | T-530 |

## R1 — Routes and kiosk mode

- New route tree `apps/erp/src/app/pos/`:
  - `layout.tsx` (the shell, R3);
  - `page.tsx` (Orders, a placeholder until T-527);
  - `kitchen/page.tsx`, `refills/page.tsx`, `receipts/page.tsx` and `till/page.tsx` (placeholders).
- `proxy.ts`: the matcher becomes `['/clock', '/clock/:path*', '/pos', '/pos/:path*']`, so `AppShell` hides the ERP
  chrome (`AppShell.tsx:35`). Update `apps/erp/tests/proxy-kiosk-header.test.ts` to the new exact list, and keep its
  exactness.
- Every page is a Server Component that calls `requirePageAccess('/pos…')` first and renders the refusal when it is not
  null (`lib/page-access.tsx`). `ROUTE_CAPABILITY` entries:

| Route | Requirement |
|---|---|
| `/pos` (and `/pos/receipts`, `/pos/till`) | `record_sale` |
| `/pos/kitchen` | `serve_pos_ticket` |
| `/pos/refills` | `request_pos_refill` |

- A route someone may not open is not shown as a tab (R3).
- Census duties, each done honestly without weakening any guard:
  - `route-capability-coverage` (the pages call `requirePageAccess`);
  - `nav-route-reachability`: add `/pos/*` to `UNLINKED_BY_DESIGN` with the reason "full-screen POS, reached from
    tablet sign-in or the ERP button; never a sidebar link";
  - the `t348-page-description-sweep` allowlist (kiosk layout, like `/clock`);
  - `no-ungated-read-surface`;
  - the touch-target baselines, if they cover new pages;
  - `tests/unit/pos-v2-copy.test.ts` and the app-boundary tests, if they pattern-match `pos` paths.
- **The Kitchen theme (row 433):** `/pos/kitchen` renders with `data-theme="dark"` unless the `shareat_theme` cookie
  is exactly `'light'`. Every other route keeps the existing rule (anything not `'dark'` is light). This is a server-side
  decision in the kitchen page or a nested layout, so the first paint is right. Do not change `theme-state.ts`'s rule
  for other routes.

## R2 — Landing after sign-in

- `apps/erp/src/app/sign-in/landing.ts`: when the sign-in came from a **paired tablet** (the `signInWithTabletPinAction`
  path) and the person holds `record_sale` at the pairing's store, land on `/pos`. Otherwise, if they hold
  `serve_pos_ticket` there, land on `/pos/kitchen`. Otherwise, if they hold `request_pos_refill` there, land on
  `/pos/refills`.
- An explicit safe `next` still wins. Every other sign-in keeps today's landing.
- Tests: each of the three POS landings; a cashier signing in by email on a laptop is **not** sent to `/pos`; and a
  safe `next` wins.

## R3 — The shell (`app/pos/layout.tsx` plus client components in `app/pos/_shell/`)

The server part resolves:
- the session (`requirePageAccess`);
- the pairing (`readPosTabletToken` and `resolvePosTablet`), or null on a phone or kitchen browser;
- the store: the pairing's store, else the person's single store scope. When the person has several stores and there is
  no pairing, show a store picker card that links `?storeId=`. The store is validated by the domain's store scope.
- the tabs the person may open (R1's capabilities, checked with `heldCapabilities`).

The client part (`'use client'`) shows the top bar, from left to right:
1. The store name.
2. The tab strip, only the tabs allowed:
   - Orders, Kitchen, Refills, Receipts and Till;
   - Kitchen and Refills each show their live count from the state poll, the way `orders.png` shows them;
   - the active tab is marked with `aria-current="page"`.
3. A status pill, using the existing `Badge`. Its states:
   - **Online**;
   - **Offline 1h 12m · 14 waiting to send**, which is the yellow band of `orders-offline.png`;
   - **Sending…** while a drain runs.
   The waiting count comes from `countPending()` (T-530a).
4. The signed-in name, with a **Switch cashier** button (R5).
5. An **ERP** button for anyone who holds any ERP route beyond `/pos`. It links to that person's normal landing.

Further rules:
- Touch targets are at least 48 px. The kit's `Button` is `min-h-11` (44 px), so use a POS size variant built from
  tokens: add a size prop to the kit, or a `pos-` class, whichever the kit's conventions allow. Never write a raw pixel
  value. Plus Jakarta Sans and Baloo 2 come from the existing tokens.
- **No new state library.** A small `usePosState` hook polls `GET /api/pos/state?since=<v>&storeId=` every 3 seconds
  while the tab is visible (`document.visibilityState`) and keeps the last body. A 304 changes nothing. A network
  failure flips the pill to Offline after 2 failures in a row (about 6 seconds). Polling stops while the tab is hidden.
  The tabs read their lists from this hook.
- **Snapshot on the paired tablet only:**
  - On mount and every 5 minutes, `GET /api/pos/snapshot` with `If-None-Match`.
  - On a 200: `saveSnapshot`, then `resumeAbove(device.lastSeq, device.lastTerminalSeq)`.
  - On a 304: `touchSnapshot`.
  - On a failure: keep the cached snapshot (`readSnapshot`). Never blank it (A6).
  - If there is no usable snapshot, the tablet has never been signed in online, so show "This tablet needs the
    internet once to load the menu."
  - The age limit passed to `isSnapshotUsable` comes from the snapshot's `rules`, if T-539 adds one. Otherwise it is a
    named constant `POS_OFFLINE_SNAPSHOT_MAX_AGE_MS = 24 h` with a one-line reason: A6, the offline limit stated in
    the design, a protocol limit rather than a business setting.
- **Drain:** after any enqueue (T-527 onward) and every 10 seconds while online and the outbox is not empty, call
  T-530a `drain(send)`. `send` POSTs `/api/pos/events` with `credentials: 'same-origin'` and maps the reply onto
  `SendOutcome`.
  - On `stopped: 'http', status 401`: the pairing is dead. Show "This tablet was un-paired. Ask a manager to pair it
    again."
  - Conflicts: show the manager-facing sentence from T-530a in the Toaster.

## R4 — The offline PIN verifier: made on the tablet at online sign-in

- **The pending verifier.** `TabletSignInForm.tsx` gets an `onSubmit` hook that runs before the Server Action submits.
  It:
  1. derives a verifier from the typed PIN in the browser, with WebCrypto `PBKDF2-SHA256`, a random 16-byte salt and
     `POS_VERIFIER_ITERATIONS` (a security constant, at least 210,000, the current OWASP figure, with its reason);
  2. stores it as **pending** in `sessionStorage` under `shareat_pos_pending_verifier`, as
     `{employeeId, salt, hash, iterations, createdAtMs}`. The PIN itself is never stored, logged or sent anywhere new.
  The form still submits exactly as today.
- **Promote.** On the first load of `/pos` after sign-in, the shell reads the pending verifier. If its `employeeId`
  equals the signed-in person's `employeeId` from the snapshot's `staff` list, and it is no older than 5 minutes, it is
  stored with `putVerifier({personId, ...})` (T-530a). The pending entry is then **always** deleted, whether or not it
  matched. A wrong PIN never reaches `/pos`, so its pending entry is never promoted, and the next attempt replaces it.
- **Expire.**
  - On every successful snapshot 200, delete any verifier whose `personId` is no longer in `staff`. A revoked staffer
    loses offline sign-in at the next refresh (A6).
  - A verifier is usable offline only while `isSnapshotUsable(snapshot, now, POS_OFFLINE_SNAPSHOT_MAX_AGE_MS)`, so no
    verifier works more than 24 hours after the last online refresh.
- **Verifier rules:**
  - The salt is per verifier.
  - The hash comparison runs in constant time over the bytes.
  - Nothing about verifiers is sent to the server.
  - Clearing the app's data clears them (design §5.4).
- Put the derive, verify and constant-time compare functions in `apps/erp/src/lib/pos-device/pin-verifier.ts`. This
  file is T-526's own, beside T-530a's storage. It is pure and unit-tested.

## R5 — Switch cashier

- **Online** (the state poll is succeeding): **Switch cashier** calls the existing `signOutAction` and lands on
  `/sign-in`, which on a paired tablet shows Employee ID + PIN (T-464). This adds no new server path.
- **Offline:** **Switch cashier** opens an in-shell dialog (the kit's `Dialog`) with a 3-digit Employee ID and a
  6-digit PIN, on big keypad buttons. Typing is not needed (row 371); a tap keypad component may be added under
  `app/pos/_shell/`.
  - The PIN is checked with `getVerifierByEmployeeId` plus `pin-verifier.ts`.
  - On a match, the **offline actor** becomes that `personId`, held in memory and in `sessionStorage` for a reload. Every
    event T-527 onward enqueues carries this `personId`. The top bar shows the name with an "offline sign-in" tag.
  - On a miss, the dialog says "Wrong Employee ID or PIN." **5 misses for one Employee ID pause that ID for 5 minutes**,
    the same rule as T-464 (row 381). The count is kept in the device store's `meta`, so a reload does not reset it.
  - The offline actor ends:
    - when the tablet is back online and the server session belongs to someone else, in which case the shell asks that
      person to sign in online (`signOutAction`);
    - on Switch cashier;
    - at the 24-hour snapshot limit.
- The capabilities shown offline (which tabs and buttons) come from the snapshot's `staff[].posCapabilities` for the
  offline actor. The server still decides every action (T-525 R4 and `authorize()`).

## R6 — Tests (the tester writes them first; every ✅ needs its ✗)

**Unit (apps/erp, the `node` environment; use the fake IndexedDB from T-530a's `apps/erp/tests/helpers/fake-idb.ts`
and WebCrypto from `node:crypto`'s `webcrypto`):**
- `pin-verifier`:
  - derive, then verify with the right PIN → true; a wrong PIN → false;
  - two derives of the same PIN have different salts and hashes;
  - fewer iterations than the constant → refused;
  - the compare has no early return (read the source).
- Promote:
  - a matching pending verifier → stored, and pending deleted;
  - a mismatched employee → not stored, and pending deleted;
  - a pending verifier older than 5 minutes → not stored;
  - no pending → no-op.
- Expire:
  - a staffer dropped from `staff` → their verifier deleted;
  - a snapshot older than 24 hours → offline sign-in refused.
- Offline switch:
  - the right PIN → the actor is set;
  - 5 misses → paused, and the 6th attempt with the right PIN is refused until 5 minutes pass (injected clock);
  - the pause survives a reopen.
- `usePosState` logic, extracted as a pure reducer plus an injected `fetch`:
  - a 304 keeps the state;
  - two failures → offline;
  - a hidden tab → no fetch.
- Landing: the R2 cases.
- `proxy-kiosk-header`: the new exact matcher.
- Kitchen theme: no cookie → dark; `'light'` → light; `'dark'` → dark. The Orders route with no cookie → light.

**Integration (real Postgres, the lane's `_test` DB):** every `/pos` page refuses a person without its capability
(`requirePageAccess`), and refuses another store's manager when `?storeId` names a store they do not hold.

**No screenshot claim without a render (standing rule).** The builder renders `/pos` and `/pos/kitchen` with a seeded
session at 1280×800 and 390×844, with Orders online and offline. Compare them with `orders.png`,
`orders-offline.png` and `kitchen-dark.png`, and attach the screenshots to the hand-back. Dev servers cannot run from a
junctioned worktree, so render from the main tree on a release branch, or use the headless approach from the design lane
(`mocks.html` rendering).

## R7 — Gates

`npm run typecheck` · the unit project · the integration files above · `route-capability-coverage` ·
`nav-route-reachability` · `no-ungated-read-surface`. Use the lane's own `_test` DB. Never print a value from
`.env.local`.

## Open

- **O1 (for Ian, via BOSS):** row 323 says a person with two positions picks one after the PIN, and the pick only
  narrows. Nothing implements it yet. Release 1 proposal: no picker, so a person acts with all their grants, the same as
  in the ERP today. Is that acceptable for Lipa on 7 Dec?

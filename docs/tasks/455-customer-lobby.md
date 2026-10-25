# T-455: Customer app lobby: menu, self check-in, booking code, birthday-song request, discount-ID claim

**Status:** SPEC 2026-10-24 (Opus planner). Build starts now (Ian, 24 Oct); switch-on date is Q3 below.
**Model:** Sonnet tester -> Sonnet builder -> Sonnet auditor per slice (S7/S8 touch personal data: money/PII lane rules).
**Migration:** one, **0215 (renumbered from 0217 on 25 Oct; 0216 is POS T-472, 0217 is T-475 S3)** by the orchestrator. Hand-authored (ADR-012 §5).
**Authority:** bible rows 251, 283, 330, 349, 353, 357, 358, 364, 371, 372, 378, 379, 380, 383; ADR-015 (+ amendment
A2, A6); plan `docs/plans/pos-customer-v2-phase-plan.md` §0, §5; T-437 (Customer v2 skeleton); T-426 (SC/PWD per
diner); T-137 (register); T-435 (personal-data gates); DEF-421 (`tx: Tx`); T-398 S3/S4 (same-org).
**Asked by Ian, 22 Oct; ruled 24 Oct:** keep `order.shareat.net`; read the ID on the diner's phone only, never an
outside AI service; build now, not after cutover.

## 1. Goal, and what it beats in v1
A party arrives at the gate, scans the store poster, sees the menu, checks in ("we are 5, pork and chicken"), and
gets a 4-digit booking code and a live place in line. The cashier taps that party on POS v2, checks the pre-filled
order, picks a stand, starts the session, and the phone moves into the table on its own. From the line the party can
ask for the birthday song (the cashier accepts with a time or declines; the tablet plays it then) and can claim a
senior/PWD discount by typing (or reading on the phone) the ID; the cashier still looks at the card and approves.

| v1 today (read 22-24 Oct) | T-455 |
|---|---|
| Waitlist is staff-only: cashier types name, pax, phone (`ParkWalkInModal.tsx`, Firestore `stores/{id}/waitlist`); the party has nothing in hand | The party checks itself in; staff typing drops to zero; one list for walk-ins parked by staff and lobby check-ins |
| Seating re-types pax and package from what the guest says | The start-session form is pre-filled from the check-in; the cashier confirms |
| Joining the table needs the printed PIN slip/QR after seating | The waiting phone is handed into the session automatically; the printed QR stays as the other door |
| Birthday song: cashier taps play when someone remembers (POS v1 `BirthdaySongButton`, added 17 Oct, **not in POS v2**: the copy is pinned at `e26d0c1`) | The party asks; cashier picks a time; the tablet plays it at that time; v1's manual button is ported too |
| SC/PWD: no name or ID kept anywhere (row 164); T-426 now makes the cashier type both | The party types or phone-reads them while waiting; the cashier checks the card and approves; nothing is re-typed |

Numbers we have: SC/PWD recorded in 91 days = 0, true volume unknown (PC-0, T-426). Waitlist and birthday counts were
not reachable (Firestore not queried by this spec). So the order of slices puts the cheap, certain win first (check-in
and seating) and the unproven one last (on-phone OCR, S8).

## 2. Data model

### 2.1 Which store holds it: Postgres (decided)
All five new tables live in **Postgres (`packages/db`)**, not in Firestore. Reasons: RULES #4 (Postgres is the only
system of record; no new entity may be born in Firestore); ADR-015 A2 (we are leaving Firebase in steps, so a new
collection is debt on day one); row 379 lets the **POS session** stay in Firebase until P3, and only it. Customer v2
holds no Firebase (T-437 ruling 2, kept). POS v2 reaches Postgres through its own server, which already holds
`DATABASE_URL` and maps a POS store id to an ERP store (`posV1Repo.getLinkByPosStoreId`, `apps/pos/src/server/pos2/deps.ts`).
**Consequence:** the staff-parked walk-in list moves from Firestore `stores/{id}/waitlist` to the same Postgres table
(one list, not two). Offline, the POS lobby card says "Lobby paused (offline)"; seating a walk-in directly still works.

### 2.2 Tables (migration 0215 (renumbered from 0217 on 25 Oct; 0216 is POS T-472, 0217 is T-475 S3)); every one has `org_id`, `UNIQUE (org_id, id)`, composite FKs
| Table | Columns that matter | Rules the DATABASE enforces |
|---|---|---|
| `lobby_stores` | `store_id`, `enabled`, `paused`, `max_live_entries` (default 60), `birthday_enabled`, `claims_enabled`, `pos_seen_at` | PK `(org_id, store_id)`; FK `(org_id, store_id)` -> `stores (org_id, id)` |
| `lobby_entries` | `store_id`, `source` (`lobby`/`staff`), `code` (4 digits), `display_name`, `party_size`, `note`, `phone` (staff-parked only), `status`, `device_hash`, `ip_hash`, `client_request_id`, `session_ref` (POS session id, text), `stand_label`, `handoff_url`, `handoff_expires_at`, `called_at`, `seated_at`, `closed_at`, `acted_by_person_id` | FK `(org_id, store_id)` -> stores; FK `(org_id, acted_by_person_id)` -> persons; CHECK party 1-30, name 1-40, code `^[1-9][0-9]{3}$`, phone null unless `source='staff'`; partial UNIQUE `(store_id, code)` and `(store_id, device_hash)` WHERE status IN (`waiting`,`called`); UNIQUE `(store_id, client_request_id)`; trigger: status only moves forward (below), `code/store_id/source/device_hash` frozen |
| `lobby_entry_lines` | `entry_id`, `variant_id`, `option_value_ids uuid[]`, `qty`, `line_kind` (`package`/`a_la_carte`) | FK `(org_id, entry_id)` -> entries; FK `(org_id, variant_id)` -> `menu_item_variants`; CHECK qty 1-20; no price column (the phone never prices) |
| `lobby_birthday_requests` | `entry_id`, `celebrant_name`, `status`, `scheduled_at`, `decline_reason`, `played_at`, `acted_by_person_id` | FK via entry (header) and persons; partial UNIQUE `(entry_id)` WHERE status <> `cancelled`; CHECK `scheduled_at` not null iff status IN (`accepted`,`played`); forward-only trigger |
| `lobby_discount_claims` | `entry_id`, `kind` (`senior`/`pwd`), `holder_name`, `id_number`, `id_last4`, `ocr_assisted`, `status`, `session_ref`, `statutory_diner_ref`, `reject_reason`, `acted_by_person_id`, `card_seen_at` | FK via entry and persons; CHECK `holder_name` and `id_number` NULL unless status = `pending`; CHECK `card_seen_at` not null iff `approved`; max claims per entry = `party_size` (trigger); forward-only trigger |

Children carry no `store_id`: their store is the header's (via-header, T-398 S4 pattern). Each table is classified
in `packages/db/src/cutover/classification.ts` (born in v2, nothing migrated, row 379) and `packages/db/src/rls/registry.ts`
(org-scoped). Lobby tables are not hot-set mirrors (no Firestore copy).

**T-479 / DEF-774:** the claims cap holds from both sides - `lobby_entries_party_size_cap` also refuses lowering `party_size` below the entry's pending + approved claims (`docs/tasks/479-lobby-party-shrink-claim-cap.md`).

### 2.3 Booking code
- **4 digits, 1000-9999, random** (not a counter), unique among the store's live entries (partial unique index);
  insert retries up to 5 times on a unique violation, then refuses "Please check in at the counter". With the
  60-entry cap a collision needs a retry about 0.6% of the time.
- **The code is a counter-side label, never a key.** No diner endpoint takes a code; the diner's phone is identified
  by a 256-bit random secret in an httpOnly, Secure, SameSite=Lax cookie (`lobby_dev`); the server stores only
  `device_hash = HMAC(LOBBY_HASH_SECRET, secret)`. Guessing codes therefore reveals nothing and changes nothing.
  Only signed-in POS staff look an entry up by code.
- **Expiry:** an entry still `waiting`/`called` 3 h after check-in becomes `expired` (nightly job and on read).
- **Same phone twice:** a second check-in from the same cookie at the same store returns the live entry (v1's
  one-slot-per-device idea, `CUSTOMER/src/lib/server/customer-participants.ts`, with an HMAC instead of v1's unsalted
  16-hex SHA-256).

### 2.4 State machines (forward-only triggers; every staff move writes `audit_log`)
- **Entry:** `waiting -> called -> seated`; `waiting|called -> cancelled` (diner) `| removed` (staff) `| expired`.
  `seated` needs `session_ref` and `stand_label`. Terminal states never change.
- **Birthday:** `requested -> accepted(scheduled_at) -> played`; `requested -> declined`; `requested|accepted ->
  cancelled` (diner, before play) `| expired` (accepted and not played 30 min after `scheduled_at`, or requested and
  not answered when the entry closes unseated).
- **Discount claim:** `pending -> approved | rejected | expired`. Approval needs a seated entry, `session_ref`, the
  T-426 diner id, and `card_seen_at`. On leaving `pending`, `holder_name` and `id_number` are set to NULL in the
  same statement (CHECK above); `id_last4`, kind, outcome, who and when stay: that is "the app documents it".

### 2.5 Pre-order lines (rows 358, 383)
The lobby menu is the ERP v2 menu for that store, `projectStoreMenu(snapshot, storeId, now)` (`packages/domain/src/menu/project.ts`),
channel `store`: packages, their option values (flavours: "pork and chicken"), and à la carte. One line per choice;
package qty = party size by default. Phone prices are labelled "estimate; the cashier confirms". At seating POS v2,
which in P0 sells from v1's Firestore menu (row 378), converts each `variant_id` to the store's POS key through
`menu_pos_v1_links`; a line with no link is shown to the cashier as plain text to tap in by hand, never dropped.

### 2.6 Device hand-off into the session (the v1 participant idea, reused)
Until P3 the table session lives in Firebase and the in-session diner app is Customer v1 (`customer.shareat.net`),
whose `exchange-qr` claims a participant slot keyed by the hashed device id. So the hand-off reuses the printed QR's
own door: when the cashier starts the session from an entry, POS v2 fetches the session's join URL exactly as it does
to print the PIN slip (`apps/pos/src/app/print/session-pin/page.tsx` -> `/api/pins/join-url`) and sends it with the
seat call. The waiting phone's next poll gets `handoff_url` once and does `location.replace(url)`; v1 claims the slot
(seat limit applies). `handoff_url` is a bearer link: returned only to the cookie that owns the entry, never logged,
cleared on first read or at `handoff_expires_at` (the token's own 2 h). At P3 only the target changes (Customer v2
`/join`), and `device_hash` becomes the v2 participant key.

### 2.7 Code rules every slice obeys
Every domain function takes `tx: Tx` (never `Tx | null`, DEF-421) and runs under `withOrgPrincipal(orgId)`; SQL only in
`packages/db/src/repo/lobby.ts`. Both servers are single-organisation like POS v2 (`LOBBY_ORG_ID`, `POS_ORG_ID`): no
cross-org lookup, so no new auth-door lookup (row 382 pattern not needed). Money: none stored. Times: `timestamptz`,
shown in Manila.

## 3. Flows and screens

### 3.1 Customer app (order.shareat.net, web first; the APK is not needed at the gate)
| Route | Screen |
|---|---|
| `/lobby?s=LIPA` (store code from the gate poster) | Store name, "N parties waiting". Menu by category (package cards with flavour chips, à la carte list). If the store is paused, disabled, or POS unseen > 5 min: "Please check in at the counter" and the menu only |
| `/lobby/check-in` | Name to call (1-40 chars), party size stepper (1-30), package + flavours, à la carte (+/-), optional note (60 chars). No phone, no email (data minimisation). One button "Join the line" |
| `/lobby/wait` | Big code `4821`, "3 parties ahead of you", your order summary, Cancel. Notices on the page: "Please come to the counter" (called), then the hand-off. Buttons: "Request birthday song", "Senior / PWD discount" |
| `/lobby/birthday` | Celebrant's first name (optional), Send. Then the status: waiting for the cashier / "Accepted for 7:30 PM" / "Sorry, not tonight: (reason)" |
| `/lobby/discount` | Kind (Senior / PWD), name as on the card, ID number, "Scan my ID" (S8 only), Send. Note: "Show your card to the cashier. The discount is added only after the cashier checks it." Lists claims with status, ID shown as `****1187` |

**Live position** is a poll of `GET /api/lobby/me` every 10 s while the page is visible (paused when hidden). Ruling:
a poll here, not a stream, because Customer v2 holds no Firestore and 60 waiting phones = 6 requests/s on a
one-row-per-call query; a Postgres LISTEN stream is P3 work.

**On-device OCR (S8, tesseract.js):** Apache-2.0. Lazy-loaded only on "Scan my ID"; worker, wasm core and English
data are **self-hosted under order.shareat.net** (no CDN at run time), first download measured in S8 (expected a few
MB to ~15 MB; the budget is 15 MB, else use the "fast" data). Runs in a web worker, works offline once cached. The
photo is decoded in memory, read, and discarded; nothing but the typed fields leaves the phone (Q1). The read text
fills the form; the diner corrects it; `ocr_assisted = true` is sent.

### 3.2 POS v2 (apps/pos: the POS session's area)
- **Lobby card** replaces `WaitlistCard`: rows "4821 · Ana · 5 pax · Pork+Chicken · 12 min" with badges (birthday,
  SC/PWD claim). Search by code on the on-screen number pad (row 371: tap and keypad, no free typing). "Add walk-in"
  (v1's Park, now a `source='staff'` entry; phone optional). Row actions: Call, Seat, Remove. A "Pause lobby" toggle.
  The card's 10 s poll also stamps `pos_seen_at`.
- **Seat:** opens the existing start-session form through today's `pendingSeat` hand-off
  (`session-list-view.tsx`, `start-session-form.tsx`), pre-filled with pax, package, flavours, à la carte (mapped,
  2.5), name in notes. Cashier taps a free stand (row 371), confirms, starts. On success POS calls `lobby/seat`
  `{entryId, sessionId, standLabel, joinUrl}`. If that call fails the session still stands; the row shows "Retry
  link" and the printed QR still works.
- **Birthday prompt:** a banner "Birthday song request: Ana, stand 7". Accept opens a time picker (Now, +15, +30, +45,
  +60 min, or a time today); Decline takes one of three preset reasons. At the time the tablet shows a full-screen
  "Birthday song for stand 7" with a 10-s countdown, then plays (Stop and Snooze 5 min). Accepted songs are kept on the
  tablet, so they still play offline. If the app was closed at the time, it asks on next open within 30 min. Uses the
  ported v1 player (`POS/src/lib/birthday/player.ts`, `android/.../BirthdaySongPlugin.java`, `public/sounds/*.mp3`) and
  v1's manual button.
- **Discount claim approval:** on a seated party's bill, "Senior/PWD claims (1)" opens T-426's add-diner dialog
  pre-filled (kind, name, ID; "read by phone, check against the card" when OCR-assisted). The cashier must tick "I have
  seen the card" to save. Save = T-426's own `mutateStatutoryDiners` (the session's `statutoryDiners`, the one record that
  becomes the receipt and, at P2, `statutory_discount_records`), then `lobby/claims/approve`. Reject needs a reason.
  T-426's duplicate-ID refusal stops a double add on retry.

### 3.3 ERP
Nothing in this task. `lobby_stores` rows are seeded by the runbook (S9). A lobby report is out of scope.

## 4. Security and privacy
1. **Diner endpoints are unauthenticated by design**, so limits are server-side and tested: one live entry per cookie
   per store; 5 check-ins per hour per `ip_hash` per store; store cap `max_live_entries`; refuse when paused, disabled
   or POS unseen > 5 min; party size, name, note, line count (<= 20) and qty bounds; request body <= 16 KB; at most
   `party_size` claims and 1 birthday request per entry. A refusal is one plain sentence and never says which limit.
2. **No enumeration:** codes are never inputs to diner endpoints (2.3); entry, claim and request ids are uuidv7 but
   only reachable through the owning cookie; POS lookups need a signed-in staffer of that store (`identity.ts`).
3. **No personal data in URLs or logs:** URLs carry only the store code. Bodies carry names and IDs. Route logs carry
   status, route and entry id only; a test feeds a known name and ID number through every route and asserts neither
   appears in captured log output. `ip_hash` is an HMAC, never the raw address.
4. **Photo handling (S8):** no upload path exists. A guard test asserts the lobby discount module contains no
   `FormData`, `Blob` upload, `toDataURL` sent over the network, or file-broker call, and the server rejects any claim
   field over 40 chars (so an image cannot ride in a text field).
5. **OCR is never trusted:** the server stores it as a pending claim only; the discount exists only after a staffer
   saves it through T-426 with "card seen". The server refuses approval for an unseated entry, another store's
   session, or a claim not `pending`.
6. **Who can see a claim (row 353, T-435):** POS staff of that store only, through the pos2 route; the list shows
   `****last4`; the full name and ID are returned only by "Open claim", which writes an `audit_log` row (view). Every
   approve, reject, call, seat, remove, accept, decline and play is an `audit_log` row with the tablet's person. A
   test proves a staffer of another store, and an unsigned caller, see nothing.
7. **Retention:** a pending claim's name and ID go on approval, rejection or expiry (DB CHECK). A nightly job (04:00
   Manila, existing scheduler) sets `display_name`, `phone`, `note`, `celebrant_name`, `device_hash`, `ip_hash`,
   `handoff_url` to NULL on entries closed more than 24 h; counts, times and outcomes stay. The repo is public
   (row 380): **no real card photo or real ID number is ever committed**; S8's accuracy set stays on Ian's machine.

## 5. Slices (build order). Tester first in every slice: tests red for the right reason, then build, then audit
**Areas:** [O] = orchestrator's (`packages/**`, `apps/customer/**`); [P] = POS session's (`apps/pos/**`), coordinate
merges with the Lipa soak (risk R1).

| Slice | Area | What | Tests (tester writes) and the mutants they kill | Parallel with |
|---|---|---|---|---|
| **S1** schema | [O] | migration 0215 (renumbered from 0217 on 25 Oct; 0216 is POS T-472, 0217 is T-475 S3), `packages/db/schema/lobby.ts`, index export, classification + RLS registry rows, repo `packages/db/src/repo/lobby.ts` | `packages/db/tests/integration/t455-s1-lobby-schema.test.ts`: cross-org parent refused on every FK (kills a plain FK instead of composite); backward status move refused, terminal frozen (kills missing trigger); two live entries same code / same device refused, a closed one frees the code (kills full instead of partial unique); a claim leaving `pending` with name kept refused; `party_size+1`th claim refused; phone on a lobby entry refused. Census tests (`t398-s1-same-org-fk-census`, `rls-registry`, `cutover-classification`) stay green | S4 |
| **S2** domain | [O] | `packages/domain/src/lobby/{checkin,staff,purge}.ts`: check-in (code retry, idempotent cookie, limits, staleness), position, cancel, list/call/seat/remove/park, expiry, nightly purge | `packages/domain/tests/integration/t455-s2-lobby.test.ts`: 6th check-in per ip-hour refused; 61st live refused; paused/stale refused; same cookie returns same entry and code; forced code collision retries and succeeds; position counts only earlier `waiting|called` of the same store; seat without session refused; handoff URL returned once then null; purge nulls every listed column and keeps counts; every function's signature requires `tx` (type test) | S4 |
| **S3** customer server | [O] | `apps/customer/src/app/api/lobby/**`, `src/server/**` (cookie, limits glue, log redaction), `src/data/http-lobby-data.ts`; `scripts/build-cap.mjs` stashes `api`/`server` like POS; amend T-437's guard test: server code may import `@shareat/db|domain`, client code may not; `fetch` only in `src/data/http-*`; still no Firebase | `apps/customer/src/server/__tests__/lobby-routes.test.ts`: no cookie -> 401 on `/me`; another cookie cannot read or cancel an entry; body > 16 KB refused; log capture holds no name/ID; `Set-Cookie` is httpOnly+Secure+SameSite; guard detectors each flag a hand-made bad sample | after S2 |
| **S4** lobby screens | [O] | `apps/customer/src/app/lobby/**`, `LobbyData` interface + fixture (screens built against the fixture first) | unit: check-in form bounds; position text; called notice; hand-off calls `location.replace` exactly once; disabled-store screen shows no form; no price sent in the payload. Smoke at phone width on 9010 | S1-S3 |
| **S5** POS lobby card + seating | [P] | `apps/pos/src/app/api/pos2/lobby/**`, `src/server/pos2/lobby.ts`, new `LobbyCard` replacing `WaitlistCard` + `ParkWalkInModal` writes, seat hand-off in `session-list-view.tsx`, variant -> POS key mapping | route tests: unsigned 401, other store 403, seat for another store's entry refused; mapping: unlinked line kept as text (kills silent drop); seat-call failure leaves session and shows retry; keypad search finds by code; staff walk-in lands in Postgres, not Firestore (kills a leftover `addDoc`) | after S2 |
| **S6a** birthday, server + phone | [O] | `packages/domain/src/lobby/birthday.ts`, customer route + `/lobby/birthday` | second request refused; accept without time refused; decline sets reason; cancel after play refused; accepted-not-played 30 min -> expired | S5 |
| **S6b** birthday, POS | [P] | prompt, time picker, scheduler on the tablet, port v1 player + plugin + mp3s + manual button | fake clock: plays at the time, not before; countdown Stop cancels; offline accepted request still plays; app reopened after 30 min does not play; port parity with v1 `player.test.ts` | after S6a |
| **S7a** claims, server + phone (typed) | [O] | `packages/domain/src/lobby/claims.ts`, customer route + `/lobby/discount` | claim > party size refused; approve unseated refused; approve without `cardSeen` refused; name/ID null after approve, reject, expire; full view writes audit row; other-store staff gets 403 | S6b |
| **S7b** claims, POS | [P] | claims badge, pre-filled T-426 dialog, "card seen" tick, approve/reject calls | save writes `statutoryDiners` once even on a retried approve (T-426 dup refusal); untick blocks save; list shows only last 4 | after S7a |
| **S8** on-phone OCR | [O] | spike first: tesseract.js at an exact version, self-hosted assets, accuracy on >= 20 real OSCA/PWD cards (kept off the repo), size and time on a low-end phone; then `src/lib/id-ocr/**` | guard: no upload path (4.4); worker lazy-loaded (main bundle unchanged in size budget test); parser fixtures are **synthetic** cards only; OCR failure falls back to the typed form | after S7a; drop if the spike misses (2/3 of fields right on 80% of cards) |
| **S9** ops | [O] | Customer server as the third service on 159.223.46.224 (built in CI, never on the droplet, DEF-238), nginx for order.shareat.net, secrets `LOBBY_HASH_SECRET`/`LOBBY_ORG_ID`, nightly purge, `lobby_stores` seed for Lipa, runbook; measure memory after start (plan R6) | runbook dry-run on the emulator profile; memory figure recorded | last |
| **A** audit | Sonnet | diff vs this spec; each acceptance case with real output; looks for a code used as a key, PII in logs/URLs, an upload path, a price from the phone, a second statutory copy | FINDINGS <= 30 lines | end |

Workers never run git; LF only; ports 9009 (POS) and 9010 (Customer) only.

## 6. Out of scope (and why)
- **SMS or push "your table is ready"**: row 280 / A6 (no push; on-page notices only). The called notice is on-page.
- **Joining the line from home, online reservations or deposits**: A6 (no reservations in the first release); the
  lobby is for people at the gate. Nothing stops a remote check-in, so the cap and 3 h expiry limit the harm.
- **Paying or splitting in the app**: A6.
- **Customer v2 in-session screens on real data**: P3 (row 269, plan §5); the hand-off goes to Customer v1 until then.
- **Wait-time estimates (ETA)**: no turnover data yet; the position count is honest, a minute estimate would not be.
- **Reading IDs on our server or any outside service**: Ian, 24 Oct (rows 251, 330, 353).
- **Lobby reports in the ERP, Padre Garcia (second org)**: single-org server like POS v2; later task when needed.
- **Loyalty sign-in in the lobby**: Customer v2 account work is P3.

## 7. Questions for Ian (plain words; recommended answer first)
1. **Do we keep a photo of the senior/PWD card?** (a) **Recommended: no.** The photo never leaves the guest's phone;
   we keep the name and ID number on the receipt record (as the law asks), and the lobby keeps only the last 4 digits,
   who approved, and when. Safest under the privacy law, nothing to leak. (b) Keep the photo in the file store,
   viewable by managers only, deleted after N days: stronger proof, but we would hold ID pictures of customers.
2. **After the cashier starts the table, the phone jumps to today's customer app (customer.shareat.net) until spring.**
   (a) **Recommended: yes.** Tables still live in the old system until P3; the guest sees the menu and bill there as now.
   (b) Build the new app's table screens now: about 3-4 more weeks of work in the December crunch.
3. **When do we switch the lobby on at Lipa?** (a) **Recommended: Mon 11 Jan 2027**, after the holiday no-change
   window and the ERP cutover; the build finishes by mid-December. (b) Mid-December, during peak season, on a POS
   that went live a week earlier.

**Ian-only actions:** the DNS record for `order.shareat.net` (to the production host); print the gate poster QR
(we supply the link); for S8, 20 real cards photographed on his own phone (never sent to us as files in the repo).

## 8. Risks to 1 January
| # | Risk | Plan |
|---|---|---|
| R1 | [P] slices land during the Lipa soak (23-29 Nov) and go-live (7 Dec) and change the tested build | S5/S6b/S7b merge before 20 Nov or after 14 Dec; never between |
| R2 | ERP menu for Lipa and its `menu_pos_v1_links` not complete (target 18 Dec) | Unmapped lines show as text; the lobby works with no pre-order at all (party size only) |
| R3 | A third Node service on the 4 GB host | Measure after start (S9); fallback: serve the lobby API from the POS v2 server behind its own route prefix |
| R4 | Hand-off depends on Customer v1 and POS v1's `join-url` staying up | They are live today; failure leaves the printed QR, which always works |
| R5 | OCR accuracy on Philippine cards unknown | S8 is last and droppable; typed claims (S7) carry the feature |
| R6 | Pranks fill the line from outside | Cap 60, 5 per hour per network, 3 h expiry, staff Remove, Pause toggle |
| R7 | Lobby needs the POS online; outages pause it | Lobby says "check in at the counter"; staff seat walk-ins as today |

## Ian's answers (2026-10-24)
Binding over Q1-Q3 above. Ian: "build now". Where this section and the text above differ, this section wins.
1. **No photo of the senior/PWD card is kept.** The photo never leaves the phone. The receipt record holds the name and ID
   number (as the law asks). The lobby keeps only the last 4 digits, who approved, and when.
2. **Yes: until spring, the phone hands off to today's customer app (customer.shareat.net)** after seating. No new in-session
   screens are built now.
3. **Switch on at Lipa as soon as it is built and tested.** Not 11 Jan 2027. Build now. The no-POS-merges window
   (20 Nov-14 Dec, R1) still applies unless Ian says otherwise: [P] merges land before 20 Nov or after 14 Dec, never between.
- **Migration number:** 0215 (renumbered from 0217 on 25 Oct; 0216 is POS T-472, 0217 is T-475 S3). Every earlier "0216"/"0217" for this task now reads 0215 (25 Oct, so it lands first under rule 4c).

## S1 audit notes (2026-10-24)
Carried forward from the S1 audit; none blocks S1.
- **S2 must expire pending discount claims** when their entry closes (cancelled / removed / expired / seated-and-gone), and the nightly job must sweep stale pending claims (name and ID are NULLed on expiry by the DB CHECK). Both need tests in `t455-s2-lobby.test.ts`.
- **Cutover purge order:** delete `lobby_entry_line_options`, then `lobby_entry_lines`, `lobby_birthday_requests`, `lobby_discount_claims`, then `lobby_entries` (all FKs are `restrict`).
- **Before S9 decide a dedicated lobby DB role** with grants only on `lobby_*` plus read on the menu tables. The diner path must not run as `shareat_app`, which reaches the whole organisation.

## S2 rulings (orchestrator, 2026-10-25) — answers to the S2 tester's questions

1. **Hashes:** the S3 server glue computes the HMACs; the domain takes `deviceHash` and `ipHash` and never sees a raw IP or cookie.
2. **Refusals:** one class `LobbyRefusal` with machine codes `LOBBY_*`. The diner-facing sentence is the SAME for every limit
   (§4.1: never say which limit); the code is for tests and logs only.
3. **Code retry:** exactly **5 attempts in total** (first try + 4 retries). Tests pin exactly 5 generator calls, not "5 or 6".
4. **`parkWalkIn` (staff):** ignores the customer limits (ip-hour, paused, stale POS) AND the 60-live cap — staff are standing
   in front of the guest. It still obeys the DB rules (one live entry per code, party-size cap). Test the cap bypass.
5. **Hand-off expiry:** the domain sets it to seat time + 2 hours.
6. **Returning cookie:** a cookie with a live entry is answered (same entry, same code) BEFORE the ip and cap checks.
7. **Stale pending claim (nightly sweep):** any claim still `pending` whose entry is closed (any age), or whose own
   `created_at` is more than 24 hours old. Expiry NULLs name + ID per the DB CHECK.
8. **`closed_at` on seat:** yes, seat sets `closed_at` (the 24 h purge depends on it). ⛔ If 0215's trigger refuses that,
   the builder STOPS and reports: 0215 is unmerged, so the orchestrator fixes it in S1, never S2.
9. **Helpers:** pure helpers stay unexported from `lobby/*`; only the actions the screens call are exported.
10. **`clientRequestId` replay:** add a test — the same `clientRequestId` returns the same entry and creates no second row.

Spec defects acknowledged:
- `packages/db/src/repo/lobby.ts` (promised in S1) does not exist. **S2's builder writes it**: all lobby SQL lives there
  (SQL only in `packages/db/src/repo/`), the domain calls it.
- §4.1 vs per-limit tests: resolved by ruling 2.
- Expiry lives in `packages/domain/src/lobby/purge.ts` with the nightly purge.

## S2 audit notes (2026-10-25), carried to S3
- **S3 must require a uuid-shaped `clientRequestId`** (the domain accepts any 1-64 chars). A guessable id could be
  pre-claimed by another device, which then makes the real diner's retry answer `LOBBY_BAD_INPUT`.
- Staff lobby functions authorize `record_sale` at the entry's own store (orchestrator ruling, 25 Oct). A store-A cashier
  probing a store-B entry id gets AuthorizationError while a ghost id gets LOBBY_NOT_FOUND: accepted (signed-in staff
  only, unguessable uuidv7 ids, the attempt writes a denial row).
- `packages/db/src/audit/catalogue.ts` is at its 195-entry cap after S2's four lobby actions: S6/S7 must raise it.
- `runLobbyNightly(tx, orgId)` has no org loop yet; S9 adds the scheduler entry and the systemTransaction org list (DEF-742).

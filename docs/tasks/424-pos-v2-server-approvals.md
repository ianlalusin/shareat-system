# T-424: POS v2 server — manager-PIN approvals, refunds, tender corrections, server-gated void (P0, PC-4 part 2)

**Status:** spec written 2026-10-16 (Opus planner, POS v2 lane, plan mode); revised the same day after the Opus spec
review (B1, B2, M1-M6 and minors folded in, marked ✎R). Re-review before build.
**Model:** Sonnet tester -> Sonnet builder -> Sonnet auditor; S5 (auth) is an auth lane: Sonnet, its own test DB
copied with `CREATE DATABASE … TEMPLATE shareat_test_t416`.
**Migration:** ✎R ONE, for the terminal link table (Ruling 5); number asked from the orchestrator before writing it
(next free 0201). It also carries the capability grant if grants are data.
**Authority:** **Ian 16 Oct (this lane): money actions go through a small POS v2 server; managers approve with their
ERP v2 PIN.** · ADR-015 A3, A4.2, A5.1 · bible rows 272, 307, 319, 343, 348, 350 · RULES #7 (no client-only
authorization) · DEF-588, 590, 651, 652 · T-412/T-416 (approval PIN pattern and miss cap) · T-417 B5 (service unit).
**Depends on:** T-423 (terminal series, centavo module).

## Goal, in plain words
Refunds, wrong-tender fixes and voiding an unpaid table are checked by our own server, not by the tablet. A manager
approves with the same PIN they use in ERP v2, with the same limit of 5 wrong tries a day. The old POS and the ERP
keep reading the same numbers they read today.

## Constraints carried from T-423 and the research
- **Wire format unchanged** (T-423 "Hard constraint"). In particular a refund keeps v1's shape (positive-qty line
  clones, negative `total`, `isRefund`, `parentReceiptId`, NO `analytics.mop`), because the ERP derives refunds as
  `X = Σ byMethod − totalSales` (`packages/domain/src/pos/v1-derive.ts`). The refund TENDER is recorded in a new field
  and is NOT fed into `byMethod`.
- **Firestore rules are v1's** and stay loose (DEF-652). ✎R **What this task protects, stated honestly:** it gates
  the v2 tablet's own refund, correction and void actions on the server with a manager PIN. It does NOT close v1's
  open doors while v1 is live: v1's `/api/analytics/payment-conversion` lets any cashier create or void a conversion
  without a PIN; `voidPaymentConversionServer` trusts client-writable doc fields; a refund receipt forged in Firestore
  plus a call to v1's `apply-delta 'refund'` lowers `totalGross`; the parent's `refundedQtys` is client-writable. Those
  close when v1 retires (P2). Ruling 11 adds a read-only detector so forged or unapproved records are seen, not
  silently trusted.
- v1's analytics builder logic (DEF-589) is kept as it is: ✎R the v2 server runs a PORT of it (Ruling 6), so the
  same totals come out whether v1's server or ours applied them.

## Rulings (planner)
1. **Where the server lives.** `apps/pos/src/app/api/pos2/**` route handlers + `apps/pos/src/server/**` helpers,
   served by `next start` (server build) as `shareat-pos.service` on 159.223.46.224 behind `https://pos2.shareat.net`.
   `scripts/build-cap.mjs` stashes `src/app/api` and `src/middleware.ts` during the static export (v1's
   `build-capacitor.mjs` pattern). `src/middleware.ts`: CORS for origin `https://localhost` only (the APK), matcher
   `/api/:path*`. The APK reads a second base `NEXT_PUBLIC_POS2_API_BASE` (default `https://pos2.shareat.net`) for
   `/api/pos2/*` only; all other `/api/*` calls keep `NEXT_PUBLIC_API_BASE` (app.shareat.net) via the existing
   `installApiBaseFetch` (extend it: `/api/pos2/` prefix -> POS2 base).
2. **Server-only code boundary.** `firebase-admin`, `@shareat/db`, `@shareat/auth`, `@shareat/domain` may be imported
   only under `src/app/api/**` and `src/server/**`; `src/server/**` starts with `import 'server-only'`. T-422's guard
   (Acceptance 2, closure guard) is narrowed to client paths and a new guard proves no client file imports those.
3. **Caller identity.** Every route: `Authorization: Bearer <Firebase ID token>` verified with the Admin SDK for
   project `shareat-hub-v2`; then `staff/{uid}` must be `status == 'active'` with the store in `assignedStoreIds`
   (port of v1 `lib/server/staff-access.ts`, read via `git show e26d0c1:`). Request bodies carry no trusted role.
4. **Credentials (never committed).** `POS_FIREBASE_SA_KEY_FILE` (a service-account file with Firestore write on the
   target Firebase project) and `DATABASE_URL`, read through `@shareat/core/env`-style validation; missing -> the route
   answers 503 "POS server is not configured", never a crash. The default target is a TEST Firebase project until Ian
   says otherwise (Ian step 1).
5. **Manager approval = ERP PIN.** New `verifyPosManagerApproval(tx, {orgId, erpStoreId, pin, terminalPersonId})` in
   `packages/auth/src/pos-approval.ts`, modelled line for line on `verifyAdminApproval` (`admin-approval.ts`):
   one refusal sentence for every failure, full-cost path, the PIN owner must be allowed to sign in, must not be a
   terminal, and must be an active admin OR hold the NEW capability `approve_pos_correction` at `erpStoreId`. Misses
   charge the **terminal person's own bucket** `{ actor: terminalPersonId }` (no new bucket kind) with T-416's cap
   (5 / 24 h); never the store's sign-in budget. Each POS v2 tablet is therefore registered as an ERP terminal person
   (the existing terminal provisioning, `npm run provision-terminal`); the server maps `(storeId, deviceId)` from the
   T-423 terminal claim to that person through the Postgres link below (✎R B1). Firestore store -> ERP store through `pos_v1_store_links`.
   CAPABILITY-MATRIX: add `approve_pos_correction` (default: store manager positions; admins implicitly).
   ✎R **B1 fix: the terminal link lives in Postgres, never in Firestore.** New table `pos_terminal_links` (org_id,
   store_id -> ERP store, pos_v1_store_link_id, terminal_no, device_id uuid, terminal_person_id, revoked_at), written
   ONLY by the provisioning step (admin capability, audited), never by a tablet or a request. The server picks the
   bucket from the link row matching the caller's store (via a LIVE `pos_v1_store_links` row) and the request's
   `deviceId`; it checks the person is a terminal (`personIsTerminal`) of that ERP store; with ADR A3's one tablet per
   store, a store has exactly one active link. `deviceId` is validated as a uuid before any insert
   (`pin-attempts.ts:135` would 500 on bad input). The claim doc's fields are display only. A forged claim doc or a
   forged `deviceId` from another store can change neither the store nor the bucket charged. The terminal's cap
   message names the store manager as who can clear it (a terminal person has no user page): the T-416 clear action
   is reachable from the ERP terminal's page.
6. **Refund** `POST /api/pos2/refunds` `{storeId, parentReceiptId, lines:[{lineId, qty}], tenderMethodId, reason,
   terminalNo, terminalSeq, receiptNumber, pin}`. One Admin-SDK transaction: re-read the parent (`status: 'final'`,
   not a refund, same store); refuse any line qty above `qtyOrdered − freeQty − voidedQty − refundedQtys[lineId]`
   (no over-refund, DEF-001's twin) ✎R where `refundedQtys` is COUNTED from the existing refund receipts of that
   parent (query by `parentReceiptId`), never read from the client-writable counters on the parent; ✎R **idempotent:**
   the request is keyed on `receiptNumber`: if its `receiptNumbers` doc already points at a refund of the same parent
   with the same body hash, return that refund (a timed-out retry never pays twice); a different body on the same
   number is refused; ✎R2 the body hash leaves out `pin` (a manager retyping the PIN must not turn a safe retry into
   a refusal); ✎R **amount (M2):** the refund of each unit is its share of what the customer actually PAID:
   `allocate(receipt total in centavos, by line net)` gives every line its paid amount (VAT added on top at VAT-exclusive
   stores, the senior/PWD VAT removal and 20%, discounts, loyalty and charges are all inside `total`), units take equal
   shares with the last unit of a line taking the remainder, and all refunds of one receipt can never exceed `total`
   (DEF-590); write the refund in v1's shape + `refundTender {methodId, methodName}`
   (DEF-588) + `refundTotalCentavos` + `approvedByPersonId`; update the parent's `refundedQtys`, `totalRefunded`,
   `refundCount` as v1 does (kept for v1's screens; not trusted by this route). Always a manager PIN.
   ✎R **Cash refunds only (M3)** until the ERP day feed (T-375) reads `refundTender`: the ERP derives every refund as
   cash (`v1-derive.ts:184-195`), so a GCash refund would book cash short and GCash over. The tender picker shows cash
   only with the sentence "E-wallet refunds come later; refund in cash for now." Lifting it is an orchestrator task on
   the ERP side (named in the report). ✎R **Analytics (M5):** the server applies the refund's analytics in the same
   transaction with a port of v1's `applyAnalyticsDeltaServer` (read via `git show e26d0c1:`), sets
   `analyticsApplied: true` and a server-clock `createdAtClientMs`; the tablet no longer calls v1's `apply-delta` for
   refunds. The APK's Firebase project and the server's must be the same (checked at start-up: the server refuses a
   token from another project).
7. **Tender correction** `POST /api/pos2/tender-corrections` `{storeId, receiptId, fromMethod, toMethod, amount,
   reference, reason, pin, requestId}`. ✎R `requestId` (uuid) is the correction doc's id: a retry returns the same doc
   (B2); ✎R2 a retry with the same `requestId` but a different body is refused. Refuse unless: receipt `final` and not a refund; `amount` (centavos, > 0) ≤ the receipt's
   `analytics.mop[fromMethod]` ✎R MINUS the sum of this receipt's active `pos2-correction` docs already moving money
   out of `fromMethod` (plus any moved into it), read inside the same transaction, so stacked corrections can never
   drive a method negative (`v1-methods.ts:85` would refuse the day); `toMethod` is an active `storeModesOfPayment` with a different name; a reference when
   `toMethod.hasRef`; **an ERP till shift for that store is open (`openShiftFor`) and its `openedAt` ≤ the receipt's
   `createdAtClientMs`** (A5.1, row 319; ✎R the sale's own clock, so an offline receipt synced after the shift opened
   but rung before it is refused). Write ONE `stores/{s}/paymentConversions/{id}` document in v1's exact shape (so v1's
   dashboard and summary keep working) plus `receiptId`, `reference`, `requestedBy {uid, name}`,
   `approvedByPersonId`, `source: 'pos2-correction'`, ✎R and `dayId`/`dayStartMs` = the RECEIPT's day from its
   `createdAtClientMs` (v1's create path uses "now"; using the receipt's day keeps a later v1 void reversing the right
   day); in the same transaction move `payments.byMethod` on the receipt's day / month / year docs and every applicable `dashPresets` doc exactly as v1's
   `applyPaymentConversionServer` (port it; `safeKey` mapping included): `−amount` on from, `+amount` on to,
   `totalGross` and `txCount` untouched. The receipt document is never written (row 272). After the shift closes the
   tablet shows "Shift closed: refund and ring again" instead of the button.
8. **Unpaid-session void** `POST /api/pos2/session-voids` `{storeId, sessionId, reason, pin?}`: allowed for a caller
   whose staff role is manager/admin, or with a manager PIN; runs T-423's transactional `voidSession` logic with the
   Admin SDK. The offline void stays on the tablet (PC-5).
9. **UI** (plain, restyled after Ian approves the PC-7 mock-up): receipts page "Refund" dialog gains a tender picker and
   a PIN pad and calls the route; "Mark wrong tender" on a paid receipt (from-method, to-method, amount defaulting to
   the full from-amount, reference, reason, PIN pad); the void-session dialog calls the route. The disabled "Void —
   coming in the safe flow" button from T-422 is replaced by Refund (a paid receipt is never voided, row 272).
10a. ✎R **Port of v1's analytics delta for sales (M5).** The test Firebase project has no v1 server or reconcile cron,
    so the v2 server also serves `/api/pos2/analytics/apply-delta` (port of v1's route, same idempotency flags).
    ✎R2 **It is used only where proven:** the APK sends sale and void deltas there only when built with
    `NEXT_PUBLIC_POS2_ANALYTICS=1` (test-project builds); production builds keep calling v1's `apply-delta` until a
    parity test passes AND the orchestrator flips it. Slice **S10** owns the port and its parity test: the vendored
    real v1 delta code (as fixtures, read via `git show e26d0c1:`) and the port produce byte-identical day / month /
    year / preset deltas for payment, void and refund receipts over a fixture corpus including offline, discounted,
    VAT-exempt and refunded receipts. Loyalty, PINs and online orders keep using v1's server and do not
    work on the test project; the soak plan says so.
11. ✎R **Detector (M4).** `apps/pos/scripts/pos2-audit.mjs` (read-only, run by a person): lists, per v2 store and day,
    refund receipts without `approvedByPersonId` or without a `receiptNumbers` doc, and `paymentConversions` without
    `source: 'pos2-correction'`, ✎R2 and `pos2-correction` docs that v1 has since voided. Output is counts and receipt
    numbers only.
12. **Ops is not this lane's.** The lane writes `docs/ops/pos2-runbook.md` (DNS, Caddy route, env file, unit install,
    first start, memory check) and a `deploy.yml` change PROPOSAL in the task report; the orchestrator applies deploy
    and ops. Never build on, or connect to, a droplet.

## Slices
**T** tester first (red for the right reason): route tests with an injected Firestore port (in-memory fake, no live
project); `packages/auth` integration tests for `verifyPosManagerApproval` on its own test DB; tree guards for the
server boundary; an ERP-feed contract test that runs `v1-methods`/`v1-derive` on the day doc a refund and a correction
produce. **S4** skeleton + caller identity + config 503 + CORS + build-cap stash. **S5** ✎R2 approval function, capability `approve_pos_correction` and matrix row, AND the terminal link:
the migration (number from the orchestrator) creating `pos_terminal_links` with its `classification.ts` and
`rls/registry.ts` entries; the writer `provisionPosTerminalLink(tx, actor, {...})` in `packages/domain`, gated by the
EXISTING capability that provisions clock terminals (named in the report after reading `provision-terminal`), audited,
and reached from the same provisioning script; a "This tablet's device id" line with a copy button on `/settings` so
the person provisioning can record it. A reinstall makes a new device id: approvals then fail with "This tablet is not
registered for approvals yet. Ask an administrator to register it." until it is re-provisioned (the old link is
revoked by the same writer). **S6** refund. **S7** correction. **S8** void route. **S9** UI wiring + runbook. **S10** ✎R2 analytics port + parity test (Ruling 10a).

## Acceptance (each names the mutant it kills)
1. No client file imports `firebase-admin`, `@shareat/db`, `@shareat/auth`, `@shareat/domain`, or `src/server/**`;
   `build:cap` output contains no `/api/pos2` handler code. Kills: server code or keys in the APK.
2. Every route refuses: no token (401), a token for a staff doc not assigned to the store (403), an inactive staff
   doc (403); a body `role` field is ignored. Kills: client-trusted role.
3. Missing credentials -> 503 with the plain sentence. Kills: a crash loop on a misconfigured box.
4. Approval (real Postgres): a manager holding `approve_pos_correction` at the store passes; the same manager at
   another store, a cashier, a diner-only person (row 350), a terminal's own PIN, and a wrong PIN are all refused with
   the ONE sentence; the 6th wrong PIN in 24 h from one terminal is refused even when correct; another terminal at the
   same store is unaffected; a store's sign-in budget is not charged. Kills: role leak; oracle message; shared bucket.
5. Refund: ✎R a replay of the same request returns the same refund and pays nothing twice; refunding every line in
   3 partial refunds sums EXACTLY to the receipt `total` for each tax type (VAT inclusive, VAT exclusive, non-VAT,
   senior/PWD VAT-exempt); a non-cash tender is refused; a client-zeroed `refundedQtys` on the parent does not allow
   a second full refund; over-refund refused; second partial refund gets its own terminal number (DEF-001); a 10% bill discount
   refunds 90% of list (DEF-590); `refundTender` recorded (DEF-588); no `analytics.mop` on the refund; two concurrent
   refunds of the last unit -> one succeeds. Kills: list-price refund; collision; double refund.
6. ERP contract, ✎R run with v1's REAL `getPaymentContribution` / delta core vendored as fixtures (like T-423's
   `tax-v1`), not a re-implementation: for a day with sales S and one refund R, the day doc after v1's delta logic still yields
   `X = Σ byMethod − totalSales = R` in `v1-derive`; after a correction, `Σ byMethod` and `totalGross` are unchanged
   and no method goes negative (`v1-methods` accepts the day). Kills: corrections or refunds silently breaking T-375.
7. Correction: refused with no open till shift, with a shift opened after the receipt, above `mop[from]`, to an
   inactive or same method, without a reference for a reference tender; the receipt document is byte-identical before
   and after; `paymentConversions` doc has v1's fields + the new ones. Kills: editing a paid receipt (row 272);
   correcting a closed shift. ✎R A second correction of the same full amount is refused; a retry with the same
   `requestId` returns the first doc; `dayId` equals the receipt's day even when corrected after midnight.
11. ✎R2 Re-provisioning: a new device id on the same tablet is refused with the "not registered" sentence until the
    writer re-links it; the old link is revoked; only the provisioning capability can write a link. Kills: approvals
    silently working on an unregistered device.
12. ✎R2 Analytics parity (S10): port vs vendored v1 delta code byte-identical over the corpus; a production build
    without `NEXT_PUBLIC_POS2_ANALYTICS` calls v1's `apply-delta`. Kills: a drifting copy changing ERP day totals.
10. ✎R B1 mutant: a forged Firestore claim doc and a forged `deviceId` of another store change neither the store
    checked nor the bucket charged; a non-uuid `deviceId` is a 400, not a 500.
8. Void route: cashier without PIN refused; manager role or manager PIN passes; paid session refused. Kills: client-only
   void gate.
9. `npm test -w @shareat/pos`, pos tsc, `build`, `build:cap`, root unit + the new integration tests on the lane DB,
   T-422/T-423 guards: green.

## Must NOT change
Firestore field meanings (additive only) · v1 (read-only) · live `shareat-hub-v2` (no writes from tests or agents) ·
`deploy.yml` (proposal only) · droplets · `apps/erp/**` except a capability wiring the matrix requires (named in the
report).

## Ian's steps (plain words)
1. **Make a test copy of the POS Firebase project** for trying the new POS before the December soak, so nothing real
   can break. The orchestrator can walk you through it.
2. **Point pos2.shareat.net at our server** (159.223.46.224).
3. **Create a write key** for the POS Firebase project and put it on our server (you or the orchestrator, never in the
   code, never pasted into a chat).
4. **Give each store manager an ERP PIN** (the Staff page already issues one, row 348) and the new
   "approve POS corrections" permission at their store.
5. **Register each POS v2 tablet** in ERP as a terminal (one time per tablet).

## Dependencies and later work (✎R)
- **Lipa on 11 Jan:** corrections need an ERP till shift opened before the first sale; the till screen (row 319) or an
  ERP routine must exist by then. Orchestrator to schedule.
- **Offline refunds** (ADR A3: same tablet, same day, cash only, manager PIN) are PC-5.
- **E-wallet refunds:** wait for T-375 to read `refundTender` (orchestrator, ERP side).

## Open questions
1. Refunds always need a manager PIN (recommended; 7 refunds all-time) — or may a manager signed in on the tablet
   refund without typing it? Recommended: always the PIN, so the approver is recorded.

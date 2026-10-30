# T-425: POS v2 offline selling — sale ledger, server-proven sync, reachability, ₱50k warning, X-slip, soak harness (P0, PC-5)

**Status:** (checked 31 Oct against main) S1-S6 built and on main in `68b5c39` ("WIP ... NOT audited; 2 tests disputed"); later audit and dispute outcome: verify. Real two-tablet soak 23-29 Nov (docs/ops/pos2-soak.md). Original: spec written 2026-10-17 (Opus planner, POS v2 lane, plan mode); revised after the Opus spec review the
same day (3 blockers, 7 majors, minors: marked ✎R); second review: 5 fixes applied (✎R2), ready to build
**Model:** Sonnet tester -> Sonnet builder -> Sonnet auditor (money-adjacent: Sonnet, never Haiku).
**Migration:** none expected.
**Authority:** ADR-015 §5 + A3, A4.5 · bible rows 272, 276, 313, 348, 351 · DEF-002, 017, 018, 587 ·
`docs/discovery/pos-offline-and-data-tiers-proposal.md` (DECIDED) · plan §6 PC-5 · **bible row 356 (Ian 17 Oct): no refunds
offline; an unpaid-table void offline only by a signed-in manager/admin, marked and reviewed after sync.**
**Depends on:** T-423 (terminal series, money module), T-424 (POS v2 server, `pos2/client.ts`).

## Goal, in plain words
A tablet keeps selling for a day without internet, and when the internet returns every sale reaches the server exactly
once. The tablet knows for certain which sales are still unsent, warns the manager when they pass ₱50,000, prints a
cash-control slip every 4 offline hours, and stops staff from wiping unsent sales by updating or reinstalling.

## Facts verified (apps/pos at the T-424 merge)
- Firestore `persistentLocalCache` + multi-tab manager (`lib/firebase/client.ts:16-19`). `commitLocalFirst`
  (`lib/offline/commit.ts:18-31`) never awaits; failures go to `console.error`. **No** `hasPendingWrites`,
  `waitForPendingWrites` or metadata listeners anywhere: the app never learns that a write landed.
- Deferred effects: localStorage `offline_payment_queue` (`lib/offline/payment-queue.ts:3`); a parse error returns `[]`
  and the next write erases the queue (`:46-48`); no quota handling; "failed" items never shown again
  (`hooks/use-payment-queue-sync.ts:95-98`).
- Connectivity: `hooks/use-online-status.ts` = `navigator.onLine`; `OfflineBanner.tsx:6-48` keeps its own copy;
  `firestore.ts:346` reads `navigator.onLine` directly. No probe (DEF-017).
- Offline sale: `completePaymentOffline` (`offlinePayment.ts:39-251`) reserves the T-423 number, writes one batch
  (receipt with `offlineOrigin: true`, `receiptNumbers/{n}`), then queues analytics/loyalty/PIN effects.
  `voidSessionOffline` (`offlineVoid.ts`) writes `offlineOrigin: true`; no role check.
- No X-slip or sales-report formatter in the copy; `printHub` + `receiptFormatter` exist. `public/sw.js` does
  `skipWaiting()` + `clients.claim()`. No update check anywhere; APKs are sideloaded from CI artifacts.
- Already IndexedDB: the terminal counter (`lib/terminal/counter.ts`) and the proof-photo outbox.
- Test helpers: `fakeIdb.ts` (no cursors/indexes), `fakeFirestore.ts` (no offline / pending-write mode).

## Rulings (planner; ✎R = revised after the Opus spec review of 17 Oct)
1. **Sale ledger** (`apps/pos/src/lib/outbox/ledger.ts`). ✎R It lives in the SAME IndexedDB database as the T-423
   counter (`shareat-pos-terminal`, new store `events`, key `[deviceId, terminalSeq]`). ✎R2 ONE shared opener
   (`lib/terminal/db.ts`) owns the version (2) and the upgrade (creates `events`, keeps the counter row); `counter.ts`
   and the ledger both use it (today `counter.ts:58` opens version 1 hard-coded, which would throw `VersionError` after
   the upgrade and refuse every sale). Connections close on `versionchange` from another tab. The runbook says never
   install an OLDER APK over a newer one. So an offline sale RESERVES its number and APPENDS its event in ONE IndexedDB transaction
   (no skipped-but-unexplained numbers). Event: `{deviceId, storeId, terminalNo, terminalSeq, receiptId, receiptNumber,
   kind: 'sale'|'void'|'skipped', totalCentavos, linesHash, tenders: [{method, centavos, toCheck, reference}],
   createdAtClientMs, ops, status, attempts, lastError}`.
   - **Offline sale (or offline void):** event written with `status: 'unsent'` and `ops` = the COMPLETE write list of
     the batch as plain data: `[{op: 'set'|'update'|'delete', path, data, merge?}]`, covering every write the batch makes
     (payments, kitchen tickets marked served, session close, closed/active session copies, receipt, `receiptNumbers`,
     table free). ✎R Server timestamps are stored as the marker `{"__serverTimestamp__": true}` and turned back into
     `serverTimestamp()` at replay; ✎R2 likewise `{"__deleteField__": true}` and `{"__arrayRemove__": [...]}` for the
     void's `deleteField()` / `arrayRemove()` (`offlineVoid.ts:100-101`); payment doc ids are fixed BEFORE the batch (`<receiptId>-p<index>`), never random,
     so a replay writes the same docs. The batch is BUILT FROM `ops` (one code path), so the ledger copy and the real
     write cannot differ. ✎R2 The write list is built BEFORE the IndexedDB transaction; inside it, the number is
     reserved and the receipt number filled in without any `await` (IndexedDB closes a transaction at the first await).
     If the IndexedDB commit fails, the sale is refused with "This tablet could not save the sale. Do
     not continue; call the manager." and nothing is written to Firestore.
   - ✎R2 **Online sale:** the number is reserved together with a `reserved` event in ONE IndexedDB transaction; when
   the Firestore transaction succeeds the event becomes `acknowledged` (no `ops`; the server has it; it serves the
   X-slip and counts); when it fails for good it becomes `skipped` (no money). A crash in between leaves `reserved`,
   which reconcile resolves by reading the server (present -> `acknowledged`, absent -> `skipped`), so every number is
   explained.
   - Statuses: `unsent` -> `acknowledged`; `quarantined` (server copy conflicts; manager list; never overwritten);
     ✎R `rejected` (the server refused the write, e.g. a permission or validation error from the batch's `onError` or the
     replay transaction; manager list; never replayed); ✎R `stuck` after 10 failed attempts (manager list, Retry).
   - Unsent rows are never deleted; acknowledged and skipped rows are pruned after 7 days (they hold the customer name
     and lines; unsent rows are kept until sent).
2. **Reconcile = server proof** (`lib/outbox/reconcile.ts`). ✎R Runs only when ONLINE (Ruling 4) and only in the tab
   holding the Web Lock `pos-reconcile` (other tabs skip), on start-up, on going online, and every 60 s while unsent rows
   exist. Each pass:
   - `waitForPendingWrites()` with a 20 s limit. ✎R A timeout is normal, not an error: if it does not RESOLVE, the pass
     does no replay at all (Firestore's own queued write may still land and must not be raced); it only re-checks.
   - Per unsent event in `terminalSeq` order, `getDocFromServer(receipts/{receiptId})`. ✎R A thrown read is never
     "absent": the event stays unsent, `attempts` +1.
   - Present -> **compare** (✎R): `receiptNumber` first; then only fields that never change after a sale:
     `total` in centavos and `linesHash`. ✎R2 `linesHash` is computed over a STABLE form of `lines`: keys sorted,
     undefined removed (Firestore's `ignoreUndefinedProperties` drops them), amounts converted to integer centavos;
     the same function hashes the local copy and the server copy. Equal -> `acknowledged` (refunds, T-424 tender
     corrections, `analyticsApplied`, `totalRefunded` and other later fields are ignored). Different -> `quarantined`.
   - Absent (and the pending-writes wait resolved) -> **replay inside `runTransaction`** (✎R2: ALL reads and checks
     before ANY write): re-read the receipt (stop if it now exists), the session, the table, and every doc an `update`
     op targets. If the session is `closed` or `voided` -> `quarantined` ("This table was changed on another tablet."),
     nothing written. Otherwise write the receipt, payments, tickets and `receiptNumbers` from `ops`; free the table ONLY
     if `currentSessionId === sessionId`; ✎R2 an `update` op whose doc no longer exists is skipped and noted (never a
     reason to reject the sale). Only a real permission or validation refusal makes the event `rejected`. The next pass
     acknowledges by the compare rule.
   - A void event is acknowledged when the server session shows `status: 'voided'`; its replay follows the same guards.
3. **Deferred effects move to IndexedDB** (`lib/outbox/effects-store.ts`, store `effects` in the same database, same item
   shapes). On first start a non-empty localStorage `offline_payment_queue` is copied in one IndexedDB transaction, then
   the key is removed; a corrupt value is kept under `offline_payment_queue.corrupt` and reported, never dropped.
   ✎R A receipt's effects (analytics, loyalty, PIN) run only after that receipt's ledger row is `acknowledged`, so
   apply-delta never runs before the receipt exists on the server. "Failed" effects appear on a manager list with Retry.
4. **Reachability** (`hooks/useConnectivity.ts`, one shared store; `use-online-status.ts` becomes a thin wrapper;
   `OfflineBanner.tsx` and `firestore.ts:346` use it). ✎R Probe: `GET {NEXT_PUBLIC_POS2_API_BASE}/api/pos2/health`
   (new, unauthenticated, no Firestore/DB access, CORS for `https://localhost` via the T-424 middleware), online only if
   the body is exactly `{"ok": true, ...}` JSON within 4 s (a captive portal's HTML 200 fails). No v1 fallback. Interval
   30 s online, 10 s offline, and immediately after any `/api` network error. Two consecutive failures -> offline; one
   success -> online. ✎R **Ship precondition** (runbook): pos2's health route must be live before any tablet runs a v2
   APK, or every tablet reads offline (card disabled, every sale offline).
5. **Offline tenders and actions** (ADR A3; bible row 356): offline, cash; GCash/Maya only with a required reference;
   card and QR Ph disabled with "Needs the internet". E-wallet lines carry `toCheck: true`; the receipt gets the additive
   field `tendersToCheck: [{method, centavos, reference}]`. **Refund** offline: disabled, "Refunds need the internet."
   **Unpaid void** offline: only when the signed-in staff role is `manager` or `admin`; the session gets the additive
   `voidedOffline: true`; the ledger keeps a void event; `pos2-audit.mjs` and a "Review after outage" list show them.
   ✎R **One tablet bills a table** (ADR-015 §5): offline pay and offline void are refused unless the session's
   `ownerTerminalId` equals this device's `getBrowserDeviceId()` (what `startSession` writes, `firestore.ts:157`) ("This table was opened on another tablet. Pay it there, or wait for the
   internet."); a session with no `ownerTerminalId` (opened by v1) is allowed only online.
6. **₱50,000 warning:** a banner on every screen while the ledger's unsent total ≥ 5,000,000 centavos: "₱52,340.00 in
   sales not yet sent. Keep selling. Tell the manager." Selling never stops (ADR A3).
7. **X-slip** (`lib/printing/xSlipFormatter.ts`, via `printHub`). ✎R An **offline period** starts at the first offline
   reading and ends only when the tablet has been online for 10 continuous minutes AND has no unsent rows; brief
   reconnects do not end it. A slip prints at every 4 hours of offline-period time (4:00, 8:00, ...), and on demand from
   a "Print X-slip" button. The period start and the slips already printed are kept in IndexedDB (survive restarts).
   Content: header "X-READING — cash control, not a BIR document" (ADR A4.5), store, terminal, period from–to, receipt
   count, first and last receipt number, totals by tender (e-wallets "TO CHECK"), unpaid voids, unsent total; data from
   the ledger only. No paired printer -> shown on screen, with a reminder until printed.
8. **Update and reinstall safety (✎R, APK-first).** The service worker is registered only for the web build, so it is
   left as it is. What protects a tablet: (a) the release APK is always signed with the same release key (CI already
   uploads an APK only when the keystore secrets exist; the runbook says never install a debug build on a store tablet,
   because it cannot update in place and staff would uninstall); (b) Settings shows "Unsent sales: N — do not uninstall,
   clear data or install a different build until this is 0"; (c) "Check for update" reads `version` from the health route
   and shows the download link only when N = 0. The runbook includes an in-place-update test during an outage.
9. **Released-terminal tablets** (T-423 Ruling 6): their unsent rows keep reconciling (numbers below the +1,000 gap);
   the manager list shows them.
10. **Soak harness** (`apps/pos/src/lib/outbox/__soak__/two-tablets.test.ts`): fake Firestore gains an offline mode
    (writes held as pending and delivered on reconnect, an option to drop a tablet's pending queue to simulate the
    SDK losing it, a server-side refusal option) and a controllable clock; two tablets = two fake IndexedDBs with their
    own terminal claims. Script: 150 sales / ~2,000 writes offline split across both, flapping connectivity, 4 X-slips,
    a kill-and-restart mid-reconcile, a dropped pending queue on one tablet, a table re-seated on the server before
    reconnect, reconnect. Assert: server receipts = ledger sales (count and ids), zero duplicate receipt numbers, every
    sale acknowledged except the planted conflict (quarantined, server untouched), X-slip totals = the period's sales.
    ✎R `docs/ops/pos2-soak.md` (real two-tablet 24-hour run on the TEST Firebase project, 14–22 Dec) must add: kill the
    app within 1 s of a payment; airplane-mode flapping; an in-place APK update during an outage; Android "Clear cache";
    verify the health route first. `apps/pos/scripts/pos2-soak-verify.mjs` (read-only) lists a terminal's server receipt
    numbers and labels each gap `skipped` (a `skipped` ledger event exists) or `MISSING`, and any duplicate.

## Slices
**T** tester first: ledger, reconcile (incl. quarantine and payload replay), effects migration (incl. corrupt
localStorage), connectivity (captive portal, two-failure flip), offline tender/refund/void rules, ₱50k banner, X-slip
formatter and 4-hour timer across restart, SW/update gating, the soak harness, tree guards (no sales-critical state in
localStorage). **S1** ledger + reconcile + payment/void wiring. **S2** effects store + migration + failed list.
**S3** connectivity + health route + consumers. **S4** offline rules (tenders, refund block, manager-only void, one-tablet-per-table owner check).
**S5** banner + X-slip + update safety (APK-first). **S6** soak harness extensions + runbook + verifier.

## Acceptance (each names the mutant it kills)
1. Ledger first (offline): if the IndexedDB transaction fails, no Firestore write happens and the sale is refused; the
   number reservation and the event commit together or not at all. Kills: a sale outside the ledger; an unexplained gap.
2. ✎R Ops fidelity: the batch built from `ops` equals the original write set field for field (incl. fixed payment ids
   and server-timestamp markers restored). Kills: a replay that writes different docs.
3. ✎R2 Replay guards: absent receipt + table re-seated on the server (session still open) -> receipt written, table NOT
   freed; absent receipt + session voided online -> quarantined and NOTHING written; an `update` op on a deleted ticket
   -> skipped, sale acknowledged, not rejected; a thrown `getDocFromServer` -> no write; `waitForPendingWrites` timeout -> no replay that pass.
   Kills: blind overwrite (DEF-018); racing the SDK's own queue.
4. ✎R2 `linesHash` of a receipt read back from the fake server (undefined dropped, keys reordered) equals the local
   hash. ✎R Compare: a server receipt later refunded (`totalRefunded`), tender-corrected, or with `analyticsApplied: true` is
   acknowledged; a different `receiptNumber`, `total` or `linesHash` is quarantined. Kills: false quarantine; missed
   conflict.
5. ✎R2 A version-1 `shareat-pos-terminal` database (counter row only) upgrades to version 2 and `reserveNext` keeps
   counting from the stored value; a crash between reservation and an online transaction leaves `reserved`, resolved
   by reconcile. ✎R Status discipline: an online sale whose transaction fails leaves a `skipped` event and is never replayed; a
   server-refused offline write becomes `rejected` and is never replayed; 10 failures -> `stuck`. Kills: re-creating a
   sale the server refused.
6. Lost SDK queue: with a tablet's pending writes dropped, every unsent sale still reaches the server from `ops`.
7. Single-flight: two triggers -> one run (Web Lock); a kill mid-run then restart finishes with no duplicates.
8. Effects: a localStorage queue of 3 items moves to IndexedDB and the key is removed; a corrupt value is kept under
   `.corrupt`; ✎R a receipt's analytics effect does not run until its ledger row is acknowledged.
9. Guard: no `localStorage` for the ledger, effects, offline period or X-slip state (tree test over `lib/outbox/**`,
   `lib/offline/**`, `hooks/useConnectivity.ts`); no direct `navigator.onLine` outside the hook.
10. Connectivity: `navigator.onLine` true + an HTML 200 -> offline after two probes; `{ok:true}` -> online.
11. Offline rules: card and QR Ph disabled; GCash without a reference refused; with one saved `toCheck: true` and in
    `tendersToCheck`; refund disabled with the sentence; void refused for cashier/server/kitchen and allowed for
    manager/admin with `voidedOffline: true`; ✎R pay or void of a table owned by another device refused offline.
12. Banner at exactly ₱50,000.00 unsent shows; at ₱49,999.99 it does not; selling never blocked.
13. ✎R X-slip: prints at 4:00 and 8:00 of offline-period time; a 2-minute reconnect in between does not reset it; the
    state survives a restart; totals equal the ledger; the header says it is not a BIR document.
14. ✎R Update safety: the update link is hidden while unsent > 0; the runbook contains the in-place-update-during-outage
    test and the "never install a debug build" rule.
15. Soak harness (Ruling 10) green; the verifier labels a planted skipped number `skipped` and a removed receipt `MISSING`.
16. `npm test -w @shareat/pos`, pos tsc, T-422/423/424 guards, `build` + `build:cap` green. ✎R Integration or unit tests
    never require a specific lane database name.

## Must NOT change
Firestore wire shape (additive only: `tendersToCheck`, `voidedOffline`) · v1 (read-only) · live `shareat-hub-v2` ·
`packages/**` · `apps/erp/**` · CI/deploy.

## Out of scope
Offline PIN sign-in and an offline manager-PIN verifier (P1) · offline refunds (refused, Ian 17 Oct) · SQLite (only if the
soak fails, plan R4) · Z-reading / day close (PC-8) · the real-device soak run itself (Ian/ops, runbook).

## For the orchestrator
Ian's 17 Oct rulings are bible row 356 (commit 29e9986).

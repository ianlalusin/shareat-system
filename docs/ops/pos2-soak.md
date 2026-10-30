# POS v2 offline soak - real two-tablet run (T-425, Ruling 10)

The unit-test soak (`apps/pos/src/lib/outbox/__soak__/two-tablets.test.ts`, part of `npm test -w @shareat/pos`) proves the logic with fakes: 150 sales over
two tablets, flapping connectivity, 4 X-slips each, a lost SDK queue, a killed reconcile pass, a re-seated table, a table voided online. This document is the
**real-device run**: two tablets, 24 hours, (planned 23 to 29 November; a failure retries 30 November to 4 December; docs/plans/pos-customer-v2-phase-plan.md section 0), by Ian or ops. Nothing here touches production data.

## Before you start
1. **Health route first.** From a laptop: `curl -s https://pos2.shareat.net/api/pos2/health` must print `{"ok":true,"version":"..."}`. If it does not, stop:
   every tablet would read "offline" (card disabled, every sale offline). The route is `/api/pos2/health`; see `docs/ops/pos2-runbook.md` section 12.
2. Both tablets run the SAME release APK, signed with the release key (never a debug build). Each has its own terminal number (Settings > Terminal).
3. No cloud test project: each tablet signed in to a Lipa test setup (a test store entry, a test cashier and a test manager). Note each tablet's device id and terminal number.
4. Settings > Unsent sales shows `Unsent sales: 0` on both. A printer is paired on at least one tablet (the other tests the on-screen slip).

## The run (about 24 hours)
1. **Normal offline day.** Put both tablets in airplane mode. Sell for several hours: at least 60 sales per tablet, a mix of cash, GCash with a reference, and
   two tenders on one bill. Try card and QR Ph (must say "Needs the internet"), a refund (must say "Refunds need the internet."), a void as a cashier (refused)
   and as a manager (allowed), and a table opened on tablet A paid on tablet B (refused).
2. **Airplane-mode flapping.** Every 5 to 10 minutes switch airplane mode off for 1 to 2 minutes and on again, for an hour, while selling. The banner and the
   X-slip clock must not reset on a short reconnect; unsent sales must stay listed until the server has them.
3. **Kill the app within 1 s of a payment.** Complete a payment and, within 1 s, swipe the app away (and once force-stop it from Android settings). Reopen:
   the sale must be in the ledger as unsent (or already sent) and never lost, and the next receipt number must not repeat. Do this at least 10 times per tablet.
4. **Android "Clear cache".** With unsent sales on the tablet, Settings > Apps > Shareat POS v2 > Storage > **Clear cache** (NOT "Clear data"). Reopen: every
   unsent sale must still be there. (Clear data deletes them; that is the warning on the Settings screen.)
5. **In-place APK update during an outage.** With at least 5 unsent sales and the tablet still offline, install the next release APK over the current one (an
   in-place update, same key). Reopen: the 5 sales are still listed and reach the server when the internet returns. Never test this with a debug build.
6. **50,000 peso banner.** Let unsent sales pass 50,000.00 pesos on one tablet: the banner must show on every screen and selling must continue.
7. **4-hour X-slip.** The first slip prints at 4:00 of offline-period time (and 8:00, 12:00, ...). Press Settings > Unsent sales > Print X-slip at any time:
   the totals must equal the ledger's sales for the period. The header says "not a BIR document".
8. **A server-side change during the outage.** On a laptop (ERP or Firebase console), void one of the tablet's open tables and re-seat
   another. Reconnect: the paid sale on the voided table is **quarantined** (shown to the manager, server copy untouched); the re-seated table is not freed.
9. **Reconnect and wait 10 minutes.** Both tablets: `Unsent sales: 0`, the offline period ends 10 minutes after the last unsent sale is proven.

## Verify (read-only)
For each tablet, with the POS Firebase service-account key (the project the APK signs into) (`POS_FIREBASE_SA_KEY_FILE`, never typed into a chat or a flag):
`node apps/pos/scripts/pos2-soak-verify.mjs --store=<test store id> --terminal=<n> --skipped=<comma list>`
`--skipped` is the list of terminal sequence numbers the tablet's ledger explains WITHOUT a receipt: online sales that failed (status `skipped`) and offline voids
(each void used a number). Void rows are shown in Settings > Unsent sales > "Review after outage"; ask the developer for a ledger dump for `skipped` rows.
Output: the receipt count, every gap labelled `skipped` or `MISSING`, and any duplicate receipt number. Exit 0 = every number explained, none duplicated.
Also run `node apps/pos/scripts/pos2-audit.mjs --from=<day> --to=<day>` to list the offline voids for a manager to review.

## Pass criteria
- No `MISSING` number and no duplicate receipt number on either terminal.
- Every sale made offline is on the server exactly once, except the planted conflict, which is quarantined and untouched.
- Unsent sales survived: the kill within 1 s, Clear cache and the in-place update.
- X-slip totals equal the ledger; the banner showed at 50,000.00; selling never stopped.

# DEF-726 — offline receipt intent assessment, 22 October
Goal: cash paid once on the owning tablet remains recoverable through restart and reconnect, with one receipt number.
Android demo confirmed valid Terminal01, own cached order and Cash P760 still fail on an uncached receipt getDoc.
The existing fake returns a missing snapshot where the real SDK raises unavailable, masking this failure.
Receipt absence is unknown offline. Catching that exception and creating anyway would weaken payment idempotency.
Current ledger reserves counter+event atomically, but keys events by deviceId/terminalSeq, not by store/receipt intent.
Before removing the read, test concurrent same-receipt attempts and recovery of a saved but unapplied event.
Candidate: an intent lookup in the existing meta store, written in the SAME transaction as counter/event, pointing
at the one event for that store/receipt/kind. No adoption yet: online reserved/skipped/acknowledged states and
changed payloads need explicit semantics; do not silently recycle a possibly committed number or event.
Known failed online attempts may need a new number while preserving old history; uncertain attempts must wait
for server proof. A matching unsent offline retry should reuse its stored ops and receipt number after restart.
Keep session-owner/tender/statutory/billing checks before reservation. Cached paid receipts remain useful positive
evidence, never a requirement to prove a new receipt absent. Reconcile remains the server conflict backstop.
No SQLite, schema upgrade or new backend is justified merely to solve this intent problem.
Research context: https://firebase.google.com/docs/firestore/manage-data/enable-offline
Implementation needs a separately scoped T-458 contract, target tests, actual demo APK cash/restart/sync controls.

## Bounded assessment and chosen S1, 22 October
Verdict: extend the existing atomic ledger with a small intent pointer; no replacement storage engine.
The reproduced sample is one failed offline cash payment; production offline-payment frequency was not queried.
Without this correction every first offline receipt can fail, so it blocks the already authorized emulator acceptance.
Existing counter/event transaction, meta store and strict transaction fake cover the required primitives.
Firebase documents that uncached individual reads fail, and cached data may be incomplete:
https://firebase.google.com/docs/firestore/manage-data/enable-offline#get_offline_data
The transaction pattern is standard IndexedDB, scoped over all participating stores:
https://developer.mozilla.org/en-US/docs/Web/API/IDBDatabase/transaction
Open-source candidate https://github.com/jakearchibald/idb (ISC) wraps IndexedDB promises; not adopted:
the project already owns a transaction helper and adding a wrapper would not supply receipt-intent semantics.
Scope is one local reservation protocol plus its payment wiring and demo verification; no new tables/dependencies.
All reference apps remain untouched; this is a defect in the rebuild's existing ledger, not a request to copy legacy payment code.
T-458 defines conservative legacy/unknown-state handling and preserves existing online reservations and history.

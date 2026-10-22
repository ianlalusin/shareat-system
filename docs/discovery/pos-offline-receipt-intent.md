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

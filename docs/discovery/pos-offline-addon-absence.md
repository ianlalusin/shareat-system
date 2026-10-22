# DEF-741 — absence-safe offline add, 21 October
Goal: append a billable dish while disconnected, preserving any line the device has not cached.
Observed Android SDK unavailable on getDoc of a never-cached deterministic bill-line id.
[Firestore offline documentation](https://firebase.google.com/docs/firestore/manage-data/enable-offline)
distinguishes cached query results from missing single-document reads; an empty cache cannot prove server absence.
[Generated document references](https://firebase.google.com/docs/firestore/manage-data/add-data) let a client
allocate a fresh id before committing a batch. Existing POS sessions/tickets already use generated ids.
Adopt a new offline line per add intent, retaining the same payload and ticket references in one batch.
Tradeoff: repeated offline adds appear as separate bill rows. Quantities and adjustment ownership remain explicit.
Do not adopt catch-and-create, a cache query treated as authoritative absence, a new database or a server call
that makes offline adding dependent on connectivity. Online grouping is preserved.

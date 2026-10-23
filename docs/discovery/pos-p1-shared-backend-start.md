# POS P1 start — bounded assessment, 21 October
Verdict: reuse APK, exact billing and local outbox; start the shared-backend migration with isolated runtime testing.
The reason holds: offline persistence does not require Firebase. Current POS also depends on it for auth, staff,
orders and receipts, so deleting its SDK or switching a URL is not a migration.
Existing T-425 terminal/db.ts and outbox/ledger.ts persist counters/events atomically in IndexedDB;
reconcile still replays Firestore ops. ERP auth/sessions.ts already owns PIN KDF, throttle, opaque tokens and revocation.
T-424 pos_terminal_links maps public install UUIDs to server terminal persons, not a possession credential.
P1 must retain that distinction and use one authorize() implementation.
Prior discovery pos-offline-and-data-tiers-proposal.md studies POS/CUSTOMER/ERP flows and estimates ~130 sales/day
across four stores; this is an old planning estimate, not a new live count. No live data was queried for this pass.
Android recommends local/network data sources and persistent queues:
https://developer.android.com/topic/architecture/data-layer/offline-first
Capacitor documents IndexedDB caveats and SQLite options:
https://capacitorjs.com/docs/guides/storage
Open-source candidate @capacitor-community/sqlite is MIT, local storage rather than hosted API:
https://github.com/capacitor-community/sqlite
Do not adopt yet: first measure the existing Android ledger; a switch adds native integration and device-data migration.
Firebase supports demo-* projects with no live resources, suitable for legacy-path emulator tests:
https://firebase.google.com/docs/emulator-suite/connect_firestore
Scope: demo-only test profile and APK harness first; shared auth/reference APIs next, receipts and tables in owner flips.
Out: a LAN hub, second authoritative database, live TEST-store writes, bulk Firestore export and a simultaneous cutover.
Effort is multiple slices: enrollment/auth, offline verifier, reference snapshots, sale ingestion and table ownership.
No day estimate until the caller inventory and enrollment contract are scoped; existing hardening is retained.

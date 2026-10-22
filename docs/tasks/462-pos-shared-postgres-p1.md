# T-462 — begin POS P1 on the shared PostgreSQL backend
Status: started 21 October. Ian said "start now" after reviewing the POS phases and the
APK/device-storage proposal; then requested emulator testing for builds.
Goal: one identity, permissions and business backend shared with ERP; device storage supports offline work.
Preserve the working POS copy and its ledger; do not launch an interim Firebase release by default.
No decision to install SQLite yet: measure existing IndexedDB on the emulator and real tablets first.

## Bounded sequence
1. T-463: isolated demo emulator build/runtime harness, with no live Firebase or payment destination.
2. Inventory and specify shared sign-in: tablet enrollment must prove possession, not trust its public device UUID.
   Reuse ERP PIN/session/throttle/capability services; no second role matrix, no secrets in browser storage.
3. Implement online enrollment/sign-in/session revocation, then offline staff-verifier storage and expiry.
4. Read menu, prices, tenders and permitted discounts from ERP through server APIs; keep local snapshots versioned.
5. P2: typed sale events to PostgreSQL, server recompute/compare, idempotent receipts/refunds and ERP till actions.
6. P3: live tables/kitchen/Customer ownership moves by store, then retire Firebase after the migration window.

## Discovery already confirmed
POS auth context/login currently use Firebase Auth and staff snapshots. T-424 server authenticate also reads staff
from Firestore. ERP already has PIN/session APIs, RLS, store scope, position grants and POS terminal links.
Existing POS terminal links identify a registered UUID but do not alone authenticate possession of a tablet.
The terminal PIN session is bound to a server terminal-person id; the install UUID is a different identity.
Current ledger/counter are in one IndexedDB transaction; sync ops still encode Firestore document writes.
Do not mistake changing the session token for completing the data-owner migration.

Scope now: this plan, docs/discovery/pos-p1-shared-backend-start.md and the explicitly scoped T-463 files.
Ian's "document this" additionally scopes the dated owner-direction updates in
docs/plans/pos-customer-v2-phase-plan.md, docs/ops/pos2-runbook.md and apps/pos/README.md.
Record the emulator alternative to a cloud test project and distinguish planned architecture from delivered code.
Do not amend planner-owned bible rows here; planner synchronization remains outstanding.
Later sign-in, enrollment and schema slices require their own exact-file specs before code.
No app imports another app. Keep reference repos read-only and the active ERP release separate.
Acceptance: emulator APK runs only against isolated local services, then a separately specified shared-auth slice
proves active staff/store/device binding, revoked/expired sessions, throttling and no client-supplied authority.

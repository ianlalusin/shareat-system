# T-338: store readiness warns when a store has no manager

**Status:** RESERVED 2026-09-24. Queued after T-336. NOT SPECCED.

**Ruling (Ian, 2026-09-24):** manager stays a ROLE that an admin assigns to a person; it is never a seeded position. There is one organisation-wide admin, and managers are scoped per store. The adminless-manager elevation stays as it is. The store-readiness checklist (the one that already reports room / adminScope / salesChannel / signIn) gains an item: "No manager assigned to this store", shown when no person holding the `manager` role has an active store-scope row for that store. The item is a warning only and blocks nothing.

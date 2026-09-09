# T-253 — DEF-220: `/commissary/catalogue` opens on a branch, not a commissary

> **Status: RESERVED by the orchestrator, 2026-09-10. Assigned to lane B. Awaiting a SPEC.**
> Number reserved so no peer takes it. Nothing below is built.

`apps/erp/src/app/commissary/catalogue/page.tsx:28` defaults `commissaryStoreId` to `stores[0]`,
and `listForOrg` orders active-then-code, so the default is Lipa — a branch with no
`commissary_links` — and the branch picker renders empty until the user knows to switch to
Smoketest Commissary.

- Handled by a real empty state, so nothing breaks: this is a **default-selection** defect, not a
  crash. Severity 🔸.
- Remedy per the register: default to the first store that IS a commissary (has an outgoing link),
  or to the store the actor is signed in to when it is one. One line and a test.
- ⚠️ **The test is the half that matters.** A fix that hard-codes a different index is the same
  defect wearing a different number — the test must assert the *property* (the default store has an
  outgoing commissary link), never a particular store name or position.

See `docs/DEFECTS-REGISTER.md` DEF-220. Found 2026-09-07 by lane C in the standing browser sweep.

# T-257 — DEF-259: give the ERP a way to sign out

> **Status: RESERVED by the orchestrator, 2026-09-10. Unassigned. ⭐ IAN'S CALL, 10 Sep:
> FIX THIS NEXT — top of the queue.** Number reserved so no peer takes it. Nothing below is built.

There is no sign-out control anywhere in the ERP. `signOutAction`
(`apps/erp/src/app/sign-in/actions.ts:107`) is complete and correct — it calls `signOut` and
ends the **server** session — and nothing references it. A case-insensitive sweep for
*sign out / signout / log out / logout* across every `.tsx` in `apps/erp/src` returns **zero**.

⛔ **Why this is a blocker and not a missing button.** Sign-in is **store-scoped** and sessions are
**server-side**, so a shared back-office PC or a manager's tablet cannot be handed to the next
person: closing the browser does not end the session, and clearing cookies leaves the server
session alive. The realistic failure is someone acting under another person's identity.

## What this task is, and is not

- ⭐ **The hard part is already written and already right.** `signOutAction`'s own comment records
  the distinction most sign-outs get wrong — *the browser forgetting is not the session ending*.
  Do not rewrite it. This is wiring and placement.
- **Return to `/sign-in`**, never to a store-scoped screen — the next person must pick their own
  store and enter their own PIN.
- ⚠️ **Placement is a real decision, not an afterthought.** It lands in T-234's responsive shell and
  must work at 390px as well as 1280px. Say where it goes and why in the spec.
- ⚠️ **Check the clock-terminal surface separately.** T-246 established that the wall-mounted clock
  tablet must not show office navigation; a sign-out control must not leak onto it either.

## Done when

- A person signed in at a store can sign out from any screen, and lands on `/sign-in`.
- The **server** session is ended, proven by a query, not by the browser forgetting.
- Browser pass at 390 and 1280 — the orchestrator runs it.
- The clock-terminal surface is confirmed unaffected.

See `docs/DEFECTS-REGISTER.md` DEF-259. Found 2026-09-10 by lane C during the production-caller
census, which it was not sent to find; verified independently by the orchestrator.

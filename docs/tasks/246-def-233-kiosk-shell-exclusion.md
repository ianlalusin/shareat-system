# T-246 — DEF-233: the ERP's navigation must not render on the clock kiosk

> **Status**: 🔒 **RESERVED — spec not yet written.** Number allocated by the orchestrator
> (`ianla-44`) 2026-09-09 for **lane B** (`readiness-check-remedy-link`, was `ianla-3a`). Write the
> spec into this file **in plan mode**, send `[B] SPEC`, and stop until you receive `APPROVED`.

## The defect

**DEF-233** (`docs/DEFECTS-REGISTER.md:304`) — `/clock`, the wall-mounted kiosk screen staff punch
in on, can render the full ERP navigation chrome whenever a manager happens to hold an ERP session
in the same browser.

`/clock` authenticates through Firebase entirely separately from the ERP's `__session` cookie
(`apps/erp/src/app/clock/page.tsx` vs `apps/erp/src/lib/session.ts:64`), so *"is there a session?"*
is the wrong question for that route — and it is the only question a **Server Component can ask**:
Next 16 does not support reading the current URL from one. That is design, not oversight
(`node_modules/next/dist/docs/01-app/03-api-reference/04-functions/use-pathname.md`).

Pre-existing — `Nav()` has had this gap since it shipped, and T-234's `AppShell` inherited it
deliberately rather than widening a UI slice's scope. It is a real defect on the device staff
actually use.

## ⭐ This is a decision, which is why it gets a spec in plan mode

The register names two supported fixes and rules out a third. **Recommend one, with costs:**

1. **`middleware.ts`** setting a header that `AppShell` reads through `headers()`, hard-excluding
   the path. One new file — but it is on the **request path**, so it wants its own assessment:
   what it costs on every request, and how narrowly the matcher can be scoped.
2. **Route groups** — move `/clock` (and any other shell-less route) outside the shell layout.
   The register calls this *"the correct end state"*, but it is a file move touching every route,
   so weigh that against option 1 landing sooner.

⛔ **Do NOT close this with a client component that hides the shell after paint.** The kiosk would
flash the ERP chrome on every load, in front of staff, on a wall-mounted screen.

⚠️ Before recommending: **count what option 2 would actually move.** "Every route" is the
register's phrase, not a measurement — and on this codebase an uncounted estimate has been wrong
three times in two days. Print a known hit before any count (bible §13 row 181).

## Required reading

- `docs/RULES.md`, then `PROJECT_BIBLE.md` §3.3 (spec format) and §9 (definition of done)
- `docs/DEFECTS-REGISTER.md:304`
- `docs/tasks/234-responsive-shell-sidebar-nav.md` — why `AppShell` inherited this rather than fixing it
- The Next 16 docs in `node_modules/next/dist/docs/` for anything you assert about middleware or
  route groups. ⛔ This is not the Next.js in your training data — read the shipped guide.

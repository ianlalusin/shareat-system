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

## Placement decision

⭐ **Replace the existing "Signed in" indicators; do not bolt a fourth control on beside them.**
T-234 already reserved three slots for exactly this affordance and attached no control to any of
them — `TopBar.tsx:31` (phone), `Sidebar.tsx:137` (sidebar, expanded), `Sidebar.tsx:138` (sidebar,
collapsed to the rail). All three currently render passive "Signed in" text or an emerald dot.

The reason to replace rather than add: the text and the dot carry no information a person doesn't
already have from looking at the shell — of course they're signed in, they're looking at the ERP.
Once that slot can carry the ACTION instead, keeping the old label alongside a new button is pure
clutter for zero benefit. This also means the change costs no new layout or spacing at any of the
three breakpoints.

⚠️ **The wrinkle that makes this a real decision:** the sidebar's expanded and collapsed states are
not one surface but two (`shell-sidebar-expanded-only` / `shell-sidebar-collapsed-only`, switched
by CSS off `data-sidebar-state`, never by a second JS state). A control placed only in the expanded
slot leaves a person on a collapsed rail with no way to sign out — DEF-259 again, in a smaller
costume. So all **three** surfaces get the control, not two:

1. **Phone top bar** (`TopBar.tsx`, Server Component, `md:hidden`) — the bare `<span>Signed in</span>`
   becomes `<form action={signOutAction}><button type="submit">Sign out</button></form>`. A Server
   Component may render a `<form>` whose `action` is a Server Action reference with no client
   boundary — confirmed against this codebase's own prior art (`apps/erp/src/app/budgets/page.tsx`
   does exactly this), so `TopBar.tsx` stays a Server Component, preserving the file's own
   SSR-parity invariant (identical markup at every viewport, visibility decided by CSS alone).
2. **Sidebar, expanded** (`Sidebar.tsx`, already `'use client'`) — the `shell-sidebar-expanded-only`
   "Signed in" span becomes the same form/button pattern, labelled "Sign out".
3. **Sidebar, collapsed to the rail** — the aria-hidden decorative dot becomes an icon-only submit
   button (`aria-label="Sign out"`, same form/action), wrapped in `shell-sidebar-collapsed-only`
   instead of the dot. This is the one new export: `icons.tsx` gains one glyph, following its
   existing SVG pattern; its only caller is this button, named here so it does not become
   DEF-226/227/249's shape (an export with no caller).

⚠️ **Touch-target separation from the Collapse button (DEF-244 discipline — measure, don't eyeball).**
The rail's Collapse button (`Sidebar.tsx:124-132`) and the new rail sign-out button both sit inside
the same `.shell-sidebar` column (`4rem` / 64px wide when collapsed, `globals.css`), so both take the
existing `.shell-nav-row` class already used by every touch target in this shell (`.shell-nav-row`:
`min-height: 36px`, `44px` under a coarse/touch pointer, `globals.css:86-93`) with the same `mx-2`
horizontal margin the Collapse button uses — giving both buttons the same ~48px-wide, 36–44px-tall
box, not an arbitrarily-sized new one.

**They are not adjacent.** `PersistentSidebar` is a `flex flex-col md:h-dvh` column: Wordmark, then
the Collapse button pinned near the top, then `<div className="flex-1"><SidebarNav /></div>`
absorbing all remaining vertical space, then the sign-out footer row pinned at the bottom. The two
buttons sit at opposite ends of a full-viewport-height column with the nav list's `flex-1` spacer
between them — not a fixed small gap that DEF-244's 3.2px overlap could recur in. The one edge case
this reasoning does not cover from source alone: a viewport short enough (a landscape phone/tablet
at ≥768px width, low height) that `SidebarNav`'s natural content plus the `flex-1` minimum could
compress the gap before `md:overflow-y-auto` kicks in. That is a real browser measurement, not a
source-reading one — flagged for the orchestrator's browser pass rather than claimed here.

## Done when

- A person signed in at a store can sign out from any screen, and lands on `/sign-in`.
- The **server** session is ended, proven by a query, not by the browser forgetting.
- Browser pass at 390 and 1280 — the orchestrator runs it.
- The clock-terminal surface is confirmed unaffected.

See `docs/DEFECTS-REGISTER.md` DEF-259. Found 2026-09-10 by lane C during the production-caller
census, which it was not sent to find; verified independently by the orchestrator.

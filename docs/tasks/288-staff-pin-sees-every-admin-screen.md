# T-288 — a staff PIN reaches every admin screen, and the nav advertises them

> ⚠️ **SPEC ONLY. No code in this task yet.** It needs a bible amendment (§ *The amendment* below)
> and only the Opus planner may write that row (RULES §1 rule 14). Task number provisional pending
> allocation by system32-85.

**Reported by Ian, 2026-09-12:** *"i tried signing in with a staff pin only but i can access many
restricted pages and actions for staff."*

## ⭐ What was measured, including the half that is NOT true

Ian's report has two halves and they resolved differently. **He withdrew the second himself when
asked**: no action ever succeeded — he reached the pages and inferred the rest.

That withdrawal is corroborated structurally rather than taken on recollection. Every server action
that writes through a repo **directly**, bypassing a domain service, was checked by hand for a
preceding `authorize()`:

| Action file | Direct repo write | Gate |
|---|---|---|
| `admin/users/actions.ts` | `grantStoreScope`, `revokeStoreScope` | `authorize(…, 'manage_users')` at :159 |
| `admin/users/actions.ts` | `revokeGrantById` | `authorize(…, 'grant_capability')` at :227 |
| `inventory/low-stock/actions.ts` | `setThreshold`, `clearThreshold` | `authorize(…, 'set_item_threshold', { storeId })` |
| `fixed-assets/actions.ts` | `updateTerms` | `authorize(…, 'manage_fixed_assets')` |
| `ap/actions.ts` | `updateSupplier` | via `updateSupplierDetails` in the domain |

⭐ **The write layer is intact.** Everything else routes through a domain service, and
`authorize()` lives inside those services precisely so forgetting is impossible. **There is no
privilege escalation here and this task must not be written as though there were.**

## The real defect, in two parts

### 1. The nav does no filtering whatsoever

`components/shell/Sidebar.tsx` and `SidebarNav.tsx` contain **no reference to a role or a
capability**. A cashier signing in at a counter tablet is shown links to Users, Stores, Sales
channels, Owners, Loans, Payroll and the ledger reports. They are advertised, not merely reachable.

### 2. Reads are ungated, and that part is a RECORDED DECISION, not an oversight

`settings/sales-channels/lib.ts:4`, `admin/users/lib.ts:3`, `staff/lib.ts` and
`attendance/terminals` all carry the same note: *"plain reads go straight through with no
capability gate — the gate belongs to the WRITE."* It is DEF-051's remedy — `canAccessFinancialReports`
hid the UI while the data stayed readable, and the conclusion drawn was *"presentation is not a
control."*

⭐ **And `tests/unit/no-ungated-read-surface.test.ts` is the guard that encodes it, correctly and
narrowly.** Its own header says it: a page that touches the database must establish a **session** —
*"it does not try to judge whether the authorization is correct, only that the page cannot have
skipped the question entirely."* A signed-in cashier passes it, by design. The guard is not broken;
its claim was never about capability.

**So the gap is real and the existing guard cannot see it.** DEF-051's lesson — that hiding a
screen is not a control — is true and is not being repealed. What is being added is the control
that was supposed to sit behind the hiding.

## ⭐ The amendment this needs, stated for Ian

> **DEF-051 concluded that presentation is not a control. T-288 does not overturn that — it adds
> the missing half.** A screen is hidden from the nav *and* its read is gated server-side. Hiding
> alone remains explicitly insufficient. The reason the pairing is now worth its cost: the app is
> used on a **shared counter tablet** signed in with a store PIN, where the population that can see
> a screen is not a set of trusted office staff but whoever is standing at the till.

⛔ **The implementer writes neither the bible row nor this amendment.** It goes to Ian through
system32-85.

## The design

### One declaration, two consumers — and that is the whole point

⛔ **If the nav filter and the page gate read from two different lists, they WILL drift**, and the
drift is silent in the dangerous direction: a link disappears, an operator assumes the screen is
protected, and the URL still renders. This is DEF-310's shape exactly — two guards described as
twins, one widened, the other not.

So: a single `ROUTE_CAPABILITY` map, route → required capability, in `apps/erp/src/lib/`. It is
read by:

1. **`requireCapabilityForPage(route)`** — a server-side gate the page calls right after
   `requireSession`. It refuses with a card, not a redirect (a redirect to `/` from a link the nav
   offered is indistinguishable from a bug).
2. **The sidebar**, which renders a link only when the actor holds the capability for it.

### A guard that proves the map covers the routes

⛔ A `ROUTE_CAPABILITY` map that silently lacks an entry for a new admin route is the same
narrower-than-its-claim failure this repo has filed five times (DEF-295, 296, 304, 309, 310). The
guard enumerates admin/settings route files from `git ls-files` and fails on any route with no
entry — **and its own plant state is: remove one entry, the guard must go RED.**

### ⚠️ What must NOT change

- `authorize()` stays exactly where it is. This adds a layer; it replaces nothing.
- The refusal card must name the capability, as `/admin/stores` already does for a manager.
- **Not every page.** `/clock`, `/till`, `/sales-days` and the staff-facing surfaces are where a
  cashier legitimately works. The map covers the admin, settings and financial-report routes.

## Open question for Ian

**What should a cashier see when the nav is filtered — a shorter nav, or a different home?** A
tablet showing four links out of thirty is honest but looks broken. Recommendation: filtered nav
plus a landing page that is the till, not the dashboard.

## Definition of done

typecheck · unit green · the coverage guard fails with an entry removed · a seeded cashier PIN
reproduced in the running app on 9008 **before and after** · bible row written by the planner.

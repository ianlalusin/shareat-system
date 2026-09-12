# T-288 — a staff PIN reaches every admin screen, and the nav advertises them

> ⭐ **BUILT 2026-09-12.** Ian cleared it directly, in his own words: **"do both hide the menu and
> gate the reads."**
>
> ⚠️ **The bible amendment is still UNWRITTEN** — the ruling exists, the row does not. Only the
> Opus planner writes it (RULES §1 rule 14); system32-85 is putting it to Ian. The quotable text is
> under *The amendment this needs*, below.
>
> ⚠️ **Not done: no cashier-PIN smoketest yet.** This is not finished until a seeded cashier has
> actually been refused in a browser on 9008.

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

---

# What was actually built, and three things this spec got WRONG

⭐ Recorded rather than edited away — the corrections are the useful part.

## ⛔ Correction 1 — the report pages were ALREADY read-gated

This spec asserted that admin reads are ungated across the board. **Too broad.** The eight
`/reports/*` pages call `reportScope(path, capability, …)` (`apps/erp/src/app/reports/lib.ts:73`),
which calls `authorizeForScope` — proving the capability **per store**, and throwing. That is
strictly *stronger* than the gate this task adds.

So the report routes are in `ROUTE_CAPABILITY` **for nav filtering only**, and
`route-capability-coverage.test.ts` accepts `reportScope(` as a gate. Forcing a second, weaker call
into eight already-correct pages would have been churn that bought nothing.

⚠️ This also means DEF-051's remedy was **more complete than its own summary suggested**: reports —
the thing DEF-051 was actually about — did get a real read gate. What never got one was everything
else.

## ⛔ Correction 2 — the nav is a DATA MODULE, not hardcoded markup

This spec said `Sidebar.tsx`/`SidebarNav.tsx` contain no route table. In fact
`apps/erp/src/components/nav.tsx` exports `GROUPS`. The filtering is applied by `AppShell`, which
passes `allowedHrefs` down; `nav.tsx` stays pure data and knows nothing about capabilities.

## ⛔ Correction 3 — no page-level refusal pattern existed to copy

This spec said `/admin/stores` "early-returns for a manager with a refusal card". It does not. That
sentence came from a *comment* in `settings/sales-channels/page.tsx` describing intent. **No such
pattern existed anywhere**, so `requirePageAccess` created the first one.

## ⭐ The defect the guards found in the gate itself

`tests/unit/no-direct-transaction-in-erp.test.ts` caught the first implementation using a bare
`transaction()` inside `requirePageAccess`. **A plain transaction connects as the table owner, for
which RLS does not apply.** The gate reads `person_roles` and `person_grants` — org-scoped tables —
so the access-control layer was itself querying with every tenancy policy switched off.

⛔ **A single-org dev database returns the right answer anyway**, so no test of this task's own
would have caught it. Fixed to `withOrgPrincipal`, then `withorgprincipal-chokepoint` (T-261 §B6)
caught the fix importing it from `@shareat/db` instead of the chokepoint that owns the
constraint-refusal counter. Three guards, three real catches, one file.

## As-built

| Piece | File |
|---|---|
| The one declaration | `apps/erp/src/lib/route-capability.ts` |
| The read gate + refusal card | `apps/erp/src/lib/page-access.tsx` |
| `heldCapabilities()` — matrix ∨ grant, beside `authorize()` | `packages/auth/src/authorize.ts` |
| Nav filtering | `AppShell.tsx` → `Sidebar.tsx` → `SidebarNav.tsx` |
| The gate, applied | 26 pages under `/admin`, `/settings`, `/payroll`, `/owners`, `/loans`, `/liabilities`, `/fixed-assets`, `/money-accounts`, `/money-transfers`, `/prepaid` |
| Coverage guard + plant | `tests/unit/route-capability-coverage.test.ts` |

⛔ **`authorize()` is unchanged.** Store scope is deliberately NOT checked at page level — a page is
often not store-specific — so this layer is intentionally more permissive than `authorize()` for a
store-scoped capability, which is the safe direction: the screen opens, the action still refuses.

**Gates:** `tsc` exit 0 · unit **106 files / 1420 passed / 0 failed** · plant verified on real
source (stripping `/payroll`'s gate fails the guard naming `/payroll`) · `touch-target-baseline.json`
**unchanged** — the one new undersized control was fixed, not baselined.

---

# ⚠️ A GAP I LEFT, AND IT WAS MY JUDGEMENT CALL ALONE — for Ian

`ROUTE_CAPABILITY` is deliberately not exhaustive: the staff-facing surfaces stay open because
gating them would break the app for the role that uses it most. **But five routes in the Reports
nav group are open to any signed-in person and I decided that silently, without putting it to Ian.**

| Route | Holds |
|---|---|
| `/statutory-discounts` | ⛔ **`holder_name` and `id_number`** — the **name and government ID number** of senior-citizen and PWD customers, read off a physical card (`statutory_discount_records`) |
| `/cutover/opening` | The organisation's opening balances — its financial starting position |
| `/cutover/count` | The cutover stock count |
| `/findings` | The findings feed |
| `/admin/prerequisite-refusals` | A count of order-of-operations walls people hit |

⚠️ **`/statutory-discounts` is the one that matters.** It is the only place T-288's map leaves
**customers' personal data** readable by every signed-in person, including a cashier on a shared
counter tablet — which is exactly the population the task was written for.

⭐ **The argument for leaving it open is real**, which is why it is a question and not a defect: a
cashier *records* SC/PWD discounts, holds `record_statutory_discount`, and cannot do the job
without touching this data. **But recording one discount is not the same as reading the store's
whole register**, and that distinction is a business decision, not mine.

**Recommendation:** gate `/statutory-discounts` on `view_financial_reports` (manager and up) and
leave the recording flow untouched, so a cashier can still add an entry but not browse the
register. ⛔ **Not done — it needs Ian's ruling**, and guessing would either expose customer IDs or
break a control a cashier needs.

⚠️ Also unresolved by me: `view_financial_reports` was chosen as the gate for `/owners`, `/loans`,
`/liabilities`, `/money-accounts`, `/money-transfers` and `/prepaid` **because it is the capability
that separates staff from manager**, not because anyone decided a manager should see owner
drawings. That is a business question wearing a technical answer, and it deserves review.

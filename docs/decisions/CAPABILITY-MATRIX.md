# The capability matrix

| | |
|---|---|
| **Status** | Proposed 2026-08-25 by the Opus planner, at Ian's instruction (*"for now design it as they are manager, I'm the admin. Do the matrix."*) |
| **Governs** | T-121, bible row 114 |
| **Becomes** | A typed, exhaustive table in code with a build guard — this document is the decision, that file is the enforcement |

## How to read this

**Four roles**, each strictly containing the one below it in *authority* but **not** in scope:
`super_admin` › `admin` › `manager` › `staff`.

**Scope column:** `store` means the check also tests the actor's store list; `org` means it applies
org-wide. **Scope and capability are independent** — holding a capability never implies holding it
everywhere (bible row 114).

**Every ✅ needs a test proving the ✗ fires.** A capability with no denial test is a checkbox, not
a control — DEF-051 and DEF-052 are both that failure, already shipped in v1.

**Franchise owners are `manager`** for now, and Ian is `admin` of every org. So **read the manager
column as "what a franchise owner can do to run their restaurant."** If it is missing something
they need weekly, the boundary is wrong.

---

## Sales and cash

| Capability | Scope | super | admin | manager | staff | Notes |
|---|---|:--:|:--:|:--:|:--:|---|
| `record_sale` | store | ✅ | ✅ | ✅ | ✅ | The POS. Everyone on shift |
| `submit_sales_day` | store | ✅ | ✅ | ✅ | ✅ | Cashier closes their own day |
| `verify_sales_day` | store | ✅ | ✅ | ✅ | ✗ | **Segregation:** the person who submits should not be the one who verifies |
| `void_sales_day` | store | ✅ | ✅ | ✅ | ✗ | v1's `canVoidRecords`, promoted to a role-level capability |
| `accept_remittance` | store | ✅ | ✅ | ✅ | ✗ | **DEF-052** — in v1 this grant enforced nothing. Here it must have a denial test |

## Expenses

| Capability | Scope | super | admin | manager | staff | Notes |
|---|---|:--:|:--:|:--:|:--:|---|
| `create_expense` | store | ✅ | ✅ | ✅ | ✅ | Staff record what they spend |
| `edit_own_expense` | store | ✅ | ✅ | ✅ | ✅ | **Time-boxed** — v1 gives cashiers 48h on their own. Preserve the window |
| `edit_any_expense` | store | ✅ | ✅ | ✅ | ✗ | |
| `void_expense` | store | ✅ | ✅ | ✅ | ✗ | |
| `approve_expense` | store | ✅ | ✅ | ✅ | ✗ | |

## Inventory

| Capability | Scope | super | admin | manager | staff | Notes |
|---|---|:--:|:--:|:--:|:--:|---|
| `record_stock_movement` | store | ✅ | ✅ | ✅ | ✅ | Receiving, transfers, counts |
| `adjust_inventory` | store | ✅ | ✅ | ✅ | ✗ | v1's `canAdjustInventory`. An adjustment is a write-off in disguise |
| `record_wastage` | store | ✅ | ✅ | ✅ | ✅ | Recording waste must be frictionless, or it goes unrecorded |
| `charge_staff_for_discrepancy` | store | ✅ | ✅ | ✅ | ✗ | v1's `canChargeStaff`. Takes money off a person — never staff-level |

## Suppliers, buyers and credit

| Capability | Scope | super | admin | manager | staff | Notes |
|---|---|:--:|:--:|:--:|:--:|---|
| `approve_supplier` | store | ✅ | ✅ | ✅ | ✗ | Ian's list |
| `approve_buyer` | store | ✅ | ✅ | ✅ | ✗ | Ian's list — **operational** judgement |
| ⚠️ `set_credit_limit` | org | ✅ | ✅ | ✗ | ✗ | **Split out deliberately.** Approving a buyer is operational; deciding how much of your money they may owe is not. **Ian to confirm** — see §Open 1 |
| `override_credit_limit` | store | ✅ | ✅ | ✅ | ✗ | Discovery 19 §2 — one gate, with an override. Every use logged |
| `record_ap_payment` | store | ✅ | ✅ | ✅ | ✗ | |
| `record_ar_collection` | store | ✅ | ✅ | ✅ | ✗ | |

## Wholesale (ADR-008 §11)

| Capability | Scope | super | admin | manager | staff | Notes |
|---|---|:--:|:--:|:--:|:--:|---|
| `create_wholesale_order` | store | ✅ | ✅ | ✅ | ✅ | Staff-entered by design |
| `dispatch_wholesale_order` | store | ✅ | ✅ | ✅ | ✗ | **The billing event** (discovery 19 §1) and the credit-limit gate. Not staff |

## Books and reporting

| Capability | Scope | super | admin | manager | staff | Notes |
|---|---|:--:|:--:|:--:|:--:|---|
| `view_financial_reports` | store | ✅ | ✅ | ✅ | ✗ | **DEF-051** — in v1 this hid the UI while the data stayed readable. Here it gates the DATA |
| `view_trial_balance` | org | ✅ | ✅ | ✗ | ✗ | Org-wide by nature; a store manager has no store-level trial balance to see |
| `reverse_entry` | store | ✅ | ✅ | ✅ | ✗ | The only correction path (T-106). Must be reachable, or people find worse ways |
| ⚠️ `close_period` | **org** | ✅ | ✅ | **conditional** | ✗ | Bible row 101 says admin **and** manager. **But a period is org-wide and a manager is store-scoped** — see §Open 2 |
| `post_journal_entry` (direct) | org | ✅ | ✗ | ✗ | ✗ | **Nobody posts by hand.** Entries come from source documents. Reserved for break-glass repair, logged |

## People

| Capability | Scope | super | admin | manager | staff | Notes |
|---|---|:--:|:--:|:--:|:--:|---|
| `enrol_staff` | store | ✅ | ✅ | ✅ | ✗ | Ian's list. **Staff only** — creating another manager is `manage_users` |
| `manage_users` | org | ✅ | ✅ | ✗ | ✗ | Creating/assigning roles at manager level and above. **See §Open 3 — this is the friction point** |
| `grant_capability` | org | ✅ | ✅ | ✗ | ✗ | Only an admin grants |
| `manage_attendance` | store | ✅ | ✅ | ✅ | ✗ | v1's `attendanceManager` grant, now a manager capability |

## Configuration

| Capability | Scope | super | admin | manager | staff | Notes |
|---|---|:--:|:--:|:--:|:--:|---|
| `manage_store_settings` | store | ✅ | ✅ | ✅ | ✗ | *"Store settings tied to operation"* — Ian's words |
| `manage_price_lists` | org | ✅ | ✅ | ✗ | ✗ | Pricing is a commercial decision, not an operational one |
| `manage_fixed_assets` | org | ✅ | ✅ | ✗ | ✗ | |
| `run_depreciation` | org | ✅ | ✅ | ✗ | ✗ | **Scheduled, not clicked** — v1's stopped scheduler is DEF-044 |
| `manage_chart_of_accounts` | org | ✅ | ✅ | ✗ | ✗ | The technical residue. Exactly what Ian was right not to hand over |

## Platform — super-admin only

| Capability | Scope | super | admin | manager | staff | Notes |
|---|---|:--:|:--:|:--:|:--:|---|
| `cross_org_access` | platform | ✅ | ✗ | ✗ | ✗ | **Break-glass.** Re-auth, stated reason, every use logged (bible row 114) |
| `view_franchise_sales` | platform | ✅ | ✗ | ✗ | ✗ | The franchisor view — **sales only**, never their costs or profit (ADR-008 §5) |

---

## ⚠️ Open — three cells I will not decide alone

### 1. `set_credit_limit` — admin only, or manager too?

I have it as **admin only**, splitting it from `approve_buyer`. Approving a buyer is operational
judgement about whether to trade with someone; setting their limit decides **how much of your money
is at risk** if they do not pay.

**For a franchise this matters more, not less:** a franchise manager setting their own buyers'
limits is risking their own money — which is arguably fine. In Ian's org, a store manager setting
limits is risking Ian's.

**If manager should hold it, say so and it moves.** I have taken the cautious position because the
looser one is harder to walk back once buyers are trading on terms.

### 2. ⚠️ `close_period` conflicts with store scoping — this is a real inconsistency

**Bible row 101 says admin and manager may close. Bible row 114 says capabilities are
store-scoped. A fiscal period is ORG-wide.** So a manager of Lipa alone would be closing the books
for Malvar, Banay-Banay and Davao too.

**Recommended: a manager may close only if their store scope covers the whole org.** That keeps
row 101 true, makes it coherent, and needs no new concept — the scope check already exists.

The alternative is restricting close to admin, which contradicts row 101 and would mean Ian
closes the books for every franchise every month. **Not recommended, but it is a real option.**

### 3. `manage_users` is the friction point Ian should expect

Manager can enrol **staff** but not create another **manager**. So a franchise owner opening a
second store cannot appoint its manager — Ian does it.

**That is correct today** (Ian is their admin, and it is one request a year) **and it is the first
thing that will chafe** if a franchise grows. Worth watching rather than pre-solving: if it
happens twice, move `manage_users` to manager scoped to their own org.

---

## The rules this matrix must be built under

1. **Every ✅ has a denial test.** A capability whose ✗ is never exercised is not a control.
2. **The matrix is exhaustive and typed.** Adding a capability without a decision for all four
   roles **fails the build** — the same guard shape as T-119 and T-120. No default.
3. **Enforced server-side, at the mutation.** Never in a component, never by hiding a screen —
   that is DEF-051 exactly.
4. **Scope is checked separately and always.** Holding a capability is never sufficient on its own.

---

# B. "Manager takes over when there is no admin" — asked 2026-08-25

Ian: *"When a store has an admin assigned, admin handles sensitive info, especially financial.
When a store has no admin, manager takes over. So the moment a franchise hires an outside manager
and dedicates themselves as admin, the role adjusts automatically. Is this model fragile?"*

**The goal is right. The mechanism is fragile in one specific way, and it is the way that matters.**

## What is right about it

A one-person operation needs that person to do everything, and a grown one should separate duties.
Any model that cannot express both is wrong. And avoiding a painful manual migration between them
is a real benefit, not a convenience.

## The one fragility that decides it

> **Removing an admin would silently PROMOTE every manager in that org.**

An admin leaves, is deactivated, or is deleted in a tidy-up — and at that moment every manager
gains financial control. Nobody granted it. Nobody was told. **A privilege escalation triggered by
an HR event, invisible in the data, with no record that it happened.**

That is the failure this project has already met twice under different names: v1's signup flow that
demoted an admin and created a lockout, and `canAcceptRemittance` (DEF-052) whose enforcement
nobody could locate. **A permission that changes because some other row disappeared is the same
species.**

Four more, briefly, all downstream of the same choice:

| | |
|---|---|
| **"Can this person set a credit limit?" stops having a stable answer** | It depends on a row somewhere else. Reasoning, testing and reviewing all get harder |
| **"Has an admin" is a fuzzy predicate** | Deactivated? On leave? Account exists but never logged in? Fuzzy predicates in authorization are where holes live |
| **Auditing becomes time-travel** | *"Who could have set that limit on 3 March?"* needs the org's admin population **as it was that day**. Not answerable from current state |
| **Every sensitive capability gets two behaviours** | And each multiplies against store scope. The test matrix doubles for a rule nobody can see |

## ⭐ The version that is not fragile: automatic at GRANT time, static at CHECK time

Ian's goal survives intact if the fallback moves earlier — out of the permission check and into the
moment the manager is created.

| | Ian's version | Recommended |
|---|---|---|
| **When is it decided?** | On every check, from live data | **Once, when the manager is appointed** |
| **Where does it live?** | Nowhere — it is inferred | **A row.** Visible, dated, attributable |
| **Admin removed** | Managers **silently gain** power | **Nothing changes.** Grants are unaffected by someone else's departure |
| **Admin appointed** | Managers silently lose power | One deliberate revoke — an act, with a record |
| **Audit** | Reconstruct history | `select` |

**Concretely:** creating a manager in an org that has no admin **automatically proposes and applies
the elevated grants**. That is the automatic behaviour Ian wants, and it happens exactly where a
human is already present and paying attention. From then on the grants are ordinary stored grants —
one code path, one answer, one thing to test.

When the franchise later hires a manager and the owner takes the admin seat, **Ian revokes the
elevated grants in one action.** Once per franchise, per lifetime.

> **The rule worth keeping beyond this decision: nothing anyone DELETES should give anyone else
> more power.** Deletion may break a feature loudly — it must never widen access quietly.

## What this costs

One deliberate action per franchise, on the day it grows. In exchange: every permission is a row
you can query, the audit answers itself, and no HR event ever changes who can touch the money.

**Recorded as recommended, not decided — it is Ian's call.**

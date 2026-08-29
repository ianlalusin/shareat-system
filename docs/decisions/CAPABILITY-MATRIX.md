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
| `transfer_funds` | store | ✅ | ✅ | ✅ | ✗ | Row 150. Moving money between accounts that already exist is RECORDING, not changing what the books can record against — that is `manage_chart_of_accounts` |

## Expenses

| Capability | Scope | super | admin | manager | staff | Notes |
|---|---|:--:|:--:|:--:|:--:|---|
| `create_expense` | store | ✅ | ✅ | ✅ | ✅ | Staff record what they spend |
| `edit_own_expense` | store | ✅ | ✅ | ✅ | ✅ | **Time-boxed** — v1 gives cashiers 48h on their own. Preserve the window. ⭐ **Also gates DELETING a draft** (2026-08-25) — deleting is the last edit you can make to it, so no separate capability exists and the window cannot drift |
| `edit_any_expense` | store | ✅ | ✅ | ✅ | ✗ | Also gates deleting a draft once the window has closed, or when the actor is not its creator |
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
| `approve_supplier` | org | ✅ | ✅ | ✅ | ✗ | Ian's list. **Scope corrected to `org` by T-130**: `suppliers` has no `store_id` — org-wide master data, same shape as `customers` (ADR-008). Nothing depended on the old `store` declaration (unimplemented until T-130) |
| `approve_buyer` | store | ✅ | ✅ | ✅ | ✗ | Ian's list — **operational** judgement |
| `set_credit_limit` | org | ✅ | ✅ | ✅ | ✗ | ✅ **Ian 2026-08-25 — manager too.** Coherent: managers already approve the buyer, and a **franchise** manager setting their own buyers' limits is risking their own money. Still split from `approve_buyer` — two decisions, not one |
| `override_credit_limit` | store | ✅ | ✅ | ✅ | ✗ | Discovery 19 §2 — one gate, with an override. Every use logged |
| `record_ap_payment` | store | ✅ | ✅ | ✅ | ✗ | |
| `record_ar_collection` | store | ✅ | ✅ | ✅ | ✗ | |
| `write_off_receivable` | store | ✅ | ✅ | ✅ | ✗ | T-131. ⭐ **Manager too — Ian, 2026-08-28**, overriding v1's admin-only gate. The real control is identity, not rank: refused for whoever recorded the charge, so a write-off always takes two people. Rank was the weaker guard and it left an admin-less store unable to clear a debt it will never collect |
| `run_cutover` | org | ✅ | ✅ | ✅ | ✗ | T-134. ⭐ **ORG-scoped, not store** — the conversion is one org-level event and most of its steps belong to no store at all. ⚠️ The per-store discipline is not lost to that: a per-store step DEMANDS a `storeId` and writes one row per store, so a single tick still cannot hide a store nobody visited. Manager attests; the domain layer holds the purge and the opening entry to admin on top of this, because C2 and C5 are irreversible in practice |
| `approve_item` | org | ✅ | ✗ | ✗ | ✗ | T-148. ⭐ **Super-admin alone** — the only such row in this matrix. Ian, 2026-08-28: *"superadmin only can add 1 global item."* Admins and managers request; a super-admin decides. An item is the identity every price and supplier link keys on, and a duplicate is not a row you delete afterwards — it is a price history split in two |
| `manage_items` | org | ✅ | ✅ | ✅ | ✗ | T-145. The item master is org-wide master data — v1's per-store items are why the same product exists as 187 duplicate records. Same bar as `approve_supplier` |
| `record_supplier_invoice` | store | ✅ | ✅ | ✅ | ✅ | T-130. Logging a pending invoice moves no money — same bar as `create_expense` |
| `verify_supplier_invoice` | store | ✅ | ✅ | ✅ | ✗ | T-130. Ian, 2026-08-27: *"yes manager verifies receipts."* The verification IS the approval — recording the expense against a verified invoice still needs `approve_expense` too, so only a manager can complete the whole flow |
| `void_supplier_invoice` | store | ✅ | ✅ | ✅ | ✗ | T-130. Cascades through the existing expense-void primitive for every linked expense — never a reimplemented reversal |

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
| `close_period` | **org** | ✅ | ✅ | conditional | ✗ | ✅ **Ian 2026-08-25 — grantable, but only with ORG-WIDE store scope.** Keeps row 101 (admin *and* manager may close) true alongside row 114 (capabilities are store-scoped): a period is org-wide, so a manager closes only when their scope covers every store. A Lipa-only manager never closes Malvar's books |
| `post_journal_entry` (direct) | org | ✅ | ✗ | ✗ | ✗ | **Nobody posts by hand.** Entries come from source documents. Reserved for break-glass repair, logged |

## People

| Capability | Scope | super | admin | manager | staff | Notes |
|---|---|:--:|:--:|:--:|:--:|---|
| `enrol_staff` | store | ✅ | ✅ | ✅ | ✗ | Ian's list. **Staff only** — creating another manager is `manage_users` |
| `manage_users` | org | ✅ | ✅ | ✗ | ✗ | Creating/assigning roles at manager level and above. **See §Open 3 — this is the friction point** |
| `grant_capability` | org | ✅ | ✅ | ✗ | ✗ | Only an admin grants |
| `manage_attendance` | store | ✅ | ✅ | ✅ | ✗ | v1's `attendanceManager` grant, now a manager capability |
| `provision_clock_terminal` | store | ✅ | ✅ | ✗ | ✗ | T-159. ⭐ **ADMIN-ONLY** — Ian, 2026-08-29 (bible row 165), tightened from v1's manager-level `registerClockTerminalAction`. A provisioned terminal is the only principal permitted to read the credential mirror, so whoever may create one may read every enrolled template at that store. Deliberately NOT folded into `manage_attendance` (§7 rule 2). ⚠️ The cost is real and accepted: a manager cannot pair a replacement tablet without an admin |

## Configuration

| Capability | Scope | super | admin | manager | staff | Notes |
|---|---|:--:|:--:|:--:|:--:|---|
| `manage_store_settings` | store | ✅ | ✅ | ✅ | ✗ | *"Store settings tied to operation"* — Ian's words |
| `set_cash_policy` | store | ✅ | ✅ | **✗** | ✗ | The remittance cadence and un-remitted ceiling (T-152). Ian, 2026-08-29: *"configurable by admin."* ⛔ **Manager is deliberately ✗ while `manage_store_settings` is ✅** — the ceiling is the number a store's cash custody is *measured against*, so whoever is measured must not move it. A manager running late could otherwise raise it and watch the finding vanish. A risk limit is not an operating setting |
| `manage_price_lists` | org | ✅ | ✅ | ✗ | ✗ | Pricing is a commercial decision, not an operational one |
| `manage_fixed_assets` | org | ✅ | ✅ | ✗ | ✗ | |
| `run_depreciation` | org | ✅ | ✅ | ✗ | ✗ | **Scheduled, not clicked** — v1's stopped scheduler is DEF-044 |
| `manage_prepaid_items` | org | ✅ | ✅ | ✗ | ✗ | T-125. Separate from `manage_fixed_assets` on purpose — the asset register and the insurance policies are not the same trust |
| `run_amortisation` | org | ✅ | ✅ | ✗ | ✗ | **Scheduled, not clicked**, same as `run_depreciation`. v1's stopped scheduler is DEF-044 |
| `manage_chart_of_accounts` | org | ✅ | ✅ | ✗ | ✗ | The technical residue. Exactly what Ian was right not to hand over |

## Platform — super-admin only

| Capability | Scope | super | admin | manager | staff | Notes |
|---|---|:--:|:--:|:--:|:--:|---|
| `cross_org_access` | platform | ✅ | ✗ | ✗ | ✗ | **Break-glass.** Re-auth, stated reason, every use logged (bible row 114) |
| `view_franchise_sales` | platform | ✅ | ✗ | ✗ | ✗ | The franchisor view — **sales only**, never their costs or profit (ADR-008 §5) |

---

## ✅ Open cells — all closed

*`set_credit_limit` (manager too) and `close_period` (org-wide scope required) closed 2026-08-25;
`manage_users` closed by §B.1. **Every cell in the matrix is now decided.***

*(The third, `manage_users`, was closed by §B.1 — the grant-time fallback covers it.)*

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

✅ **DECIDED 2026-08-25 — Ian: *“go with the safe version.”***

## B.1 It also resolves §Open 3, which I had left as friction to live with

I flagged that a franchise owner (a `manager`) could not appoint a manager for a second store,
because `manage_users` sits with admin — correct today, but the first thing to chafe as a franchise
grows.

**The grant-time fallback answers it.** A manager created in an org with **no admin** receives the
elevated grants at that moment — and `manage_users` is one of them. So a franchise owner running
their own org *can* appoint their second store's manager, without any inferred rule and without
Ian in the loop.

When they later hire a dedicated admin, those grants are revoked in the single deliberate action
§B already describes.

> **Ian's instinct was right and mine was too narrow.** I had treated "no admin in this org" as a
> gap to be covered by Ian; it is better read as a *state the org is legitimately in*, which
> deserves its own grant set. The only thing that needed changing was **when** the question is
> asked — once, at appointment, instead of on every check.

**§Open 3 is therefore closed.** The two remaining open cells are `set_credit_limit` and
`close_period`.

## B.2 The authority chain — Ian, 2026-08-25

> *"Only super-admin can assign admin. Once admin is assigned, admin can then touch managers'
> access level. When an admin is deactivated or removed, managers' access won't change unless
> ticked by super-admin."*

✅ **Adopted. This completes §B rather than amending it**, and it closes a gap I had left open.

| | Who may do it | Why that one |
|---|---|---|
| **Assign an org's admin** | **Super-admin only** | Who runs an org is a commercial decision, not an operational one. It also stops an admin minting a peer admin — a lateral move that would be invisible from above |
| **Set a manager's access level** | **That org's admin** | Each tier manages the tier below. No one reaches past their own level |
| **Re-elevate managers after an admin leaves** | **Super-admin, by an explicit tick** | The right person by elimination: at that moment the org **has no admin** to do it |

**The gap this closes.** §B said grants are unaffected by anyone's departure — true, but silent on
what happens when an org genuinely now has no admin and its managers were never elevated. Ian's
answer supplies it: **super-admin ticks it, deliberately.** Nothing infers, nothing escalates, and
the action lands on the only role that still exists.

### ⭐ One addition: the absence of a change must be VISIBLE

Not granting automatically is right. **Not noticing is not.**

An org can now sit with **no admin and un-elevated managers**, and nothing says so — until someone
cannot do their job, probably at month end, probably while closing.

> **So deactivating an admin raises a notice to super-admin: *"Org X has no admin. Its managers do
> not hold elevated grants. Elevate them?"*** A prompt, never an action.

That keeps the safety property whole — **nothing changes without a human deciding** — while
removing the failure it would otherwise create: a quiet gap nobody is looking for. **A design that
refuses to escalate silently should also refuse to degrade silently.**

### Worth being conscious of, not fixing

Two things now depend on Ian personally: **assigning an admin**, and **re-elevating managers**.
That is correct at this scale — both are rare and both are genuinely his decisions. It is worth
saying out loud only so that if a franchise ever needs an urgent change while he is unreachable,
nobody is surprised by it. **A known dependency, not a flaw.**

---

# C. Two findings from the T-121 implementation — 2026-08-25

## C.1 ⚠️ `manage_users` cannot express the authority chain on its own

**Bible row 116:** only **super-admin** assigns an org's **admin**; that admin then sets
**managers'** access.

**But `manage_users` is one boolean.** An admin holding it can, as far as `authorize()` is
concerned, assign *any* role — including another admin. That is precisely the lateral move row 116
exists to prevent, and it is invisible from above.

**Not fixable inside `authorize()`**, which answers *"may this actor use this capability?"* and
correctly says yes. The missing check is about the **target**: *assigning the `admin` role
additionally requires `super_admin`.*

> **The rule, stated so the next person does not have to rediscover it: a capability answers
> "what may you do", never "to whom". Where the target's own level matters, the check belongs at
> the call site and must be tested there.**

**Resolution:** the role-assignment server action carries that extra condition, with its own denial
test. Recorded here because the screen does not exist yet and this is exactly the kind of
requirement that gets lost between tasks.

## C.2 ⚠️ An admin currently has NO store scope — resolved: materialise rows at assignment

The implementer took *"v1 lets admin bypass store scope, v2 should not"* literally and gave admin
no structural bypass. **Correct, and it exposes a gap I left:** an admin appointed today is
authorised for **nothing store-scoped** until someone grants them store rows. That contradicts
*"org admin = org-wide control"* (bible row 114).

**Both halves are right; the resolution is the one already used for grants (row 115):**

> **Assigning the admin role materialises a `person_store_scope` row for every store in that org,
> at assignment time.** It stays **rows, never a bypass** — so *"who can see Davao?"* is still a
> `select` — and the admin has genuine org-wide control from the moment they are appointed.

**The consequence that is easy to miss:** a store created *later* appears in nobody's scope. So
**creating a store must add scope rows for that org's existing admins** — otherwise a new branch is
invisible to the person who just opened it, and the failure looks like a permissions bug rather
than a missing row.

*This is the same shape as row 115 and for the same reason: decide once, at the moment a human is
present, and store the answer — rather than inferring it on every check.*

---

# D. Period close — four things beyond the permission, raised 2026-08-25

Ian asked what he might be missing about `close_period`. The permission is the least of it.

### D.1 ⭐ The day AFTER a close is where the pain lands

Someone posts to the closed month, is rejected, and does not know why or what to do instead. The
correct path is a **prior-period adjustment into the current open period** — already built
(`reverseEntry`, row 101).

> **The rejection must name the PATH, not just the rule.** *“Period 2027-01 is closed”* tells a
> cashier they have failed. *“Period 2027-01 closed on 15 Feb. Record this as a prior-period
> adjustment dated today — it will carry into February with its original date noted”* tells them
> what to do.

**An error message that only states the rule sends people looking for a workaround**, and in an
accounting system the workarounds are all worse than the rule.

### D.2 A close is IRREVERSIBLE and must never look like Save

Row 101: a closed year is never reopened. If the control sits among ordinary actions with ordinary
styling, someone clicks it on the 3rd instead of the 15th — and there is no undo.

It needs confirmation naming **which period** and **what becomes impossible**, in the way the
purge script demands the database name typed back. **Ceremony proportional to consequence.**

### D.3 Closing is ORG-wide; managers are STORE-scoped — a coordination problem, not only a permission one

A manager needs org-wide store scope to close (§Open 2's resolution). But the deeper issue is that
**Lipa closing stops Malvar posting.**

- Whoever closes should see **whether the other stores are actually finished** — unposted drafts,
  unverified sales days — before the button is available.
- The other stores should be **told it happened**. Discovering it by rejection is discovering it
  the worst way.

### D.4 A BLOCKED close must be louder than a successful one

If the trial balance does not tie, or a store still has drafts, the close is refused. **Then
nothing happens — and nothing happening is silent.** The month stays open, and it is noticed in
February.

**A refused close should raise something a person sees.** Success can be quiet; failure cannot.

### D.5 One sequencing note

**December and the year both close on 15 January** (ADR-006) — **December first, then the year.**
The year close gates on *“no earlier period still open”*, so the order is forced; it is the one
month where two closes stack, and the only month where getting the order wrong blocks both.

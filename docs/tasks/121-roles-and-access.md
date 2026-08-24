# T-121 — Roles and access: the structure is mine, the matrix is Ian's

> **Status:** ⏸ **Structure proposed 2026-08-25. The capability matrix needs a session with Ian
> BEFORE Wave 1 builds screens that gate on it.**
> **Depends on:** T-120 (done — the org boundary already holds).
> **Written by:** Opus planner, from `docs/discovery/04-auth-and-permissions.md`.

## Answering the question directly

Ian asked whether roles need their own discussion. **Yes — but only for the *content*.** The
*structure* does not need one, because v1 already answers it and the answer is largely good.

**What I can decide:** the shape — how roles, stores and grants compose, and where each is
enforced.
**What only Ian can decide:** which role may do what. That is a business judgement about who he
trusts with what, and no amount of reading v1 substitutes for it.

**The timing matters more than the meeting.** Wave 1 (expenses, sales day) builds screens that
gate on this. A matrix agreed *after* those screens exist means retrofitting gates onto working
code — the same "cheap per-table, expensive in bulk" problem RLS had. **One hour with Ian before
Wave 1 is worth a week after it.**

---

## What v1 already gets right, and is therefore a requirement

**Two vocabularies, deliberately separate** — and v1's own source says so in a comment
(`src/types/position.ts:15`):

| | |
|---|---|
| **Role** — `admin` / `manager` / `staff` | What you may do **in the system** |
| **Position** — Cashier, Cook, Server, Dishwasher, Slicer, Inventory Staff | What job you do **on the floor** |

**Keeping these apart is correct and worth defending.** Conflating them is the classic mistake:
the moment "Cashier" becomes a permission, every new job title becomes a permissions change, and
every permission change becomes an HR conversation.

Also preserved: **positions are multi-valued** (one person can be Cashier *and* Server); the
default position is **Server, the least privileged**, so an unconfigured user is not a risk; and
the **server action layer is the real boundary**, with the client used only for UX.

## What v1 gets wrong, and v2 must correct

### 1. ⚠️ `admin` is GLOBAL — and that is now dangerous

In v1, `isAdmin()` short-circuits `hasStoreAccess()` to true and appears as `isAdmin() || X` on
nearly every rule. Fine when one company owns every store.

**A franchise with a separate owner is live.** An admin of Ian's org must **never** be an admin of
Padre Garcia's, and vice versa.

**So `admin` becomes per-org. There is no global super-admin.** Ian is admin of his org; the
franchisee is admin of theirs. Cross-org visibility is the separate, explicitly-granted
franchisor view (ADR-008 §5) — **never a role that happens to see everything.**

### 2. Permissions that do not permit — DEF-051 and DEF-052

`canAccessFinancialReports` hides the UI while the data stays readable. `canAcceptRemittance` has
**no locatable enforcement at all**.

> **The rule that kills this whole class: every grant must have a test proving the DENIAL fires.**
> A grant with no denial test is not a grant, it is a checkbox. This is the same lesson as
> Dolibarr's unchecked credit limit and v1's AP tile wired at three of eight write paths.

### 3. Grants as columns do not scale

v1 has five boolean columns plus `attendanceManager`, each added one at a time. Every new
capability is a migration and a schema change.

**Proposal: a `person_grants` table with the grant name from a closed enum in code.** Adding a
grant is then one enum value and one row — no migration — while still being typed and exhaustive.

---

## The proposed structure — three orthogonal axes

**They compose; none substitutes for another.** Access requires all three to pass.

| Axis | Question | Enforced by |
|---|---|---|
| **1. Organization** | *Whose books?* | **PostgreSQL RLS** — done (T-120). Not application code |
| **2. Store scope** | *Which branches within that org?* | Server-side, on the person; `all` is a value, not a bypass |
| **3. Role + grants** | *What may you do?* | Server-side capability check at every mutation |

### On store scope

v1 lets `admin` bypass it. **v2 should not** — a store list of "all" is an explicit, visible,
auditable value, whereas a bypass is invisible in the data and impossible to review. *"Who can see
Davao?"* should be a query, not a code reading.

### On roles vs a permission engine

**Fixed roles with an explicit capability matrix in code** — not a database-driven permission
engine. Bible §16.4 already rejects a workflow engine for the same reason: a configurable engine
moves the rules out of review and into runtime data, where nobody reads them and nothing tests
them.

The matrix lives in one file, is exhaustive over a typed capability union, and **fails the build
when a new capability is added without a decision for every role** — the same guard shape as T-119
and T-120. **No default.**

---

## What the session with Ian must produce

One table. Rows are capabilities; columns are roles; every cell is an explicit yes or no.

The starting list, taken from what v1 actually gates today:

`view_financial_reports` · `adjust_inventory` · `void_records` · `charge_staff` ·
`accept_remittance` · `manage_attendance` · `close_period` (admin + manager, already decided —
bible row 101) · `post_journal_entry` · `manage_users` · `manage_price_lists` ·
`dispatch_wholesale_order` · `override_credit_limit` (discovery 19 §4)

**Three questions to settle in that session**, because each changes the structure rather than a
cell:

1. **Does `manager` mean the same thing in a franchise as in Ian's org?** I would say yes — a
   franchise owner is a branch owner of their own company (ADR-008 §6), and one role catalogue
   applied within an org boundary is simpler than two.
2. **Should any capability be store-scoped rather than org-scoped?** E.g. a manager of Lipa
   approving only Lipa's voids. v1 gates by store access, so probably yes — but it is worth
   confirming, because it doubles the size of every check.
3. **Who may grant a grant?** v1 says admin only. With per-org admin that stays workable, but a
   franchise admin granting themselves financial access to their own org is now *correct* rather
   than a hole — worth saying out loud once so it is not later mistaken for a bug.

## Out of scope

Attendance-specific adjudication (Phase 4) · the customer principal, which has no role at all and
is deliberately not part of this matrix (ADR-008 §10) · any UI.

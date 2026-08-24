# T-120 — Row Level Security: org isolation the database enforces

> **Status:** spec ready. **Depends on:** T-119 (running — both touch the schema; do not run them
> in parallel). **Blocks:** every Phase 2 table.
> **Written by:** Opus planner, 2026-08-24. Bible row 112, ADR-008 §9–§10.

## Goal

Make it **impossible** for one organization's rows to reach another, by putting the rule in
PostgreSQL rather than in every query.

## Why now, and why this is the expensive one to defer

`WHERE org_id = :org` on every query works until **the one query that forgets** — and that query
will exist. It will be written months from now, by someone who did not know the rule, in a report
or a script or a fix at 11pm. That is application discipline, and **discipline is not a control**.

**A franchise with a separate owner is already live** (Padre Garcia, ADR-008 §7). The failure mode
here is not a broken page — it is **showing one business owner another business owner's books**.

**Adding a policy as a table is created costs minutes. Adding twenty later costs a week and misses
one.** Phase 2 adds roughly a dozen tables. This is the last cheap moment.

---

## Scope

Create or modify **only**:

```
packages/db/src/rls/principal.ts          the principal type + set/clear on a connection
packages/db/src/rls/policies.ts           the policy generator, driven by a declared registry
packages/db/migrations/0011_*.sql         ENABLE ROW LEVEL SECURITY + policies, per table
packages/db/src/client.ts                 set the principal at the connection/request boundary
packages/db/src/index.ts                  re-export
tests/unit/rls-registry.test.ts           the coverage guard — no database
packages/db/tests/integration/rls.test.ts real Postgres, the isolation proofs
```

**Do not modify** the ledger tables' definitions, `postEntry`, `reverseEntry`, `packages/etl/**`,
`packages/etl-firestore/**`, or anything under `apps/`. Migrations `0000`–`0010` are applied and
are **never edited**. **Do not touch `PROJECT_BIBLE.md`.**

### ⚠️ Coordinate with T-119

T-119 is building the cutover classification registry and touches the same schema surface. **Read
its output before starting.** If both need a table registry, **they share one** — two registries
listing the same tables is exactly the second-source-of-truth failure both tasks exist to prevent.
Report it if you find the overlap; do not build a parallel list.

### ⚠️ DEF-039

Generate `0011`, then **immediately** run `packages/db/tests/migration-journal.test.ts`. The
migrator sorts by `when` and **silently skips** anything sorting earlier, exiting `0`.

---

## Contract

### 1. The principal — not merely an org

Three kinds of actor exist (ADR-008 §10), and the third is why this is a *principal* and not an
`org_id`:

```ts
type Principal =
  | { kind: 'staff';    orgId: string; personId: string }
  | { kind: 'customer'; customerId: string }        // external wholesale buyer — NO org, NO books
  | { kind: 'system' }                              // migrations, crons, the ETL
```

Set per transaction with `set_config('app.principal_kind', …, true)` and its companions — **the
`true` scopes it to the transaction**, so it is cleared at commit or rollback and cannot leak
through a pooled connection. That mechanism is already proven here: migration `0005` uses exactly
this pattern for the reversal exemption.

### 2. ⚠️ Connection-pool safety is the thing most likely to be got wrong

A pooled connection outlives a request. A principal set with session scope, or set and not cleared,
**serves the next request's queries under the previous user's identity** — and that failure is
silent, intermittent, and shows one owner another owner's data.

- **Transaction-scoped only.** Never `SET`, always `set_config(..., true)`.
- Set it **inside** the transaction that will use it, never before acquiring the connection.
- A query that runs with **no principal set** must return **nothing** from an org-scoped table —
  not everything. **Default deny, always.**
- **Invariant 8 proves this directly** by running a query with no principal.

### 3. The policies

For each org-scoped table: `ENABLE ROW LEVEL SECURITY`, then

- **staff** → rows where `org_id` matches the principal's org
- **customer** → **no policy at all** on most tables. Only the small set a wholesale buyer may
  touch (their own orders, order lines, invoices, statement) gets a `customer_id` policy
- **system** → a `BYPASSRLS` role for migrations, crons and the ETL

**Refusal is the default.** A new table without a policy is invisible to everyone but `system` —
which is the correct failure direction: a missing policy breaks a feature loudly rather than
leaking data quietly.

> **Test the direction of failure explicitly.** It is the difference between a bug and a breach.

### 4. `FORCE ROW LEVEL SECURITY`

A table's owner **bypasses RLS by default in PostgreSQL** — so the very role running the app may
ignore every policy while all the tests pass. `ALTER TABLE … FORCE ROW LEVEL SECURITY` closes it.

**This is the single most commonly missed step in a Postgres RLS setup, and it silently disables
the entire feature for the owner.** Invariant 9 exists solely to catch it.

### 5. The coverage guard — a unit test

Every table in the schema must either **have a policy** or be **declared exempt with a reason**
(reference data such as `accounts`, which is deliberately shared). An unlisted table **fails the
build**.

Same shape as T-119's guard, and the same rule: **no default class.** A default is a decision made
by whoever wrote the default, for data they have never seen.

---

## Invariants the tests must prove

**Coverage — unit, no database**
1. Every schema table either has a policy or a declared exemption with a non-empty reason.
2. An unlisted table **fails** — demonstrated with a deliberate probe, then reverted.
3. Every exemption names a table that exists.

**Isolation — real Postgres, two orgs seeded**
4. Staff of org A reading an org-scoped table see **only** org A's rows.
5. **A query with NO `WHERE org_id` returns only org A's rows** — the whole point: the forgotten
   filter is harmless.
6. Staff of org A **cannot INSERT** a row carrying org B's `org_id`.
7. Staff of org A **cannot UPDATE or DELETE** an org B row — it is not merely hidden, it is
   unreachable.
8. **A query with NO principal set returns ZERO rows** — default deny, never default allow.
9. ⭐ **The application's own database role cannot bypass RLS** — proves `FORCE ROW LEVEL SECURITY`
   is on. Seed org B, connect as the app role with org A's principal, assert org B is invisible.
10. The `system` principal (migrations, ETL, crons) **can** see everything — otherwise the migrator
    and the audit break.

**Pool safety**
11. Two sequential transactions on the **same pooled connection** with different principals each
    see only their own org — the principal does not survive into the next.
12. A transaction that **throws** leaves no principal set for the next user of that connection.

**Nothing else broke**
13. Every pre-existing test still passes, with the `system` principal where appropriate.
14. `postEntry` and `reverseEntry` still work unchanged under a staff principal.

## Out of scope

Roles and permissions **within** an org (T-121) · the franchisor's sales-only visibility (T-121) ·
the customer portal (ADR-008 §10 — only the policy shape is defined here) · any UI · Phase 2
feature tables.

## Done when

- [ ] Migration `0011` applies cleanly; re-running is a no-op; `migration-journal.test.ts` passes.
- [ ] All 14 invariants pass. **Invariant 2 and invariant 9 demonstrated failing first, and the
      output reported** — those two are the ones whose absence is invisible.
- [ ] `npm run typecheck` · `test` · `test:integration` green · `build` succeeds.
- [ ] No query anywhere gained a hand-written `org_id` filter to make a test pass. **If one is
      needed, the policy is wrong** — report it.
- [ ] Any spec defect **reported, not silently worked around**.

> **The measure of success:** delete a `WHERE org_id` clause from any query and nothing leaks.

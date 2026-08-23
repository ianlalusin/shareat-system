# ADR-001 — Database engine: PostgreSQL, not MariaDB

**Status:** Accepted (open to reversal by Ian — see "If we go MariaDB instead")
**Date:** 2026-08-22
**Decided by:** Opus, planner role
**Supersedes:** the engine choice in `ERP-rebuild/docs/MARIADB_REBUILD_PLAN.md`

---

## Context

ERP-rebuild already contains a written relational-rebuild plan:
`docs/MARIADB_REBUILD_PLAN.md` (236 lines). It is a good document and ERPv2 adopts
most of it. It specifies **MariaDB**. This ADR is the one place where ERPv2
deliberately diverges, so the divergence is recorded rather than silently made.

**Where the prior plan and ERPv2 already agree** — these are not in dispute and are
carried forward:

- Relational DB as transactional system of record; not a table-for-table Firestore clone
- Keep Next.js frontend, routes, components; replace the data loaders
- **Drizzle ORM** (or raw SQL) over a heavy Active-Record layer, because accounting
  and inventory need explicit, reviewable transactions
- Reuse the pure journal builders in `src/lib/financial/journal/builders/`
- Proper double-entry: `journal_entries` header + `journal_lines` debit/credit,
  every posted entry must balance
- Inventory ledger is truth; `item_balances` is derived in the same transaction
- Period-based payroll with immutable posted pay runs
- Closed fiscal periods block postings
- Reports derive from journal lines, not separate writable ledgers
- Keep Firebase Auth initially; ERP authorization moves to SQL

## Decision

**PostgreSQL 18** is the system of record for ERPv2.

## Rationale

The workload is an accounting + reporting system. The differentiators favour Postgres:

| Need | Postgres | MariaDB |
|---|---|---|
| **Materialised views** for report read-models (replacing Firestore projection docs — the single biggest source of drift bugs in v1) | Native | **Not supported.** Would require hand-maintained summary tables — reintroducing the exact "derived data maintained by a separate writer" pattern ERPv2 exists to eliminate |
| **Transactional DDL** — a failed migration rolls back whole | Yes | No. Partially-applied migrations leave the schema in an undefined state |
| Partial + expression indexes (e.g. index only unposted rows) | Yes | Limited |
| `EXCLUDE` constraints, rich `CHECK`, domains | Yes | Weaker |
| JSONB with indexing, for the genuinely schemaless leftovers | Strong | Adequate |
| Row-Level Security as defence-in-depth on `store_id` | Yes | No |
| Window functions for aging buckets, running balances, payroll | Strong | Present (10.2+), less complete |

The materialised-view gap is the deciding one. §4.2 rule 7 of the bible — *derived data
is a view, not a hand-maintained summary row* — is a direct structural fix for v1's
worst bug class. MariaDB cannot express that rule natively.

Secondary: Cloud SQL supports both, Drizzle supports both, so neither hosting nor
tooling constrains the choice.

## Consequences

- ETL targets Postgres types (`numeric`, `timestamptz`, `uuid`, enums).
- Report read-models are materialised views with a defined refresh strategy.
- `MARIADB_REBUILD_PLAN.md` remains a valuable reference for **everything except**
  engine-specific DDL. It is not deleted and not treated as wrong.

## The one real argument for MariaDB

Ian is concurrently running an **ERPNext/Frappe migration** (`webapps\MIGRATION`),
and **Frappe runs on MariaDB**. Choosing MariaDB for ERPv2 would mean one engine, one
set of ops knowledge, one backup story across both efforts.

That is a genuine operational argument, and it is Ian's call, not mine. It does not
change the technical assessment above, but it may outweigh it.

**A prior question sits underneath this one:** ERPv2 and the ERPNext migration may be
two solutions to the same problem. That should be resolved before Phase 1 — see
`docs/decisions/OPEN-DECISIONS.md`, item 0.

## If we go MariaDB instead

The change is contained, if made **before Phase 1**:

- Drizzle swaps dialect (`mysql-core` instead of `pg-core`); repository layer is unaffected
- `timestamptz` -> `datetime(3)` + explicit UTC discipline (the `Asia/Manila` helper
  becomes more load-bearing, not less)
- `numeric(14,2)` -> `decimal(14,2)` — equivalent
- **Materialised views must be replaced** by summary tables refreshed inside the
  source transaction, with a reconciliation job proving they have not drifted.
  Bible §4.2 rule 7 gets an explicit exception, and §12 gains a landmine row.
- Row-Level Security is unavailable; store scoping rests entirely on the repository layer

After Phase 1 the cost rises sharply. **Decide early.**

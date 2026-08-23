# Shareat System

Accounting-correctness rebuild of the Shareat ERP, on PostgreSQL.

> ## 🚀 Setting this up on a new machine?
> ### → Read **[HANDOFF.md](./HANDOFF.md)** first.
> In Claude Code, just run **`/handoff`**.
>
> It covers the full cold start: toolchain, cloning the reference repo, installing
> PostgreSQL, `.env.local`, verifying the build, and what to work on next.

---

## What this is

The existing system (`ERP-rebuild`, live, running a Philippine restaurant business) is
backed by Firestore. Discovery found its accounting is structurally broken: **it has no
nominal ledger.** Revenue and expense are never posted as journal legs, a single-leg entry
is treated as "trivially balanced", and the income statement is a hand-maintained scan
list. Most other defects are downstream of that one design choice.

**Shareat System is not primarily a database migration — it is an accounting-correctness project
that requires one.** PostgreSQL is the means; books you can trust are the end.

- **Postgres owns the truth. Firebase owns the edge.** Every entity's authoritative state
  lives in PostgreSQL. Firestore keeps only a narrow read-only mirror plus an append-only
  inbox, so clock terminals keep working offline.
- **Correct like ERPNext, simple enough for one business.** No multi-currency, no cost
  centres, no configurable tax engine — one company, PHP, store as the reporting
  dimension, PH tax rules written directly.
- **Rules held by construction, not by remembering.** Ten accounting invariants enforced
  as database constraints and CI tests, so a wrong entry is *impossible* rather than
  merely discouraged.

## Documentation

| Document | What it is |
|---|---|
| **[PROJECT_BIBLE.md](./PROJECT_BIBLE.md)** | **The authority.** Architecture, execution model, conventions, security, phases, and 67 logged decisions. Read before writing code. |
| [HANDOFF.md](./HANDOFF.md) | Cold-start guide for a new machine |
| [docs/BACKEND-ORIENTATION.md](./docs/BACKEND-ORIENTATION.md) | How the layers fit; a request traced end to end |
| [docs/plans/](./docs/plans/) | Phase plans — Phase 1 is the accounting spine |
| [docs/decisions/](./docs/decisions/) | ADRs, the chart-of-accounts alignment, open decisions |
| [docs/discovery/](./docs/discovery/) | Eight reports on the existing system |

## Stack

Next.js 16 · TypeScript · Tailwind · Drizzle ORM · PostgreSQL 18 · Firebase Auth (identity
only; authority lives in Postgres) · Vitest · GitHub Actions

## Local development

```bash
npm ci
cp .env.example .env.local     # then fill it in — see HANDOFF.md §4
npm run dev                    # http://localhost:9008
```

```bash
npm run typecheck
npm run test                   # unit
npm run test:integration       # needs a real Postgres
npm run build                  # stop the dev server first
```

## Non-negotiables

1. **`ERP-rebuild` is READ-ONLY.** Live production, owned by someone else. Never modify it.
2. 🚫 **Never build on the production droplet.** Builds run in CI; the server receives a
   finished artifact only. Build once, deploy many.
3. **Port 9008** for dev, **5435** for local Postgres. Nothing else.
4. **Money is never a float.** `numeric` in the database, integer centavos in code.
5. **No client-side-only authorization.** Every gate exists server-side.

Full list and reasoning in [PROJECT_BIBLE.md §2](./PROJECT_BIBLE.md).

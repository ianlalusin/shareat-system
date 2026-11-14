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
| **[PROJECT_BIBLE.md](./PROJECT_BIBLE.md)** | **The authority.** Architecture, execution model, conventions, security, phases, and the dated decision log. Read before writing code. |
| [HANDOFF.md](./HANDOFF.md) | Cold-start guide for a new machine |
| [docs/BACKEND-ORIENTATION.md](./docs/BACKEND-ORIENTATION.md) | How the layers fit; a request traced end to end |
| [docs/plans/](./docs/plans/) | Phase plans — Phase 1 is the accounting spine |
| [docs/decisions/](./docs/decisions/) | ADRs, the chart-of-accounts alignment, open decisions |
| [docs/discovery/](./docs/discovery/) | Reports on the existing system |

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
2. 🚫 **Never build on EITHER droplet — and know which is which (DEF-238).** `159.223.46.224`
   is **our production host** (`erp2.shareat.net`); `159.223.78.207` is the **old shared** box
   (ERPNext + the POS archive DB), which this project has never run on. Builds run in CI; the
   server receives a finished artifact only. Build once, deploy many.
3. **Port 9008** for dev, **5435** for local Postgres. Nothing else.
4. **Money is never a float.** `numeric` in the database, integer centavos in code.
5. **No client-side-only authorization.** Every gate exists server-side.

Full list and reasoning in [PROJECT_BIBLE.md §2](./PROJECT_BIBLE.md).

## System Overview — EGM blueprint

The code-bearing tree groups the ERP back office, POS till and fixture-backed Customer app above shared workspace packages. PostgreSQL owns business state. Existing Firebase adapters and terminal/client paths remain implemented; planned migration work is not a claim that they have already been removed.

This blueprint documents the inspected code. [PROJECT_BIBLE.md](./PROJECT_BIBLE.md) remains the project authority; the contracts below do not amend its decisions.

## Interface

- Root [package.json](./package.json) defines workspaces and operator/test entry points; [vitest.config.mts](./vitest.config.mts) separates root unit and real-PostgreSQL integration projects.
- The root unit project excludes POS and Customer unit suites; each app owns its separate Vitest configuration.
- The root has no application HTTP entry point; runtime routes and exported package symbols are indexed by child contracts.

## Subdirectories & System Boundaries

- [apps](./apps/README.md) — ERP, POS and Customer front ends, with independent app/build boundaries.
- [packages](./packages/README.md) — core, database, authentication, domain, ETL and integration adapters shared by front ends and scripts.
- [scripts](./scripts/README.md) — operator and scheduler entry points with guarded database, backup, import and reporting effects.
- [docs](./docs/README.md) — authority/navigation plus the code-bearing operational provisioning subtree.
- [firebase](./firebase/README.md) — isolated Firestore/Auth emulator harness and security-rule contract.
- [spike](./spike/README.md) — disposable offline experiments, excluded from shipped application imports.

Only code-bearing directories and their ancestors receive EGM contracts. Hidden/ignored/generated trees and test-only directories are excluded; documentation-only directories remain linked through their existing indexes. The website directory currently has no source contract.

## Invariants

- Apps import shared packages and never another app; packages never import apps.
- Preserve server authorization, organization/store scoping, exact Money handling and append-only financial history. Per-module contracts locate the enforcement; they do not prove an untested guard.
- Read-only reference repositories are requirements sources. All generated documentation lives in this rebuild.
- Application dev/start ports come from current workspace manifests: ERP 9008, POS 9009, Customer 9010. Local PostgreSQL uses 5435.
- Stop an app's dev server before building it. CI produces deployment artifacts; neither production droplet is a build host.

## Side Effects

- Root npm commands dispatch into apps, packages or scripts. They may serve HTTP, build local output, execute database migrations/jobs, or start tests; read the matching command contract before running it.
- Runtime modules may access PostgreSQL, Firebase, browser storage, native device bridges, file storage and background jobs as described by child contracts.
- This bootstrap writes Markdown contracts only. It does not execute operational jobs, change runtime configuration, commit, push or deploy.

## Verification

From the repository root, the configured verification entry points are:

- `npm run typecheck` — workspace TypeScript check.
- `npm run test` — ERP/shared unit and golden project.
- `npm test -w @shareat/pos` and `npm test -w @shareat/customer` — app-specific unit suites.
- `npm run test:integration` — integration/invariant suite against real PostgreSQL; coordinate access to the shared test database.
- `npm run build` — ERP build, only with its dev server stopped. Other apps own workspace build commands.
- [docs/SMOKETEST.md](./docs/SMOKETEST.md) — the actual running-app smoke procedure.

These are available commands, not claims that bootstrap ran them. Documentation verification rereads each contract and checks sections, coverage and relative link targets. Source scouting is bounded to 300 lines per implementation file and normally 50,000 bytes per directory; contracts identify partial coverage. Fresh-context subtree workers performed scouting directly within the four-agent concurrency limit. ERP's session helper required one disclosed follow-up beyond its directory byte budget. This bootstrap is an architectural index, not a complete code correctness or drift audit.

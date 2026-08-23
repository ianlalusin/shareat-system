# ADR-004 — One monorepo: `apps/` + `packages/`

| | |
|---|---|
| **Status** | Accepted 2026-08-23. Restructure done the same day, before T-102 |
| **Decision by** | Ian — "go in" (the Website), "move now" |
| **Follows** | ADR-003 (one backend, four front-ends) |

## Context

ADR-003 made PostgreSQL the single backend for four front-ends. That immediately raised a
question it did not answer: do the four apps live in one repository or four?

The reference systems answer it one way today — four separate repos — and the results are
documented in `docs/CROSS-APP-MAP.md` and `docs/DEFECTS-REGISTER.md`.

## Decision

**One repository, npm workspaces, `apps/` + `packages/`.** The Website is included.

```
packages/   core · db · domain · auth · ui      ← shared, one copy of each truth
apps/       erp 9008 · pos 9003 · customer 9004 · website 9007
```

No Turborepo or Nx until build times actually hurt. npm 11 workspaces are already present and
need no new tooling — *boring and standard beats clever* (bible §0.2).

## Why

**1. The schema is shared, and that is not negotiable.** Every front-end needs the Drizzle
schema, the repositories, the posting engine, and the single `authorize()` module. Across
separate repos that is either a published package with version bumps, or duplicated code.
For a solo operator both are pure overhead — paying coordination costs for a team that does
not exist.

**2. The existing defect list is almost entirely cross-repo drift.** This is the decisive
argument, and it is empirical rather than theoretical:

| Defect | Shape |
|---|---|
| A loyalty scope helper duplicated in POS and CUSTOMER, with a note to "keep identical" | two copies of one truth |
| Two rounding implementations inside POS alone — `money.ts` and an inline copy in `tax.ts` (DEF-003) | two copies of one truth |
| Three independently-synced sources of branch identity in the Website (DEF-010) | three copies of one truth |
| `dineInSales` semantics known in POS, assumed in ERP | one truth, two understandings |
| Six collections written by both POS and CUSTOMER (DEF-007) | no owner |

Every one is the same failure: a truth maintained in more than one place by remembering.
**A monorepo makes "keep identical" impossible to get wrong, because there is one copy.**
That is the bible's own principle — a rule held *by construction*, not *by discipline* (§4.4).

**3. Atomic cross-cutting change.** Add a column and update the two apps that use it in one
commit, one CI run, one review. Type errors across the boundary surface at compile time
instead of at runtime in production.

**4. Agents start cold.** One repo means one `CLAUDE.md`, one bible, one discovery corpus. A
session opening this project sees the whole system. That directly serves the handoff-document
approach this project already depends on.

## The cost, stated honestly

**This trades a coupling the filesystem enforced for one only a rule enforces.**

In separate repos, POS *cannot* import CUSTOMER's internals — there is nothing to import. In a
monorepo it is one relative path away, and doing it would silently rebuild the exact coupling
ADR-003 spent a day deleting.

> **The rule: an app may never import from another app.** Apps depend on `packages/`;
> packages never depend on apps. Recorded in bible §8.

It is worth accepting because the first kind of coupling has already cost real bugs, and the
second has not happened yet — but it is a real trade, not a free win. A lint rule enforcing
the import boundary should land before the second front-end does.

**Also accepted:** independent deploys need configuring rather than coming free (per-app build
targets, path-filtered CI), and the checkout grows.

## Why the Website is in, held loosely

It is the weakest case — Astro, static, a different toolchain, mostly marketing content. It
was included because store and menu data is domain data, and its three sources of branch
identity are precisely the problem a shared `stores` table solves.

If it fights the toolchain, **splitting the Website back out later is cheap.** Splitting POS
never would be. That asymmetry is why including it now is the low-risk direction.

## Consequences

- `db/` → `packages/db/`, `src/lib/{money,datetime,logger,env}` → `packages/core/src/`,
  the Next.js app → `apps/erp/`. Moved with `git mv`, so history follows.
- Imports become `@shareat/core/*` and `@shareat/db/*`. The old `@/lib/*` and `@db/*`
  aliases are gone.
- Packages ship **TypeScript source**, not a build artefact; `transpilePackages` compiles them
  as first-party code. No build pipeline until one is needed.
- Three resolvers must agree on the same paths — `tsconfig.json`, `vitest.config.mts`, and
  `next.config.js`. When adding a package, update all three.

## Verified at restructure

Typecheck clean · 45/45 unit · 25/25 integration against real Postgres · build clean ·
migration re-run is a no-op.

**One defect was found by doing this** (DEF-030): the migration runner's credential redaction
used a lazy regex that stopped at the first `@`, so a password containing `@` leaked its tail
to stdout on every run. Found by reading the migration output rather than grepping it for a
pass line. Fixed, with five tests.

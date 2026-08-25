# Shareat System

> ### 👉 New machine or fresh session? Run **`/handoff`**, or read [`HANDOFF.md`](./HANDOFF.md).
> It walks the full cold start: toolchain, cloning the reference repo, installing
> PostgreSQL, configuring `.env.local`, verifying the build, and what to work on next.

### 👉 Start with [`docs/RULES.md`](./docs/RULES.md) — every operating rule in one page.

**Then read [`PROJECT_BIBLE.md`](./PROJECT_BIBLE.md) in full before deciding anything.**
RULES.md is a digest that cites the bible for every rule; the bible wins any disagreement.

> Also read [`docs/GLOSSARY.md`](./docs/GLOSSARY.md) before naming anything. Several field
> names in this domain mean the opposite of what they look like — `dineInSales` is
> package-only, `takeOutSales` is a residual, `receiptSeq` is not a monotonic key.
>
> [`AGENTS.md`](./AGENTS.md) is the same orientation for non-Claude agents.

It is the authority on this project: architecture, execution model, data conventions,
security model, phase plan, and the landmines carried over from ERP-rebuild. It
outranks any habit, any prompt, and any preference of your own. If your task conflicts
with it, stop and say so — do not proceed and do not amend the bible yourself unless
you are acting as the Opus planner.


## WARNING — the four reference repos, their real names, and the trap

Docs call these "v1", "the legacy ERP", or "the reference repos". **None of them is named
`v1` on disk.** Worse, one is named as if it were this project:

| Referred to as | Actual path | Notes |
|---|---|---|
| **v1 · the legacy ERP** | `C:\Users\ianla\webapps\ERP-rebuild` | **The name lies.** This is the OLD, live production ERP. It is **NOT** the rebuild, despite being called `ERP-rebuild` |
| **POS** | `C:\Users\ianla\webapps\POS` | Live. Branch `sev5_advanced` |
| **CUSTOMER** | `C:\Users\ianla\webapps\CUSTOMER` | Live. Diner app |
| **the Website** | `C:\Users\ianla\webapps\Shareat Website` | Live. Astro — note the space in the folder name |
| **THIS project** | `C:\Users\ianla\webapps\shareat-system` | The rebuild. The only repo you write to |

**All four references are READ-ONLY. This project is the only one you write to.**

**Reading them needs no permission and no announcement.** Read freely and often — you cannot
break anything by reading, and guessing what the old system does is far more dangerous than
opening it. Read them as *requirements*, not as design (bible section 1.2b).

## ⭐ What am I doing? — read THIS, not everything

A task-to-document router. **Most work needs two or three of these, not the whole `docs/` tree.**

| If you are… | Read |
|---|---|
| **Starting cold / resuming** | `HANDOFF.md` — the resume point: what is done, what is in flight, what is next |
| **About to write any code** | `docs/RULES.md` (one page) — then the bible sections it cites for your area |
| **Naming a field, table or type** | `docs/GLOSSARY.md` — **first, always.** Several v1 names mean the OPPOSITE of what they look like |
| **Posting anything to the ledger** | `docs/POSTING-PATTERNS.md` — 41 verified examples. **Look it up; do not decide** |
| **Adding a table** | The build will stop you until you classify it in `packages/db/src/cutover/classification.ts` AND `packages/db/src/rls/registry.ts`. That is the guard working |
| **Adding a capability or a permission** | `docs/decisions/CAPABILITY-MATRIX.md` — and every ✅ needs a test proving the ✗ fires |
| **Asking “why is it like this?”** | `PROJECT_BIBLE.md` **§13**, the decision log — 135 rows, newest last. Then `docs/decisions/` for the ADRs |
| **Asking “what does v1 do?”** | `docs/discovery/` — 24 read-only findings. **Read v1 as REQUIREMENTS, never as design** |
| **Asking “what is already broken?”** | `docs/DEFECTS-REGISTER.md` — 61 entries |
| **Picking up a task** | `docs/tasks/NNN-*.md`, and `docs/plans/phase-2-source-documents.md` for the sequence |
| **Wondering what the business does that we have not covered** | `docs/CAPABILITY-GAPS.md` |

> **`PROJECT_BIBLE.md` and `docs/POSTING-PATTERNS.md` both open with a line-range table of
> contents.** Read the index, then `offset`/`limit` to the one section you need — neither is meant
> to be read whole, and the ranges are build-verified so they cannot misdirect you.

## The 60-second version

- **Postgres owns the truth. Firebase owns the edge.** Every entity's authoritative
  state lives in PostgreSQL. Firestore holds only a narrow, read-mostly mirror plus an
  append-only inbox, so clock terminals keep working offline.
- **Shareat System is a re-platform of `C:\Users\ianla\webapps\ERP-rebuild`, not a rewrite.**
  Same product, same business rules, new persistence layer.
- **`ERP-rebuild` is READ-ONLY.** Never edit it, branch it, or run git in it.
- **Never touch `C:\Users\ianla\webapps\inactive projects`.**
- **Opus plans, Sonnet codes.** No implementation without a written task spec in
  `docs/tasks/`.
- **Port 9008** for the dev server, **5435** for local Postgres. Nothing else.
- 🚫 **NEVER BUILD ON THE PRODUCTION DROPLET** (`159.223.78.207`). No `next build`, no
  compile step, ever. It has 4 GB RAM and runs the app; a build OOMs the box. **Builds run
  in CI; the server receives a finished artifact only.** Build once, deploy many.
- **Locally, stop the dev server before `npm run build`** — the build clobbers the `.next`
  the dev server is serving, producing unstyled pages and phantom errors.

## Where things live

| Path | What |
|---|---|
| `HANDOFF.md` | Cold-start guide for a new machine or fresh session |
| `docs/RULES.md` | **Every operating rule on one page** — the fastest way to start working |
| `PROJECT_BIBLE.md` | The authority. Wins any disagreement. |
| `docs/CROSS-APP-MAP.md` | **Living map** of every seam between POS / ERP / CUSTOMER / Website |
| `docs/CAPABILITY-GAPS.md` | **What the business does that the plan does not cover** — 33 unowned capabilities |
| `docs/DEFECTS-REGISTER.md` | Gaps and bugs found in the reference repos, fixed here, never at the source |
| `docs/GLOSSARY.md` | **Read before naming anything** — several field names mean the opposite of what they look like |
| `docs/discovery/` | Read-only findings from ERP-rebuild |
| `docs/plans/` | Phase plans |
| `docs/tasks/` | Task specs — one per unit of implementation work |
| `docs/decisions/` | ADRs |
| `packages/db/schema/` | Drizzle tables — the only place tables are defined |
| `packages/db/migrations/` | Generated SQL, committed, never edited after apply |
| `packages/etl/` | Firestore -> Postgres ETL, the specimen corpus, and the replay harness |
| `packages/db/src/repo/` | The only place SQL is written |
| `packages/domain/` | Business rules; owns transactions |
| `packages/domain/sync/` | Firestore publisher (mirror) + ingestor (inbox) |
| `packages/auth/` | The single `authorize()` module |
| `packages/core/` | money · datetime · logger · env — shared by every front-end |
| `apps/erp/` | ERP front-end, port 9008. `apps/{pos,customer,website}` reserved |

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

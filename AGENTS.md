# Shareat System — start here

**You are an AI agent working in this repository.**

1. Read **[`docs/RULES.md`](./docs/RULES.md)** — every operating rule on one page.
2. Then read **[`PROJECT_BIBLE.md`](./PROJECT_BIBLE.md)** in full before deciding anything.

RULES.md is a digest and cites the bible for every rule. **The bible wins any
disagreement** — if they differ, RULES.md is stale and that is a bug.

This file exists so that any agent — Claude Code, Codex, Cursor, or anything else — lands on
the same rules. It is a pointer, not a second source of truth. **`PROJECT_BIBLE.md` is the
authority**; if this file and the bible ever disagree, the bible wins and this file is a bug.


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
| **Asking “why is it like this?”** | `PROJECT_BIBLE.md` **§13**, the decision log — 131 rows, newest last. Then `docs/decisions/` for the ADRs |
| **Asking “what does v1 do?”** | `docs/discovery/` — 24 read-only findings. **Read v1 as REQUIREMENTS, never as design** |
| **Asking “what is already broken?”** | `docs/DEFECTS-REGISTER.md` — 60 entries |
| **Picking up a task** | `docs/tasks/NNN-*.md`, and `docs/plans/phase-2-source-documents.md` for the sequence |
| **Wondering what the business does that we have not covered** | `docs/CAPABILITY-GAPS.md` |

> **`PROJECT_BIBLE.md` and `docs/POSTING-PATTERNS.md` both open with a line-range table of
> contents.** Read the index, then `offset`/`limit` to the one section you need — neither is meant
> to be read whole, and the ranges are build-verified so they cannot misdirect you.

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

## The five things that will get you in trouble

1. **All four reference repos are READ-ONLY** — `ERP-rebuild`, `POS`, `CUSTOMER`,
   `Shareat Website`. Never edit, branch, or run `git` in them. Copy from them; keep what is
   clean, clean what is not, omit what is not needed, add what is missing. A defect you find
   there is **logged in [`docs/DEFECTS-REGISTER.md`](./docs/DEFECTS-REGISTER.md) and fixed
   here**, never patched at the source.

   **Read them freely — but read them as REQUIREMENTS, not as design** (bible §1.2b). Every
   feature exists because the business needed it enough to build it, and staff use it daily.
   The code may be wrong in its details; the *need* is proven. **They are authoritative about
   WHAT the business needs and never about HOW to build it.** So: do not dismiss a feature
   because its implementation is poor, and do not faithfully reproduce a flaw because "v1 is
   the oracle". **If a feature looks pointless, ask — never delete.**
2. **Never touch `C:\Users\ianla\webapps\inactive projects`** — retired work. Exclude it from
   every recursive search.
3. **An app may never import from another app.** Apps depend on `packages/`; packages never
   depend on apps. Breaking this silently rebuilds the coupling ADR-003 deleted.
4. **Never build on the production droplet** (`159.223.78.207`). It has 4 GB RAM and runs the
   app; a build OOMs the box. Builds run in CI.
5. **Locally, stop the dev server before `npm run build`** — the build clobbers the `.next`
   the dev server is serving, producing unstyled pages and phantom errors.

## Where to look

| Question | File |
|---|---|
| What are the rules? | `PROJECT_BIBLE.md` — **the authority, read in full** |
| What does this word mean? | [`docs/GLOSSARY.md`](./docs/GLOSSARY.md) — **read this before naming anything.** Several field names in this domain mean the opposite of what they look like |
| What is already broken? | [`docs/DEFECTS-REGISTER.md`](./docs/DEFECTS-REGISTER.md) |
| Why is it built this way? | `docs/decisions/` (ADRs) and bible §13 (the decision log) |
| How do the four apps connect? | [`docs/CROSS-APP-MAP.md`](./docs/CROSS-APP-MAP.md) |
| What am I building next? | `docs/plans/` and `docs/tasks/` |
| I am starting cold on a new machine | [`HANDOFF.md`](./HANDOFF.md) |

## How work is done here

- **Opus plans, Sonnet implements.** No implementation without a written task spec in
  `docs/tasks/` (bible §3). A spec names the exact files you may touch — **stay inside it**,
  and if you must go outside, say so explicitly in your report.
- **Pick the model for the task** (bible §3.1a). **Sonnet** is the default for delegated work:
  code reading, discovery, executing a spec, writing tests. **Opus** plans, reviews, and makes
  decisions. **Fable** is reserved for two cases only — a bug that has already survived a
  deliberate Opus pass, and genuinely intricate data-shape design. *"It was hard"* is not the
  bar for escalation; a systematic pass must have been made and failed. Equally, do not spend
  Opus on what Sonnet does well.
- **Research before planning** (bible §3.6). A new phase or module, or any data shape that is
  expensive to undo, gets a bounded research pass into how mature systems solve it *before*
  the plan is written — with a document under `docs/discovery/`. Research **informs**; it
  does not decide. The target is the midpoint (§1.1), so the output must name what we are
  **not** adopting and why, or it becomes a shopping list.
- **Tests before implementation**, and integration tests run against a **real** PostgreSQL,
  never a mock.
- **Verify, do not claim.** Run the command and report its actual output. A task reported
  complete with a failing gate is worse than one reported blocked.
- **Report spec defects; never silently work around them.** If a constraint cannot be built as
  specified, say so with the real error rather than substituting a weaker rule.
- **Definition of done** is bible §9: typecheck clean · unit tests · integration tests against
  real Postgres · **smoketested in the running app** · build succeeds with the dev server
  stopped · self-reviewed · committed.

> The smoketest is not ceremony. A green build and green tests have already shipped an app
> that could not start.

## Layout

```
packages/   core (money·datetime·logger·env) · db (schema·migrations·client)
apps/       erp 9008 · pos 9003 · customer 9004 · website 9007
docs/       decisions/ · discovery/ · plans/ · tasks/
```

Ports are reserved and never shared. Never pass a different `-p`.

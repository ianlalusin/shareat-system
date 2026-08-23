# Shareat System — start here

**You are an AI agent working in this repository. Read this file, then read
[`PROJECT_BIBLE.md`](./PROJECT_BIBLE.md) in full before doing anything else.**

This file exists so that any agent — Claude Code, Codex, Cursor, or anything else — lands on
the same rules. It is a pointer, not a second source of truth. **`PROJECT_BIBLE.md` is the
authority**; if this file and the bible ever disagree, the bible wins and this file is a bug.

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

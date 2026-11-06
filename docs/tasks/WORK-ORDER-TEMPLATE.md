# Work order template — for builders outside Claude Code

> **Who writes it:** the Opus planner (BOSS or a spec lane). **Who builds from it:** an AI coding
> app outside Claude Code (today: Freebuff, running DeepSeek or Nemotron) or a human.
> **Who checks it:** CI on the PR; a Codex audit of the open PRs' diffs every 12 hours; Claude fixes
> the findings (a Sonnet fixer, verified by Opus); then BOSS's merge queue. Ian, 2026-11-06.
>
> A work order is a task spec (`docs/tasks/NNN-*.md`) written so that a builder with **no memory of
> this project** can finish it from the file alone. Copy everything below the line into
> `docs/tasks/NNN-short-name.md`, using the number BOSS reserved, and fill every field. A field you
> cannot fill means the work order is not ready to hand out.

---

# T-NNN — <one-line title>

| Field | Value |
|---|---|
| Status | ready for builder · in build · in audit · merged |
| Planner | <session name> |
| Builder | <app and model, e.g. Freebuff / DeepSeek> |
| Branch | `wo/tNNN-short-name` (the builder creates it from `origin/main`) |
| Worktree | `C:\Users\ianla\webapps\wt-tNNN` (the builder creates it, and works only there) |
| Risk class | **low** (screens, docs, tests) · **medium** (domain logic, no money/auth/schema) · **high** (money, auth, schema) — high stays with Claude builders until Ian says otherwise |
| Numbers reserved | migration: none / `NNNN` · DEF: none / `DEF-NNN` · bible row: none (builders never write bible rows) |

## 1. Goal

What the business gets, in two or three plain sentences. Name the screen, the user and the moment.

## 2. Read first (and nothing else is required)

The exact files, with sections or line ranges. Always include:
- `AGENTS.md` (this repo's rules for non-Claude agents)
- `docs/RULES.md`
- the bible sections this task touches (§ numbers)
- `docs/GLOSSARY.md` entries for every domain word in this task

## 3. What to build

Numbered steps. Each step names its file and what changes there. Include function names,
props and return shapes where they are already decided. Say plainly what is **not** to be built.

## 4. Files you may touch

| File | Change |
|---|---|
| `path/to/file.ts` | new / edit — what |

⛔ **Any file not in this table is off limits.** If the task cannot be done inside this list, stop
and report why. Do not widen the scope yourself.

## 5. Tests that must pass

| Test | Proves |
|---|---|
| `path/to/new.test.ts` — "<test name>" | <behaviour> |

Plus, every time:
```bash
npm run typecheck
```
```bash
npx vitest run <the test files above>
```
Integration tests run against a **real** Postgres test database, never a mock (bible §9).

## 6. Done means

- [ ] Every step in §3 built, inside the §4 file list only
- [ ] Every §5 test written and passing; typecheck clean
- [ ] Smoketested in the running app (`npm run dev` in `apps/erp`, port 9008), with what you saw written in the PR
- [ ] One commit per logical step; messages say what and why
- [ ] Branch pushed; **one PR opened** against `main`, its body listing the §5 command output
- [ ] **Stop there.** You do not merge, deploy or close anything

## 7. Forbidden — every work order, no exceptions

1. ⛔ **Never merge, rebase onto, force-push or delete any branch except your own `wo/` branch.**
   Never push to `main`. Never enable auto-merge.
2. ⛔ **Never work in `C:\Users\ianla\webapps\shareat-system` itself.** That checkout is shared by
   other sessions and holds the owner's uncommitted files. Do not switch its branch, stash, reset,
   clean or commit there. Work only in your own worktree (header table).
3. ⛔ **Never run `git worktree remove --force` or `rm -rf` on a worktree.** Worktree links reach the
   main checkout and have deleted real source files three times. When finished, leave the
   worktree in place; Claude cleans it up.
4. ⛔ **Never invent a number**: no migration, DEF, task or bible row number unless the header table reserves it.
   Migrations are hand-written, numbered strictly in order, and need the full test suite.
5. ⛔ **Never edit the reference repos** (`ERP-rebuild`, `POS`, `CUSTOMER`, `Shareat Website`) or
   anything under `inactive projects`. Read them freely.
6. ⛔ **Never hard-code a business value** (a price, a limit, a rate, a name). It belongs in the
   database with an ERP screen (Ian, 5 Nov). Only file formats are constants.
7. ⛔ **Never edit `PROJECT_BIBLE.md`, `docs/DEFECTS-REGISTER.md` decisions, or `knowledge/`.** Report
   findings in the PR body instead; the planner records them.
8. ⛔ **Never touch a production server.** No SSH, no deploy, no build on either droplet.

## 8. If you get stuck

Stop and write the problem at the end of this file under **Builder notes**: the step, the exact
error output, and what you tried. Push that and open the PR as a draft. Do not guess around a spec
defect. A blocked report is better than a silent workaround.

## 9. Audit checklist (for the Codex 12-hour audit and the Claude fixer, not the builder)

The audit runs on the PR **before** it is queued, so nothing unaudited reaches `main`. Findings go
to BOSS; a Sonnet fixer pushes fixes to the same `wo/` branch; Opus verifies; BOSS queues it.


- [ ] Diff touches only §4 files
- [ ] Every §5 test exists, asserts the behaviour (not just "runs"), and passes in CI
- [ ] No §7 rule broken (numbers, hard-coded values, other branches, bible/knowledge edits)
- [ ] Matches the bible and glossary names
- [ ] Money, auth or schema touched? Then the risk class was wrong; stop and send back to the planner
- [ ] Findings reported to BOSS; PR queued only when the audit is clean

## Builder notes

<!-- the builder writes here -->

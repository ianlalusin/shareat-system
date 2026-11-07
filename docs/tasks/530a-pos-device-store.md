⛔ **BLOCKED — the work order has no spec body. No code was written, no test was run.**

Claimed by DeepSeek deepseek-flash, 2026-11-07 12:40 (Asia/Manila).

---

# RE-OPENED (BOSS, 7 Nov): an earlier attempt left a BROKEN worktree wt-t530a (0 tracked files) and a local branch wo/t530a-pos-device-store. Do NOT reuse either. Use branch wo/t530b-pos-device-store and worktree C:\Users\ianla\webapps\wt-t530b, cut fresh from origin/main, and run the worktree completeness check (BUILDER-PROMPT.md step 5) before editing.

## T-530a — POS v2 device store: the tablet's offline outbox and snapshot cache (IndexedDB)

| Field | Value |
|---|---|
| Planner | POS design lane (Opus), for BOSS, 7 Nov 2026 |
| Builder | DeepSeek deepseek-flash, 2026-11-07 (re-opened attempt — BLOCKED, see below) |
| Branch | `wo/t530b-pos-device-store` (the RE-OPENED note renames it from `wo/t530a-pos-device-store`; created from `origin/main` at `6a4ccc1`) |
| Worktree | `C:\Users\ianla\webapps\wt-t530b` (the RE-OPENED note renames it from `wt-t530a`) |
| Risk class | **medium**: client-side storage logic with tests. No money arithmetic, no database schema, no sign-in or permissions. A bug here could lose an unsent sale, so the tests are strict |
| Numbers reserved | migration: none · DEF: none · bible row: none |

### Builder notes — BLOCKED at step 1: there is no brief

**The step.** "Read the whole work order, then build it." There is nothing to read.

**The exact state.** The file in `open\` was 3,393 bytes and contained only the RE-OPENED note
above, the header table, and the **previous attempt's** Builder notes. It has no

- §1 Goal,
- §2 Read first,
- §3 What to build (the API, the behaviour, the rules),
- §4 Files you may touch,
- §5 Tests that must pass,
- §6 Done means / §7 Forbidden / §8 If you get stuck.

The coord copy of this same order (`C:\Users\ianla\webapps\shareat-coord\docs\tasks\530a-pos-device-store.md`, 3,035 bytes)
is the same document: header table + the old attempt's notes, no spec. It is not a second, fuller copy.

**What I tried, and what it found.**

1. Read the `open\` file in full (46 lines) — header table, then the old attempt's notes. No spec.
2. Read the coord copy at `shareat-coord\docs\tasks\530a-pos-device-store.md` — same content, no spec.
3. `git -C shareat-system log --all --oneline -- "docs/tasks/530*"` — **no commits**. No version of the
   spec was ever committed to this repository.
4. `git branch -a | grep 530` — only the old local branch `wo/t530a-pos-device-store`, and
   `git log wo/t530a-pos-device-store --oneline -5` shows it points at `f1a6a02` ("docs(T-524): POS v2
   domain spec (#170)"), an old `main` commit. The branch carries **no commit of its own**, so there is
   no spec in its history either. `git ls-remote --heads origin "wo/t530*"` — the branch was never
   pushed.
5. Looked in the broken `C:\Users\ianla\webapps\wt-t530a` for the previous builder's copy of the
   work order: `docs\tasks\530*` does not exist there. The directory does contain the previous
   attempt's **uncommitted** `apps\erp\src\lib\pos-device\` files (`types.ts`, `db.ts`, `outbox.ts`,
   `snapshot-cache.ts`, `verifier-store.ts`, `meta.ts`, `index.ts`, `README.md` and four `.test.ts`
   files, plus `apps\erp\tests\helpers\fake-idb.ts`). Its `git ls-files` is 0 — the index is broken.
   The RE-OPENED note forbids reusing that worktree or branch, and those files are the previous
   attempt's unapproved guess at the spec, so they are **not** a substitute for the brief.
6. `shareat-coord` is not a git repository (`fatal: not a git repository`), so the earlier copy of the
   file cannot be recovered from history there.

**Why I stopped rather than rebuilt it.** With no §3 (the required API and behaviour), no §4 (the
files I may touch) and no §5 (the tests), every one of those would be a decision the planner has to
make, not the builder — a POS outbox that loses or double-sends an unsent sale is the risk this
order's own risk class names. Reusing the old attempt's uncommitted files would be adopting the very
work the RE-OPENED note declares void. RULES §3.4a is explicit: report a spec defect and stop; never
silently work around it.

**What BOSS needs to do.** Re-issue T-530a with its §1–§8 body (the previous attempt's file list at
the bottom of this copy is a starting point for §4, not a spec), or say "recover the files in
`wt-t530a`" explicitly and name that as the task. Either way the branch `wo/t530b-pos-device-store`
and worktree `wt-t530b` are disposable and were not modified beyond this document.

**Checks: none run, because there is nothing to check.** The worktree completed its completeness
check (`git ls-files` = 4,527 files) and `npm ci` was run in it, so the environment is ready for the
real build once the brief exists. No smoketest (nothing built).

---

### Previous attempt's notes (from the voided `wo/t530a-pos-device-store` attempt — kept for recovery only, not verified by this builder)

- `npm run typecheck`: passes (errors in other packages, not in pos-device files)
- `npx vitest run apps/erp/src/lib/pos-device`:
  - Test Files: 5 failed | 1 passed (15)
  - Tests: 10 failed | 5 passed (15)
  - verifier-store.test.ts: 4 passed (put, get by employee id, replace, delete, list)
  - db.test.ts: 1 passed (no IndexedDB → the plain refusal), 1 failed (opens version 1 with four stores — TypeError: Cannot read properties of undefined (reading 'contains'))
  - meta.test.ts: 2 failed (app keys round-trip; counters are off limits; setMeta rejects key without app. prefix — expected Error but got boolean from catch pattern)
  - outbox.test.ts: 4 failed (seq counting, racing enqueues, listPending not empty, countPending not 0)
  - snapshot-cache.test.ts: 3 failed (saveSnapshot is not a function; never blanks; usable window)
- `npx vitest run --project unit`: config not set up in this worktree; original T-528a had root vitest.config.mts
- No integration tests (no Postgres in this work order)

### Files the previous attempt built (its §4 claim — unverified)

- `apps/erp/src/lib/pos-device/types.ts` — type definitions
- `apps/erp/src/lib/pos-device/db.ts` — database opening with 4 stores
- `apps/erp/src/lib/pos-device/outbox.ts` — enqueue, reserveTerminalSeq, resumeAbove, listPending, countPending, applyResults, drain
- `apps/erp/src/lib/pos-device/snapshot-cache.ts` — save, touch, read, isUsable
- `apps/erp/src/lib/pos-device/verifier-store.ts` — put/getByEmployeeId/delete/listVerifiers
- `apps/erp/src/lib/pos-device/meta.ts` — getMeta/setMeta (app.-prefixed keys)
- `apps/erp/src/lib/pos-device/index.ts` — re-exports public API
- `apps/erp/src/lib/pos-device/README.md` — documentation
- `apps/erp/src/lib/pos-device/db.test.ts` — db tests (fake IndexedDB)
- `apps/erp/src/lib/pos-device/outbox.test.ts` — outbox tests
- `apps/erp/src/lib/pos-device/meta.test.ts` — meta tests
- `apps/erp/src/lib/pos-device/verifier-store.test.ts` — verifier store tests (4/4 passing)
- `apps/erp/src/lib/pos-device/snapshot-cache.test.ts` — snapshot cache tests
- `apps/erp/tests/helpers/fake-idb.ts` — copied from apps/pos

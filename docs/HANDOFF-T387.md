# Handoff: T-387 lane, 2026-10-11

This is the T-387 lane's handoff. The project-wide `docs/HANDOFF-TODAY.md` belongs to the orchestrator session,
which owns `main`, the bible and the roadmap.

## Where things stand
- All eight slices of T-387 are built. The task is "the ERP looks like the brand: SharEat Warm in light, Grill Night
  in dark" (spec: `docs/tasks/387-warm-theme-and-grill-night-dark.md`).
- **On `main`:** S1 (tokens, fonts, logo, warm neutral ramp), S2 (kit reshaped), S3 (missing kit) and S4 (toast,
  stamp, field errors). PRs #9, #11, #12, #13.
- **Open:** S8 (the sweep, 140 screens onto the kit) as PR #14. Its CI is re-running after test-only fixes.
- **Built but not pushed:** S5 (editorial dashboard), S6 (big order-status card) and S7 (staff ID-card wall and
  live roster). They sit on branch `release/t387-s5-s7`, which is stacked on S8, in worktree
  `C:\Users\ianla\webapps\wt-t387-s5`.
- Ian's go for every T-387 PR is "merge when green".

## Gates on `release/t387-s5-s7` (S8 + S5–S7)
- **typecheck:** 0 errors (`tsc -p apps/erp`).
- **unit:** 5466 passed / 7 failed / 3 skipped (5476).
  - 4 of the failures are real S5 guard breaks (t371 money comparisons and t374 current-instant). They are being
    fixed; see "Pick up here".
  - 2 are t343 load timeouts. They pass alone.
  - 1 is `packages/etl` capture, which reads this machine's `.env.local`. It also fails on S4, which is green on CI.
- **integration:** not run locally, because heavy files take over 10 minutes each on this laptop. CI runs the full
  suite on each PR. #14's last CI failure (3 files) is fixed. The S5–S7 integration tests ran green on their lane
  DBs: count-open-today, photo-file-ids, today-state.
- **build:** webpack build plus `next start` on 9008 for every slice's screenshots.

## What happened this session
- **Slices, in order: S1 → S2 → S3 → S4 → S8 (Workflow, 32 agents) → S5 ∥ S6 ∥ S7.**
  - Each slice ran tester, then builder, then auditor (Sonnet), with the Opus lead adjudicating.
  - Each was seen in the running app in both themes. The screenshots are in `docs/design/t387/seen/`.
- **Ian's decisions:**
  - All of these are recorded in the task doc's **Status** block: fix the colour clash (the warm neutral ramp),
    keep `#2b2210`, merge on green, make the active nav red, and demote extra primaries.
  - They are also in the bible as §13 rows 308–312, which the orchestrator (the planner) wrote on main in
    `59ace55`. ROADMAP.html was updated in the same commit.
- **Spec defects found and fixed:** these are listed in the same Status block.
  - `useFormStatus` exists in the App Router (bundled React 19). The `react-dom` 18 that Vitest loads lacks it.
  - The "RLS store ✗" wording in S5 was wrong.
  - The S6 exit-step rule.
  - S7's refusal rule.
  - Guards that were blind to the kit components.
- **Logged elsewhere:**
  - DEF-635, the setup SubmitButton comment. It is in the orchestrator's register.
  - `/staff` has no `authorize` on the roster read: DEF-636. It needs Ian's ruling.

## Pick up here
1. Finish S5's guard fixes (t371, t374) on `release/t387-s5-s7`. Commit, then rerun those two guards.
2. When #14 (S8) is green, merge it and tell the orchestrator (it rebases its PR #16 on #14). Then merge
   `origin/main` into `release/t387-s5-s7`, push, open the PR, and merge it when green.
3. T-387 follow-ups, unallocated (the spec's "Not in this task" list):
   - A per-day expense series for the dashboard.
   - A real branch-order walk on the status card. The fresh org has no commissary, so it was shown with kit
     markup.
   - Making "By channel" agree with typed (non-POS) sales.

## Do not decide these alone (Ian's)
- **Which capability may view the `/staff` roster.** Today any signed-in session can.
- **Whether a cancelled order's badge in the list** should be red like its status card. It is slate (closed) in
  lists and red in the card, which follows the spec's "side exits are red".

## Traps that bit today
- **Building in a worktree.** A worktree's `node_modules` is a junction, and Turbopack rejects it. Build with
  `next build --webpack --experimental-build-mode compile` then `generate`. Copy `.env.local` in BEFORE building,
  because `NEXT_PUBLIC_*` values are inlined at build time; without it the app shows a hydration mismatch.
- **Never `git checkout -- <file>`** to undo a mutant in an uncommitted tree: it wipes the real work too. Re-edit the
  exact text back instead.
- **`\b` inside a JS template literal is a backspace character.** Write `\\b`.
- **Never cap the caller census with `timeout`.** It truncated `docs/production-caller-baseline.txt` once (fixed in
  `ec195b5`).
- **Swapping raw controls for kit components** blinds source-reading guards. Teach the guard the kit tags; never
  lower the baselines.

## The paste-ready prompt
```
You are the T-387 lane on shareat-system (C:\Users\ianla\webapps\shareat-system). Read, in order:
docs/HANDOFF-T387.md (this lane's state; it is on branch release/t387-s5-s7 in worktree
C:\Users\ianla\webapps\wt-t387-s5), then docs/tasks/387-warm-theme-and-grill-night-dark.md (Status block).
Work only in your own worktree; never commit to or switch branches in the shared checkout (the orchestrator
session owns main). Ask the orchestrator (ListAgents → "Shareat-system orchestrator session") before using port
9008 or merging to main. Ian's go for every T-387 PR is "merge when green". Start at "Pick up here", item 1.
```

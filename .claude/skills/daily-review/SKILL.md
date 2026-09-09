---
name: daily-review
description: >
  Daily system-level review of shareat-system. Determines the diff since the last
  run (state in .claude/daily-review-state.json), runs the real gates FIRST to
  establish the baseline, reviews the diff against the bible's invariants —
  money paths, migrations, triggers, auth gates, task-spec scope — appends
  genuine defects to docs/DEFECTS-REGISTER.md, applies only narrow mechanical
  fixes, and commits everything (fixes, register edit, review docs) onto a
  daily-review/YYYY-MM-DD branch. Main is never touched. Writes
  docs/reviews/YYYY-MM-DD.md plus the paste-ready docs/reviews/NEXT-PROMPT.md.
  Use daily, or when Ian says "run the daily review".
---

# /daily-review — the daily system review

You are reviewing `C:\Users\ianla\webapps\shareat-system` — the rebuild, the only
repo that is ever written to. Work from the repo root.

**Read before reviewing anything, every run:**
1. `docs/RULES.md` — the operating rules. They bind this review too.
2. `docs/DEFECTS-REGISTER.md` — open items, row format, severity taxonomy, and the
   lessons in its `fixed` rows (they are this review's checklist ancestors).
3. `docs/GLOSSARY.md` — before trusting any field name in the diff.
4. The `PROJECT_BIBLE.md` sections for whatever the diff touches (§4 relational
   core, §5 hot lane, §6 money, §7 security, §9 done, §11 ETL, §16 accounting).
5. Any `docs/tasks/` spec named in the commits under review.
6. `docs/CAPABILITY-GAPS.md` — only when the diff lands near a listed gap.

**Standing constraints inherited from the bible — the review never overrides them:**
- The four reference repos are read-only. This review never opens a writer against
  them (settings.json also denies it).
- `PROJECT_BIBLE.md` is never edited here (§14). A needed amendment is a **finding
  addressed to the Opus planner**, reported in the review file — nothing more.
- Never commit to `main`. Never amend an applied migration. Never touch
  `webapps\inactive projects`.
- Verify, do not claim (§3.4a). Report every command's real output.

---

## 0. Preflight — refuse to run over an unmerged previous review

```
git branch --list 'daily-review/*'
git branch --merged main --list 'daily-review/*'
```

If any `daily-review/*` branch exists that is **not** merged into `main`:
**STOP. Do not review, do not write anything, do not update state.** Report
loudly: name the unmerged branch and tell Ian to merge it (or delete it if he
rejects its contents) before the next run. Running anyway would assign duplicate
DEF numbers and orphan the previous run's NEXT-PROMPT.md.

If today's branch `daily-review/YYYY-MM-DD` already exists but IS merged (a
same-day re-run), use `daily-review/YYYY-MM-DD-2`, `-3`, … instead.

## 1. Determine the range

State lives in `.claude/daily-review-state.json` (never committed — gitignored,
see below):

```json
{ "lastReviewedSha": "<sha>", "lastRunAt": "<ISO-8601>" }
```

1. Confirm the checkout is `main` with `git rev-parse --abbrev-ref HEAD`. If it
   is anything else, check out `main` and say so in the report.
2. `git rev-parse HEAD`. If the state file exists and
   `git cat-file -e <lastReviewedSha>` succeeds: the range is
   `lastReviewedSha..HEAD`.
3. If the SHA no longer exists (history rewrite): fall back to rule 4 and flag
   the rewrite itself as a ⚠️ finding — main should not be rebased.
4. **First run (no state file):** range is the last 24 hours —
   `git log --since="24 hours ago" --format=%H` → base is the oldest listed
   commit's parent. Never "today's commits": that misses yesterday-evening work
   and re-reviews on quiet days.
5. **First-run housekeeping** (do these once, when the state file does not yet
   exist): create `docs/reviews/` if missing, and add the line
   `.claude/daily-review-state.json` to `.gitignore` if it is not already there.
   The `.gitignore` edit is committed with the docs commit in §9 — never left
   dangling on main.
6. If the range is empty (quiet day): write a short review file saying so,
   refresh `NEXT-PROMPT.md` (open items carry forward), commit both per §9,
   update state, stop.
7. Note uncommitted working-tree changes if present. Do not review them line by
   line — record that they exist, whose files they touch, and that they are
   outside this run's range.

Record the reviewed HEAD **now**, before any branch exists. That SHA — not a
review-branch commit — is what goes in the state file at the end.

## 2. Run the gates FIRST — establish the baseline

Before reading a single diff hunk, run at the reviewed HEAD:

```
npm run typecheck
npm test
npm run test:integration
```

Then, **only if port 9008 is free** — check with
`netstat -ano | grep -E ":9008.*LISTEN"` (no output = free):

```
npm run build
```

If 9008 is occupied, do not build; the report line is
"build: skipped — dev server live on 9008" — a stated fact, not an unknown
(bible §2.9: a build under a live dev server produces phantom errors).

Report the **real** output of every gate: exact pass/fail counts, the actual
first errors. If Postgres on 5435 is unreachable, the run is **BLOCKED —
integration gate did not run**; that is the report. A run that reports clean
with a failing or skipped gate is worse than one that reports blocked.

**If the baseline is red:** the review still happens, but the review file opens
with `> ⚠️ BASELINE WAS ALREADY RED at <sha> — <which gates, first error>` as
its first line, failures are attributed to the pre-existing state rather than to
this range's diff unless the diff demonstrably caused them, and **auto-fix (§5)
is skipped entirely this run** — fixing on top of a red baseline makes "the fix
went green" unprovable.

Never touch port 9008's running server, or either droplet — `159.223.46.224` (our production
host, `erp2.shareat.net`) or `159.223.78.207` (the old shared box). DEF-238.

## 3. Review the diff as a system

`git log --stat <range>` then `git diff <range>`. Never judge a file in
isolation — for each change ask what it touches:

- **Invariants (§16 / T-109):** does any change weaken a trigger, constraint, or
  the draft-first posting order? An invariant phrased as "our code doesn't do X"
  instead of a database refusal is itself a finding (the DEF-041 lesson).
- **Money paths:** anything under `packages/core` money helpers,
  `packages/domain/src/ledger/`, or arithmetic on amounts. Floats near money is
  automatic ⛔. A second implementation of rounding/balance/immutability in
  TypeScript is a second source of truth — ⚠️ (RULES §6.3).
- **Migrations:** new files only ever append. A diff that edits an applied
  migration is ⛔ — report it, never "fix" it by further edits. Check
  `meta/_journal.json`: `when` strictly ascending, `idx` contiguous (DEF-039).
  Any new status value on `journal_entries` → check every trigger that switches
  on status (DEF-036).
- **Triggers and constraints:** dropped, relaxed, or newly bypassed? Does any new
  code write `journal_entries`/`journal_lines` other than through `postEntry`?
- **Auth gates:** changes in `packages/auth/` or anything moving a check
  client-side. Client-only authorization is ⛔ (§2.6).
- **App boundaries:** an app importing an app, or a package importing an app
  (§8 / ADR-004) — the boundary test should already catch it; confirm it still
  exists and passes.
- **Task-spec scope:** map each commit to its `docs/tasks/` spec. Files touched
  outside the spec's Scope list, unreported, are a finding. A spec listing
  `PROJECT_BIBLE.md` in Scope is a defect **in the spec** (RULES §1.14).
- **The bible itself changed?** Fine only if it is a planner amendment following
  §14 (version bump + §13 row). Otherwise ⛔.
- **Tests changed alongside code:** a test weakened, deleted, or rewritten in
  the same range that its subject changed deserves specific suspicion — was the
  test corrected, or silenced?
- **Naming:** new fields near the glossary traps (`dineInSales`,
  `takeOutSales`, `receiptSeq`) get checked against `docs/GLOSSARY.md`.
- **File map:** `docs/FILE-MAP.md` routes agents to code by topic. If the diff
  created, moved, renamed, or deleted files, or opened a new domain (e.g. the
  first file in `packages/auth/`), update the affected rows and the
  "Verified against" line. Rows POINT only — never write prose explanations
  into the map; the pointed-to file and the bible stay the authority. A row
  found stale is a 🔸 finding as well as an edit.

## 4. Classify

Use the register's taxonomy exactly — no new symbols, no numeric scores:

| Sev | Meaning |
|---|---|
| ⛔ | correctness / money |
| ⚠️ | structural risk |
| 🔸 | quality / maintenance |

A **register defect** is a genuine, durable flaw in the rebuild (or newly found
in a reference repo). A style preference, a nit, or "I'd have done it
differently" is a review-file note only. When unsure, it is a review note, not a
register row.

## 5. Auto-fix — deliberately narrow

**Skipped entirely if the baseline was red (§2).**

MAY fix, on branch `daily-review/YYYY-MM-DD` (create from the reviewed HEAD),
**one commit per fix**, message explaining *why*:

- type errors · lint errors · dead imports
- a failing test **where the fix is provable and the test goes green** — rerun
  the exact suite and show it

MUST NOT touch, ever — report only: `packages/db/migrations/**` · anything under
`packages/domain/src/ledger/` · auth or permission code · money arithmetic ·
`PROJECT_BIBLE.md`.

**Never modify a test to make it pass.** The fix goes in the code the test
exercises, or there is no fix. Sometimes the test really is what's wrong —
T-105 proved that cuts both ways — but deciding which side is wrong takes
judgement, and unsupervised judgement is not a fix: it is a register entry
naming both the test and the code it disagrees with.

After each fix, rerun the relevant gate against the baseline result. Not
provably green → `git revert` (or drop the commit), and the item becomes a
finding instead. **If a "fix" needs judgement, it is not a fix — it is a
register entry.** Never merge the branch; never commit to main.

## 6. Update the register

**Numbering:** the next DEF number is `max + 1` over every DEF-NNN found in
`docs/DEFECTS-REGISTER.md` on `main` **plus** the register as it appears on
every `daily-review/*` branch, merged or not
(`git branch --list 'daily-review/*' | xargs -I{} git show {}:docs/DEFECTS-REGISTER.md`
— tolerate branches where the file is unchanged). §0's refusal should make
unmerged branches impossible; this scan is the belt to that braces.

For each genuine defect, append to the matching section of
`docs/DEFECTS-REGISTER.md` (new rebuild findings → section E) in the existing
row format:

```
| **DEF-0NN** | Sev | **One-line summary.** Detail with `file:line`. | `reported` | What the rebuild should do about it |
```

- State is **`reported`** — `verified` means Ian read the code, not you.
- Add a dated line to the register's Change log:
  `| YYYY-MM-DD | DEF-0NN..: added by daily review (docs/reviews/YYYY-MM-DD.md). |`
- This register is the **single** flagged-item list. Never create a parallel
  findings doc.

## 7. Write `docs/reviews/YYYY-MM-DD.md`

```markdown
# Daily review — YYYY-MM-DD

> ⚠️ BASELINE WAS ALREADY RED at <sha> — <gates, first error>   ← only if §2 found it

## Range
`<base-sha>..<head-sha>` — N commits. (First run / quiet day / rewrite noted here.)

## What changed
By area, two lines each — which packages, which task specs.

## What was checked
The system lenses from §3 actually applied, and what each concluded.

## Gate results — baseline at <sha>
typecheck: <real result> · unit: <x/y> · integration: <x/y or BLOCKED + why>
· build: <result or "skipped — dev server live on 9008">
(If fixes were applied: the same line again, after fixes, on the branch.)

## Findings
Severity order, each with file:line and (if registered) its DEF number.

## Fixed
Branch `daily-review/YYYY-MM-DD`: one line per commit. Or "nothing
auto-fixable" / "auto-fix skipped — red baseline".

## Needs a human
Judgement calls, spec defects, test-vs-code disagreements, proposed bible
amendments (addressed to the planner), anything MUST-NOT-touch.

## FOR IAN
Plain language: what changed, what's broken, what needs your decision.
```

## 8. Write `docs/reviews/NEXT-PROMPT.md` — the primary output

Overwrite it every run. It must make sense to someone with **zero context** —
a fresh Claude Code session, cold. Shape:

```markdown
# Next-session prompt — generated by /daily-review on YYYY-MM-DD

You are working in C:\Users\ianla\webapps\shareat-system. Before doing anything,
read docs/RULES.md, then the PROJECT_BIBLE.md sections it cites for the areas
below. The bible wins any disagreement. Never write to the four reference repos.

This file was committed on branch `daily-review/YYYY-MM-DD` together with the
review docs, the defects-register update, and any fixes. If you are reading it
from that branch, merging the branch is the first order of business (after
reviewing its fix commits).

## Findings to address, severity order
1. ⛔ DEF-0NN — <summary> — <file:line> — <what to do / which spec governs it>
...

## Already fixed — do not redo
Branch `daily-review/YYYY-MM-DD` holds: <commits>. Review and merge it, or
cherry-pick; each fix was verified green against the baseline (<gate evidence>).

## Recommended next
What to pick up first and why, in one short paragraph. Open questions for Ian.
```

If a run has no findings and no fixes, the file still exists and says so, with
whatever remains open from previous runs.

## 9. Commit the outputs to the branch — never to main

Every run produces the branch, even a quiet one. On `daily-review/YYYY-MM-DD`
(created in §5, or created now if there were no fixes), after the fix commits,
add **one final docs commit** containing exactly:

- `docs/reviews/YYYY-MM-DD.md`
- `docs/reviews/NEXT-PROMPT.md`
- the `docs/DEFECTS-REGISTER.md` edit (if any)
- the `docs/FILE-MAP.md` row updates (if any)
- the first-run `.gitignore` line (first run only)

Message: `daily review YYYY-MM-DD: review docs + register`. Use explicit
`git add <path>` per file — never `git add -A` (a sweep of unrelated
working-tree files into this commit is precisely the accident this design
prevents). Nothing this review writes is ever left uncommitted on main — an
uncommitted NEXT-PROMPT.md is overwritten by the next run and silently lost,
and an uncommitted register edit is one stray `git add -A` away from landing in
an unrelated commit.

## 10. Finish

Check out `main`. Write
`{ "lastReviewedSha": "<reviewed HEAD from §1>", "lastRunAt": "<now>" }`
to `.claude/daily-review-state.json` (it is gitignored). Confirm `git status`
on main is clean apart from whatever uncommitted changes §1.7 found already
there and pre-dated this run. One thing exists to merge:
`daily-review/YYYY-MM-DD`.

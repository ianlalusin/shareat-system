---
name: wrap-up
description: >
  Ian's closing ritual for every AI agent on shareat-system. Triggered by
  "wrap up today's work" (or /wrap-up). Summarises everything done since the
  last wrap-up (state in .claude/wrap-up-state.json), runs the real gates,
  commits and pushes ALL outstanding work, and writes docs/HANDOFF-TODAY.md —
  the paste-ready prompt that lets the next session, human or agent, pick up
  cold. Nothing Ian said today is allowed to survive only in the transcript.
---

# /wrap-up — the closing ritual

**Ian's words:** *"When I say wrap up today's work, you summarize it after the last
summarization, you test everything done, commit and push every work, create a
handoff prompt — because that will be my closing line for all AI agents to work in
this project."*

So this runs **at the end of a working session**, and its job is that **nothing is
lost**: not the code, not the decisions, and not the reasons.

> ⭐ **The failure this prevents:** a session ends with work uncommitted, a decision
> Ian made living only in the transcript, and the next agent starting cold and
> re-deriving — or worse, re-deciding — what was already settled.

**This is NOT `/daily-review`.** That one is a critic: it reviews a diff for defects,
works on a branch, and never touches `main`. **This one is a closer**: it commits and
pushes the real work. They write different files and never clobber each other.

---

## 0. Orient

Work from `C:\Users\ianla\webapps\shareat-system`. Read `docs/RULES.md` if you have
not this session.

```
git rev-parse --abbrev-ref HEAD
git status --short
cat .claude/wrap-up-state.json 2>/dev/null
```

Range is `lastWrappedSha..HEAD` plus whatever is uncommitted. **First run** (no state
file): the last 24 hours, per `/daily-review` §1.4's reasoning — never "today's
commits", which misses yesterday-evening work.

⚠️ **If HEAD is not `main`**, say so and ask before pushing. A wrap-up that pushes a
feature branch nobody expected is a surprise, and surprises at the end of a day are
the worst kind.

## 1. Gates FIRST — before committing anything

```
npm run typecheck
npm test          ← check ${PIPESTATUS[0]}, NEVER trust `| tail`
npm run test:integration
```

Build **only if port 9008 is free** (`netstat -ano | grep -E ":9008.*LISTEN"`).
Occupied → the line is *"build: skipped — dev server live on 9008"*, a stated fact
(bible §2.9).

**Report the real numbers.** Not "tests pass" — `522/522`.

### ⛔ If the gates are RED

**Commit and push anyway.** This is deliberate, and it is the opposite of what a CI
pipeline would do:

- **Uncommitted work is invisible and easy to lose.** Committed red work is visible
  and easy to fix.
- Nothing deploys from `main` here. The cost of red on `main` is a message; the cost
  of lost work is the work.

**But then the handoff OPENS with it** — a `> ⛔ THE BUILD IS RED` banner as its
first line, naming the failing gate and the first real error, and **fixing it is item
1**. A wrap-up that buries a red build has done the one thing it exists to prevent.

## 2. Summarise since the last wrap-up

`git log --stat <range>` plus the uncommitted diff. Write it **by theme, not by
commit** — "what moved" beats a changelog.

⭐ **The part that matters most: DECISIONS.** For every one Ian made this session,
confirm it is recorded in the right durable place:

| Kind | Belongs in |
|---|---|
| A decision, with its reasoning | `PROJECT_BIBLE.md` §13 row (planner only, §14) |
| A defect found | `docs/DEFECTS-REGISTER.md` |
| A design or a requirement | `docs/tasks/NNN-*.md` |
| Something learned about v1 or the field | `docs/discovery/NN-*.md` |
| A trap in a name | `docs/GLOSSARY.md` — **and the banned-names test** |
| A task finished or advanced this session | its own `> **Status:**` line in `docs/tasks/NNN-*.md` — edit it directly, don't just say so in the handoff |
| **What is now done, and what is next** | **`docs/ROADMAP.html` — every wrap-up, no exceptions.** See below |

### ⭐ The roadmap is updated EVERY wrap-up — Ian, 2026-08-28

**Not "if it changed."** Every wrap-up opens `docs/ROADMAP.html` and makes it true
again before committing. It is the one document that answers *"where is this project
up to"* at a glance, and it is the first thing read by anyone who is not deep in the
task docs — which includes Ian.

What to change, concretely (it is hand-written HTML, so this is a real edit, not a
regenerate):

- A task that finished gains `t-done`: `<div class="task t-done">` — it is plain
  `<div class="task">` until you do. Its dot and border go green off that one class.
- A wave or phase whose state moved gets its chip changed: `c-queued` → `c-active` →
  `c-done`, with `c-part` for genuinely half-finished. One chip per header.
- A task whose *content* changed — scope cut, split in two, renamed — gets its
  `task-what` text corrected, not just its status.
- A task that was added or dropped this session is added or dropped here too.

⛔ **A roadmap that says a shipped task is queued is worse than no roadmap**, because
it is believed. On 2026-08-28 both T-129 and T-130 had shipped and both still read as
not-started — the exact staleness this rule exists to stop.

⚠️ **If nothing on the roadmap changed, say so explicitly** in the handoff
(*"roadmap: checked, nothing moved"*). Silence is indistinguishable from forgetting,
which is how it went stale in the first place.

**Anything Ian decided that is not yet written down, write it down NOW**, before
committing. That is the whole point of the ritual. ⚠️ If a decision is too big to
record safely (it needs a bible amendment you are not the planner for), **say so in
the handoff as an explicit unrecorded item** — never let it pass silently.

**If this session changed how a fresh machine gets set up** — a new env var, a new
local dependency, a new install or seed step — **update `HANDOFF.md` too**, not only
today's handoff. `HANDOFF-TODAY.md` is disposable; `HANDOFF.md` is the one a cold
start actually reads first, and it goes stale silently otherwise.

## 3. Commit and push everything

- **Before staging anything, scan for secrets.** This repo has a live `secrets/`
  directory at its root. `git status --short` must not show it, and nothing staged
  may touch `secrets/` or `.env*`. A file that matches gets unstaged and is called
  out in the handoff explicitly — never committed silently, never assumed fine.
- **Group by theme**, one commit per coherent change. Never one giant commit.
- **Explicit `git add <path>`.** Never `git add -A` blindly — look at
  `git status --short` first and account for every file. A file you cannot explain
  does not get committed; it gets mentioned in the handoff.
- Messages say **WHY**, and record what was tried and rejected. Follow the repo's
  existing style — read the last few `git log` entries.
- ⚠️ **Never commit to `main` if the repo convention says otherwise**; today it does
  not, so `main` is correct.
- Then `git push`. **Report the real result**, including a rejection. **If the push
  is rejected** (remote has diverged), stop: `git fetch` and look at what changed
  there, then tell Ian and ask how to reconcile. **Never `--force`.** A wrap-up that
  force-pushes over someone else's work is the exact failure this ritual exists to
  prevent.

## 4. Write `docs/HANDOFF-TODAY.md`

**Overwrite it every run.** It must work for someone with **zero context** — a fresh
session, cold, tomorrow morning.

```markdown
# Handoff — YYYY-MM-DD

> ⛔ THE BUILD IS RED — <gate>, <first error>. Fixing this is item 1.   ← only if §1 found it

## Where things stand
Two or three sentences. What is shipped, what is half-built, what is only designed.

## Gates at <sha>
typecheck · unit x/y · integration x/y · build (or why skipped)

## What happened this session
By theme. Include the decisions Ian made and WHERE each is recorded.

## Pick up here
The one thing to do next and why. Then the next two.

## Do not decide these alone — they are Ian's
Open questions, each with the recommendation already on the table.

## Traps that have actually bitten
The ones live in this area right now. Keep it short; the full list is the bible.

## The paste-ready prompt
```
<the literal text Ian can paste into a fresh session>
```
```

⭐ **The paste-ready block is the deliverable.** Keep it SHORT and make it point at
files — the `.md` files carry the detail, and a prompt that restates them will drift
out of date the moment they change.

## 5. Finish

1. Commit `docs/HANDOFF-TODAY.md` and push it. **The handoff is worthless uncommitted**
   — the next session may be on another machine.
2. Write `.claude/wrap-up-state.json`:
   `{ "lastWrappedSha": "<HEAD after push>", "lastWrappedAt": "<ISO-8601>" }`
   (gitignored, like the daily review's).
3. **Tell Ian, in the chat**: the gate numbers, what was pushed, the one thing to pick
   up next, and anything needing him. **Then give him the paste-ready prompt inline**
   so he does not have to open a file to get it.
4. If an unmerged `daily-review/*` branch exists, **say so** — it holds findings and a
   `NEXT-PROMPT.md` that the next session should merge first.

---

## The standing rules this ritual never overrides

- The four reference repos are **read-only**. `ERP-rebuild` is the OLD live ERP, not
  this rebuild — the name lies.
- `PROJECT_BIBLE.md` is amended only by the planner, per §14.
- Never touch `webapps\inactive projects`.
- **Verify, do not claim** (§3.4a). Every number in the handoff is one you actually
  ran.

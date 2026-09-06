# T-227 — the caller guard and the nav guard: two mechanical checks for one recurring defect

> **Status**: ✅ **BUILT 2026-09-06.** Specified first, per RULES rule 8; the record of the red
> first run is in *"What the first run actually said"* below.
>
> ⛔ **This task builds no feature.** It builds two unit tests and applies the two nav fixes their
> first red run names. Everything it checks was already checkable; nothing was checking it.
>
> ⭐ **Four defects came out of it, and only one was known going in**: DEF-192 (`/settings`, the
> seed), **DEF-197** (`/attendance/lane` reachable from nowhere), **DEF-198** (22 gated services
> with no screen, counted), and — from the smoketest, not the guards — **DEF-199** (24 of 66 routes
> scroll sideways at 390px) and **DEF-200** (seven report screens 500 for a super-admin). The last
> two are outside this task's scope and are logged, not fixed.

## Why this exists

Nine logged defects are the same defect: **something shipped, tested and green, that no screen can
reach.**

| | The shape |
|---|---|
| **DEF-107** | a nav entry pointing at a route with no `page.tsx` — a 404 in the menu |
| **DEF-133** | `provision_clock_terminal` + credential enrolment: engine, tests, no screen |
| **DEF-137** | `recordChannelSettlement` shipped with no screen, so every `1220` receivable a verified platform day raised had nothing that ever cleared it |
| **DEF-139** | `/statutory-discounts` built and tested, reachable only by typing the URL |
| **DEF-174** | the same shape again |
| **DEF-181** | two routes shipped from T-201, linked from nowhere |
| **DEF-186** | the same shape again |
| **DEF-190** | `recordCollection` / `voidCollection` / `writeOffCharge` — zero callers under `apps/`, so `1210` has a raising path, a reporting path and **no clearing path a human can reach** |
| **DEF-192** | `/settings` in `nav.tsx` today with **no `page.tsx` behind it** |

⭐ **Every one of them was found by a human opening a browser or running a grep by hand.** The
2,400-test suite went green through all nine, because a function with a test and no caller passes
its test, and a page with no link renders fine when you type its URL.

`docs/CAPABILITY-GAPS.md`'s *"The sweep that found these"* already records the method as a
reproducible manual audit and says the obvious next thing:

> ⚠️ **Both checks in 1 and 2 are mechanical enough to be tests rather than a periodic audit**, and
> `tests/unit/deferral-staleness.test.ts` (T-220) is the pattern to copy.

This task does that.

## Goal

Two unit tests in the normal `npm test` run: one that no nav entry points at a missing route and no
route is unreachable from nav, and one that no action-shaped domain export lacks a caller under
`apps/` without a named, written reason. Both fail today, for reasons that are live defects.

## Scope — files this task may create or modify

**Create**
- `tests/unit/nav-route-reachability.test.ts`
- `tests/unit/domain-actions-have-callers.test.ts`

**Modify**
- `apps/erp/src/components/nav.tsx` — the two fixes the first red run names (§5)
- `docs/DEFECTS-REGISTER.md` — DEF-192's disposition; one new row for the finding below
- `docs/CAPABILITY-GAPS.md` — the sweep section now points at the two tests

**Explicitly NOT in scope**
- ⛔ `PROJECT_BIBLE.md` (RULES rule 14 — only the Opus planner amends it).
- ⛔ `packages/domain/**` — no domain function is edited to satisfy a guard. An export the guard
  flags is either wired to a screen (a separate task) or exempted with a reason.
- ⛔ `packages/domain/src/attendance/**`, `tests/golden/**`, `apps/erp/src/app/attendance/**`
  beyond the single nav line in §5 — session `ianla-25` owns that area.
- ⛔ Building `/settings` as a hub page. See §5.

## Contract

### 1. What each check is, precisely

**Check A — `nav.tsx` → route.** Every `href:` literal in `apps/erp/src/components/nav.tsx`
resolves to a `page.tsx` under `apps/erp/src/app`.

**Check B — route → `nav.tsx`.** Every **non-dynamic** route (no `[param]` segment) under
`apps/erp/src/app` is *reachable*: it is a nav href, or it is linked from a file belonging to a
route that is itself reachable, transitively.

**Check C — action-shaped domain export → caller.** Every export under `packages/domain/src`
whose signature is **`(tx: Tx…, …, actor: Actor, …)`** has a word-boundary reference in production
code under `apps/`.

### 2. Why `(tx, actor)` is the definition of "money-or-state-moving"

⭐ **This is the load-bearing design decision in the task and it is worth stating, because the
obvious version of this guard is useless.**

There are **401** exported functions under `packages/domain/src` and **157** have no `apps/` caller.
Reporting 157 is reporting noise: most are correct. `planConsumption` is called by `postUsage`;
`compareQuantity` is arithmetic; `commitCountSession` *looks* uncalled and is not, because
`/inventory/counts` calls a wrapper named `commitCount`. A guard that fires 157 times fires zero
times, because the list gets an exemption entry per row and nobody reads it again.

The repo already carries the distinction the guard needs, in its own layering (bible §4.3, §13 row
138 — *"it always took `(tx, actor, …)` and never asked where the actor came from"*):

| Signature | What it is | Needs a screen? |
|---|---|---|
| `f(input)` / `f(a, b)` | pure computation — `computeDay`, `splitPayment`, `addQuantity` | no |
| `f(tx, orgId, …)` | plumbing another domain function calls — `loadBranchOrder`, `postEntry` | no |
| **`f(tx, actor: Actor, …)`** | **a user-initiated act.** It authorizes; it therefore presumes a human | **yes** |

Measured on 2026-09-06: **200** action-shaped exports, **30** with no `apps/` caller. That is a list
a person can read and judge — which is the whole difference between a guard and a wall of text.

⚠️ **Stated as the guard's known limit, not hidden:** a state-moving function that takes no `actor`
is out of scope for check C. That is deliberate — such a function is either called by one that does
take an actor (and is therefore covered transitively) or is a scheduler entry point (covered by
`tests/unit/findings-single-clock.test.ts` and the job's own registration). If a future defect
escapes through that gap, widen the rule and say so here.

### 3. Traps that must be handled, each of which has already cost this repo something

| Trap | Handling | Precedent |
|---|---|---|
| ⛔ **`apps/erp/.next` contains turbopack copies of the domain barrel and matches every symbol.** Scanning it makes every export look called | Enumerate files with `git ls-files`, which cannot see a gitignored build directory | `no-ungated-read-surface.test.ts` uses exactly this |
| ⛔ **Comments mention names and paths.** `/attendance/lane` appears in one comment and nowhere else; a raw text match would call it linked | Strip block and line comments before matching, both for link extraction and for caller matching | `no-ungated-read-surface.test.ts`'s `codeOnly()` — *"a guard that fires on prose describing the fix is a guard somebody eventually deletes"* |
| ⛔ **CRLF.** This repo checks out CRLF and JavaScript's `.` does not match `\r`, so a line-oriented scan can match **nothing** and pass | Normalise `\r\n` → `\n` before any line work | DEF-179; `deferral-staleness.test.ts` carries the same comment |
| ⛔ **A scan matching zero files looks exactly like a clean tree** | Assert non-vacuity: nav link count, route count, action-shaped-export count, and discovered-edge count all above a floor | DEF-179; T-161's refusal to register a detector that could not fail |
| ⚠️ **A shared component's links belong to no route** — `/reports/journal-lines` is linked only from `components/reports/TrialBalanceTable.tsx` | Files under `apps/erp/src/components/**` and `apps/erp/src/lib/**` are treated as reachable, since they render inside pages. Stated as the one accepted hole: an orphaned shared component's links would be believed | — |

### 4. The exemption list is a confession, not a config knob

Check C carries `EXEMPT: Record<string, string>` — export name → the reason it has no caller. Two
rules, both enforced by the test itself:

1. An action-shaped export with no caller and no entry **fails**.
2. ⭐ An entry whose export **now has a caller** also **fails** — the row must be deleted.

Rule 2 is what stops the list becoming permanent. It is the pattern
`tests/unit/no-client-supplied-actor.test.ts` already uses, and bible §13 row 138 states the reason:
*"an entry in that list is a confession that a screen can be impersonated through, not a config
knob — and a second test refuses a stale one, because an exemption matching nothing makes the rule
look narrower than it is."*

⚠️ **A reason must open with one of four kinds and name the other half**, and the test enforces
both the prefix and a minimum length:
- `INTERNAL` — another domain function calls it; **name that function and its file**
  (`capitalizeApprovedExpense` ← `approveExpense`, `expenses/approve.ts:231`);
- `WRAPPER` — an app action calls it under a different name; **name the wrapper**
  (`commitCountSession` → `/inventory/counts` calls `commitCount`);
- `JOB` — a scheduler, cron or script calls it rather than a screen; **name the job**;
- `UNWIRED` — nothing calls it and that is a gap; **cite the task or defect that owns it**.

⭐ **`UNWIRED` is not an excuse, it is a register.** Twenty-two of the thirty entries written on
2026-09-06 are that kind — that is the measured size of the *built, tested, unreachable* debt, and
stating it once means it can be counted and paid down instead of rediscovered one screen at a time.

### 5. The two nav fixes this task applies

Check A and check B are red today. Both failures are real and both are fixed here.

**`/settings` — remove the nav entry.** `apps/erp/src/components/nav.tsx:135` links it; there is no
`apps/erp/src/app/settings/page.tsx`, only `settings/attendance/`. DEF-192 offers two dispositions
and calls the second the durable one: drop the entry, keep `/settings/attendance`, which is already
linked beside it. ⛔ A hub page listing exactly one child is a screen that exists to satisfy a link.
When a second settings screen lands, that is the moment a hub earns its place.

**`/attendance/lane` — add a nav entry.** ⭐ **A finding this task produced rather than inherited.**
The clock-lane quarantine screen is the *only* structural fix in bible §12 that is a screen — it is
landmine #14's answer, and its own header says so: *"A quarantine nobody can read is a dead letter
with better manners."* It is in no nav group and nothing links to it; it is reachable only by typing
the URL. **The screen that exists so a dead letter is visible was itself invisible.** File as a new
defect in section E and link it beside `/attendance` in the Daily group.

**Two roots are exempt from check B, named in the test with reasons:**
- `/clock` — the terminal kiosk, opened on a provisioned device, and bible §5.2 forbids it touching
  the server at all. It is not back-office navigation and must never appear in a menu a manager sees.
- `/sign-in` — reached by redirect when there is no session; `nav.tsx` deliberately renders nothing
  without one.

### 6. Check C's starting exemption list

The 30 action-shaped exports with no `apps/` caller today are triaged in the implementation. ⛔ **The
five AR functions from DEF-190 — `recordCharge`, `voidCharge`, `recordCollection`, `voidCollection`,
`writeOffCharge` — are exempted with `DEF-190` as the reason and `T-226` as the owner, and T-226
must delete all five rows.** Rule 2 of §4 makes that automatic: the moment T-226's page calls them,
the stale-exemption check fails until the rows go.

## Invariants

1. **The guards run in `npm test`.** A guard behind a flag or a separate script is a guard that
   stops running. They live in `tests/unit/`, matched by the existing `tests/unit/**/*.test.ts` glob.
2. **No guard reads `apps/erp/.next`.** Asserted structurally by using `git ls-files`.
3. **No guard can pass vacuously.** Each has an explicit floor assertion, and each floor is a number
   that would drop to zero if the scan broke.
4. **Neither guard edits behaviour to make itself pass.** The only production change in this task is
   two lines of `nav.tsx`.
5. **An exemption names a reason.** An empty or whitespace reason fails the test.

## Tests — written first, and seen failing for the right reason

⭐ The guards *are* the tests, so "tests before implementation" means: **write each guard, run it,
and record the real red output before applying any fix.** A guard whose first run is green has
proved nothing (`docs/CAPABILITY-GAPS.md`, T-220's stated lesson).

The first run must fail with, and only with:

| Guard | Expected first-run failure |
|---|---|
| A (nav → route) | `/settings` — DEF-192, live |
| B (route → nav) | `/attendance/lane` — unreachable, the new finding |
| C (export → caller) | the five DEF-190 AR functions, with the exemption list empty |

⛔ **If the first run is green, the guard is broken** — check the file enumeration and the
non-vacuity floors before believing it.

Then, after the fixes and the exemption list:

1. Guard A green; re-adding a bogus `href: '/nope'` in a scratch copy turns it red again.
2. Guard B green; deleting `/attendance/lane`'s new nav line turns it red again.
3. Guard C green; deleting any one exemption row turns it red naming that export.
4. Guard C's stale check red when an exemption is written for an export that *does* have a caller.
5. Every non-vacuity assertion fails if its source directory is pointed somewhere empty.

⚠️ 1–4 are demonstrated by hand during implementation and reported; they are not committed as
permanent negative tests, because a test asserting a guard fails on a mutation of itself is a test
of the mutation.

**Smoketest on 9008.** The nav change is a visual change: sign in, confirm `Settings` is gone,
confirm `Clock lane` is present and opens `/attendance/lane`, and confirm the nav still wraps with
**0px horizontal overflow at 390px** (DEF-149 — a nav group was an unwrappable row and every route in
the app scrolled sideways).

## What the first run actually said

Recorded verbatim because *"it was red first"* is a claim, and a claim is what this whole line of
work exists to stop accepting.

**`nav-route-reachability.test.ts`, before any fix — 2 of 4 failed:**

```
× A — every nav href resolves to a page.tsx (DEF-107, DEF-192)
  [ "apps/erp/src/components/nav.tsx — href '/settings' has no page.tsx under
     apps/erp/src/app. It is a 404 in the menu." ]

× B — every non-dynamic route is reachable from nav (DEF-139, DEF-181, DEF-197)
  [ "/attendance/lane — no nav entry and nothing reachable links to it, so it exists
     only for whoever types the URL." ]
```

**`domain-actions-have-callers.test.ts`, with `EXEMPT` empty — 30 offenders**, including all five
of DEF-190's AR functions (`recordCharge`, `voidCharge`, `recordCollection`, `voidCollection`,
`writeOffCharge`). The full list is the `EXEMPT` map's keys.

**After the two nav lines and the exemption map: 8 of 8 green**, and the whole unit suite
**1038 passed / 1 skipped / 63 files**.

**Smoketest on 9008, 390×844, signed in as super-admin:** `Settings` gone from the nav,
`Attendance settings` still there, `Clock lane` present and opening `/attendance/lane` (renders,
no 404), `/settings` still a real 404 — no hub page was invented to satisfy a link. 0px horizontal
overflow on `/`, `/attendance`, `/attendance/lane`, `/settings/attendance`.

⚠️ **And the smoketest found two things the guards could not**, which is the standing lesson about
browsers versus suites arriving on schedule: **DEF-199** (24 of 66 routes overflow at 390px — none
of them the nav) and **DEF-200** (seven report screens 500 for a super-admin because
`personCoversWholeOrg` and `personHasStoreScope` disagree). Both logged with their diagnosis;
neither is in this task's Scope and neither is touched here.

## Out of scope — with reasons

- **Wiring any of the 30 uncalled exports to a screen.** That is per-module work and T-226 is the
  first of it. This task makes the debt visible and countable; it does not pay it.
- **The same two checks for `packages/db/src/repo`.** A repo function with no caller is dead weight,
  not a missing capability. Cheaper to add later once check C has proved itself.
- **A route→capability check** (*"every page declares a permission"*). Real, and
  `no-ungated-read-surface.test.ts` already covers the read half.
- **Table→writer** (the sweep's check 3, which found DEF-169, DEF-193). Needs a per-table judgement
  a test cannot make; the sweep note stays the record of the method.

## Done when

- [ ] Both guards exist under `tests/unit/` and run in `npm test`
- [ ] The first red run is recorded verbatim in the report — three failures, all live defects
- [ ] `/settings` gone from nav; `/attendance/lane` linked from it
- [ ] The new `/attendance/lane` finding filed in `DEFECTS-REGISTER.md` section E
- [ ] DEF-192's disposition updated with what shipped
- [ ] `docs/CAPABILITY-GAPS.md`'s sweep section points at the two tests
- [ ] Every exemption in check C carries a reason of one of the three permitted kinds
- [ ] `npm run typecheck` clean, `npm test` green, `npm run test:integration` green
- [ ] Smoketested on 9008, 0px horizontal overflow at 390px
- [ ] `npm run build` exit 0 with the dev server stopped

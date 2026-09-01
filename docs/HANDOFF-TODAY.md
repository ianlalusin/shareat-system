# Handoff — 2026-08-31

## Where things stand

**Seven tasks shipped, and five of them were defects nobody knew about.** The session began as
*"turn on one payroll flag"* and the flag turned out to be the least of it: probing before building
found that **payroll paid a full day for a four-minute shift**, that **a manager could void a day
and payroll paid it anyway**, and that **the entire manager-adjustment layer had no caller**.

⭐ **Phase 5 is 13 of 17 built.** The one thing that is *code-complete but not live* is the
attendance sweep: its systemd timer sits in `docs/ops/` and **nobody has installed it on the
droplet.** That is the single most important line in this document.

## Gates at `93408a7`

```
typecheck   ✅ exit 0
unit        ✅ 872 passed, 1 skipped (873)
integration ✅ 1778 passed (1778)
build       ✅ exit 0, dev server stopped first
```

All four run on the committed tree, exit codes checked rather than output skimmed.

## What happened this session

### ⛔ Five defects, and four of them are one family

| | |
|---|---|
| **DEF-111** | ⛔ **A day crediting ZERO minutes was paid a FULL daily rate.** `unitsFor` read only `isHalfDay`, and `compute-day.ts:557` says *"there is NO DAY"* by zeroing the minutes while leaving that flag false. **31 of 560 live sessions; three under five minutes.** Fixed in **T-194** — and such a day is now *held*, not paid-and-frozen, because freezing it would put its overtime permanently beyond reach |
| **DEF-113** | ⛔ **`recordAdjustment` had NO CALLER outside tests.** Six adjustment kinds shipped a month ago and nothing invoked them, so overtime could never be approved and a `needs_review` day could never be settled by anything. Root cause: **a task-number collision** — four specs promised the screen as "T-166" and the inventory lane shipped T-166 as *Deliveries*. Fixed in **T-195** |
| **DEF-115** | ⛔ **Voiding a day did nothing; payroll paid it in full.** Found by *building* T-195. `verify` was equally dead, so a flagged day could never be rescued. ⭐ **The cause was the test**: invariant 11 is titled *"a voided day contributes nothing"* and asserted only that the adjustment row was written. *The half of the invariant that involved money lived in the test's name, not its body* |
| **DEF-118** | ⚠️ **The clock mirror published every attendance day ever.** 24 of 24 measured were historical; payroll's freeze doubled it. ⭐ And **nothing read the feed at all**. Fixed in **T-198** |
| **DEF-119** | ⛔ **`halfDayOnMissingTap` was a column nothing read.** All three v1 stores have it ON, so a forgotten tap-out paid **half a day there and ₱0 here** — an underpayment nobody reports because nobody can see it. Fixed in **T-199** |

⭐ **DEF-109, 111, 113, 115, 119 are one shape**: stored intent that the consuming layer never
reads. Five occurrences in two days. **If you find a comment addressed to a future module, check
that module actually reads it.**

### What shipped

| Task | |
|---|---|
| **T-194** | Zero-credit days pay nothing and are **held**, not frozen |
| **T-195** | `/attendance` — the review queue and the decision surface. Every reason stated on the row |
| **T-197** | `shortShiftHalfDayOt` **on by default** — all three live stores already ran it that way, so v2's `false` was *reversing* practice, not preserving it. Worth **51.5 days a month, ~9.2% of basic pay** |
| **T-198** | The mirror's day feed scoped to two days |
| **T-199** | The missed clock-out sweep + `openShiftsStale`, the alarm that works when the sweep is dead |
| **T-200** | The clock terminal rebuilt: no in/out toggle, intent derived, on-shift roster and today's feed rendered at last, per-person 30s cooldown |
| **T-196** | Draft expense on a pending invoice — specced by a peer session, implemented here by a Sonnet subagent |

### Where the decisions were recorded

| Decision (Ian's words) | Recorded in |
|---|---|
| *"1 turn on and test it"* | `docs/tasks/197-*.md`, migration `0111` |
| *"2. fix it"* (the mirror) | `docs/tasks/198-*.md`, migration `0112` |
| *"3. plan well and build a better one. your call. park the break"* | `docs/tasks/200-*.md` §3 and §8 |
| *"1. lets do it"* (sweep **and** alarm) | `docs/tasks/199-*.md`, `docs/ops/README.md` |
| *"lastly do the t196 too"* | implemented; spec is the peer session's, unamended |
| DEF-111 → 119 | `docs/DEFECTS-REGISTER.md` |

⚠️ **Roadmap: updated.** All seven cards added and marked done; the Phase 5 chip corrected from
*"1 of 5 built"* to **13 of 17**; masthead gates refreshed.

⛔ **Nothing needing a bible amendment came up.** No `PROJECT_BIBLE.md` §13 row was required and
none was written — the decisions above are all task-level.

1. ~~⛔ INSTALL THE SWEEP TIMER ON THE DROPLET~~ — **corrected 2026-09-01, do not act on the
   original framing below.** Read-only SSH inspection of `159.223.78.207` found no
   `/srv/shareat`, no `shareat` OS user, no shareat-system systemd units, and no CI deploy step —
   **the app has never been deployed to production at all**, so there is nothing yet to point a
   timer at. This matches ADR-005/ADR-007: pilot go-live is **Oct–Dec 2026**, not now. The
   precondition and correction live in `docs/ops/README.md`. The original text is preserved below
   only so the mistake is visible, not as an instruction:

   > ~~INSTALL THE SWEEP TIMER ON THE DROPLET. `docs/ops/README.md` has the four commands. The
   > job is written, tested and committed and it is not running. Three jobs in this business's
   > history shipped and were never scheduled — v1's depreciation (two months, ₱35,483.98/month
   > unbooked, found by an audit), POS's holiday calendar, POS's weather job. This is that step.
   > `systemctl enable --now` — without `--now` it arms for the next boot and not for today.~~

   **Next step here is a task spec for the first production deployment** (provision DO Managed
   Postgres, create the `shareat` user, ship a build via CI, *then* install the timer) — not
   something to execute ad hoc, and not due until closer to the pilot.
2. **The payroll settings screen.** Overtime mode, three holiday multipliers, period type, cutoff
   day, payout days, and now the sweep's cut-off hour and max-shift cap — **all of them need SQL to
   change.** `/payroll` displays them, so nothing is invisible; nothing is editable either.
3. **T-191, 13th-month pay** — a confirmed ADD (bible row 90); `6140` has existed since Phase 1
   with nothing posting to it.

## Do not decide these alone — they are Ian's

| Question | The recommendation on the table |
|---|---|
| ⛔ **Statutory is blocked on DATA, not effort** | 0 of 126 staff have an SSS/PhilHealth/Pag-IBIG/TIN number. Somebody must enter them before T-190 can exist. ⚠️ Also a live compliance exposure independent of software |
| **Breaks are unreachable** | Parked at Ian's instruction. The schema has `break_start`/`break_end` and `computeDay` deducts break excess — the rules exist and no button reaches them |
| **`/clock` cannot run on a dev machine** | `NEXT_PUBLIC_FIREBASE_PROJECT_ID` and `_API_KEY` are **empty** in `.env.local`. T-200 was verified against the Firebase emulator instead. Filling them, or documenting the emulator path in `HANDOFF.md`, is a small job nobody owns |
| **DEF-114** | DEF-087 says Malvar has 3 config keys and Banay-Banay 1; the raw capture shows **23 and 21**, with store-specific values. One of them is wrong. ⛔ Do not migrate either store's config until it is settled |
| **DEF-116's remainder** | The stale `dayFeed` docs already in Firestore. Harmless (T-200 queries by date) but a destructive one-off to clean, so it needs an explicit go-ahead and a counted dry run |
| **DEF-117** | Not mine — a peer session's. `closeReadiness` can report a period ready to close while pending invoices hold spend outside it |

## Traps that have actually bitten — live in this area now

- ⛔ **Task numbers collide.** T-166 cost a month. **And it happened again today**: a peer session
  and I both took `T-196` and `DEF-117` within three minutes. Both were caught before either
  committed. ⚠️ **Two agents share this one working tree — `ListAgents` before you start.**
- ⛔ **`store_attendance_config` rows are IMMUTABLE.** A migration that `UPDATE`s one is refused by
  name. Supersede with a new row — and `supersedeConfig` will also refuse to back-date over
  already-computed days.
- ⚠️ **Backticks inside a `sql\`\`` template literal close the string.** Made twice today, the
  second time *inside the comment warning about the first*.
- ⚠️ **A JS array bound into SQL is not an array literal.** Use `array[...]` construction.
- ⛔ **Two clocks in one decision.** The sweep's query used the database's `now()` while its rule
  took `nowMs` — untestable at a chosen time, and disagreeing with itself on any run straddling a
  second.
- ⚠️ **Integration files `truncate` unscoped by org.** Never run the full suite beside a busy peer.
- ⚠️ **Migration `when` must rise with `idx`** or Drizzle skips it silently. 0111–0114 are correct.

## The paste-ready prompt

```
Continue on shareat-system (C:\Users\ianla\webapps\shareat-system).

Read docs/RULES.md, then docs/HANDOFF-TODAY.md. main is at 93408a7, all gates
green (typecheck 0 · 872 unit · 1778 integration · build).

⚠️ ANOTHER AGENT MAY BE IN THIS SAME WORKING TREE. Run ListAgents before you
start, and coordinate on task numbers, defect numbers and migration numbers —
we collided on all three yesterday. Next migration is 0115.

Item 1 in the handoff's "Pick up here" is NOT a coding task: the attendance
sweep is built and committed and its systemd timer has never been installed on
the droplet. docs/ops/README.md has the commands. Three jobs in this project's
history shipped and were never scheduled; do not let this be the fourth.

Before building anything, assess it and be willing to argue against it
(/research-evaluate-propose). Probing live v1 data changed the shape of every
task this week — including one where my own defect report turned out to be wrong.

Standing rules: ERP-rebuild is READ-ONLY and its name lies (it is the OLD live
ERP). No implementation without a written task spec in docs/tasks/. Verify UI in
a browser — a green build is blind to whether anyone can see the thing. Update
docs/ROADMAP.html at every wrap-up.
```

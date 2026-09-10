# Handoff — 2026-09-10 (afternoon) — for the NEXT ORCHESTRATOR

> **The tree is CLEAN, every gate is GREEN, `main` is pushed, and all four lanes are idle and
> cleared.** Nothing is half-built. Ian invokes `/orchestrator shareat system` in your terminal
> himself; the skill is user-invocation only. Run the role from this file until he does.

## Where things stand

**Four tasks shipped this afternoon** (T-257, T-255, T-258, T-259) on top of the morning's five, and
**ten defects filed** (DEF-267…276). `main` is at `b0991a4` and pushed. Production is unchanged.

⭐ **T-257 is done, which was Ian's explicit next: you can sign out of the ERP.** The control is on
all three shell surfaces and the *server* session provably ends.

## Gates at `b0991a4`

All run by the orchestrator on the **shared** database, not a lane's:

- **typecheck** `--incremental false` → **exit 0**
- **unit** → **91 files, 1280 passed / 1 skipped, exit 0**
- **integration** → **110 files, 2676 passed, 0 failed, exit 0** — 1490s (~25 min) on `shareat_test`
- **build** → **exit 0**, dev server stopped, route table lists `ƒ Proxy (Middleware)`,
  `apps/erp/next-env.d.ts` restored afterwards
- **browser** → **29/29 at 390 AND 1280** (`smoke-t257-t258.mjs`, new), with a **real user click**
  asserted rather than a scripted bypass
- **caller census** → clean; baseline regenerated with `--names`, 111 → 110 names

⚠️ The bible TOC was checked with `npm run toc` — already correct, `bf83740` had run it.
**PROJECT_BIBLE.md was not amended by me** (rule 14); DEF-275 proposes a narrowing and is Ian's.

## Pick up here, in this order

1. **DEF-272 — a sub-centavo amount defeats every `> 0` guard in the money domain.** ⭐ The most
   valuable open item. `Number('0.004') > 0` passes the guard, Postgres rounds to `0.00`, the CHECK
   refuses, raw driver text lands on the person moving money. Reachable today on cash requests,
   loans, AP payments and money transfers. ⚠️ **State the severity as the row does: the database
   REFUSES the row, so nothing wrong is stored and no money is mis-recorded.** The fix is one shared
   check rejecting anything that rounds to zero *at the column's scale* — not four hand-written ones,
   since four hand-copied guards is the shape T-255 just deleted. Needs a task number.
2. **DEF-274 — wire the hit counter into the money screens.** Row 189 defers its next decision to
   measured hit counts, and the counter is wired into 19 call sites across payroll and settings with
   **zero money screens**. Left alone, the first report says the money screens are quiet, which is
   the opposite of what DEF-272 just proved. ⭐ T-255 gave all 42 screens one shared entry point, so
   this is the cheapest it will ever be. ⚠️ Not trivial: `orgId`/`storeId`/`actorPersonId` must be in
   scope at ~100 catch blocks, with an `await` inside `catch`.
3. **DEF-269 — re-census touch targets with a matcher that resolves inherited text size.**
   `action-link-sweep.test.ts` matches `text-xs` with a bare `underline` **inside one `className`**,
   so any control inheriting its text size from an ancestor is invisible to it. DEF-239's census may
   have undercounted app-wide. ⛔ Until then, that guard's green is evidence about the shapes it can
   see and nothing more. Decide whether a text-scanning guard can do this at all, or whether the
   assertion must move to rendered output.
4. Then: **DEF-260** (terminal pairing — a MANAGER confirms on screen, per bible row 190),
   **DEF-251/252**, **DEF-253/254/255**, **DEF-261/262**, **DEF-273** (pick one sentence per
   constraint — sequence *after* DEF-274 so the choice is informed), **DEF-267** (the server-side
   half of the padding blind spot).

## What happened this session, by theme

**The browser pass earned its place, twice.** Lane B named one thing it could not verify without a
running app; that was the one thing that was wrong — the sign-out control sat at y=925 in an 800px
viewport, 125px below the fold, reachable only by scrolling a sidebar that does not advertise it
scrolls. Sent back; the footer is now pinned (`min-h-0` is load-bearing — a flex item's default
`min-height: auto` would have made `overflow-y-auto` inert).

**A spec defect was caught before a line was written.** T-259's instruction to reuse `env.ts`'s
notion of "required" would have built a preflight blind to the padded case, because every schema
entry `.trim()`s before validating. Resolved by deriving the *list* from the schema but computing the
verdict on the **raw** value before any parse.

**A lane went a third way and was right.** T-255's judgement call was framed as "migrate each
screen's sentences or drop them"; lane C found only ~29 of ~94 branches could ever live in a
constraint map, and that migrating them would have **widened an unauthenticated allowlist** —
`pre-session-message.ts` builds `WRITTEN_FOR_A_PERSON` from `CONSTRAINT_MESSAGES`, which gates what
may appear in the URL of the unauthenticated `/setup` page.

**Decisions recorded:** no new Ian decisions this session — his backlog was cleared this morning.
DEF-275 is the only item proposing a bible change and it is **reported and stopped** for him.

## Do not decide these alone — they are Ian's

- ⭐ **DEF-275 — one clause of bible §13 row 189 is unsupported by its own examples.** Row 189 says
  the unmapped set is "exactly where there is frequently no TS guard either"; all four of DEF-246's
  named examples **do** have one. ⛔ Not a reversal — sanitise-first-then-count stands, and DEF-272
  gives a sharper reason those constraints are reachable. If Ian agrees, row 189 wants a superseding
  row narrowing that clause and citing DEF-272.
- **The fingerprint capture gap** — multi-week, mapped in `CAPABILITY-GAPS.md`. ⚠️ Ian has still
  **not been asked about face recognition**, which v1 also has.
- **DEF-237's residue** — grants written before `grant_source` existed stay NULL for ever. Permanent.
- **DEF-258's triage** — 47 same-digit dark-mode overrides across 28 files. ⛔ Not all are defects;
  triage before touching, and do not bulk-replace on a regex.

## Two things Ian must do himself

1. ⚠️ **Apply the month-end timer on the droplet.** `docs/ops` does not ship (DEF-194). Verify with
   `systemctl list-timers`: NEXT should read **19:00 UTC on the 30th/31st**, not 02:00 UTC on the 1st.
   **This is the only item left on his board.**
2. ⚠️ **A lane ran a system-wide `taskkill /F /IM python.exe`** and killed two processes it did not
   intend to. Nothing of the orchestrator's was Python. Some MCP tooling here runs on Python — if
   anything misbehaves, restart it. Disclosed unprompted by the lane, against its own work.

## Traps that bit TODAY — every one of these caught a real mistake

- ⛔ **A MEASUREMENT IS PLAUSIBLE AND WRONG MORE OFTEN THAN IT IS ABSENT.** The orchestrator got
  three wrong in one session, and each was caught only by re-checking: (a) a file count reported from
  a **string match that included comments** — the exact error it had just warned two lanes about;
  (b) a "428.5px row gap" measured **across two different tables** with a heading between them, which
  nearly sent a lane chasing a phantom; (c) a padded-secret test whose **injection silently never
  landed** (`$(printf '%s\n' …)` strips trailing newlines), making a *working* guard read as broken.
- ⛔ **PROVE THE INJECTION BEFORE YOU BELIEVE EITHER OUTCOME.** A failed injection and a failed
  control are indistinguishable from an exit code alone. Assert it with a byte count or a hexdump.
- ⛔ **WRITE THE CENSUS AS THE GUARD.** A hand census counts spellings; a guard whose assertion is
  **zero** cannot be fooled by a naming convention. That is how lane C found 4 copies its own
  name-based count had missed.
- ⛔ **STARVATION HERE LOOKS LIKE A RED TEST, NOT A CRASH (DEF-268).** The integration suite was
  OOM-killed with four lanes active and reported two tests as FAILED with durations of **468,095ms
  and 2,830,560ms** — 7.8 and 47 minutes for tests that take under two seconds. Re-run alone the same
  file passes 14/14 in 25 seconds. **Check durations before believing any integration failure taken
  while lanes were live.** Do not run the suite with lanes active.
- ⚠️ **THREE LANES ON ONE TREE MEANS A TEST RUN IS A PHOTOGRAPH, NOT A FACT.** Two lanes reported
  contradictory results for the same file; both were honest — one sampled the tree while the other
  was still editing. Gate on the settled tree. A red result naming a file outside your task is a
  timestamp.
- ⚠️ **A BARREL IS ANY NAME REACHING A PACKAGE'S PUBLIC SURFACE**, not just a line in an `index.ts`.
  `packages/core/src/index.ts` is `export * from './env'`, so a new export in `env.ts` publishes
  itself with no barrel edit. A lane spotted that the stated rule under-described the risk; the rule
  is now the broader one.
- ⚠️ **`resize_window` in the Chrome tooling does not change the page viewport here** — it stayed
  1536 regardless, so the <768 breakpoint is unreachable that way. Use the Playwright harness in
  `~/.claude/skills/orchestrator/tools/` (it launches a pinned chromium; `npx playwright install` is
  NOT needed and Playwright's own `chrome` channel is absent).
- ⚠️ **A PRODUCTION BUILD CANNOT BE SMOKE-TESTED LOCALLY.** `npm start` refuses to boot without
  production Firebase credentials (`FIREBASE_PROJECT_ID: is required in production` — env.ts's
  fail-closed contract, working as designed). So every local browser pass is a **dev-mode** pass, and
  Next's `<nextjs-portal>` dev indicator permanently occupies the bottom-left — which is where the
  pinned sidebar footer now lives (DEF-276, verified dev-only: zero hits in the production chunks).
- ⚠️ **`/F` in Git Bash becomes `F:/`.** `taskkill //F` or use PowerShell `Stop-Process -Id <pid>`.
  Kill by PID, never by image name — four sessions share this machine.
- ⚠️ **A browser probe that reports SKIPPED can look like a clean pass.** The first customer by sort
  order has no journal-entry rows; the smoke script now pins the one customer holding both row shapes.
- ⚠️ **`git add` stages whole files, so a shared file cannot be split across task commits.**
  `DEFECTS-REGISTER.md` carried rows from four tasks and got its own docs commit rather than being
  attached arbitrarily to one.
- ⚠️ **A doc comment quoting a regex that ends in the two characters closing a block comment
  truncates the file.** Describe the spellings; do not quote them.
- ⚠️ **Three files in this tree use CRLF** (`attendance/lane/actions.ts`, `inventory/usage/actions.ts`,
  `statutory-discounts/actions.ts`) and a sweep matching on a line ending silently skips them.

## The four lanes — ALL IDLE, all SAFE TO CLEAR (all four notified with reasons)

Lanes **rename themselves per task**, so match on the `[ref]` from `ListAgents`, not the name.
⭐ **All four existed and were idle at handoff — the previous handoff claimed none did.**

| Lane | ref | Model | Shipped today | Lane DB |
|---|---|---|---|---|
| **B** | `6b575a` | Sonnet 5 | T-253, then **T-257** | `shareat_test_t229` |
| **C** | `523c43` | **Opus 5, xhigh** | DEF-249 trace, census, then **T-255** | `shareat_test_qa` |
| **D** | `074c83` | Sonnet 5 | T-252, then **T-258** | `shareat_test_t216b` |
| **E** | `505d06` | Sonnet 5 | T-251a/254/256, then **T-259** | `shareat_test_def219` |

⭐ **Assign by MODEL, and probe first — it worked again.** A task whose spec already exists is
execution and belongs on Sonnet, where row 184 makes it *correct*, not a compromise; the day's real
judgement call went to the Opus lane and it repaid that by going a third way nobody had listed.
⭐ **Nobody was `opusplan` and nobody was in plan mode, so Ian answered ZERO approval prompts.**

**Protocol they must be told** (they will not remember): first line `[X] STATUS: sentence`,
STATUS ∈ ACK/QUESTION/SPEC/READY/BLOCKED. Workers never run git, build, dev, or
`npm run test:integration`; integration only via
`node ~/.claude/skills/orchestrator/tools/it.mjs <lane db> <files>`. **You alone** stage explicit
paths, commit with `-F`, push, run the dev server and browser, and edit the bible, registers,
roadmap and board. ⭐ **Ask each lane for its exact path list before committing** — lane C's
44-path list made a precise stage trivial with three lanes editing one tree.

## Databases

`shareat_dev` · `shareat_test` · four lane DBs · **`shareat_test_t240`** — PIN `246810` on
`Smoke Store (SMK)`. **Do not drop it.** `shareat_dev` signs in as **Dev Admin, PIN `111111`**.
⚠️ Sign-in is store-scoped — **pick the store BY NAME**, never index 0.
⚠️ For T-258's rows, `shareat_dev`'s only customer with BOTH row shapes is **`Smoketest Wholesale
Buyer`** (1 charge, 2 collections) — pinned in the smoke script for that reason.

Browser scripts in the orchestrator tools folder: `smoke-t248.mjs`, `smoke-t250.mjs`,
`smoke-t253.mjs`, **`smoke-t257-t258.mjs`** (new — carries the viewport-relative discipline, a
real-click-vs-bypass assertion, per-`tbody` row grouping, and the `NEXTJS-PORTAL` exception).

## The status board

Ian reads **https://claude.ai/code/artifact/b1555e09-a726-492b-a431-7a30791e1d50** rather than chat.
`Artifact action:"read"` it, edit, republish with that `url` at **every commit**. **Never make a
second one.** `docs/ROADMAP.html` moves at the same moments — do both. ⭐ Edit both with an
**anchored script that refuses unless each anchor matches exactly once**; a board edit that silently
no-ops is worse than one that fails loudly, because Ian reads the board and not the chat.

## The paste-ready prompt

```
You are the ORCHESTRATOR for shareat-system. Read
C:\Users\ianla\webapps\shareat-system\docs\HANDOFF-TODAY.md in full, then docs/RULES.md, then
PROJECT_BIBLE.md §13 rows 184, 189, 190 and 191. Ask Ian to type /orchestrator shareat system
in your terminal (the skill is user-invocation only).

The tree is CLEAN, main is at b0991a4 and pushed, and all gates were green at handoff. Four lane
terminals existed and were idle — run ListAgents and match by [ref], not name, and PROBE EACH FOR
ITS MODEL BEFORE ASSIGNING: a task whose spec already exists is execution and belongs on Sonnet;
a trace or judgement call belongs on Opus. Only opusplan lanes need plan mode — none were, so Ian
answered zero approval prompts; keep it that way if you can.

You own the dev server on 9008, builds, migrations, git and every browser pass; lanes never run
git, build, dev or npm run test:integration. Ask each lane for its exact path list, stage explicit
paths, commit with -F, push, and update BOTH docs/ROADMAP.html and the status board at EVERY
commit. Re-run every gate yourself on the shared database rather than accepting a lane's numbers.

⛔ Treat every register row and task stub as a HYPOTHESIS. ⛔ And treat your OWN measurements the
same way — yesterday the orchestrator got three wrong: a count from a string match, a gap measured
across two tables, and a test whose injection never landed and made a working guard look broken.
Prove an injection with a byte count before believing either outcome. Never commit a new export
with no production caller; scripts/production-caller-census.mjs checks it mechanically.
⛔ Do not run the integration suite while lanes are active (DEF-268) — starvation here presents as
a RED TEST with absurd durations, not as a crash.

Pick up at "Pick up here": DEF-272 (a sub-centavo amount defeats every > 0 money guard — needs a
task number), then DEF-274 (the hit counter is wired into zero money screens), then DEF-269 (the
touch-target guard cannot see inherited text size). DEF-275 proposes narrowing one clause of bible
row 189 — Ian ratifies, rule 14. The month-end timer on the droplet is the only thing on his board.
When a task completes with the tree clean, that is a milestone: run the wrap-up ritual
(.claude/skills/wrap-up/), rewrite this file, and hand over. Keep your session small.
```

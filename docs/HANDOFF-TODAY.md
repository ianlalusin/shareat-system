# Handoff — 2026-09-18

> ⭐⭐ **THE GOAL, IN IAN'S WORDS, UNCHANGED: *"make the app as close as possible to deployment."***
> When two pieces of work compete, the one that unblocks a deploy wins.
>
> ⭐⭐ **§9.4 WAS MET BY ACTUALLY SIGNING IN — the first time this project has ever done that.** Not
> "the screens render", not a minted pairing token: Ian typed a credential into `/sign-in` on 9008
> and a real session row landed in Postgres. ⛔ **This document makes no PRESENT-TENSE claim about
> which commit production is running** (DEF-360). Ask `/api/health` and compare all forty characters
> against `git rev-parse origin/main`.

## Where things stand

**T-323 is complete: `3542a91`, pushed.** Sign-in now works on a development machine, and the
outage screen has stopped blaming the operator. **Closed: DEF-371 and DEF-368.**

### Gates at wrap-up — real numbers

| Gate | Result |
|---|---|
| `npm run typecheck` | **exit 0**, 0 type errors, 10s |
| unit | **1770 passed**, 1 skipped, 128 files, exit 0, 51s |
| `npm run build` | **exit 0**, 72s, with 9008 free and the emulators stopped |
| integration | ⛔ **NOT RUN LOCALLY — stated, not glossed.** The slice touches no `packages/db` or `packages/domain` code, the local suite takes ~29m and OOMs here (DEF-245), and CI runs it on push |
| CI on `3542a91` | **in progress at wrap-up — CHECK IT.** `gh api repos/ianlalusin/shareat-system/actions/runs/<id>/jobs` |

⚠️ **The build log reports "1 error line" and it is a red herring.** It is a source line containing
`throw new Error(...)` quoted inside a pre-existing Turbopack warning about `packages/sync-firestore`
reached via `attendance/terminals`. Nothing to do with sign-in. Do not chase it; do not ignore the
next one without checking it the same way.

## 1. What shipped

| Commit | What |
|---|---|
| `c9bf97a` | T-323 specced, and `.env.example` gains the emulator block — **spec committed BEFORE the code it governs**, so the commit that explains *why* points at something in the history |
| `3542a91` | **T-323** — 13 files, 801 insertions. Closes DEF-371 and DEF-368 |

**The fix, in one paragraph:** `signInFirebase()` gains the `connectAuthEmulator` wiring it never had,
gated on `NODE_ENV !== 'production'` so it is dead code in a production build. The outage notice names
the real state instead of claiming PIN sign-in is unaffected. The terminal form gates itself off in
the same condition instead of offering a submittable PIN box that blames the operator's password. And
`authApp()` now **throws** if `FIREBASE_AUTH_EMULATOR_HOST` is set in production.

## ⛔⛔ 2. A VARIABLE THAT IS NO LONGER HARMLESS — TELL WHOEVER ADMINISTERS THE DROPLET

**`FIREBASE_AUTH_EMULATOR_HOST` set on a production host now breaks sign-in for EVERYONE**,
immediately and permanently, until it is unset. That is deliberate: without the guard,
`firebase-admin` accepts **unsigned** tokens, which is a full authentication bypass — anyone able to
reach the app mints their own token and is believed.

⚠️ **It is not in `.github/workflows/deploy.yml`'s env allowlist and must stay out.**
⛔ **`scripts/deploy-preflight.ts` checks that REQUIRED keys are PRESENT and has no denylist**, so
nothing in the pipeline would fail a build that carried it. **That gap is now security-relevant, not
tidy-up** — filed as **DEF-373**, unspecced.

## ⭐⭐ 3. THE DAY'S TRANSFERABLE FINDING — TWO RULES, BOTH EARNED THE HARD WAY

### (a) The row-214 mirror: a PRESERVED line can be falsified by a change made elsewhere

Bible row 214 says a rewrite is a deletion, so enumerate every removed line. **Its mirror is that a
line nobody touched can be made false by a change somewhere else — and a deletion audit is
structurally blind to it.** Found four times in one afternoon:

1. `EmailSignInForm.tsx` — *"Decision 6: the PIN sign-in stays exactly as it is"*, which would have
   authorised the next person to **delete the new gate**.
2. `page.tsx`'s subtitle, advertising two routes above two notices saying neither works. **Ruled
   acceptable and filed** — fixing it properly would need the config state on the server side of a
   boundary the codebase deliberately forbids.
3. `docs/tasks/232`'s live 9008 smoketest recipe, whose expected output could no longer occur —
   **the next person to run it would have concluded the app was broken, and that person was me,
   minutes later.**
4. ⛔ **DEF-368's own lie, verbatim in form, alive in `firebase-auth-admin.ts:77`** — *"PIN sign-in
   does not need it and still works"* — in a file outside every sweep this task had made. **Closing
   DEF-368 with that shipping would have closed it on the instance found, not on the defect.**

⭐ **The mirror needs a SEARCH for the old CLAIM, not a read of the diff.** This belongs in the bible
as the second half of row 214; it is drafted here and not yet written.

### (b) A verification that silently skips part of its input reports success

Five instances in one day, every one of which ran, returned, and **looked like evidence**:

- ⛔ **`callers.mjs` matches by NAME, not by binding.** It credited a new export with a caller that
  does not exist (a same-named local in another file), then later **missed the real importer**. "ok
  by accident", in both directions. ⚠️ **The zero-caller gate this repo adopted after DEF-129/135/
  136/137/147 can be fooled by a duplicate function name.**
- ⛔ **The `--forbid` invocation in `worker-briefing.md` fails by construction** when it names every
  path in the slice. A verdict that cannot distinguish a violation from a correct slice is not signal.
- ⛔ **A snapshot taken during active edits** with no committed object to verify against — it was
  mixed-epoch and nearly produced a false accusation against a lane that had done the work correctly.
- ⛔ **`git diff <commit> -- <path>` reports UNTRACKED files as wholly deleted.** Use
  `git show <ref>:<path> | diff - <path>`.
- ⛔ **The Chrome extension's `read_network_requests` returned "No network requests found for this
  tab" while genuine cross-origin calls were in flight.** Recovered via
  `performance.getEntriesByType('resource')`. **The next tester would read that empty result as a
  failure.**

## 4. ⭐ How §9.4 was met, and the trap in the version that nearly shipped

⛔⛔ **THE §9.4 RECIPE AS FIRST SPECCED WOULD HAVE PASSED WHILE SIGN-IN REMAINED IMPOSSIBLE.** It
asserted *where the request went*. The browser reaches the emulator and mints an **unsigned** token;
`firebase-admin` refuses it unless `FIREBASE_AUTH_EMULATOR_HOST` is set in the **server** process —
and that variable existed nowhere in this repo outside `spike/firestore-two-lane/offline.test.ts:63`,
**where it names port 9199, a different emulator.** Copying the only precedent points at nothing.

**The recipe that worked, end to end:**
1. Emulators: `firebase emulators:start --only auth,firestore --project demo-shareat` from
   `firebase/` — auth **9198**, firestore **8182** (`firebase/firebase.json`).
2. Dev server on 9008 with **all** of: the five `NEXT_PUBLIC_FIREBASE_*` as **non-empty
   placeholders** (⛔ blank defeats everything — `publicEnv()` throws *before* the emulator branch),
   `NEXT_PUBLIC_FIREBASE_EMULATOR_HOST=localhost:8182`, `NEXT_PUBLIC_FIREBASE_AUTH_PORT=9198`,
   **`FIREBASE_AUTH_EMULATOR_HOST=localhost:9198`**, and `FIREBASE_PROJECT_ID=demo-shareat` matching
   the client's project id. ⛔ **Pass these to the PROCESS, never into `.env.local`** —
   `next.config.js:9` loads that file at BUILD time, so a captured `localhost` is inlined and cannot
   be corrected at runtime on the droplet.
3. Create an emulator account (**Ian runs this; the password is his**):
   `POST http://127.0.0.1:9198/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-key`
4. Link the returned uid to a person:
   `update person_credentials set external_id='<uid>' where kind='firebase' and person_id=…`
   ⚠️ Without this, sign-in fails at a **later** step with *"this account is not linked to a person in
   this system"*, which looks like a credential problem and is not.

⛔⛔ **A TOKEN AND A PASSWORD ARE BOTH OFF-LIMITS TO AN AGENT — IAN PASTES THEM, AND "it is a
throwaway emulator credential" IS NOT AN EXEMPTION.** ⭐ A **uid** is different: it is an identifier,
it authenticates nothing, and an agent may handle it.

**The result, three independent instruments:** request to `localhost:9198/...signInWithPassword`,
never Google · landed on `/sales-days` with real data and no error · Postgres session row for **Dev
Admin** at `2026-09-18T10:34:02Z`, where the previous row is 2026-09-12.
⚠️ **Limits, and they belong with any citation:** email path only, **not** the terminal PIN path;
emulator, not real Firebase; a credential row linked by hand; **on a dev machine, which was never the
broken environment — `erp2.shareat.net` signs in fine and always did.**

## 5. Pick up here

1. **DEF-357** — cap the handover at what is owed plus a declared overage. T-319 unblocked it.
2. **T-320** — access that does not come from a position. ⛔ **Still a PLACEHOLDER, no spec.** Take
   **DEF-367** with it; the register says so in terms.
3. **`deploy-preflight.ts` denylist** — now **DEF-373**. Unspecced, security-relevant.
4. **DEF-366** — one line in `remittance/actions.ts`, in whichever pass is next in that file.
5. **T-322** — retire the two legacy constraint names. ⛔ **Trigger is mechanical, not a date:** `0153`
   confirmed in production **plus three deploys** since release N.
6. **The bible row** for §3(a) — drafted above, not written. Only the Opus planner amends the bible.

## 6. Open observations — not verified, do not report as checked

- ⛔ **`terminal/firebase.ts:102` has the same ungated emulator wiring T-323 closed on the sign-in
  client** — now **DEF-372**, and the way it was nearly lost is the day's lesson landing on the
  orchestrator: `firebase-client.ts:66` shipped in `3542a91` asserting this was *"filed as its own
  defect row"* **when no such row existed.** Caught by the auditor in the wrap-up audit and filed in
  `621ca66`+. ⚠️ **A comment claiming a filing that does not exist is worse than a missing row — it
  tells the next reader to stop looking.**
- ⚠️ **`firebaseSignInMessage` exists independently in BOTH sign-in forms** and now carries the same
  new branch in each. They can drift. Pre-existing; **paid twice on purpose** rather than extracting a
  module mid-audit. Needs a row.
- ⚠️ **`PUNCH_COOLDOWN_MS` may not bite** (carried from 2026-09-17, still unchecked).

## 7. Traps that have actually bitten

- ⛔⛔ **MEMORY IS THE HIDDEN CAUSE ON THIS MACHINE — IT BIT THREE TIMES TODAY.** It killed a lane's
  test run, made a suite take 60s instead of 27s, and stopped a background process. **None of it was
  a code problem and each time it looked like one.** ⚠️ Windows Update's `TiWorker` held 2.3 GB for
  much of the afternoon. **If a tool fails nonsensically, suspect memory first** — `0xc0000142` from a
  build tool is Windows refusing to create a process, not a compiler bug.
- ⛔ **A harness "killed for memory" message does NOT mean the child processes died.** Both the
  emulators and a dev server survived their wrapper being reaped and kept serving. **Check the port
  and then check functionally** — a listening port is not proof of a working service.
- ⛔ **`git diff <commit> -- <path>` silently reports untracked files as deleted.** Use
  `git show <ref>:<path> | diff - <path>`.
- ⛔ **For a CI verdict use the API, not `gh run view`** — they disagreed about the same run in the
  same second. Never chain a `gh run watch` with other commands; you get the wrong exit code.
- ⛔ **One integration suite at a time.** Two at once = a `DROP DATABASE` teardown timeout reported as
  a failed suite with zero failed tests.
- ⛔ **The shell eats backslashes and executes backticks.** Write tool → plain file → a script that
  READS it.
- ⛔ **`next-env.d.ts` flips** between `.next/dev/types/...` and `.next/types/...` depending on whether
  `dev` or `build` ran last. It is generated and says "should not be edited" — **revert it, do not
  commit it.**
- ⛔ **A bible row insertion shifts every range below it** — run `npm run toc`.

## 8. Numbers to allocate from

Next task **T-324** · next defect **DEF-374** · next migration **`0154`**
⚠️ **Reserved, do not re-issue:** `0149`/`0150` (T-314 F/G), `0151` (T-316). **DEF-370's number is
SPENT** on `daily-review/2026-09-17`.
⛔ **`0152` AND `0153` ARE APPLIED — never edit either.**

## 9. Live agent sessions

⛔ **ASK A SESSION ITS MODEL; NEVER READ IT OUT OF THIS TABLE** (DEF-361).

| Session | Role today | State |
|---|---|---|
| `system32-4f` | orchestrator | this session — **clear it** |
| `webapps-9e` | **TESTER** | stood down, lane closed. Wrote the red, caught the untested production gate, and refused to claim an identity the screen could not show |
| `webapps-71` | **BUILDER** | stood down, lane closed. **Refused a green-in-one-move** rather than defeat React's escaping to pass an assertion |
| `webapps-f8` | **AUDITOR** | stood down, lane closed. Ran on Opus. Reversed two orchestrator rulings, both correctly |

⚠️ **The working tree still carries `docs/reviews/NEXT-PROMPT.md` (modified) and
`docs/reviews/2026-09-17.md` (untracked)** — the exited `/daily-review` session's, never ours,
deliberately not committed on 2026-09-17 or today.

## The paste-ready prompt

<!-- Copy everything between the two rows of dashes. -->

-----------------------------------------------------------------------------------------------

You are the orchestrator for shareat-system (C:\Users\ianla\webapps\shareat-system). Run the
global /orchestrator skill. You are starting COLD.

⭐ IAN'S GOAL: "make the app as close as possible to deployment."

⭐⭐ THREE SESSIONS, THREE FIXED ROLES: a TESTER who writes the red and drives the real screen in
Chrome, a BUILDER who makes it green and never edits a test file, an AUDITOR who runs /code-review
READ-ONLY on every slice. Read SKILL.md §2 before briefing anybody.

⛔ A SLICE HANDED FOR REVIEW IS FROZEN (bible row 215). Tell the LANES, not just yourself. And give
the auditor a VERIFIABLE REFERENCE OBJECT per round — stage the slice paths, `git write-tree`,
`git commit-tree -p HEAD`, then `git reset`. HEAD never moves and the auditor can diff against a
real object instead of catching a baseline in flight with `cp`. Say "THE TREE IS FROZEN" as a
statement of fact; "stand by" is not a freeze.

⛔⛔ THE DAY'S TWO RULES, both in docs/HANDOFF-TODAY.md §3 with their evidence:
(a) ROW 214 HAS A MIRROR — a PRESERVED line can be falsified by a change made elsewhere, and a
deletion audit is structurally blind to it. Found FOUR times on 2026-09-18, including DEF-368's own
lie alive in a file outside every sweep. THE MIRROR NEEDS A SEARCH FOR THE OLD CLAIM.
(b) A VERIFICATION THAT SILENTLY SKIPS PART OF ITS INPUT REPORTS SUCCESS. Five instances in one day,
including callers.mjs crediting a caller that does not exist, and `git diff` reporting untracked
files as deleted. DO NOT QUOTE A VERDICT LINE YOU HAVE NOT READ THE BODY OF.

Read: docs/RULES.md, docs/HANDOFF-TODAY.md, PROJECT_BIBLE.md rows 204-215, DEFECTS-REGISTER.md
section E. ⛔ GREP the big ones — the register is ~1MB and the bible ~418KB.

⛔ T-323 IS DONE AND PUSHED (3542a91). DEF-371 and DEF-368 are closed. Do not re-open them.
⛔ CHECK CI ON 3542a91 FIRST — it was in progress at wrap-up, and integration was NOT run locally.
Use the API: gh api repos/ianlalusin/shareat-system/actions/runs/<id>/jobs

⛔ FIREBASE_AUTH_EMULATOR_HOST IS NO LONGER HARMLESS. Set on a production host it breaks sign-in for
everyone, deliberately, rather than accepting unsigned tokens. It is not in deploy.yml's allowlist
and deploy-preflight.ts has no denylist — that gap is now security-relevant and unspecced.

⭐ SIGN-IN NOW WORKS ON A DEV MACHINE — the recipe is handoff §4 and it needs SIX environment values,
not two. IAN MUST PASTE ANY PASSWORD OR TOKEN; a uid is not a credential and you may handle it.

⛔ MEMORY IS THE HIDDEN CAUSE ON THIS MACHINE. It bit three times on 2026-09-18 and looked like a
code problem every time. Sequence heavy runs one at a time. And a harness "killed for memory" notice
does NOT mean the child processes died — check the port, then check FUNCTIONALLY.

Next task T-324 · next defect DEF-372 · next migration 0154.

-----------------------------------------------------------------------------------------------

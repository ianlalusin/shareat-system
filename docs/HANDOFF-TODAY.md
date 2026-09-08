# Handoff — 2026-09-08 (midday) — for the NEXT ORCHESTRATOR

> **You are taking over as the ORCHESTRATOR of a running four-lane team.** The worker sessions are
> ALIVE on this machine and parked at clean boundaries — **re-adopt them, do not respawn.** Only the
> orchestrator session is cleared at each milestone (Ian's rule, `CLAUDE.md` § "Orchestrated
> sessions hand over"). **Do the same when you cross the next one.** Ian invokes `/orchestrator
> shareat system` in your terminal himself; the skill is user-invocation only — run the role from
> this file until he does.

## Where things stand

`main` is at `4093bb1` plus this handoff commit, pushed. **T-232 is complete in code and deployed by
CI: Ian signs in on production with his v1 email and password, and — because no organisation exists
— lands on `/setup`, creates the organisation in one transaction and lands inside.** The real sign-in
with his password is the one step nobody else can take; it is the milestone, and it was still his to
do when this was written. **T-233 shipped** (DEF-219: the scheduler's per-org seam is total, ten
jobs). Four commits today: `09a2b44` docs, `4ecc08b` T-233, `da55176` T-232 slice 1, `4093bb1`
T-232 slice 2; then the handoff commits and **T-234's spec** (the responsive shell Ian asked for
at the end of the session — item 3 below). Tree clean.

## Gates at `4093bb1`

typecheck clean · unit **70 files, 1110 passed / 1 skipped** · integration **106 files, 2602 passed** (full `npm run test:integration` on `shareat_test` at HEAD, 1406 s, every lane parked) · build
**exit 0** with 9008 free · browser on 9008 against a fresh empty throwaway DB with v1's public
client config exported in-process: **35/36** (the one miss is the console check catching Firebase's
expected 400 on a wrong password) — `/sign-in` both forms at 390px with 0 px overflow; `/setup` end to
end (no cookie → "window has closed", a 2-digit PIN past the browser's own validation → "the PIN must
be exactly 6 digits" with the window kept, the real submit → `/` with eleven rows counted, `/setup`
then refuses everyone, the chosen PIN signs in). Lane C verified every slice on its own DB; every
slice had an Opus second read (Ian's rule: lane C reviews on Sonnet, so review judgement went to an
Opus subagent per READY — ~180k tokens each, and each found something real).

## ⭐ The four agent sessions — re-adopt by name (`ListAgents`)

| Lane | Session · model | State | Lane DB | Natural next slice |
|---|---|---|---|---|
| **B** | `ianla-3a` · Opus | T-232 slice 2 COMMITTED; parked clean | `shareat_test_t229` | **DEF-222**: one environment-gated formatter for the pre-session surfaces (`/sign-in` both paths, `/setup`), generalising `emailSignInMessage` + `setupErrorMessage`; two call sites, one test |
| **C** | `ianla-87` · Sonnet | QA; parked. ⚠️ Ian may have CLEARED this terminal — if `ListAgents` shows it but it does not ACK a RE-ADOPT with context, re-brief it cold (it verifies; no spec) | `shareat_test_qa` | code-review every READY; integration on its DB; the browser sweep only if Ian grants its terminal dev/build permissions (still not granted) |
| **D** | `ianla-0a` · Opus | T-232 slice 1 COMMITTED; parked clean | `shareat_test_t216b` | **DEF-224** (its seam): a migration making `person_credentials_external_id_unique` partial on `revoked_at is null`; `/admin/users` link/unlink for a Firebase credential, unlink ending that person's sessions — **the migration lane** |
| **E** | `ianla-60` · Sonnet | T-233 COMMITTED; parked clean. ⚠️ Ian may have CLEARED this terminal — re-brief cold from DEF-226 if so | `shareat_test_def219` | **DEF-226** first (the 15-day order-wastage backstop has NO caller — a script in the shape of `finding-observation.ts`, a `package.json` line, a systemd pair in `docs/ops`), then DEF-225 and DEF-227 in the same file |

Re-adopt each with a first line `[X] RE-ADOPT: <one sentence from this table>`; they know the
protocol. **Name the model in every briefing** (bible row 184) and put terminals Ian must switch in
the board's "Needs you" — a session cannot switch itself.

**Protocol the lanes follow:** first line `[X] STATUS: sentence`, STATUS ∈ ACK/QUESTION/SPEC/READY/
BLOCKED (lane C: VERIFIED/FAILED). Workers never run git, build, dev or `npm run test:integration`;
integration only via `node ~/.claude/skills/orchestrator/tools/it.mjs <lane db> <files>`; a new
lane DB via `make-test-dbs.mjs <name>`. You alone stage explicit paths, commit with `git commit -F
<file>`, push, and edit the bible, register, roadmap, barrels, guards' registries and nav. Lanes
write specs; you approve; then they build. Two lanes' hunks in one file → one commit that says so.

## Pick up here, in this order

1. **Ian's production sign-in is the milestone** (board item 2). ✅ **The local proof is DONE**:
   at 02:09 UTC on 2026-09-08 Ian signed in on `http://localhost:9008/sign-in` with his real v1
   email and password against a dev server pointed at the empty `shareat_test_setup3` and created
   `SHAREAT_OPC` from `/setup` — a real token verified end to end (`verifyIdToken` with the project
   id alone, the three-way decision, the setup cookie, the transaction, the session). The deploy of
   `4093bb1` completed at 02:04 UTC. (To repeat the local check on a fresh DB: `make-test-dbs.mjs
   <name>` then `node ~/.claude/skills/orchestrator/tools/smoke-dev.mjs <name>` — the launcher reads
   v1's public config from `ERP-rebuild/src/firebase/config.ts` at run time; nothing is committed.)
   Then production: **he must do the setup immediately after the deploy** — until he does,
   any account in v1's Firebase project that finds the URL could claim the organisation (decision 5;
   one env var could lock the door to his email if he wants it — his call). Production also still
   needs `FIREBASE_PROJECT_ID=studio-7300228488-a394e` in the droplet's `/srv/shareat-shared/.env.local`
   and the five `NEXT_PUBLIC_FIREBASE_*` secrets equal to v1's — neither could be verified from here
   (the deploy key is refused for `shareat@`, and the classifier blocks further ssh).
   **If the sign-in fails on production, that is item 1 for every lane.**
2. Re-adopt the four lanes with the slices in the table. DEF-226 is the most consequential open
   defect (tracked wastage never auto-charges); DEF-224 is the migration lane — give out no other
   migration slot while D holds it.
3. **T-234 — the responsive shell, specced and waiting for lanes** (`docs/tasks/234-responsive-shell-
   sidebar-nav.md`, written by this orchestrator at Ian's request on 2026-09-08, his WHAT in the
   header). Two slices, disjoint files: slice 1 the three-state sidebar (drawer / rail / full,
   cookie-persisted, POS's shadcn sidebar as the visual benchmark, hand-rolled, no new dependency);
   slice 2 one `<Page density>` container for every route, two-column detail pages at ≥ 1280,
   DEF-199's filter row, and a page-container guard. Both execute a written spec → Sonnet lanes;
   recommended: slice 1 → lane E after DEF-226 (or a fresh lane), slice 2 → lane B after DEF-222.
   The lane reads the spec and reports defects as QUESTION before building; you own the two guards.
   Ian asked for this explicitly; sequence it right after the defects in the table, before DEF-218.
4. Queued behind those: DEF-218 (the harness must connect as a non-superuser, non-BYPASSRLS role —
   touches every job suite's fixture path, so alone on the tree), DEF-216 + the tutorials question,
   DEF-221 (a guard that a `*.test.ts` under any `tests/integration/` the config does not include
   fails), DEF-220, DEF-199's one `flex-wrap`, T-231's two sweeps.

## Do not decide these alone — they are Ian's

- **Tutorials**: count the walls first (half a day) or pick ten by judgement (`docs/discovery/30`
  §10 recommends counting).
- **Locking the first-run door to one email** before the organisation exists (an env var) — only
  matters if the deploy lands long before he does the setup.
- **Arming the recurring-expense timer** on the droplet (DEF-194: `docs/ops/*.service` and
  `.timer` ship in docs, not the artifact), and, once DEF-226 has a script, arming that one too.
- **Fourteen stale databases** to drop (the classifier blocks the orchestrator): the ten on the
  board plus `shareat_test_t229_cli`, `shareat_test_setup`, `shareat_test_setup2`, and
  `shareat_test_setup3` (his local check is done). Keep `shareat_dev`, `shareat_test`,
  `shareat_test_t229`, `shareat_test_t216b`, `shareat_test_qa`, `shareat_test_def219`.

## Decisions Ian made today, and where each is recorded

Bible §13 row **184** (Sonnet wherever the work can be done by Sonnet — whole lane terminals, the
orchestrator names the model in every briefing, Ian switches with `/model`; also RULES §2, `CLAUDE.md`,
the global orchestrator skill's briefing template). Row **185** (first-run setup is the ONE request
path that opens an owner-role transaction without a principal, deliberately — not a precedent).
Ian's model split for the live lanes: B and D Opus, C and E Sonnet, orchestrator Fable. Auto-mode
decisions the orchestrator took for him, all reversible, are on the board's "Decided for you".

## Traps that have actually bitten today

- **Two guards enumerate files with `git ls-files`, and one of them saw only TRACKED files.** The
  nav guard uses `--cached --others --exclude-standard` (untracked routes count); the raw-transaction
  guard used tracked only, so a lane's new pre-auth file made its exemption check cry wolf until
  staging, and an untracked offender was invisible until then. Fixed to match the nav guard. Rule:
  **before calling the unit project green on a slice with NEW files, ask which guards enumerate
  tracked files.**
- **An Opus review launched mid-build reports the half-written state as blockers.** The slice 2
  review started while lane B was writing `grantCapabilityAsActor`; two of its three "blockers"
  were that. Launch the second read only after the lane's READY, and read its findings against the
  tree as it is now, not as the reviewer saw it.
- **Two lanes on one test file at the same instant** — lane C saw `roles.test.ts` red for seconds
  while lane B was mid-write (`grantCapabilityAsActor is not a function`), re-ran, green. When two
  lanes' hunks land in one file, hold the commit until both are READY, and tell lane C which file
  is moving.
- **Import cost lives in the FILE, not the path** (memory `reference_import_cost_lives_in_the_file`):
  a constant in `roles.ts` cost 1.94 s of `@shareat/db` graph per unit test however it was imported;
  in `capabilities.ts` (imports nothing), 70 ms. "Move it if over N seconds" measures the wrong thing.
- **Commit order makes the register honest**: the register carried rows for all three commits, so it
  was staged with the LAST one, after the work it describes existed on `main`.
- **The classifier blocked**: ssh to the droplet (any key), `DROP DATABASE`, and — once each,
  transiently — a background `npm run test:integration` and a background dev-server start; the plain
  re-issue of each went through. Say what was blocked; never route it through a lane.
- **Playwright**: the Chrome extension and the Playwright MCP still do not work here; the npx-cache
  harness does (memory `reference_playwright_smoketest_harness`). Today's scripts live in
  `~/.claude/skills/orchestrator/tools/`: `smoke-dev.mjs` (dev server on a lane DB with v1's public
  config), `forge-setup-cookie.mjs` (a `shareat_setup` cookie signed with the LOCAL secret — how
  `/setup` was driven without Ian's password), `q.mjs` (quiet SQL), `run-with-db.mjs` (any script
  against a lane DB), `smoke-t232.mjs`, `smoke-admin.mjs`. A 2-digit PIN never reaches the server —
  the browser's own `pattern` stops it — so the crafted request sets `form.noValidate` first.
- **Stale lane DB after a peer's migration** reads as a regression (`column … does not exist`) —
  re-run `make-test-dbs.mjs <lane db>` before diagnosing. No migration shipped today, so every lane
  DB is current at 0136.

## The status board — update it at EVERY commit

Ian reads **https://claude.ai/code/artifact/b1555e09-a726-492b-a431-7a30791e1d50** instead of chat
reports. `Artifact action:"read"` it, rebuild the HTML locally, republish with that `url` after every
commit and every lane state change (labels max 60 chars): Needs-you · Lanes · Phases · Shipped ·
Flagged · Decided-for-you. **Never create a second board.** `docs/ROADMAP.html` moves at the same
moments.

## The paste-ready prompt

```
You are the ORCHESTRATOR for shareat-system. Read C:\Users\ianla\webapps\shareat-system\docs\HANDOFF-TODAY.md
in full, then docs/RULES.md. Ask Ian to type /orchestrator shareat system in your terminal (the
skill is user-invocation only). Four agent sessions are ALIVE on this machine and parked clean: run
ListAgents, then re-adopt lane B = ianla-3a (Opus), lane C = ianla-87 (Sonnet, QA), lane D =
ianla-0a (Opus), lane E = ianla-60 (Sonnet) by SendMessage, first line "[X] RE-ADOPT: <one
sentence from the handoff's table about them>". Do not respawn and do not re-brief from scratch —
their lane DBs and natural next slices are in the handoff's table; name the model in every briefing
(bible row 184).

T-232 shipped: Ian signs in on production with his v1 email and password and sets the
organisation up from /setup. His real sign-in is the milestone and is still his to do (handoff
§ "Pick up here", item 1 — and the dev server for his local check first). You own the dev server
on 9008, builds, the dev-DB migration and the browser passes (lane C's session cannot run them);
lanes never run git, build, dev or npm run test:integration. Stage explicit paths, commit with -F,
push, and update docs/ROADMAP.html and republish the status board at EVERY commit. Every READY
gets lane C's gates on its DB and, since lane C is on Sonnet, an Opus second read (a subagent) —
launched only after READY, never mid-build. When Ian's production sign-in works — or any task
completes with the tree clean — that is a milestone: run /wrap-up, rewrite this file for the next
orchestrator, and hand over. Keep your session small.
```

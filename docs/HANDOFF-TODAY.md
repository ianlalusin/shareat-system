# Handoff — 2026-09-07 (evening) — for the NEXT ORCHESTRATOR

> **You are taking over as the ORCHESTRATOR of a running four-lane team.** The worker sessions are
> ALIVE on this machine and parked at clean stopping points — **re-adopt them, do not respawn.**
> Only the orchestrator session was cleared, on purpose: at every milestone the orchestrator wraps
> up, rewrites this file as the next orchestrator's prompt, and hands over, so no session carries a
> long context (Ian, 2026-09-07 — recorded in `CLAUDE.md` § "Orchestrated sessions hand over").
> **Do the same when you cross the next milestone.**

## Where things stand

`main` is at `ea4569d`, pushed. CI green and deployed through `6a6e03c`. **Today shipped eleven
commits across four lanes**: T-230 (sales channels + per-channel wastage policy), **T-229 complete**
(settings shelf, category mapping, wastage monitor, category create/rename/retire, org/store
identity + TIN), **T-231 complete** (the hidden-org-id hole closed, every request path under an RLS
principal, the `getDb()` door shut), **T-216 complete** (recurring bills draft themselves, never
auto-pay), the DEF-209 assessment (RLS was never dormant), and the tutorials assessment.

**In flight, committed as WIP: T-232**, Ian's goal for the day — *sign in on production with the v1
email and password, see the app, set the organisation up from inside*. Lane D built the signed
setup-cookie seam (12/12 unit). Lane B has the first-run domain function and its tests in
progress. Neither half is usable yet. **This is item 1.**

## Gates at `ea4569d`

typecheck clean · unit **66 files, 1077 passed / 1 skipped** · integration **105 files, 2576 passed** (full `npm run test:integration` on `shareat_test` at 0136) · build **exit 0** with 9008 free · lane C's browser sweep of today's routes: **21 routes × 2 viewports, 42/42 HTTP 200, no error boundary, no console error** — 12 pre-existing phone-width overflows traced to ONE unwrapped filter row (DEF-199's stated cause corrected in the register); every route touched by today's commits is overflow-clean; `/ap/invoices/[id]` renders against the pending RECUR invoice the job created.

Lane C's standing audit (its own DB, `shareat_test_qa`, current with `6a6e03c`): **99/99 integration
files, 2239 tests, 0 failed** — a composite of two runs (chunks 1–9 and 11–13 before 0136 landed,
chunk 10 re-run after; nothing in 0136 touches the other twelve chunks). The browser half is DONE too (the line above); the audit is complete. Two register rows came out of it: DEF-199's cause corrected (one `flex-wrap` closes twelve overflows) and DEF-220 (the commissary catalogue defaults to a branch).

## ⭐ The four agent sessions — re-adopt by name (`ListAgents`)

| Lane | Session | State | Lane DB | Spec | Next |
|---|---|---|---|---|---|
| **B** | `ianla-14` (Opus) | T-232 slice 2: domain core BUILT — `bootstrapOrganization`, the four derived grants in `createFirstAdmin`, `lockFirstRun`/`anyOrganizationExists`; 13/13 new + 446/446 on the suites it touches | `shareat_test_t229` (at 0136) | `docs/tasks/232-…` § "Slice 2 — contract" (APPROVED) | in order: (1) `packages/auth/src/roles.ts:218-226` widening + its test; (2) `apps/erp/src/app/setup/{page,actions,lib}` on lane D's seam; (3) `scripts/bootstrap-org.ts` → `bootstrapOrganization`; (4) `docs/ops/README.md`; READY |
| **C** | `ianla-87` (QA) | standing audit, non-browser half done | `shareat_test_qa` | none — it verifies | code-review every READY; integration on its DB; the browser sweep only if Ian grants its terminal dev/build permissions |
| **D** | `ianla-0a` (Opus) | T-232 slice 1: the `SetupIdentity` seam BUILT and contract-tested (12/12, incl. "a bare SESSION_SECRET HMAC does not verify"); nothing else started | `shareat_test_t216b` | `docs/tasks/232-…` slice 1 | in order: `apps/erp/src/lib/firebase-auth-admin.ts` → `sign-in/EmailSignInForm.tsx` → `signInWithEmailAction` + its 3 integration branches → `packages/core/src/env.ts` (make `publicEnv()` stop hard-requiring the storage bucket for sign-in) + `.env.example`; READY |
| A | `ianla-3a` | **RELEASED**, clean — Ian may have cleared it | `shareat_test_t228` (drop) | — | if the terminal is reopened it is a fresh lane: DEF-218 (test-harness role), the `bible §6.3` citation sweep + guard, the `.filter(type-predicate)` sweep |

⚠️ **Lane C's session cannot run `npm run db:migrate`, `npm run build` or `npm run dev`** — its
permission classifier refuses them and (correctly) refused its own attempt to add allow rules.
Until Ian adds allow rules in that terminal, **the orchestrator owns the dev server on 9008, builds,
the dev-DB migration, and the browser passes**; lane C keeps code-review, typecheck, unit and
integration on its own DB.

**Protocol the lanes already follow:** first line of every message `[X] STATUS: sentence`, STATUS ∈
ACK/QUESTION/SPEC/READY/BLOCKED (lane C: VERIFIED/FAILED). Workers never run git, build, dev or
`npm run test:integration`; integration only via `node ~/.claude/skills/orchestrator/tools/it.mjs
<lane db> <files>`; a new lane DB via `make-test-dbs.mjs <name>`. You alone stage explicit paths,
commit with `git commit -F <file>`, push, and edit the bible, register, roadmap, barrels and nav.
Lanes write specs; you approve; then they build. Ian sometimes instructs a lane directly — accept
it, and when two lanes' hunks land in one file, commit both slices in one commit that says so.

## Pick up here — T-232, in this order

1. **Ian's two actions gate everything** (also on the board): GitHub Secrets
   `NEXT_PUBLIC_FIREBASE_API_KEY`, `_AUTH_DOMAIN`, `_PROJECT_ID`, `_APP_ID` = v1's values
   (`ERP-rebuild/src/firebase/config.ts`, project `studio-7300228488-a394e`) **plus
   `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`** (lane D found `publicEnv()` hard-requires it today; lane
   D's env.ts change should stop it gating sign-in, but set it anyway); and
   `FIREBASE_PROJECT_ID=studio-7300228488-a394e` in the droplet's `/srv/shareat-shared/.env.local`.
   `gh secret list` shows what exists before you assume.
2. Lane D finishes slice 1; lane B finishes slice 2. Their seam is agreed and built (`SetupIdentity`,
   cookie `shareat_setup`, 10-min TTL, HMAC under the `setup-identity` label). Each READY → you read
   the diff, relay to lane C for review + integration, run typecheck/unit/build yourself, then **the
   one thing only 9008 can prove: a real Firebase email sign-in against v1's project** — export the
   five `NEXT_PUBLIC_FIREBASE_*` values and `FIREBASE_PROJECT_ID` in your own shell for the dev
   server (never commit them), sign in with Ian's v1 email on `/sign-in`, land on `/setup`, create an
   org on `shareat_dev` (its `organizations` table is NOT empty — clear the guard's precondition on
   a throwaway DB or add a dev-only override lane B specs), land on `/`.
   Two things the lanes settled between themselves and I ratified: the sign-in refusal for a verified uid with no credential while an org EXISTS reads "This account is not linked to a person. Ask an administrator to link it" (lane D), and the setup refusal when an org exists reads "…first-run setup is closed" (lane B) — two questions, two sentences, keep both. And lane C should look at one thing specifically: `packages/domain/src/organizations/index.ts` now imports `createStore` from `../stores/service`, which imports back — an import cycle that resolves only because both crossings are hoisted function declarations (lane B left a ⛔ comment).
3. Commit each slice (or both together if their files interleave), push, watch CI + Deploy, then
   tell Ian: sign in on production. **If it works, that is the milestone: wrap up and hand over.**

Queued behind T-232 (never beside it): T-231's two sweeps (§6.3 citations with a guard;
`.map().filter(type predicate)` chains), DEF-218 (a non-superuser test role so a job without a
principal fails in tests, not in production), DEF-219 (the scheduler runner's `startRun` inside the
per-org boundary — one runner change), DEF-216 (readiness links, half a day, and step one of the
tutorials proposal), the T-216 nit (the no-op run prints "ok" without the count), and the tutorials
feature once Ian answers the question below.

## Do not decide these alone — they are Ian's

- **Tutorials**: count which walls people hit first (half a day, ranks the pages) or pick the first
  ten by judgement. `docs/discovery/30-tutorials-assessment.md` §10 recommends counting. Ian's WHAT
  is in its header: a tappable `?` on every page that needs it, describing the page and how to use
  the feature.
- **Arming the recurring-expense timer** on the droplet after the deploy — `docs/ops/*.service` and
  `.timer` ship in docs, not the artifact (DEF-194). Until then bills draft only by hand.
- **Ten stale lane DBs** to drop (the permission classifier blocks the orchestrator): the eight on
  the board plus `shareat_test_t228` and `shareat_test_t216` (superseded by `t216b`).
- The production role probe is optional now — after T-231 both outcomes are safe.

## Decisions Ian made today, and where each is recorded

Bible §13 rows **180** (per-channel wastage policy), **181** (the tenancy id never comes from the
client; RLS is the second layer, never the only one), **182** (the cutover keeps store settings —
the Monitor survives), **183** (a recurring expense drafts and never auto-pays); T-232's header
(six decisions; decision 3 superseded by lane B's §2.2 — one active role per person, so `admin`
plus the four super-admin-only capabilities as grants, an exact equivalence); the roadmap's
tutorials line (the `?` per page); `CLAUDE.md` (the milestone handover rule). Auto-mode decisions
the orchestrator took for him, all reversible, are on the status board's "Decided for you" table.

## Traps that have actually bitten today

- **Stale lane DB after a peer's migration** reads as a regression in a suite you never touched
  (`column … does not exist`). Re-run `make-test-dbs.mjs <lane db>` BEFORE diagnosing. `shareat_dev`
  is migrated by the orchestrator only once a migration file is FINAL (READY), never mid-build.
- **`npm run db:generate` is unusable** — its snapshot chain died at 0019. Migrations are
  hand-written from the schema (0131–0136 say so in their headers); `when` strictly greater than
  the previous entry's; re-read the journal before appending.
- **Grep raw `sql` strings for the snake_case name before dropping a column** — typecheck only sees
  builder references; a drop goes green and fails at runtime (T-229 slice 2).
- **A sweep that reports a total must first report a known non-zero control** (bible §12, v3.11):
  heredocs eat escapes, a line-based grep misses a multi-line import, a regex truncates a message.
- **A job test cannot see a missing RLS principal** — the harness connects as a superuser
  (DEF-218). Probe by hand until the harness role changes.
- **A unit test that imports anything from `apps/erp/src/lib/` pays ~4.7 s of module graph before its first assertion** (`@shareat/auth` → `@shareat/db` → the schema barrel) against the unit project's 5 s timeout. Static-import it; keep `vi.resetModules()` out of `beforeEach`. And run the PROJECT gate, not the file, before calling anything green — a file passing alone proved nothing twice today.
- **Playwright**: the Chrome extension is not connected and the MCP wants Google Chrome. Use the
  npx-cache harness (memory `reference_playwright_smoketest_harness`); the previous orchestrator's
  scripts lived in its scratchpad and are gone — the pattern is a clean `goto`, click, then
  `waitForURL` on `?ok=|?error=`; `require` dotenv/postgres by ABSOLUTE path from the repo's
  `node_modules`; a `has:` locator is relative to its parent (never prefix it with `form `);
  "Dev Cashier" (PIN 333333) has been a manager since 5 Sep — staff denial comes from tests.

## The status board — update it at EVERY commit

Ian reads **https://claude.ai/code/artifact/b1555e09-a726-492b-a431-7a30791e1d50** instead of chat
reports. `Artifact action:"read"` it, rebuild the HTML locally, republish with that `url` after
every commit and every lane state change: Needs-you · Lanes · Phases · Shipped · Flagged ·
Decided-for-you. Keep every line short. Memory `reference_shareat_system_board_artifact` holds the
design. **Never create a second board.** `docs/ROADMAP.html` moves at the same moments.

## The paste-ready prompt

```
You are the ORCHESTRATOR for shareat-system. Read C:\Users\ianla\webapps\shareat-system\docs\HANDOFF-TODAY.md
in full, then docs/RULES.md. Ask Ian to type /orchestrator shareat system in your terminal (the
skill is user-invocation only). Four agent sessions are ALIVE on this machine and parked: run
ListAgents, then re-adopt lane B = ianla-14 (T-232 slice 2), lane C = ianla-87 (QA), lane D =
ianla-0a (T-232 slice 1) by SendMessage, first line "[X] RE-ADOPT: <one sentence from the handoff's
table about them>"; lane A = ianla-3a is released. Do not respawn and do not re-brief from
scratch — their specs, lane DBs and next slices are in the handoff's table.

The day's goal is T-232: Ian signs in on production with his v1 email and password and sets the
organisation up from inside. Two things gate it and are Ian's: the Firebase secrets and the
droplet's FIREBASE_PROJECT_ID (handoff § "Pick up here", item 1). You own the dev server on 9008,
builds, the dev-DB migration and the browser passes (lane C's session cannot run them); lanes
never run git, build, dev or npm run test:integration. Stage explicit paths, commit with -F, push,
and update docs/ROADMAP.html and republish the status board at EVERY commit. When T-232 works on
production — or any task completes with the tree clean — that is a milestone: run /wrap-up,
rewrite this file for the next orchestrator, and hand over. Keep your session small.
```

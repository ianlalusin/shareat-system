# T-308 — publish the deployed revision, then assert production is not running something older than `main`

> ✅⭐ **STATUS: SLICE A IS SHIPPED AND VERIFIED IN PRODUCTION (2026-09-14). SLICE B IS APPROVED,
> UNBUILT, AND BLOCKED ON IAN'S TOKEN — Done-when B4, and nothing else.**
>
> **Slice A** — commit `60935e9`, deployed by run `34803535420`. Production reports
> `revision.sha = 60935e97938a9fe232a968b346c466ac9833a0fb`, **compared character-for-character
> against the commit the deploy ran from** (Done-when A6). A5 was smoketested on 9008 first. The
> measurements are at the foot of §Done when — ⛔ **do not re-litigate the decisions recorded here;
> they were taken, built and proven.**
>
> **Slice B** — spec below is APPROVED. It needs a fine-grained PAT at
> `/srv/shareat-shared/secrets/github-guard.token`, which only Ian can mint. A lane that cannot
> complete B4 reports **BLOCKED**; it does not report done.
>
> ⚠️ **This banner previously read *"SPEC WRITTEN … AWAITING APPROVAL"* for the whole of the day on
> which the spec was approved, slice A was built, reviewed twice, shipped and verified.** It was
> true when written. **Found at wrap-up by its own author** (lane C), who noted that the file a cold
> session opens to build slice B was telling it, in bold, in the first line, that nothing had been
> approved yet — while the proof sat 390 lines below. ⛔ **A status line is as perishable as a
> diagnosis** — `PROJECT_BIBLE.md` §13 row 204, written the same morning. **Eighth instance of that
> class in one day, and the third found by the author of the thing it was wrong about.**
>
> Supersedes the
> *"number reserved, spec not yet written"* banner. The analysis this spec rests on was written by
> lane C on 2026-09-13 and is preserved verbatim in **§Why** below — it is the reasoning, not
> background, and a reviewer who skips it will re-open settled questions.
>
> ⭐ **TWO SLICES, AND SLICE A SHIPS WITHOUT SLICE B.** Slice A (publish the sha) needs no
> credential and no placement ruling. Slice B (the lag checker) needs both. They are specified
> together because B reads what A publishes, and separated in **Scope**, **Tests** and
> **Done when** so A can land today.
>
> ⭐ **IAN'S DECISION, 2026-09-14: the sha is published on `/api/health`.** He was told the endpoint
> is unauthenticated and that this tells a stranger which build production is on, and chose it over
> the private alternative's extra credential and wiring. **That is an accepted, named cost, not an
> oversight** — see Invariant A4, which states exactly what is disclosed and what is not.

---

## Goal

**Slice A.** `/api/health` reports the exact commit the running process was built from, so
*"which commit is production on?"* is answerable in one unauthenticated GET instead of an SSH
session plus inference from a directory timestamp.

**Slice B.** A check running off-GitHub, on a schedule, fails loudly when production has been
running a commit older than `origin/main` for longer than a stated threshold — and names the cause
rather than only the symptom.

---

## Scope — the only paths each slice may create or modify

**Slice A**
- `apps/erp/src/app/api/health/route.ts` — add the `revision` field.
- `apps/erp/src/generated/revision.ts` — **new, tracked, committed as a placeholder** (see
  Contract A2 for why it is committed rather than ignored).
- `scripts/write-revision.mjs` — new.
- `package.json` — one script entry.
- `.github/workflows/deploy.yml` — one new step. ⚠️ **One env var, on that step only** — see the
  2026-09-14 correction at Contract A4.
- `tests/unit/deployed-revision.test.ts` — new.

**Slice B**
- `docs/ops/revision-lag-guard.mjs` — new. ⛔ **`docs/ops/`, not `scripts/`** — Contract B1.
- `docs/ops/shareat-revision-lag-guard.service`, `docs/ops/shareat-revision-lag-guard.timer` — new.
- `docs/ops/provision.sh` — install the guard script to a fixed path.
- `docs/ops/README.md` — the arming and verification lines.
- `tests/unit/scheduler-job-hosting.test.ts` — the named exception. ⛔ **Not optional** — Invariant B5.

⛔ Neither slice touches `docs/DEFECTS-REGISTER.md`, `PROJECT_BIBLE.md`, `docs/ROADMAP.html`,
`docs/tasks/307-*.md`, `packages/**`, or any migration.

---

## Contract

### Slice A — publish the deployed revision

**A1. The response shape.** `/api/health` gains one field, present on **every** response — the 200
and both 503s:

```
revision: { sha: string, builtAt: string | null }
```

`sha` is either a 40-character lowercase hex string or the literal `"unknown"`. `builtAt` is an
ISO-8601 UTC instant or `null`. ⛔ **No other value is legal**, and the two move together: a real
`sha` always carries a real `builtAt`.

**A2. Where the value comes from — a module generated at build time, baked into the artifact.**
`scripts/write-revision.mjs` writes `apps/erp/src/generated/revision.ts` as a plain
`export const REVISION = { sha: '…', builtAt: '…' } as const;`. It runs **before `next build`**, on
the CI runner, and the constant is compiled into `.next`.

⭐ **Why baked in and not read from a file at runtime, and this is decisive rather than a
preference.** The deploy swaps `/srv/shareat` last and then restarts the service
(`deploy.yml:143-145`). If the symlink moves and the restart does not take, a runtime file read
would report the **new** release's sha while the process is still executing the **old** build — the
guard would go green on a real failure. A value compiled into `.next` cannot disagree with the code
it labels, so slice B detects that case for free.

⭐ **Why the file is committed rather than gitignored.** Typecheck runs before the build
(`ci.yml:146-147`), so an absent module fails `tsc --noEmit` on every developer machine. The
committed content is the **placeholder** — `sha: 'unknown', builtAt: null` — which is also exactly
the right answer for a local dev server and a test run. The runner overwrites it in place before
building; nothing commits it back.

**A3. The unset path, and it fails in two different directions on purpose.** The generator reads
one env var, `DEPLOY_REVISION_SHA`.

| Where | Value absent or not 40-hex | Why |
|---|---|---|
| Local dev, `npm run build` by hand, any test | **Writes the placeholder and exits 0** | A developer has no sha and does not need one |
| `deploy.yml` (invoked with `--require`) | ⛔ **Exits 1 and fails the deploy** | A production artifact that cannot say what it is can never be checked |

⛔ **The generator never invents a value.** No `git rev-parse` fallback, no `"dev"`, no empty
string, no timestamp-only record. **DEF-311 is the standing proof that a plausible-looking wrong
value costs more than an honest absence** — there, `FIREBASE_STORAGE_BUCKET` held a string that read
as correct and the repository could not tell the safe reading from the unsafe one.

**A3b. The output-path override, and it is an ARGV FLAG, not an environment variable.** The
generator accepts `--out <path>`, defaulting to `apps/erp/src/generated/revision.ts`. Its only
purpose is to let the test suite exercise the writing cases without touching the tracked file
(Done-when A2b). ⛔ **It changes WHERE the file is written and nothing else** — never whether
`--require` refuses, never what is written.

⚠️ **Why argv and not an env var, which is what this correction first proposed.** An environment
variable is inherited by every child process and can be set far away from the command it affects;
argv cannot leak in. **If `REVISION_OUTPUT_PATH` were ever set in the deploy environment for an
unrelated reason, the deploy would write the revision to the wrong path and then build the
placeholder** — shipping a production artifact that reports `unknown`, or worse, silently keeping a
stale value, with `--require` having passed and nothing red anywhere. That is this task's own
failure shape re-entering through the mechanism meant to make the task safe. An argv flag is the
same number of lines, and the test already passes `extraArgs`.

**A4. What `deploy.yml` passes, and it must be the same expression that is already there.**
`deploy.yml:47` resolves the deployed commit as
`${{ github.event.workflow_run.head_sha || github.sha }}` and discards it. That **same expression**
is passed as `DEPLOY_REVISION_SHA` to the revision step — **and to that step only**.
⛔ **Do not substitute `git rev-parse HEAD`.** The checkout is detached at that ref so the two agree
today; two sources that agree today are still two sources.

> ⛔ **CORRECTION, 2026-09-14 — this clause originally said "to the revision step **and the `Build`
> step**", and those four words were wrong.** Lane A implemented them faithfully; the defect was in
> this spec, not in the build. **Nothing reads `DEPLOY_REVISION_SHA` at build time** — measured:
> `apps/erp/next.config.js` holds no reference to it, the generated module is a static constant the
> preceding step has already written, and `route.ts` is the only importer of `@/generated/revision`
> anywhere in the tree. The variable was withdrawn from the `Build` step, together with the test
> case that had begun asserting its presence.
> ⚠️ **Recorded rather than deleted, because a silently-vanished line invites someone to add it back
> "for safety".** The reason it is not there is that it is unread, and a second copy of a value
> nothing consumes is the hand-maintained half that rots — DEF-240's lesson. If a build-time
> consumer ever appears, that is the moment to add it, with a comment saying what reads it.

### Slice B — the lag guard

**B1. Where the checker lives, and it is not `scripts/`.** `docs/ops/revision-lag-guard.mjs`,
delivered by the `scp -r docs/ops` that `provision.sh`'s own header already prescribes, installed by
`provision.sh` to `/usr/local/lib/shareat/revision-lag-guard.mjs`.

⭐ **Two independent reasons, and the first is a correction to lane C's own 2026-09-13 analysis**
(§Why ranks the substrate but never says where the script lives):
1. ⛔ **A checker shipped inside the deploy artifact can only be updated by the pipeline it exists
   to watch.** Detection still works — stale logic is still correct logic — but *installing* it, or
   *fixing* it, would depend on the thing being broken. `docs/ops/` breaks that loop.
2. **`docs/` is not in the deploy artifact at all** (`deploy.yml:91`; DEF-194 is the whole row about
   what that fact costs people), so the artifact was never a delivery route for it.

⭐ **And `docs/ops/**` is already classified as code, not prose, by `ci.yml:92`** — a change to the
guard correctly runs the full suite. That classification was written for the units; it now earns its
keep a second time.

⛔ **Node built-ins only** — global `fetch`, no npm install. `/usr/local/lib/shareat/` has no
`node_modules` and must not grow one.

**B2. What it reads.**

| Side | Call | Credential |
|---|---|---|
| Production | `GET http://127.0.0.1:9008/api/health` | none — loopback, the same route `deploy.yml:156` already curls |
| `origin/main` tip | `GET /repos/{owner}/{repo}/commits/main` | token |
| Is the deployed sha on `main`? | `GET /repos/{owner}/{repo}/compare/{deployed}...{tip}` | token |
| `CI` workflow state | `GET /repos/{owner}/{repo}/actions/workflows/{id}` | token |
| Runs for the tip | `GET /repos/{owner}/{repo}/actions/runs?head_sha={tip}` | token |

**The credential.** A GitHub **fine-grained PAT**, scoped to `ianlalusin/shareat-system` only,
permissions **Metadata: Read, Contents: Read, Actions: Read** — nothing that can write. Placed at
`/srv/shareat-shared/secrets/github-guard.token`, mode `600`, owner `shareat:shareat`, in the
directory `provision.sh` already creates at `chmod 700`.
⛔ **Ian creates and places it. No agent sees it** — `IAN-SETUP-CHECKLIST.md` §4b, the same rule
that keeps agents out of `provision.sh`.
⚠️ **Token expiry is itself a fail-silent hazard** — an expired token is a `401`, and a `401` read
as "cannot determine, never mind" is this whole defect family again. Contract B4 forbids that.
Choose the longest expiry GitHub offers and record the date in `docs/ops/README.md`.

**B3. The assertion, in numbers.**

> **FINDING when:** production's sha ≠ `origin/main`'s tip sha, **and** the tip commit's committer
> date is more than **30 minutes** ago.

**Threshold: 30 minutes.** Justified against measurement, not taste:

| | |
|---|---|
| Measured normal end-to-end | **≈6 minutes.** DEF-336's own closing evidence: CI run `34766105131` 171s, then Deploy on `workflow_run` 199s. The other cited Deploy, `34727881980`, ran 2m41s |
| 30 min is | **5×** that, so ordinary queueing, a slow runner and a real migration all fit inside it |
| Shortest incident in the table | **DEF-336, 9 hours** — 18× the threshold |
| Longest | **DEF-327, 20 hours** — 40× the threshold |

**Cadence: every 30 minutes** (`OnCalendar=*:00,30`). Worst-case time to detection is therefore
**60 minutes** — against 9h and 20h, between 9× and 20× better, and the API cost is ~200 requests a
day against a 5,000/hour limit.

**B4. The four outcomes. There is no fifth, and none of them is a silent zero.**

| First line | Exit | When |
|---|---|---|
| `OK` | 0 | shas match, **or** the tip is younger than 30 minutes |
| `LAG-UNEXPLAINED` | **1** | behind, tip ≥ 30 min old, and not positively explained below |
| `LAG-EXPLAINED` | **1** | behind, tip ≥ 30 min old, **and** the tip commit has a `CI` run whose conclusion is positively `failure` or `cancelled` |
| `UNKNOWN` | **1** | either side could not be read — GitHub unreachable, `401`/`403`, loopback refused, malformed JSON |

⛔ **`LAG-EXPLAINED` requires a POSITIVE conclusion. The absence of a CI run is never an
explanation** — the absence of a run *is* DEF-336, and classifying it as "explained" would rebuild
the exact blindness this guard is for. DEF-245 is the standing statement of the general form: both
of its failed runs *"produced an ABSENCE OF EVIDENCE, which is the more dangerous outcome"*.

⛔ **`UNKNOWN` exits 1.** Fail-silent is the shared failure mode of every defect in §Why's table;
a guard that cannot see is not a guard that is happy.

⚠️ **`LAG-EXPLAINED` exits 1 too, and that is deliberate.** The severity attaches to the fact —
production is behind — not to the cause. A red `main` that nobody has fixed for hours is not a
benign state; it is the state DEF-327 sat in for twenty hours.
⭐ **The obvious objection, answered:** the census in `docs/discovery/32-production-caller-census.md`
§6 rejected a rule that *"would fire 111 times, be ~90% wrong, and be suppressed within a day"*.
That reasoning does not transfer, because **this guard's expected steady state is zero fires** — it
fires only when production really is behind, which is not the normal condition of a working
pipeline, unlike a code-shape lint whose population is the whole repo.
⚠️ **The mechanical trigger that reopens suppression** (not "revisit later"): if the guard produces
`LAG-EXPLAINED` on **three consecutive days** for a cause already known and accepted, that is the
observable that says a suppression window is now worth designing.

**B5. Two more cases that must be named outcomes, not gaps.**

- **Production reports `sha: "unknown"`** → `LAG-UNEXPLAINED`, first line saying so. A production
  artifact carrying the placeholder means Contract A3's `--require` was bypassed. The placeholder
  polices itself.
- **The deployed sha is not an ancestor of `main`** (a `workflow_dispatch` deploy of a branch, a
  force-push that orphaned it) → `LAG-UNEXPLAINED`, first line saying so. This is not theoretical:
  `workflow_dispatch` is exactly how `d2e32a1` reached production on 2026-09-13 while CI was
  disabled, and `deploy.yml:44`'s step is still named *"Checkout the exact commit CI verified"*
  while doing it.

**B6. The detail lines — the workflow-state check belongs here and nowhere else.** Every run, both
outcomes, logs all six:

```
workflow CI state=<active|disabled_manually|disabled_inactivity>
tip        <sha> <iso8601>
tip CI     <none|queued|in_progress|success|failure|cancelled> [run <id>]
Deploy     <conclusion> <iso8601> [run <id>]
production sha=<sha> builtAt=<iso8601> age=<duration>
behind by  <n> commits
```

⛔ **`workflow CI state` is a detail line, never the assertion.** Throughout DEF-336, `gh` reported
`Deploy: active` while `deploy.yml:22-26` gated it on a disabled `CI` — **a state check would have
returned green on the worst possible day.** It is DEF-332's `list-timers` trap on another provider:
useful for naming a cause, worthless as the question.

---

## Invariants

**A1.** The `revision` field is reported on **every** response, including both 503s, and its value
never depends on `env()`. The route calls `env()` inside a `try` and returns 503 when it throws
(`route.ts:40-55`); a baked-in constant survives that, and *which build is this* is most wanted
precisely when the app is degraded. — `apps/erp/src/app/api/health/route.ts:32-79`

**A2.** ⛔ The committed `apps/erp/src/generated/revision.ts` **is and stays the placeholder**.
Asserted by a unit test, not by discipline. A real sha committed by accident is a value that reads as
current forever — DEF-311's shape, and DEF-240's lesson that the hand-maintained half of any pair is
the half that rots.

**A3.** Nothing else in the response changes. `status`, `configuration`, `database`, `latencyMs` and
`timestamp` keep their current meanings and values; `deploy.yml:156`'s `curl -fsS` keeps passing on
exactly the same condition.

**A4.** ⭐ **The disclosure, stated as the accepted cost it is.** `/api/health` is unauthenticated
and in production deliberately withholds error detail (`route.ts:14-17`, added so the endpoint
cannot *"describe which variables are unset or echo connection-string fragments"*). The revision
field **does not** use that redaction, by Ian's decision of 2026-09-14.
What a stranger gains: **the age of the running build**, and therefore whether a publicly-disclosed
dependency vulnerability is plausibly still present. What they do not gain: the repository is
private, so a sha is not a lookup key for anyone outside it, and nothing about configuration,
routing, or data is revealed.
⛔ **Do not later "fix" this by redacting it in production** — that would silently break slice B,
which reads the field over loopback and cannot tell redaction from a stale build.

**B1.** ⛔ The guard runs **outside** `/srv/shareat` and imports nothing from it. `WorkingDirectory`
is `/usr/local/lib/shareat`. A guard whose own liveness depends on the deploy landing is circular —
the same circularity that eliminated `Deploy`'s first step as a substrate in §Why.

**B2.** The guard reads production over **loopback only**. It never reaches the public hostname,
so it cannot be fooled by a proxy, a cache, or DNS — and needs no second credential.

**B3.** ⛔ The exit code is load-bearing and is the only thing the host's mailer sees. Stated
explicitly because `docs/ops/shareat-orphan-file-sweep.service` already says so in its own header
and DEF-330 is the register's proof that a success *string* is not a success: there, the recipe
printed `Migrations applied in 231ms` for a no-op, **indistinguishable from the real thing**.
⛔ Therefore the `OK` line carries **both shas it compared**, never the bare word.

**B4.** ⛔ **No layer may be the only one for a given risk** — bible **§15.11**. The droplet timer is
primary; a wrap-up ritual line is the backstop; the residual is written down rather than hidden
(§Why, and Done-when B9).

**B5.** ⛔ **`tests/unit/scheduler-job-hosting.test.ts` will go red the moment the new unit pair
lands, and that is correct.** Its invariants 3 and 4 (lines 152-161) fail any `.service` or `.timer`
in `docs/ops/` that is neither a `SCHEDULER_JOBS` script nor a *named* exception —
`NAMED_NON_JOB_SERVICE = ['erp']`, `NAMED_SECONDARY_TIMER_ONLY = ['month-end-retry']`.
The guard is **deliberately not** a `SCHEDULER_JOBS` entry (Invariant B1 — a scheduler job runs
`npm run <job>` inside `/srv/shareat`), so it needs a named exception in **both** lists, with the
comment saying why. ⛔ **Adding it to `SCHEDULER_JOBS` to make the test pass is the wrong fix** and
would put the guard back inside the artifact it is watching.

---

## Tests

### Slice A — `tests/unit/deployed-revision.test.ts`

1. **The committed module is the placeholder.** `sha === 'unknown'` and `builtAt === null`.
   *Teeth:* edit it to a real-looking 40-hex sha, watch this fail, restore by edit and prove
   `git diff` clean.
2. **The generator's happy path.** Given a valid 40-hex `DEPLOY_REVISION_SHA`, the emitted file
   parses, `sha` matches the input exactly, `builtAt` is a valid ISO-8601 instant.
3. **The generator's unset path.** Unset, empty, `"HEAD"`, a 39-character string, an uppercase sha,
   and a non-hex 40-character string each produce the **placeholder** and exit 0 — never a
   fallback, never a partial value.
4. **`--require` inverts exactly those cases.** Each of the six inputs above exits **1** and writes
   nothing when `--require` is passed. ⛔ *This is the test that keeps DEF-311 from recurring.*
5. **Shape.** The health route's revision field is one of the two legal shapes and nothing else.

⚠️ **Prove the suite has teeth before reporting green** — RULES §2, *"confirm they fail for the
right reason first"*. A test that only ever passed proves nothing.

### Slice B

6. **`scheduler-job-hosting` stays green** with the new units and the named exceptions, and
   **goes red** if either exception is removed. Both directions reported with real output — the
   discipline that file's own header already demands of its `EXEMPT` map (DEF-296).
7. **Forced-failure proof, on the droplet, against production.** Run the guard with an override
   pinning the "production" sha to a deliberately stale commit. Observe **exit 1** and the
   `LAG-UNEXPLAINED` first line. Restore, re-run, observe **exit 0** and `OK` carrying both shas.
   ⛔ Report the real output of both runs, not a summary of it.
8. **`UNKNOWN` proof.** Run once with the token file absent and once with `127.0.0.1:9008`
   unreachable. Both must exit **1** with `UNKNOWN` naming which side failed.
   ⛔ **Neither may exit 0.** This is the single assertion that separates this guard from every
   defect in §Why's table.
9. ⚠️ **If any forced-failure run fails differently than predicted here, chase it in the same pass.**
   An unpredicted failure mode is evidence about the normal path, not a curiosity to note and move
   past.

---

## Out of scope

- ⛔ **Migration lag.** DEF-330's own proof — `select count(*) from drizzle.__drizzle_migrations`,
  127 before and 130 after against 130 journal entries — is a genuinely valuable second assertion
  and this guard is standing in the right place to make it. **It needs a database credential on the
  droplet, which doubles the credential surface, so it is not in this task.**
  ⚠️ **Mechanical trigger to reopen:** the first `LAG-*` finding whose root cause turns out to be a
  migration that did not apply. That is an observable event, not a calendar reminder.
- ⛔ Renaming `deploy.yml:44`'s *"Checkout the exact commit CI verified"*, which lies under
  `workflow_dispatch` — DEF-336's second finding, and the orchestrator's to schedule.
- ⛔ Re-enabling, disabling, or changing any workflow trigger; any change to `ci.yml`.
- ⛔ Arming anything on the droplet — **Ian's**, and `docs/ops` does not ship (DEF-194).
- ⛔ Anything in T-307's scope. ⭐ **The pairing to keep straight: T-307 asserts CI's configuration
  is correct; T-308 asserts CI ran at all.** A correct config that never executes is DEF-336; a
  running CI with a wrong env block is DEF-328.
- ⛔ `docs/DEFECTS-REGISTER.md`, `PROJECT_BIBLE.md`, `docs/ROADMAP.html` — the orchestrator's.

---

## Done when

### Slice A — shippable on its own

A1. `apps/erp/src/generated/revision.ts` committed as the placeholder, generated by the script and
never hand-edited.
A2. `scripts/write-revision.mjs` and its `package.json` entry in place; `deploy.yml` passes
`DEPLOY_REVISION_SHA` from the **same expression as line 47** to the revision step, **and to no
other step** — corrected 2026-09-14, reasoning at Contract A4.
A2b. ⛔ **The test suite must not write to the tracked `revision.ts`.** The generator takes an
output-path override so the mutating cases write to a temp directory; Test 1 and the shape check
stay pointed at the real committed file, because their whole job is to assert what is on disk.
⚠️ **Found in review, and it is the sharper half of this slice:** without it, an interrupted run —
or two lanes running `npm run test` at once on this shared tree, the second snapshotting the first's
fake sha as its "original" and writing it back as canonical — leaves a well-formed but false sha in
a tracked file. **That is DEF-311's shape, and it is strictly worse than the honest `unknown` it
replaced, because slice B trusts this field.** The guard enforcing Invariant A2 must not be able to
manufacture an A2 violation.
A3. `tests/unit/deployed-revision.test.ts` green, all five cases, **with the teeth checks reported
as real output**.
A4. typecheck clean · `npm run test` green · `npm run build` succeeds with the dev server stopped ·
integration suite green.
A5. **Smoketested on 9008** — `curl localhost:9008/api/health` shows `revision.sha === "unknown"`
locally, which is the correct local answer and proves the field is wired.
A6. ⭐ **Measured on production after the first deploy that carries it:** `/api/health` returns a
40-hex sha, and that sha **equals the commit that deploy ran from**, compared by hand against the
Deploy run's own log. ⛔ Not "the field appeared" — the two values compared.
A7. A `FOR IAN` block in plain language (RULES §2).

✅⭐ **SLICE A IS DONE — 2026-09-14. A5 AND A6 BOTH MEASURED, NOT ASSERTED.**

**A5**, on 9008 after a clean build with the dev server stopped:
`{"status":"ok","configuration":"valid","database":"reachable","revision":{"sha":"unknown","builtAt":null},"latencyMs":260}` — `unknown`/`null` is the correct local answer and a legal shape. ⭐ **That was the first time anything in this slice had been seen over HTTP rather than read as source text or an exit code** — by three sessions across two review passes.

**A6**, against production after CI `34802978388` (success) and Deploy `34803535420` (success, automatic on `workflow_run`):
```
production /api/health revision.sha : 60935e97938a9fe232a968b346c466ac9833a0fb
commit the deploy actually ran from : 60935e97938a9fe232a968b346c466ac9833a0fb
builtAt                             : 2026-09-14T03:43:23.901Z
```
⛔ **The two values COMPARED, all forty characters, not "the field appeared"** — which is what A6 asked for and the distinction it was written to force. `database` stayed `reachable` at 114ms, so T-310's TLS change is still healthy under the same deploy.

⭐ **And the fail-closed step did not block the pipeline.** This deploy was the first to run `npm run write-revision -- --require`, which exits 1 and writes nothing if it cannot determine the sha. It resolved cleanly from `deploy.yml:47`'s existing expression, which is the reason that expression was reused rather than a second source introduced.

⚠️ **Slice B remains unbuilt and blocked on Done-when B4** — the fine-grained PAT, which is Ian's and cannot be minted from here. ⭐ **But the enabling half now stands on its own:** *"which commit is production on?"* — asked repeatedly during DEF-326 and DEF-327, answerable until today only by SSH plus inference from a directory timestamp — is now one unauthenticated GET.

### Slice B

B1. `docs/ops/revision-lag-guard.mjs` — Node built-ins only, `node --check` clean.
B2. Unit pair present; `provision.sh` installs the script; `docs/ops/README.md` carries the arming
line **and** the verification line.
B3. `tests/unit/scheduler-job-hosting.test.ts` extended with both named exceptions, green, and
**reported red** with either removed.
B4. Ian has created the fine-grained PAT and placed it at
`/srv/shareat-shared/secrets/github-guard.token` (`600`, `shareat:shareat`), expiry recorded in
`docs/ops/README.md`. ⛔ **This line is Ian's.** A lane that cannot complete it reports **BLOCKED**;
it does not report done.
B5. ⭐ **PROOF IT IS ARMED — measured, not installed.**
  `systemctl is-enabled shareat-revision-lag-guard.timer` → **`enabled`**
  `systemctl is-active shareat-revision-lag-guard.timer` → **`active`**
  ⛔ **By `is-enabled`, NEVER by `list-timers`** — DEF-332: *"a timer that was never enabled is not
  loaded, so it is absent from `systemctl list-timers` even with `--all`"*. The instrument an
  operator reaches for is blind to exactly this failure.
B6. ⭐ **PROOF IT CAN RUN.** After one real firing:
  `systemctl show shareat-revision-lag-guard.service -p Result -p ExecMainStatus` →
  **`Result=success`, `ExecMainStatus=0`**, and the log file holds a dated `OK` line **carrying both
  shas**. ⛔ DEF-326 is the row where everything was armed, scheduled and correct and the job still
  could not run, because the artifact lacked the entry point — *"nothing but running it once could
  have found this."*
B7. Test 7's forced-failure output reported verbatim, both directions.
B8. Test 8's two `UNKNOWN` runs reported verbatim, both exit 1.
B9. ⭐ **THE RESIDUAL, WRITTEN DOWN — and this spec states plainly that it cannot close it.**
  If the timer is never enabled **and** nobody runs the wrap-up, both layers are silent. That is
  DEF-332's own failure mode, and with DEF-194 / DEF-240 / DEF-326 / DEF-336 it is the **fifth**
  time this family has been filed. ⛔ **The repository cannot test this** — DEF-332 says it outright:
  *"what is armed on a host is not a fact the repository contains."* So the residual lands in two
  places that are **not** this task's to write, and the lane must report them rather than assume
  them: **(a)** one line in DEF-336's register row, **(b)** one line in the wrap-up ritual.
  ⚠️ **Shipping this guard unarmed would be the sixth member of the family it was built to catch.**
  Done-when B5 exists so that cannot happen quietly.

---

# Why

> ⭐ **Everything below is lane C's analysis of 2026-09-13, preserved.** The comparison table, the
> substrate ranking, the counterexample and the residual are the reasoning the spec rests on. One
> heading is corrected where the spec found it incomplete; the correction is marked and the original
> claim left standing.

## The assertion — and it is deliberately NOT "CI is enabled"

⛔ **Assert DEPLOYED-REVISION LAG: production is running a commit older than `origin/main`, and
nobody said so.** That is the observable every silent failure in this project has actually shared:

| Defect | What happened | Caught by a lag check? |
|---|---|---|
| DEF-326 | The deployed build lacked the npm script its unit invoked | ✅ |
| DEF-327 | Migrate aborted **before** the symlink swap; host served the old release, 20 h | ✅ |
| DEF-330 | The manual recipe applies nothing and prints success | ✅ |
| DEF-336 | `CI` disabled by hand; every push inert, 9 h | ✅ |

⭐ **A "every commit has a CI run" assertion catches one of those four.** A lag assertion catches
all four **plus causes nobody has enumerated** — and in this project the enumeration is the thing
that keeps failing.

⚠️ **One row narrowed by the spec pass, and it is narrower than the tick suggests.** DEF-330's ✅ is
real but indirect: the guard would have been red throughout, because the stale symlink DEF-330
pointed at was itself the lag. It would **not** have contradicted the recipe's own
`Migrations applied in 231ms`. The guard catches the state DEF-330 left behind, not DEF-330's lie —
which is why migration lag is named in **Out of scope** with a trigger rather than quietly assumed.

## ⛔ Why a workflow-state check is the wrong assertion — the counterexample is this defect

Throughout DEF-336, `gh` reported **`Deploy: active`**. But `deploy.yml:22-26` gates `Deploy` on
`workflow_run` of `CI`, and `CI` was disabled — so **`Deploy` was structurally dead while reporting
active.** A state check would have returned green on the worst possible day.

⚠️ **That is DEF-332's `systemctl list-timers` trap on a different provider.** Keep the state check
as a **detail line inside** the guard, so a symptom is reported with its cause; never as the
assertion itself.

## Placement — no substrate is invulnerable, and that is not the target

Bible **§15.11** already rules that *no layer may be the only one for a given risk* (DEF-210 is what
one layer looks like). So the job is not to find an invulnerable home; it is to pick a substrate
that fails **independently** and then **name the residual**.

| Candidate | Verdict |
|---|---|
| `Deploy`'s first step | ⛔ **Eliminated, not ranked.** `workflow_run`-gated on `CI`, so it is silent in exactly the scenario it detects. **Circular.** |
| A scheduled GitHub workflow | ⚠️ The guarded thing wearing a hat — same provider, same disablement, and GitHub has a named automatic sibling state, `disabled_inactivity`. There are zero `schedule:` triggers in the repo today |
| **A droplet timer** | ⭐ **Recommended primary.** Different machine, scheduler, provider and credential — the only genuinely independent substrate. `provision.sh` already installs units and eight jobs already report to `scheduler_runs` |
| A wrap-up ritual line | ⭐ **Recommended backstop**, not primary — it depends on a person |

⛔ **The residual, stated rather than hidden:** if the timer is never enabled **and** nobody runs the
wrap-up, both layers are silent. **That is DEF-332's own failure mode.** It is accepted as strictly
better than one layer that has already failed — but it must be written into DEF-336's row, not
discovered later.

⚠️ Lane C explicitly **did not** count "`scheduler_runs` staleness would catch a dead timer" as
mitigation: nothing currently reads that table for staleness.

⭐ **CORRECTION, 2026-09-14 — this table ranks the SCHEDULER and never says where the SCRIPT lives,
and that is a gap in the original analysis, not a detail of the build.** A checker placed in
`scripts/` ships inside the deploy artifact and can then only be installed or fixed by the pipeline
it watches. Contract B1 puts it in `docs/ops/` instead, which `provision.sh`'s own `scp -r` header
already delivers and which `ci.yml:92` already treats as code. The ranking above stands; the row it
was missing is now Contract B1.

## The enabling step — worth doing even if the guard is never built

**Production does not publish which commit it is running.** `deploy.yml:47` already resolves the
sha and never writes it anywhere; `apps/erp/src/app/api/health/route.ts` reports status,
configuration and database but **no version**. So *"which commit is production on?"* is today
answerable only by SSH plus inference from a directory timestamp — **a question asked repeatedly
during DEF-326 and DEF-327.**

⚠️ **Ian's decision inside this, flagged and not taken:** the cheapest place to publish the sha is
`/api/health`, which is **unauthenticated** — low sensitivity for a private product, but a real
disclosure. The private alternative is a file on the box, read over the existing deploy SSH path.
**Put this to him in plain language before building either.**

⭐ **ANSWERED 2026-09-14: `/api/health`.** Ian was told it is unauthenticated and what that
discloses, and accepted it against the alternative's extra credential and wiring. Recorded as an
accepted, named cost in **Invariant A4**, which states precisely what is and is not revealed. ⛔ This
paragraph is kept rather than deleted so a later reader can see the question was asked and by whom
it was settled.

### ⭐ Lane C's recommendation on the FORM of the published sha, since it was invited

**Publish the full 40-character sha, paired with `builtAt`. Do not abbreviate.**

1. ⛔ **Abbreviation buys no privacy.** A 7-character prefix is exactly as resolvable to anyone with
   repository access and exactly as useless to anyone without it. It would be ceremony.
2. ⛔ **And it costs the guard precision.** A short sha forces prefix comparison, which is the class
   of string handling that fails quietly — and this project has DEF-345 sitting in the register as
   proof that a string-mangling bug can destroy data and exit 0 while doing it.
3. ⭐ **`builtAt` is the half that earns its place, for a reason specific to this project.** DEF-330
   established that *a success output identical whether the work happened or not* is worse than a
   broken one. A sha alone answers *which commit*; it cannot answer *as of when*. If the revision
   module ever silently stops regenerating, a stale-but-valid sha looks exactly like a current one —
   whereas a `builtAt` two days old is legible to a human at a glance, with no guard running at all.

## ⛔ Why this is NOT bundled into T-307

They share a sentence — *nothing checks that CI is what we think it is* — and no substrate.

- **T-307** is static, pure-data, fast-unit-suite, no network, **shippable today**.
- **T-308** is runtime, out-of-band, needs a credential and a placement ruling from Ian.

**Bundling makes the decided cheap thing wait on the undecided one.** The precedent is in the
register: DEF-334's *"NOT to be bundled into T-299 — an isolation-strategy change, not a budget
tweak."*

⭐ **The same argument applied once more, inside this task, is why Slice A and Slice B are
separated.** Slice A is decided, credential-free and shippable today; Slice B waits on a token Ian
must mint. Bundling them would make the decided half wait on the undecided one a second time.

⭐ **The pairing to remember: T-307 asserts CI's configuration is correct; T-308 asserts CI ran at
all.** A correct config that never executes is DEF-336; a running CI with a wrong env block is
DEF-328.

## Why it is worth its cost, in one line

**DEF-245's standing disposition makes `ci.yml` the only real integration gate** — quoted three
times in the 2026-09-13 handoff. **DEF-336 proved that sole gate can vanish leaving no trace.**
A sole gate that can silently vanish is not a gate, it is a habit.

---

See `docs/DEFECTS-REGISTER.md` DEF-336, DEF-332, DEF-330, DEF-327, DEF-326, DEF-311, DEF-296,
DEF-245, DEF-240, DEF-194; `PROJECT_BIBLE.md` §3.3, §9, §15.11; `.github/workflows/deploy.yml`
(lines 22-26, 44, 47, 91, 143-145, 151-164); `.github/workflows/ci.yml` (lines 92, 146-147);
`apps/erp/src/app/api/health/route.ts`; `docs/ops/provision.sh`; `docs/ops/README.md`;
`tests/unit/scheduler-job-hosting.test.ts` (lines 60-95, 152-161);
`docs/discovery/32-production-caller-census.md` §6; `docs/tasks/307-ci-env-contract-assertion.md`.

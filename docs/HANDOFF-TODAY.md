# Handoff — 2026-09-14 (wrap-up)

> ✅⭐ **FOUR DEFECTS FIXED AND SHIPPED, ONE DEFECT RETRACTED AS FALSE, AND PRODUCTION NOW REPORTS
> WHICH COMMIT IT IS RUNNING.** Eleven commits, all pushed but one. CI and Deploy both ran
> automatically, twice, with nobody dispatching anything.
>
> ⭐⭐ **THE DAY'S BIGGEST FINDING IS THAT A DEFECT WE HAD FILED NEVER HAPPENED.** DEF-345 said a
> shell had eaten a file list out of DEF-258's row. It had not. The list was there the whole time,
> at `HEAD` and in the commit blamed. **A lane sent to re-derive it re-derived it to EXACT
> agreement and reported that the agreement meant the premise was false** — rather than handing
> back four filenames that matched. ⛔ **A measurement that agrees perfectly with the record is
> evidence the record is INTACT, not evidence your repair succeeded.**
>
> Written for a **COLD start**. Read `docs/RULES.md` first, then this. `PROJECT_BIBLE.md` wins any
> disagreement.

## Where things stand

**Production is healthy, current, and now self-identifying.** `/api/health` returns:

```
{"status":"ok","configuration":"valid","database":"reachable",
 "revision":{"sha":"60935e97938a9fe232a968b346c466ac9833a0fb",
             "builtAt":"2026-09-14T03:43:23.901Z"},"latencyMs":84}
```

⭐ **That `revision` field is new today (T-308 slice A), and it was verified by COMPARING the two
values — all forty characters against the commit the deploy actually ran from — not by seeing the
field appear.** *"Which commit is production on?"*, asked repeatedly during DEF-326 and DEF-327 and
answerable until today only by SSH plus inference from a directory timestamp, is now one GET.

Migration **`0147`** is still the last applied; **no migration was written today** and `0148` is
free. All four lane databases sit at 131 entries.

## Gates — real output, run by the orchestrator, not taken on report

| Gate | Result |
|---|---|
| `npm run typecheck` | **exit 0** |
| `npm run test` (unit) | **exit 0** — 114 files, 1626 passed, 1 skipped |
| `npm run build` | **exit 0**, dev server stopped first |
| **Smoketest on 9008** | ✅ `/api/health` served the new `revision` field over real HTTP; `/sign-in` HTTP 200 |
| Integration — **scoped** | `packages/db` 11 files / 239 passed · `apps/erp` 5 files / 39 passed · `position-defaults` 19/19 |
| ⭐ Integration — **FULL SUITE** | ✅ **RAN, IN CI, AND PASSED** — run `34801123338`, success in **11m14s**. ⭐ **The first time it has ever run against the database-client change**; it OOMs locally (DEF-245) |
| **CI** | ✅ `active`. Two runs, both **automatic on push**, both success |
| **Deploy** | ✅ `active`. Two runs, both **automatic on `workflow_run`**, both success (3m17s, 3m~) |
| Backtick-parity sweep | ✅ **zero odd rows across all four documents of record, with NO exemption** |

⚠️ **What is still NOT proven:** the full integration suite has still never run *locally* (DEF-245
stands). Everything above that says "full suite" means **in CI**.

## What shipped

| | |
|---|---|
| **DEF-338** | A test comment ordered the reader to delete a timeout the register forbids deleting, and its precondition had come true eleven lines below it. Now records the **ruling** instead of issuing an instruction |
| **DEF-344 / T-310** | The DB client derived TLS from `NODE_ENV` and **overrode the connection string**. Deleted; the URL decides. ✅ **Verified encrypted in production** |
| **DEF-329 / T-307** | `ci.yml`'s own `env:` block now runs through the app's real startup contract, with two controls proven red-then-green |
| **DEF-330** | The manual-migration recipe migrated **the wrong release** (through the symlink the deploy swaps last) and printed success. Now resolves the release explicitly and proves it with a before/after count |
| **T-308 slice A** | Production publishes its own commit. Baked into the build, not read at runtime |
| **DEF-345** | ⛔ **RETRACTED — the claim was false when filed.** Nothing was ever lost |
| **DEF-346** | Filed: `deploy.yml` names **eleven** required secrets; the workflow reads **seven** |
| **DEF-315** | Corrected: its claim that nothing tests config relationships stopped being true when T-292 landed |
| **DEF-325** | Measured under deliberate concurrency. Still **UNEXPLAINED**; the 120s override **untouched** |
| **DEF-347** | Filed **and fixed**: `HANDOFF.md` — the file a new machine reads FIRST — said *"T-122 in flight"* and *"67 logged decisions"* while the project was at T-311 and 206. Fixed by **deleting** the duplicated facts, not refreshing them |

## ⭐⭐ The rule that came out of today — bible §13 row 204

**A remedy is as perishable as a diagnosis.** Any comment or register row that names a specific
token — an identifier, a line number, a secret, a file — and asserts a present-tense fact about it
**will go stale without anybody editing it**. Six instances in one morning:

1. **DEF-338** — *"whoever fixes that root cause should come back and delete this timeout override"*,
   where the root cause had been fixed **eleven lines below**.
2-4. **DEF-338's and DEF-334's own rows** cited `:541-546` for a block at 542-547, `:549-556` for
   one ending at 555, and `:538` for a line that had stopped saying it.
5. ⭐ **The repair created a fifth** — the replacement comment is six lines longer, so the override
   it protects moved from `:627` to `:633`. **The fix for the stale-citation defect produced a stale
   citation in the row describing it, within the hour.**
6. **DEF-346** — `deploy.yml`'s secrets list, which has **no conditional grammar at all**.
7. ⭐ **A seventh, found by this very wrap-up: `HANDOFF.md`** — the file a session on a new machine is
   told to read FIRST — announced *"T-122 in flight"* and *"67 logged decisions"* while the project
   was at **T-311 and 206**. Frozen 2026-08-25, wrong for about three weeks. ⛔ **Its audience is the
   one reader who could not possibly have noticed** (DEF-347).

⛔ **The rules:** prefer a **NAME** to a **POSITION** (an identifier survives an edit above it; a
line number does not) · phrase it as a **ruling**, because *"whoever does X should then do Y"* is a
booby trap with a timer · **the detection query is TOKEN-based, not grammar-based** — a sweep for
*"whoever fixes" / "once X is fixed" / `TODO: remove`* found nothing but DEF-338 and **structurally
cannot** match DEF-346 · an **immutable migration is exempt by construction**.

⭐⭐ **AND THE COROLLARY DEF-347 ADDS, WHICH IS THE ONE THAT CHANGES WHAT YOU DO AT EVERY WRAP-UP:
A DOCUMENT THAT IS NOT MAINTAINED MUST NOT CONTAIN A FACT THAT MOVES.** It may hold architecture,
rationale and traps — things true for as long as the design holds — and it must **POINT** at the
maintained documents for everything else. ⛔ **The fix for a stale status is never to re-type
today's numbers into it**; that only resets the clock on the same defect. **Delete the duplicate.**

⭐ **Row 206 and its same-day sharpening are worth reading together.** Row 206 said: prefer a guard
to `!` on a regex match, and where `!` is used name what makes it safe. **Its first instance in the
wild wrote the comment — and the reason it gave was false.** The code was correct for a *different*
reason. So the row now says in terms that **it is not satisfied by a comment existing**; the comment
must name the ACTUAL reason and a reviewer must check it. **A comment giving a plausible wrong
reason is worse than no comment: no comment invites checking, a wrong one forecloses it.**

## Pick up here

1. **T-308 slice B — the lag guard.** Spec is written and approved (`docs/tasks/308-*.md`). ⛔ **Blocked
   on Done-when B4, which is Ian's**: a fine-grained PAT at `/srv/shareat-shared/secrets/github-guard.token`.
   ⭐ Slice A is the hard prerequisite and it is **done and verified**, so B is now unblocked apart
   from the token. ⛔ Its done-when demands **proof it is ARMED** — `is-enabled` AND `is-active`,
   never `list-timers` (DEF-332) — because shipping it unarmed would be the sixth member of the
   family it was built to catch.
2. **T-311 / DEF-346** — correct `deploy.yml`'s secrets list **and** assert it. ⛔ **Do not do the
   comment without the test**; the register holds four proofs that a documented expectation with no
   executable check is just a comment. Design is costed in DEF-346 at well under an hour. **It was
   blocked on `deploy.yml` being held by T-308 slice A — that file is now free.**
3. **T-309 — ERP v2's own Firebase project.** Its hard gate (*"do not start while there is only one
   way to sign in"*) has been satisfied since 2026-09-13.
4. **T-302** — one PIN per person across every branch. Specced and approved, not built.

## Do not decide these alone — they are Ian's

- ⛔ **The T-308 slice B token.** Nobody here can mint it. Item 1 above is blocked on it and on
  nothing else.
- ⚠️ **A fourth `persons` reader** could appear and compile clean; the `kind` filter is fail-open.
  A build-enforced guard is the fix. *Carried from 2026-09-13, still open, still the only genuinely-Ian
  engineering item.*
- ⭐ **Answered 2026-09-14, recorded so they are not re-asked:** *where to publish the deployed
  commit* (the public `/api/health`, disclosure accepted and named — §13 row 205) · *whether to push
  the database fix on its own* (yes, so a failure would have one suspect) · *whether to push the
  pipeline change* (yes).

## ⛔ Read this before you edit any document

**The backtick trap is real, but DEF-345 is proof that its SIGNATURE is ambiguous.** An odd backtick
count in a table row has at least two causes, and this repository guessed wrong once:

1. content genuinely consumed by a shell before it was written;
2. **a legitimately backticked regex, path or glob written inline** — which is what DEF-258 had.

⭐ **The sweep is now a committed script, not an inline one-liner** — because an inline sweep for the
backtick trap is itself vulnerable to the backtick trap:

```
node scripts/backtick-parity.mjs            # the four documents of record
node scripts/backtick-parity.mjs <files...> # anything else
```

It reports an **anomaly** and names both causes; it no longer announces a diagnosis. ⛔ **Read the raw
text of any flagged row before concluding.** If the named identifiers are still there, nothing was
lost — re-spell the literal backtick (`\x60` in a regex, a doubled-backtick span otherwise) rather
than exempting the row. **Current state: zero odd rows, no exemptions.**

⚠️ **The write method still stands:** Write tool → plain file → a script that READS the file. Never
build a document edit inside a shell string. `node -e "…"` is an `-e` string.

## Traps that have actually bitten — live in this area right now

- ⛔ **A test-name filter through the lane runner ran the WRONG TESTS and EXITED 0.** `it.mjs` used
  `shell: true`, which concatenates argv unescaped (Node warns, DEP0190), so on Windows
  `-t "some name"` was re-split; vitest read the trailing words as **filename filters**, ran four
  unrelated files for 254s, and returned green. ✅ **Fixed 2026-09-14** — it spawns vitest's own
  entrypoint with `shell: false`. ⭐ **A green run of the wrong tests is indistinguishable from a real
  pass in every log anybody checks.**
- ⛔ **`npm run build` dirties `apps/erp/next-env.d.ts`**; starting `dev` flips it back. Generated —
  **restore it, never commit it.**
- ⛔ **The full local integration suite OOMs.** Scoped runs are healthy. **CI is where the full suite
  runs** (DEF-245).
- ⛔ **`systemctl list-timers` cannot show a timer that was never enabled.** Use `is-enabled`. Its
  GitHub twin: **`Deploy: active` means nothing if `CI` is disabled** — check `gh workflow list --all`.
- ⛔ **`/srv/shareat` is the symlink the deploy swaps LAST** — when a deploy is broken it points at the
  *stale* release. ✅ The recovery recipe no longer uses it (DEF-330).
- ⛔ **`DROP DATABASE` waits are INVISIBLE to `pg_locks`** — they are `IPC` waits (`CheckpointStart`,
  `ProcSignalBarrier`). A `pg_locks`-only investigation reports "no contention" and is wrong about
  the mechanism. Found 2026-09-14 while measuring DEF-325.
- ⚠️ **Server runtimes are UTC.** `formatBusinessDateTime` is the only sanctioned formatter.
- ⛔ **SSH to the droplet is blocked for the orchestrator** by the permission classifier. Ian runs
  host-side commands — suggest he type `! <command>`.

## ⭐ The method, and it produced almost everything above

**Lanes were sent QUESTIONS, not just change orders. Seven corrections came back at the
orchestrator — two of them to numbers it had stated as measured** — and **two lanes corrected their
own committed work.**

| Correction | From |
|---|---|
| The tree description was one file stale | lane C |
| The edit's line range was off by one (and so was the register) | lane B |
| *"11 `postgres(` call sites"* — actually ~140; the grep's filter had been dropped when quoting it | lane A |
| DEF-345's entire premise is false | lane C |
| DEF-315's claim about `env.test.ts` stopped being true when T-292 landed | lane B |
| DEF-344's *"one-line change is the whole migration cost"* — there is no cost | lane A |
| The `!` question was asked about the wrong artefact: *"the concerning thing is not the error, it is the remedy"* | lane C |
| **Its own spec said `Build` needs a variable nothing reads** | lane C, on itself |
| **Its own fix used an env var that can be set from a distance** — replaced with an argv flag | lane C, on itself |

⭐ **That last one is the one to remember.** The escape hatch added to stop the test corrupting a
tracked file was specified as an environment variable. An env var is inherited by every child
process; one set in the deploy environment for an unrelated reason would have made the build write
the file elsewhere and compile in the untouched placeholder — **shipping a production artifact
reporting `unknown` with the fail-closed check having PASSED and nothing red anywhere.** *A safety
hatch that can be opened from a distance reintroduces the failure it was added to prevent.*

## Live agent sessions at wrap-up

| Session | Model | Lane DB | State |
|---|---|---|---|
| `system32-85` | Opus 5 | `shareat_test_orch` | orchestrator — this session |
| `webapps-65` | Sonnet 5 | `shareat_test_lanea` | **idle.** T-310, then T-308 slice A through three review rounds |
| `webapps-4e` | Sonnet 5 | `shareat_test_laneb` | **idle.** DEF-338, T-307, DEF-330, and the DEF-325 measurement |
| `webapps-f7` | Opus 5 | `shareat_test_lanef7` | **idle.** Wrote T-308's spec, reviewed slice A twice, killed DEF-345 |

⚠️ **`webapps-36` has been alive since 2026-09-13 and is in no lane.** Treated as **foreign** all
session — no work given, no assumption about its files. **Do not adopt it by name without asking Ian.**

⚠️ **`docs/scratch/` is UNTRACKED and deliberately not committed** — it holds 2026-09-13's lane C
working documents. Their substance is in the register. **Delete freely.** Lane B's DEF-325 harness
(21 trial records, 455 lock snapshots) lives in that lane's own scratchpad, outside the repo — the
first thing to re-run if DEF-325 ever bites again.

## Numbers to allocate from

- Next task **T-312** · next defect **DEF-348** · next migration **`0148`** (`when` > `1798774307084`)

⚠️ **Allocated 2026-09-14, do not re-issue:** **T-310** (done) · **T-311** (reserved, analysis
complete, spec unwritten) · **DEF-346**, **DEF-347**. **Still reserved from 2026-09-13:** **T-307** (done),
**T-308** (slice A done, slice B blocked), **T-309** (unstarted).

## The paste-ready prompt

<!-- Copy everything between the two rows of dashes. -->

-----------------------------------------------------------------------------------------------

You are the orchestrator for shareat-system (C:\Users\ianla\webapps\shareat-system). Run the
global /orchestrator skill. You are starting COLD.

Read in this order: docs/RULES.md, docs/HANDOFF-TODAY.md, PROJECT_BIBLE.md §13 rows 202-206,
docs/DEFECTS-REGISTER.md section E (DEF-325 through DEF-346 are the live ones).

⭐ Rows 204, 205 and 206 are new and all three constrain what you may do:
  204 — a remedy is as perishable as a diagnosis. Any comment or row naming a specific token and
        asserting a present-tense fact about it goes stale with nobody editing it. Prefer a NAME
        to a POSITION; record the RULING, never a conditional instruction.
  205 — production publishes its running commit at /api/health, unauthenticated. Ian's decision,
        the disclosure accepted and named. ⛔ Do NOT "fix" it later by redacting it — that
        silently breaks T-308 slice B.
  206 — prefer a guard to `!` on a regex match; where `!` is used the comment must name the ACTUAL
        reason. ⛔ The rule is NOT satisfied by a comment existing — its first instance wrote one
        that was confidently wrong.

Tree clean, ONE commit unpushed (d2e241e, pure record-keeping — a docs push still restarts
production, DEF-339). Production healthy and REPORTING ITS OWN COMMIT: /api/health carries
revision.sha, verified 2026-09-14 by comparing all forty characters against the deploy.

⛔⛔ FIRST, BEFORE TRUSTING ANY PIPELINE: gh workflow list --all
Both were `active` and both fired automatically twice on 2026-09-14 — but CI sat
`disabled_manually` for nine hours on 2026-09-13 and NOTHING reported it (DEF-336). ⚠️ Do NOT
satisfy yourself with "Deploy: active"; Deploy is workflow_run-gated on CI.

⭐ The full integration suite RAN AND PASSED in CI (run 34801123338, 11m14s) against the current
code. It still OOMs locally (DEF-245). Say "passed in CI", never bare "green".

START WITH T-308 SLICE B if Ian has minted the PAT — the spec is written and approved and slice A
is done. Otherwise T-311/DEF-346: deploy.yml names eleven required secrets and reads seven, and
deploy.yml is now free. ⛔ Do not correct that comment without the test that asserts it.

⛔ EDITING DOCS: a shell heredoc or `-e` string EXECUTES backticks. Use Write tool → plain file →
a script that READS the file. Then run: node scripts/backtick-parity.mjs
⚠️ An odd row is an ANOMALY, not a verdict — DEF-345 was retracted because someone read one as
proof of damage when the cause was a regex carrying a literal backtick. READ THE RAW TEXT.

⛔ THE LANE RUNNER: node ~/.claude/skills/orchestrator/tools/it.mjs <lane_db> <files...>
A name filter through it used to run the WRONG TESTS and EXIT 0 (fixed 2026-09-14). Never run
npm run test:integration — it hits the shared DB.

ASK EACH LANE A QUESTION, NOT JUST FOR A CHANGE. On 2026-09-14 that produced seven corrections to
the orchestrator — two to numbers it had called measured — and two lanes corrected their own
committed work. Not one came from building.

⛔ SSH to the production droplet is BLOCKED for the orchestrator. Ian runs host-side commands;
suggest he type `! <command>` so the output lands in the conversation.

Next task T-312 · next defect DEF-348 · next migration 0148 (when > 1798774307084).
T-309 and T-311 are RESERVED stubs with analysis written and specs unwritten.

-----------------------------------------------------------------------------------------------

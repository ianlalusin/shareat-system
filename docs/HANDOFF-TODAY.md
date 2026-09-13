# Handoff — 2026-09-13 (evening wrap-up)

> ✅⭐ **PIN SIGN-IN WORKS IN PRODUCTION. DEF-333 IS CLOSED END TO END.** The T-304 cutover ran in
> full and **all eight steps passed**, on a real device: SharEat Lipa's tablet signs in with a
> shared store credential, a staff PIN identifies the person, and the store's credential typed into
> the admin form is refused. That was the day's headline outage and it is gone.
>
> ⚠️⚠️ **BUT DO NOT READ "GREEN" INTO THIS FILE. The full integration suite has never run against
> the code now in production** — not here (OOM, DEF-245) and not in CI, which was **switched off**
> for nine hours (DEF-336). Ian was told that plainly and chose to deploy anyway. **Quote the gates
> table below, never the word "green".**
>
> Written for a **COLD start**. Read `docs/RULES.md` first, then this. `PROJECT_BIBLE.md` wins any
> disagreement.

## Where things stand

**Production is healthy, current, and serving the two-layer sign-in.** Migration **`0147`** is
applied. All nine timers armed, all eight scheduled jobs reporting `success`.

⭐ **Two firsts happened today, and neither was true before:**

1. **The pipeline applied a real pending migration by itself.** Lane A established that the four
   unattended deploys everyone cited as proof **all had zero pending migrations** — Ian had
   hand-applied `0144`-`0146` first. So *"proven unattended"* had only ever meant *connected
   cleanly and no-op'd*. Run `34758896635` applied `0147` (`Migrations applied in 303ms`, against
   177ms for the no-ops). **No document had said this.**
2. **A staff PIN signed a person in on a store tablet** — the thing T-304, T-303 and DEF-333 all
   existed for.

⛔ **The day's most dangerous discovery, and it was silent: `CI` had been `disabled_manually` since
11:42 (DEF-336).** A `git push` of three commits — one rewriting sign-in — created **zero runs**.
`Deploy` is `workflow_run`-gated on `CI`, so nothing would ever have deployed. `git push` exits 0,
Actions still reads `enabled: true`, `Deploy` still reads `active`. **Every surface a person checks
said healthy while the pipeline was off.** It reached production only because the orchestrator
dispatched `Deploy` by hand. ✅ **Re-enabled the same evening on Ian's decision**, with the guard he
also authorised reserved as **T-308**.

## Gates on the code in production (`d2e32a1`)

⚠️ **No code changed today.** Every commit this session is documentation; `d2e32a1`'s code tree is
byte-identical to `3c25275`, confirmed with `git diff --name-only`. **That is the only reason the
older rows below carry over.**

| Gate | Result |
|---|---|
| `npm run typecheck` | **exit 0** (at `3c25275`; code tree unchanged since) |
| `npm run test` (unit) | **exit 0** — 111 files, 1472 passed, 1 skipped (same) |
| `npm run build` | **exit 0** locally, **and again on the deploy runner** for `d2e32a1` |
| `npm run toc` | **exit 0**, re-run repeatedly this session |
| Integration — **scoped** | **exit 0** — 21 files, 810 passed, 295s, on `shareat_test_orch` |
| Integration — `terminal-sign-in.test.ts` alone | ⭐ **exit 0, 23/23, 4.62s** — invariants 7 and 8, re-run by the orchestrator rather than taken on report |
| Integration — **full suite** | ⛔ **NEVER RUN AGAINST THIS CODE.** OOM twice locally (DEF-245); CI disabled (DEF-336) |
| **CI** | ⛔ **zero runs** for `58f198a`, `3c25275`, `d2e32a1`. ✅ Workflow re-enabled; the wrap-up push is its first real exercise |
| Deploy | **success** — `34758896635`, `workflow_dispatch`, migrate + restart + health green |
| **Production, on a device** | ✅ **All eight cutover steps passed.** Layer 1, layer 2, and the refusal |

## The cutover — what was actually proven, and how

`docs/tasks/304-two-layer-terminal-sign-in.md` §Cutover. Terminal person
`01a09b5f-14b5-767e-a683-64e7c15d5ae7`, credential `01a09b5f-14bc-7b68-9d0c-d5c565c4771b`,
store **`LIPA` — SharEat Lipa**, Firebase uid `ZC2PNnTaMURnnHxQGMSd95E1dZv1`.

| Step | Result |
|---|---|
| 3 — admin signs in by email | ✅ **The unrecoverable case, cleared first** |
| 5 — `provision-terminal` | ✅ dry run read back the store **name**, then `--confirm` |
| 6 — terminal signs in, PIN box appears | ✅ no store chosen anywhere |
| 7 — PIN identifies a person | ✅ |
| 8 — store credential refused by the admin form | ✅ **invariant 8** |

⭐ **Step 8 needed reasoning, not just reading, and the next person must know why.** The refusal
renders `apps/erp/src/app/sign-in/lib.ts:40`, the UI's wording for the domain's single `NOT_LINKED`
sentence — and `packages/auth/src/sessions.ts` throws that sentence from **two** places: `:202`
(credential absent or not firebase-kind) and `:213` (`personKind === 'terminal'`). **Step 6
succeeding proves the credential exists and is firebase-kind, so `:202` cannot have fired.** The
identical wording is deliberate (`sessions.ts:205-212`). ⛔ **Verify invariant 8 by eliminating
paths, never by the text on screen.**

## What was found today — ten defects, and none of them were new knowledge

⭐ **The pattern, now nine times: the knowledge was already written down, correctly, and
disconnected from the decision that needed it.** Today it stopped being only about knowledge.

| # | Finding |
|---|---|
| **DEF-336** ⛔ | `CI` disabled by hand; every push inert. **Fifth member of the DEF-194/240/326/332 *installed-but-never-armed* family, first outside systemd.** The lesson was on the droplet four times and never reached the CI provider |
| **DEF-337** ⚠️ | `provision-terminal.ts` has no `SYSTEM_DATABASE_URL` guard; `deploy.yml` was hardened against the identical failure. ⭐ **Empirically discharged today** — the script reached the DB as `doadmin` |
| **DEF-338** ⛔ | A test comment **orders** the deletion of a timeout the register forbids deleting. Its precondition came true **eleven lines below it** |
| **DEF-339** ⚠️ | T-306 made docs pushes cheap in `CI` and left `Deploy` rebuilding and **restarting production** for a Markdown edit |
| **DEF-340** ⛔ | Every instruction says *"the Firebase console"* and never **which** — and there are two projects. **Caught by Ian, not by us** |
| **DEF-341** ⚠️ | `erp2.shareat.net` is not an authorised domain; `erp.shareat.net` is |
| **DEF-342** ⚠️ | v1 uses customers' **phone numbers as Firebase uids** |
| **DEF-343** 🔸 | v1 mints a permanent auth user per table join and never deletes one — **Ian's 7,000** |
| **DEF-344** ⚠️ | The db client derives TLS from `NODE_ENV` and **overrides the connection string**, so hand-run scripts connect unencrypted and are refused. **`bootstrap-org.ts` has it too** |
| **DEF-345** 🔸 | The backtick trap **already damaged this register on 2026-09-10** and nobody swept for casualties |

**Corrected from a disposition review nobody had scheduled:** DEF-333, DEF-334, DEF-328 → `fixed`;
DEF-245, DEF-268 → `verified`. ⭐ **DEF-245 — the row every *"CI is the only real integration gate"*
citation rests on — was stamped `reported`, which this register's own legend defines as
unchecked.** DEF-326's disproven hypothesis retracted; DEF-325 given the number that shipped;
DEF-327's *"proven unattended"* marked past-tense; **DEF-245 ↔ DEF-336 cross-referenced** — *a sole
gate that can silently vanish is not a gate, it is a habit.*

## ⛔ Read this before you edit any document

**The backtick trap bit the orchestrator on 2026-09-13 evening, an hour after it quoted the warning
to a lane.** `node -e "…"` is an `-e` string; bash expands backticks inside the double quotes before
node sees them. Two identifiers became **nothing**, and the command **exited 0 reporting success** —
the only signal was two stray `command not found` lines above it.

⭐ **The control is the method, not the memory:** **Write tool → plain file → a script that READS
the file.** Every edit made that way today was clean; the one inline `node -e` was not.

⛔ **And run the parity sweep after any document edit** — it is one command and it found DEF-345:

```
node -e "const fs=require('fs');for(const f of ['docs/DEFECTS-REGISTER.md','PROJECT_BIBLE.md','docs/HANDOFF-TODAY.md']){const b=[];fs.readFileSync(f,'utf8').split(/\r?\n/).forEach((l,i)=>{if(/^\| /.test(l)&&((l.match(/\x60/g)||[]).length%2))b.push(i+1)});console.log(f,b.length?('ODD: '+b.join(',')):'ok')}"
```

**Current state: `DEFECTS-REGISTER.md` line 332 (DEF-258) is the only known casualty, filed as
DEF-345. The bible and this file are clean.**

## Pick up here

1. ⛔ **DEF-338 first.** A live comment instructs the wrong action, its precondition is met, and
   following it removes a safeguard holding up something nobody has explained. One comment, no
   behaviour change. **It is the only open finding that causes a wrong action rather than a wasted
   hour.**
2. ⛔ **DEF-344 — the TLS override.** `bootstrap-org.ts` cannot reach production either, and
   first-run setup is the least recoverable place to discover that. ⚠️ **Do not "fix" it by telling
   people to prefix `NODE_ENV=production`** — that was the cutover workaround, not the remedy.
3. **T-308 — the CI-liveness guard**, authorised by Ian. ⭐ **Lane C re-scoped it and the re-scope
   is settled: assert DEPLOYED-REVISION LAG, not workflow state.** `Deploy` reported `active`
   throughout DEF-336 while being structurally dead. **Read `docs/tasks/308-*.md` before
   re-deriving anything.**
4. **T-307 — CI env-block assertion.** Deliberately **not** bundled with T-308.
5. **T-309 — ERP v2 gets its own Firebase project.** ⛔ **Hard gate written into the file: do not
   start it while there is only one way to sign in.** That gate is now satisfied.
6. ⛔ **DEF-330's manual-migrate recipe is still broken** — `docs/ops/README.md:100-103` still says
   `cd /srv/shareat`, the symlink that points at the *stale* release exactly when a deploy is
   half-broken. Lane B wrote a correct replacement that resolves the release explicitly and verifies
   with a before/after count; it is in this session's transcript and should be written in.
7. **DEF-325's stall is still unexplained**, and the 120s timeout is **not** dead weight. Re-measure
   before deleting — see DEF-334 and DEF-338.

## Do not decide these alone — they are Ian's

- ⚠️ **A fourth `persons` reader** could appear and compile clean; the `kind` filter is fail-open.
  A build-enforced guard is the fix. **The only genuinely-Ian item left, and even it is arguably
  engineering.**
- ⚠️ **T-309's disclosure sub-question:** the cheapest place to publish the deployed commit is
  `/api/health`, which is **unauthenticated**. The private alternative is a file on the box.
- ⭐ **Answered today, recorded so they are not re-asked:** *whether to push* (ship — asked twice,
  the second time with the honest framing that nothing had tested the code) · *whether to re-enable
  CI* (yes, and build the guard) · *which Firebase project* (finish on the borrowed one, move after
  — T-309).
- ⛔ **DEF-329 was mis-routed into this section and has been moved out.** It sat here meaning
  *"unbudgeted"* — a **sequencing** statement — under a heading that reads as **decision rights**.
  It is now **T-307**. ⭐ **A thing belongs here because a RULE reserves it, never because it is
  merely unscheduled.**

## Traps that have actually bitten — live in this area right now

- ⛔ **Backticks in a shell string.** See the section above. It bit again today.
- ⛔ **`npm run build` dirties `apps/erp/next-env.d.ts`**; `dev` flips it back. Generated —
  **restore it, do not commit it.**
- ⛔ **The full local integration suite OOMs.** Scoped runs are healthy. DEF-245.
- ⛔ **`systemctl list-timers` cannot show a timer that was never enabled.** Use `is-enabled`.
  ⭐ **And its GitHub twin: `Deploy: active` means nothing if `CI` is disabled** — check
  `gh workflow list --all`, not the Deploy row.
- ⛔ **`/srv/shareat` is the symlink the deploy swaps LAST** — when a deploy is broken it points at
  the *stale* release (DEF-330).
- ⛔ **Hand-run scripts on the box need `NODE_ENV=production`** or they connect unencrypted and are
  refused (DEF-344). ⚠️ **A workaround, not a fix.**
- ⚠️ **Server runtimes are UTC.** `formatBusinessDateTime` is the only sanctioned formatter.
- ⛔ **SSH to the droplet was blocked for the orchestrator** by the permission classifier. Ian ran
  every host-side command. **Ask him rather than working around it.**

## Live agent sessions at wrap-up

| Session | Model | Lane DB | State |
|---|---|---|---|
| `system32-85` | Opus 5 | `shareat_test_orch` | orchestrator — this session |
| `webapps-65` | Sonnet 5 | `shareat_test_lanea` | **idle.** Killed the rehearsal hypothesis; found the zero-pending-migrations fact; wrote the step 3-8 signatures |
| `webapps-4e` | Sonnet 5 | `shareat_test_laneb` | **idle.** T-306 classification; the `provision-terminal` read; the working rollback recipe |
| `webapps-f7` | Opus 5 | — | **idle.** The disposition review (12 register edits) and the T-308 re-scope |

⭐ All lane databases current at **131 migrations**, re-attachable by name.

⚠️ **`docs/scratch/` is UNTRACKED and deliberately not committed.** It holds lane C's two working
documents (the DEF-325..345 disposition review and the DEF-336 guard analysis). **Their substance
was transcribed into the register rows and `docs/tasks/308-*.md`**, so committing them would create
a second copy of decided content — the drift this repo keeps filing defects about. They are left on
disk because they are the evidence behind twelve register edits. ⛔ **Read them if you want the
reasoning; do not treat them as current — the register is the record.** Delete them freely.

⚠️ **A fifth interactive session, `webapps-36`, has been alive ~10h and is in no lane.** Treated as
**foreign** all session — no work given, no assumption about its files. The tree stayed clean.
**Do not adopt it by name without asking Ian what it is.**

⭐ **The method that produced most of today's findings: the lanes were sent QUESTIONS, not change
orders, and corrected the orchestrator five times** — the rehearsal hypothesis killed as redundant,
*"three unattended deploys"* re-measured, DEF-329 shown not to be Ian's, T-306's prediction shown
untestable on that push, and DEF-338 found in a file nobody had asked about. **Not one came from
building.** ⛔ **A sixth correction came from Ian**, who stopped the cutover to ask why Firebase had
7,000 users — which is DEF-340, and it would have sent the terminal account to the wrong project.

## Numbers to allocate from

- Next task **T-310** · next defect **DEF-346** · next migration **`0148`** (`when` > `1798774307084`)

⚠️ **Allocated 2026-09-13, do not re-issue:** **T-307** (CI env-block assertion) · **T-308**
(deployed-revision-lag guard) · **T-309** (ERP v2's own Firebase project) — all three are **stubs
with the analysis written and the spec not yet written**. **DEF-336** … **DEF-345**.
⭐ **`0148` is still free — no migration was written today; `0147` shipped from `58f198a`.**

## The paste-ready prompt

<!-- Copy everything between the two rows of dashes. -->

-----------------------------------------------------------------------------------------------

You are the orchestrator for shareat-system (C:\Users\ianla\webapps\shareat-system). Run the
global /orchestrator skill. You are starting COLD.

Read in this order: docs/RULES.md, docs/HANDOFF-TODAY.md, PROJECT_BIBLE.md §13 rows 194-201,
docs/DEFECTS-REGISTER.md section E (DEF-325 through DEF-345 are the live ones).

Tree clean, nothing unpushed, production serving the deployed commit with migration 0147 applied.
PIN SIGN-IN WORKS — the T-304 cutover ran in full on 2026-09-13 and all eight steps passed on a
real device. DEF-333 is closed end to end. Do not re-open it or re-litigate the push.

⛔⛔ FIRST, BEFORE TRUSTING ANY PIPELINE: verify CI is enabled.
  gh workflow list --all
It was `disabled_manually` for nine hours on 2026-09-13 and NOTHING reported it — git push exits 0,
Actions reads enabled:true, Deploy reads active, and zero runs are created (DEF-336). ⚠️ Do NOT
satisfy yourself with "Deploy: active"; Deploy is workflow_run-gated on CI and was structurally
dead the whole time. T-308 is the guard, authorised and unbuilt, and lane C already settled its
design: assert DEPLOYED-REVISION LAG, not workflow state. Read docs/tasks/308-*.md first.

Do NOT claim any integration green. The full suite has never run against the deployed code — OOM
locally (DEF-245), CI disabled (DEF-336). Quote the gates table; never the word "green".

START WITH DEF-338. A comment in position-defaults.test.ts instructs the reader to delete a timeout
the register forbids deleting, and its stated precondition came true eleven lines below it. It is
the only open finding that causes a WRONG ACTION rather than a wasted hour. Then DEF-344 — the db
client derives TLS from NODE_ENV and overrides the connection string, so bootstrap-org.ts cannot
reach production either.

⛔ EDITING DOCS: a shell heredoc or `-e` string with backticks EXECUTES them, and `node -e "…"` is
an `-e` string. It bit the orchestrator on 2026-09-13 an hour after it quoted the warning to a
lane; two identifiers became nothing and the command exited 0 reporting success. Use Write tool →
plain file → a script that READS the file, and run the backtick-parity sweep in this handoff after
every doc edit. DEF-345 is what that sweep found.

THE PATTERN, NINE TIMES: the knowledge was already written down, correctly, and disconnected from
the decision that needed it. It is no longer only about knowledge — DEF-338 is a stale remedy still
ISSUING AN INSTRUCTION, and DEF-345 is a documented trap whose existing casualties nobody swept
for. Before filing anything, grep whether this repo already says it. Before following any
instruction in a comment, check whether its precondition quietly came true.

Ask each lane a QUESTION, not just for a change. On 2026-09-13 that produced five corrections to
the orchestrator and a sixth from Ian, who stopped the cutover to ask why Firebase had 7,000 users
— which was DEF-340, and it would have sent the terminal account to the wrong project.

⛔ SSH to the production droplet is BLOCKED for the orchestrator by the permission classifier. Ian
runs host-side commands. Suggest he type `! <command>` so the output lands in the conversation.

Next task T-310 · next defect DEF-346 · next migration 0148 (when > 1798774307084).
T-307, T-308, T-309 are RESERVED stubs with analysis written and specs unwritten.

-----------------------------------------------------------------------------------------------

# Handoff — 2026-09-19 (late evening, written immediately before a machine reboot)

> ⭐⭐ **THE GOAL, IN IAN'S WORDS, UNCHANGED: *"make the app as close as possible to deployment."***
> ⚠️ **AND IT IS NOT LAUNCHED.** Production deploys exist; no staff use it yet. That changes urgency,
> never correctness. ⛔ **This document makes no PRESENT-TENSE claim about which commit production
> runs** (DEF-360). Ask `/api/health` and compare all forty characters against
> `git rev-parse origin/main`.

## Where things stand

**`origin/main` is `edad7dc`. The tree is clean** apart from two files that are deliberately not
yours (see §5). **Nothing is in flight and no lane holds work** — that is why the reboot is happening
now.

⚠️ **THIS SESSION SHIPPED NO CODE. Every commit below is docs, a spec, a register row or a ruling.**
Nothing was built, so nothing needs a gate — and no §9 gate was run, which is correct rather than
skipped.

| Commit | What |
|---|---|
| `d362a80` | **DEF-382 `verified` by execution** + T-327 and T-328 specs |
| `4372af2` | Roadmap rows for both, carrying the measurement rather than the intention |
| `edad7dc` | **Bible row 216** — Ian's ruling on DEF-380 — and **DEF-386 filed** |

## ⛔ 1. FIRST THING AFTER THE REBOOT — RE-TEST THE RENDERER. IT IS ONE COMMAND.

**This was the whole reason for the reboot, and nobody has yet seen it work.**

```
npm run dev                     # from the repo root; it binds 9008
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:9008/api/health   # was 200 even when broken
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:9008/sign-in      # was 500 — THIS is the test
```

**Measured before the reboot, twice, on a fresh `.next`:** `/api/health` → **200**, every page route →
**500**, with
`PostCssTransformedAsset::process → creating new process → node process exited before we could
connect to it with exit code: 0xc0000142`. That is Windows failing to start a process, not a code
fault; no CSS was touched.

⛔ **One hypothesis was tested and is WORSE — do not repeat it.** `next dev --webpack -p 9008`
instead of Turbopack: `instrumentation.ts` fails to resolve `@google-cloud/storage`'s dependency
chain and **even `/api/health` 500s**. Turbopack is the configured bundler here; leave it.

⭐ **If page routes now return 200, say so loudly** — §9.4 has been unmet on every task since
2026-09-17 and that would be the first time in three days the screen is reachable.
⛔ **AND THE SIGN-IN CONSTRAINT IS SEPARATE AND SURVIVES A REBOOT:** all five
`NEXT_PUBLIC_FIREBASE_*` in `.env.local` are empty and `/sign-in` has no emulator path of its own
(DEF-371). **A token or a password is off-limits to an agent, and "it is a throwaway emulator
credential" is not an exemption.** Even with a working renderer, a signed-in screen needs Ian.

## ⛔ 2. PICK UP HERE — T-327, THEN T-328

**Both are fully specced, reviewed and committed. Do not re-derive them.**

- **`docs/tasks/327-a-poison-value-that-passes-every-guard.md`** — the database refuses a non-finite
  amount on **all 172** `numeric` columns. **Migration `0155`.** ⭐ **No census, no call-site
  changes — that is the point of it.** It ships first so that T-328's census is allowed to be wrong.
- **`docs/tasks/328-every-typed-amount-reaches-the-parser-that-already-exists.md`** — the
  enumeration and the conversion. **Depends on T-327.**

⭐ **DEF-382 is `verified`, not `reported` — the probe has been run.** Executed against live
Postgres this session, on the real column shape (`numeric(14,2)` with a `CHECK (a > 0)`, **not** a
bare `numeric`, which was the first probe's mistake):

| Fact | Result |
|---|---|
| `INSERT 'NaN'` past a real `CHECK (amount > 0)` | **stored** |
| `'NaN'::numeric > 0` | `true` |
| `'NaN' = 'NaN'` | **`true`** — so `CHECK (col = col)` is no guard |
| `NaN + 100` · `NaN * 0` | `NaN` · **`NaN`** |
| `numeric` columns in `public` / **bare** ones / holding a `NaN` today | **172** / **0** / **0** |
| `'Infinity'` into `numeric(14,2)` | **refused** — `numeric field overflow` |

⭐ **`Infinity` is therefore NOT reachable in this schema and that was checked, not assumed** — every
column carries a precision. The finite-range constraint is still the one to write, because it costs
nothing more and is right on the day somebody adds a bare `numeric`.

**Then, in order:** **DEF-386** (below — it now has a ruling behind it) · DEF-374 · T-320
(+DEF-367) · DEF-373.

## ⛔⛔ 3. BIBLE ROW 216 IS NEW, AND IT UNBLOCKS DEF-380 WHILE BLOCKING ON DEF-386

**Ian ruled on 2026-09-19**, in his own words:

> *"mirror what v1 workflow does sales report submited, verified. once verified it is recognized as
> sales, remittance is just money movement where is the money. shortage will keep sales day from
> being closed=fully remitted so manager can always go back and charge or mark as remit when staff
> pays shortage by cash. overage will be considered other income."*

**Four rulings. Two of them confirm the build rather than change it** — verification already IS the
posting (`sales-days/verify.ts` says so in its first line), and a remittance already recognises
nothing.

⭐ **An overage is other income → `7350 "Cash over and short"`** (parent `7000`). **The account
exists, is seeded, and `till/index.ts` already reserves it for a remittance variance in terms, with
a test asserting the till module never touches it. No new account, and none may be created.**

⭐ **A shortage is NOT a disposition** — it leaves the day short of fully-remitted, and a manager may
later charge it **or mark it remitted when the staff member pays cash.** `remittanceStateOf` already
derives `partially_remitted`; **the cash-payment path does not exist and must be built.**

⛔⛔ **BOTH HALVES ARE BLOCKED ON DEF-386, WHICH IS THE LARGER FINDING.** Resolving a variance posts
**nothing**: `charged_to_person_id` is written and **read by nothing**, there is no
`journal_entry_id` on the variance, and `resolveRemittanceVariance` only sets status fields. **So
charging a shortage to a person recovers no money and creates no receivable — v2 is behind v1**,
which posted `staff_advance__{staffId}` as a payroll-deductible receivable. ⭐ **The shape already
exists one module over:** `chargeTillShortage` posts `Dr 1230 Advances to employees / Cr the account
that came up short`.

⛔ **Refused on evidence, so do not re-propose it:** attributing a surplus to a day still awaiting
verification. No surveyed system does it and it is the lapping/skimming shape. Netting an overage
against a shortage is refused too — GAO B-199447 rejects it by name.

## 4. ⛔ Live agent sessions — THE REBOOT ENDS ALL OF THEM

**Every session below dies with the reboot. None of them will come back, and none should be waited
for.** Start fresh terminals.

| Session | Role | Note |
|---|---|---|
| `system32-4f` | orchestrator | this one; dies with the reboot |
| `webapps-1c` | AUDITOR (Opus) | was idle and clean; **correctly refused to ACK a new cycle's briefing without Ian clearing it in its own terminal** — that behaviour is right, expect it again |
| `webapps-36` · `webapps-37` | BUILDER · TESTER (Sonnet) | **never answered a status ping all session** — if that repeats after the reboot, the terminals are not delivering cross-session messages and Ian must intervene |
| `webapps-5a` | Ian's own | not a lane |

⭐ **After the reboot: three fresh terminals, one per role, each paste the block at the bottom.**
⛔ **ASK EACH ITS MODEL; NEVER READ IT OUT OF A TABLE** (DEF-361). TESTER and BUILDER on **Sonnet**,
AUDITOR on **Opus**.

## 5. Numbers to allocate from

Next task **T-329** · next defect **DEF-387** · next migration **`0155`** (**allocated to T-327's
builder; not yet written**).
⛔ **`0154` IS APPLIED — never edit it.** Reserved, do not re-issue: `0149`/`0150`/`0151`.
⚠️ **`docs/reviews/NEXT-PROMPT.md` (modified) and `docs/reviews/2026-09-17.md` (untracked)** are an
exited session's, deliberately uncommitted since 2026-09-17. **Leave them, and never stage them** —
three separate commits this session had to avoid them by staging explicit paths.
⚠️ **Lane databases from 2026-09-19 will survive the reboot** (`shareat_test_t325_*`,
`shareat_test_t326_*`); **T-327/T-328 need their own** — `shareat_test_t327_{tester,builder}`.

## 6. ⛔ FOR IAN — open decisions nobody else can make

1. **Should `write_off` exist at all?** v1 has **no** such path — a shortage was always charged — and
   row 216 names two outcomes, neither of which is forgiving a loss. A third exists in the schema
   today. ⛔ **Not deleted, deliberately: removing a capability someone uses is Ian's call.**
2. **Who may accept an overage?** Charging a shortage is gated behind a manager permission in v1 and
   in the till module. Accepting an overage is a different act and may warrant a different gate.
3. **Is verification meant to happen before handover?** Only a **verified** day is settleable, so
   cash handed in ahead of verification cannot be allocated and becomes a surplus **by
   construction**. If handover routinely runs ahead of verification, that is a workflow question
   worth answering before building controls around its symptom.
4. **`DEF-370` is cited twelve times across `docs/reviews/` and HAS NO ROW** — the numbering jumps
   369 → 371. Still true, still unfixed.
5. **`docs/reviews/NEXT-PROMPT.md`'s uncommitted edit reinstates a remedy its own committed version
   struck out as FALSE.** Correct it or discard it — Ian's call, untouched since 2026-09-17.
6. ⚠️ **Small truth bug, nobody's task:** `docs/RULES.md` §5 says the bible holds *"107 logged
   decisions"*. It holds **216**. A count in a place nobody maintains, which is the lesson this repo
   keeps re-learning.

## The paste-ready prompt

<!-- Copy everything between the two rows of dashes. -->

-----------------------------------------------------------------------------------------------

You are the orchestrator for shareat-system (C:\Users\ianla\webapps\shareat-system). Run the global
/orchestrator skill. You are starting COLD, on a freshly rebooted machine.

⭐ IAN'S GOAL: "make the app as close as possible to deployment." ⚠️ IT IS NOT LAUNCHED. Production
deploys exist; no staff use it yet. That changes urgency, never correctness.

⛔⛔ FIRST, BEFORE ANY PLANNING: re-test the renderer, it is one command. `npm run dev`, then curl
http://localhost:9008/sign-in. Before the reboot /api/health returned 200 and EVERY page route 500'd
with Turbopack failing to spawn the PostCSS worker (0xc0000142). THE REBOOT WAS DONE SPECIFICALLY TO
TRY TO FIX THIS. If pages now render, say so loudly — §9.4 has been unmet since 2026-09-17. ⛔ Do NOT
retry `next dev --webpack`; it was tested and is worse (even /api/health 500s). ⛔ Sign-in is a
SEPARATE constraint that a reboot does not fix: the five NEXT_PUBLIC_FIREBASE_* are empty and a
credential is off-limits to an agent (DEF-371).

⭐⭐ THREE SESSIONS, THREE FIXED ROLES — a TESTER who writes the red and drives the real screen, a
BUILDER who makes it green and never edits a test, an AUDITOR who runs /code-review READ-ONLY on
every slice. Read SKILL.md §2 before briefing anybody. ⛔ GIVE EACH LANE ITS OWN LANE DB
(shareat_test_t327_tester / _builder). ⛔ ALL PREVIOUS SESSIONS DIED WITH THE REBOOT — start three
fresh terminals, do not wait for webapps-1c/36/37. ⛔ ASK each its model, never read it from a table
(DEF-361): TESTER and BUILDER on Sonnet, AUDITOR on Opus. Ian may need to accept your briefing in
each terminal before it ACKs, and an auditor refusing to ACK without his say-so is CORRECT.

⛔⛔ THE ORCHESTRATOR IS THE LEAST-POLICED SESSION AND IT CAUSED EVERY COLLISION ON 2026-09-19: two
integration runs on one lane database from contradictory instructions; a lane's source file edited
mid-verification without telling it; a .test.ts created under packages/ while a gate was scanning it.
APPLY YOUR OWN FREEZE RULES TO YOURSELF. When you take a gate over from a lane, say explicitly "this
supersedes my earlier instruction to X".

NEXT UP: T-327, then T-328. BOTH ARE FULLY SPECCED AND COMMITTED — docs/tasks/327-*.md and
docs/tasks/328-*.md. DO NOT RE-DERIVE THEM. T-327 adds a finite-value CHECK to all 172 numeric
columns (migration 0155) and deliberately touches NO call site and needs NO census — it ships first
so that T-328's census is allowed to be wrong. DEF-382 is already `verified`: the probe was executed
against live Postgres and 'NaN' stores past a real CHECK (amount > 0), while 'Infinity' is refused by
every column because they all carry a precision.

⛔ BIBLE ROW 216 IS NEW — Ian's ruling on DEF-380. An overage is other income, posted to 7350 "Cash
over and short", an account that ALREADY EXISTS and is already reserved for exactly this. A shortage
is not a disposition: it leaves the day short of fully-remitted and a manager may later charge it or
mark it remitted when staff pays cash. BOTH HALVES ARE BLOCKED ON DEF-386 — resolving a variance
posts NOTHING today, charged_to_person_id is read by nothing, and v2 is behind v1 here.

⛔ SPELLING IS NOT SHAPE. A census bound by one spelling missed 21 of 56 files; a third and then a
FOURTH spelling (template-literal keys, 17 sites in 4 files) were invisible to the ones before them.
⛔ RE-DERIVING A NUMBER CHANGED IT FIVE TIMES IN TWO DAYS. Never put a count in a test name.
⛔ ASK OF EVERY PASSING CHECK: who chose its input set? And of every assertion: what value would have
to be wrong for this to go red, and does the code under test supply it? A spec review on 2026-09-19
found THREE assertions that could not fail, in a spec its own author had just written.
⛔ AN IDENTIFIER OR FIGURE YOU HAVE NOT READ IS A GUESS (bible row 208). The previous handoff's
"14 money sites" did not survive checking, and the enumeration it promised was not in the file it
named.

Read: docs/RULES.md, docs/HANDOFF-TODAY.md, PROJECT_BIBLE.md row 216, DEFECTS-REGISTER.md section E.
⛔ GREP the big ones — the register is ~1MB and the bible ~418KB.

Next task T-329 · next defect DEF-387 · next migration 0155 (allocated to T-327, not yet written).

-----------------------------------------------------------------------------------------------

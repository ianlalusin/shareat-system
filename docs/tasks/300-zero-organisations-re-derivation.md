# T-300 — nine documents assert production has zero organisations; it has one

> **Status: BUILT 2026-09-13 by lane C (webapps-f7, Opus 5). Spec APPROVED by system32-85 with
> scope widened to 12 files. 11 documents edited; register and roadmap prose handed to the
> orchestrator.** See §"As built" below.

## The measurement — now direct, not derived

⭐ **PRIMARY, 2026-09-13:** `select count(*) from organizations` → **`1`**, `select name from
organizations` → **`SHAREAT OPC`**, run against the live production database by system32-85 as the
**admin role** (`SYSTEM_DATABASE_URL` / `doadmin`, `rolbypassrls = t`) — the one role RLS cannot
filter.

**CORROBORATING, 2026-09-12 15:57 UTC:** `/var/log/shareat/budget-reissue.log` reads
`budget-reissue: ok — created 0 · 1 orgs`, naming **SHAREAT OPC** (DEF-326).

⚠️ **Two methods, one answer — and the Q1 argument below is retained rather than retired**, because
it is what explains why a *third* reading taken the same day said `0`. See Q1 §"Two consequences".

---

# As built — 2026-09-13

## The count, corrected once more: 35, not 34, not 20

⚠️ **My own sweep had the same class of blind spot as the one it replaced, just a narrower one.**
The briefed figure came from a case-sensitive, line-bounded grep. Mine was case-insensitive and
wrap-tolerant — and still required *whitespace* between the two words, so it missed
`held **zero** organizations`, where markdown emphasis sits between the two words. Allowing
emphasis characters as well as whitespace found **one more in scope**
(`docs/ops/README.md` §"Standing up an organization") and two in `PROJECT_BIBLE.md`.

⭐ **The two bible hits are NOT this class, and one of them is worth reading.**
`PROJECT_BIBLE.md:1503` already states the exact mechanism this lane's Q1 turns on: *"Under a
non-bypassing role it reads **zero** organisations on a populated database, because `organizations`
is RLS-scoped `self` and no principal is declared."* **The bible documented the trap that
`docs/ops/README.md` then fell into three days later** by recording a `count(*) → 0` from
`shareat_app_prod` as though it were a census. The knowledge was present; nothing connected it to
the reading. **Bible amendment still not required.**

## What each in-scope file became

| File | Assertions | What was done |
|---|---|---|
| `docs/ops/README.md` | 9 | The `count(*) → 0` row now says in terms that it is **not a count**; the tenancy paragraph re-derived (conclusion kept, reason replaced, three concealed items surfaced, DEF-210's fixed half separated from its open half); "what is NOT proven" re-grounded; the 2026-09-06 section dated harder and forward-pointed, **its zero preserved**; the bootstrap section banner-ed as **already done and now refused**; the arming guidance replaced with the per-unit table. ⛔ **The manual-migration recipe was NOT touched** — left for DEF-330 |
| `docs/discovery/29-*.md` §5.3 | 1 | The root. Both unknowns resolved into a measured table; the two-column fork shown to have been **walked through both columns in sequence**; the right-hand column named as the live, undischarged state |
| `docs/discovery/30-*.md` | 1 | "No history to mine" kept, reason changed — and the recommendation **strengthened**: ship the counter at the moment data begins, not a month into the pilot |
| `docs/tasks/228-*.md` | 1 | True dated observation **preserved**, marked as the timeline's fixed point; task recorded as carried out; door recorded as shut |
| `docs/tasks/230-*.md` | 1 | SQL block left **byte-for-byte** (it quotes an immutable artifact); note added that the comment's *instruction* is right and its *justification* is not — DEF-331 |
| `docs/tasks/231-*.md` | 1 | Risk table resolved by measurement; **the sequencing hope recorded as not held** — `bootstrap-org` ran with slice 2 still open; stale `ops/README:31-34` citation pinned to a section |
| `docs/tasks/232-*.md` | 2 | Goal moved to past tense; the first-person-wins warning marked **extinguished** — closed safely but unobserved |
| `docs/tasks/239-*.md` | 1 | "Zero by construction" retired; `person_credentials` is **very unlikely to be empty** (bootstrap writes a credential in the same transaction); decision survives on the CHECK being fully validated, which never depended on a row count |
| `docs/tasks/251a-*.md` | 1 | "Silently reports success" corrected and **dated**: the guard predated the filing by three days |
| `docs/tasks/276-*.md` | 2 | The countdown has started: `fiscal_periods` cover `2026-09` → `2027-08`, first uncovered date **2027-09-01** |
| `docs/tasks/294-*.md` | 3 | Re-argued on three legs, two measured; conclusion unchanged; **reopening trigger rebuilt in two stages** because the original could not fire |

**Register (14) and `ROADMAP.html` (3) prose handed to system32-85 rather than edited.**

## The classification, as applied

**11 load-bearing** — every one re-argued in place, none patched. **17 decorative** (16 + the
emphasis-hidden one) — each made true with value + provenance + pinning mechanism, never a bare
number. **7 not-this-class.** Four true dated 2026-09-06 observations deliberately preserved.

## ⛔ Corrections I made to my own spec while building

- **"nobody has signed in"** — I wrote this in three places and it is not established. Bootstrap
  itself does **not** exercise the app role's RLS: `bootstrapOrganization` and the auth door both
  resolve to `SYSTEM_DATABASE_URL`, which bypasses it. So the first organisation was created
  without testing the thing the ops README wanted tested, **whichever side of the role swap it fell
  on** — and whether any of the 34 unprincipalled paths has since been hit is genuinely unknown.
  All three sites now say that instead.
- **`0139`** — cited from memory as the T-239 backfill migration; it is
  `0138_def229_credential_revoke_reason.sql`. Corrected before the edit landed.

---

# Q1 — the orchestrator's derivation, attacked link by link

**Verdict: the CONCLUSION holds. `1 orgs` is a true `count(*) from organizations`. One link of the
stated chain is wrong, and a stronger proof is available that does not need that link at all.**

## The four links, checked against source

| # | Claim | Verdict |
|---|---|---|
| 1 | the timer passes no `--org` | ✅ **Confirmed from the unit, not assumed.** `docs/ops/shareat-budget-reissue.service` — `ExecStart=/usr/bin/npm run budget-reissue`, no arguments. `budget-reissue.ts:29-32` only reads `--org=<v>`; nothing supplies one |
| 2 | `:74` prints `result.outcomes.length` | ✅ Confirmed verbatim (`scripts/budget-reissue.ts:74`) |
| 3 | outcomes come from `listOrgsToRun(undefined)`, an unfiltered select | ✅ Confirmed, with one correction to the citation: the call is `listOrgsToRun(options.orgId)` at `packages/domain/src/scheduler/index.ts:772`, which is the **domain wrapper** at `:220-222`, which calls `schedulerRepo.listOrgsToRun(tx, orgId)` at `packages/db/src/repo/scheduler.ts:24-31`. `.where(orgId ? eq(...) : undefined)` is a genuine no-op in Drizzle. **No status filter, no `is_active` filter** — and `organizations.isActive` exists (`packages/db/schema/organizations.ts:19`), so that matters: the count would include an inactive org if one existed |
| 4 | "it runs through `systemTransaction`, the system door, **so RLS is not hiding rows from it**" | ⚠️ **WRONG AS STATED, and this is the link worth knowing about.** `systemTransaction` sets **no principal and switches no role** — it is `getSystemDb().transaction(fn)` and nothing else (`packages/db/src/client.ts:171-173`). It is not a door through RLS. Its own docstring says so: *"With `SYSTEM_DATABASE_URL` unset, this is byte-for-byte `transaction()` — same connection, same credentials."* What actually keeps RLS off that query is a property of the **database role** |

## The link that does the work, and why the conclusion survives anyway

`organizations` carries **ENABLE + FORCE ROW LEVEL SECURITY** with one policy,
`organizations_self_isolation … USING ("id" = app_current_org())`
(`packages/db/migrations/0011_row_level_security.sql:115-118`). `app_current_org()` is
`NULLIF(current_setting('app.org_id', true), '')::uuid` (`0011:38-41`) — **NULL when unset** — and
migration `0011`'s own header states the consequence: *"a query with NO principal set matches NO
rows. DEFAULT DENY falls out of the semantics."*

`systemTransaction` never sets `app.org_id`. Therefore:

> ⭐ **On this one query there are exactly two possible worlds, and no third.** Either the
> connection is subject to RLS — in which case the select returns **zero** rows — or it is not, in
> which case it returns **every** row. There is no principal that could return a proper subset,
> because no principal was set. **So `1` cannot be an RLS-filtered undercount of a larger true
> count. The observed output is self-certifying.**

Had RLS applied, `outcomes.length === 0` would have fired (`budget-reissue.ts:65-70`), the log
would read `no orgs were processed — nothing to reissue?`, and the exit code would be 1. It reads
`ok — created 0 · 1 orgs`.

**`count(*) from organizations = 1`. Derived, and on a stronger footing than the briefing's.**

Which role it was is then a matter of record rather than of the proof: DEF-327 and
`docs/ops/README.md` §"Status as of 2026-09-12" record that `SYSTEM_DATABASE_URL` was added to
`/srv/shareat-shared/.env.local` that morning carrying the original `doadmin` string
(`rolbypassrls = t`), while `DATABASE_URL` was repointed to `shareat_app_prod`
(`rolbypassrls = f`). All eight job units share `WorkingDirectory=/srv/shareat` and `User=shareat`
with no `EnvironmentFile`, so they resolve the same `.env.local`; budget-reissue's success proves
that resolution works.

## ⛔ Two consequences of link 4 that you should have before approving anything

**(a) `docs/ops/README.md`'s own corroborating measurement is not a census, and reads exactly like
one.** The §2026-09-12 table records:

> `select count(*) from organizations` → `0`, a number rather than a permission error, so
> migration `0011`'s grants reached it through the group

That query was run **as `shareat_app_prod`** — `rolbypassrls = f`, no principal. Under FORCE RLS
with `app_current_org()` NULL it returns `0` **on any database, with any number of organisations**.
It is a proof that `SELECT` was granted; it is **not** evidence about the org count, and a reader
scanning that table will take it as evidence. ⭐ The `0` and the `1` do not disagree — they are
exactly what RLS semantics predict from two different roles on the same day. **That agreement is
additional confirmation of the premise, and the sentence around it has to stop implying a count.**

**(b) `systemTransaction`'s docstring is now stale on the one fact that matters.**
`packages/db/src/client.ts:167-170` still says the divergence applies to *"the integration test
harness … not production, not local dev, until a separate, later decision says otherwise."*
That decision was taken on 2026-09-12 and is recorded in DEF-327 and the ops README.
⛔ **Out of my scope (`packages/db/src/client.ts`). Reported, not edited.**

---

# Q2 — is the tenancy conclusion different, or only differently worded?

**Honest verdict: the CONCLUSION survives, the REASON must be replaced, and the sentence was
concealing three things — one of which is a near-miss, not a nuance.**

The sentence under test (`docs/ops/README.md:52`):

> ⚠️ The exposure was never realised because production has held **zero organisations**
> throughout; there was no second set of books to reach into.

## What is genuinely unchanged, and precisely why

Cross-tenant exposure needs **two** tenants. At `n = 1` it is not expressible, and that is
arithmetic rather than a defence:

- A query that forgets its `org_id` predicate (DEF-209's class) returns SHAREAT OPC's rows — the
  same set a correctly-scoped query returns for its only tenant. No row belongs to anyone else.
- A client-supplied `org_id` (DEF-210's class, fixed in code 2026-09-07 by T-231 slice 1) could
  only name SHAREAT OPC — a no-op — or a uuid with no row, which the FK to `organizations` refuses.

So *"the exposure was never realised"* is **true, and stays true**. It was never true *because*
there were no books; it is true because there is **one set of books and cross-tenant leakage needs
two.** Same verdict, different sentence — and the different sentence is the honest one.

## What the old sentence concealed — three things, stated even though two are uncomfortable

1. ⛔ **There was a window in which a real organisation existed behind a bypassing role, and
   nobody knew it was open.** Zero organisations is evidenced for 2026-09-06 evening
   (`finding-observation` exiting 1 under `doadmin`, a *bypassing* role — a real measurement).
   One organisation is evidenced for 2026-09-12 15:57 UTC. Somewhere in those six days the premise
   flipped, and `rolbypassrls = t` was live for at least part of that window.
   **"That is also why this was the cheap moment to do it" is therefore a near-miss rather than a
   plan.** Whether the window was hours or six days is not derivable from this repository — see
   the one command that settles it, in Q4.
2. ⚠️ **Data-at-risk went from the empty set to a non-empty one, and the sentence reads as
   "nothing was at risk."** Every defect whose blast radius is *this* tenant's data — a missing
   `authorize()`, an over-broad capability, an unauthenticated route — was genuinely harmless
   against an empty database and is not harmless now. None of those was ever protected by the
   organisation count; the sentence simply covered for them by accident.
3. ⚠️ **"No production read path has ever exercised its own RLS behaviour, because there has never
   been a row to scope"** (`:112`) is now false in its stated reason. There is a row to scope. The
   claim it was protecting — *the first real sign-in is still the real test* — survives intact,
   because nobody has signed in; but it must be re-grounded on "no user has exercised it" rather
   than "no row exists."

## ⭐ The one thing that got SAFER, and it belongs in the replacement prose

The repository's own "latent landmine" framing of the role change is **wrong, and wrong in the
reassuring direction** — see Q3, DEF-250. A restricted role does not make scheduled jobs *silently
succeed* on zero organisations; it makes all eight of them **exit 1, loudly, into a mailer**. The
failure direction of the whole tenancy tightening is a closed door, never an open one — the same
property `anyOrganizationExists` has (`packages/db/src/repo/organizations.ts:225-236`: under a
non-bypassing role it answers `false` on a populated database and the INSERT is then refused by the
policy's own `WITH CHECK` — *"a wrong sentence, never a second organisation"*).

---

# Q3 — the classification, and a spec defect in the scope list

## ⛔ SPEC DEFECT: "nine files, 20 assertions" is an undercount, and the scope list inherits it

`grep -rl "zero organi[sz]ation" docs/` is **case-sensitive, single-phrase and line-bounded.** It
misses `ZERO organizations`, `no organisations`, and — because these files are hard-wrapped — every
assertion where `zero` ends one line and `organisations` begins the next. Re-run wrap-tolerant,
case-insensitive and variant-tolerant (`(?:zero|no|0|without an?)\s+organi[sz]ation`, whole-file
slurp), the same nine files hold **34 occurrences, not 20**, and **eight further files** carry the
same class of claim.

| Where | Briefed count | Measured | Notes |
|---|---|---|---|
| `docs/DEFECTS-REGISTER.md` | 10 | **14** | DEF-311 alone carries 3; DEF-250 and the 2026-09-12 cycle row are new |
| `docs/ops/README.md` | 2 | **8** | `:52`, `:112`, `:120`, `:134`, `:236`, `:245` all missed by the grep |
| `docs/ROADMAP.html` | 1 | **3** | `:717`, `:730` missed |
| `docs/tasks/232-*` | 1 | **2** | `:20` (the Goal) missed |
| `docs/tasks/276-*` | 1 | **2** | `:43` missed |
| `docs/tasks/294-*` | 2 | **3** | `:72` missed |
| `docs/tasks/228-*`, `231-*`, `251a-*` | 1 each | 1 each | ✅ as briefed |

**Four real assertions of the same class live OUTSIDE the scope I was given**, and I am not
widening scope unilaterally — I am reporting them and stopping at the boundary:

| File | What it asserts | Why it matters |
|---|---|---|
| `docs/discovery/29-rls-enforcement-assessment.md:526` | *"Production has **never had an organisation** … So no production read path has ever exercised its own RLS behaviour"* | §7 of that assessment rests on it, **and `docs/ops/README.md:112` and `docs/tasks/231:447` both cite it as their source.** Fixing the citers while the cited source still says it is how this returns |
| `docs/discovery/30-tutorials-assessment.md:192` | *"Production currently holds zero organizations, so there is no history to mine"* | Load-bearing for a build/don't-build recommendation — the same shape as T-294 |
| `docs/tasks/239-def-229-credential-revoke-reason.md:400` | *"The production count is **zero by construction, not by assumption**: no organisation exists on production yet"* | It upgraded a spec's *"unknown"* to *"zero by construction."* The construction is gone |
| `docs/tasks/230-sales-channels-admin-and-wastage-policy.md:251` | *"Production holds zero `order_wastages`: there are no organizations yet"* — justifying a `SET NOT NULL` | ⛔ **And it is frozen in an applied migration**: `packages/db/migrations/0133_t230_sales_channel_admin.sql:30,59` carry the same two sentences. Bible §2 rule 9 — an applied migration is never edited. The false premise is permanent there and can only be annotated elsewhere. ⚠️ The migration's *outcome* was correct (it applied); its *argument* was unsound and happened to be true |

Also outside scope, named only so nobody is surprised: `docs/HANDOFF-TODAY.md:10,81` (forbidden to
me) carries the arming guidance corrected below. `PROJECT_BIBLE.md:1502`, `docs/discovery/28:46,445`
and `docs/tasks/229:238` match the pattern but are **not** this class — they say *v1* has no
organisation entity, which is true and unrelated.

## The classification — load-bearing vs decorative

Test used: **does removing the premise change the conclusion?** If a sentence merely *dates* or
*colours* a conclusion reached on other evidence, it is decorative and may simply become accurate.
If a conclusion was *derived from* the count, it is load-bearing and must be re-argued.

### Load-bearing — the conclusion was derived from the count (**11**)

| # | Where | The conclusion that rested on it | What happens to it |
|---|---|---|---|
| 1 | `ops/README:52` | tenancy: *"no second set of books to reach into"* | **Survives on a new basis** — Q2 |
| 2 | `ops/README:112` | *"no production read path has ever exercised its own RLS behaviour"* | **Re-grounded**: no *user* has, and a row now exists |
| 3 | `ops/README:429` + `:469` | *"BOTH WILL EXIT 1 TODAY — zero organisations"*; *"Both scripts treat zero organisations as a FAILURE"* | **Falsified twice over.** Wrong count of scripts (8, not 3) and wrong outcome (budget-reissue exited 0) — item 2 below |
| 4 | `REGISTER` DEF-250 | *"every scheduled job silently processes ZERO organisations and **reports success**"* | ⛔ **Wrong on the day it was filed**, independent of the org count — see below |
| 5 | `REGISTER` DEF-305 | *"the twelve-month clock has not started for any real org — cheap now and an outage later"* | ⛔ **The clock HAS started**, and now has a date |
| 6 | `REGISTER` DEF-307 | *"that loop has never executed against a real object: not rare, genuinely unexercised"* | **Conclusion survives on three new legs** — T-294 below |
| 7 | `REGISTER` DEF-312 | *"Harmless at today's scale … production holds zero organisations"* | **Survives, weakened**: the index drift is now against one real org's rows, still capped at 500 |
| 8 | `ROADMAP:730` | *"Swap the role without fixing that and every scheduled job silently processes ZERO organisations and reports success"* | Same error as DEF-250, propagated |
| 9 | `tasks/231:447` | *"the repo does not say which role production connects as"* — the two-column risk table | **Resolved by measurement.** It was `doadmin` / `rolbypassrls = t`; it is now `shareat_app_prod` / `= f` |
| 10 | `tasks/276:43` + `:258` | *"has anywhere already hit this? Production: no"* / *"not urgent today"* | **Re-dated, not reversed** — below |
| 11 | `tasks/294:68,69,72` | the *"do not build"* assessment | **Survives, re-argued** — below |

### Decorative — accurate or not, the conclusion stands on other evidence (**16**)

`REGISTER` DEF-195, DEF-288, DEF-311 (×3), DEF-326, the three 2026-09-12 cycle rows and the
2026-09-06 log row; `ops/README:120`, `:134`, `:236`, `:245`; `ROADMAP:715`; `tasks/228:34`;
`tasks/232:20`, `:715`.

⭐ **Two of these deserve calling out rather than lumping in:**

- ⛔ **`tasks/228:34`, `ops/README:134`, `REGISTER` DEF-195 and the 2026-09-06 log row are TRUE AS
  WRITTEN.** They are dated, evidenced claims about **2026-09-06**, sourced to
  `finding-observation` exiting 1 under a *bypassing* role — a real measurement, not an inference.
  Nothing in them is wrong. What was wrong was **quoting them forward as current** for six days.
  **These must not be "corrected."** Editing a true dated observation to say "one" would destroy
  the only fixed point the timeline has — it is what proves the organisation was created *after*
  2026-09-06.
- **`tasks/232:715`** — *"On an empty production database, the FIRST person who signs in becomes
  the owner … Any account in v1's Firebase project qualifies. So create the organisation yourself
  before the URL is shared, and the door closes for good the moment it exists."* This is a standing
  **security warning that is now extinguished**: the door has closed, exactly as written. It
  becomes a record of a risk that was closed, not a live instruction.

### Not this class (**7**) — false positives of the pattern

`REGISTER` DEF-312's *"no organisation predicate"* (a SQL predicate), `ROADMAP:713`,
`tasks/228:211` (a bootstrap invariant), `tasks/229:238`, `discovery/28:46`, `:445`,
`PROJECT_BIBLE.md:1502`.

> **Counts: 11 load-bearing · 16 decorative · 7 not-this-class**, over the measured 34 in the nine
> in-scope files. Plus **4 load-bearing out of scope**, **2 frozen in an applied migration**, and
> **2 in `HANDOFF-TODAY.md`**.

## ⛔ A defect of its own, found while classifying: DEF-250 was wrong when it was filed

DEF-250, `ROADMAP:730` and `tasks/251a:269` all assert that a tightened role would make scheduled
jobs *"silently process zero organisations and **report success**."* **All eight scheduled scripts
return exit 1 on an empty run** — `attendance-sweep:55`, `budget-reissue:65`,
`finding-observation:64`, `firestore-relay:74`, `month-end:67`, `order-wastage-backstop:68`,
`orphan-file-sweep:74`, `recurring-expense-draft:72`, each carrying the same comment.

Dated, not assumed: the guard landed in **`91397aa` (2026-09-06, T-214)**; DEF-250 was filed in
**`245c102` (2026-09-09)** — three days later. ⭐ And the disproof is already in this repository:
`ROADMAP:717` records the orchestrator *executing* it — *"exit 1 with no organisations, exit 0 with
one."* **The landmine was never silent. It is loud, and it always was.** This matters because it is
the sentence that made the role change read as a data risk when its failure direction was an
availability wall throughout.

---

# Q4 — shelf life: could a second organisation have appeared since 15:57 UTC?

**No — and not by luck. It is refused in code on every path, and the refusal fails in the safe
direction under both role configurations.**

| Path | Reachable without Ian? | What happens now |
|---|---|---|
| `/setup` in a browser | a stranger with any v1 Firebase identity could reach it **while zero orgs existed** (`tasks/232:715`) | `resolveVerifiedSignIn` (`apps/erp/src/app/sign-in/lib.ts:139`) now answers `not-linked`; the screen's own check (`setup/lib.ts:28`) agrees |
| `bootstrapOrganization` itself | both `/setup` and the CLI call it | takes `pg_advisory_xact_lock(232002)` **then** refuses: *"this system already has an organization, so first-run setup is closed"* (`packages/domain/src/organizations/index.ts:341-348`) |
| `npm run bootstrap-org` on the box | Ian only — no standing SSH for agents | same guard, plus its own pre-check at `:158` |
| any of the 9 timers | automatic | **none creates an organisation.** All enumerate via `listOrgsToRun`; `bootstrapOrganization` has exactly two callers repo-wide |
| a deploy landing new code | automatic on green CI | ⛔ **nothing has deployed since 2026-09-12 07:13 UTC** (DEF-327). The code on the box cannot have changed |

And if `SYSTEM_DATABASE_URL` ever went missing, `anyOrganizationExists` would read `false` on a
populated database — but the INSERT is then refused by `organizations_self_isolation`'s own
`WITH CHECK`. *A wrong sentence, never a second organisation.*

## ⭐ Recommended wording — and it is not "add a date", it is "name the guard"

A bare date makes every document look like it is quoting a perishable reading. The number is not
perishable; it is **pinned**. So the standard sentence I propose wherever a count is stated:

> **one organisation (`SHAREAT OPC`), measured 2026-09-12 15:57 UTC from
> `/var/log/shareat/budget-reissue.log`. First-run setup is closed by `bootstrapOrganization`'s
> own guard, so this number cannot rise without a deliberate act that the code currently refuses.**

Three parts, each earning its place: the **value**, the **provenance** (so a reader can re-check
it), and the **mechanism that pins it** (so a reader knows whether to re-check it at all).

⛔ **And the converse rule, which is the actual lesson of these six days:** a count with provenance
but no mechanism — *"zero organisations, confirmed 2026-09-06"* — was **never wrong**, and was
quoted as current by six documents for six days. The date did not stop that. **Naming the mechanism
is what stops it**, because a mechanism is a thing a reader can notice has changed.

## The one command that closes the remaining unknown

The creation time of SHAREAT OPC is not derivable from this repository, and it is the fact Q2's
"unprotected window" turns on. Two independent sources agree on the box, neither needing a schema
change:

```sh
# Needs the admin string — ops/README's own manual recipe shows how.
select id, name, created_at from organizations;
```

`organizations.created_at` is `notNull().defaultNow()`, and the primary key is **`uuidv7()`**,
whose leading 48 bits are the Unix-ms timestamp — so the row **carries its own creation time
twice**, and the two must agree. Cross-check without SQL at all:

```sh
journalctl -u shareat-finding-observation.service --since 2026-09-06 | grep -c "no orgs were processed"
```

⭐ **Run the second one first, because it tests a prediction rather than fetching a fact:**
`finding-observation` runs daily at 01:30 Manila and exits 1 when it sees no orgs. **The night it
stopped saying that is the night the organisation appeared** — and if it is *still* saying it
today, my whole reading of this lane is wrong and I want to know before nine documents are
rewritten.

---

# Scope

## Files I will create or modify

| File | What changes |
|---|---|
| `docs/tasks/300-zero-organisations-re-derivation.md` | this spec, then the record of what each assertion became |
| `docs/ops/README.md` | 8 assertions — the §2026-09-12 tenancy prose, the `count(*) → 0` row, the arming guidance at `:429`/`:469`, the `/setup` description at `:236`/`:245`. ⛔ **The 2026-09-06 section (`:120`, `:134`) stays as a true dated observation**, gaining only a forward-pointer |
| `docs/tasks/228-organization-bootstrap.md` | 1 — true as written; gains the bound on when the org appeared |
| `docs/tasks/231-tenancy-id-never-from-the-client.md` | 1 — the two-column risk table resolved by measurement |
| `docs/tasks/232-email-sign-in-and-first-run-setup.md` | 2 — the Goal's tense, and the extinguished first-person-wins warning |
| `docs/tasks/251a-system-transaction.md` | 1 — the "silently reports success" characterisation |
| `docs/tasks/276-def-305-fiscal-period-coverage.md` | 2 — the urgency re-dated against a real clock |
| `docs/tasks/294-def-307-bucket-reconciliation-assessment.md` | 3 — the assessment re-argued |

## Files I will NOT touch — prose handed to system32-85 instead

`docs/DEFECTS-REGISTER.md` (14 occurrences across 12 rows) · `docs/ROADMAP.html` (3).

## ⛔ Reported and stopped, per RULES §1 rule 14 and §3.4a

- **`PROJECT_BIBLE.md`** — I have read §13 row 194 and **found no amendment it needs for T-300.**
  Row 194's subject is the auth door's closed caller list; the organisation count is not
  load-bearing in it. `PROJECT_BIBLE.md:1502` matches the grep but is about permission naming, not
  a count. **No bible amendment requested.**
- **`packages/db/src/client.ts:167-170`** — `systemTransaction`'s docstring is stale on production.
- **`docs/discovery/29:526`, `docs/discovery/30:192`, `docs/tasks/239:400`, `docs/tasks/230:251`** —
  four load-bearing assertions outside my scope; `discovery/29` is the *cited source* for two
  assertions inside it.
- **`packages/db/migrations/0133_t230_sales_channel_admin.sql:30,59`** — frozen, unfixable.
- **`docs/HANDOFF-TODAY.md:10,81`** — forbidden to me; `:81` is the wrong arming guidance.
- **9 timer files in `docs/ops/` vs "8 armed" in DEF-326** — one timer is not on the box. One
  command settles it; not mine to run.

---

# Contract

1. **Re-derive, never patch.** No edit may consist of changing a number. Every load-bearing
   assertion gets its conclusion re-argued in place, with the old premise visible as superseded.
2. **A true dated observation is not corrected.** It is dated harder and given a forward-pointer.
3. **Every replacement count carries value + provenance + pinning mechanism** (Q4).
4. **Nothing is asserted about production that is not in a log line or a source file I have read.**
   Anything I could not check goes under "What I did not verify."
5. **Scope is the eight files above.** Anything outside is reported, never edited.

# Invariants

| # | Invariant | Citation |
|---|---|---|
| 1 | `count(*) from organizations = 1`, `SHAREAT OPC`, at 2026-09-12 15:57 UTC | Q1 |
| 2 | Production held **zero** organisations on 2026-09-06 evening | `ops/README:134`; `finding-observation` exit 1 under `doadmin` |
| 3 | DEF-311's storage finding rests on a measured `stored_files` = **0 rows**, not on an org count, and **does not move** | DEF-311; `ops/README` §storage bucket |
| 4 | All **8** scheduled scripts treat an empty run as failure (exit 1) — not 3 | the eight `outcomes.length === 0` sites |
| 5 | First-run setup is closed and cannot reopen while an organisation exists | `organizations/index.ts:341-348` |
| 6 | `organizations` is FORCE RLS, policy `id = app_current_org()`; no principal ⇒ zero rows | `0011:115-118`, `0011:38-41` |
| 7 | Nothing has deployed since 2026-09-12 07:13 UTC | DEF-327 |

---

# The three known-wrong items

## 1 · T-294's "do not build" — RE-ARGUED, and it SURVIVES

**Old argument (falsified):** *"`sweepOrphanedFiles` is per-org via `listOrgsToRun()`, and
production holds zero organisations … Zero orgs means the loop body that could ever call
`driver.remove` against a real object has never executed once in production."*

The premise is false. The **conclusion is unchanged**, and now rests on three independent legs, two
of them measurements rather than inferences:

1. ⭐ **The job cannot start at all.** `/var/log/shareat/orphan-file-sweep.log` reads
   `npm error Missing script: "orphan-file-sweep"` (DEF-326) — the deployed tree predates
   `55fc4bd`, the commit that added that script. Execution stops before any TypeScript runs, so
   `listOrgsToRun` is never reached. **Measured.**
2. ⭐ **`stored_files` held ZERO rows** when the bucket was switched on 2026-09-12 — checked before
   anything changed, by a script written to abort otherwise (DEF-311). Even on a working deploy,
   `listOrphans` would return nothing and `driver.remove` would not be called. **Measured, and it
   never depended on the organisation count** — this is the leg that makes the conclusion robust.
3. **It cannot become false soon.** Two independent blockers stand between today and a first real
   sweep: DEF-327 (the migrate step is refused) and DEF-325 (CI red ⇒ Deploy `skipped`).

**Therefore: do not build bucket enumeration. Unchanged, and now better evidenced.** T-294's cost
section never referenced the org count and needs no revision.

⛔ **But one thing DOES change, and it is the part T-294 got structurally wrong:**

> T-294's reopening trigger is *"the first time a real organisation's `orphan_file_sweep` run shows
> a non-empty `failures` array."* **That trigger cannot fire today**, because the job cannot run —
> and a trigger that cannot fire is not a deferral, it is a forget. The old text said *"nothing
> needs to be built to make that trigger visible"*, which was true on the zero-org premise and is
> false now.

**Replacement trigger, in two stages:** *(a) the arming precondition — `orphan_file_sweep` produces
a `scheduler_runs` row at all, which requires DEF-326/DEF-327 cleared; until then the trigger is
**inert and known to be inert**; (b) then the original trigger, unchanged.* Stage (a) is observable
with the same `journalctl` that found DEF-326.

## 2 · The arming guidance — the correct expectation, per unit

The guidance said **three units failing nightly**, on the zero-org premise. It is wrong four ways,
and only one of them is the premise.

| Wrong how | The fact |
|---|---|
| **wrong script count** | *"`orphan-file-sweep`, `budget-reissue`, `finding-observation`, all three"* — **all 8** scheduled scripts carry that guard |
| **wrong cadence** | `attendance-sweep` is **hourly** and `firestore-relay` is **every 2 minutes**. On the zero-org premise those two alone would have produced ~744 failures a day, not "nightly" |
| **wrong for month-end** | `month-end` fires **monthly, on the 15th** (`*-*-15 02:00 Asia/Manila`), plus a retry at 03:00. Never nightly |
| **wrong premise** | there is one organisation, so the zero-org branch is not taken at all |

**The correct expectation, on the true figure and against the *deployed* artifact** — which
predates `55fc4bd` and is therefore not what this repo's `main` contains:

| Unit | Fires | Expected | Why |
|---|---|---|---|
| `shareat-finding-observation` | daily 01:30 Manila | ✅ **exit 0** | 1 org ⇒ the empty-run branch is not taken. ⭐ **Its nightly failure should have STOPPED on the first run after the org appeared** — the prediction to check first |
| `shareat-recurring-expense-draft` | daily 02:00 | ✅ exit 0 | nothing due ⇒ `posted 0`, which is success |
| `shareat-order-wastage-backstop` | daily 02:30 | ✅ exit 0 | as above |
| `shareat-orphan-file-sweep` | daily 03:00 | ⛔ **exit 1 — the only expected failure** | `Missing script` (DEF-326). **Not an organisation problem.** Persists until a deploy lands |
| `shareat-budget-reissue` | daily 03:30 | ✅ **exit 0 — measured** | `ok — created 0 · 1 orgs` |
| `shareat-attendance-sweep` | **hourly** | ✅ exit 0 | |
| `shareat-firestore-relay` | **every 2 min** | ✅ exit 0 | |
| `shareat-month-end` (+ `-retry`) | **15th, 02:00 / 03:00** | ✅ exit 0 | next fire 2026-09-15 |

> **ONE unit should be failing, not three — `shareat-orphan-file-sweep` — and the reason has
> nothing to do with organisations.** Everything else should have gone quiet. ⚠️ If any other unit
> is still failing, it is a **new, unexplained** fault and not the expected noise — which is
> exactly the distinction the old guidance made impossible to draw.

⚠️ **Env caveat, stated because it is the one thing that could invalidate this table:** all eight
units share `WorkingDirectory=/srv/shareat`, `User=shareat` and no `EnvironmentFile`, so they
resolve the same `.env.local` and therefore the same `SYSTEM_DATABASE_URL`. budget-reissue's exit 0
proves that resolution works there; I infer the other seven from identical unit configuration and
have not read their logs.

## 3 · The tenancy reassurance — see Q2

Both `ops/README:52` and the DEF-210 quotation are re-derived per Q2: conclusion kept, reason
replaced, three concealed items surfaced, and the "silent landmine" characterisation corrected to
"loud" per Q3 / DEF-250.

## ⭐ A fourth, not in the briefing: DEF-305's twelve-month clock has started

`REGISTER` DEF-305 and `tasks/276` both defer on *"production has zero organisations today, so the
twelve-month clock has not started for any real org — this is cheap now and an outage later."*

`bootstrapOrganization` seeds **12 consecutive calendar months from the org's current business
month** (`fiscalPeriodSeedWindow`, `packages/domain/src/organizations/index.ts:95-117`,
`months: 12`). SHAREAT OPC was created in business month **2026-09**, so its `fiscal_periods` cover
**2026-09 → 2027-08**, and the first uncovered date is **2027-09-01 (Asia/Manila)**.

**The deferral survives — it is still not urgent — but it is no longer open-ended.** The
recommendation becomes: *build the coverage job before 2027-09-01*, with ~11½ months of runway from
today. ⭐ That is exactly the *"cheap now, outage later"* the row predicted, with the "later" now
filled in — a date rather than a feeling, which is what the deferral was missing.

---

# Out of scope

Fixing DEF-326 or DEF-327 · anything under `.github/` (lane A) ·
`packages/domain/tests/integration/position-defaults.test.ts` (lane B) · any source file · any
migration · `PROJECT_BIBLE.md` · `docs/HANDOFF-TODAY.md` · any git write · any build, dev server or
browser · anything touching `159.223.46.224`.

# Done when

1. All 8 in-scope files edited; all 11 load-bearing conclusions re-argued in place, none patched.
2. Every count carries value + provenance + pinning mechanism.
3. The four true dated 2026-09-06 observations are intact and forward-pointed.
4. Replacement prose delivered to system32-85 for the register (12 rows) and ROADMAP (3).
5. The out-of-scope reports delivered: `client.ts`, `discovery/29`, `discovery/30`, `tasks/239`,
   `tasks/230` + migration `0133`, `HANDOFF-TODAY.md`, the 9-vs-8 timer count.
6. Bible: **no amendment requested**, stated explicitly.

# ⚠️ What I did not verify, and cannot from this lane

- **Anything on the box.** No production access, and forbidden. Every production fact here is read
  from a log line quoted in DEF-326/DEF-327 or from `docs/ops/README.md`, never observed by me.
- **When SHAREAT OPC was created** — bounded only to (2026-09-06 evening, 2026-09-12 15:57 UTC].
  Two commands close it (Q4); neither is mine to run.
- **Whether the other seven units are currently exiting 0.** Predicted from source and unit files;
  no log read. ⛔ This is the single prediction that, if wrong, invalidates item 2's table.
- **`rolbypassrls` on `doadmin` as of the 15:57 run** — taken from `ops/README`'s own measurement
  table. My Q1 proof does not depend on it.
- **No test, typecheck or build was run.** This lane changes only Markdown; none is meaningful here.

# T-261 — DEF-274: the hit counter reaches zero money screens

> **Status: RESERVED by the orchestrator, 2026-09-10.** Number reserved so no peer takes it.
> Nothing built. ⭐ **THIS TASK OPENS WITH A DECISION, NOT WITH CODE.** DEF-274 is filed as
> mechanical wiring. The orchestrator measured it and it is not — there is a real architectural
> fork with a hard boundary on one side of it, and picking the wrong arm buys ~175 hand-copied
> call sites of exactly the shape T-255 just spent a day deleting. **Decide first, in writing,
> then build.**

## Why this matters, in one paragraph

Bible §13 row 189 is **Ian's decision**, and it defers its next decision to *measured hit counts*:
sanitise the fallback first, then "let measured hit counts decide which constraints earn a
hand-written sentence". The counter is wired into payroll and settings only. **Zero money screens.
Zero of DEF-246's four named examples.** Left alone, the first hit report will say the money screens
are quiet — and DEF-272 has just proved the opposite, that a sub-centavo amount reaches the CHECK
constraint on cash requests, loans, AP payments and money transfers today.

⛔ **A measurement that is blind where the risk is does not merely under-report — it actively
misleads the decision it exists to inform.** That is the whole defect.

## What the orchestrator measured — correcting the row

DEF-274 says "19 call sites across 8 files" and "~100 catch blocks". Counted mechanically on the
settled tree at `3243fef`:

| Measurement | Value |
|---|---|
| `recordIfUnmappedConstraint(` call sites in `apps/erp/src` | **17**, not 19 |
| Files containing them | 8 — payroll ×3, settings ×5 |
| `errorMessage(` call sites in `apps/erp/src/app` | **192** |
| Files calling `errorMessage` | 53 |
| Files calling `errorMessage` with **no** counter at all | **45** |

⚠️ **So the uncounted population is ~175 call sites, not ~100.** The row's estimate is low by
roughly 75%, which is precisely the input that decides whether hand-wiring is sane.

⚠️ ⛔ **Treat these numbers as MY hypothesis, exactly as I am asking you to treat the register's.**
They came from `grep -c` over `apps/erp/src/app`. Re-derive them before you rely on them — and if
you get a different number, that discrepancy is a finding worth more than the tidy answer. This
project has had a count come back plausible-and-wrong four separate times.

## The fork

### Arm A — wire the ~175 catch blocks by hand

This is what T-252 designed for. `apps/erp/src/lib/constraint-messages.ts` says it explicitly:
*"`errorMessage` stays synchronous and pure; this is the separate, explicitly-invoked entry point a
caller with an `orgId` in scope threads in."*

- ✅ Crosses no boundary. Keeps `actorPersonId` and `storeId`, which the counter's context takes.
- ✅ Every action already has `const actor = await requireActor()` at the top, so `actor.orgId` and
  `actor.personId` **are** in scope in the catch block.
- ⛔ ~175 hand-copied call sites. **DEF-273 is already the register row proving this exact
  population drifts** — payroll's `lib.ts` files hand-copied a sanitising strip while their sibling
  `actions.ts` files imported the shared one. The domain best covered was the domain hiding the copies.
- ⚠️ `storeId` is frequently declared **inside** the `try`, so it is out of scope in the `catch`.
  That is per-site surgery, not a sweep.

### Arm B — record at the chokepoint

`withOrgPrincipal` is defined **once** (`packages/db/src/rls/principal.ts:111`) and imported by
**99 files** in `apps/erp/src`. It takes `orgId` as its first argument and it is the transaction the
constraint refusal actually aborts.

- ✅ One change covers every screen, and cannot drift.
- ⛔ **RULES rule 13 blocks the naive version.** `CONSTRAINT_MESSAGES` lives in
  `apps/erp/src/lib/constraint-messages.ts`. `packages/db` may never import from an app — packages
  never depend on apps, enforced by `tests/unit/app-boundaries.test.ts`. So a recorder at that layer
  **cannot answer "is this constraint mapped?"**
- ⛔ **RECURSION TRAP, and it is not hypothetical.** `recordConstraintRefusal`
  (`packages/domain/src/shared/constraint-refusals.ts`) calls `withOrgPrincipal` itself, by design —
  that independent transaction is the thing that makes the write survive the caller's rollback, and
  bible row 189 calls it out by name as "the shape that works". Recording inside `withOrgPrincipal`
  therefore re-enters itself. Guardable, but it must be **guarded deliberately and proved**, not
  assumed away.
- ⚠️ Loses `actorPersonId` and `storeId` unless they are threaded to that layer some other way.

### Arm C — record every constraint refusal, filter at reporting time

The "is it mapped?" question is only asked to decide whether to *record*. It does not have to be.
Record the constraint name unconditionally; decide mapped-vs-unmapped when the report is read.

- ⭐ **This arm would MEASURE something row 189 currently only asserts.** Row 189 records lane C's
  finding that `CONSTRAINT_MESSAGES` "may be substantially dead code" — every mapped constraint it
  traced was guarded by a TypeScript check that fires first, and a deliberate two-tab concurrency
  test never got the mapped sentence to fire. **Recording mapped hits too turns that hypothesis into
  a number**, and it is the same number Ian's next decision needs.
- ⚠️ Changes what the stored rows mean. Anything already reading them must be checked.
- ⚠️ Volume, retention, and whether a mapped hit is even interesting are open questions — answer
  them, do not skip them.

## What you must produce, in this order

1. **Re-derive the measurements above** and say where you agree and disagree with me.
2. **A written recommendation naming ONE arm**, with the reasoning, the cost, and — required —
   **what would have to be true for you to be wrong.** A recommendation with no failure condition
   is an opinion.
3. ⛔ **Then STOP and send it to me as `SPEC`.** Do not implement. I decide, and where it touches
   Ian's row 189 he decides.

⭐ **A third way is explicitly permitted and has paid off twice this week.** T-255's lane found a
fourth option nobody listed and was right; T-259's lane found the spec itself was defective. If none
of A/B/C is correct, say so and say what is.

## Watch out

- ⛔ **`errorMessage` is called from 48 action files and is SYNCHRONOUS AND PURE ON PURPOSE.**
  Making it async to fold the counter in would touch every one of those 192 call sites and change
  a shipped design decision. If you propose it, propose it explicitly with that cost stated — do
  not slide it in.
- ⚠️ **A promoted sentence widens a security allowlist.** `apps/erp/src/lib/pre-session-message.ts:137`
  builds `WRITTEN_FOR_A_PERSON` from `CONSTRAINT_MESSAGES`, which gates what may appear in the URL
  of the **unauthenticated** `/setup` page. Anything you propose that changes what is in
  `CONSTRAINT_MESSAGES` must say what it does to that allowlist. This is the trap that stopped
  DEF-273 from being folded into T-255.
- ⚠️ The counter must not swallow the original error or change what the person sees. The refusal is
  the product; the count is a side effect.
- ⚠️ **A write inside the aborting transaction records nothing, for ever, with nothing red.** That
  is T-245's original bug and the reason `recordConstraintRefusal` takes no `tx`. Any arm you
  recommend must preserve that property, and you must say how you know it does.
- ⚠️ Three files in this tree use CRLF (`attendance/lane/actions.ts`, `inventory/usage/actions.ts`,
  `statutory-discounts/actions.ts`) — a sweep matching on a line ending silently skips them.

## Out of scope

- **DEF-273** (two constraints carry two different live sentences). Explicitly sequenced *after*
  this, so the wording choice is informed by whether either sentence ever fires. Do not merge
  sentences here.
- **DEF-272 / T-260** — lane E is editing the money **domain** layer right now. You are in the
  **app** layer. Do not touch `packages/domain/src/**` money guards, and tell me if you need to.
- Amending the bible. Row 189 is **Ian's**, and DEF-275 already proposes narrowing one of its
  clauses. Report and stop (RULES rule 14).

## Done when — for THIS phase

- The measurements are re-derived and agreed or disputed with numbers.
- One arm is recommended in writing, with its cost and its falsifier.
- ⛔ Nothing is implemented, and the report ends with a `FOR IAN` block in plain language.

See `docs/DEFECTS-REGISTER.md` DEF-274, DEF-273, DEF-272, and `PROJECT_BIBLE.md` §13 row 189.

---

## Phase 1 — the lane's analysis

> Written 2026-09-10 by lane C (Opus 5). **Nothing above this line was changed**; where this
> section disputes the spec it quotes what it is disputing. No application code was touched and no
> git command was run, read-only ones included — the orchestrator supplied the `3243fef..092eb40`
> delta this lane could not obtain: **zero files changed under `apps/`**, 28 under
> `packages/domain/**`, all T-260. Every number below is therefore directly comparable to the
> spec's. Tree at time of writing: `580fdb3` (docs only — bible row 192, the register, the roadmap,
> T-262's spec).
>
> ⛔ **Scope discipline, because this population has two defensible answers.** Unless a row says
> otherwise, every count below is over **`apps/erp/src/app`**, the scope the spec's own numbers
> used. Over the wider `apps/erp/src` the same counts read 195 occurrences / 20 definitions / 175
> call sites — the extra definition being the canonical one in `src/lib/constraint-messages.ts`.
> The spec quoted one scope while implying the other; this section names its scope on every row.

### §1 — Re-derived measurements

Counted by **occurrence** (`grep -o`), never by line, with definitions separated from calls. That
distinction is not pedantry: it is the exact failure DEF-278's remedy records — *"a naive line-wise
grep of the same tree returned '4 of 18', a plausible and wrong answer the orchestrator caught only
by re-measuring."*

| # | Measurement (scope `apps/erp/src/app` unless stated) | Spec / register | Re-derived | Verdict |
|---|---|---|---|---|
| 1 | `recordIfUnmappedConstraint(` call sites, scope `apps/erp/src` | **17** (spec) / 19 (DEF-274) | **17** (18 occurrences − 1 definition at `lib/constraint-messages.ts:131`) | ✅ **spec confirmed; the register's 19 is wrong** |
| 2 | Files holding them | 8 — payroll ×3, settings ×5 | **8**, the same eight | ✅ confirmed |
| 3 | `errorMessage(` occurrences | **192** | **192** | ✅ the occurrence count is right |
| 4 | …of which are `function errorMessage(` **definitions** | not separated | **19** | ⛔ **so 192 are not call sites** |
| 5 | True `errorMessage(` call sites | — | **173** | corrected |
| 6 | Second translator name `errorMessageOf` — definitions / calls | not mentioned | **2 / 7** (9 occurrences, 4 files) | ⛔ **absent from the spec** |
| 7 | **Total translator call sites, both names** | ~192 | **180** | corrected |
| 8 | Files "calling `errorMessage`" | **53** | 53 *mention* a translator; **52** call one | ⚠️ 53 is a mention count |
| 9 | Files with a translator call and **no** counter | **45** | **44** | corrected |
| 10 | **Uncounted translator call sites** | **~175** | **163** | ⛔ **the headline number — derived, not adopted; see §1.2** |
| 11 | `catch (` blocks | ~100 (DEF-274) | **194** across 60 files | ⛔ register wrong by ~2× |
| 12 | CRLF files | 3 | **23** here, **26** over `apps/erp/src` | ⚠️ warning pointed the right way, undercounted the hazard ~8× |
| 13 | `withOrgPrincipal` definitions | once, `packages/db/src/rls/principal.ts:111` | **once**, that line | ✅ confirmed |
| 14 | Files referencing it, scope `apps/erp/src` | **99** | **117** | corrected |
| 15 | `withOrgPrincipal(` call sites, scope `apps/erp/src` | — | **364** | new |
| 16 | App files importing it from `@shareat/db` **directly** | — | **2** | new — **the decisive number, F5** |
| 17 | Keys in the shared `CONSTRAINT_MESSAGES` | 21 (bible row 189) | **26** | row 189 stale by 5 |
| 18 | Named CHECK constraints in `packages/db/migrations` | 442 (bible row 189) | **310 distinct** (315 declarations) | ⚠️ not reproducible — §1.3 |

**§1.1 — How the spec's numbers were built, and why one of them misleads.** Each is reproducible
once the recipe is known: `53` is *files mentioning the identifier*, `45` is `53 − 8`, and `~175`
is `192 − 17`. The last subtracts a **call-site** count of one symbol from an **occurrence** count
of another. Both errors push the same way and the spec leans on the result: *"the uncounted
population is ~175 call sites, not ~100. The row's estimate is low by roughly 75%, which is
precisely the input that decides whether hand-wiring is sane."* The **direction** survives and the
conclusion drawn from it survives; the magnitude does not. Against the register's ~100, the true
163 is low by ~63%, not 75%.

**§1.2 — 163 is derived, and the assumption the orchestrator flagged is now checked.** The
subtraction `180 − 17` is only valid if every counter call sits alongside a translator call in the
same file, so that removing the counted sites removes exactly 17 translator sites. **Verified
per-file, not assumed:**

| File | translator calls | counter calls |
|---|---|---|
| `payroll/actions.ts` | 3 | 3 |
| `payroll/separations/actions.ts` | 2 | 2 |
| `payroll/thirteenth-month/actions.ts` | 2 | 2 |
| `settings/attendance/actions.ts` | 1 | 1 |
| `settings/expense-categories/actions.ts` | 4 | 4 |
| `settings/organization/actions.ts` | 1 | 1 |
| `settings/sales-channels/actions.ts` | 3 | 3 |
| `settings/wastage-monitor/actions.ts` | 1 | 1 |
| **total** | **17** | **17** |

Exact 1:1, file by file. The established wiring convention is *one counter call per translator call
site*, so **180 − 17 = 163** uncounted translator call sites across **44** files. ⚠️ **163 is a
floor, not a ceiling** — findings F2 and F3 add call sites and whole screens that a translator-keyed
count cannot see at all.

**§1.3 — Row 189's "442" is not reproducible, and I did not force it.** Migration source yields 310
distinct named CHECK constraints; `check (` appears 597 times. The authoritative figure is
`pg_constraint where contype = 'c'` on a live database, which I did not query — the only database
available to this lane is shared and nothing in this phase needs it. ⚠️ **A likely explanation,
worth one command before the number is quoted at Ian again:**
`information_schema.check_constraints` reports every `NOT NULL` as a check constraint and inflates
a count exactly this way. If that is the provenance, the mapped fraction is 26/310 ≈ **8.4%**, not
21/442 ≈ 4.8% — still small, but the denominator is doing unearned work in the argument for
"finish the map".

**§1.4 — Bible row 192 (ratified today) is live input and it moves the ground under the spec.**
Row 192 narrows row 189's *"which is exactly where there is frequently no TS guard either"* and
records that T-260 has routed all four of DEF-246's named examples through `parseMoneyInput()`, so
**"the expected hit count on precisely DEF-246's four named examples is now approximately zero, and
a counting programme aimed at them would have measured a silence it had itself created."** The
spec's motivating sentence — *"DEF-272 has just proved the opposite, that a sub-centavo amount
reaches the CHECK constraint on cash requests, loans, AP payments and money transfers today"* — is
therefore **stale and must not be quoted at Ian in the present tense**; DEF-272 reads `fixed`. The
surviving argument is carried by **DEF-277** (four sites deliberately not fixed) and **DEF-278**
(nine money inputs carry `min="0"`, so the browser does not object either).

⭐ **This strengthens the task and it changes the arithmetic of the decision.** Row 192's own words:
a hit is now *"RARER AND MORE INFORMATIVE, not less."* A programme whose signal is rare and precious
should buy the **widest** coverage for the **least** cost — and should be especially unwilling to
spend 163 hand edits aimed at a population whose four flagship members have just gone quiet. It
also raises the price of F1 sharply: 8 phantom hits are noise against a large signal and a
catastrophe against a rare one.

### §2 — Findings the spec does not contain

**F1 ⛔ — Wiring the counter into the money screens as specified will record eight already-mapped
constraints as UNMAPPED, and both affected screens are money screens.**
`recordIfUnmappedConstraint` decides mapped-ness with `if (!constraintName || constraintName in
CONSTRAINT_MESSAGES) return;` (`constraint-messages.ts:137`) — the **shared** map only. But
`till/actions.ts` and `remittance/actions.ts` each keep a local map the shared module cannot see,
holding 8 names between them, **disjoint** from the shared 26:

- till (5): `till_custody_shifts_one_open_per_store`, `till_custody_shifts_prev_unique`,
  `till_custody_shifts_store_date_no_unique`, `till_count_lines_shift_moment_account_unique`,
  `till_count_lines_counted_nonnegative_check`
- remittance (3): `stores_pooling_requires_ceiling_check`,
  `stores_unremitted_ceiling_positive_check`, `stores_remittance_cadence_check`

Cash custody and cash remittance are as close to "the money screens" as this app gets. Worse, the
two remittance CHECKs are **DEF-273's two constraints** — and DEF-273 is sequenced after this task
so its wording choice can be *"informed by whether either sentence ever fires."* It would instead be
informed by a count that fires **because** the sentence exists. ⚠️ **This is the same
measurement-integrity defect DEF-274 itself is about, pointing the other way**: DEF-274 says a
measurement blind where the risk is misleads the decision it informs; this one manufactures signal
where there is none. Against row 192's now-rare hit rate, 8 phantom constraints could plausibly
top the first ranked report.

**F2 ⚠️ — The population has a second name, and a guard already committed to this repo knew it
while the spec did not.** `errorMessageOf` — `commissary/orders/lib.ts:45` (exported) and
`wastage/actions.ts:57` (module-private) — **7 call sites across 3 files**
(`commissary/orders/actions.ts`, `commissary/orders/[id]/actions.ts`, `wastage/actions.ts`). A
name-keyed sweep skips them in silence.
⭐ **The part worth recording:** `local-errormessage-convergence.test.ts` already matches
`function\s+errorMessage(?:Of)?`, and its own header explains why — *"Shape, not spelling — DEF-243's
lesson … A spelling-based guard would have shipped that hole."* **A guard committed to this
repository knew about the second name, and the spec written to warn this lane about exactly that
hazard did not.** That is DEF-243's shape-not-spelling lesson landing for the fifth time, on the
document warning against it. **Candidate register row in its own right.**

**F3 ⛔ — Four action files have no `catch` at all, and Arm A cannot reach them by construction.**
`inventory/low-stock/actions.ts` (1 server action), `inventory/returns/actions.ts` (3),
`inventory/transfers/actions.ts` (4), `trade/returns/actions.ts` (3) — **11 server actions, zero
`try`, zero `catch`, zero translator calls.** All four are documented as *"Thin adapters: parse
`FormData`, call the domain, revalidate."* A constraint refusal on stock transfers, supplier returns
or customer returns therefore does not render driver text — it renders the Next.js error boundary —
and it is invisible to every per-call-site arm, because there is no call site to wire. Three of the
four are also CRLF. ⭐ **Logged under bible §13 row 164 though it is not this lane's task**: whether
an unhandled throw from a server action is intended on four stock screens needs a decision.
**Recommend the orchestrator file a register row; this lane did not (RULES rule 14 / scope).**

**F4 ⛔ — A recorder placed INSIDE the transaction misses deferred violations, and that is T-245's
bug wearing a different hat. ⚠️ CORRECTED 2026-09-10 BY THIS LANE — my first two numbers here were
comment-inflated and my claim was too wide. Both corrections are recorded rather than silently
edited, because the orchestrator verified this finding before I caught it.**

`packages/db/src/client.ts:82`'s own doc states the mechanism: *"Accounting invariants — balanced
entries, minimum two lines, closed-period rejection — are enforced by DEFERRED constraint triggers,
so they fire at COMMIT."* That much stands. The counts and the scope of the consequence do not.

- ⛔ **Correction 1 — the counts.** I first reported **14 `DEFERRABLE` / 9 `INITIALLY DEFERRED`**
  from a raw `grep` over `packages/db/migrations/*.sql`. **Eight of those 14 lines are SQL
  comments**, several of them explaining that Postgres *forbids*
  `DEFERRABLE CHECK`. Excluding comment lines the real DDL is **6 `DEFERRABLE INITIALLY DEFERRED`
  declarations**: five `CREATE CONSTRAINT TRIGGER` (`journal_entries_balance_check`,
  `journal_lines_balance_check`, `stock_movements_no_negative_on_hand_trg`,
  `stock_layer_consumptions_ties_trg`, `order_wastage_allocations_sum_100_trg`) and **one deferrable
  self-referencing FOREIGN KEY** — `attendance_adjustments.superseded_by_adjustment_id`,
  `0084_t158_attendance_adjustments.sql:38-39`. The eight comment lines are `0003` ×4 (7, 8, 10,
  97), `0063` ×1 (135), `0084` ×2 (32, 33) and `0126` ×1 (78). The orchestrator's independent 12/8
  is comment-inflated the same way; the settled figure is **6**. ⚠️ **The lesson is the one this
  document is otherwise about**: I counted occurrences rather than declarations, which is a
  different shape of the same error I corrected in the spec's `192`.
  ⛔ **Two further corrections to this bullet itself, both mine, both recorded rather than
  overwritten.** (i) I first called it a deferrable **UNIQUE**. It is a **FOREIGN KEY**; there is no
  deferrable unique here at all — `attendance_adjustments_live_unique` is a *plain, non-deferrable*
  partial unique index, and lines 32–37 explain that the FK is deferred *because* that index is
  not: the old row must be stamped superseded before the new row it points at exists.
  (ii) I first cited the line as `:21`, which is the line number **within my comment-stripped
  stream**, not within the file — an artefact of the very filter I had just applied to fix
  correction 1. Every line citation in this bullet is now against the real file.
- ⛔ **Correction 2, and it is the substantive one — the accounting-invariant class is uncountable
  by EVERY arm, not just by a badly-placed one.** All five constraint triggers raise with a bare
  `RAISE EXCEPTION 'journal entry % is unbalanced: debits % <> credits %'` and its siblings —
  **not one uses `USING CONSTRAINT = …`**, so none of them emits the `constraint "name"` text
  `parseConstraintName` requires. `recordIfUnmappedConstraint` therefore no-ops on all five
  regardless of where the recorder sits. My original sentence — *"would record nothing for the
  entire accounting-invariant class"* — implied Arm A or a well-placed recorder would capture it.
  **They would not.** That class is invisible to Arm A, B, C and D alike.

**What survives, and it still favours placing the recorder outside the transaction.** Exactly one
deferred object is both raised at COMMIT *and* parseable: the deferrable self-referencing **FK** on
`attendance_adjustments.superseded_by_adjustment_id`, which emits `insert or update on table "…"
violates foreign key constraint "…"` at COMMIT — a shape `parseConstraintName` matches, since its
regex keys on `constraint "name"` and not on the violation kind (the module's own T-230 comment
already relies on that parity for unique indexes). A recorder inside `withOrgPrincipal`'s callback
misses it and every future `DEFERRABLE` FK, unique or exclusion constraint, silently. That is one
constraint today rather than a
whole class — a narrower advantage than I first claimed, and still a real one, because the failure
mode is silent and the cost of avoiding it is zero: the wrapper sits outside the transaction either
way. **The recursion trap and the rule-13 boundary remain the load-bearing arguments against Arm B;
F4 is now a supporting one.**

⭐ **Two things worth carrying out of this correction.** First, it settles what was falsifier 3 in
§4 — see the note there. Second, it is a finding in its own right: **the counter is structurally
blind to the five accounting invariants**, which is precisely the population row 189's "double
signal" rule cares most about (a hit means nothing above refused first). Making them countable
means adding `USING CONSTRAINT = '<name>'` to five `RAISE EXCEPTION` statements in new migrations —
cheap, but it is a schema change, out of this lane's scope, and it belongs to whoever owns the
follow-up rather than to T-261. **Recommend the orchestrator log it.**

**F5 ⭐ — 115 of the 117 importer files funnel through ONE app-layer line.** Every reference to
`withOrgPrincipal` in `apps/erp/src` resolves to the single definition at
`packages/db/src/rls/principal.ts:111`, and the import graph has exactly **two** roots:

| Import source | Files |
|---|---|
| `./lib`, `../lib`, `../expenses/lib`, `../../expenses/lib`, `../../../expenses/lib` — all re-export chains rooted at `expenses/lib` | **115** |
| `@shareat/db` **directly** | **2** — `app/expenses/lib.ts` (6 call sites; the root itself) and `app/admin/prerequisite-refusals/lib.ts` (1 call site) |

`apps/erp/src/app/expenses/lib.ts:148` — `export { withOrgPrincipal } from '@shareat/db';` — is one
app-layer line through which **363 of 364** call sites pass. The one that does not is the read-only
query behind the refusals *reporting* screen: the single site you would exclude deliberately anyway.

**F6 ✅ — every call site passes the actor's own org.** All 364 pass either `actor.orgId` (212) or a
variable named `orgId` (152). No literal, no cross-org value, no system org. A recorder at this
layer cannot file a row under the wrong tenant.

**F7 ⚠️ — the pre-session paths are uncountable under every arm, and that is a boundary, not a
gap.** The 8 bare `transaction(` sites in `apps/erp/src` are all `setup`, `sign-in`, `session` and
the sign-in page — paths where no `orgId` exists yet, so no org-scoped refusal row can be written by
any arm. `pre-session-message.ts` is the mechanism that already covers them.

**F8 ⚠️ — the domain's `if (tx) return run(tx); return transaction(run);` fallback is not a live
bypass, but this is the weakest link in my reasoning.** ~170 domain functions carry it. From the app
every call supplies `tx` from `withOrgPrincipal`; the bare fallback opens a transaction with no
principal, which under RLS *"sees zero org-scoped rows"* (`principal.ts` doc, migration 0011 lines
20–24), so it is a test/script affordance rather than a production write path. **I inferred this
from source and did not execute it.** See falsifier 1.

### §3 — Recommendation: none of A, B or C as written. **Arm D — wrap the app-side chokepoint.**

> Taken up on the spec's own invitation: *"A third way is explicitly permitted and has paid off
> twice this week … If none of A/B/C is correct, say so and say what is."*

**In one sentence:** replace the re-export at `apps/erp/src/app/expenses/lib.ts:148` with a thin
`async` wrapper that awaits `withOrgPrincipal`, and on a thrown constraint refusal awaits
`recordIfUnmappedConstraint` **after** the transaction has settled, then rethrows the error
unchanged.

```ts
// apps/erp/src/app/expenses/lib.ts — replaces the bare re-export on line 148
export async function withOrgPrincipal<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await dbWithOrgPrincipal(orgId, fn);  // awaited: COMMIT has happened, or failed
  } catch (err) {
    await recordIfUnmappedConstraint(err, { orgId, storeId: null, actorPersonId: null });
    throw err;                                   // the refusal is the product; the count is a side effect
  }
}
```

**Why this and not the three arms as written**

| | A — 163 hand edits | B — inside `packages/db` | C — record everything | **D — app-side wrapper** |
|---|---|---|---|---|
| Crosses RULES rule 13 | no | **yes, fatally** | no | **no — it is app code; `CONSTRAINT_MESSAGES` is a legal import** |
| Recursion trap | none | **real** (`recordConstraintRefusal` → `withOrgPrincipal`) | n/a | **none by construction** — the recorder imports `withOrgPrincipal` from `@shareat/db`, and a package can never import an app, so it cannot re-enter this wrapper |
| Misses deferred constraints (F4) | no | **yes, in its obvious shape** | depends where it sits | **no — the `await` has already passed COMMIT** |
| Reaches the 11 catch-less server actions (F3) | **no, by construction** | yes | yes | **yes** |
| Reaches the 7 `errorMessageOf` sites (F2) | only if the sweep knows the second name | yes | yes | **yes — name-independent** |
| CRLF hazard (23 files) | **real — it is a sweep** | none | none | **none — one file, edited by hand** |
| Drifts as screens are added | **yes — DEF-273 is the register row proving this exact population drifts** | no | no | **no, and a guard asserts it (§3.5)** |
| Files changed | **44** | 2 packages + a layering change | ~3 | **3 source + 2 test** |
| Net app code | **+163 call sites** | — | — | **−17 call sites, −8 imports, +~15 lines** |

Arm B is right about *where* and wrong about *which layer*. The chokepoint it names is real; it just
sits one import below the boundary that makes the mapped-check legal. **Moving the same idea up one
layer — to the app's own root re-export — keeps every advantage and pays none of the three costs the
spec correctly identifies against it.** It also inverts the sign of the change: Arm A adds 163 call
sites of the shape T-255 spent a day deleting; Arm D **deletes 17 of them**.

**§3.1 — How I know it preserves "never write inside the aborting transaction".** Three independent
reasons, strongest first.

1. **By construction, one layer up.** The `catch` is reached only after
   `await dbWithOrgPrincipal(...)` has *settled*. `withOrgPrincipal` → `transaction()` →
   `getDb().transaction(fn)`, whose promise rejects only once the transaction has already rolled
   back. There is no open transaction in scope in that `catch` — **there is no `tx` binding in it at
   all**, so there is nothing a future editor could accidentally write on. This is the same *"the
   mistake is not reachable from the signature"* argument `constraint-refusals.ts` already makes for
   itself, applied one level out to the call site.
2. **The recorder is unchanged and still takes no `tx`.** It still opens its own independent
   transaction — bible row 189's *"the shape that works"*, and the property
   `constraint-refusals.test.ts`'s durability test already proves. Arm D changes *who calls the
   counter*, not *how the counter writes*.
3. **F4 is the sharper form of the same property, and Arm D satisfies it where the naive Arm B does
   not:** because the `await` sits outside the transaction, a **deferred** violation raised at COMMIT
   is caught like any other.

⛔ **Proof obligation I would accept before calling this done:** an integration test that triggers
(a) an *immediate* CHECK violation and (b) a *deferred* one, asserting a refusal row survives each.
The second case is covered by no existing test. ⛔ **Case (b)'s subject, stated exactly, because two
of us have now got it wrong: the deferrable self-referencing FOREIGN KEY
`attendance_adjustments.superseded_by_adjustment_id`
(`0084_t158_attendance_adjustments.sql:38-39`) — NOT a unique constraint, and NOT one of the five
constraint triggers.** There is no deferrable unique in this schema; a lane sent to find one finds
nothing. And per the F4 correction the triggers raise without `USING CONSTRAINT`, so a test written
against one of them would assert that nothing is recorded and pass for the wrong reason — exactly
the "a test that only ever passed proves nothing" failure RULES §2 warns about.
⚠️ **Reach it directly, not through a domain function.** Lines 32–37 of that migration explain that
the write order is deliberately arranged so this FK never fires in normal operation; the test must
insert a row pointing at a non-existent id and commit.

**§3.2 — What Arm D costs, honestly.**

- ⚠️ **`storeId` and `actorPersonId` are lost — recorded as `null`.** `orgId` is the wrapper's own
  first parameter, so it is exact; the other two are not in scope at that layer, and there is **no
  `AsyncLocalStorage` anywhere in this repo** (checked) to recover them from. The 17 existing sites
  do record all three, so this is a real reduction in fidelity for those eight files. **I judge it
  acceptable and say why:** row 189 ranks *constraints*, and the ranking key is `reasonCode` = the
  constraint name; `prerequisiteRefusalsRepo.record` already takes both fields as nullable. If Ian's
  decision turns out to need a per-store or per-person cut, the wrapper grows an optional third
  argument and callers enrich it incrementally — the 8 money screens first, the rest never — and
  nothing is blocked meanwhile. That is a better position than 163 edits that must **all** land
  before the first report can be read.
- ⚠️ **It fires on read paths too.** Many of the 364 sites are page loaders. The recorder runs only
  on the error path, and `recordIfUnmappedConstraint` returns immediately unless the error parses as
  a constraint violation, so happy-path cost is zero and error-path cost is one extra round trip on
  a request that is already failing.
- ⚠️ **One `await` is added to the error path** before the refusal reaches the person. Bounded:
  `recordConstraintRefusal` sets `lock_timeout = '2s'` and swallows its own failures into
  `logger.error`, so it can neither change the refusal's shape nor fail the request. ⛔ **The
  alternative — `void`-ing the promise — is explicitly rejected**: an un-awaited promise in a
  Next.js server action can be killed when the response is sent, reintroducing "records nothing,
  with nothing red" through a different door. Awaiting is possible here only because the wrapper is
  `async`, and that is the whole reason this works where folding the counter into the synchronous
  `errorMessage` cannot.

**§3.3 — What Arm D does to `WRITTEN_FOR_A_PERSON`: nothing, and the check is mechanical.**
`pre-session-message.ts:137` builds the allowlist as `new Set(Object.values(CONSTRAINT_MESSAGES))`
— it is keyed on **sentences**, and widens only when a sentence is added to the shared map. Arm D
adds no key and no sentence; it adds a caller. The allowlist is byte-identical before and after.
⛔ **The one variant that WOULD widen it, and which I therefore recommend against:** fixing F1 by
promoting till's 5 and remittance's 3 local sentences into the shared `CONSTRAINT_MESSAGES` would
add **8 sentences** to the unauthenticated `/setup` URL allowlist — the exact trap that kept DEF-273
out of T-255. **Fix F1 with names, not sentences:** export a
`LOCALLY_MAPPED_CONSTRAINT_NAMES: ReadonlySet<string>` that `recordIfUnmappedConstraint` also
consults. Names never reach `Object.values(CONSTRAINT_MESSAGES)`, so the allowlist cannot widen by
construction, and DEF-273's wording arbitration stays untouched and correctly sequenced after this.

**§3.4 — Arm D must delete the 17 existing call sites, or double-count.** Each of the 17 sits in a
`catch` around a `withOrgPrincipal(...)` call, so once the wrapper lands both would fire for the
same refusal and payroll/settings would read as **twice as hot as they are** — error in exactly the
direction that would send Ian's follow-up work to the wrong domain, and doubly damaging against row
192's now-rare hit rate. Deleting them is the right resolution rather than deduplicating: 17 call
sites and 8 imports go, one implementation remains instead of two, and hand-wired coverage goes from
8 files to 0 while real coverage goes to 115.

**§3.5 — What stops it drifting, which is the whole case against Arm A.** One guard test, in the
shape `local-errormessage-convergence.test.ts` and `app-boundaries.test.ts` already establish: **no
file under `apps/erp/src` may import `withOrgPrincipal` from `@shareat/db`, except
`app/expenses/lib.ts` and the allowlisted `app/admin/prerequisite-refusals/lib.ts`.** Two assertions
make the chokepoint a property of the build rather than a convention, and screen 116 is covered the
day it is written. DEF-273's second paragraph makes this argument outright: *"that is the argument
for a guard that asserts zero rather than a convention that asks people to remember."*

**§3.6 — On the two things the spec says not to slide in.** I am **not** proposing to make
`errorMessage` async: the 192 occurrences and the shipped sync-and-pure decision stand untouched,
and Arm D exists precisely because it obtains an `async` frame without one. I am **not** proposing
to merge DEF-273's duplicate sentences. Both stay out of scope.

**§3.7 — Line endings, stated explicitly as required.** Arm D edits **one** file by hand
(`app/expenses/lib.ts`, LF) and deletes from **eight** (all LF). It performs **no sweep**, so the
23-file CRLF population under `apps/erp/src/app` is irrelevant to it — which is itself part of the
recommendation, since a 44-file sweep would have to handle all three CRLF translator files
(`attendance/lane/actions.ts`, `inventory/usage/actions.ts`, `statutory-discounts/actions.ts`) and
any guard test written for it must match on shape with `\r?` tolerance rather than on line endings.

### §4 — What would have to be true for me to be wrong

Ranked by how likely I think each is, each with the check that settles it.

1. ⛔ **The one that would overturn this: a material share of real constraint refusals arrive on a
   path that never enters `withOrgPrincipal`.** F8 argues the domain's `transaction(run)` fallback is
   a test-only affordance because a bare transaction sees no org-scoped rows under RLS — **inferred
   from `principal.ts`'s doc comment and migration 0011, not executed.** If any production write
   path reaches the database without an org principal, Arm D is blind there and Arm A's per-site
   wiring is more complete. **Settles it:** one integration test calling a domain writer with
   `tx = null` and asserting it fails on RLS rather than succeeding. If it succeeds, this
   recommendation is wrong as written.
2. ⚠️ **Row 189's next decision needs a per-store or per-person cut, not a per-constraint ranking.**
   Then `null` context is not a fidelity trade but a missing requirement, and the wrapper needs
   threaded context before the first report — pushing cost back toward Arm A's shape for whichever
   screens Ian cares about. **Settles it:** Ian says what the first hit report must show. This is
   the one question in this document whose answer changes the build.
3. ✅ ⚠️ **SETTLED, AND IT WENT AGAINST ME — deferred constraint-trigger violations do NOT carry a
   parseable constraint name.** I listed this as open and then closed it at source rather than
   leaving it for the build: all five `CREATE CONSTRAINT TRIGGER` functions raise with a bare
   `RAISE EXCEPTION '…'` and **none uses `USING CONSTRAINT = …`**, so `parseConstraintName` returns
   `null` and `recordIfUnmappedConstraint` no-ops on every one of them, under **every** arm
   including Arm A. **F4 is narrowed accordingly** — see the correction recorded there. The
   recommendation is unchanged: F4 was a supporting argument, and the recursion trap and the rule-13
   boundary carry Arm B's rejection on their own. What remains genuinely deferred *and* parseable is
   the one deferrable self-referencing FK on `attendance_adjustments.superseded_by_adjustment_id`.
4. 🔸 **Recording on the error path of 364 sites produces unacceptable volume.** Arm C's open
   questions — *"volume, retention, and whether a mapped hit is even interesting"* — apply to Arm D
   unchanged for the unmapped case, and I have not answered them. **Settles it:** the refusals
   table's growth over one week in production. Retention is a separate decision.
5. 🔸 **The extra async frame changes how Next.js surfaces the rethrown error.** I reason it cannot:
   the error is rethrown by identity, and `redirect()`'s `NEXT_REDIRECT` is thrown in the caller's
   `catch`, outside the wrapper. **Settles it:** the required smoketest on 9008 — one refusal on one
   screen, before and after.

⭐ **If (1) comes back the wrong way the honest fallback is NOT Arm A** — it is Arm D plus wrapping
`transaction()` in the same shape, one more file, every other property retained.

### §5 — Recommended sequence, if the orchestrator takes this

1. `LOCALLY_MAPPED_CONSTRAINT_NAMES` (names only) and `recordIfUnmappedConstraint` consults it.
   Fixes F1 **before** any counting begins, so the first report is not born wrong.
   `CONSTRAINT_MESSAGES` untouched; the `/setup` allowlist untouched.
2. The wrapper at `app/expenses/lib.ts`, with the integration test covering the immediate **and the
   deferred** case (§3.1).
3. Delete the 17 hand-wired call sites and their 8 imports.
4. The import-graph guard test (§3.5).
5. **Then** read a hit report — and only then rank which constraints earn a hand-written sentence,
   which is where row 189 hands the decision back to Ian.

Steps 1–4 touch **3 source files and 2 test files**. Arm A as specified touches 44.

### FOR IAN

**What this was.** The hit counter your row 189 decision depends on — *"we count hits and improve
the message the more hits it gets"* — is switched on for payroll and settings and switched off
everywhere else, including every screen that moves money. This phase decided **how** to switch it on
everywhere. No code was written.

**What I found that changes things.**

- The job is **smaller than the task said**: 163 places, not ~175, across 44 files, not 45. The
  register's own estimate of ~100 was the badly wrong one.
- **There is a far cheaper way than wiring 163 places by hand.** Every screen reaches the database
  through one shared function, and all but two files get it through **a single line of code**.
  Changing that one line switches the counter on for all 115 screens at once, lets us **delete** the
  17 we wired by hand, and cannot fall out of date when someone builds screen 116. Hand-copying the
  same two lines into 163 places is what has already drifted twice on this exact code (DEF-273), and
  we would be adding it back the week after T-255 removed it.
- ⚠️ **One thing must be fixed first or the numbers you read will be wrong.** The till and
  remittance screens keep their own private list of friendly messages. The counter cannot see those
  lists, so it would report 8 constraints as "has no message" when they already have one — and two
  of those 8 are the very constraints we are queued to make a wording decision about. Small fix,
  does not touch the security-sensitive list on the setup page, and it must land **before** the
  first count, not after. Your row 192 makes this urgent rather than tidy: now that real hits are
  expected to be rare, 8 false ones could top the first report.
- ⚠️ **Four stock screens have no error handling at all** — low-stock, stock returns, stock
  transfers, customer returns; 11 actions between them. If the database refuses something there the
  person gets a generic crash page rather than a sentence. Separate from this task and untouched by
  me, but someone should decide whether that is intended. **It needs a register row.**

**What needs a decision from you.**

1. **What does the first hit report have to show you?** If a ranked list of constraint names is
   enough, the cheap route works exactly as designed. If you also need *which store* and *which
   person*, the cheap route records those blank and we would fill them in screen by screen
   afterwards. This is the only question whose answer changes what gets built.
2. Row 189 says *"only 21 of 442 CHECK constraints are mapped."* It is 26 today, and the 442 looks
   like it may be counting things that are not CHECK constraints — plausibly every `NOT NULL`.
   Neither number changes the plan; both should be corrected before being quoted again. **Row 192
   has just narrowed a different clause of row 189, so this could ride along.** Only you amend
   row 189.

**What I have not done.** No code written, nothing built, no test run, no git command of any kind.
The only file changed in this phase is this one, by appending this section.

---

## Phase 2 — the build spec (APPROVED: Arm D)

> **Status: APPROVED by the orchestrator 2026-09-10.** Arm D is the decision. Phase 1's analysis
> above is the reasoning; **this section is the instruction, and it is self-contained** — an
> executing lane needs to read only §B0 onward, plus the four files §B2 names. Where a Phase 1
> finding is load-bearing it is restated here in full rather than cross-referenced.
>
> ⭐ **IAN'S RULING, 2026-09-10 — ranked constraint NAMES ONLY.** `storeId` and `actorPersonId` are
> recorded as `null`. **No `AsyncLocalStorage`, no context threading, no plumbing.** It answers what
> bible §13 row 189 actually defers to — *which* constraints are hit and *how often* — and
> enrichment can be added later without redoing any of this. ⛔ **Do not build the richer version
> "while you are in there."** Recording `null` for those two fields is the specification, not a
> shortcut.

### §B0 — Orientation, for a lane that has never seen this project

The database refuses bad rows with CHECK and unique constraints. When one fires and we have no
hand-written English sentence for it, the person sees a sanitised generic line — and we **count**
the refusal, so Ian can decide which constraints are hit often enough to earn a real sentence
(bible §13 row 189, his decision). That counter is currently called by hand from **17 places in 8
files**, all payroll and settings. **Zero money screens.** So the first report would say the money
screens are quiet, and that silence would be read as safety. That is the defect (DEF-274).

**What you are building:** not 163 more hand-written calls. Every screen in this app reaches the
database through one shared function, and all but two files receive it through **a single line of
code**. You will wrap that one line, delete the 17 hand-written calls, and add a guard that stops
the arrangement drifting.

### §B1 — The mechanism, stated as the fact a reviewer will check

`withOrgPrincipal` is **defined exactly once**, at `packages/db/src/rls/principal.ts:111`. It opens
the transaction under the org's RLS principal, and it is the transaction a constraint refusal
aborts.

Inside `apps/erp/src` it is referenced by **117 files across 364 call sites**, but those files do
not each import it from the package. They form a **re-export tree with a single root**:

- **44 sites forward the binding** — `export { withOrgPrincipal } from '../expenses/lib'`, or a
  local `export { withOrgPrincipal }` of a binding imported from there, across 44 files.
- **`apps/erp/src/app/expenses/lib.ts:148` is the only line in the entire app layer that imports
  `withOrgPrincipal` from `@shareat/db`.** (`expenses/lib.ts:18` imports it a second time for the
  module's own 6 internal calls — same file, both change.)
- The only other direct importer is `apps/erp/src/app/admin/prerequisite-refusals/lib.ts` (1 call
  site), the **read-only query behind the refusal *reporting* screen** — deliberately excluded, and
  allowlisted in §B6.

⭐ **A re-export forwards the binding.** Replace the root and all 115 importers get the new
behaviour; **the other 43 re-export files need no edit at all.** That is why this is 3 source files
and not 44, and it is the first thing a reviewer should verify.

### §B2 — The only files you may create or modify

| # | Path | Change |
|---|---|---|
| 1 | `apps/erp/src/lib/constraint-messages.ts` | add `LOCALLY_MAPPED_CONSTRAINT_NAMES`; `recordIfUnmappedConstraint` consults it (§B3) |
| 2 | `apps/erp/src/app/expenses/lib.ts` | the wrapper — lines 18 and 148 (§B4) |
| 3 | the 8 files in §B5 | delete 17 call sites + narrow 8 imports |
| 4 | `apps/erp/tests/constraint-messages.test.ts` | unit coverage for §B3 |
| 5 | `apps/erp/tests/withorgprincipal-chokepoint.test.ts` | **new** — the import-graph guard (§B6) |
| 6 | `packages/domain/tests/integration/constraint-refusals.test.ts` | **append only** — the two new integration cases (§B7). ⚠️ This is the one permitted touch under `packages/domain/` and it is a **test file**; `packages/domain/src/**` stays untouched |

⛔ **Everything else is read-only**, including `PROJECT_BIBLE.md`, `docs/DEFECTS-REGISTER.md`,
`docs/ROADMAP.html`, `docs/CAPABILITY-GAPS.md`, `docs/HANDOFF-TODAY.md`, every other
`docs/tasks/*.md`, all of `packages/domain/src/**`, and all of `packages/db/src/**`. Read as widely
as you need.

### §B3 — Step 1: the local-map fix. **Record NAMES. Never promote a sentence.**

⛔ **Do this first. If you build the wrapper before this, the first hit report is born wrong.**

`recordIfUnmappedConstraint` (`constraint-messages.ts:131`) decides mapped-vs-unmapped with:

```ts
if (!constraintName || constraintName in CONSTRAINT_MESSAGES) return;
```

That consults the **shared** map only — **26 keys**. But two screens keep their own private maps
that the shared module cannot see, and both are money screens:

- `apps/erp/src/app/till/actions.ts:30` — **5 keys**: `till_custody_shifts_one_open_per_store`,
  `till_custody_shifts_prev_unique`, `till_custody_shifts_store_date_no_unique`,
  `till_count_lines_shift_moment_account_unique`, `till_count_lines_counted_nonnegative_check`
- `apps/erp/src/app/remittance/actions.ts:34` — **3 keys**:
  `stores_pooling_requires_ceiling_check`, `stores_unremitted_ceiling_positive_check`,
  `stores_remittance_cadence_check`

**Overlap with the shared 26: zero.** So without this fix, switching the counter on would record
**8 constraints that already render a friendly sentence** as *unmapped* — on cash custody and cash
remittance, and two of the eight are the constraints DEF-273 is queued to arbitrate. Bible row 192
(ratified today) expects real hits to be **rare**, so 8 false ones could top the first ranked
report. **This is DEF-274's own defect pointing the other way: a measurement that misleads the
decision it exists to inform.**

**The fix, exactly:**

```ts
/**
 * Constraint NAMES that a screen-local CONSTRAINT_MESSAGES map already covers — till/actions.ts
 * and remittance/actions.ts each keep one, and this module cannot see them. Names only, never
 * sentences: see the ⛔ below.
 */
export const LOCALLY_MAPPED_CONSTRAINT_NAMES: ReadonlySet<string> = new Set([
  /* the 8 names listed above */
]);
```

and in `recordIfUnmappedConstraint`:

```ts
if (!constraintName) return;
if (constraintName in CONSTRAINT_MESSAGES) return;
if (LOCALLY_MAPPED_CONSTRAINT_NAMES.has(constraintName)) return;
```

⛔ **Why names and not sentences — do not "simplify" this by moving the 8 sentences into
`CONSTRAINT_MESSAGES`.** `apps/erp/src/lib/pre-session-message.ts:137` builds
`WRITTEN_FOR_A_PERSON` as `new Set(Object.values(CONSTRAINT_MESSAGES))`, and that set gates **what
text may appear in the URL of the unauthenticated `/setup` page**. Promoting the 8 sentences would
widen a security allowlist by 8 entries as a side effect of a counting change. Names never reach
`Object.values(...)`, so this fix **cannot** widen it — by construction, not by care. This is the
trap that kept DEF-273 out of T-255.

⚠️ **Duplication is accepted here and is the lesser evil.** The 8 names now exist in two places and
can drift. The guard in §B6 does not cover that; a follow-up may. Widening the `/setup` allowlist is
the worse outcome, and DEF-273 owns the real de-duplication.

### §B4 — Step 2: the wrapper

**`apps/erp/src/app/expenses/lib.ts`, two edits.**

`:18` — alias the package import and add the `Tx` type (exported from `@shareat/db` at
`packages/db/src/index.ts:30`):

```ts
import {
  moneyAccountsRepo, schema, expensesRepo, journalRepo,
  withOrgPrincipal as dbWithOrgPrincipal, type Tx,
} from '@shareat/db';
import { recordIfUnmappedConstraint } from '@/lib/constraint-messages';
```

`:148` — replace `export { withOrgPrincipal } from '@shareat/db';` with the wrapper:

```ts
export async function withOrgPrincipal<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await dbWithOrgPrincipal(orgId, fn);
  } catch (err) {
    await recordIfUnmappedConstraint(err, { orgId, storeId: null, actorPersonId: null });
    throw err;
  }
}
```

**Five things about those nine lines, each of which a reviewer will ask about:**

1. ⛔ **`return await`, not `return`.** The `await` is what puts the `catch` *outside* the
   transaction — see §B7.1. `return dbWithOrgPrincipal(...)` inside a `try` does not catch the
   rejection at all. This is the single most important character in the change.
2. ⛔ **`await recordIfUnmappedConstraint(...)`, never `void`.** An un-awaited promise in a Next.js
   server action can be killed when the response is sent — which reintroduces "records nothing,
   with nothing red", the exact T-245 bug, through a new door. Awaiting is possible only because
   this wrapper is `async`; that is the whole reason this design works where folding the counter
   into the synchronous `errorMessage` cannot.
3. ⛔ **`throw err;` — rethrow the same object, unchanged.** The refusal is the product; the count
   is a side effect. Do not wrap, re-type, log-and-swallow, or alter the message. Nothing the person
   sees may change.
4. **The wrapper cannot fail the request.** `recordConstraintRefusal`
   (`packages/domain/src/shared/constraint-refusals.ts`) already sets `lock_timeout = '2s'` and
   catches its own failures into `logger.error`. Do not add a second try/catch around it.
5. **`expenses/lib.ts`'s own 6 internal `withOrgPrincipal(` calls now route through the wrapper.**
   That is intended — leave them as they are.

⚠️ **A bundle hazard to be aware of but not act on.** `trade/orders/NewOrderForm.tsx` is
`'use client'` and imports from `trade/orders/lib.ts`, which re-exports `withOrgPrincipal`. It is an
`import type` — erased at compile time, so nothing is pulled into the client bundle. **If you ever
find yourself changing that to a value import, stop**: it would drag `@shareat/domain` into a client
bundle. You are not asked to change it. Named so you do not "tidy" it.

**§B4.1 — reserved.** If the orchestrator's F8 check finds a production write path that reaches the
database without `withOrgPrincipal`, the same wrapper shape is applied to `transaction()`
(`packages/db/src/client.ts:82`) and that instruction lands here as an **insertion**. Nothing else
in this spec changes. **If §B4.1 is still empty when you start, F8 came back clean — proceed.**

### §B5 — Step 3: delete the 17 hand-wired call sites

⛔ **This is not cleanup, it is correctness.** Each of the 17 sits in a `catch` wrapped around a
`withOrgPrincipal(...)` call. Once the wrapper lands, **both fire for the same refusal**, and
payroll and settings would read as **twice as hot as they are** — sending Ian's follow-up work to
the wrong domain, and doing it against bible row 192's now-rare hit rate, where doubling one domain
distorts the whole ranking.

| File | delete `await recordIfUnmappedConstraint(...)` at lines | narrow import at |
|---|---|---|
| `app/payroll/actions.ts` | 41, 64, 82 | 13 |
| `app/payroll/separations/actions.ts` | 47, 63 | 15 |
| `app/payroll/thirteenth-month/actions.ts` | 39, 59 | 13 |
| `app/settings/attendance/actions.ts` | 118 | 16 |
| `app/settings/expense-categories/actions.ts` | 47, 76, 96, 113 | 19 |
| `app/settings/organization/actions.ts` | 44 | 17 |
| `app/settings/sales-channels/actions.ts` | 73, 96, 116 | 15 |
| `app/settings/wastage-monitor/actions.ts` | 39 | 15 |

All 8 imports have the same shape and become:
`import { errorMessage } from '…/lib/constraint-messages';`

⚠️ **Each call also carries a 2-line comment above it** (*"T-252 — DEF-246: measures which unmapped
constraints are actually hit…"*). Delete the comment with the call. ⚠️ **Line numbers shift as you
delete** — work bottom-up within each file, or match on the statement text.

**After the deletion, `recordIfUnmappedConstraint` must have exactly one caller in `apps/erp/src`:**
the wrapper in `expenses/lib.ts`. Verify by search before you move on.

### §B6 — Step 4: the guard that stops it drifting

**New file: `apps/erp/tests/withorgprincipal-chokepoint.test.ts`.** A source sweep in the shape
`apps/erp/tests/local-errormessage-convergence.test.ts` already establishes (read that file first —
it gives you the directory walker, the `posix()` helper and the failure-message convention).

Assert both:

1. **No file under `apps/erp/src` imports `withOrgPrincipal` from `@shareat/db`, except**
   `app/expenses/lib.ts` and `app/admin/prerequisite-refusals/lib.ts`. Failure message must name the
   offender and say: *import it from `../expenses/lib` instead — that is the chokepoint where the
   constraint-refusal counter lives.*
2. **`app/expenses/lib.ts` still defines the wrapper** — the guard must not be able to pass by the
   wrapper having been deleted. (`local-errormessage-convergence.test.ts` has the same
   not-passing-by-deletion assertion; copy its shape.)

⚠️ **Match on shape, not on line endings.** 23 files under `apps/erp/src/app` use CRLF (26 under
`apps/erp/src`), including `attendance/lane/actions.ts`, `inventory/usage/actions.ts` and
`statutory-discounts/actions.ts`. Read with `utf8` and match with `\r?` tolerance or on substrings —
never on `$`-anchored line ends. ⚠️ **And match case-insensitively where SQL or DDL is involved**:
this project has already lost a count today to a `grep` for `DEFERRABLE` against DDL that said
`deferrable`.

### §B7 — Tests, and the two things you must watch FAIL before you trust them

**§B7.1 — The aborting-transaction property. This is T-245's original bug and it is why this task
is careful.** A recorder that writes inside the transaction the refusal aborts records **nothing,
for ever, with nothing red** — no error, no failing test, just an empty table a year later. You may
not take it on reasoning that the wrapper avoids this. **Watch it fail first.**

Append to `packages/domain/tests/integration/constraint-refusals.test.ts` (its header already
documents this red-then-green ritual, and it carries the `asOrg` / `fixture` helpers you need):

- **(a) Immediate CHECK violation.** Through the wrapper, provoke an unmapped CHECK violation;
  assert a refusal row exists afterwards with `reasonCode` = the constraint name, `storeId` and
  `actorPersonId` **null** (Ian's ruling — assert the nulls, they are the specification).
- **(b) Deferred violation, raised at COMMIT.** ⛔ **The subject, stated exactly, because two
  sessions have already got this wrong: the deferrable self-referencing FOREIGN KEY
  `attendance_adjustments.superseded_by_adjustment_id`, declared at
  `packages/db/migrations/0084_t158_attendance_adjustments.sql:38-39`.**
  - **NOT a unique constraint.** There is no deferrable unique in this schema;
    `attendance_adjustments_live_unique` is a *plain, non-deferrable* partial unique index. A lane
    sent to find "the deferrable unique" finds nothing.
  - **NOT one of the five `CREATE CONSTRAINT TRIGGER`s** (see §B9) — they raise without
    `USING CONSTRAINT`, so nothing is recorded and a test written against one would **assert that
    nothing is recorded and pass for the wrong reason**.
  - ⚠️ **Reach it by direct insert, not through a domain function.** Lines 32–37 of that migration
    explain that the write order is deliberately arranged so this FK never fires in normal
    operation. Insert a row whose `superseded_by_adjustment_id` points at a non-existent id and
    commit. A lane that tries the domain route will conclude the violation is unreachable and write
    the wrong test.
  - This case exists because a recorder placed *inside* the transaction callback would miss it
    silently — the deferred FK is raised by COMMIT, after the callback has already returned
    successfully.

⛔ **The red run is mandatory and its output goes in the report.** Before the wrapper is correct,
run both cases against a deliberately wrong placement — the recorder called on the caller's own `tx`
inside the callback — and capture **zero rows, not an error**. That empty result is the whole point:
it is what the bug looks like. Then fix and capture green. *A test that only ever passed proves
nothing* (RULES §2).

**§B7.2 — Unit, in `apps/erp/tests/constraint-messages.test.ts`:** a name in
`LOCALLY_MAPPED_CONSTRAINT_NAMES` records nothing; a name in neither map records; a
non-constraint error records nothing. **And an assertion that `WRITTEN_FOR_A_PERSON` is unchanged in
size** — the mechanical proof that §B3 did not widen the `/setup` allowlist.

**§B7.3 — Regression:** `apps/erp/tests/local-errormessage-convergence.test.ts` and
`tests/unit/app-boundaries.test.ts` must both still pass untouched.

**§B7.4 — Smoketest on 9008**, per RULES §2: provoke one refusal on one money screen and confirm
the person sees the same sentence as before and a row is recorded. ⚠️ **Stop the dev server before
`npm run build`** — the build clobbers the `.next` it is serving.

### §B8 — Explicitly OUT of scope

- ⛔ **The `USING CONSTRAINT` migration** — Ian has ruled it a separate item, sequenced after T-261
  ships (§B9). Do not write it here.
- ⛔ **Enrichment.** `storeId`/`actorPersonId` stay `null`. Ian's ruling. No `AsyncLocalStorage`.
- ⛔ **DEF-273's wording merge** — two constraints carrying two different live sentences. Sequenced
  after this deliberately, so the choice is informed by whether either sentence ever fires. Merging
  them also means promoting a sentence, which §B3 exists to avoid.
- ⛔ **The package source trees — nothing at all.** Neither `packages/domain/src/` nor
  `packages/db/src/`, at any depth. The single permitted touch under `packages/domain/` is
  appending to the integration **test** file in §B2 row 6.
- ⛔ **Amending `PROJECT_BIBLE.md`.** Row 189 is Ian's and row 192 was ratified today. Report a
  needed amendment and stop (RULES rule 14).
- ⛔ **The four catch-less action files** — `inventory/low-stock`, `inventory/returns`,
  `inventory/transfers`, `trade/returns` (11 server actions, no try/catch). A separate register row
  owns them. The wrapper covers them for *counting* purposes anyway, which is the only part that is
  this task's business.

### §B9 — Blind spots this counter SHIPS with, and they must be written down

⛔ **Say this in the report, and expect it to be quoted when the first hit report is read.** The
counter cannot see the five deferred accounting invariants: **balance**, **minimum-two-lines**,
**negative stock**, **layer ties**, and **wastage-allocations-sum-to-100**. All five are
`CREATE CONSTRAINT TRIGGER`s that raise a bare `RAISE EXCEPTION`; **not one uses
`USING CONSTRAINT`** (verified: zero files in `packages/db/migrations` contain that clause), so they
emit no `constraint "name"` text and `parseConstraintName` returns `null`. **They are invisible to
every possible design of this counter, not to this one.**

⭐ **This matters more than it sounds.** Those five are exactly the population bible row 189's
"double signal" rule cares most about — a hit there would mean *nothing above the database refused
first*. **Their silence in the first hit report is absence by construction, not safety.** Reading it
as safety would be the same failure DEF-274 exists to prevent, one layer down. The fix is
`USING CONSTRAINT = '<name>'` on five `RAISE EXCEPTION` statements in a new migration; Ian has ruled
it its own item, sequenced after this. **Cite it; do not build it.**

Also, and by construction under every arm: `/setup` and `/sign-in` are uncountable, because no
`orgId` exists yet on those paths. `pre-session-message.ts` is the mechanism that covers them.

### §B10 — Your falsifier. What would mean you built the wrong thing

State the answer to each in your report. **A "done" with these unanswered is not done.**

1. **Does `recordIfUnmappedConstraint` have exactly one caller in `apps/erp/src` when you finish?**
   More than one means §B5 is incomplete and some domain double-counts. Search, do not assume.
2. **Does the red run in §B7.1 produce ZERO ROWS rather than an error?** An error means you built a
   different wrong thing and the test is not watching the bug this task is about.
3. **Is `WRITTEN_FOR_A_PERSON` the same size before and after?** If it grew, §B3 was done with
   sentences instead of names and a security allowlist widened as a side effect.
4. **Does the guard in §B6 fail when you temporarily add a direct `@shareat/db` import to some third
   file?** If it passes, it is asserting nothing.
5. **Does one refusal on one money screen still show the person exactly the sentence it showed
   before?** If the text changed, the wrapper is altering the product rather than counting it.

⚠️ **If you hit a spec defect, report it and stop. Do not work around it.** The Phase 1 section
above exists because this task's own spec had five defects in it, and finding them was worth more
than executing the spec as written would have been.

### §B11 — Definition of done

typecheck clean · unit tests pass · **integration tests pass against real Postgres**, with the §B7.1
red run captured before the green one · **smoketested in the running app on 9008** ·
`npm run build` succeeds **with the dev server stopped** · self-reviewed line by line · committed
with a message explaining *why* · the five §B10 questions answered with real command output ·
report ends with a `FOR IAN` block. *Reporting done with any of these unmet is itself a defect*
(RULES §2).

**Expected size:** 3 source files changed (1 wrapper added, 17 call sites and 8 imports deleted, 1
name-set added), 2 test files changed, 1 test file created. **Net app code shrinks.** If your diff
is materially bigger than that, stop and say why before continuing.

### FOR IAN — what Phase 2 will do

We are switching the hit counter on for every screen by changing **one line**, not by hand-writing
it into 163 places. The counter will then be deleted from the 17 places it was written by hand, so
payroll and settings do not get counted twice and read as busier than they are.

Two things you should know before you read the first report:

- **Till and remittance already have their own private message lists.** We are teaching the counter
  about them first, so it does not report 8 constraints as "needs a message" when they already have
  one. Done by listing names only, so nothing changes about what text can appear on the
  unauthenticated setup page.
- ⚠️ **Five accounting rules will be missing from the report and that is not because they are
  quiet.** Balance, minimum-two-lines, negative stock, layer ties, and wastage-splits-summing-to-100
  are enforced by database triggers that do not report a name we can count. **Their absence is a
  blind spot, not a clean bill of health** — you ruled the fix its own item, and it is five lines in
  a new migration whenever you want it.

Per your ruling, the counter records **which constraint and how often**, and leaves which store and
which person blank. Those can be filled in later without redoing any of this.

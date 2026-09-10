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

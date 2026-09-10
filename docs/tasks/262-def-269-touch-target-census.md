# T-262 — DEF-269: re-census touch targets with a matcher that resolves inherited text size

> **Status: RESERVED by the orchestrator, 2026-09-10.** Number reserved so no peer takes it.
> Nothing built. ⭐ **THIS TASK OPENS WITH A DECISION, NOT WITH CODE.** DEF-269's remedy is
> written as two parts and the second one — *"decide whether a text-scanning guard can do this at
> all, or whether the assertion has to move to rendered output"* — governs the first. Answer it in
> writing before a line of the census is written, because the answer decides what the census even
> looks like.

## Why this matters, in one paragraph

`apps/erp/tests/action-link-sweep.test.ts` is green. That green is the reason nobody has re-checked
touch targets since T-250. But the guard matches `text-xs` **and** a bare `underline` inside the
**same `className` attribute value** — so a control that carries `underline` itself and takes
`text-xs` from an **ancestor** matches nothing, is counted as absent, and the sweep reports success.
⛔ **Until this is answered, that guard's green is evidence about the shapes it can see and nothing
more, and it must not be cited as proof that touch targets are covered.**

## What is already known, and it is not a guess

**The concrete instance that exposed the blind spot:** the void submit button at
`apps/erp/src/app/customers/[customerId]/page.tsx:495` has no padding of its own and inherits
`text-xs` from its ancestor `<td>`. It is the exact undersized shape DEF-239 was written to find,
and it was invisible to **both** DEF-239's original census **and** the guard built to stop
recurrences. It was fixed in T-258 as DEF-270 — **the instance is closed; the blind spot is not.**

⛔ **This is the FOURTH time on this project that a guard has matched a SPELLING where it needed to
match a SHAPE.** DEF-243's lesson was exactly this one level down (an exact-literal grep
undercounted DEF-239's population by more than half); T-250's target test needed three corrections
for the same reason; the production-caller census was wrong twice and printed a plausible list both
times. **The pattern is now well enough evidenced to be the default suspicion of any text-scanning
guard in this repo** — including whatever you propose to replace this one with.

⚠️ **The guard already documents a SECOND blind spot, in its own header, and any answer here must
say what it does about it:** a `className` extracted into its own named constant (this app's
existing `SUBMIT_BTN`/`BTN_SM`/`BTN`/`FIELD` convention) is not seen, because the guard reads
`className=` call sites, not constant definitions. Two known blind spots in one guard is a fact
about the *approach*, not about two oversights.

## The fork

### Arm A — keep a text scanner, make it structural

Parse the JSX properly and resolve `text-*` from the nearest ancestor that sets one, instead of
reading one attribute value in isolation.

- ✅ No new runtime dependency on rendering; stays a fast unit test.
- ⛔ **A regex cannot do this and must not be attempted.** Ancestry needs a real AST — the
  TypeScript compiler API is already a dependency of this repo. A regex walking JSX nesting would
  be the fifth instance of the exact mistake this task exists to correct.
- ⚠️ Resolves *authored* ancestry only. It still cannot see a size arriving through a component
  boundary (`<Cell>` renders the `<td>`), through a prop, or through a named constant.
- ⚠️ Say honestly how many of the real cases live inside the part it still cannot see.

### Arm B — move the assertion to rendered output

Render, let Tailwind produce real CSS, and assert on computed box height.

- ✅ Measures the thing the rule is actually about — geometry — rather than a proxy for it.
- ⛔ **T-249 §9 explicitly ruled this out at the time**, and the guard's header records why: *"no
  harness here renders real Tailwind-generated CSS"*. If you recommend this arm you are proposing
  to build that harness — **say so plainly, and price it.** Do not present it as a matter of
  changing an assertion.
- ⚠️ The orchestrator owns the browser and the dev server. A lane may not start either. If your
  recommendation needs a rendered measurement to be *believed*, say what you want measured and I
  will run it.

### Arm C — invert the assertion: allowlist the sanctioned shapes

Stop hunting for the bad shape. Assert instead that every interactive control uses one of the
sanctioned shared classes (`ACTION_LINK`, `BTN`, `BTN_SM`, `SUBMIT_BTN`), each of which guarantees
its own tap target.

- ⭐ **Inheritance stops mattering.** You never need to compute a size if the control is required to
  carry a class that guarantees one.
- ⭐ **It closes the named-constant blind spot too** — that convention stops being an evasion and
  becomes the thing being asserted.
- ⚠️ Needs a defensible definition of "interactive control" and an exemption list that is honest
  rather than pre-populated. `SHAPE_ALLOWLIST` is empty on purpose today; do not fill one "just in
  case".
- ⚠️ Probably the largest one-time change, and it lands on files no defect has complained about.
  Price that.

## What you must produce, in this order

1. **Re-derive the population.** How many controls in `apps/erp/src` carry a bare `underline`
   **without** `text-xs` in the same attribute value, and of those, how many actually inherit a
   small text size from an ancestor? ⛔ **The second number is the whole question and the first
   number alone is not an answer.**
   ⚠️ ⛔ **Treat any number you produce as YOUR hypothesis, and re-derive it a second way before you
   report it.** Yesterday a line-wise grep over this same JSX gave three different answers before
   the true one, and only the third was right. If two methods disagree, that disagreement is worth
   more to me than a tidy figure.
2. **Answer the governing question in writing:** can a text-scanning guard do this at all?
3. **One arm named**, with its reasoning, its cost, and — required — **what would have to be true
   for you to be wrong.** A recommendation with no falsifier is an opinion and I will send it back.
4. ⛔ **Then STOP and send it to me as `SPEC`.** Do not implement. Do not modify the existing guard.

⭐ **A fourth way is explicitly permitted and has paid off twice this week** — T-255's lane found an
option nobody listed and was right; T-259's lane found the spec itself was defective. If none of
A/B/C is correct, say so and say what is.

## The second consumer — state your answer so it generalises

**DEF-278 asks the same question about a different population.** Its remedy part (2) wants *"a
guard over rendered attributes, not source text"* for money inputs, after a line-wise grep of the
same tree returned "4 of 18" — plausible and wrong — against the true "17 of 26". ⭐ **So the
question "can a text-scanning guard assert a rendered property here?" has at least two callers, and
an answer that only fits touch targets is worth much less than one that says where the line is.**
Say which side of your line DEF-278 falls on. Do not build anything for it.

## Watch out

- ⛔ **Do not weaken the existing guard as a side effect.** `TARGET_FILES` is a real invariant:
  DEF-270 records that removing a page from that list would have a UI task quietly weakening a
  guard, which was judged strictly worse than the bundling it avoided.
- ⚠️ **Any guard needs a non-zero control.** The existing one has one, deliberately: a broken walk
  reporting "0 hits" is indistinguishable from a correctly-fixed tree. Whatever you propose must
  carry the equivalent, and you must say what it is.
- ⚠️ **Three files in this tree use CRLF** (`attendance/lane/actions.ts`, `inventory/usage/actions.ts`,
  `statutory-discounts/actions.ts`) — a sweep matching on a line ending silently skips them.
- ⚠️ The `(?<!no-)` / `(?!-)` guards in the current regex exist because `hover:no-underline` and
  `underline-offset-*` both contain "underline". Any new matcher inherits that requirement.

## Out of scope

- **DEF-270** — already fixed in T-258. Do not revisit the instance.
- **DEF-258** — 47 same-digit dark-mode overrides across 28 files. Different defect, different pass,
  and not all of them are defects. Do not fold it in.
- **DEF-278's implementation.** Answer where the line falls; build nothing.
- Amending the bible, the registers, or the roadmap (RULES rule 14 — report and stop).

## Done when — for THIS phase

- The population is re-derived by two independent methods and the two are reconciled.
- The governing question is answered in writing: can a text-scanning guard do this at all?
- One arm is recommended, with its cost and its falsifier, and DEF-278 is placed on one side of the
  line.
- ⛔ Nothing is implemented, no existing test is modified, and the report ends with a `FOR IAN`
  block in plain language.

See `docs/DEFECTS-REGISTER.md` DEF-269, DEF-270, DEF-278, DEF-243, DEF-239;
`apps/erp/tests/action-link-sweep.test.ts`; `docs/tasks/249-*.md` §7 and §9.

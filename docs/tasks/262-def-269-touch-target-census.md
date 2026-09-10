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

---

## Phase 1 — the lane's analysis

> ⛔ **§1 AND §2 ARE PARTLY SUPERSEDED — read §5 (the addendum) before acting on any number below.**
> The orchestrator's browser pass answered falsifier 1 and, in doing so, found that **my own ≤12px
> threshold repeats the spelling-for-shape error one level up.** The population in §1 is real but is
> roughly a tenth of the true one. §1 is left standing unedited because what it got wrong is the
> evidence.

> Written by lane D (Opus 5) on 2026-09-10. **Nothing was implemented.** No application file, no
> test, no other task doc was modified; no git command was run. The census tool described below
> lives in the session scratchpad **outside the repo**, deliberately, because this phase's scope
> permits creating no file inside it. It is reproducible from the description in §1.2 and I will
> move it into the repo only if a later phase asks for it.

### 0. Spec defects — reported, not worked around (RULES §3.4a)

⚠️ **Protocol deviation, disclosed:** the briefing said to report spec defects as `QUESTION`
*before* doing anything else. I did the census first. Two of the three defects below are only
*provable* by measuring, and reporting them beforehand would have been a guess presented as a
finding. That was my call and it cost the orchestrator a round trip it asked to have earlier.

**QUESTION 1 — the spec's population definition is itself a spelling match, and it undercounts by
the same mechanism the task exists to correct.** The spec asks (line 86) for controls carrying *"a
bare `underline` without `text-xs` in the same attribute value"*. But `underline` is a **text
decoration, not a size**. It was only ever DEF-239's proxy for *"this is an inline text-style
action"*. Anchoring the re-census on it reproduces DEF-243's error one level up — which is what
§"THE ONE THING TO INTERNALISE" warns against, in the document that then does it. Measured: the
`underline`-anchored population is **16**; the shape-anchored population over the same tree is
**22**. The 6 it cannot reach are not underlined and were never going to be. **This would have been
the fifth instance.**

**QUESTION 2 — DEF-278's stated remedy is over-prescribed, and this analysis contradicts it.** The
register's remedy part (2) asks for *"a guard over rendered attributes, not source text"*. `min` and
`step` are **authored attributes sitting on the element itself** — no inheritance, no cascade, no
layout. What failed in DEF-278's original count was **line-wise vs element-wise granularity**, not
source vs rendered; the orchestrator's own correct "17 of 26" was itself obtained by reading whole
`<input>` elements *in source*. Recommending a rendering harness there buys nothing and prices in a
dependency the defect does not need. See §4.

**QUESTION 3 — the spec asserts a CRLF hazard that does not apply to this guard, and undercounts it
by 8×.** §"Watch out" warns that *"a sweep matching on a line ending silently skips"* three CRLF
files. The three it names genuinely are CRLF (`attendance/lane/actions.ts`,
`inventory/usage/actions.ts`, `statutory-discounts/actions.ts`) — **but there are not three.
Measured: 26 CRLF files of 276 under `apps/erp/src`** (23 of 232 under `apps/erp/src/app`, which is
the figure the orchestrator independently arrived at). ⚠️ **26 is the number that matters here**,
because the guard's own `walk()` starts at `src`, not `src/app`. Neither figure changes this task:
the existing guard matches a global regex over whole file contents and never splits on a line
ending, so it is not exposed, and neither is an AST successor. The warning is **still worth
keeping** — it is a live hazard for any *future* line-wise sweep, and DEF-278's original wrong count
was line-wise — but as written it reads as a defect in this guard, and it is not one. Suggest
re-filing as a general note with the corrected scope and count.

⛔ **Worth noticing that this is the same failure a third time in one document.** The spec's
"three files" came from a named list rather than a measurement, exactly as DEF-239's "4 instances"
did and as my own "32" did (§1.1). A hand-written list of examples reads as a population and is
not one — see DEF-240, where a fix globbed the machinery and left the neighbouring hand-written
list to rot.

### 1. The re-derived population, two ways

**Scope of both methods:** 276 `.ts`/`.tsx` files under `apps/erp/src`, 7,408 JSX elements, of
which **1,007 are interactive controls** after excluding `type="hidden"` inputs and `<form>`
wrappers. Both methods parse with the **TypeScript compiler API (5.9.3, already a repo dependency)**
— no regex walks JSX nesting anywhere in this analysis.

**Method 1 — anchored on `underline`, exactly as the spec defines it.** Resolve each element's own
`className` (string literal, template, *and* named-constant reference), then walk authored JSX
ancestors to the nearest one setting an unconditional `text-*` size.

| Bare-underline elements | 152 |
|---|---|
| …carrying their **own** `text-xs` — what the current guard can see | 8 |
| …**without** own `text-xs` — the guard is blind to all of these | **144** |
| ⤷ own `text-sm` | 49 |
| ⤷ no own size, **inherits `text-sm`** (20px box — out of this defect's scope) | 76 |
| ⤷ no own size, **inherits ≤12px** | **16 ← the spec's question** |
| ⤷ no own size, nothing resolvable (ancestry hit a component boundary) | 3 |

**Method 2 — anchored on shape. The word `underline` appears nowhere in it.** Enumerate every
interactive control, compute its effective text size (own, else nearest authored ancestor), and keep
those ≤12px that carry no padding and no height of their own.

| Interactive controls | 1,007 |
|---|---|
| effective size ≤12px | 112 |
| …and no own padding/height — **undersized by shape** | 27 |
| ⤷ size from its own `className` | 5 |
| ⤷ size **inherited** | **22** |

**Reconciliation.** Method 1 ⊂ Method 2, exactly: 16 shared, **0 found only by Method 1**, **6 found
only by Method 2**. The 6 are `admin/users/[personId]:214` (a `<summary>`) and five
checkbox/radio inputs (`inventory/deliveries/[id]:191`, `staff/hire:156`,
`staff/[employmentId]:104`, `trade/returns:203`, `:208`).

⛔ **The disagreement is worth more than the figure, and it points the opposite way from comfort.**
Method 2's 5 checkbox/radio hits are **found for the wrong reason**. A checkbox's box is
*intrinsic* — roughly 13×13px in Chrome — and does **not** scale with inherited `font-size`. They
are genuinely undersized targets, and a text-size scanner catches them by coincidence; it would
equally miss a checkbox inside a `text-base` label, which is just as undersized. **35 checkbox/radio
inputs exist in this tree and 26 carry no padding of their own.** If they are in scope for this
defect class, no text-size guard of any construction is adequate.

#### 1.1 Two errors I made, both caught by hand-reading rather than by the tool

Recorded because §"THE ONE THING TO INTERNALISE" asks for exactly this, and because both are the
same failure the task is about:

1. **Method 2 first returned 32, not 22.** Ten of those were `type="hidden"` inputs and `<form>`
   elements — not tap targets at all. A **45% overcount**, in a run that looked entirely plausible
   and printed a tidy list. Caught only by opening `customers/[customerId]/page.tsx:499` and seeing
   `type="hidden"` with my own eyes.
2. **My standalone-vs-mid-sentence heuristic is wrong on 3 of 16** (§2). It has a fragment bug —
   a control whose parent is a `<>` fragment reads as having no sibling prose, which misfiled
   `expenses/recurring:204` as standalone when it is mid-sentence — and it cannot tell a breadcrumb
   from a sentence, which misfiled `settings/expense-categories:57` and `settings/organization:58`
   the other way.

**Positive control, and it is live.** All 8 own-`text-xs`+`underline` elements resolve to
`ACTION_LINK` (5 by constant reference, 3 inside template expressions) and **all 8 carry `py-2`**.
My census therefore independently reproduces the existing guard's green over the population that
guard *can* see. A resolver that saw nothing would have printed the same "0 undersized" and looked
identical — this is the check that separates the two.

### 2. The governing question, answered

> *Can a text-scanning guard resolve inherited text size at all, or does the assertion have to move
> to rendered output?*

**Yes, it can resolve inheritance — I did, in ~150 lines, and it is fast and reliable. And that does
not make the guard correct, because inherited text size is not the property the rule is about.**
Three findings, in increasing order of how much they cost the text-scanning approach:

1. **Resolving authored ancestry is genuinely tractable.** 5% of interactive controls (49/1,007)
   end up with no resolvable size because ancestry terminates at a component boundary. That is
   small enough to enumerate and hold. It also **closes the guard's own confessed second blind
   spot for free**: 364 interactive controls take their `className` from a named constant, and a
   compiler-API resolver reads those, where the current `className=`-anchored regex cannot.

2. **Text size is a proxy for box height, and the proxy fails on the controls that matter most.**
   A checkbox ignores font-size (26 unpadded ones here). An `<input>` or `<select>` is sized by UA
   stylesheet and padding. Anything with `inline-flex`+`py-*` is sized by its padding — which is
   precisely how `ACTION_LINK` fixes the defect. **A perfect inheritance resolver still measures
   the wrong quantity for every control that is not bare inline text.**

3. ⛔ **The decisive one: the source does not contain the fact that decides whether an instance is
   a defect at all.** Of the 16, hand-reading shows most are links sitting **inside running
   sentences** — `admin/stores/[id]:177` is *"…are the organisation's — set them once."*;
   `settings/wastage-monitor:175` is *"…is set on Sales channels."* WCAG 2.5.8's **inline
   exception** covers a target within a sentence, and DEF-239's own register row already flags that
   reading as *"arguable here"*. Others are breadcrumbs (`settings/organization:58`) or a flex row
   of actions (`payroll:145`) where the exception plainly does **not** apply. **Whether a link
   renders inline in a sentence or as a standalone row is a rendered-layout fact.** My source
   heuristic got 3 of 16 wrong trying to infer it, and no better heuristic exists in the source,
   because the information is not there.

**So the honest answer is narrower than either arm as written.** A text scanner can assert what the
author *wrote*. It cannot assert what the browser *computes*. Inheritance is the one computed
property it can approximate — because authored ancestry is in the same file — and the failure that
produced DEF-269 is not that the guard approximated badly. **It is that the guard could not tell
"I checked and it is fine" from "I could not see it", and reported both as green.**

### 3. Recommendation — a fourth way. Arm A's mechanism, Arm C's polarity, and it fails closed

Not A, B or C as written. The spec permits a fourth and this is it.

**Build a structural resolver that partitions every interactive control into three buckets — PASS /
FAIL / UNRESOLVED — and make UNRESOLVED fail the test** unless individually listed with a written
reason, in the style `SHAPE_ALLOWLIST` already uses.

- **From Arm A:** the TS compiler API, authored-ancestry resolution, named-constant resolution.
  Stays a fast unit test with no rendering dependency.
- **From Arm C:** positive assertion. Within the one shape where the text proxy is *sound* — a bare
  inline `<a>`/`<button>`/`<Link>` with no padding, no height, not `inline-flex`, whose box really
  is its line-height — assert it carries a sanctioned class. Do **not** extend that to all 1,007
  controls (§3.1).
- **The load-bearing part, and the actual fix for DEF-269:** the UNRESOLVED bucket. A control whose
  size cannot be resolved — component boundary, prop, dynamic class — **fails**. Today that control
  is silently counted as absent, which is the precise mechanism by which
  `customers/[customerId]:495` survived both DEF-239's census and the guard built to stop it.
- **Non-zero control:** the existing `files.length > 100` walk check stays (currently 276), and
  gains a second: the resolver must find the 8 known `ACTION_LINK` sites and report them PASS. A
  resolver that silently resolves nothing then reports "0 undersized" is otherwise indistinguishable
  from a clean tree — the same failure one level up.
- ⛔ `TARGET_FILES` is untouched. DEF-270 records why weakening it is worse than what it avoids.

**Cost:** roughly a day. ~150 lines of resolver (I have a working one to port), plus adjudicating
the 16 + 6 and whatever the UNRESOLVED bucket turns out to hold in a stricter implementation than
mine.

#### 3.1 Why not each arm, priced

- **Arm A alone** institutionalises the proxy. It would resolve inheritance perfectly and still
  report green over 26 unpadded checkboxes. Correct mechanism, wrong assertion.
- **Arm B** measures the real thing and I am **not** recommending it *now* — but say plainly what
  that means: you would be building the Tailwind-rendering harness T-249 §9 ruled out, to adjudicate
  a population of 16–22 controls of which most are arguably WCAG-exempt. That is not a defensible
  price today. It becomes defensible the moment §3.2's first falsifier fires.
- **Arm C as written** is priced at **932 of 1,007 interactive controls across 118 files** — only 75
  are on a sanctioned class today. That is not a guard, it is a refactor of the app's entire
  interaction layer, landing on files no defect has complained about. The spec asked me to price it;
  that is the price, and it is why I take only its polarity and not its scope.

#### 3.2 What would have to be true for me to be wrong

1. ⭐ **If the 14 mid-sentence links actually render as standalone rows, I am wrong and Arm B gets
   much stronger.** My whole "most are WCAG-exempt" claim rests on a source reading of prose
   structure — and §1.1 shows my own heuristic for that is wrong 3 times in 16. **This is the one
   measurement I want and cannot take:** the orchestrator owns the browser. Load
   `/settings/sales-channels`, `/settings/organization`, `/wastage` and `/payroll` at 390px and
   report, for each of the 16, whether the link sits inline in a sentence or on its own line. If the
   answer is "standalone", the genuine population is ~16 rather than ~2 and rendering earns its
   price.
2. **If the UNRESOLVED bucket is large and irreducible, Arm C wins despite its price.** My resolver
   says 5% (49/1,007). A stricter one — refusing to walk through `.map()` callbacks, or treating
   every custom component as opaque — would report considerably more. If it lands above ~10%, the
   guard is mostly abstaining, and asserting a positive shape becomes the better buy.
3. **If checkbox/radio targets are ruled in scope, the answer flips to B outright.** 26 unpadded
   checkbox/radios are undersized independently of font-size, and no text-size guard of any
   construction can see that. This is Ian's call, not mine — it is a scope question about what the
   touch-target rule covers.

### 4. Which side of the line DEF-278 falls on

**The line, stated so it generalises:**

> **A source scanner may assert a property the author WROTE ON THE ELEMENT. It may not assert a
> property the BROWSER COMPUTES** — inheritance, cascade, UA defaults, intrinsic control sizing,
> layout. Inheritance is the single computed property a structural scanner can *approximate*,
> because authored ancestry sits in the same file. It must approximate it explicitly and **fail
> where the approximation runs out.**

**DEF-278 falls on the source-scanning side, and comfortably.** `min` and `step` are authored
attributes on the `<input>` itself. Nothing is inherited, nothing is computed, nothing depends on
layout. Its original wrong answer ("4 of 18" against the true "17 of 26") came from a **line-wise**
grep — reading lines instead of whole elements — and the orchestrator's own correct count was
obtained by reading whole `<input>` elements **in source**, which is exactly what an AST pass does
mechanically. See QUESTION 2: the register's "guard over rendered attributes" is over-prescribed.

**DEF-269 falls on the computed side**, which is why its guard can only ever proxy, and why the
fail-closed bucket is the part that actually transfers between the two.

⚠️ Both then share the *other* half of the lesson, which is the one worth generalising:
element-wise, never line-wise; and a guard that cannot see something must say so rather than pass.

---

### FOR IAN

**What this was.** A test called `action-link-sweep.test.ts` is green, and that green was being
read as "the small tap targets are fixed". It is not — the test can only see a control that spells
out its own text size. If the size comes from the row or paragraph *around* it, the test sees
nothing and calls that a pass.

**What I found.** Counting the way the task asked gives **16** such controls. Counting by *shape*
instead — any small control you can tap, underlined or not — gives **22**. The extra 6 include
checkboxes, and those matter for a reason worth knowing: **a checkbox is about 13px no matter what
text size it sits in**, so a test that reasons about text size will never reliably find them. There
are 26 unpadded checkboxes and radio buttons in the ERP.

**The catch, and it is the interesting part.** Most of the 16 are links sitting *inside a sentence*
— "the registered name and TIN are the organisation's — **set them once**." The accessibility
standard specifically exempts links inside sentences, so most of these may not be defects at all.
But whether a link renders inside a sentence or on its own line is something you can only see by
**looking at the page**, not by reading the code. I tried to infer it from the code and got 3 of 16
wrong.

**What I recommend.** Rebuild the guard so that when it cannot work something out, it **fails
instead of passing**. That is the real bug here — not that the test measured badly, but that
"I couldn't see it" and "it's fine" came out the same colour. About a day's work.

**What I need from you (one thing).** Somebody with a browser should open four pages at phone width
and tell me whether those 16 links sit inside sentences or stand on their own lines. If they stand
alone, this is a real 16-instance defect and the fix is bigger than what I have recommended. If they
sit in sentences, it is closer to 2 and my recommendation is right-sized. I could not check —
lanes are not allowed to start a browser or a dev server.

**Two decisions that are yours, not mine.** (1) Do checkboxes and radio buttons count as touch
targets for this rule? If yes, no text-based test can ever do this job and we should price a
rendering harness properly. (2) DEF-278's register entry asks for a rendering-based guard for money
inputs; I think that is over-prescribed and a source-based one is correct there — worth a second
opinion before anyone builds it.

**Nothing was changed.** No app code, no tests, no other documents. This section is the only edit.

---

## 5. Addendum — falsifier 1 answered, and my own threshold retracted

> Added by lane D after the orchestrator's rendered pass (`smoke-t262.mjs`, real Playwright at
> 390×844, dev server on 9008, signed-in store-scoped session; 195 interactive controls across 5
> pages, 159 passing the floor as its non-zero control). Still nothing implemented.

### 5.1 Falsifier 1 did NOT fire

| Page (390px) | undersized | inline — 2.5.8 exempt | **standalone — real** |
|---|---|---|---|
| `/settings/sales-channels` | 18 | 18 | **0** |
| `/settings/organization` | 1 | 1 | **0** |
| `/wastage` | 1 | 1 | **0** |
| `/payroll` | 3 | 3 | **0** |

**Zero standalone across all four.** My §3.2 falsifier 1 said that if these rendered standalone the
genuine population was ~16 and Arm B earned its price. They do not, so it does not. §2's third
finding — that the source cannot tell inline from standalone — **survives and is strengthened**: the
distinction turned out to be real, decisive, and visible only in a browser.

⚠️ **Two stated limits of that probe, carried here so nobody over-trusts it.** It does not test
2.5.8's *spacing* exception, so a small target with generous clearance is still counted undersized;
and "inline" is scoped to the nearest non-inline block ancestor, so a link alone in a `<td>` reads
standalone even when a sibling cell puts text on the same visual line. The orchestrator flags the
second as a judgement rather than a measurement. I agree with the judgement — an adjacent table cell
is not a sentence containing the link — but it is a judgement and it is load-bearing for the
`/customers` count below.

### 5.2 ⛔ My ≤12px threshold is the same error one level up. Retracted.

Said as plainly as §1.1's overcount, because it is the same lesson and it is mine:

**I anchored both methods on `text size ≤ 12px`, and on a boolean `has any padding`. Both are
proxies. The rule is a box height in pixels. My threshold is a spelling; the box is the shape.**

Two worked instances, neither of which my census could ever have reached:

1. **`customers/page.tsx:93`** — `<Link className="underline underline-offset-2 hover:no-underline">`,
   inheriting `text-sm`. **Rendered 196×19px.** It carries no small-text class at all. My census saw
   `14px > 12px` and filed it under the 76 I dismissed as *"inherits text-sm — out of this defect's
   scope"*. It is 19px tall against a 24px floor. **I wrote the dismissal myself, in a table, in
   §1.**
2. **`customers/page.tsx:131`** — a submit button, `px-2 py-0.5 text-xs`. **Rendered 56×22px.** My
   Method 2 excluded it because `hasPad` was true. But `py-0.5` is **2px a side**; padding is a
   *quantity*, and I tested it as a *boolean*.

⛔ **That is the third and fourth time in one task that I encoded a proxy where a shape was
needed** — after the `type="hidden"` overcount (§1.1) and the prose heuristic (§1.1). The spec did
it, the register did it, and I did it three times while writing the analysis that names the pattern.
The pattern is not a thing careful people avoid; it is the default failure mode of asking a source
file a question about a rendered box.

### 5.3 Re-anchored on authored box geometry — the orchestrator's question 3

**Yes, and it is strictly better.** Same TS compiler API pass, but instead of reading a text-size
class it computes an **authored box height**: resolved font size → Tailwind line-height, plus
`py-*`/`pt-*`/`pb-*`, plus border, or an explicit `h-*`/`min-h-*` where one is set. Floor 24px
(WCAG 2.5.8 AA).

**Validated against the orchestrator's pixels before being trusted** — this is the positive control
that matters, because a geometry model that predicts nothing is as useless as a resolver that
resolves nothing:

| Site | modelled | measured | |
|---|---|---|---|
| `customers/page.tsx:131` | 22px | **22px** | exact |
| `customers/page.tsx:93` | 20px | **19px** | 1px — CSS line-height vs an inline box's content height |

**The recount, whole tree, 1,007 interactive controls:**

| | |
|---|---|
| **RESOLVED from authored geometry** | **925 (92%)** |
| ⤷ PASS (≥24px) | 770 |
| ⤷ **FAIL (<24px)** | **155**, across 79 files |
| **UNRESOLVED → FAIL by construction** | **82 (8%)** |
| ⤷ checkbox/radio — intrinsic ~13px box, font-independent | 35 |
| ⤷ `input`/`select`/`textarea` with no authored padding (UA-sized) | 3 |
| ⤷ foreign component (`TokenReveal`, `SidebarNav`) | 3 |
| ⤷ ancestry truncated, no size resolvable | 41 |

⭐ **The number that reframes the defect: of the 155, only 26 carry or inherit `text-xs`. 129 are at
`text-sm` or larger.** DEF-269 is written as *"the guard cannot see an inherited small size"* — 16
instances. The real defect is *"the guard is keyed on text size at all"* — **155 candidates, of
which 129 lie outside the `text-xs` framing entirely and no text-anchored guard reaches at any level
of sophistication.** The text-anchored census in §1 reached about a tenth of its own subject.

⚠️ **155 candidates is NOT 155 defects, and the gap is §5.1's.** 128 of the 155 model at 20px, and
20px is overwhelmingly the inline `text-sm` link — precisely the class the browser pass found
**100% inline-exempt** on four pages. The source layer can enumerate 155 cheaply and **cannot
triage a single one**. That is not a flaw to fix; it is the division of labour.

**My falsifier 2 does not fire — 8%, not the >10% that would hand it to Arm C. But it nearly did,
and for an instructive reason.** My first refined pass reported **69% unresolved** because I marked
every capitalised JSX tag opaque — including `<Link>`, which renders a plain `<a>` and is entirely
transparent. Correcting that one misclassification moved the number from 69% to 8% and decided a
falsifier. ⛔ **A fifth proxy error, and the closest one to changing the recommendation.** The 8%
should be read as *the value under my definition of opaque*, not as a property of the tree.

### 5.4 What this changes in the recommendation — and what it does not

**Unchanged, and now better evidenced:** PASS / FAIL / **UNRESOLVED where UNRESOLVED FAILS**. It was
always the load-bearing idea, and §5.3 gives it a concrete, nameable UNRESOLVED bucket — 82 controls
in four named classes, not a vague admission. The 35 checkbox/radio are **permanently** unresolvable
from source at any sophistication: their box is intrinsic and font-independent. A guard that fails
closed on them is telling the truth; one that reports green is not.

**Changed:** the guard is re-anchored on **authored box geometry, not text size**. `text-xs` stops
being the subject and becomes one input to a height calculation. This subsumes DEF-239, DEF-243 and
DEF-269 as special cases of one rule — *a control's authored box must reach 24px, or it must be
unresolvable and say so* — and it is the only version that reaches `customers:93`.

**Endorsed:** the orchestrator's two-layer ruling, and my §3.1 pricing of Arm B is superseded by it.
I priced Arm B as "build the harness T-249 §9 ruled out" and judged it not worth it for ~16
controls. That pricing was wrong in both terms: the population is ~155, and the harness cost turned
out to be twenty minutes because it is **a smoke script, not a unit test**. T-249 §9's ruling stands
exactly as written — rendering cannot be the fast CI guard, since it needs a dev server, a
signed-in store-scoped session and seeded data — but it never forbade a periodic rendered check,
and I read it as if it had. Two layers, neither the only one for the risk (bible §15.11): the source
guard enumerates and fails closed; the rendered pass triages inline-vs-standalone and measures real
geometry.

### 5.5 FOR IAN — what changed since §4

**The good news first: the thing I asked you to check came back clean.** Those 16 links on the four
settings pages all sit inside sentences, exactly as I guessed, so they are mostly not defects. My
recommendation was right-sized for them.

**The bad news is that I was looking at the wrong pages, and my own rule was too narrow.** The
orchestrator checked one page I had not flagged — the customers list — and found 10 real ones. They
were invisible to me because I had decided to only count text below a certain size, and these are
*just* above it: 14px text with no padding is 19px tall, and the floor is 24px. **A link can be too
small to tap without being written in small text at all.** Re-counting by actual box height instead
of text size takes the candidate list from 16 to **155**.

**Most of those 155 are still probably fine** — they are links inside sentences, which the standard
exempts. But nobody can tell which from the code alone; that needs a browser.

**So the answer is two checks, not one**, and this is the orchestrator's call which I think is
right: a fast automatic one that runs on every change and **fails when it cannot work something
out** rather than quietly passing, plus a slower browser check run periodically that catches what
the fast one structurally cannot. Neither alone is enough.

**Your two decisions from §4 stand, and one got sharper.** Checkboxes and radio buttons — there are
35 — can *never* be checked by the fast test, because their size has nothing to do with text at all.
They will always come back "cannot determine". Whether that should fail the build or be formally
exempted is a call I should not make for you.

**One thing about me, for the record.** I made the same mistake five times in this task — the
mistake the task exists to fix. Each time it looked like a reasonable simplification and each time
it was a guess wearing a number's clothing. Two of the five I caught myself; the third and fourth
were caught by the orchestrator's browser pass; the fifth I caught only because correcting the
fourth made me re-examine a figure that had looked fine. That is the argument for the two layers
better than anything in §3.

---

# 6. BUILD SPEC — T-262 Phase 2 (APPROVED 2026-09-10)

> **Read this section and §6.12 only. You do not need §§1–5** — they are the analysis that produced
> this, kept for the record. Everything you need to build is here.
>
> **Approved by the orchestrator on 2026-09-10**, with two rulings by Ian carried in §6.1. Phase 1
> produced a written recommendation; this is the implementation of it. Model: **Sonnet** (this
> executes an approved spec; bible §13 row 184).

## 6.0 What you are building, assuming you know nothing about this

`apps/erp/tests/action-link-sweep.test.ts` is a unit test that walks `apps/erp/src` as **text** and
asserts that no interactive control is too small to tap on a phone. It is green, and its green is
not trustworthy: it looks for the two Tailwind classes `text-xs` and `underline` appearing in the
same `className` attribute value. That is a **spelling**. The thing the rule is actually about is a
**box height in pixels**.

Two consequences, both measured:

- A control that carries `underline` but takes `text-xs` from an ancestor element matches nothing,
  is counted as absent, and the sweep reports success. (This is the logged defect, DEF-269.)
- ⛔ **The larger half, which DEF-269 does not say:** a control with *no small-text class at all*
  can still be under the floor. `text-sm` is 14px text on a 20px line box, and 20px < 24px. **127 of
  the 151 undersized controls in this tree are `text-sm` or larger**, and no guard keyed on text
  size reaches them at any level of sophistication.

**You are replacing the text matcher with an authored-box-geometry model, and — this is the
load-bearing part — making the guard FAIL when it cannot work a control out, instead of passing.**

## 6.1 The rule you are asserting, and Ian's two rulings

> **Every interactive control's authored box must reach 24px, or the guard must be unable to
> resolve it and say so by failing.**

24px is WCAG 2.2 SC **2.5.8 Target Size (Minimum), Level AA**. (2.5.5 Enhanced is 44×44 and is
*not* the bar here; do not raise the floor to 44 — a measured ruling in DEF-244 found 44px targets
on the customers table overlap by 3.2px and open the wrong row, which is worse than the defect.)

**Ian's rulings, 2026-09-10 — both binding:**

1. ⭐ **Checkbox and radio inputs ARE in scope.** Their box is *intrinsic* — about 13×13px in
   Chrome — and does **not** scale with font size. They are therefore **permanently unresolvable
   from source at any level of sophistication**, and must land in UNRESOLVED and FAIL. There are
   **35** in this tree. Ian chose this knowing it means a text-size guard is inadequate by
   construction. Do not add a special case that quietly passes them.
2. ⭐ **The governing line, adopted project-wide:** *a source scanner may assert what the author
   **wrote** on the element; never what the browser **computes** — inheritance, cascade, UA
   defaults, intrinsic control sizing, layout. Inheritance is the one computed property it may
   approximate, because authored ancestry sits in the same file; it must approximate it explicitly
   and **fail where the approximation runs out.**

## 6.2 The geometry model, specified to reimplement

Parse with the **TypeScript compiler API** (`typescript` 5.9.3, already a repo dependency —
`ts.createSourceFile(..., ScriptKind.TSX)`). ⛔ **Do not walk JSX nesting with a regex.** Ancestry
needs a real AST; a regex doing it would repeat the exact error this task exists to correct.

**Step 1 — resolve the element's `className`.** Handle all four shapes; the current guard handles
only the first two and that is one of its two confessed blind spots:

| Shape | How |
|---|---|
| `className="..."` | string literal |
| ``className={`...`}`` | template — concatenate literal spans |
| `className={SOME_CONST}` | **resolve the constant.** Build a module-level map of `const NAME = '<string>'` across the tree first. **364 interactive controls take their class this way** |
| `className={cond ? A : B}` | gather every string-ish operand; if any part is unresolvable, the element is UNRESOLVED |

**Step 2 — resolve the effective font size.** The element's own unconditional `text-<size>` class,
else walk **authored JSX ancestors** to the nearest one that sets one. ⚠️ A **variant-prefixed**
class (`sm:text-xs`, `hover:text-lg`) is conditional and is **not** the base box — skip it when
resolving, or you will model a shape that only exists at one breakpoint.

**Step 2b — ⛔ resolve geometry from the app's OWN stylesheet too, not only from Tailwind
utilities.** This step was missing from the first draft of this spec and it produced a false
positive that was off by 3.4× (§6.10, §6.12). A `className` may carry a hand-authored class whose
rule lives in CSS:

| Class | Rule | Where |
|---|---|---|
| `.shell-nav-row` | `min-height: 36px`, and **`44px` under `@media (pointer: coarse)`** | `apps/erp/src/app/globals.css:86-93` |

⭐ **Assert against the SMALLEST authored height — here 36px, not 44px.** A media query means a
control has more than one authored height, and the guard's job is the worst case: if the smallest
clears 24px, every larger variant does too. (For `.shell-nav-row` both clear it comfortably; on a
real touch device it is 44px, which beats the 32px `ACTION_LINK` settles for.)

⚠️ **Verified 2026-09-10, and worth re-verifying rather than trusting:** `globals.css` is the
**only** stylesheet under `apps/erp`, and `.shell-nav-row` is the **only** selector in it that sets
a box dimension. The other custom classes in the tree — `shell-sidebar`, `shell-sidebar-nav`,
`shell-sidebar-expanded-only`, `shell-sidebar-collapsed-only`, `shell-sidebar-collapse-icon` —
control width, display or transform, never height. A handful of bare status words (`posted`,
`voided`, `paused`, `internal`, `alarm`, …) appear in `className` values and **match no rule in any
stylesheet**, so they set nothing. See §6.7 for the invariant that keeps this true.

**Step 3 — compute the box.**

```
box = explicit h-* / min-h-*  or a stylesheet min-height   if one is set
    = lineHeight(font) + 2·padY + border                    otherwise
```

| Input | Values |
|---|---|
| Tailwind font→line-height (px) | `xs` 12→**16** · `sm` 14→**20** · `base` 16→**24** · `lg` 18→**28** · `xl` 20→**28** · `2xl` 24→**32** · `3xl` 30→**36** |
| `leading-*` overrides line-height | `none` ×1 · `tight` ×1.25 · `snug` ×1.375 · `normal` ×1.5 · `relaxed` ×1.625 · `loose` ×2 · `leading-<n>` = n×4px absolute |
| Spacing scale | `n` → n×4px; `px` → 1px; the half steps land on `0.5`=2 `1.5`=6 `2.5`=10 `3.5`=14 |
| `padY` | `py-n` → n×4 each side. `pt-n`/`pb-n` → sum the two sides. `p-n` counts as `py-n` |
| `border` | `border` → 1px each side (**2px total**). `border-<n>` → n px each side |
| Floor | **24px** |

**Step 4 — the model must pass its own test before you trust its output.** These two are measured
in a real browser at 390×844 and are the model's fixtures. ⭐ **Write them as assertions. A geometry
model that predicts nothing is as useless as a resolver that resolves nothing.**

| Site | model must produce | measured in browser |
|---|---|---|
| `app/customers/page.tsx:131` — `<button className="px-2 py-0.5 text-xs …">` | **22px** | 56×**22**px — exact |
| `app/customers/page.tsx:93` — `<Link className="underline underline-offset-2 hover:no-underline">` inheriting `text-sm` | **20px** | 196×**19**px |

⚠️ The 1px on the second is understood and is not model error: CSS `line-height` is 20px, but an
`display:inline` element's *rendered* box is its content height, which is font-metric-dependent.
**Assert 20px and record why it is not 19.** If your model produces 19 for it, you have modelled
inline content height and will then be wrong on every block-level control — do not "fix" it.

## 6.3 The partition — PASS / FAIL / UNRESOLVED, where UNRESOLVED FAILS

⭐ **This is the actual fix, and it matters more than the census.** Today the guard cannot tell *"I
checked and it is fine"* from *"I could not see it"*, and reports both as green. That is the
mechanism by which an undersized button survived both the original census and the guard built to
stop it. Every interactive control lands in exactly one bucket:

| Bucket | Meaning | Test result |
|---|---|---|
| **PASS** | box resolved, ≥24px | pass |
| **FAIL** | box resolved, <24px | **fail** |
| **UNRESOLVED** | box not resolvable from source | ⛔ **fail** |

**The four unresolvable classes, named and counted so you can check your implementation against
mine.** Total **78 of 1,007 interactive controls (8%)**:

| Class | n | Why |
|---|---|---|
| checkbox / radio | **35** | intrinsic ~13px box, font-independent. **Permanently unresolvable.** Ian's ruling §6.1 |
| `input`/`select`/`textarea` with no authored padding | 3 | UA stylesheet supplies the padding; not in source |
| foreign component (`TokenReveal`, `SidebarNav`) | 3 | opaque; the box is decided inside the component |
| ancestry truncated — no font size resolvable | 37 | the chain ends at a component boundary |

⛔ **State your own opaque-set explicitly in the test file; do not inherit mine silently.** This is
not politeness — **my first pass at this classification reported 69% unresolved, because I marked
every capitalised JSX tag opaque, including `<Link>`, which renders a plain `<a>` and is entirely
transparent. Correcting that one assumption moved the figure 69% → 8% and flipped a falsifier.** A
number that swings 60 points on one judgement call is a number that can be tuned without anyone
noticing. Read 8% as *the value under this definition of opaque*, not as a property of the tree, and
write your definition down where a reviewer can disagree with it.

## 6.4 ⛔ 151 CANDIDATES IS NOT 151 DEFECTS. DO NOT FIX THEM.

**Your job is to build the guard, not to fix the 155.** Read this twice before touching a page file.

The rendered pass (§6.5) measured four pages at 390px and found **23 undersized controls, of which
23 were inline and 0 were standalone.** WCAG 2.5.8 carries an **inline exception** for a target
sitting within a sentence — "the registered name and TIN are the organisation's — *set them
once*." — and on the measured evidence, **essentially all of the inline `text-sm` link class is
exempt.** 127 of the 151 model at exactly 20px and are overwhelmingly that class.

⚠️ **That rendered result covers 390px only, and the orchestrator has re-scoped it:** controls that
do not render at 390px — the entire app shell among them — were outside its reach, at 0×0. It is
being re-run at 1280 as well. **Treat "23 inline, 0 standalone" as a measurement of one breakpoint,
not of the app.**

⭐ **The source layer enumerates. It triages nothing.** Whether a link renders inline in a sentence
or standalone on its own row is a rendered-layout fact that is not present in the source in any
form. A previous attempt to infer it from source got **3 of 16 wrong**. If you "fix" the 151 you
will be changing ~127 controls that are compliant, on 76 files no defect has complained about.

**So: the new guard starts with the 151 in an explicit, reasoned baseline list** (§6.12), each entry
carrying its modelled height — not an empty allowlist and not a green tree. Removing entries from
that baseline is a *later*, separately-scoped task driven by the rendered pass's triage. Your
deliverable is a guard that is **honest and red where it should be red**, not a green one.

## 6.5 Two layers, and neither is the only one for the risk (bible §15.11)

| Layer | What | Where |
|---|---|---|
| **Fast, every change** | your source guard — enumerates, resolves geometry, fails closed on what it cannot see | `apps/erp/tests/action-link-sweep.test.ts` (CI) |
| **Periodic, rendered** | `smoke-t262.mjs` — real Playwright at 390×844, triages inline-vs-standalone, measures true pixels | orchestrator-run; needs dev server + signed-in store-scoped session + seeded data |

⚠️ **`docs/tasks/249-*.md` §9 ruled out rendering and that ruling stands** — rendering cannot be the
fast unit-test guard, for exactly the reasons in the right-hand column. **It never forbade a
periodic rendered check.** Do not attempt to render anything from the unit test, and do not start a
dev server or a browser.

## 6.6 What this subsumes — the argument for the size of the change

One rule replaces three defects' worth of special cases:

| Defect | Was | Becomes |
|---|---|---|
| **DEF-239** | 4 instances of the literal `text-xs underline underline-offset-2` | a box under 24px |
| **DEF-243** | 5 more that spliced in `text-neutral-500`, breaking substring matching but not geometry | a box under 24px |
| **DEF-269** | a control inheriting `text-xs` from an ancestor | a box under 24px, with inheritance resolved |
| *newly reachable* | `text-sm` with no padding (20px); `text-xs` with `py-0.5` (22px); intrinsic checkboxes (13px) | a box under 24px, or UNRESOLVED |

`text-xs` stops being the subject and becomes one input to a height calculation. `underline` stops
being mentioned at all — it is a text decoration, never was a size, and anchoring on it is what
undercounted every previous census.

## 6.7 Invariants you must not break

- ⛔ **`TARGET_FILES` stays exactly as it is.** DEF-270 records that dropping a page from it would
  have a UI task quietly weakening a guard, judged strictly worse than the bundling it avoided.
  Keep the existing `it('each target file uses ACTION_LINK')` case unchanged.
- ⛔ **Two non-zero controls, both required.** (a) the file walk still asserts `files.length > 100`
  (currently **276**); (b) **new**: the resolver must positively identify the 8 known `ACTION_LINK`
  sites and report them PASS at 32px. A resolver that silently resolves nothing reports "0
  undersized" and is indistinguishable from a clean tree — (b) is the check that separates them.
- **`ACTION_LINK` drift guard stays** (`py-2` and `-my-2` in `components/action-link.ts`).
- ⭐ **NEW — assert that `globals.css` is the only stylesheet under `apps/erp`.** Step 2b's
  correctness depends on it: the model concludes "this class token sets nothing" from having parsed
  every stylesheet there is. If a second one appears and the guard has not been taught to read it,
  the guard must go **red loudly**, not keep resolving against a partial picture. This is the same
  fail-closed principle as UNRESOLVED, applied to the guard's own inputs.
- The `(?<!no-)` / `(?!-)` handling exists because `hover:no-underline` and `underline-offset-*`
  both contain "underline". If you keep any underline matching at all, it inherits that requirement
  — but you should not need it.

## 6.8 Scope — files you may touch

- `apps/erp/tests/action-link-sweep.test.ts` — rewrite
- a new helper beside it if the resolver deserves its own file
- **nothing else.** ⛔ No page file, no component, no `packages/**`. If the guard's own red output
  makes you want to fix a page, that is §6.4 and the answer is no.

## 6.9 Done when

typecheck clean · the new test runs and is **red in a way that names the 155 with their modelled
heights and the 82 unresolved with their reason** · the two model fixtures in §6.2 step 4 pass as
assertions · both non-zero controls pass · `TARGET_FILES` untouched · `npm run build` succeeds with
the dev server stopped · self-reviewed line by line · report ends with a `FOR IAN` block.

⛔ **Do not run `npm run test:integration`** — it hits the shared database and truncates a peer's
fixtures (DEF-268). This is a unit test; run it directly with vitest.

## 6.10 Your falsifier — required in your report

⭐ **This falsifier has already FIRED ONCE, in review, before a line was built — which is worth more
than three that never have.** The first draft of this spec reported 155 FAIL / 82 UNRESOLVED and
included a confident off-task pointer naming `components/shell/SidebarNav.tsx:127` as modelling
**13px** — "the smallest in the tree", highest reach, weakest exemption case, triage it first.

**It was a false positive off by 3.4×.** Those controls carry `shell-nav-row`, a hand-authored class
in `globals.css` setting `min-height: 36px` — and **44px under a coarse pointer**, so on a real
touch device they beat every `ACTION_LINK` in the app. The model read Tailwind utilities only, found
no `py-*` and no `min-h-*`, and **concluded "no vertical padding" where it should have concluded "I
cannot see".** It resolved a control it could not actually resolve — the precise failure this whole
task exists to correct, arriving in the tool built to correct it. The orchestrator caught it by
opening one CSS file.

⛔ **Had it shipped, §6.12 would have sent a lane to degrade the three best tap targets in the
app.** Corrected counts after teaching the model to read `globals.css`: **151 FAIL / 78
UNRESOLVED** — and note it moved in *both* directions, removing 4 false failures and newly resolving
4 controls that had been unresolvable. A blind spot costs you accuracy, not just coverage.

**Now: state what would have to be true for YOUR implementation to be wrong**, and check the three
already known to be load-bearing:

1. **If your UNRESOLVED count differs materially from 78 (8%), one of us has a different opaque-set
   — say which and why.** Higher is not automatically worse; it may mean you were stricter and more
   honest. But a number much *lower* than 78 means you resolved something you should not have, and
   that is the failure mode this whole task is about.
2. **If your modelled heights disagree with the two browser fixtures**, the model is wrong and the
   census built on it is worthless — stop and report, do not adjust the fixtures.
3. Name a control class your resolver claims to handle that you have **not** actually verified
   against a real rendered pixel. That class is your risk.

## 6.11 One correction carried forward

The Phase-1 spec's "Watch out" warns that three files use CRLF and a line-ending-sensitive sweep
would skip them. **Re-filed as a general note, not a watch-out for this task**, and the figure was
wrong: it is **26 CRLF files of 276 under `apps/erp/src`** (23 of 232 under `apps/erp/src/app`).
26 is the figure that applies, because the guard's `walk()` starts at `src`. It does not affect this
task either way — neither the old regex nor an AST pass splits on a line ending — but any *future*
line-wise sweep is exposed, and one already produced a wrong count once (DEF-278's "4 of 18" against
a true "17 of 26").

## 6.12 The baseline — 151 undersized controls across 76 files

Modelled authored box height in px, at the 24px floor, from the census described in §6.2 **including
step 2b's stylesheet resolution**. Format: `line:tag/modelledPx`. ⚠️ **This is a baseline to encode,
not a worklist to fix — see §6.4.**

> ⛔ **RETRACTED, and left visible on purpose.** An earlier draft of this section closed with a
> confident off-task pointer: that `components/shell/Sidebar.tsx:150`, `SidebarNav.tsx:127` and
> `TopBar.tsx:38` were undersized, that `SidebarNav.tsx:127` at **13px** was "the smallest in the
> tree", that they render on every page so had the highest reach, that being navigation chrome
> rather than prose made them least likely to be exempt — and that they should be triaged first.
>
> **Every word of the reasoning was sound and the number underneath it was wrong.** They carry
> `shell-nav-row`, which sets `min-height: 36px` in `globals.css` and `44px` under a coarse
> pointer. Measured in the browser: **239×36px and 214×36px at 1280.** They are not the worst
> targets in the app; on a touch device they are among the **best**, clearing the 44px
> Apple/Material bar that `ACTION_LINK`'s 32px deliberately does not.
>
> ⛔ **This is what makes it worth keeping rather than deleting: it was the most actionable-looking
> line in the document, and acting on it would have degraded three of the app's strongest
> controls.** The model had looked in exactly one place for authored geometry — Tailwind utilities —
> and treated "I did not find padding" as "there is no padding". Confident, specific, well-argued,
> and false, because a proxy was mistaken for the thing itself. That is the same failure as the
> `underline` anchor, the `≤12px` threshold, the has-any-padding boolean and the opaque-set — the
> fifth or sixth instance depending on how you count, and the only one that reached an approved
> document. §6.2 step 2b is the fix; §6.10 is the record.

| File (under `apps/erp/src/`) | n | `line:tag/px` |
|---|---|---|
| `app/admin/stores/[id]/page.tsx` | 3 | 46:Link/20 65:Link/20 177:Link/16 |
| `app/admin/stores/page.tsx` | 1 | 67:Link/20 |
| `app/admin/users/[personId]/page.tsx` | 3 | 50:a/20 214:summary/16 249:a/20 |
| `app/admin/users/page.tsx` | 2 | 57:a/20 84:a/20 |
| `app/ap/invoices/[id]/page.tsx` | 4 | 66:a/20 224:a/20 274:a/20 328:a/20 |
| `app/ap/page.tsx` | 2 | 61:Link/20 87:Link/20 |
| `app/ap/suppliers/[id]/page.tsx` | 3 | 57:a/20 83:summary/20 215:a/20 |
| `app/ap/suppliers/page.tsx` | 1 | 116:Link/20 |
| `app/attendance/[dayId]/page.tsx` | 1 | 83:Link/20 |
| `app/attendance/lane/page.tsx` | 2 | 200:Link/16 391:summary/16 |
| `app/budgets/page.tsx` | 4 | 63:Link/20 84:Link/20 179:summary/16 224:summary/20 |
| `app/cash-requests/[id]/page.tsx` | 1 | 56:Link/20 |
| `app/cash-requests/page.tsx` | 1 | 105:Link/20 |
| `app/commissary/catalogue/page.tsx` | 1 | 138:Link/20 |
| `app/commissary/discrepancies/page.tsx` | 1 | 143:Link/20 |
| `app/commissary/orders/[id]/page.tsx` | 3 | 79:Link/20 207:Link/16 473:Link/20 |
| `app/commissary/orders/page.tsx` | 5 | 114:Link/16 124:Link/20 145:Link/20 182:Link/20 193:Link/20 |
| `app/customers/[customerId]/page.tsx` | 3 | 103:Link/20 340:Link/16 464:Link/16 |
| `app/customers/page.tsx` | 4 | 52:Link/20 93:Link/20 125:input/22 131:button/22 |
| `app/customers/price-lists/[id]/page.tsx` | 1 | 37:Link/20 |
| `app/customers/price-lists/page.tsx` | 1 | 27:Link/20 |
| `app/expenses/[id]/page.tsx` | 2 | 107:a/20 143:a/20 |
| `app/expenses/new/page.tsx` | 2 | 52:a/20 65:a/20 |
| `app/expenses/page.tsx` | 1 | 130:a/20 |
| `app/expenses/recurring/page.tsx` | 3 | 77:Link/20 204:Link/16 214:summary/16 |
| `app/findings/page.tsx` | 1 | 50:Link/20 |
| `app/findings/scorecard/page.tsx` | 1 | 32:Link/20 |
| `app/fixed-assets/[id]/page.tsx` | 1 | 64:a/20 |
| `app/fixed-assets/new/page.tsx` | 1 | 141:a/20 |
| `app/fixed-assets/page.tsx` | 2 | 113:a/20 223:a/20 |
| `app/inventory/counts/[id]/page.tsx` | 2 | 105:Link/20 263:Link/20 |
| `app/inventory/counts/page.tsx` | 2 | 54:Link/20 162:Link/20 |
| `app/inventory/deliveries/[id]/page.tsx` | 3 | 57:Link/20 113:Link/20 218:Link/20 |
| `app/inventory/deliveries/page.tsx` | 2 | 63:Link/20 131:Link/20 |
| `app/inventory/locations/page.tsx` | 1 | 75:Link/20 |
| `app/inventory/low-stock/page.tsx` | 1 | 59:Link/20 |
| `app/inventory/page.tsx` | 8 | 44:Link/20 47:Link/20 50:Link/20 53:Link/20 56:Link/20 59:Link/20 62:Link/20 130:Link/20 |
| `app/inventory/pos-map/page.tsx` | 1 | 53:Link/20 |
| `app/inventory/pos-usage/page.tsx` | 1 | 176:Link/20 |
| `app/inventory/production/[id]/page.tsx` | 1 | 53:Link/20 |
| `app/inventory/production/page.tsx` | 3 | 59:Link/20 92:Link/20 162:Link/20 |
| `app/inventory/returns/page.tsx` | 1 | 115:Link/20 |
| `app/inventory/transfers/page.tsx` | 1 | 92:Link/20 |
| `app/inventory/usage/[id]/page.tsx` | 3 | 46:Link/20 82:Link/20 159:Link/20 |
| `app/inventory/usage/page.tsx` | 3 | 58:Link/20 91:Link/20 132:Link/20 |
| `app/items/[id]/page.tsx` | 2 | 57:a/20 193:a/20 |
| `app/items/page.tsx` | 3 | 79:a/20 82:a/20 175:a/20 |
| `app/liabilities/[id]/page.tsx` | 1 | 51:Link/20 |
| `app/liabilities/page.tsx` | 2 | 58:Link/20 98:Link/20 |
| `app/loans/[id]/page.tsx` | 1 | 38:Link/20 |
| `app/loans/page.tsx` | 1 | 77:Link/20 |
| `app/money-accounts/page.tsx` | 1 | 50:Link/20 |
| `app/money-transfers/page.tsx` | 2 | 66:Link/20 112:Link/20 |
| `app/not-found.tsx` | 1 | 11:Link/20 |
| `app/owners/[id]/page.tsx` | 1 | 56:Link/20 |
| `app/owners/page.tsx` | 2 | 74:Link/20 109:Link/20 |
| `app/payroll/page.tsx` | 3 | 90:a/20 93:a/20 145:a/16 |
| `app/payroll/separations/page.tsx` | 2 | 71:a/20 111:a/20 |
| `app/prepaid/[id]/page.tsx` | 2 | 41:Link/20 93:Link/20 |
| `app/prepaid/page.tsx` | 1 | 135:Link/20 |
| `app/sales-days/[id]/page.tsx` | 1 | 80:a/20 |
| `app/sales-days/new/page.tsx` | 1 | 38:a/20 |
| `app/sales-days/page.tsx` | 2 | 76:a/20 136:a/20 |
| `app/settings/attendance/page.tsx` | 1 | 54:a/20 |
| `app/settings/expense-categories/page.tsx` | 2 | 57:a/16 246:a/16 |
| `app/settings/organization/page.tsx` | 2 | 58:a/16 67:a/20 |
| `app/settings/sales-channels/page.tsx` | 4 | 64:a/20 163:a/16 177:a/16 220:a/16 |
| `app/settings/wastage-monitor/page.tsx` | 3 | 134:a/20 175:a/16 187:a/16 |
| `app/staff/[employmentId]/page.tsx` | 3 | 41:a/20 165:a/20 178:a/20 |
| `app/staff/hire/page.tsx` | 1 | 56:a/20 |
| `app/staff/page.tsx` | 1 | 104:Link/20 |
| `app/trade/orders/[id]/page.tsx` | 2 | 61:Link/20 112:Link/20 |
| `app/trade/orders/page.tsx` | 2 | 40:Link/20 105:Link/20 |
| `app/trade/returns/page.tsx` | 1 | 115:Link/20 |
| `app/wastage/[id]/page.tsx` | 1 | 84:Link/20 |
| `app/wastage/page.tsx` | 5 | 198:a/16 202:a/16 222:Link/20 250:Link/20 282:Link/20 |

⭐ **No `components/shell/*` row appears above, and that absence is the corrected result** — all
five `shell-nav-row` controls resolve to 36px and PASS. See the retraction at the head of this
section.

**Plus 78 UNRESOLVED**, which under this spec also fail: 35 checkbox/radio · 3 UA-sized
`input`/`select`/`textarea` · 3 foreign components · 37 ancestry-truncated.

⚠️ **Two controls in `components/shell/Sidebar.tsx` are in that UNRESOLVED bucket, not the pass
list** — `:230` (a `<div>` with a handler, no resolvable font size) and `:268` (`<SidebarNav>`, a
foreign component). They fail by construction, correctly: the guard cannot see them and says so.
Do not "fix" them either; they need a rendered measurement, not an edit.

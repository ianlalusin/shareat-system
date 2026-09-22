# T-334 slice 2 — the contract for `Button`, `Input`, `Card`

**Status:** ✅ **BUILT 2026-09-22.** Tester `webapps-d1`, builder `webapps-4d`, audited (`/code-review high`).
**Gates:** typecheck 0 · unit 142 files / 1947 passed · build 0 · ⚠️ integration 3/2982 failed, **all DEF-412, pre-existing** (see §10).
**Parent task:** `docs/tasks/334-v2-theme-brand-red-and-a-manual-dark-toggle.md` §3 SLICE 2.
**Authority:** `docs/decisions/ADR-013-v2-erp-theme-and-brand-colour.md` — Ian's ruling, 2026-09-19.
**Migration slot:** ⛔ **none.** No schema change. Report any need for one as BLOCKED.
**Depends on:** slice 1 (`bfa12ee`), which is **shipped and verified present**.

> ⛔ **THE PALETTE IS RULED AND CLOSED.** This slice consumes the tokens; it does not revisit them.
> ⛔ **NO SCREEN ADOPTS THESE COMPONENTS IN THIS SLICE.** That is deliberate — see §6.

---

## 1. Why this document exists

The parent task gives slice 2 three lines: *"`components/ui/{Button,Input,Card}.tsx` carrying the
tokens. Not adopted by any screen in this slice. ~half a day."* That is a size, not a contract.
Three things were measured on 2026-09-21 that change how this slice must be built, and none of
them is in the parent task:

| Measured | Consequence |
|---|---|
| The unit project's include glob is **`apps/**/*.test.ts`** — no `.tsx` variant | ⛔ **A `.test.tsx` file matches NOTHING and passes silently.** Same shape as DEF-081/DEF-221 |
| **No jsdom, no `@testing-library`, no `@vitejs/plugin-react`** anywhere in the tree | ⛔ There is **no React-rendering test capability**, and this slice must not invent one |
| `apps/erp/tests/filter-row.test.ts` already solved both | ⭐ **`createElement` + `renderToStaticMarkup`, in a `.ts` file, `environment: 'node'`.** Proven, in-tree, zero new dependencies |

⭐ **The precedent is binding: copy `filter-row.test.ts`'s shape.** Its header comment explains the
glob trap in its own words and exists precisely so the next person does not re-discover it.

---

## 2. The tokens these components consume

Slice 1 mapped the ruled palette into Tailwind (`apps/erp/tailwind.config.ts`). The utilities that
exist **today**, verified:

| Utility family | Token |
|---|---|
| `bg-brand` · `text-brand` · `border-brand` | `--brand` `#d40909` |
| `bg-brand-hover` | `--brand-hover` `#b00707` |
| `text-danger` · `border-danger` | `--danger` `#a00606` |
| `bg-danger-surface` | `--danger-surface` `#fde7e7` |
| `bg-warning` | `--warning` `#f4b942` |
| `bg-success` · `text-success` | `--success` `#059669` |
| `bg-canvas` | `--canvas` |
| `bg-surface` · `border-surface-border` | `--surface` / `--surface-border` |
| `text-ink` | `--ink` `#1a1a1a` |

⛔ **Every colour in these three components comes from that table.** No raw hex, no `red-600`, no
`amber-500`, no `gray-200`. That is mechanically checked — §4 guard 1.

⚠️ **The `color-mix` wrapper in `tailwind.config.ts` is load-bearing and must not be touched.** A
bare `var(--x)` silently emits no rule at all for any opacity-modified class.

---

## 3. The contract, component by component

### `Button` — `apps/erp/src/components/ui/Button.tsx`

Props: `variant?: 'primary' | 'secondary' | 'danger'` (default `'secondary'`), plus the native
button attributes it needs (`type`, `disabled`, `onClick`, `className`, `children`).

| Variant | Treatment | Rule it encodes |
|---|---|---|
| `primary` | **solid** `bg-brand text-white hover:bg-brand-hover` | ADR-013: the one primary action per view |
| `secondary` | neutral outline on `--surface`, `text-ink` | the default, so a careless caller does not get brand red |
| `danger` | ⛔ **OUTLINED — `border-danger text-danger`, never a solid fill — and it renders its own icon** | ADR-013 §1: *danger is a TREATMENT, not a hue* |

⭐⭐ **THE ICON IS RENDERED BY THE COMPONENT, NOT PASSED BY THE CALLER.** ADR-013 requires danger to
carry an icon *always*. A prop the caller may omit is a convention; an icon the component emits is
an invariant. ⛔ **Build it so a `danger` button without an icon is not expressible.**

⚠️ `type` defaults to `'button'`. An unspecified `type` inside a form submits it — a real bug, not
a style preference.

### `Input` — `apps/erp/src/components/ui/Input.tsx`

Props: `invalid?: boolean`, plus native input attributes.

- Base: `bg-surface border-surface-border text-ink`, focus ring on `--brand`.
- `invalid`: `border-danger` **and** `aria-invalid="true"`. ⭐ The ARIA attribute is not optional —
  a red border alone communicates nothing to a screen reader, and colour is never the sole channel.

### `Card` — `apps/erp/src/components/ui/Card.tsx`

Props: `className`, `children`. Renders `bg-surface border border-surface-border` with rounding and
padding consistent with what the app already uses.

⚠️ **All three append a passed `className` rather than replacing their own classes** — the
behaviour `filter-row.test.ts` already pins for `FilterRow`, and the same test belongs here.

---

## 4. Tests — the contract, not the pixels

⛔ **Do not screenshot-diff. Do not add jsdom.** `.test.ts` files, `createElement` +
`renderToStaticMarkup`, exactly as `apps/erp/tests/filter-row.test.ts` does it.

**Per-component behaviour:**
1. `primary` emits `bg-brand` and a `brand-hover` hover class.
2. `secondary` is the default when no `variant` is passed — asserted as a **literal**, positively.
3. ⭐ **`danger` emits NO solid brand/danger background, DOES emit a border/outline, and DOES emit
   an icon element.** These are three separate assertions; the third is the one that matters most
   and is the easiest to leave out.
4. `type` defaults to `button`; an explicit `type="submit"` survives.
5. `Input` with `invalid` emits both `border-danger` **and** `aria-invalid="true"` — ⭐ assert both;
   the ARIA half is the half that gets dropped.
6. All three append a passed `className` instead of replacing their own.

**Guards — and ⛔ EVERY ONE IS MUTATION-TESTED: break the thing and watch the test fail.**

7. ⭐ **Token discipline.** The three component sources contain no raw hex and no stock Tailwind
   colour utility (`red-\d`, `amber-\d`, `gray-\d`, `slate-\d`, …). ⛔ **STRIP COMMENTS BEFORE
   ASSERTING ON A FILE.** On 2026-09-21 a guard in this very task was satisfied by the prose
   describing it, and deleting the entire block it guarded left it green.
8. ⭐ **`--warning` never carries text.** No component emits `text-warning`. ADR-013: 1.77:1, fails
   every standard.
9. ⭐ **Danger is never filled.** No component emits `bg-danger` as a solid fill. `bg-danger-surface`
   is permitted; `bg-danger` is not. ⚠️ An unanchored substring match cannot tell those two apart —
   **assert on the class token, not on a substring.**

⚠️ **A test's name is not an assertion.** DEF-115 shipped green with the money half of its
invariant living in the test's title. If a case is called *"danger is never filled"*, the body must
be what proves it.

---

## 5. Invariants at every commit

1. ⛔ **No screen changes.** Nothing imports these components in this slice. The app must render
   byte-identically before and after.
2. ⛔ **All 3,488 existing `dark:` classes keep working.** Untouched by this slice.
3. ⛔ **No new dependency.** Not jsdom, not `@testing-library`, not a React vitest plugin.
4. ⛔ **No barrel file.** `components/ui/index.ts` is shared state and is the orchestrator's to add
   when something first imports it — not this slice's.
5. Danger outlined, never filled, always iconned. Warning never text. Primary is not decoration.

---

## 6. ⭐ The screen gate (§9.4), scoped honestly

⛔ **These components are adopted by NO screen in this slice, so there is no new screen behaviour to
demonstrate.** Claiming a feature smoketest here would be claiming something false.

**What §9.4 means for slice 2, and it is still mandatory:** a **non-regression** check. The app
boots on 9008, `/sign-in` and one shell screen load, both still render **light** with no flash, and
the console is clean. That proves the slice changed nothing user-visible — which is precisely what
it promised.

⚠️ **The session used is FORGED** (`docs/SMOKETEST.md` §3) and bypasses sign-in on purpose. It
proves things about screens and **nothing whatever about authentication.** Say so in the report.

---

## 7. Out of scope

- ⛔ Adopting these components on any screen. That is slice 3.
- ⛔ Re-pointing `red-*` usages. That is slice 4.
- ⛔ Re-opening the palette, or choosing dark mode's text reds (§7 of the parent task — Ian's, and
  still open).
- ⛔ `packages/ui` — it does not exist, and whether tokens eventually live there is undecided.
- ⛔ A theme-toggle control. Slice 1 shipped the mechanism and the default; the control is later.

## 8. Done when

Every §9 gate: typecheck clean · unit green · integration green on the lane DB · `npm run build`
with the dev server stopped · the §9.4 non-regression check of §6 above, with the screenshots
actually looked at · audited by a session that did not write the code · committed with a message
saying why.

---

# 9. ⭐ RULINGS — the lanes' spec questions, answered

> ⭐ **SIX gaps were found in §1–§8 above by the three lanes reading it before any code existed** —
> four by the auditor (`webapps-17`), one by the builder (`webapps-4d`), who independently found the
> same icon gap, and one by the tester (`webapps-d1`) — see **R6**. **Every one was real.** They are ruled here, in the document, because a ruling that
> lives only in a message is not a ruling the project has made (ADR-013's own lesson, learned the
> expensive way three days ago).
> ⛔ **§9 wins where it contradicts §1–§8.**

## R1 — `text-white` on the primary fill is PERMITTED, as a named exception

§3 says primary is `bg-brand text-white`, while §2 says every colour comes from the token table —
and the table has no white text token. **The auditor is right that these contradict.**

**Ruling: `text-white` is permitted, and only in this one position** — the contrast pair for a solid
`--brand` fill. It is chrome, not palette.

⛔ **The alternative was rejected deliberately:** adding a tenth `--on-brand` token would be
**re-opening the ruled palette**, which ADR-013 closes and which only Ian may do. A contradiction in
my contract is not licence to amend his ruling.
⚠️ `bg-white` remains **forbidden** — that is what `--canvas` and `--surface` are for. The exception
is `text-white`, exactly.

## R2 — Guard 7 gets a CLOSED list, not an example set

The auditor is right that `red-\d`, `amber-\d`, `gray-\d`, `slate-\d`, `…` cannot be
mutation-tested deterministically. **A guard whose forbidden set ends in an ellipsis is a guard
whose failure is a matter of opinion.**

**Ruling — the closed list is Tailwind's 22 default hues:**

```
slate gray zinc neutral stone red orange amber yellow lime green emerald
teal cyan sky blue indigo violet purple fuchsia pink rose
```

Guard 7 fails on `\b(<any of those 22>)-\d{2,3}\b` **or** on a hex literal (`#` followed by 3, 6 or
8 hex digits), in the three component sources, **with comments stripped first**.
⭐ **`text-white` is explicitly allowlisted** per R1; `bg-white` is not. `black`, `transparent`,
`current` and `inherit` carry no numeric suffix and so are not matched by the hue pattern — they are
**out of this guard's reach and that is accepted**, not overlooked.

## R3 — the danger icon: hand-drawn, inline, and detected by a CONTROL PAIR

Both lanes found this. There is no warning/alert glyph anywhere in the tree, and
`apps/erp/src/components/shell/icons.tsx` (the only icon set) has a provenance note explaining why
icons here are hand-drawn rather than copied from a library.

**Ruling on the glyph — the builder's own proposal, adopted as offered:** an original hand-drawn
warning triangle, **inline inside `Button.tsx`**, matching `shell/icons.tsx`'s idiom (24×24
`viewBox`, stroke, `stroke-width` 1.5), rendered `h-4 w-4`, leading, with `gap-2`, carrying
`aria-hidden="true"` and `focusable="false"`.
⭐ **Inline, not centralised in `shell/icons.tsx`** — that file is outside the builder's scope and
centralising one glyph is not worth a shared-state edit mid-slice. ⚠️ **If slice 3 needs the same
glyph elsewhere, moving it to `shell/icons.tsx` is slice 3's call, not a defect in this one.**

**Ruling on detection — and this is the part that decides whether the guard is worth anything.**
⛔ Do **not** invent a `data-` attribute that exists only to be asserted on. Assert the real thing,
as a **positive and negative control pair**:
- `variant="danger"` output **contains** `<svg` **and** `aria-hidden="true"`;
- `variant="primary"` and `variant="secondary"` output contains **no** `<svg` at all.

⭐ **The negative half is what gives the positive half meaning.** An assertion that an icon is
present, with no case proving it can ever be absent, is satisfied by a component that always renders
one — which is not the invariant. Mutation-test both halves.

## R4 — NO `'use client'` on any of the three, and no hooks

The auditor is right that this is invisible to slice 2's tests and would surface as a slice-3
defect. **Ruling: none of the three carries the directive, and none uses a React hook.**

⭐ **Reasoning, because the intuitive answer is the wrong one.** A component *without* `'use client'`
works in **both** graphs: rendered from a server component it stays server-rendered; imported by a
client component it is compiled into the client bundle. Adding the directive does not enable
`onClick` — it **forecloses** server use and pushes these three into the client bundle at every call
site, including the many buttons that are plain `type="submit"` inside a server-action form.
⛔ **The directive would therefore buy nothing and cost the slice-3 adoption path.** Accepting
`onClick` in the prop type is not the same as needing the directive; a server component that tries
to pass a function gets a clear framework error at that call site, which is slice 3's to meet.

**Guard 10 (new):** none of the three sources contains `'use client'`, and none imports `useState`,
`useEffect`, `useRef`, `useReducer`, `useContext` or `useMemo`. Comments stripped first.
⚠️ If the builder concludes a hook is genuinely required, that is **BLOCKED** — it would overturn
this ruling, not sit inside it.

## R6 — `secondary` is asserted by IDENTITY, not by one shared class

⛔ **This ruling existed only in a message for eight hours, and the auditor caught the discrepancy**
— §9's preamble said "five gaps" while the AUDIT briefing and `6346f64`'s subject line both said
six. **The sixth was this one, ruled to the tester in chat on 2026-09-22 and never written here.**

⭐⭐ **That is ADR-013's opening lesson recurring INSIDE the task ADR-013 produced**, on the same
day, by the same orchestrator who wrote that lesson up twice. A decision that lives only in a
message is not a decision the project has made — and the mechanism that caught it was not memory,
it was a **count that did not reconcile**. Two independent records of the same number disagreeing
is a cheap, mechanical tell, and it is the only reason this was recovered.

**The gap:** §4 case 2 asks for `secondary` to be asserted positively but never gives secondary's
utility set, the way §3 does for `primary` and `danger`. Found by the tester (`webapps-d1`).

**Ruling — both halves, as the tester proposed them:**
1. `text-ink` as the positive literal, since §3's prose names it for secondary.
2. ⭐ `Button({})` renders **byte-identically** to `Button({variant:'secondary'})`.

⭐ **The second is stronger than anything the contract specified.** It proves "secondary IS the
default" as an *identity*, not as a coincidence of two assertions that happen to agree: an
assertion that the no-variant output merely *contains* `text-ink` would also pass if the default
were a fourth, unnamed variant sharing one class. Byte-identity cannot.
⚠️ **Its limit, stated when it was approved:** byte-identity is only as strong as the two calls
being otherwise identical. Pass the same children and the same everything-else, or it proves
something narrower than it looks.

---

## R5 — ⛔ `Card` IS NOT PROTECTED BY THE ZERO-CALLER RATCHET, AND NOBODY SHOULD THINK IT IS

Found by the orchestrator on 2026-09-21 while running the unit suite over the pre-wired stubs.
`tests/unit/production-caller-ratchet.test.ts` correctly flagged **`Button`** and **`Input`** as
newly joining the zero-production-caller set — **and did not flag `Card`**, although `Card` is
exported from `apps/erp/src/components/ui/Card.tsx` and called by nothing.

**Cause: this is a fresh instance of DEF-403**, not a new defect — *"the production-caller census
counts JSX text as a call site, so shipping a word in user-facing copy silently deletes a real
zero-caller finding."* The word `Card` appears in user-facing strings (`'Card enrolled.'`,
`'Card clock-in is switched off for this store.'`), in JSX body text (`staff/[employmentId]/page.tsx:195`)
and in comment prose, and the census counts those as production callers.

⭐ **The transferable consequence, which is worse than this one component:** **any export named with
a common English word is invisible to a ratchet that gates the build.** `Card` is merely the one
that happened to prove it.

⚠️ **For this slice specifically:** `Button` and `Input` are ratchet-visible and will be carried on
the regenerated baseline with this task cited. `Card` is not, and its absence from that baseline is
**evidence of DEF-403, not evidence that `Card` has a caller.** ⛔ Nobody is to "fix" the baseline by
adding `Card` to it by hand — `docs/production-caller-baseline.txt` is generated, and hand-editing a
generated list beside its generator is DEF-240.

---

# 10. ⚠️ The gate this slice could not make green, and why it shipped anyway

**Final full-suite run, 2026-09-22** (not lane-scoped — the whole project):

```
PASS typecheck    0 type error(s)
PASS unit         142 files · 1947 passed | 1 skipped
FAIL integration  3 failed / 2982   ← packages/domain/tests/integration/findings.test.ts
PASS build        exit 0
```

⛔ **The three failures are DEF-412 and they are PRE-EXISTING on `main`.** T-332's
`attendanceConfigMissing` detector, shipped 2026-09-21, fires correctly at a fixture that asserts
every detector is silent. **Reproduced on a pristine database** (`shareat_test_probe412`, created
and migrated fresh) and **ruled out as caused by this slice** on the dependency direction: a package
can never import an app, which `tests/unit/app-boundaries.test.ts` enforces. The detector is right
and the fixture is stale.

⚠️ **This is recorded rather than glossed, because §9 of the bible says integration must pass and it
did not.** The honest statement is narrow: **this slice leaves `main` exactly as red as it found
it.** Every gate this slice can affect is green, including the full unit project and the build.

⭐ **The decision to commit was the orchestrator's, made explicitly:** holding finished, audited work
hostage to a defect it did not cause and must not fix mid-slice (a shared surface, mid-cycle, with
no task or tests of its own) serves nobody, and a commit is reversible in a way a lost afternoon of
context is not. ⛔ **It is NOT a claim that the definition of done was met.** It was not, on that one
gate, for that one reason, and DEF-412 carries the remedy.

⭐⭐ **THE FINDING WORTH MORE THAN THIS SLICE: a lane-scoped integration gate cannot certify a commit
to a shared tree.** `docs/ROADMAP.html`'s own masthead carried the evidence and nobody read it that
way — *"last FULL-SUITE run was T-328's, 20 Sep: 0 failed."* T-332 shipped on the 21st, and every
gate run since was scoped to the lane's own files (2 of 141), which is **green by construction** for
a lane that breaks a surface it does not own. ⛔ **Nineteen days earlier, DEF-126 recorded the same
lesson in almost the same words** — *"a file's own tests passing is not the same as the shared
surfaces it registers into being exercised"* — on the same shared surface, `listFindings`.

⚠️ **Open for Ian (not the orchestrator's to decide):** whether the orchestrator runs the FULL
integration suite before every commit. Measured here: **~33 minutes**. It would have caught this on
2026-09-21. The alternative is continuing on lane-scoped gates and accepting that this class recurs.

---

# 11. ⛔ AMENDMENT — §4's enumerated list was treated as the whole contract, and it left the components' core behaviour unasserted

**Raised by the auditor (`webapps-cb`, Opus) against `6346f64`, 2026-09-22. Scoped by Ian to be
fixed BEFORE slice 3 adopts these components across 65 files.**

## The measurement, which is what makes this a defect and not an opinion

The auditor rebuilt all three components in a scratchpad **from the committed class strings**, with
`{children}` and `{...rest}` removed and **nothing else changed**, then ran all eleven committed
behaviour assertions verbatim — including the two added after the first audit round.

> ⛔ **11 / 11 PASS.**

The mutant `Button` renders `<button type="button" class="…"></button>`: **no label, `disabled`
dropped, `onClick` dropped.** The mutant `Input` renders without `name`, `required` or
`placeholder`.

**Failure scenario:** slice 3 adopts `<Button>` on `/expenses`. A later refactor drops `{...rest}`.
Every submit button in the application loses `disabled`, so a double-click double-posts. Typecheck
clean, suite green, and the screen gate passes because at that moment nothing is adopted yet.

## ⭐ The root cause is this document, not the tester

⛔ **§4 enumerates what to assert and never asks what the enumeration leaves unconstrained.** The
tester followed it deliberately and said so in writing at `ui-card.test.ts:15-17`.
⚠️ **And §1 made the counter-example binding without anyone noticing:** `filter-row.test.ts:22` —
the precedent §1 instructs the lanes to copy — asserts `toContain('name="store"')`. **The precedent
pins the exact thing these four files leave open.**

## ⭐⭐ The general fault, which matters more than the fix

**This is the same shape as the geometry defect behind ADR-013 Amendment 3**, in a different
register: a spec that enumerated what to check, and a reader who treated the enumeration as the
contract.
- Amendment 3: the contract specified no geometry, so the builder picked one precedent out of
  seven, and the components match **29%** of the app's buttons and **0%** of its inputs.
- Here: the contract specified no children/attribute assertions, so the suite never required
  either component to **be a component at all**.

> ⛔ **A SPEC'S LIST OF CHECKS IS A FLOOR, AND EVERY SPEC IN THIS PROJECT SHOULD SAY SO IN ITS OWN
> WORDS.** Slice 3 executes against the same habit across 65 files, so its spec
> (`334-slice-3-retire-the-local-constants.md`) must name what its enumeration does **not** cover.

## What must be true before this is closed

1. **`Button` and `Card` render their children** — asserted on real content, not emptiness.
   ⚠️ **CORRECTED 2026-09-22, and the tester was right to flag it rather than decide it silently.**
   This requirement originally read *"each of the three components renders its children"*, which is
   **impossible for `Input`**: `<input>` is a void HTML element and takes no children, and §3 gives
   it no `children` prop. ⭐ The auditor's own mutant description corroborates the narrower reading
   — it names only `name`/`required`/`placeholder` for `Input`, never children. **`Input` is exempt
   from this item and covered entirely by item 2.**
2. Each **forwards native attributes through `{...rest}`** — at minimum `disabled` and `onClick` for
   `Button`; `name`, `required` and `placeholder` for `Input`.
3. ⭐ **The mutant must die.** The auditor's no-children/no-rest rebuild must FAIL the amended suite.
   ⛔ That is the acceptance test for this amendment, not the new cases passing.
4. ⚠️ `Card`'s children assertion is not optional either, though it takes no `rest`.

⛔ **Still open and NOT in this round** (Ian scoped it to findings 1–3): guard 7 cannot see
`bg-white`, which R1 forbids by name; all four test headers still describe the components as stubs
and one instructs a slice-3 author that the three source files are permanently out of scope; and
⚠️ **the dark-danger gap test this orchestrator ordered in the first audit round is itself an
absence-only assertion** — a `Button` returning `null` passes it — which is the very shape the
parent task's §5 forbids in its own words. Its free control is to assert `text-danger` IS present
in the same case.

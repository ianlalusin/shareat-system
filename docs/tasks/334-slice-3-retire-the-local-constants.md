# T-334 slice 3 — retire the 65 local `BTN`/`INPUT` constants

**Status:** ⭐ **SPECCED 2026-09-22 · §3.1 RULED 2026-09-23 (ADR-013 Amendment 5: dark `--danger` #f87171) by the orchestrator (`system32-df`), NOT BUILT.**
**Parent task:** `docs/tasks/334-v2-theme-brand-red-and-a-manual-dark-toggle.md` §3 SLICE 3.
**Authority:** `docs/decisions/ADR-013-v2-erp-theme-and-brand-colour.md` — ⭐ **read AMENDMENT 3
first**, it is the ruling this slice exists to execute.
**Depends on:** slice 2 (`6346f64`), shipped — `Button`, `Input`, `Card` exist and are adopted by
nothing.
**Migration slot:** ⛔ none. No schema change.

> ⛔ **THE SIZE QUESTION IS RULED AND CLOSED (Amendment 3, Ian, 2026-09-22): ONE SIZE.** Every button
> takes `Button`'s geometry, every input takes `Input`'s. Existing variation is discarded. This
> slice executes that; it does not revisit it.

---

## 1. The measured surface — ⛔ not the one three documents claimed

⚠️ **ADR-013 A1.3, the parent task and `HANDOFF-TODAY.md` all said "~8 `BTN` + ~9 `INPUT`" distinct
values, "a mapping exercise". Each was quoting the one before it and none had been checked.**
Measured 2026-09-22:

| | Claimed | **Measured** |
|---|---|---|
| Files with a local constant | 65 | **65** ✅ |
| Declarations | — | **99** (48 `BTN`, 51 `INPUT`) |
| Distinct `BTN` values | ~8 | **16** |
| Distinct `INPUT` values | ~9 | **7** |

⭐ **Concentration differs sharply between the two, and it decides the tranche order:**
`INPUT`'s top two values cover **46 of 51** (90%). `BTN`'s top two cover **21 of 48** (44%), with a
long tail of one-offs.

**Geometry — the number that actually stopped this slice being dispatched blind:**

```
BTN (48)                             INPUT (51)
  19 x  rounded    px-4 py-2           29 x  rounded    px-3 py-2
  14 x  rounded-md px-4 py-2.5  ✅     17 x  rounded-md px-2 py-2
   8 x  rounded-md px-3 py-2            2 x  rounded    px-2 py-1.5
   3 x  rounded    px-3 py-1.5          1 x  rounded-md px-2 py-1.5
   2 x  rounded-md px-2 py-1            1 x  rounded    px-2 py-1
   1 x  rounded    px-3 py-2            1 x  (composed from FIELD)
   1 x  rounded-md px-3 py-1.5
```

`Button` is `rounded-md px-4 py-2.5` — **14 of 48 match.** `Input` is `rounded-md px-3 py-2` —
**0 of 51 match exactly.** ⛔ Per Amendment 3 all of them are normalised anyway.

**Reproduce these numbers before trusting them** (they are a `node` script over `apps/erp/src`,
matching `const (BTN|INPUT)[A-Z_]*\s*=` with a multi-line value — ⚠️ **the declarations span two
lines**, which is why a naive single-line grep finds almost nothing and reports a false "already
done").

---

## 2. Scope

**In:** the 65 files under `apps/erp/src` carrying a local `BTN`/`INPUT` constant. Per file: delete
the constant, import `Button`/`Input` from `@/components/ui/...`, replace every usage.
⭐⭐ **CLASSES ACCOMPANYING THE CONSTANT AT A CALL SITE ARE *LAYOUT*, NOT GEOMETRY — PASS THEM
THROUGH UNCHANGED VIA `className`. Amendment 3 rules the geometry INSIDE the component; it never
rules the caller's layout.** ⛔ **This is the single most important sentence in this document.**
Measured 2026-09-22: of the call sites, **326 use the constant as the entire `className`** and
**~90 carry extra classes alongside it** — `${INPUT} w-40`, `${INPUT} w-32 text-right`,
`${INPUT} font-mono`, `${INPUT} col-span-2`, `${BTN} inline-block`. ⚠️ **One call site in five
carries a decision**, and those are widths, alignment and display — **not** geometry, so Amendment 3
does not reach them. ⛔ Without this sentence, agent A passes `w-32 text-right` through and agent B
reads *"existing variation is discarded"* and drops it; **both are defensible against the spec, so
across parallel agents it is a coin flip per file.** The budgets page's numeric column silently
becomes a full-width left-aligned input with `tsc` clean and the suite green.

⛔ **A `BTN` ON A `<Link>`/`<a>` IS OUT OF SCOPE AND KEEPS ITS CONSTANT.** `Button` renders a
`<button>`; converting a navigation to one makes it a no-op. Measured: exactly **two** —
`app/ap/suppliers/page.tsx:86` and `app/staff/page.tsx:53`. ⚠️ So **two `BTN` declarations survive
this slice by design**, and the completion criterion is "65 files less those two", not "zero
constants". (The first is also why `inline-block` is there at all.)

**Also in:** the barrel `apps/erp/src/components/ui/index.ts` — ⛔ **created by the ORCHESTRATOR
BEFORE TRANCHE 1, not "at first adoption".** It is shared state (slice 2 §5 invariant 4), and
"first adoption" under a workflow is **65 simultaneous events — the definition of a race.**
⭐ **Workflow agents import from the barrel** (`@/components/ui`), never a direct file path, so the
barrel is exercised rather than left as dead code the slice created.

⛔⛔ **EVERY ASSERTION YOU WRITE MUST NAME WHAT IT WOULD FAIL ON.** Three families cost this task
**twelve instances on 2026-09-22** and **all three survive a green suite**, so the workflow's own gates
cannot catch them:
- **(a) SUBSTRING WHERE A TOKEN WAS MEANT.** `bg-danger` matches inside `bg-danger-surface`;
  `disabled` matches inside `disabled:opacity-50`; `//` matches inside `http://`. ⭐ **Split the
  class attribute and compare TOKENS; never `toContain` a class name.**
- **(b) POSITIVE WITHOUT A NEGATIVE.** Asserting `disabled=""` appears when you pass `disabled` is
  satisfied by a control that is **always** disabled. ⭐ **A BOOLEAN attribute needs the absent case
  as well; a VALUED one (`name="email"`) does not, because its value is its own control.**

⛔ **(c) A COMMENT WHOSE FACTUAL CLAIM OUTLIVED ITS CODE.** ⭐ **EVERY ROUND OF T-334 PRODUCED AT
LEAST ONE**, and unlike (a) and (b) this family is invisible to **every** gate — no test, no
typecheck, no build, no sweep can see it. Measured instances: a comment claiming a `Record` "cannot
be restored without reintroducing the census failure" (it could, at zero cost); a comment claiming
renaming a variant branch "is not caught by anything" (three tests catch it); and a comment naming
`PRIMARY_CLASSES` after that identifier had ceased to exist. ⚠️ **The danger is not untidiness — it
is that a future reader USES the claim to decide what still needs guarding**, which is exactly how
the second one nearly justified keeping a weaker guard. ⭐ **This slice deletes 99 constants and the
comments around them across 65 files, so it is the largest single opportunity this project will
have to create family (c).** When you delete a constant, delete or correct every comment that
named it.

⚠️ **NAMING ALL THREE FAMILIES IS THE POINT.** Instance three was internalised as *"use a literal, not
a substring"* — the narrow form — and family (b) walked straight through it **one assertion
later**, in the same file, by the same author, on the same day. ⛔ **A workflow agent starts COLD:
it inherits none of those nine instances and none of the reasoning, and gets ONE reading.** So the
general rule has to be the thing it reads, not a warning it is expected to derive.

**Out:**
- ⛔ Re-opening the palette, the geometry, or adding a `size` prop (Amendment 3 §5).
- ⛔ The 781 `red-*` usages that mean *error* — that is **slice 4**, and it is the landmine.
- ⛔ `LABEL` (11 occurrences) and other constant families. Named here only so nobody assumes.
- ⛔ Touching `ERP-rebuild`, `POS`, `CUSTOMER`, `Shareat Website`.

---

## 3. ⛔ Four things that will cost a cycle

1. ⛔ **`--warning` AND `--danger` HAVE NO DARK TREATMENT, AND DANGER IS NOW REACHABLE.** ADR-013 §7:
   `#a00606` is **2.15:1 on the theme's actual dark surface — fails AA**. ⚠️ **ADR-013 §7 and the parent task both say 2.52:1 "on black", and that figure is 15% OPTIMISTIC** — the dark surface is `--surface` `#171717`, not `#000`. Measured 2026-09-22. `globals.css` does not redefine `--danger` under
   `[data-theme="dark"]`. There are **5 measured red/destructive `BTN` declarations**. ⭐ The moment
   one becomes `<Button variant="danger">` on a screen, a dark-cookie user gets an unreadable
   destructive label. **A test already pins this gap open** (`ui-button.test.ts`, added in slice 2).
   ⛔ **Do not close it.** Report each danger adoption; **Ian must rule the dark reds** before dark
   is called supported.
2. ⛔ **THE TAP-TARGET BASELINE WILL MOVE, AND THAT IS EXPECTED.** Controls get bigger, so
   `action-link-sweep.test.ts`'s `151 FAIL` should **fall**. ⚠️ Regenerate deliberately, per that
   file's own rules and the worked precedents in its comments (`53 → 56`, `56 → 58`) — ⛔ never to
   silence a red, and never by hand-editing `touch-target-baseline.json` to make something vanish.
   ⚠️ Each adopted file may also LEAVE the unresolved set, which is progress and must be captured.
   ⭐ **AND THE CONDITION THAT REOPENS THE SLICE-2 ADJUDICATION:** `Button` and `Input` are accepted
   in `touch-target-baseline.json` as permanently unresolvable, which is correct for two files and
   **corrosive at 65** — every adopted file replaces a statically MEASURED control with an
   unmeasurable one. ⛔ **If after any tranche `UNRESOLVED` has risen while `FAIL` has not fallen by
   at least as much, the sweep is measuring less rather than the app being better, and the
   acceptance must be revisited BEFORE the next tranche — not at the end of the slice.**
   ⭐ Phrased as an arithmetic relation between two numbers the test already prints, so nobody has
   to remember to exercise judgement.
3. ⛔ **EVERY ADOPTED FILE DELETES `dark:` CLASSES.** The existing constants carry them
   (`dark:bg-white`, `dark:border-neutral-700`, …); the components carry tokens that flip
   automatically. This slice removes a real fraction of the `dark:` usages. ⚠️ **NO NUMBER IS QUOTED HERE ON PURPOSE:** the parent task and ADR-013 say 3,485, slice 2's contract says 3,488, and a fresh count on 2026-09-22 said 3,486. ⛔ **Reproduce it yourself before using it as a baseline** — `grep -ro 'dark:' apps/erp/src | wc -l` — in the document whose §1 exists because three documents quoted each other without checking. ⭐ That is correct
   and is the point — but it means **dark mode must be smoketested on every adopted screen**, not
   just light.
4. ⚠️ **`Input` silently DISCARDS a caller-supplied `aria-invalid`** (slice 2, deliberate — the
   component owns it, driven by `invalid`). TypeScript will not complain. A call site currently
   setting it by hand must be converted to `invalid={…}`, and ⛔ **nothing will warn you.**

---

## 4. Shape — a `Workflow`, and why

⭐ With Amendment 3 ruled, each file is the same deterministic operation with no per-file judgement:
delete the constant, import the component, swap usages, keep behaviour. **One agent per file,
resumable, output stays out of the orchestrator's context.** That is the `Workflow` tool's case, and
`HANDOFF-TODAY.md` already nominated it — ⛔ but only because the ruling makes it true. Had sizes
been preserved, all 65 files would have been judgement calls and this would have been a lane.

⛔ **Tranche it; do not run 65 in one pass.** ⭐ **Do `INPUT` before `BTN`:** 90% of inputs are two
values, versus 44% for buttons, so the mechanical core is proved on the cleaner half first.
Suggested order — the parent task's own traffic ranking: the shell, `/`, `/sign-in`, `/staff`,
`/expenses`, then the rest.

⭐ **The tester writes the red and the auditor reads the resulting diff exactly as for a lane; only
the labour moves.** ⛔ A workflow does not remove the audit.

---

## 5. Done when

⛔ **THE GATES ARE THE ORCHESTRATOR'S, RUN ONCE PER TRANCHE AFTER THE AGENTS ARE DONE AND JOINED —
NEVER A WORKFLOW AGENT'S.** A workflow agent cannot run them: `npm run build` clobbers the `.next`
the 9008 server is serving (bible §2.9), and 65 agents cannot each take the browser. ⚠️ Stated
explicitly because the first agent to read this section literally would stop a dev server it does
not own.

Per tranche, every §9 gate — including **`npm run build`**, the **FULL** integration suite (bible
§9 rule 3, Ian 2026-09-22), and **§9.4 in a real browser, in BOTH themes, with the screenshots
actually looked at**, because this slice changes what screens look like on purpose. ⛔ **A green
suite proves nothing a reader cares about here.**
⛔⛔ **THE FIRST TRANCHE THAT ADOPTS A `Button` OR `Input` IS THE FIRST TIME §9.4 CAN SEE A FOCUS
RING AT ALL — AND IT MUST TAB TO ONE ADOPTED CONTROL IN **BOTH** THEMES.** Slice 2 shipped
`focus-visible:ring-2 ring-brand ring-offset-2 ring-offset-surface` on both components and
**nobody has ever looked at it.** Everything it changes is behind `:focus-visible`, and no screen
rendered either component, so no screenshot in slice 2 could contain a single pixel of it. ⚠️ The
contrast figures on record (5.47:1 light, 3.28:1 against the dark seam, 3.43:1 against the UA dark
canvas) are **COMPUTED from the token values and the generated CSS — not seen by anyone.**
⛔ **Without this, the ring ships unobserved through however many tranches follow, each one green.**

⭐ **AND NAME WHAT THE SCREENSHOTS ARE COMPARED AGAINST: before/after of the SAME screen, in the
SAME theme, captured in the SAME tranche.**
⛔⛔ **AND THE HARNESS CANNOT DO THAT TODAY — FIX IT BEFORE TRANCHE 1.**
`~/.claude/skills/orchestrator/tools/smoke-t334.mjs` writes to **three fixed filenames**
(`t334-signin-light.png`, `t334-findings-default.png`, `t334-findings-dark.png`), so **every run
overwrites the previous one's evidence.** Measured 2026-09-22: the s2b smoketest destroyed slice 2's
screenshots, and the tester's "identical to last round" was therefore a comparison against its own
written description, **not a pixel diff** — it said so itself rather than let it pass as stronger
evidence than it was. ⚠️ **A before/after requirement whose tool overwrites the "before" is not a
requirement, it is a ritual.** Name the files per tranche and per side (`t3-<tranche>-<screen>-<theme>-{before,after}.png`)
and keep them, or the comparator specified above cannot be honoured even by someone trying to. ⚠️ Slice 2 could say "the app must render
byte-identically"; this slice changes screens on purpose, so that claim is gone and nothing
replaced it. Without a named comparator, "looked at the screenshots" degrades to "saw a screen
that rendered".
⚠️ **Run the FULL integration suite before committing, not a lane-scoped one** — see DEF-412, filed
2026-09-21, which is precisely what a lane-scoped gate hid.

---

## 6. Rulings 2026-09-23: the auditor's cold read (`system32-19`) found two blocking defects in this spec

The orchestrator rules these. Each one is written as bluntly as the `<Link>` carve-out, because a
workflow agent gets one reading.

**R1 (D1): `INPUT` ON ANYTHING BUT AN `<input>` IS OUT OF SCOPE AND KEEPS ITS CONSTANT.** Measured:
192 `<input>`, **121 `<select>`**, 2 `<textarea>`, 1 `<PhotoInput>`, 1 `<TwoWayPicker>`. `Input`
renders `<input>`. Converting a `<select>` deletes its `<option>` children and leaves an empty text
box, with `tsc` clean and the suite green. ⛔ **Convert an `INPUT` call site only if its element is a
literal `<input>`.** Leave every other site, and the constant declaration it needs, unchanged, EXCEPT for the R8
geometry edit below. A file that still has non-`<input>` uses KEEPS its constant, so completion is **"no `<input>`
styled by a local `INPUT`"**, not "no `INPUT` constant". A `Select`/`Textarea` primitive is a
separate, unscheduled decision.

**R2 (D2): THE COMPONENT OWNS GEOMETRY; THE CALLER OWNS LAYOUT, AND THAT NOW HOLDS IN THE CODE.**
`Input`'s base carried `block w-full`, and Tailwind resolves conflicts by stylesheet order: `.w-full`
is emitted after `.w-40`, so a caller's `w-32` lost. 44 call sites pass a width (including §2's own
budgets example). ⛔ **`block w-full` is removed from `Input`'s base classes.** ⛔ THE NEXT SENTENCE IS FALSE; see "R2 CORRECTED" below. The local constants
carry neither, so removing them preserves today's layout, and a caller's width or display applies
unopposed. (`Button`'s `inline-flex` vs a caller's `inline-block` is the same shape. It is ruled
when the `BTN` tranche is specced, not now.)

**R3 (D3/D4): corrected counts, re-measured by the auditor.** 105 declarations (50 `BTN`, 55
`INPUT`); 8 distinct `INPUT` values; `Button` matches 15 of 50; `INPUT`'s top two cover 47 of 55
(85%). The tranche order still holds. `dark:` baseline at `1a471e6` = **3488**. §1's figures above
are superseded. They stay in place as the record of what was believed.

**R4 (D5/D6/D7): the five `BTN_DANGER` sites and the two `<Link>` files are deferred to the `BTN`
tranche spec.** Open there: whether `danger` adoption may retire those five `red-*` clusters (a
sanctioned crossing into slice 4, or deferral); the warning icon `Button` adds to every `danger`
button (a content change); and the mismatched `Button` / hand-styled link pair in
`ap/suppliers/page.tsx` and `staff/page.tsx`.

**R5 (D8):** the "do-not-touch" header in `ui-token-discipline.test.ts` is corrected in tranche 1
by the tester.

**R6 (builder `webapps-31`): A CALL SITE THAT ATTACHES A `ref` IS OUT OF SCOPE, like R1.** Measured: 0 such sites in the `INPUT` tranche (auditor). This is a `BTN`-tranche rule, and an R6 exclusion listed in an `INPUT` READY is a signal, not routine. `Input` and
`Button` are plain function components without `forwardRef`, on React 18.3, so a converted `ref`
stays `null` with no type error and no warning. ⛔ Leave the site and its constant unchanged, and
list it in READY. `forwardRef` is a separate component change, not this slice's.

**R7 (builder `webapps-31`): `dark:` VARIANTS AMONG A CALL SITE'S EXTRA CLASSES.** Measured: 0 in the `INPUT` tranche; every `dark:` there is inside a constant body, which R8 CLARIFIED keeps byte-for-byte. ⛔ Never resolve R7 against R8 by deleting `dark:` from a constant. Delete a `dark:`
variant that restyles a property the component's tokens already own: background, border colour,
text colour, placeholder colour, ring. Keep every other `dark:` variant (`dark:hidden`, a dark
width, …) as layout. ⛔ List every deleted variant, by file:line, in READY, so the auditor can check
each one against the rule.

**R2 CORRECTED (auditor N1): R2's justifying sentence was FALSE.** *"The local constants carry
neither"* holds for `block` (0 of 55) and fails for `w-full`: **31 of 55 `INPUT` constants carry
`w-full`**, and 131 `<input>` sites in 30 files rely on it. Removing `block w-full` from `Input` still
stands. ⛔ **A converted call site INHERITS every LAYOUT class the constant it leaves carried (in
practice `w-full`) and NONE of its geometry.** So `className={INPUT}` where `INPUT` carried
`w-full` becomes `<Input className="w-full" …/>`. ⭐ Invariant, checkable on the diff: **no converted
`<input>` carries fewer layout tokens than the constant it left.**

**R8 (auditor N2): A SURVIVING `INPUT` CONSTANT TAKES `Input`'s GEOMETRY IN THE SAME TRANCHE.** In
43 files one constant dresses both `<input>` and non-`<input>` sites, so R1 would leave a converted
input at `rounded-md px-3 py-2` beside a `<select>` at the old geometry in the same row. ⛔ **Where a
constant survives R1/R6, replace its geometry tokens (`rounded*`, `px-*`, `py-*`) with `Input`'s
(`rounded-md px-3 py-2`) and leave its other tokens alone.** It is one edit per constant, mechanical,
and it is Amendment 3's "one size" applied to the neighbours. ⭐ A `Select` primitive (121 sites)
is the real answer. It is a candidate next task, and R8 does not block it.

**R8 CLARIFIED (auditor, 2026-09-23): what "geometry" means, exactly.** ⛔ **Only the `rounded*` token
and the `px-*` / `py-*` pair change** (to `rounded-md`, `px-3`, `py-2`). Every other class in the
constant stays byte-for-byte: `w-full`, `border`, colours, `text-sm`, and **every `dark:`**. Replacing
the string with `Input`'s base would silently move 43 files' `<select>`s onto tokens and delete their
`dark:` classes. That is slice 4's work, on controls nobody smoketested, and it would break §3.3's
`dark:` baseline mid-slice. R8 applies to every surviving `INPUT` constant, **including a file where
nothing converts at all** (measured: `admin/access-defaults/page.tsx`, `inventory/deliveries/page.tsx`,
`inventory/usage/page.tsx`). ⭐ **So a tranche's diff may legitimately contain a file that adopts
nothing and only bumps geometry. That is R8, not scope creep.**

**⛔ R1 AND R2 ARE PROVISIONAL UNTIL SEEN — Ian, 2026-09-23, standing:** *"try it on screen then
decide based on the output. and do this to all future problems that needs actual rendering and
evaluation."* R1 (`<select>` sites keep their constant) and R2 (the caller owns width) were ruled
from static reasoning: tag-walking and Tailwind stylesheet order. Before the builder is released, the
tester renders each option against the real built CSS on a tranche-1 screen, in both themes, and the
rulings are confirmed or changed from the screenshots, which are cited here by filename.
⭐ **Standing rule: any question whose answer depends on how something renders is settled by
rendering it, not by reasoning about it.** The reasoning nominates; the screen decides.

### SEEN, 2026-09-23: render results (tester `webapps-30`, checked by auditor `system32-19`)

Real app on 9008 (production build of `1a471e6`, smoke DB), mutated with `page.evaluate` only. The
screenshots are in `~/.claude/skills/orchestrator/tools/t3-exp-*.png`.

**R1: FINAL.** E1 (`t3-exp-e1-{before,after}-staff-hire-filterrow-{light,dark,390w-light}.png`): the
real `/staff/hire` store `<select>` (153w × 39h, padding 8/8/8/8, radius 6px) was replaced with an
`<input>` carrying `Input`'s class string. It measured 185w × 38h, padding 8/12/8/12, and rendered as
**an empty text box with its options gone**. Nothing in the computed style flags it; only the screen
does.

**R2 (remove `block w-full` from `Input`): FINAL.** E2 used the real `q` input, whose call site passes
`w-56`. In place: today 224px · current base + `w-56` = **185px** · R2 base + `w-56` = **224px**.
Detached on `<body>`: current + `w-56` = **1280px** · R2 + `w-56` = **224px**. E2b: a bare R2 input in
a plain block `<div>` = 185px inside a 1280px container, so the input does not stretch to fill it.
⭐ **One bug, two opposite appearances:** in a shrink-to-fit flex `<label>` it makes the field too
NARROW, and in a block or grid cell too WIDE. A reviewer eyeballing one screen will derive the wrong
rule.

**R2 CORRECTED (inherit `w-full`): PENDING ONE NUMBER.** The `/ap` "name" field (its constant
supplies `w-full`) is 434px today. It needs the after-measurement, R2 base + `className="w-full"`,
expecting 434. That rule covers 131 sites.

**R8: HOLD.** E3's two variants measured identical height and radius, and the (a)/(b) labelling is
unverified. ⭐ **Known residual, not a defect:** a `<select>` is 39px against an `<input>`'s 38px at the
same classes. The 1px comes from the UA's `<select>` box model, and no class fixes it. Do not "fix" it.

**R8: FINAL (E3 follow-up, className read directly).** `/staff/hire`'s shared constant is the
`rounded-md px-2 py-2` family. In variant B the live `className` changed `px-2` to `px-3` (read back
directly). The select went from 153 × 39 at padding 8/8/8/8 to **161 × 39 at padding 12/12/8/8, radius
6px**, now equal to the adjacent `Input`'s padding and radius. Height and radius did not move because
they already matched. The 161-vs-224 width gap at 390px is the input's own call-site `w-56` against an
auto-width select, so it is not R8's concern.

**R2 CORRECTED: FINAL.** `/ap` "name" (its constant supplies `w-full`, and the call site adds
nothing): today **434 × 38** · R2 base + `className="w-full"` → **434 × 38**
(`t3-exp-e2ap-{before,after}.png`). Inheritance preserves width, which covers the 131 sites.

**R8 CONSEQUENCE (auditor, round 2): R8 matched GEOMETRY only, by design, so colour differs within a
row.** A converted `<Input>` uses `bg-surface` / `border-surface-border`, while a neighbouring `<select>`
keeps `bg-white dark:bg-neutral-950` / `border-neutral-300`. In dark mode that is `#171717` beside
`#0a0a0a`, and in light mode the borders are `#e5e5e5` beside `#d4d4d4`. This is expected until the
`<select>`s move to tokens (a `Select` primitive or slice 4). ⛔ Judge it from tranche 1's "after"
screenshots (Ian's render-first rule); if it is visibly jarring, it goes to Ian.
**RULED 2026-09-24 (Ian: "ship as is"):** the dark-mode colour difference within a row is accepted
(measured: `<select>` `#0a0a0a` vs `<Input>` `#171717`, `t3-1-staff-hire-dark-after.png`). It is
cured by a `Select` primitive (121 sites), which is a future task, not by recolouring constants in
this slice.

**TRANCHE 1: DONE (2026-09-24).** 5 files; ring → `ring-ink` (Amendment 6); dark `--danger`
(Amendment 5). Before/after: `~/.claude/skills/orchestrator/tools/t3-1-*-{before,after}.png`.

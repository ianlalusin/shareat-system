# T-334 slice 3 — retire the 65 local `BTN`/`INPUT` constants

**Status:** ⭐ **SPECCED 2026-09-22 by the orchestrator (`system32-df`), NOT BUILT.**
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

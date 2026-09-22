# ADR-013 — the v2 ERP theme: Shareat brand red, a manual dark toggle, and danger by treatment

**Status:** ⭐ **ACCEPTED — Ian's ruling, 2026-09-19. NOT BUILT.**
**Recorded 2026-09-21** by the orchestrator (`system32-df`), three days after it was made.
**Supersedes:** nothing. **Superseded by:** nothing.

---

## ⛔ Why this document exists at all, and the lesson is bigger than the colour

**Ian made this decision on 2026-09-19, in conversation, while planning a different project.** It
was never written into this repo — no bible row, no ADR, no task, no register row. On 2026-09-21 he
asked the orchestrator to *"find the work i had 2 or 3 days ago about the ui color"*, and a
repo-wide search found **nothing**: not in `docs/`, not in git history for 09-17→09-20, not in
untracked files, and no content match anywhere in the tree for the hex values or the phrase.

⭐ **It was recovered from a single session's persistent memory** (`webapps-17`), where it existed as
one note titled *"v2 ERP theme ruling"*. ⛔ **Had that terminal been cleared — which is routine, and
which this project's own handoff ritual actively recommends — a ruling with exact hex values,
measured contrast ratios and an implementation approach would have been gone**, and the next session
to touch theming would have started from scratch and probably picked a different red.

> ⭐⭐ **THE TRANSFERABLE RULE: a decision that lives only in a session's memory is not a decision the
> project has made.** It is one an agent happens to remember. The repo is the only durable medium
> here, and bible §14's *"bible amended if a decision was made"* is the mechanism — this one slipped
> through because the decision was made while working on something else, which is exactly when
> nobody thinks to record it.

⚠️ **Every factual claim below was re-verified against source by the orchestrator before filing**,
not accepted from the memory note. The verification is shown inline, because a ruling reconstructed
from memory deserves more scepticism than one written down at the time, not less.

---

## 1. The decision

| | Ruling |
|---|---|
| **Primary colour** | **Shareat brand red `#d40909`** on white |
| **Dark mode** | **Kept**, but moved off OS-follow onto a **manual toggle**, defaulting to **light** |
| **Danger / error** | Differentiated by **TREATMENT, not hue** — because brand red can no longer double as the error colour |

⛔ **The v2 primary is explicitly NOT v1's colour.** Verified: v1 ERP's primary is **amber** —
`--primary: 42 100% 50%` at `ERP-rebuild/src/app/globals.css:31`, commented *"Primary — POS
orange-yellow"* — and red there is `--destructive` only.

⭐ **And the brand red is not invented for this ADR — it is already declared, and so are the other
two.** Verified in `Shareat Website/src/styles/global.css`:
```
10:  --color-shareat-red: #d40909;
11:  --color-shareat-red-deep: #a00606;
12:  --color-shareat-red-soft: #fde7e7;
```
**All three values this ADR uses are the website's own existing brand tokens.** That is the strongest
argument in the ruling's favour and it was not stated in the original note: this is not a new palette,
it is the ERP finally adopting the brand's declared one.

### The treatment scale

| Role | Value | Treatment |
|---|---|---|
| Brand / primary | `#d40909` | **solid red fill** |
| Danger | `#a00606` | **outlined**, never solid — so it cannot be mistaken for a primary action |
| Error surface | `#fde7e7` | **background only** |
| Warning | `#f4b942` (brand gold) | ⛔ **surface only, NEVER text** |

### ⭐ Contrast, recomputed independently (WCAG, against white)

| Colour | Measured | Verdict |
|---|---|---|
| `#d40909` | **5.47:1** | ✅ AA for normal text · ⛔ **not AAA** |
| `#a00606` | **8.32:1** | ✅ AA and AAA |
| `#f4b942` | **1.77:1** | ⛔ **fails everything as text.** Surface only — this is why the rule above is absolute |
| `#fde7e7` | 1.18:1 | surface only, as intended |

⭐ **All three figures in the original ruling reproduced to two decimal places.** The maths was right.
⚠️ Note for whoever builds dark mode: `#d40909` on black is only **3.84:1** and `#a00606` on black is
**2.52:1** — ⛔ **both fail AA as text on a dark surface.** The dark theme therefore **cannot** simply
reuse these values for text; it needs its own lighter red. **That is a gap in the ruling, found while
verifying it, and it must be settled before dark mode is implemented.**

---

## 2. Why now, and why the order matters

Verified 2026-09-21: **v2 has no colour tokens at all.** `apps/erp/src/app/globals.css` declares only
`color-scheme: light dark` plus a sidebar-width variable — no palette, no theme tokens. Meanwhile
the tree carries **~3,485 `dark:` utility classes** and (per the original census) **62 files with
private, local colour constants** (`BTN`, `INPUT` and friends).

⛔ **So this is a real refactor, and getting the red wrong first wastes all of it.** That is the
entire argument for ruling the colour *before* anyone starts: the expensive part is not choosing the
red, it is the 62 files and the 3,485 classes that will be rewritten against whatever red is chosen.

---

## 3. Implementation approach — sketched in the ruling, NOT built

1. `:root { color-scheme: light }` — stop following the OS.
2. Tailwind `darkMode: ['selector', '[data-theme="dark"]']`.
3. A **theme cookie read server-side in `layout.tsx`**, ⭐ **reusing the existing `data-sidebar-state`
   cookie pattern**, which already solves no-flash-on-first-paint in this exact codebase
   (`globals.css`'s own comment documents why: the value must be right in the **first server-rendered
   paint**, before any JS runs, or the "no flash, no layout shift" invariant is broken).
4. **Then** retire the 62 files' local `BTN`/`INPUT` constants — ⚠️ **a few per commit**, deliberately,
   to avoid colliding with other lanes working in the same tree.

⭐ Point 3 is the part worth preserving: the no-flash problem is already solved here once, and the
theme should copy that solution rather than invent a second one.

---

## 4. What is NOT decided

- ⛔ **Dark-mode text reds.** See §1 — the ruled values fail AA on black. Unresolved.
- Where the toggle lives in the UI, and whether it is per-person or per-device.
- Whether `packages/ui` gets the tokens or each app declares its own.
- Any task number. **None allocated; nothing built.** This ADR records a decision, it does not
  schedule work.

---

## 5. Consequences

- **Positive:** the ERP finally matches the brand it belongs to, using tokens the brand already
  declares; one colour system replaces 62 files of private constants; dark mode becomes a user
  choice rather than an OS accident.
- **Cost:** a large mechanical refactor touching ~3,485 class occurrences and 62 files, which must be
  paced so it does not collide with feature lanes in a shared working tree.
- ⚠️ **Risk:** brand red at 5.47:1 is AA but **not AAA**, and it is now the primary — so it will be
  used for a great deal of text. Anything requiring AAA must use `#a00606`.
- ⛔ **Blocking gap:** dark mode cannot be built from these values alone (§1).

---

## 6. Related

- **Bible §1.2c** — UI/UX is a third authority; a screen should be *familiar-but-upgraded, never
  reinvented*, and ⭐ **POS, not `ERP-rebuild`, is the presentation-quality benchmark** where the two
  disagree. This ADR is consistent with that: it adopts the brand's palette rather than v1's amber.
- **Bible §14** — only the Opus planner amends the bible; this ADR is the record, and a bible row
  should cite it.
- `ERP-rebuild/src/app/globals.css:31` — v1's amber primary (read-only reference).
- `Shareat Website/src/styles/global.css:10-12` — the three brand tokens (read-only reference).

---

## Amendment 1 — 2026-09-21: the source document, the full palette, and the half-day that carries the win

⭐ **ADR-013 was written from a session's memory of the ruling. The ruling's own working document has
since been found and read**, and it is considerably more complete: a nine-token palette, a
four-step migration order already sequenced for a shared tree, and a colour-family census.

**Source:** the Claude Doc *"Support System Build Plan"* (2026-09-19), section **"V1 visual
restoration"** — `https://claude.ai/artifact/2BBR1pfS7sz2EKejpgZiPJ`. ⛔ **The theme ruling is one
section of a document about something else entirely**, which is precisely why a repo-wide search for
it found nothing and why it took asking a peer session to surface it.

### A1.1 The full token set — RULED, and ADR-013 §1 carried only four of the nine

| Token | Value | Used for |
|---|---|---|
| `--brand` | `#d40909` | The **one** primary action per view, active nav item, focus ring, wordmark. ⛔ **Nothing else** |
| `--brand-hover` | `#b00707` | Hover and pressed on the above |
| `--danger` | `#a00606` | Destructive actions and error text. ⛔ **Always outlined, never filled, always with an icon** |
| `--danger-surface` | `#fde7e7` | Error banner backgrounds, with a left bar |
| `--warning` | `#f4b942` | Pending, attention, needs-review. ⭐ **This is where today's 649 ambers go** |
| `--success` | `#059669` | Posted, verified, tied |
| `--canvas` | `#ffffff` | Page background |
| `--surface` | `#ffffff` + `#e5e5e5` border | Cards |
| `--ink` | `#1a1a1a` | Body text — the brand's own `shareat-black` |

⭐ `--brand-hover`, `--success`, `--canvas`, `--surface` and `--ink` are **new to this record**;
ADR-013 §1 had only the four reds and the gold.

### A1.2 ⭐ The measured surface — and one number that changes the plan's shape

| Measured | Doc, 2026-09-19 | Re-measured 2026-09-21 |
|---|---|---|
| Colour tokens in `globals.css` | **none** | none ✓ |
| `tailwind.config.ts` theme | `theme: { extend: {} }` — empty | empty ✓ |
| `darkMode` key in the Tailwind config | *(not stated)* | ⛔ **absent — so Tailwind is on its default `media` strategy, i.e. OS-follow.** That IS the bug |
| `dark:` usages | 3,434 | **3,485** (active tree) |
| Files with a local `BTN`/`INPUT` | 62 | **65** |
| Distinct hand-written primary-button strings | **12+** | ~8 `BTN` + ~9 `INPUT` distinct literals |
| Colour families | neutral 4,763 · **red 781** · **amber 649** · emerald 370 · white 291 · green 200 | — |

⭐⭐ **THE NUMBER THAT MATTERS MOST IS THE SMALL ONE: ~8–12 distinct strings across 65 files.**
This is a **mechanical sweep**, not 65 judgement calls — which is what makes step 3 below safe to
spread across commits, and what makes this a candidate for a `Workflow` rather than a lane.
⚠️ **Concentration measured: 152 files carry `dark:` classes and the top 15 hold only 22.5% of
them.** ⛔ **There is no spine.** The refactor cannot be done by fixing ten files.

### A1.3 ⭐ THE HALF-DAY THAT DELIVERS MOST OF THE WIN — and it is step 1 alone

The doc's own words: *"`:root { color-scheme: light }`, with `dark` only under
`[data-theme="dark"]`. **This one change is what makes v2 read as v1 immediately**, before any
refactor."*

1. **Tokens in `globals.css` + `tailwind.config.ts`, the `darkMode` selector, and the cookie.
   Nothing else changes.** ⭐ *~half a day, and it delivers most of the visible win.*
   - `darkMode: ['selector', '[data-theme="dark"]']` — ⭐ **so all 3,485 existing `dark:` classes
     keep working and nothing has to be deleted.**
   - A `theme` cookie read in `layout.tsx` and written onto `<html>`, **exactly as
     `data-sidebar-state` already is.** Default light.
2. One `components/ui/{Button,Input,Card}.tsx` carrying the tokens. **Not yet used anywhere.** *~half a day.*
3. Replace the local constants **a few files per commit**, highest-traffic first: the shell, `/`,
   `/sign-in`, `/staff`, `/expenses`. *~2–3 days spread out.*
4. **Semantic sweep last:** re-point the **781 `red-*` usages that mean *error*** onto `--danger` /
   `--danger-surface`, so brand red is left holding only chrome. *~1 day.*

⛔ **"Do not do this all at once" is the doc's own instruction** — other lanes work in this tree.
⚠️ And its operational note, which this repo's CLAUDE.md states independently: **stop the dev server
on 9008 before any build**, because `next build` overwrites the `.next` a running server is serving.

### A1.4 What this amendment does NOT resolve

⛔ **The dark-mode text contrast gap in ADR-013 §1 still stands and the source document does not
address it.** `#d40909` is **3.84:1** on black and `#a00606` is **2.52:1** — **both fail AA as
text on a dark surface.** The palette above is specified for **light**; step 1 keeps dark mode
working mechanically, but the dark theme's own text reds remain unchosen. ⚠️ Since step 1 defaults
to light and makes dark opt-in, **this is not blocking for steps 1–4** — but it must be settled
before dark mode is offered as a supported theme rather than a carried-over behaviour.

---

## Amendment 2 — 2026-09-21: a THIRD red exists in the family, and it is the one most likely to be copied by mistake

**Recorded by the orchestrator (`system32-df`), same day as Amendment 1.**
**Source:** `webapps-17`'s persistent memory of Ian's 2026-09-19 ruling — the same note ADR-013
itself was recovered from. Asked directly whether it held anything the ADR and Amendment 1 did not
yet record, it named this. ⭐ **Nothing else in its note was missing**, which is itself worth
recording: the recovery in Amendment 1 was very nearly complete.

⚠️ **Verified against source before filing, per this document's own standard** — a ruling
reconstructed from memory deserves more scepticism than one written down at the time, not less:

```
CUSTOMER/src/app/globals.css:13:    --primary: 0 100% 44%;
```

`hsl(0 100% 44%)` is **`#E00000`**. The ruled brand red is **`#d40909`**. ⛔ **They are different
colours and they look almost identical.**

### What the ruling actually warned against, stated in full for the first time

ADR-013 §1 as written contrasts the v2 primary against **one** wrong red-adjacent colour: v1 ERP's
amber (`ERP-rebuild` `--primary: 42 100% 50%`). ⭐ **The ruling named a second trap, and it is the
more dangerous one**, because amber is obviously not red and `#E00000` obviously is:

| Colour | Where it lives | What it is |
|---|---|---|
| `#d40909` | `Shareat Website/src/styles/global.css:10` | ⭐ **the brand's declared red — the ONLY correct source** |
| `#E00000` | `CUSTOMER/src/app/globals.css:13` | ⛔ **a different app's own primary.** Not the brand token |
| `42 100% 50%` (amber) | `ERP-rebuild/src/app/globals.css:31` | v1 ERP's primary — already named in §1 |

> ⛔⛔ **THE RULE: "the red" IS RE-DERIVED FROM THIS DOCUMENT, NEVER FROM A LIVE APP.** Opening a
> running Shareat app and sampling its primary colour will, three times out of four, give you the
> wrong value — and the wrong value is visually indistinguishable from the right one at a glance.
> The brand token is the authority; a sibling app's `--primary` is that app's decision, not the
> brand's.

### Where this bites, specifically

⚠️ **T-334 slice 4 — the semantic sweep of the 781 `red-*` usages.** That slice's whole job is
deciding which reds mean *error* and re-pointing them, which is exactly the task that tempts someone
to establish "what the red is" by looking at a shipped app. ⭐ **This amendment exists mainly so
that lane has something in the repo to be warned off by** — before today there was nothing:
ADR-013 never mentioned `CUSTOMER` at all.

⛔ **This changes no ruled value.** `#d40909`, `#a00606`, `#fde7e7` and the rest stand exactly as
ruled in §1. Amendment 2 adds a warning, not a colour.

### ⭐ The method note, which is the point

This is the **second** time in one day that a decision of Ian's turned out to exist only in a
terminal's memory — and the second time it was recovered only because someone asked that terminal
directly before it was cleared. ⛔ **The first recovery (ADR-013 itself) was one `/clear` away from
being lost outright.** This one would have been lost silently, since nobody would have known there
was anything missing to look for.

> ⭐ **Transferable: when a session is about to be released, ask it what it holds that the repo does
> not.** Its answer costs one message. `webapps-17` was standing down from a role it had been
> reassigned out of, and answered a question asked almost in passing; that answer is this amendment.

---

## Amendment 3 — 2026-09-22: one size, ruled by Ian, because the measured population does not fit the components

**Status:** ⭐ **ACCEPTED — Ian's ruling, 2026-09-22**, made in response to the measurement below and
recorded the same hour. ⛔ **Not reconstructed from anybody's memory.** That is the point of it being
here at once (Amendments 1 and 2 were both recovered days late, one from a terminal that was about
to be cleared).

### What was measured, and why it stopped slice 3 before it started

T-334 slice 3 retires the local `BTN`/`INPUT` constants. Its authority documents sized it as a
**mechanical sweep** — ADR-013 A1.3 and the parent task both say *"~8 `BTN` + ~9 `INPUT`"* distinct
values across 65 files, and `docs/HANDOFF-TODAY.md` called it *"~8–12 distinct strings… a mapping
exercise"*. ⛔ **Measured 2026-09-22, before dispatching anything, both numbers are wrong and the
second is wrong in the direction that matters:**

| | Claimed | Measured |
|---|---|---|
| Distinct `BTN` values | ~8 | **16** |
| Distinct `INPUT` values | ~9 | **7** |
| Files · declarations | 65 · — | **65 · 99** |

⭐⭐ **But the count was never the real problem — the GEOMETRY was, and nobody had looked at it.**
Slice 2's components ship one fixed geometry each: `Button` is `rounded-md px-4 py-2.5`, `Input` is
`rounded-md px-3 py-2`. The population they are meant to replace:

```
BTN                                  INPUT
  19 x  rounded    px-4 py-2           29 x  rounded    px-3 py-2
  14 x  rounded-md px-4 py-2.5  ✅     17 x  rounded-md px-2 py-2
   8 x  rounded-md px-3 py-2            2 x  rounded    px-2 py-1.5
   3 x  rounded    px-3 py-1.5          1 x  rounded-md px-2 py-1.5
   2 x  rounded-md px-2 py-1            1 x  rounded    px-2 py-1
```

⛔ **`Button` matches 14 of 48 declarations (29%). `Input` matches 0 of 51 exactly.** Adopting them
as-is is therefore **not** retiring duplicate strings — it **visibly resizes 71% of the buttons and
100% of the inputs in the application**. The smallest button (`rounded-md px-2 py-1`, ~30px) becomes
42px, a 40% jump.

⚠️ **This is a defect in slice 2's specification, and it is the orchestrator's.** The contract said
Card's padding should be *"consistent with what the app already uses"* and said nothing at all about
Button's or Input's; the builder reasonably picked one precedent out of seven. ⛔ **Nobody measured
the population the components were built to replace before building them.** Slice 2 is not wrong —
it is tested, audited and shipped — it simply cannot absorb the tree without a decision nobody had
made.

### The ruling

> ⭐ **ONE SIZE. Every button becomes `Button`'s geometry; every input becomes `Input`'s. The
> existing variation is not preserved.** — Ian, 2026-09-22

**Consequences, stated rather than discovered:**
1. ⛔ **This is a VISIBLE change on every screen carrying a button or a form control**, and it is
   intended. It is not a regression and must not be reported as one.
2. ⭐ **Buttons only ever get BIGGER, never smaller** (42px is above every measured height), so the
   T-262/DEF-269 tap-target position improves rather than degrades. ⚠️ `action-link-sweep.test.ts`'s
   accepted baseline **will shift** as controls resize — expect `151 FAIL` to fall, and regenerate
   deliberately per that file's own rules, never to silence a red.
3. ⭐ **Slice 3 stays MECHANICAL, which is what makes a `Workflow` the right vehicle.** Had the
   answer been "preserve each call site's size", every one of the 65 files would have become a
   judgement call (*which size is this one?*) and the sweep shape would have collapsed.
4. ⛔ **The variation being discarded was accidental, not designed** — seven geometries for one
   control is drift, and bible §1.2c asks for *"one uniform, reusable pattern set across screens"*.
   ⚠️ If any individual call site turns out to need a different size for a real reason, that is a
   finding to report, **not** a licence to reintroduce a local constant.
5. ⛔ **No size prop was added, deliberately.** Adding `size` would bake today's drift into the
   design system permanently. ⚠️ If a second size is ever genuinely needed it is a new ruling, and
   it is Ian's.

### ⭐ The method note

**The spec's own headline number was wrong, and it was wrong in the safe-sounding direction.** Three
separate documents repeated *"~8–12 distinct strings, a mapping exercise"* and each was quoting the
one before it. ⛔ **One `node` script over the tree settled in seconds what three documents had
agreed on and none had checked.** The same repo already records the lesson — *"a static read
nominates; running settles"*, and *"anyone who promises this in one pass has not run the numbers"*
— which is exactly what the parent task warned about, in a sentence sitting directly above the
numbers that were wrong.

---

## Amendment 4 — 2026-09-22: the dark-mode contrast figure this ADR has quoted twice is 15% optimistic

**Recorded by the orchestrator (`system32-df`) on a measurement by the auditor lane (`webapps-cb`,
Opus), 2026-09-22.** ⛔ **This changes no ruling. It corrects a number that a pending ruling will be
made from.**

§1 and Amendment 1 §A1.4 both record the dark-mode reds "on black":

| Colour | ADR says, on black | ⛔ **Measured on the theme's ACTUAL dark surface** |
|---|---|---|
| `#a00606` (`--danger`) | 2.52:1 | ⛔ **2.15:1** |

⭐ **The theme's dark surface is not black.** `globals.css` sets `--surface: #171717` and
`--canvas: #0a0a0a` under `[data-theme='dark']`. Nothing in the running application renders danger
text on `#000000`, so the figure that has been quoted in three places describes a surface that does
not exist.

⚠️ **The conclusion is unchanged and gets slightly worse:** it failed AA at 2.52 and it fails AA
harder at 2.15. ⛔ **But the number is load-bearing for a ruling Ian has not yet made** — how much
lighter the dark red must be is sized directly from the current ratio, and a 15% optimistic
starting point understates the correction needed.

**Where the stale figure appears** (left in place, each now superseded by this amendment):
`ADR-013 §1`, `ADR-013 Amendment 1 §A1.4`, `docs/tasks/334-v2-theme-brand-red-and-a-manual-dark-toggle.md §7`.
`docs/tasks/334-slice-3-retire-the-local-constants.md §3.1` already carries the corrected figure.

### ⭐ The method note, which is the same one for the third time today

**A figure was quoted from document to document and none of the copies was checked against the
thing it described.** Amendment 3 recorded this for the "~8–12 distinct strings" claim (actually
16 + 7) and for the geometry nobody had measured; slice 3 §3.3 now refuses to quote a `dark:` count
at all because three documents give three different numbers. ⛔ **This one is worse than those,
because the figure is not merely wrong — it is a measurement against the wrong object.** The
arithmetic for `#a00606` on `#000000` is correct; `#000000` is simply not where the text goes.

> ⭐ **A contrast ratio is a statement about TWO colours. Quoting one of them from a ruling and the
> other from memory produces a true number about a surface the product does not have.**

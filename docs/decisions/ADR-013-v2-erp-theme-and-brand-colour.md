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

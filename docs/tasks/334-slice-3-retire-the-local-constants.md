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
**Also in:** the barrel `apps/erp/src/components/ui/index.ts` — ⛔ **created by the ORCHESTRATOR at
first adoption, not by a lane or a workflow agent.** It is shared state (slice 2 §5 invariant 4).

**Out:**
- ⛔ Re-opening the palette, the geometry, or adding a `size` prop (Amendment 3 §5).
- ⛔ The 781 `red-*` usages that mean *error* — that is **slice 4**, and it is the landmine.
- ⛔ `LABEL` (11 occurrences) and other constant families. Named here only so nobody assumes.
- ⛔ Touching `ERP-rebuild`, `POS`, `CUSTOMER`, `Shareat Website`.

---

## 3. ⛔ Four things that will cost a cycle

1. ⛔ **`--warning` AND `--danger` HAVE NO DARK TREATMENT, AND DANGER IS NOW REACHABLE.** ADR-013 §7:
   `#a00606` is **2.52:1 on black — fails AA**. `globals.css` does not redefine `--danger` under
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
3. ⛔ **EVERY ADOPTED FILE DELETES `dark:` CLASSES.** The existing constants carry them
   (`dark:bg-white`, `dark:border-neutral-700`, …); the components carry tokens that flip
   automatically. Of **3,488** `dark:` usages this slice removes a real fraction. ⭐ That is correct
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

Per tranche, every §9 gate — including **`npm run build`** and **§9.4 in a real browser, in BOTH
themes, with the screenshots actually looked at**, because this slice changes what screens look like
on purpose. ⛔ **A green suite proves nothing a reader cares about here.**
⚠️ **Run the FULL integration suite before committing, not a lane-scoped one** — see DEF-412, filed
2026-09-21, which is precisely what a lane-scoped gate hid.

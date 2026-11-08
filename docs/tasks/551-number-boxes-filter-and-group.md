# T-551 — A number box filters what is typed and groups the thousands as you type

Status: **BUILT** on branch `fix/numeric-entry` (worktree `.worktrees/numeric-entry`), from `origin/main`
`d44852d`, 8 Nov 2026, pushed. Ian, on the deployed ERP (screenshot: the sales-day **Foodpanda** box holding
`1,0493.75`). `origin/main` has one newer commit (`9b4041d`, the T-540 page-header sweep) which touches none of
these files. Numbered **T-551**: T-549 and T-550 were already taken by lanes `t549-save-verify-icons` and
`lane/t550`.

## Why (Ian, 8 Nov 2026)

> "i want all inputbox that expets number to not accept letters or any other symbol not used in number or
> currency. and when an edit button is clicked or whenever input box is active automatically switch the
> number of ',' based on the input."

Two failures behind that sentence, both visible on the screenshot:

1. The box **accepts anything** — letters, `₱`, `%` — and only the parser refuses it, on Save.
2. The commas are **whatever the person typed**. `1,0493.75` is neither a valid grouping nor the figure
   anyone meant, and it is refused only on Save.

## Today (origin/main `d44852d`)

- Every money/quantity box is a **text input with `inputMode="decimal"`** (T-343 S5.5s–w; 38 in
  `apps/erp/src`, from `sales-days/[id]/page.tsx:436` to `components/money/MoneyLines.tsx:372`). The browser
  no longer filters them — that is what `type="number"` used to do, and it did it badly (DEF-470/472).
- `parseDecimalInput` **accepts a correct grouping** (`16,980`, `1,234,567.8`; T-504 item 7) and refuses a
  wrong one by name (DEF-383). Nothing ever *inserts* the commas.
- The live rule for a `number` — quantities, counts, minutes — validates with its own regex
  (`packages/domain/src/field-rules/check.ts`, `case 'number'`) and **refuses `1,200`**, so a grouped
  quantity would switch Save off with no way for the person to fix it (the box put the comma there).

## Rule

1. **Only what a number is made of survives.** Digits, one decimal point, a leading minus. Everything else —
   letters, `₱`, `$`, `%`, spaces, a second point — is dropped **as it is typed or pasted**. A currency
   prefix (`₱`, `PHP`) and the unicode spaces a paste brings are removed, not kept in the value.
2. **The thousands separators are the app's job, and they update on every keystroke** — `1049` shows
   `1,049`; typing another `3` makes it `10,493`; the first group is never `0,500` or `01,000`
   (leading zeros are dropped first, so the formatter cannot emit a grouping the parser refuses).
3. **Focus / the Edit button groups what is already there** — `10493.75` becomes `10,493.75` before the
   first keystroke, and the deployed screen's `1,0493.75` becomes `10,493.75`.
4. **The caret stays on the same digit.** A comma inserted to the left must not send the next keystroke to
   the end of the box.
5. **The server never sees a comma.** The grouping is stripped on submit, before the form's value is read.
6. **Whole-number boxes take digits only and are never grouped** (`inputMode="numeric"`: PINs, minutes,
   OTPs — `123456` must not become `123,456`), and **a leading zero is kept**: `012345` is a PIN, not 12,345.
7. **A comma is a grouping mark, never a decimal point.** `1,5` shows `15` (the person sees the digits),
   never 1.5 — DEF-472's lesson is that re-reading a separator is how a number becomes 10× wrong, and
   DEF-383's ruling is that a wrong grouping is refused, not guessed at.
8. **A `number` live rule reads a correct grouping the same way the parser does** and hands on the plain
   digits. A wrong grouping is still refused.

## Design

**One behaviour for the whole app, not a component per field.** Mounted once in `app/layout.tsx`; it works
on the document. The rule is a property of every number box — ~40 server-rendered pages, `CheckedForm`,
`EditableRecord` (the edit dialog), dialogs and anything added tomorrow — and a wrapper would have to be
adopted at each call site and would silently miss the next one. The two `inputMode` values the ERP already
sets (T-343 S5.5) are exactly the population; `type="number"` is left to the browser.

- `apps/erp/src/lib/number-entry.ts` (pure, no React)
  - `formatNumberEntry(raw, { decimal, negative, group })` — what the box holds.
  - `plainNumberEntry` — what is submitted.
  - `caretAfterFormat(before, caret, after)` — same digits to the left; separators inserted at the caret are
    crossed to the right, so `1,049` + typing `3` after the `0` gives `10,349`, not `13,049`.
- `apps/erp/src/components/forms/NumericEntry.tsx` (`'use client'`) — `NumericEntryBehaviour`, one
  `useEffect` with three document listeners: `focusin` (regroup, move `defaultValue`, dispatch a bubbling
  `input` so a controlled field and the live rules see the same text), `input` (filter + regroup + caret),
  `submit` in the capture phase (strip; put the display back after the action has read the form).
  Disabled, read-only, `type="number"` and composing IME input are left alone.
- `packages/domain/src/shared/money-input.ts` — the grouping rule is now **`ungroupThousands`**, used by
  `parseDecimalInput` (unchanged behaviour) and by `case 'number'` in `packages/domain/src/field-rules/check.ts`.
- `apps/erp/src/app/layout.tsx` — mounts it, beside `Toaster` and `TooltipLayer`.

## The sweep — 13 boxes were never marked

The behaviour keys on `inputMode`, so the population had to be complete. A census over `apps/erp/src` (every text
`<input>`/`<Input>` whose name reads as a money/quantity field and carried no `inputMode`) found **13**, and the
first two are **the screen the report came from**:

- `sales-days/SalesDayForm.tsx` — the per-channel amount and per-wallet tender boxes. This is the body
  `/sales-days/new` and `/sales-days/[id]/edit` render; T-343 converted the `[id]` page's platform boxes and this
  shared form was never in that sweep.
- `channel-settlements/review/DayDetail.tsx` (amount) — a one-attribute change; T-548's "not here" note is about
  that lane's modal work, not about this.
- `inventory/production/page.tsx` (labour cost, output quantity, line quantity),
  `inventory/deliveries/inbound/[shipmentId]/page.tsx` (received quantity), `inventory/pos-map/page.tsx`
  (quantity per sale).
- `kitchen/KitchenSections.tsx` (minutes to cook twice, screen order), `payroll/rates/page.tsx` (due day),
  `payroll/statutory-payments/new/page.tsx` (amount paid).

Money/quantity get `inputMode="decimal"`; whole counts, minutes and the due day get `"numeric"`.
`attendance/leave`'s `restDays` is **not** a number — it holds dates ("2026-03-04, 2026-03-05") — and is left alone.
The census is a scan, not a test; T-343's R-legs remain the guard for the boxes they name.

## Contract

- No change to field names, server actions, permissions, rules, sentences, layout or classes.
- **`EditableRecord`'s "changed?" test does not see the commas.** A value regrouped on focus also moves that
  control's `defaultValue`, so Cancel, `form.reset()` and "Save or cancel the changes you are making first"
  behave exactly as before; typing still makes the record dirty.
- **A stored value never holds a comma** (T-504 item 7), and `parseDecimalInput` is unchanged for every
  existing reader (its own test file is untouched and still green).
- No migration, no schema, no new dependency.

## Out

- `apps/pos` — a separate app; its money input is T-423's (its files are excluded from the ERP's tests too).
- `type="number"` boxes (two payroll year filters): the browser owns that value.
- Grouping a `pattern` field (no `inputMode` is emitted for one, so none is touched).
- With JavaScript disabled nothing groups the text, and a person who types their own correct grouping is
  still accepted by the parser (T-504). That is the progressive-enhancement floor, not a gap.

## Tests

- `apps/erp/tests/number-entry.test.ts` — the pure formatter: every rule above, including that **every**
  complete formatted value parses back through `parseDecimalInput` to the same figure.
- `apps/erp/tests/numeric-entry-dom.test.ts` — happy-dom, real events and real React: focus/Edit regroups
  (and the deployed `1,0493.75` is repaired), typing filters and groups with the caret kept, a numeric box
  never groups, a controlled box (`MoneyLines`) keeps React's value in step, submit strips and restores the
  display, disabled/read-only and `type="number"` are untouched, the root layout mounts it.
- `packages/domain/tests/unit/t551-number-rule-commas.test.ts` — `ungroupThousands`, and `case 'number'`
  accepting `1,200` / `11,000.5` (range judged on the value) while refusing `1,5`, `0,500`, `16,98,0`.

## Verification (measured, 8 Nov 2026)

- **`npx tsc --noEmit`** (root `tsconfig.json`, whole workspace): clean, exit 0.
- **`npm run build`** (`next build` — no dev server running): succeeded, exit 0; every route still `ƒ (Dynamic)`.
- **`npm test`** (whole `unit` project, 566 files / 11,680 tests): **11,389 passed, 223 failed**. ⚠️ Every sampled
  failure is a 5-second test timeout, not an assertion, and they reproduce **on the parent commit without this
  work**: a control worktree at `d44852d` runs the same files to the same timeouts (the machine is slow under a full
  parallel run; `t512-stage-rules` alone passes in 23s, its slowest case 3.5s).
- **ERP unit suite alone** (`apps/erp/tests`, 228 files): 10 files failed. ⭐ **One was this change and it was real** —
  `t440-s2-live-check-guard` counts any control carrying a rule-equivalent attribute (`inputMode`) that does not
  spread `nativeAttrs`, so marking the 13 boxes added 13 findings. Fixed by recording them in the guard's own
  **EXEMPT** map, one entry per file, each with the reason it cannot spread a rule (there is no field rule to spread;
  the kitchen pair's rule set exists but that section is not on a `CheckedForm` yet). The guard then reports
  469 ruled fields / 404 converted / 65 unconverted and passes, including the stale-entry check.
  The other **9 files fail identically on the parent commit** (verified: `t505-pos-tablets-page` passes alone;
  `t337`, `t384-s3-lock`, `t440-s1-checked-form`, `t511-refusal` pass alone; `t343-s5-5s`, `t502-s12`, `t502-s4`,
  `t343-scheduler-status` reproduce their 5s/20s timeouts on `d44852d` in a control worktree).
- **New tests:** 37 + 18 + 18 = 73, all green; `t504-money-commas` (22) still green.
- **Related existing suites re-run green:** `t384-s3-editable-record` (30), `t389-editable-record-typed` (28),
  `t387-s1-layout` (6), `t440-field-rules` (42), `t343-s5-5t/5v/5w` and the `t334` Input contract.

### Not done, and why

- **Smoketest in the running app.** No signed-in session is available on this machine (local Postgres is up on 5435,
  the dev server is not, and there is no credential to sign in with), and production must not be touched. The
  behaviour is exercised against a real DOM and real React 19 in `numeric-entry-dom.test.ts` instead — including
  the controlled-input tracker trap and the submit ordering — but that is **not** the same as clicking the deployed
  screen, and it is recorded as not done.

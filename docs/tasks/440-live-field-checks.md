# T-440: Live field checks on every form field with a rule

**Status:** SPEC WRITTEN 2026-10-17 (Opus planner). Audit pending. Build blocked on nothing except Ian's Q1-Q5 for the
defaults marked (rec); S1 may start on the recommended answers and be amended if Ian differs.
**Ruling:** bible row 363 (Ian, 2026-10-17). Also row 7 / §2.6 (no client-only rules), row 289 (locked records, Edit
unlocks, an add form ends in Save), row 171 / §1.2c (one family of patterns, familiar but upgraded), T-389 (a refused
save keeps typing), T-343 (`refuse()` / `userMessage`).
**Model:** Sonnet lanes (tester first, then builder). Sweep slices S3-S7 are sweep-shaped work (row 298, pre-approved
Workflow). Amendments are written in plan mode (Opus).
**Migration:** none. App + domain-leaf only.

## 1. What Ian asked for, in one paragraph
Where a field has a requirement (required, min/max length, allowed characters, a pattern such as a 10-digit SSS number,
a numeric range, a money format, a date rule), a helper line under the field says what is still missing as the user
types, and turns green with the word "Good" once satisfied. Save stays off until every rule on the form passes. Fields
with no rule are left exactly as they are. The server still checks every save, from the SAME rule definition.

## 2. Research - evaluate - propose (brief)
**Industry pattern.** Two layers everywhere: (1) native HTML constraint attributes (`required`, `maxLength`,
`inputMode`) so a browser with no JavaScript still blocks the obvious mistake, and (2) a small schema evaluated on both
client and server so messages match. GOV.UK and the WAI form tutorial both add: the message is text, not colour; the
control points at it with `aria-describedby`; `aria-invalid` marks a failing control; a blocked submit must say why.

**Options weighed.**
| Option | For | Against |
|---|---|---|
| A. zod schemas shared client/server (Next's forms guide shows zod server-side; `zod@3.24` is already in `@shareat/core` and `apps/pos`) | Standard, typed | A zod schema cannot be introspected into HTML attributes or into a "3 more digits" progress line without a parallel table; RegExp/functions do not cross the server-to-client prop boundary; adds ~13 KB to every ERP form page; domain does not use zod anywhere today |
| B. react-hook-form + zod (what `apps/pos` uses) | Mature | Needs controlled/registered inputs; `EditableRecord` requires UNCONTROLLED fields (Cancel = `form.reset()`); every server-component form would become a client component |
| **C. A tiny in-repo declarative rule set (plain JSON data) + one pure checker, in a dependency-free domain leaf** | Data crosses the server-to-client boundary as props; one function yields the HTML attrs, the live line and the server refusal sentence; follows the existing precedent `@shareat/domain/item-code` (pure leaf imported by browser and server, T-386 I5) and `@shareat/domain/money-input` | We own ~200 lines |

**Chosen: C.** It is the boring standard for this codebase: native constraints first, one shared leaf second, the
server authoritative. zod stays where it is (env, POS); nothing here forbids a later wrapper.

## 3. Design

### 3.1 The rule module - `packages/domain/src/field-rules/` exported as `@shareat/domain/field-rules`
Pure. May import only `./*`, `@shareat/core/datetime` (Manila dates) and `../shared/money-input` (`parseMoneyInput`)
plus `@shareat/core/money`. A guard (T-S1-7) fails on any other import, so the browser bundle can never pull in db/auth.

```ts
type FieldRule = {
  name: string;            // the control's name attribute, and the server input key
  label: string;           // "The SSS number" - sentence subject, same wording the server uses today
  optional?: true;         // blank passes (and is stored as null); otherwise "required"
  kind: 'text' | 'digits' | 'pattern' | 'number' | 'money' | 'date';
  min?: number; max?: number;           // length for text/digits; value for number/money
  integer?: true;                       // number
  strip?: 'spaces-dashes';              // digits: what is removed before checking AND before storing
  pattern?: string; patternSays?: string; // pattern: RegExp SOURCE (string, serialisable) + plain words ("letters and digits")
  notAfterToday?: true; notBeforeToday?: true; // date, Manila business date via toBusinessDate()
};
defineFieldRules(form: string, rules: Record<string, Omit<FieldRule,'name'>>): FieldRuleSet  // frozen; name = key
checkField(rule, raw): { ok: true; value: string | null } | { ok: false; requirement: string; progress: string }
nativeAttrs(rule): { name, required?, maxLength?, inputMode? }          // ONLY exact equivalents (§3.4)
assertFieldRules(set, input): Record<string, string | null>   // server: throws refuse(raw, requirement) on first failure,
                                                              // returns the NORMALISED values the caller must store
```
- ⛔ (Audit A1) `assertFieldRules` is NOT in the leaf: `refuse` lives in `@shareat/db` (`packages/db/src/refusal.ts`), and
  `tests/unit/client-bundle-boundary.test.ts` rule 3 walks a leaf's imports transitively and fails on any path to
  `@shareat/db`. It lives in `packages/domain/src/shared/field-rules-assert.ts` (imports the leaf + `./refusal`) and is
  exported from the `@shareat/domain` barrel only. The leaf exposes a pure `firstFailure(set, input)` it wraps.
- (Audit A5) The raw diagnostic is `` `${set.form}.${name}: ${kind} check failed` `` and NEVER contains the value (gov IDs are
  personal data; today's `setGovernmentIds` raw embeds `"${v}"` and is deleted with the inline `digits`). `requirement` and
  `progress` never interpolate the value either; the one exception is money, whose sentence is parseMoneyInput's own.
- (Audit A6) `input` is `FormData | Record<string, unknown>`; an absent key is blank; a non-string (File) is an internal fault.
  Where the domain function has callers other than ERP actions (ETL, sync ingestor, another domain function, tests that
  seed history), the call goes in the ACTION, not the domain, so a Q5 new refusal cannot break import/replay of v1 data.
- `requirement` is the one full sentence, e.g. "The SSS number must be 10 digits." It is the server's `userMessage`
  AND the line shown next to the off Save. One sentence per rule, so the two cannot drift (parity test T-S1-3).
- `progress` is the live line while typing: "3 more digits needed", "12 characters too long", "Digits only",
  "Enter an amount like 1,250.00", "Can't be after today (17 Oct 2026)", "Required". Pass = "Good" with a check icon.
- Money uses `parseMoneyInput` itself (no second money parser; DEF-272). (Audit A7) `parseMoneyInput` REFUSES commas
  (`core/money.ts` `decimal()` regex is `^-?\d+(\.\d{1,2})?$`), so the hint is "Enter an amount like 1250.00", never
  "1,250.00". Accepting commas would be a change to the one money parser for every caller: out of scope here. Dates compare `parseBusinessDate(raw)` to
  `toBusinessDate()` (Asia/Manila), never the browser's local date.
- Rule sets live in `packages/domain/src/field-rules/<area>.ts` (one file per sweep area, §5), re-exported from the leaf
  index. Each set is keyed by the SAME `<area>.<form>` key as the form's `defineTypedForm` where one exists.
- Cross-field rules (end after start; "required when tender is cash") stay server-only for now (Q4). Membership in a
  list (a select's options) stays server-only: the select already limits the choice.

### 3.2 Server side
The domain function (or, where the domain takes typed values, the action that parses FormData) calls
`assertFieldRules(SET, input)` and stores the returned normalised values. Existing inline checks that the set now
covers are DELETED in the same edit (e.g. the `digits(...)` helper in `packages/domain/src/payroll/rates.ts`
`setGovernmentIds`). A refusal flows through the existing `refuse()` -> `userMessage` -> `redirectWithFlash` path, and
T-389 keeps the typing. No new refusal path.

### 3.3 Client side - three pieces, all in `apps/erp/src/components/forms/`
Read first: `node_modules/next/dist/docs/01-app/02-guides/forms.md` (server actions, `useActionState`,
`useFormStatus`) and `01-app/01-getting-started/05-server-and-client-components.md` (props must be serialisable: this is
why rules are plain data with pattern SOURCES, never RegExp).
1. **`<CheckedForm rules={SET} action={...} {...formProps}>`** (`'use client'`) renders the `<form>` for ADD forms.
   It keeps a plain reducer state `{ values-by-name, touched-by-name }` fed by one delegated `onInput`/`onChange` on the
   form (uncontrolled controls stay uncontrolled). Provides a context `{ result(name), touched(name), active }`.
   - (Audit A2, per the Q2 ruling) Every submit control in the form is truly `disabled` while any rule fails.
     `SubmitButton` (`components/feedback/SubmitButton.tsx`) and EditableRecordView's own Save read the context
     (`disabled = pending || prop || blocked`), because SubmitButton re-renders on `pending` and would otherwise undo an
     imperative change; any other submit control (a server-rendered `<Button type="submit">`) is set `disabled`
     imperatively by CheckedForm on every check-state change. `Button.tsx` BASE already greys `disabled:`; EditableRecord's
     `PRIMARY` literal gains `disabled:pointer-events-none disabled:opacity-50` (stay ONE string literal: touch-target census).
   - Enter key: with the form's default button disabled, the browser does not submit (HTML implicit submission), so no
     submit event fires and focus stays where it is. `onSubmit` still `preventDefault()`s while blocked (belt for a form
     with no submit button, or `requestSubmit()`), marks all touched and focuses the first failing control.
   - Renders, after the children and next to Save, one `<p role="status" aria-live="polite">`:
     "Save is off until: The SSS number must be 10 digits." (first two requirements, then "and N more"). It is the
     only explanation a disabled Save has, so it is never hidden while Save is disabled. Labels are untouched.
   - (Audit A3) The T-384 guard sees only `tagName === 'form'` (`t384-s3-lock-and-save-guard.test.ts:262`), and
     `t412-destructive-census.test.ts:246` / `t387-s6-adoption.test.ts:94` search the text `<form`. S1 extends all three
     to treat `<CheckedForm` as a form (with a positive control each), else every converted add form leaves G7/G8.
   - (Audit A4) Re-read values on the form's `reset` event (deferred one task: `reset` fires BEFORE values are restored).
     That one listener covers Cancel, the registry's `close()` (another record's Edit), and React 19's automatic reset of an
     uncontrolled `<form action>` after a successful action; none of these fires `input`.
   - Before hydration (no JS, or a slow load) Save is ENABLED and only native attrs apply; the server refuses whatever
     else is wrong (§3.4). The first client render equals the server render; checks start in a layout effect that reads
     the form's current values (so a T-389 typed reopen, which writes values then fires input events, is checked too).
2. **`EditableRecord` gains `rules?: FieldRuleSet`** and uses the same reducer/context internally. LOCKED mode: checks
   inactive, no helper lines, nothing changes visually (row 289). EDITING: as above. Cancel (`form.reset()`) resets
   the check state to the stored values. The "one record open" registry is untouched.
3. **`Field` gains `rule?: FieldRule`.** With a rule, Field renders a wrapper `<div>` holding its existing `<label>`
   and, OUTSIDE the label (so the changing text never becomes part of the field's accessible name), a client
   `<FieldCheck rule>` line: `<p id={useId()} aria-live="polite">`. FieldCheck, in a layout effect, finds the control
   by `name` inside its wrapper and sets `aria-describedby` (appending, never replacing an existing id) and
   `aria-invalid="true"` while touched-and-failing. `Input`/`Select`/`Textarea` add `aria-[invalid=true]:border-danger`
   so border colour and ARIA remain one fact (Input's own contract, T-334 §4.5). FieldCheck only removes an
   `aria-invalid` it set itself: a server-rendered `invalid` (Input's declared channel) is never cleared by it.
   Line states: untouched = muted requirement ("Required - 10 digits") per Q1; touched failing = danger text + warning
   icon + progress words; passing = success text + check icon + "Good". Never colour alone. Outside a CheckedForm or
   EditableRecord context, FieldCheck renders nothing (so a Field with a rule in a stray form cannot lie).

**Per field, the sweep writes exactly two things:** `<Field label=... rule={SET.sssNo}>` and on the control
`{...nativeAttrs(SET.sssNo)}` (which supplies `name`), deleting the control's own literal `name`, `required`,
`maxLength`, `inputMode`. Mechanical by design.

### 3.4 Native attributes - only exact equivalents
`required` (unless `optional`), `maxLength` (text kind without `strip` only), `inputMode` (`numeric` for digits/integer,
`decimal` for money). NO `pattern`, `min`, `max`: the browser's reading differs from ours (a dashed SSS number, `1,250.00`,
a Manila "today") and would block input the server accepts. Dates keep `type="date"`. A no-JS submit is therefore safe
(server refuses) and never stricter than the server.

## 4. Census - how to enumerate every ruled field (mechanical)
**Scope:** every non-GET `<form>` and every `<EditableRecord>` under `apps/erp/src/app/**` and
`apps/erp/src/components/**`. GET filter forms (11 files, reports) are out. `apps/pos` (9 forms, its own
react-hook-form + zod) and `apps/customer` (1 form) are out per Q3.

**A control is RULED when any of these hold (criterion R1-R3):**
- R1 HTML: it carries `required`, `maxLength`, `minLength`, `pattern`, `min`, `max`, `inputMode="numeric|decimal"`,
  `type="number|date|email"`.
- R2 Server: the action or domain function that receives its name refuses on its presence, length, shape, range, money
  parse or date (grep the domain function for `refuse(` / `parseMoneyInput(` / `parseBusinessDate(` on that input key).
- R3 Money/qty: it is passed to `parseMoneyInput` or a quantity parser anywhere on the save path.
A control with none of these is NOT ruled and is not touched (row 363: "leave the rest alone").
An R1 control whose server never checks it is a client-only rule today: the sweep ADDS the rule server-side (Q5).

**Estimate (grep at `2e6dfa7`, `apps/erp/src/app`):** 119 files with `<form`, 27 with `<EditableRecord` (40 uses), 125
pages, 69 `actions.ts`. Attribute hits: `required` 328, `inputMode` 158, `type="date"` 78, `maxLength` 21, `pattern` 7,
`min=`/`max=` 13, `type="number"` 3. Domain: 522 `refuse(` in 77 files, ~52 of them shape/length/presence sentences.
**Expected: ~105 write forms, ~380-450 ruled fields** (fields carry several attrs, so attr hits overcount). S2 replaces
this estimate with the real census.

**Per-area attribute hits (sizes the sweep):** inventory 56, ap 35, settings 33, commissary 32, payroll 27, fixed-assets
26, menu 26, loans 25, owners 25, staff 23, attendance 22, prepaid 20, cash-requests 19, customers 18, expenses 18,
trade 18, cutover 16, statutory-discounts 16, admin 15, money-transfers 15, liabilities 13, channel-settlements 12,
items 11, sales-days 11, setup 9, wastage 9, sign-in 8, remittance 7, money-accounts 6, service-charge 5, findings 3,
budgets 2, till 2.

## 5. Slices
Every slice: tester writes failing tests first, builder makes them pass, auditor (Sonnet) reviews; local run = the
slice's tests + touched guards + `vitest --changed`; full suite in CI on the PR (row 291).

### S1 - the module, the components, two pilot forms
**Tester files:** `packages/domain/tests/unit/t440-field-rules.test.ts`, `apps/erp/tests/t440-s1-checked-form.test.ts`
(reducer + context, node-only like EditableRecord's tests), `apps/erp/tests/t440-s1-field-check-render.test.ts`
(node, `react-dom/server` render + the pure DOM-plan functions; ⛔ Audit A8: NOT `.test.tsx` — `vitest.config.mts` unit
include is `apps/**/*.test.ts`, so a `.tsx` test never runs — and NOT jsdom: no jsdom/happy-dom/testing-library is
installed. Real-DOM behaviour (Enter, focus, layout effects, reset) is proven by §6 smoke; adding jsdom is a dependency
decision for the orchestrator, not the lane), extend `tests/unit/client-bundle-boundary.test.ts` coverage by importing the
leaf from one `'use client'` file (it then walks it), extend `packages/domain/tests/integration/t190-statutory.test.ts`
(setGovernmentIds) and `packages/domain/tests/integration/supplier-master.test.ts` (createSupplier), and the three guard
extensions of Audit A3.
**Builder files:** `packages/domain/src/field-rules/{index,check}.ts` plus ONE FILE PER SWEEP AREA (§4 list, named by the
`app/<area>` folder, e.g. `staff.ts`, `ap.ts`; Audit A9) created now with an empty set and re-exported from `index.ts`, so no
sweep worker ever edits `index.ts`; `packages/domain/src/shared/field-rules-assert.ts` (A1) + barrel export,
`packages/domain/package.json` (export `./field-rules`), `packages/domain/src/payroll/rates.ts` (delete inline `digits`),
`apps/erp/src/components/forms/{CheckedForm,FieldCheck,index}.tsx|ts`, `EditableRecord.tsx` (`rules` prop),
`components/feedback/SubmitButton.tsx` (reads context, A2), `components/ui/{FormGrid,Input,Select,Textarea}.tsx`, pilots:
staff government IDs (`app/staff/[employmentId]/page.tsx:222`, EditableRecord, SSS/PhilHealth/Pag-IBIG/TIN, all optional)
and the supplier ADD form (`app/ap/page.tsx:101`, CheckedForm; name required, `creditTermsDays` optional integer 0-365 —
Audit A10: there is NO TIN on this form; "required when On credit" is cross-field, Q4, stays server-only).
**Tests, each naming the mutant it kills:**
- T-S1-1 digits: 10 passes, 9 and 11 fail; "12-345 6789-0" passes and normalises to 10 digits. *Mutant:* `<=` for `<`;
  strip removed.
- T-S1-2 money: "0.004", "1.234", "abc", "1e400", "1,250.00" fail with parseMoneyInput's own sentence; "1250.00" passes (A7).
  *Mutant:* `Number(x) > 0` substitute.
- T-S1-3 parity: for every rule in every set, for a fixture of bad values, `assertFieldRules` throws a RefusalError
  whose `userMessage` === `checkField(...).requirement`. *Mutant:* edit one server sentence.
- T-S1-4 Manila date: at `2026-10-17T16:30:00Z` (= 18 Oct in Manila) `notAfterToday` passes "2026-10-18".
  *Mutant:* UTC `new Date().toISOString().slice(0,10)`.
- T-S1-5 optional blank -> `{ ok: true, value: null }`; required blank -> "Required". *Mutant:* ignore `optional`.
- T-S1-6 nativeAttrs never emits `pattern`/`min`/`max`; emits `maxLength` only for unstripped text. *Mutant:* add pattern.
- T-S1-7 leaf purity: every file in `field-rules/` imports only the allowed list (§3.1). *Mutant:* import `@shareat/db`.
- T-S1-8 CheckedForm (Q2 = truly disabled): failing state -> SubmitButton and EditableRecord Save render `disabled`, the
  status line names the first requirement; passing -> enabled, no status line; `pending` ending does not re-enable a
  blocked Save; the submit handler `preventDefault()`s while blocked. *Mutants:* `aria-disabled` instead of `disabled`;
  SubmitButton ignores context; guard only `onClick`.
- T-S1-9 FieldCheck: control gets `aria-describedby` = helper id (existing ids kept), `aria-invalid` only when touched
  and failing; passing line contains the text "Good" (not only a class). *Mutant:* replace describedby; colour-only pass.
- T-S1-10 EditableRecord: locked -> no helper lines and Save not marked; Edit -> checks active; Cancel -> state back to
  stored values. *Mutant:* checks active while locked.
- T-S1-11 first render equals server render (Save not aria-disabled before the effect). *Mutant:* initial state
  computed from rules alone (would block no-JS submit).
- T-S1-12 integration: `setGovernmentIds` refuses "123" with "The SSS number must be 10 digits." and stores the stripped
  value for "12-3456789-0". *Mutant:* store raw input.
- T-S1-13 typed reopen (T-389): a refused save that reopens editing shows the helper lines for the typed values. (A11:
  neither pilot can show this — the gov-ID record is `typed={null}` and sssNo/philhealthNo/pagibigNo are `isNeverEchoed`;
  an add form keeps nothing (`keepTyping` needs a record). Use a fixture EditableRecord with a non-sensitive field.)
- T-S1-14 reset: Cancel, registry `close()` and a bare `form.reset()` all return the check state to the stored values.
  *Mutant:* re-read only in the Cancel click handler.
- T-S1-15 no echo (A5): a failing gov-ID value appears in no requirement, progress, status line, `RefusalError.message`
  or `userMessage`. *Mutant:* raw diagnostic interpolates the value.
- T-S1-16 guards stay sighted (A3): a `<CheckedForm>` ending in "Save item" is flagged by t384 G8; a ConfirmDestructive
  inside a `<CheckedForm action={x}>` satisfies t412. *Mutant:* revert the tag list to `'form'` only.

### S2 - census + guard ratchet
**Tester/builder files:** `apps/erp/tests/t440-s2-live-check-guard.test.ts`, `apps/erp/tests/live-check-baseline.json`
(seeded by the ORCHESTRATOR from HEAD counts, lowered only by the orchestrator, like T-384's baselines),
`docs/tasks/440-census.md` (generated table: file, form, field, R1/R2/R3, server function, target area slice).
Census run = one Haiku agent per area, merged by a script; R1 is computed by the guard itself, R2/R3 recorded by agents.
**Guard rules (TypeScript AST, like `t384-s3-lock-and-save-guard.test.ts`):**
- G1 Inside a non-GET form, a control with a literal R1 attribute (`required`, `maxLength`, `minLength`, `pattern`,
  `min`, `max`, `inputMode` numeric/decimal) that is not spread from `nativeAttrs(` is a finding.
- G2 A control spread from `nativeAttrs(X.y)` must sit inside `<Field rule={X.y}>` and inside a `<CheckedForm rules={X}>`
  or `<EditableRecord rules={X}>`; same set on both. Finding otherwise.
- G3 Every rule set exported from `field-rules/` is passed to `assertFieldRules(` somewhere in `packages/domain/src` or
  `apps/erp/src/app/**/actions.ts` (no client-only rules, row 7). *Mutant:* delete the server call -> red.
- G4 Every census row marked R2/R3 names a field that is in a rule set (the "server rule lacks a live check" ratchet).
- G5 Positive controls on literal fixtures so G1-G4 cannot go blind.
Ratchet: a file's finding count may never exceed its baseline; a stale (too high) entry fails. Ends empty at S7.
**Audit A12 (guard scope, so it cannot false-positive across ~105 forms):** "a form" = JSX tag `form` (non-GET),
`CheckedForm` or `EditableRecord` (its children). G1 skips `type="hidden|file|checkbox|radio"` and controls rendered by a
shared component whose `name` is not a string literal (MoneyLines `${name}Amount_${i}`, 27 templated names in 9 files, 22
`name={expr}` props; ConfirmDestructive's controlled `adminPin`/`confirmName`). Those are listed, with a reason, in an
`EXEMPT` map in the guard (stale entries fail), never silently ignored; "delete EXEMPT leftovers" in S7 refers to it.
`type="email"` (3 uses) is R1 and becomes a `pattern` rule with its server check (Q5).

### S3-S7 - the sweep (parallel Sonnet workers, Workflow pre-approved)
**Unit of work = one AREA, not one file**, because each area owns one `field-rules/<area>.ts`; two workers must never
write the same rules file. Domain files shared across areas (rare) are listed in the census and owned by the first slice
that names them; the orchestrator serialises any collision. Each worker, per form: census rows -> rule set entries ->
`assertFieldRules` in the domain/action (delete the replaced inline check) -> `<Field rule>` + `nativeAttrs` ->
`CheckedForm`/`EditableRecord rules` -> lower its baseline rows -> add one test per area: parity fixture + one integration
refusal per newly server-enforced rule (Q5).
| Slice | Areas | Approx. attr hits |
|---|---|---|
| S3 people | staff, payroll, attendance, admin, setup, owners, sign-in | 129 |
| S4 payables & receivables | ap, customers, trade, prepaid, liabilities, loans | 129 |
| S5 stock & menu | inventory, items, commissary, wastage, cutover, menu | 150 |
| S6 money | cash-requests, channel-settlements, expenses, money-accounts, money-transfers, remittance, sales-days, service-charge, statutory-discounts, till, budgets, fixed-assets | 144 |
| S7 settings + close | settings, findings, reports (non-GET: `reports/dual-run/[store]/[week]` disposition form has `pattern`+`required`+`maxLength`; `reports/pos-reconciliation` recheck), clock (`clock/page.tsx` pair + scan forms), `components/**` forms; baseline must be EMPTY; delete EXEMPT leftovers | 39+ |
**Builder files per slice:** that slice's `apps/erp/src/app/<area>/**/*.tsx`, `<area>/**/actions.ts`,
`packages/domain/src/field-rules/<area>.ts` (pre-created in S1, A9), the domain files named in its census rows.
⛔ (Audit A13) Workers NEVER edit `live-check-baseline.json` or `field-rules/index.ts`: the baseline is lowered by the
orchestrator after merging (as S2 says), and the index is complete from S1. A census row whose domain file is shared by
two areas is assigned to ONE area in `440-census.md` before the Workflow starts; the other area's worker does not open it.
Workflow unit = one AREA (its rules file is the shared write), tester agent first, then builder, per area.
**Tester files per slice:** `apps/erp/tests/t440-s<N>-<area>.test.ts`, the integration tests named in census rows.
Sign-in (S3): PIN/password fields get required/length rules only; `isNeverEchoed` names are never written to the live
state's logs (there are none) and the helper never repeats the value.

## 6. Smoke (§9.4, browser, port 9008, screenshots attached to the slice's hand-back)
Per slice, at least: one ADD form and one EditableRecord form at 1280 px and 375 px.
1. Empty add form: muted requirement lines (Q1), Save greyed, status line names what is missing.
2. Type 9 digits in SSS: "1 more digit needed" in danger text with icon; 10th digit: "Good" with check icon.
3. Press Enter in a field while failing: no request in the network tab; nothing is submitted (Save is `disabled`).
4. Save is greyed and `disabled` (read_page); the status sentence next to it says what is missing; fixing the last field
   enables it with no reload.
5. Locked record: no helper lines; Edit -> lines appear; Cancel -> gone and values restored.
6. JS disabled (or throttled before hydration): submit a bad SSS -> server refuses with the same sentence; typing kept.
7. Dark mode and 375 px: helper lines wrap, no sideways scroll.

## 7. Out of scope
Cross-field rules live (Q4); select membership; uniqueness checks needing the database (name already taken) - these stay
server refusals; `apps/pos`, `apps/customer`, `apps/website` (Q3); GET filter forms; re-wording existing server
sentences beyond moving them into rule sets; any change to `constraint-messages.ts` (database CHECKs remain the last word).

## 8. Questions for Ian (plain words; recommended option marked)
- **Q1 Before typing, what does a field with a rule show?** (a) **(rec)** a small grey line saying what it needs
  ("Required - 10 digits"), turning red or green once you type; (b) nothing until you start typing. (a) tells staff
  what to enter before they get it wrong.
- **Q2 How "off" is Save?** (a) **(rec)** greyed out, but clicking it jumps to the first field to fix and says why;
  (b) completely unclickable. (a) works for keyboard and screen-reader users and never leaves someone stuck guessing.
- **Q3 Which apps?** (a) **(rec)** ERP now; POS and the customer app later as their own task (POS already has its own
  checks on its 9 forms); (b) all three now. (a) keeps this task finishable.
- **Q4 Rules that compare two fields** (end date after start date; "required when paid by cash"): (a) **(rec)** keep
  them as save-time refusals for now; (b) check them live too. (b) roughly adds a slice.
- **Q5 Fields marked "required" on screen that the server never actually checked:** (a) **(rec)** the server starts
  refusing them too, so the screen and the server agree; (b) remove the required mark. The rule forbids a check that
  only the screen does, so one of these must happen; (a) keeps the intent of whoever marked it required.

## Orchestrator rulings 2026-10-17 (Ian's words decide Q2)

- **Q1 = a:** a grey "what it needs" line shows before typing; green once satisfied.
- **Q2 = b (overrides the recommendation, per Ian's own words: "disable save button unless requirement is satisfied"):** Save is truly `disabled` while any rule fails. Accessibility is kept by a visible, aria-live summary next to Save listing what is missing (and each field's aria-describedby line), so a disabled Save is never unexplained. Before scripts load (no JS), Save stays enabled and the server refuses — unchanged.
- **Q3 = a:** ERP now; POS v2 and Customer v2 later.
- **Q4 = a:** cross-field checks stay as refusals on save for now.
- **Q5 = a:** a field marked required on screen but never checked by the server gains the server check too.

## Audit 2026-10-17 (Opus spec auditor; checked against main `262c71f`)
Changes folded in (each tagged `Audit An` in place):
- A1 `assertFieldRules` moved out of the leaf to `shared/field-rules-assert.ts` (barrel only): `refuse` is in `@shareat/db`, which `client-bundle-boundary.test.ts` rule 3 forbids in any leaf.
- A2 §3.3 rewritten for the Q2 ruling: truly `disabled`; SubmitButton + EditableRecord Save read the context; `PRIMARY` gains `disabled:` classes; Enter = browser implicit submission blocked by the disabled default button; status line is Save's only explanation.
- A3 t384 G7/G8 (`tagName === 'form'`), t412 and t387-s6 (text `<form`) would go blind on `<CheckedForm>`; S1 extends them (T-S1-16).
- A4 Re-read check state on the `reset` event: covers Cancel, registry `close()`, React 19 auto-reset after a successful action (none fires `input`).
- A5 No value in raw diagnostics, requirement, progress or status line (gov IDs); T-S1-15.
- A6 `assertFieldRules` input shape; call goes in the action when the domain function has non-ERP callers (ETL/replay safety for Q5).
- A7 `parseMoneyInput` refuses "1,250.00"; hint and T-S1-2 corrected.
- A8 Tests: `.test.tsx` never runs (include is `apps/**/*.test.ts`) and jsdom is not installed; node render + smoke instead.
- A9 Rules files named by `app/<area>` folder, all pre-created in S1 with `index.ts` complete (pilots were `people.ts`/`suppliers.ts`, which matched no area).
- A10 Supplier add form has no TIN; pilot fields corrected; paths with line numbers given. Integration test paths corrected (`t190-statutory`, `supplier-master`).
- A11 T-S1-13 cannot run on either pilot (typed={null}, sensitive names, add forms keep nothing); fixture instead. T-S1-14 added.
- A12 G1 scope: CheckedForm/EditableRecord count as forms; hidden/file/checkbox/radio and non-literal names go to a reasoned EXEMPT map; `type="email"` handled.
- A13 Workers never edit the baseline or `index.ts`; shared domain files pre-assigned in the census; `reports` (non-GET) and `clock` added to S7.

Open (need a decision, not folded):
- O1 `tin` is NOT in keep-typing's `SENSITIVE` set while SSS/PhilHealth/Pag-IBIG are (row 353 calls government IDs as sensitive as a bank account). Intentional, or a defect to register?
- O2 Repeated families (MoneyLines per-line amounts, 9 files) get no live check under A12. Row 363 says "every field with a rule": accept the exemption, or add a family rule (`namePattern`) as a follow-up slice?
- O3 G3 proves a set reaches `assertFieldRules` somewhere, not on that form's own save path; the per-area integration refusal test is what pins the path. Acceptable, or make G3 resolve the form's action (like t389 G10c)?
- O4 Adding jsdom (dev dependency) would let T-S1-8/9/14 run against a real DOM; orchestrator's call.

## Orchestrator rulings on the audit's open items (2026-10-17)

- **O1:** intentional. Business TINs (supplier, organisation) stay keepable; the personal government-ID form is TYPED_EXEMPT as a whole and SSS/PhilHealth/Pag-IBIG are SENSITIVE (commit d798ee5).
- **O2:** repeated line fields (MoneyLines etc., 9 files) get live checks in a follow-up slice **S8**, after S3-S7; keep them on the exemption map until then.
- **O3:** tighten. G3 must prove the rule set is asserted in THAT form's own action (the action named by the form calls assertFieldRules with that rule set), not merely somewhere on the server.
- **O4:** no jsdom; node rendering + the §9.4 browser smoke.
- **Status:** AUDITED 2026-10-17; S1 building.

## Orchestrator ruling (sweep reconcile, 2026-10-17)

- **Authorization before field checks, everywhere** (A2 stands). The sweep placed assertFieldRules before authorize() in converted actions (DEF-676). The two pinned cases are fixed in the reconcile; **S9** restores auth-first order in every converted action and adds a guard test.

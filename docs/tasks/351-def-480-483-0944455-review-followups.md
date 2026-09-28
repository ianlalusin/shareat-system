# T-351: follow-ups from the post-commit `/code-review 0944455` (DEF-480..483)

**Status:** DONE 2026-09-28 (full gates PASS; screens partly driven, AP/loan legs integration-only; post-commit audit pending). APPROVED 2026-09-28 (orchestrator, after an independent Opus spec audit; amendments M1–M6 at the end bind). **Model:** Sonnet, tester then builder.
**Migration:** none. Every item is domain, action or render code; the one DB rule involved
(`supplier_invoice_lines_unit_price_not_negative_check`, `0047:69`) already exists and is not changed.
**Runs after** T-350 (`0ffb0fe`, which touched `channel-settlements/index.ts`) and T-349 S2c. No path here overlaps
S2c's paths (`repo/access.ts`, `admin/users/*`). One slice at a time per lane.
Line numbers were checked at HEAD `0ffb0fe`.

## Why
The post-commit review of `0944455` (T-343 S5.5u/v/w) found four leftovers. All four were verified by an independent
Opus read (register rows DEF-480..483):
1. **DEF-480 (Med).** The AP invoice unit price box became text. The server guard never followed it.
2. **DEF-481 (Med).** Loans and prepaid parse whole numbers before `authorize()`, and they check the digit run, not
   the value.
3. **DEF-482 (Low-Med).** The settlement preview shows a green "reconciles exactly" row above a red blocker list.
4. **DEF-483 (Low).** A parity slip in `quantity-input.ts`, and a comment in `catalogue.ts` that says the opposite of
   what the code does.

## Rulings (planner, 2026-09-28)

- **R1: the AP unit price goes through `parseFourDecimalCost`, in the domain, after `authorize()`.**
  - `validateInvoiceLines` runs only inside `recordInvoice` (`ap/index.ts:295` authorizes, `:366` validates) and
    `setInvoiceLines` (`:421` authorizes, `:433` validates). A parse inside it is therefore post-authorize on every
    path.
  - `parseFourDecimalCost` (`commissary/catalogue.ts:53`) is the shared parser for `numeric(14,4)` costs. It already
    refuses a sign, refuses more than four decimals, and caps the integer part at 10 digits after stripping leading
    zeros, so the cap is on the value: "below 10000000000". It accepts `.5`, `8.` and `005`.
  - **No new `>= 0` comparison.** The T-340 comment at `items/index.ts:233-234` avoided one because of the
    money-positivity census (`shared/money-positivity-census.ts`, `NUMBER_CMP` `:97`). A shape parser adds no census
    site. That comment is replaced, not contradicted.
  - **Refuse, never round, past four decimals.** This matches every other cost box. Once `12.34565` is refused, the
    string the action multiplies (`ap/actions.ts:196`) is byte-for-byte the string that is stored. That makes
    "lineTotal from the parsed price" true by construction, so **`ap/actions.ts` does not change**.
  - **The finiteness check stays first.** `abc`, `NaN` and `Infinity` keep today's raw sentence ("…the unit price "abc"
    is not a number"), which is pinned by `packages/domain/tests/integration/items.test.ts:306,328,347,504`. It becomes
    `refuse(sameRaw, human)`. The parse runs after it.
- **R2: no `constraint-messages.ts` entry for `supplier_invoice_lines_unit_price_not_negative_check`.** After R1 no app
  path can reach that check. `CONSTRAINT_MESSAGES` is also the `/setup` URL allowlist, and a count guard pins it
  (`apps/erp/tests/constraint-messages.test.ts`, per the comment at `constraint-messages.ts:371-374`). If the check
  ever fires, the unmapped-refusal register records it. That is the correct signal.
- **R3: negative AP unit prices stay forbidden. There is no question for Ian.**
  - The v2 schema already decided this (`0047:69`, `unit_price >= 0`; `:70`, `line_total >= 0`).
  - v1 has no invoice line items at all. `ERP-rebuild/src/app/financial/receipts/receipt-editor.tsx:33` keeps only a
    total, with `min(0.01)`.
  - v1's own blueprint routes a supplier return to "a reversing expense or supplier credit memo"
    (`ERP-rebuild/src/lib/financial/ACCOUNTING_BLUEPRINT.md:1215`), never to a negative line.
  - A supplier credit is a document feature, not a sign on a price.
- **R4: whole-number fields are parsed in the domain after `authorize()`.** This follows `0944455`'s own precedent for
  settlement gross/net: the action passes the raw string, and `collectSettlementFigureBlockers` parses it after
  `authorize`.
  - The attendance fix did not produce a shared parser. Its `int()` (`settings/attendance/actions.ts:57-76`) is local
    to a `'use server'` file, and such a file can export only async functions. So this slice extracts the same shape
    into a new domain helper: digits only, then a VALUE range, no length cap.
  - Every existing human sentence stays **byte-identical**. They are pinned by
    `t343-s5-5v-followups.test.ts:294-295` and `t343-s5-5w-followups.test.ts:248,265`.
- **R5: the preview says whether its figures were computed.** In the form, figures and blockers are both visible only
  as numbers, and a config blocker (for example an unwired payout account) sits beside REAL arithmetic that is worth
  seeing. Hiding the reconcile row on any blocker would throw that away.
  - The domain adds `figuresComputed` to `SettlementPreview`.
  - When it is false, the form shows no figure rows at all. Every zero in `ZERO_COMPUTED_SETTLEMENT` is fake, not only
    the "reconciles" row: "Banked ₱0.00" under a typed `1,5` misleads too.
  - When figures computed but blockers exist, the Difference row loses its good tone.

## BUILDER items

1. **DEF-480: AP unit price.** In `packages/domain/src/items/index.ts`, `validateInvoiceLines`:
   1. `:232-237`: replace the T-340 comment and the raw `throw new Error` with
      `throw refuse(<the same raw string, byte-identical>, \`Line ${i + 1} (${item.name})'s unit price — "${l.unitPrice}" is not a number.\`)`.
      `refuse` is already imported (`:26`).
   2. Directly after it, parse the price:
      `const unitPrice = parseFourDecimalCost(l.unitPrice, \`validateInvoiceLines: line ${i + 1} (${item.name})'s unit price\`, \`Line ${i + 1} (${item.name})'s unit price\`);`
      - Import it from `'../commissary/catalogue'`. Check that this import creates no cycle. If it does, STOP and
        report it; do not move the function.
      - The comment says: shape and precision via the shared cost parser, which never compares with zero (census), and
        refuses more than four decimals so the action's `quantity × price` uses the stored string.
   3. `:266`: store `unitPrice` (the parsed, trimmed string), not `l.unitPrice`.
   4. The line-total finiteness throw (`:238-240`) and the reconcile throws are unchanged (out of scope).
2. **DEF-481: shared whole-number parser.** New file `packages/domain/src/shared/whole-number-input.ts`:
   ```ts
   export function parseWholeNumberInput(
     raw: string | number, rawLabel: string, humanLabel: string,
     min: number, max: number, unit = '',   // unit: '' or ' of months'
   ): number
   ```
   - `const trimmed = String(raw).trim();` (parity with `money-input.ts:51`).
   - Blank → `refuse(\`${rawLabel} is blank\`, \`${humanLabel} — enter a whole number${unit} from ${min} to ${max}.\`)`.
   - `!/^\d+$/.test(trimmed)`, or `n < min`, or `n > max`, where `const n = Number(trimmed)`, →
     `refuse(\`${rawLabel} is not a whole number${unit} from ${min} to ${max}: ${JSON.stringify(raw)}\`, \`${humanLabel} — "${trimmed}" is not a whole number${unit} from ${min} to ${max}.\`)`.
   - Return `n`. Compare only the local `n`, never `Number(…) <op> 0` (census `NUMBER_CMP`). Refusals are `refuse(...)`
     only.
   - JSDoc: the attendance `int()` shape (T-343 S5.5w A3). `000012` is 12. The ceiling is stated in the sentence.
     Parsing happens in the domain after `authorize()` (DEF-481).
   - Not exported from `packages/domain/src/index.ts`. Nothing in the app needs it.
3. **DEF-481: loans.**
   - `packages/domain/src/loans/index.ts`: `CreateLoanInput.termPeriods` becomes `number | string` (`:36`). In
     `createLoan`, after the interest-rate check (`:63-70`), add
     `const termPeriods = parseWholeNumberInput(input.termPeriods, 'createLoan: the number of payments', 'The number of payments', 1, 99999);`
     and insert `termPeriods` (`:81`).
   - `apps/erp/src/app/loans/actions.ts`: delete `wholePayments` (`:30-43`). Pass
     `termPeriods: str(formData, 'termPeriods')` raw. Drop the `refuse` import if nothing else uses it. Replace the
     comment with one line: parsed in `createLoan` after `authorize()` (T-351/DEF-481).
4. **DEF-481: prepaid.**
   - `packages/domain/src/prepaid/index.ts`:
     - `CreatePrepaidItemInput.coverageMonths` (`:52`) and `confirmPrepaidTerm`'s `input.coverageMonths` (`:150`)
       become `number | string`.
     - In `runCreate`, right after the name check (`:101-102`), add
       `const coverageMonths = parseWholeNumberInput(input.coverageMonths, 'createPrepaidItem: the coverage', 'The coverage', 1, 120, ' of months');`
       and insert it (`:128`).
     - In `confirmPrepaidTerm`, replace the raw `Number.isInteger` throw (`:154-156`) with the same call (raw label
       `'confirmPrepaidTerm: the coverage'`), and use the parsed number at `:165-172`.
   - `apps/erp/src/app/prepaid/actions.ts`: delete `wholeMonths` (`:29-42`). Pass `str(formData, 'coverageMonths')`
     raw at `:55` and `:107`. Drop the `refuse` import if it becomes unused.
   - ⛔ Leave the "Choose a store." raw throws (`loans/actions.ts:49`, `prepaid/actions.ts:54`) alone. They leak
     nothing and are not this slice.
5. **DEF-482: preview flag and render.**
   - `packages/domain/src/channel-settlements/index.ts`: add `figuresComputed: boolean` to `SettlementPreview`
     (`:91-113`), with a JSDoc saying false means every figure field is a placeholder zero, so show none of them. Set
     it to `figureBlockers.length === 0` in `previewChannelSettlement`'s return (`:409-423`).
   - `apps/erp/src/app/channel-settlements/SettlementForm.tsx`:
     1. `PreviewShape` (`:48-61`) gains `figuresComputed: boolean`.
     2. Extract the `<dl>…</dl>` (`:454-480`) into
        `export function SettlementPreviewFigures({ preview }: { preview: PreviewShape })` in the same file. It uses
        the module-private `Row` and `money`. `SettlementForm` renders `<SettlementPreviewFigures preview={preview} />`
        in its place.
     3. When `!preview.figuresComputed`, render no rows. Render instead
        `<p className="text-sm text-neutral-600 dark:text-neutral-400">The arithmetic appears once every figure reads as an amount — fix the ones listed below, then check again.</p>`.
     4. When figures computed, the rows are as today, except the Difference row
        (`:476-478`) takes `tone="good"` only when `preview.blockers.length === 0`, and no tone otherwise.
     5. The blocker list, the gain acknowledgement, `stale` and `canPost` do not change.
6. **DEF-483.**
   - `packages/domain/src/shared/quantity-input.ts:27`: `const trimmed = String(raw).trim();`. Add a comment citing
     `money-input.ts`'s reason: a non-string must still get a sentence, not a `TypeError` from the catch block itself.
   - `packages/domain/src/commissary/catalogue.ts:40-41`: rewrite the comment to say what really happened.
     - S5.5w A1 1b WIDENED the pattern. It replaced `/^\d+(\.\d{1,4})?$/`, which rejected `.5` and `1.`.
     - `.5`, `1.` and `005` now pass for every user of the pattern: `parseFourDecimalCost`'s callers (deliveries and
       cutover, and AP invoice lines from T-351) and `upsertOffering`'s manual cost (`:207`).
     - The lookahead still rejects `""` and `"."`.
     - Code is unchanged.

**BUILDER paths:** `packages/domain/src/items/index.ts`, `packages/domain/src/shared/whole-number-input.ts` (new),
`packages/domain/src/loans/index.ts`, `packages/domain/src/prepaid/index.ts`, `apps/erp/src/app/loans/actions.ts`,
`apps/erp/src/app/prepaid/actions.ts`, `packages/domain/src/channel-settlements/index.ts`,
`apps/erp/src/app/channel-settlements/SettlementForm.tsx`, `packages/domain/src/shared/quantity-input.ts`,
`packages/domain/src/commissary/catalogue.ts`.
⛔ Not `ap/actions.ts` (R1), not `constraint-messages.ts` (R2), not `ap/invoices/[id]/page.tsx` (a text box with no
`min` is the T-343 rule), and no test file.

## TESTER paths
- **New files.**
  - `packages/domain/tests/integration/t351-review-followups.test.ts`: A1-A5, D1-D2, S1-S3.
  - `apps/erp/tests/integration/t351-review-followups.test.ts`: A6, W1-W7. Real Postgres. Mock `next/navigation`,
    `../../src/lib/session` and `@/lib/constraint-messages` exactly as `t343-s5-5v-followups.test.ts:36-49` does.
  - `apps/erp/tests/t351-settlement-preview-render.test.ts`: R1-R4. Use `renderToStaticMarkup`, as in
    `t343-s5-5r-prepaid-refund-render.test.ts`.
  - `packages/domain/src/shared/quantity-input.test.ts`: Q1-Q2. Colocated like `money-input.test.ts`.
- **Ruled edits.** Each is a behaviour or label correction, not a weakening. Record each in the TESTER report.
  - `apps/erp/tests/t343-s5-5w-number-boxes.test.ts:63`: retitle `(decimal, SAFE server-side)` to
    `(decimal; server guard: T-351 A-legs)`. The assertions are unchanged, because they test markup only and the
    title claimed more.
  - `apps/erp/tests/integration/t343-s5-5w-followups.test.ts:653-667` ("C2 sibling"): measure first. If the delivery
    saves today (the widening landed in `0944455`), drop the `instanceof Error` branch and assert the target directly
    (`unit_cost === '0.5000'`). A test that passes down either branch proves nothing. If it does NOT save, STOP and
    report; that contradicts DEF-483.
  - ⛔ `tests/unit/t343-throw-ratchet.test.ts` is not edited. Its check is `<=`, and this slice only removes raw throws
    (`items` −1, `prepaid` −1). The orchestrator may lower `items`/`prepaid` at commit from the measured counts.
  - ⛔ `packages/domain/tests/integration/items.test.ts` is not edited. I1-I4 must stay green unchanged, and they are
    the guard for R1's "finiteness first".

## Legs
Every leg asserts the TARGET. Record the raw red for each one. Fixtures: reuse `items.test.ts`'s `fixture` /
`porkBelly` / `evidence` shape for the A-legs. For the W-legs, an org with an admin plus a MANAGER. The TESTER
confirms from `CAPABILITY_MATRIX` that a manager lacks `manage_chart_of_accounts` and `manage_prepaid_items`, and
names the role actually used.

| Id | Item | Case | Target | Red today |
|---|---|---|---|---|
| A1 | 1 | `setInvoiceLines` with one line `unitPrice '-5'`, qty `'10'`, lineTotal `'-50.00'`, over an invoice already holding one good line | rejects with `userMessage` `Line 1 (Pork belly…)'s unit price — "-5" is not a valid amount. Use a non-negative number with up to four decimal places.`; ⛔ the prior line is still there, unchanged | a raw Postgres 23514 (`…unit_price_not_negative_check`) with no `userMessage` |
| A2 | 1 | `unitPrice '12.34565'`, qty `'1'`, lineTotal `'12.35'` (what the action computes) | rejects with the same four-decimals sentence; nothing written | saves `12.3457` |
| A3 | 1 | `unitPrice '12.34565'`, qty `'1000'`, lineTotal `'12345.65'` | as A2 | a raw 23514 `supplier_invoice_lines_arithmetic_check` (stored 12.3457 × 1000 = 12345.70) |
| A4 | 1 | `unitPrice '12345678901'` (qty 1, lineTotal to match, invoice total to match) | `…is too large. Use a number below 10000000000.` | a raw 22003 numeric overflow |
| A5 | 1 | `unitPrice '.5'` qty `'10'` lineTotal `'5.00'`; then `'005'` qty `'1'` lineTotal `'5.00'`; then `' 8. '` qty `'1'` lineTotal `'8.00'` | each saves; stored `unit_price` = `0.5000` / `5.0000` / `8.0000` | green (guard), except that the trimmed store is only observable for `' 8. '` via the domain |
| A5b | 1 | `unitPrice 'abc'` | the `.message` still matches `items.test.ts:306`'s regex; ⛔ `userMessage` = `Line 1 (Pork belly…)'s unit price — "abc" is not a number.` | no `userMessage` |
| A6 | 1 | `setInvoiceLinesAction` with `line1_unitPrice=-5` | the redirect `error` = A1's sentence | the generic DB-refused fallback |
| W1 | 3 | MANAGER calls `createLoanAction` with `termPeriods='abc'` (every other field valid) | the redirect `error` equals EXACTLY what the same manager gets for the same form with `termPeriods='12'` (the auth refusal); ⛔ it does not contain "number of payments" | the payments sentence |
| W2 | 3 | admin, `termPeriods='000012'` | saved; `loans.term_periods = 12` | "…is not a whole number from 1 to 99999." |
| W3 | 3 | admin, `termPeriods='100000'` | `The number of payments — "100000" is not a whole number from 1 to 99999.`; no row | green (guard) |
| W4 | 4 | MANAGER, `createPrepaidItemAction` with `coverageMonths='abc'` | equals the manager's refusal for `coverageMonths='12'`; ⛔ no "The coverage" | the coverage sentence |
| W5 | 4 | admin, `coverageMonths='0012'` | saved; `coverage_months = 12` | refused |
| W6 | 4 | MANAGER, `confirmTermAction` with `coverageMonths='abc'` on a needs-review item | equals the manager's refusal for `'12'` | the coverage sentence |
| W7 | 4 | admin, `confirmTermAction` with `'0012'` | `coverage_months = 12`, `needs_review` false | refused |
| D1 | 2/4 | `confirmPrepaidTerm` direct, `coverageMonths: 1.5` (a number) | rejects with `userMessage` `The coverage — "1.5" is not a whole number of months from 1 to 120.` | a raw Error, no `userMessage` |
| D2 | 2/3 | `createLoan` direct, `termPeriods: 12` (a number) | saves 12 | green (guard: numeric callers still work) |
| S1 | 5 | `previewChannelSettlement` with gross `'1,5'` | `figuresComputed === false`; `blockers` contains the gross sentence | `figuresComputed` undefined |
| S2 | 5 | valid figures on a channel with a config blocker (the TESTER names it, e.g. no payout account) | `figuresComputed === true`; `blockers.length > 0` | undefined |
| S3 | 5 | valid figures, no blockers | `figuresComputed === true`, `blockers` empty | undefined |
| R1 | 5 | `SettlementPreviewFigures` with `figuresComputed:false`, variance/gain `'0.00'`, one blocker | ⛔ no "reconciles exactly", no "Banked", no "This settlement clears"; + contains "The arithmetic appears once every figure reads as an amount" | the export does not exist (the import fails; state that this is the red) |
| R2 | 5 | `figuresComputed:true`, variance 0, one config blocker | "reconciles exactly" present, and its row has no `text-emerald-700` | as R1 |
| R3 | 5 | `figuresComputed:true`, variance 0, no blockers | "reconciles exactly" with `text-emerald-700` | as R1 (then a guard) |
| R4 | 5 | `figuresComputed:true`, variance `'12.00'` | the Shortfall row present; no "reconciles exactly" | as R1 (then a guard) |
| Q1 | 6 | `parseQuantityInput(NaN as unknown as string, 'raw', 'Human')` | throws a refusal whose `userMessage` = `Human — "NaN" is not a valid quantity. Use at most three decimal places.` | a `TypeError` ("raw.trim is not a function") |
| Q2 | 6 | `parseQuantityInput(1.2345 as unknown as string, …)` (a precision-loss RangeError) | the same decimal-places sentence, with `"1.2345"` | a `TypeError` |

## §9.4
Smoketest in Chrome on 9008, per `docs/SMOKETEST.md`:
- **AP invoice lines.** `-5` is refused in words. `.5` saves.
- **Loans.** Create one with `000012` payments.
- **Prepaid.** Create one with `0012` months.
- **Channel settlement.** "Check the numbers" with gross `1,5` shows no figure rows and no green line. With a valid
  gross it shows the arithmetic.

Take a screenshot of each.

## Out of scope
- The AP action's float `Number(q) * Number(p)` for `lineTotal`. The DB tolerance is 0.01 and it does not misfire at
  four-decimal prices. An exact-decimal multiply is a candidate follow-up.
- Mapping the other `supplier_invoice_lines_*` checks, and the line-total finiteness throw.
- The "Choose a store." raw throws in both actions.
- A supplier credit memo (R3). If the business needs one, it goes into `CAPABILITY-GAPS.md`, not a negative price.
- DEF-383 (converging `upsertOffering` onto `parseFourDecimalCost`).

## Done when
- Every red leg goes red→green and every guard stays green.
- `items.test.ts` I1-I4 and every `t343-s5-5v/5w-followups` sentence are green UNCHANGED.
- The money-positivity guard and the throw ratchet are green with no edit.
- Typecheck is clean, §9.4 is done with screenshots, and the builder edited no test file.

## Orchestrator amendments (bind; from the independent spec audit, 2026-09-28)
- **M1.** `packages/domain/tests/integration/items.test.ts:394-413` (I6, unitPrice `'1e308'` → `/finite/`) goes red:
  the new parse refuses it first. **Ruled TESTER edit:** I6 now expects the cost parser's "not a valid amount"
  refusal (the header-Infinity path is no longer reachable through the unit price). Add to "Done when".
- **M2.** A1's "red today" was wrong: one line of -5 × 10 fails the raw lines-vs-invoice total throw
  (`items/index.ts:277`) before Postgres. To reach the DB, A1 sends the bad line FIRST plus a good line so the sum
  equals the invoice total; today's red is then 23514 from either `…unit_price_not_negative_check` or
  `…total_not_negative_check` (`0047:69-70`) — the red must accept either, not name one.
- **M3.** A6's "red today" likewise: record what is actually rendered today, don't assume the DB-refused fallback.
- **M4.** Nothing-written assertions: W1/W4 → no loan / prepaid row created; W6/D1 → `needs_review` still true and
  `coverage_months` unchanged.
- **M5.** Add a leg: an actor without `record_supplier_invoice` sends unit price `'-5'` → the authorization refusal.
- **M6.** Ruled TESTER edit: `apps/erp/tests/t343-s5-5t-number-boxes.test.ts:100` makes the same false "SAFE
  server-side" claim as 5w:63 — correct its title too. `catalogue.ts` comment: only `.5` and `1.` are newly
  accepted (`005` already passed). Line drift: `ap/index.ts:422`, loans rate check `:64`.

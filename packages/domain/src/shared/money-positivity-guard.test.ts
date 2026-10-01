import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { censusKey, scanMoneyPositivitySites } from './money-positivity-census';

/**
 * DEF-272 — the census AS A GUARD, not a census. `docs/tasks/260-def-272-money-input-parsing.md`
 * §"Find the set as a GUARD, not as a census": a hand count finds spellings; this scans for the
 * SHAPE — every `Number(X) <op> 0` and `!(X > 0)` comparison under `packages/domain/src` — so a
 * future site that repeats the defect (a raw money string reaching a positivity guard unparsed)
 * cannot slip past this test by being spelled differently than the ones already fixed.
 *
 * ⭐ The assertion is ZERO: every match this scan finds must be present in `CLASSIFIED` below with
 * a stated reason, or the test fails. A NEW, unclassified match — the shape reappearing on a site
 * nobody has looked at — is exactly the signal this guard exists to raise. Extending the allowlist
 * is a decision a person makes by reading the site, never a reflex to make the test green again.
 *
 * ⭐⭐ T-325/DEF-376, REVISION 2 — CLASSIFIED IS KEYED BY THE COMPARISON, NOT THE LINE IT SITS ON.
 * The scanner used to live in this file and key each entry by `file:line`. A line number is the
 * least stable fact about a file: an unrelated edit anywhere above a classified comparison moves
 * it, and the guard turns red for a reason unrelated to the change that caused it — measured twice
 * in one day, 2026-09-18/19. A first fix (key on the whole source line, then the comment-stripped
 * line) turned out to still be fragile: **24 of the 49 guarded lines carry payload beyond the
 * comparison** — an error-message string, a template literal, a trailing comment — so a line-keyed
 * or stripped-line-keyed table still breaks on a reword that touches no operator, no operand, and
 * no numeric literal. The scanner now lives in `./money-positivity-census` (grep
 * `scanMoneyPositivitySites`), and every `CLASSIFIED` key is `file` + `::` + the normalised
 * **comparison itself** (`extractComparison` + `censusKey`) — including its full numeric literal,
 * not just the bare `0` the matching regexes stop at (three sites compare against a `0.005`
 * tolerance; truncating the literal would make a `0.005` -> `0` edit invisible to this guard).
 * Re-indenting, reflowing a statement across lines, rewording an error message or a comment, or
 * inserting lines above a classified comparison cannot change its key; changing the operator, the
 * operand, or the numeric literal of the comparison itself always does.
 *
 * ⛔ **A real, named loss of resolution, accepted deliberately (Contract §4):** keying on the bare
 * comparison instead of the line means a NEW site whose comparison is byte-identical to an already
 * classified one **in the same file** is silently covered by that entry instead of raising as
 * unclassified. `Number(amount) <= 0` is the dominant idiom in this domain (7 occurrences across 6
 * files), so within-file repetition is likely, not theoretical. **This guard has exactly three such
 * cases today, and their multiplicity is DECLARED, not assumed** — see `EXPECTED_SITE_COUNT` below.
 * A fourth site sharing one of those three keys turns the suite red (T12): that is the guard
 * catching the false-green hole, not a false alarm.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * ⛔ WHAT THIS GUARD CANNOT SEE — read before trusting a clean run as "no more sites of this class"
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * 1. **A variable-comparison spelling that isn't `Number(x)` or `!(x > 0)`.** This is not
 *    hypothetical: this very guard's first version MISSED `releaseCashRequest`'s instance of DEF-272
 *    (`packages/domain/src/cash-requests/index.ts`) because its guard reads
 *    `if (Number(input.amount) > Number(req.approvedAmount ?? 0))` — a comparison against another
 *    value, not against a literal `0`. It was found by reading the function fully and cross-checking
 *    `journal_lines_exactly_one_side_check` (`debit = 0` XOR `credit = 0`), not by this scanner.
 * 2. **A number already unwrapped by a prior `Number(...)` assignment, then compared bare** — e.g.
 *    `const creditApplied = Number(input.creditApplied ?? '0'); if (creditApplied < 0) ...`. The
 *    comparison line itself contains no `Number(` for this regex to match. `ap/index.ts`'s
 *    `creditApplied` and `trade/index.ts`'s `deliveryFee`/`otherFees` are this shape — logged in
 *    `docs/DEFECTS-REGISTER.md` §E as the strictly-quieter truncation class (always re-derived via
 *    `.toFixed(2)` before any DB write, so nothing is refused — an amount is silently rounded, never
 *    stored malformed), not fixed here, and NOT caught by this guard either. If one of those ever
 *    starts writing a raw string to the database, this guard will not notice; the DEFECTS-REGISTER
 *    row is the only record of that risk today.
 *    ⭐ **S5.5v Amendment A1 — `cash-requests/index.ts`'s `settleCashRequest` (`returned`, `short`) no
 *    longer belongs on this list.** S5.5s routed both through `parseMoneyInput` (DEF-277 PARTLY
 *    FIXED) — `const returned = ... Number(parseMoneyInput(input.returnedAmount, ...))`, same for
 *    `short`. The comparisons (`returned < 0 || short < 0`, `returned <= 0 && short <= 0`) still
 *    match this same blind spot's SHAPE (a bare unwrapped local, not `Number(input.x)`), so this
 *    guard still cannot see them — the fix closed the underlying defect, not the guard's blind
 *    spot to it.
 * 3. **A property path, not a bare identifier**, e.g. `a.amountApplied` in `ap/index.ts`'s
 *    allocation loop. After DEF-272's fix that value IS pre-parsed (built in a `.map()` one block
 *    above via `parseMoneyInput`), but it no longer even matches this shape (the comparison is
 *    `applied <= 0` on a `Number()`-unwrapped local, not `Number(a.amountApplied) <= 0`) — the same
 *    blind spot as (2), for the same reason.
 * 4. **Textual, not type-resolved.** Like `scripts/production-caller-census.mjs`, this walks source
 *    text with comments and strings blanked out — it does not build an AST or trace real data flow
 *    across function boundaries. A `routed` classification below for a bare variable (e.g. the
 *    `amount` guard inside `cash-requests/index.ts`'s `createCashRequest`) was verified by a person
 *    reading the line above it (`const amount = parseMoneyInput(...)`), not inferred by this
 *    scanner. That is why the classification table is hand-maintained rather than derived — the
 *    same shape this project's caller census uses its `--names` baseline for.
 * 5. **A comparison split internally across lines** — e.g. `Number(\n  amount\n) > 0` — stops
 *    matching altogether, because both the matching and the key-extraction regexes operate on one
 *    line of (comment-stripped) text at a time. This is a limit of the **line-based scanner**, not
 *    of the key: Invariant 3 (payload/whitespace/reflow are not a change) does not claim to cover
 *    this case, only the case where the comparison stays intact on one line while a *statement*
 *    around it reflows. (T-325/DEF-376, revision 2.)
 * 6. **A string containing `//` BEFORE a comparison on the same line kills that site outright.**
 *    `const u = 'http://a'; if (Number(x) <= 0) {` is **not found** — `stripComments` deliberately
 *    leaves string literals alone (its own header says so, as a knowing trade), so the `//` inside
 *    the URL string is read as a real line comment and blanks everything after it, comparison
 *    included. Pre-existing, not introduced by this task, and not currently losing a site: only two
 *    lines in all of `packages/domain/src` are stripper-suppressed this way, and both are genuine
 *    JSDoc prose quoting `Number('0.004') > 0` (`shared/money-input.ts`, `shared/money-lines.ts`) —
 *    correctly suppressed. The mechanism is live, not hypothetical — grep `memory://` in
 *    `files/driver.ts` for a string carrying `//`, harmless there only because nothing else shares
 *    its line. (T-325/DEF-376, revision 2.)
 * 7. **A string containing `/*` blanks everything to the next `* /`, removing sites in a RANGE** —
 *    a real comparison two lines below a `const s = '/*';` is not found either. Same root cause and
 *    same trade as (6), just spanning lines instead of truncating one.
 *    ⛔ **Blind spots (6) and (7) are documented here, not fixed.** Fixing the stripper changes
 *    which sites are found, and Invariant 4 forbids that in this task — they are a future defect
 *    row, not this task's work.
 * 8. **THE PRECEDENCE RULING (outer match wins when both shapes match one line) DOES NOT REACH
 *    TWO-DEEP NESTING.** `NEG_PAREN_GT`'s inner alternation only handles ONE level of nested
 *    parens, so it cannot span a line like `deliveries/documents.ts`'s
 *    `if (!(Number.isFinite(Number(line.conversionFactor)) && Number(line.conversionFactor) > 0)) {`
 *    — only `NUMBER_CMP` matches there, and the key is the INNER `Number(line.conversionFactor) >
 *    0`. Measured: deleting the outer `!` leaves that key byte-identical, still a site, UNDETECTED —
 *    the guard inverts from "reject a non-finite or non-positive factor" to "reject every valid
 *    factor" with the suite green. ⭐ For contrast, the ruling DOES hold where the regex can reach
 *    it — at `cutover/opening.ts`, the same kind of edit (removing the outer `!`) takes the key from
 *    `!(Number(amount) > 0)` to `Number(amount) > 0` and IS detected (see the T2 negation test and
 *    that entry's `CLASSIFIED` reason). The ruling is real and incomplete; this line records both
 *    ends of that rather than implying either extreme. A limit of the regex reach, not of the key.
 * 9. **TWO GUARDED COMPARISONS ON ONE LINE — ONLY THE FIRST IS CENSUSED.** The `seen` dedupe key is
 *    per LINE, not per match, so a line carrying two comparisons yields one `CensusSite`. Live site
 *    — `money-transfers/index.ts`'s `if (!(out > 0) || !(inn > 0)) {`: only `!(out > 0)` is found;
 *    `!(inn > 0)` — the `amountIn` positivity guard on a money transfer — is invisible to this guard
 *    entirely. Measured across three mutations of the second comparison (removing its `!`, `>` to
 *    `>=`, `> 0` to `> 0.005`): the key set is unchanged every time. **`amountIn`'s guard can be
 *    deleted or inverted with the whole suite green.**
 *    ⭐ **The sentence this makes true, and it belongs beside every count in this file: "49 sites" is
 *    NOT "49 guarded comparisons".** The census guards 50 comparisons at 49 sites — one of them,
 *    this one, hides a second. That distinction does not appear anywhere else in this task's
 *    documentation, including the spec, and it is exactly the kind of quiet imprecision that lets a
 *    later reader trust a number more than it has earned.
 *    ⛔ **Blind spots (8) and (9) are documented here, not fixed** — same reason as (6)/(7). (8)
 *    would need `NEG_PAREN_GT` widened to handle deeper nesting; (9) would need censusing per match
 *    rather than per line, which takes the site count to 50. Both change which sites are found, and
 *    Invariant 4 forbids that in this task.
 *
 * None of this makes the guard worthless — it is what caught `owners/index.ts` (`createOwner`'s
 * `drawingLimit`) and `cutover/opening.ts` (`addOpeningFigure`) as real, unfixed instances the
 * spec's own "known sites" table did not list. It means a clean run here is a floor, not a ceiling:
 * read the blind spots above before concluding "nothing else has this defect."
 */

const DOMAIN_SRC = fileURLToPath(new URL('..', import.meta.url));

/**
 * The hand-maintained classification. Every entry is a judgment call a person made by reading the
 * site — never regenerate this from the scanner's own output, or the guard stops being able to
 * catch a NEW site that happens to look like an old one (the exact DEF-243/DEF-269 failure the
 * spec names: "a text-scanning guard match a spelling where it needed a shape").
 *
 * Each entry names the FILE and the exact COMPARISON it classifies (never a line number) —
 * `censusKey()` below builds the actual table key the same way the scanner does, so re-indenting,
 * reflowing, or editing anything on the line OTHER than the comparison can never change its key,
 * but editing the operator, operand, or numeric literal always does.
 *
 * `checkFunctions` / `checkIdentifiers` are NOT part of the judgement — they are a mechanically
 * verifiable SUBSET of what each reason claims, asserted below in "the reason<->site pairing" (T11):
 * where a reason names a function, `checkFunctions` names it and the test confirms that function is
 * actually declared in the file; where a reason backticks an identifier that the comparison itself
 * also contains, `checkIdentifiers` names it and the test confirms the substring match. Most entries
 * carry neither — their reason is AUDITED (read by a person), not TESTED, and that is weaker. See T11.
 */
const CLASSIFIED_ENTRIES: {
  file: string;
  comparison: string;
  reason: string;
  checkFunctions?: string[];
  checkIdentifiers?: string[];
}[] = [
  // ---- routed: parsed via parseMoneyInput()/money() on a preceding line (DEF-272 fix sites) ----
  {
    file: 'ar/index.ts',
    comparison: 'Number(totalAmount) <= 0',
    reason: 'routed — `totalAmount = parseMoneyInput(input.totalAmount, ...)` above',
    checkIdentifiers: ['totalAmount'],
  },
  {
    file: 'cash-requests/index.ts',
    comparison: 'Number(amount) <= 0',
    reason:
      'routed — MERGED (Contract §4, T-343 S5.5v item 2): covers BOTH createCashRequest and ' +
      'releaseCashRequest, each `amount = parseMoneyInput(...)` above the respective site; the ' +
      'comparison is byte-identical in both, so one key legitimately stands for two sites ' +
      '(declared in EXPECTED_SITE_COUNT)',
    checkFunctions: ['createCashRequest', 'releaseCashRequest'],
    checkIdentifiers: ['amount'],
  },
  {
    file: 'cash-requests/index.ts',
    comparison: 'Number(approvedAmount) <= 0',
    reason: 'routed — decideCashRequest, `approvedAmount = parseMoneyInput(...)` above',
    checkFunctions: ['decideCashRequest'],
    checkIdentifiers: ['approvedAmount'],
  },
  {
    file: 'cutover/opening.ts',
    // ⭐ PRECEDENCE RULING: this line matches BOTH comparison shapes — `!(Number(amount) > 0)`
    // wraps `Number(amount) > 0` — and the key is built from the OUTER match. Keying on the inner
    // text alone would let deleting the `!` (inverting the guard's meaning) pass silently, still
    // classified, still found. See `extractComparison`'s own doc comment for the mechanism.
    comparison: '!(Number(amount) > 0)',
    reason: 'routed — addOpeningFigure, `amount = parseMoneyInput(...)` above',
    checkFunctions: ['addOpeningFigure'],
    checkIdentifiers: ['amount'],
  },
  {
    file: 'expenses/reimbursement.ts',
    comparison: 'Number(amount) <= 0',
    reason: 'routed — payReimbursement, `amount = parseMoneyInput(...)` above',
    checkFunctions: ['payReimbursement'],
    checkIdentifiers: ['amount'],
  },
  {
    file: 'loans/index.ts',
    comparison: 'Number(amount) <= 0',
    reason:
      'routed — MERGED (Contract §4): covers BOTH disburseLoan and recordLoanPayment, each ' +
      '`amount = parseMoneyInput(...)` above the respective site; the comparison is byte-identical ' +
      'in both functions, so one key legitimately stands for two sites (declared in EXPECTED_SITE_COUNT)',
    checkFunctions: ['disburseLoan', 'recordLoanPayment'],
    checkIdentifiers: ['amount'],
  },
  {
    // T-343 S5.5v item 3 (new site — createLoan did not parse principalAmount before this).
    file: 'loans/index.ts',
    comparison: 'Number(principal) <= 0',
    reason: 'routed — createLoan, `principal = parseMoneyInput(input.principalAmount, ...)` above',
    checkFunctions: ['createLoan'],
    checkIdentifiers: ['principal'],
  },
  {
    file: 'money-transfers/index.ts',
    comparison: '!(out > 0)',
    reason:
      "routed — createMoneyTransfer, `amountOut`/`amountIn` parsed above (out/inn are their " +
      'Number()); the check itself sits inside `runCreate`, the internal helper `createMoneyTransfer` ' +
      'delegates to',
    checkFunctions: ['createMoneyTransfer', 'runCreate'],
  },
  {
    file: 'owners/index.ts',
    comparison: 'Number(limit) <= 0',
    reason: 'routed — createOwner, `limit = parseMoneyInput(input.drawingLimit, ...)` above',
    checkFunctions: ['createOwner'],
    checkIdentifiers: ['limit'],
  },
  {
    file: 'owners/index.ts',
    comparison: 'Number(amount) <= 0',
    reason: 'routed — recordContribution, `amount = parseMoneyInput(...)` above',
    checkFunctions: ['recordContribution'],
    checkIdentifiers: ['amount'],
  },
  {
    file: 'prepaid/index.ts',
    comparison: 'Number(refunded) < 0',
    reason:
      "routed — writeOffPrepaidItem, `refunded = parseMoneyInput(input.refundAmount ?? '0', ...)` " +
      'above; the check sits inside `runWriteOff`, the internal helper `writeOffPrepaidItem` delegates to',
    checkFunctions: ['writeOffPrepaidItem', 'runWriteOff'],
    checkIdentifiers: ['refunded'],
  },
  {
    file: 'prepaid/index.ts',
    comparison: 'Number(refunded) > 0',
    reason:
      'routed — MERGED (Contract §4): covers BOTH occurrences inside writeOffPrepaidItem\'s ' +
      '`runWriteOff` helper — the same `refunded = parseMoneyInput(...)` local, checked twice ' +
      '(once before applying it, once before requiring an account code) — one key stands for two sites',
    checkFunctions: ['writeOffPrepaidItem', 'runWriteOff'],
    checkIdentifiers: ['refunded'],
  },
  {
    file: 'recurring-expenses/index.ts',
    comparison: 'Number(defaultAmount) <= 0',
    reason:
      'routed — MERGED (Contract §4): covers BOTH createRecurringTemplate and ' +
      'updateRecurringTemplate, each `defaultAmount = parseMoneyInput(...)` above the respective ' +
      'site; one key stands for two sites',
    checkFunctions: ['createRecurringTemplate', 'updateRecurringTemplate'],
    checkIdentifiers: ['defaultAmount'],
  },
  {
    file: 'sales-days/create.ts',
    comparison: 'Number(amount) <= 0',
    reason: 'routed — writeTenders, `amount = parseMoneyInput(t.amount, ...)` above',
    checkFunctions: ['writeTenders'],
    checkIdentifiers: ['amount'],
  },
  {
    file: 'trade/index.ts',
    comparison: 'Number(lineTotal) <= 0',
    reason:
      'routed — createTradeOrder, `lineTotal = parseMoneyInput(...)` above (defense-in-depth; ' +
      'always 2dp by construction already)',
    checkFunctions: ['createTradeOrder'],
    checkIdentifiers: ['lineTotal'],
  },
  {
    file: 'wastage/orders.ts',
    comparison: 'Number(amount) <= 0',
    reason: 'routed — recordOrderWastage, `amount = parseMoneyInput(input.amount, ...)` above',
    checkFunctions: ['recordOrderWastage'],
    checkIdentifiers: ['amount'],
  },
  {
    file: 'channel-settlements/index.ts',
    comparison: 'Number(amount) < 0',
    reason:
      'routed — assertSettlementFigures, `amount = parseMoneyInput(input.loan.amount, ...)` above ' +
      '(T-343 S5.5s, DEF-470 item 8: the loan amount docked)',
    checkFunctions: ['assertSettlementFigures'],
    checkIdentifiers: ['amount'],
  },

  // ---- derived: a ledger-summed or computed value, never a raw string a person typed ----
  {
    file: 'cash-requests/index.ts',
    comparison: 'Number(after.outstanding) <= 0.005',
    reason:
      'derived ledger position (`floatPositionOf`) + the codebase-standard 0.005 tolerance, not a ' +
      'raw input',
  },
  {
    file: 'expenses/reimbursement.ts',
    comparison: 'Number(position.outstanding) <= 0',
    reason: 'derived ledger position (`reimbursablePayableOf`)',
  },
  {
    file: 'liabilities/index.ts',
    comparison: 'Number(after.outstanding) <= 0.005',
    reason: 'derived ledger position + 0.005 tolerance',
  },
  {
    file: 'liabilities/index.ts',
    comparison: 'Number(outstanding) > 0.005',
    reason: 'derived ledger position + 0.005 tolerance',
  },
  {
    file: 'loans/index.ts',
    comparison: 'Number(position.outstanding) <= 0',
    reason: 'derived ledger position (`positionOf`)',
  },
  {
    file: 'loans/index.ts',
    comparison: 'Number(split.overpayment) > 0',
    reason: "derived — `split.overpayment` computed by `splitPayment()` from already-parsed Money",
    checkIdentifiers: ['split.overpayment'],
  },
  {
    file: 'loans/index.ts',
    comparison: 'Number(split.principal) > 0',
    reason: "derived — `split.principal`, same `splitPayment()` output",
    checkIdentifiers: ['split.principal'],
  },
  {
    file: 'loans/index.ts',
    comparison: 'Number(split.interest) > 0',
    reason: "derived — `split.interest`, same `splitPayment()` output",
    checkIdentifiers: ['split.interest'],
  },
  {
    file: 'loans/index.ts',
    comparison: 'Number(after.outstanding) <= 0',
    reason: 'derived ledger position (`positionOf`)',
  },
  {
    file: 'loans/index.ts',
    comparison: 'Number(after.outstanding) > 0',
    reason: 'derived ledger position (`positionOf`)',
  },
  {
    file: 'money-transfers/index.ts',
    comparison: 'Number(fee) > 0',
    reason: "`fee = (out - inn).toFixed(2)` — computed and already 2dp by construction",
    checkIdentifiers: ['fee'],
  },
  {
    file: 'prepaid/index.ts',
    comparison: 'Number(remaining) <= 0',
    reason: "derived — `remaining = subtract(money(item.totalCost), money(amortised))`",
    checkIdentifiers: ['remaining'],
  },
  {
    file: 'prepaid/index.ts',
    comparison: 'Number(expensed) > 0',
    reason: "derived — `expensed = subtract(remaining, refunded)`",
    checkIdentifiers: ['expensed'],
  },
  {
    file: 'remittance/index.ts',
    comparison: 'Number(r.owed) > 0',
    reason: 'derived ledger `owed` value',
    checkIdentifiers: ['owed'],
  },

  // ---- quantity: a count/conversion factor, not money — different CHECK, different column ----
  {
    file: 'cutover/index.ts',
    // T-343 S5.5w item 3 (RULED EDIT, red until BUILDER lands it): `input.quantity` is parsed via
    // `parseQuantityInput` first and the guard moves to the parsed local — planner's own stated
    // shape (task doc, TESTER paths note); re-key here to match, not yet true of the source.
    comparison: 'Number(quantity) < 0',
    reason: 'quantity — recordOpeningCount, not a money field; routed through parseQuantityInput (S5.5w)',
    checkFunctions: ['recordOpeningCount'],
  },
  {
    file: 'deliveries/documents.ts',
    comparison: 'Number(line.conversionFactor) > 0',
    reason: 'quantity — a unit conversion factor',
  },
  {
    file: 'items/index.ts',
    comparison: '!(qty > 0)',
    reason: 'quantity — validateInvoiceLines line quantity',
    checkFunctions: ['validateInvoiceLines'],
  },
  {
    file: 'items/index.ts',
    comparison: '!(factor > 0)',
    reason: 'quantity — validateInvoiceLines conversion factor',
    checkFunctions: ['validateInvoiceLines'],
  },
  {
    file: 'pos/item-map.ts',
    comparison: 'Number(input.quantityPerSale) <= 0',
    reason: 'quantity — `quantityPerSale`, explicitly out of scope per the T-260 spec',
    checkIdentifiers: ['quantityPerSale'],
  },
  {
    file: 'trade/index.ts',
    // ⭐ T-328 — re-keyed, not merely re-approved. The site used to compare the RAW
    // `draft.quantity` directly (`Number(draft.quantity) <= 0`), NaN-blind the same way the
    // sibling `rate` check was (`NaN <= 0` is `false`). The fix routes it through a dedicated
    // parser first — `parsedQuantity = parseQuantityInput(draft.quantity, ...)`, defined above in
    // this file, `numeric(14,3)` via `packages/domain/src/stock/quantity.ts`, NOT `money()`/
    // `parseMoneyInput` (quantity and money are different axes; see the "quantity" category
    // header above) — so the comparison's own text changed to `Number(parsedQuantity) <= 0`. The
    // sibling `rate` check avoided this by keeping the SAME identifier name (`rate`) for its
    // parsed value; `parsedQuantity` could not, because `draft.quantity` is a property path on the
    // caller's input, not a bare identifier a parsed local could reuse.
    comparison: 'Number(parsedQuantity) <= 0',
    reason:
      'quantity — routed through `parseQuantityInput(draft.quantity, ...)` above (T-328); was ' +
      'previously NaN-blind on the raw `draft.quantity` directly, same class of gap the money-side ' +
      'routing fixes elsewhere, but on the quantity axis via its own parser, not parseMoneyInput',
    checkFunctions: ['createTradeOrder'],
    checkIdentifiers: ['parsedQuantity'],
  },

  // ---- rate: numeric(14,4), a different column type with its own precision — out of money() scope ----
  {
    // T-343 S5.5v item 6 — was `Number(input.rate) < 0` (T-260 era: "do not force a rate through a
    // 2dp parser"). setPrice now routes through `parseMoneyInput` first (2dp is the right scale —
    // the column is `numeric(14,2)`, not `numeric(14,4)`; the old T-260 reason was itself stale),
    // so the comparison reads the parsed local, not `input.rate` directly.
    file: 'customers/index.ts',
    comparison: 'Number(rate) < 0',
    reason: 'routed — setPrice, `rate = parseMoneyInput(...)` above; column numeric(14,2)',
    checkFunctions: ['setPrice'],
    checkIdentifiers: ['rate'],
  },
  {
    file: 'pos/plan.ts',
    comparison: 'Number(s) > 0',
    reason: 'rate — `isPositiveDecimalString`, numeric(14,6) quantity-domain scale factor, not money',
  },
  {
    file: 'trade/index.ts',
    comparison: 'Number(rate) < 0',
    reason: 'rate — negative-only check on a numeric(14,4) rate, not a money positivity check',
  },

  // ---- percentage: numeric(6,3), its own range check — not money, not the 2dp money() scale ----
  {
    file: 'owners/index.ts',
    comparison: '!(Number(t) > 0)',
    reason:
      'percentage, numeric(6,3) — own regex+range check inside createOwner, S5.5s item 3; not money',
    checkFunctions: ['createOwner'],
  },

  // ---- type-enforced: the function's own signature requires an already-parsed Money, not a string ----
  {
    file: 'loans/interest.ts',
    comparison: 'Number(base) <= 0',
    reason:
      'internal — `accruedInterest` only ever receives already-parsed Money (`{ principal, ' +
      'outstanding }: { ...: Money }`); every call site parses first',
    checkFunctions: ['accruedInterest'],
  },
  {
    file: 'shared/straight-line.ts',
    comparison: 'Number(input.amount) <= 0',
    reason: 'internal — `StraightLineInput.amount` is typed `Money`, not `string`; every call site parses first',
  },

  // ---- log-only: a real DEF-272-shaped site, deliberately NOT fixed here — see DEFECTS-REGISTER §E ----
  {
    file: 'money-accounts/index.ts',
    comparison: 'Number(limit) < 0',
    reason:
      'renameMoneyAccount overdraftLimit — CHECK is `>= 0` (zero is a legitimate "no overdraft" ' +
      'value), so 0.004 rounding to 0.00 is silently ACCEPTED, not refused. Quieter-truncation ' +
      "class, not this task's DB-refusal class. Logged DEFECTS-REGISTER §E, not fixed — fixing it " +
      "risks nothing, but it is out of T-260's scope as ruled by the orchestrator 2026-09-10.",
  },

  // ---- not a guard at all: conditional display text, not a validity check ----
  {
    file: 'wastage/settlement-match.ts',
    comparison: 'Number(settlement.variance) > 0',
    reason: 'not a guard — conditional string interpolation for a message, not a positivity check',
  },
  {
    file: 'wastage/settlement-match.ts',
    comparison: 'Number(settlement.settlementGain) > 0',
    reason: 'not a guard — same shape as the variance-shortfall entry above (a message, not a check)',
  },
];

const CLASSIFIED: Record<string, string> = Object.fromEntries(
  CLASSIFIED_ENTRIES.map(({ file, comparison, reason }) => [censusKey(file, comparison), reason]),
);

/**
 * Contract §4 — the three keys that legitimately cover more than one site, declared rather than
 * assumed. A key found at more site counts than declared here (or a declared count no longer
 * matching what the scan finds) is the false-green hole this table exists to close (T12).
 */
const EXPECTED_SITE_COUNT: Record<string, number> = {
  [censusKey('loans/index.ts', 'Number(amount) <= 0')]: 2,
  [censusKey('prepaid/index.ts', 'Number(refunded) > 0')]: 2,
  [censusKey('recurring-expenses/index.ts', 'Number(defaultAmount) <= 0')]: 2,
  // T-343 S5.5v item 2 — releaseCashRequest's new `<= 0` guard shares createCashRequest's key.
  [censusKey('cash-requests/index.ts', 'Number(amount) <= 0')]: 2,
};

function functionIsDeclaredIn(file: string, functionName: string): boolean {
  const source = readFileSync(join(DOMAIN_SRC, file), 'utf8');
  return new RegExp(`function\\s+${functionName}\\s*\\(`).test(source);
}

/** Invariant 5 — a computed key or comparison ending in `:<digits>` is a positional artifact. */
function hasPositionalKeySuffix(value: string): boolean {
  return /:\d+$/.test(value);
}

/** Invariant 5 — a reason citing `:<digits>` anywhere is a dangling line-number pointer. */
function hasPositionalPointer(value: string): boolean {
  return /:\d+\b/.test(value);
}

describe('DEF-272 — money-positivity shape guard (census as a test, not a census)', () => {
  it('T6 — finds a realistic number of comparisons — floor against a scanner that matches nothing', () => {
    const sites = scanMoneyPositivitySites(DOMAIN_SRC);
    expect(sites.length).toBeGreaterThan(30);
  });

  it('T9 — positive control — a known, deliberately-unrouted rate check is still found', () => {
    // ⛔ HAND-WRITTEN LITERAL, NEVER computed via censusKey()/extractComparison() here (Contract
    // §3): deriving the expected value from the function under test means a bug in extraction
    // moves both sides of the assertion together and the control passes while controlling
    // nothing — the exact failure this control exists to prevent, arriving by a new route.
    // ⭐ T-343 S5.5v item 6 re-point: customers/index.ts's rate check is NOW ROUTED (setPrice
    // parses via parseMoneyInput above), so it can no longer serve as the "deliberately unrouted"
    // control — pos/plan.ts's `Number(s) > 0` (classified above as a numeric(14,6) scale factor,
    // untouched by this task) takes its place. Verified unique in that file, so this cannot drift
    // onto a neighbouring site.
    const sites = scanMoneyPositivitySites(DOMAIN_SRC);
    expect(sites.some((s) => s.key === 'pos/plan.ts::Number(s) > 0')).toBe(true);
  });

  it('T7 — every match is classified — an unclassified hit is either a missed DEF-272 site or a new one', () => {
    const sites = scanMoneyPositivitySites(DOMAIN_SRC);
    const unexplained = sites.filter((s) => !(s.key in CLASSIFIED));
    if (unexplained.length > 0) {
      const detail = unexplained
        .map((s) => `  ${s.file}:${s.line}  ${s.raw}  [key: ${s.key}]`)
        .join('\n');
      throw new Error(
        `${unexplained.length} money-positivity comparison(s) are not in CLASSIFIED — read each one ` +
          `and either route it through parseMoneyInput() (if it is a raw money string) or add it to ` +
          `CLASSIFIED with a stated reason (quantity/rate/derived/type-enforced/log-only):\n${detail}`,
      );
    }
    expect(unexplained).toEqual([]);
  });

  it('T8 — CLASSIFIED names no site the scanner no longer finds — a stale entry hides scanner drift', () => {
    const sites = scanMoneyPositivitySites(DOMAIN_SRC);
    // ⚠️ "at least one", not "exactly one": the three merged entries (Contract §4) legitimately
    // cover two sites each — see T12 for the exact-count check.
    const found = new Set(sites.map((s) => s.key));
    const stale = Object.keys(CLASSIFIED).filter((k) => !found.has(k));
    expect(stale).toEqual([]);
  });

  it('T10 — Invariant 5: no computed key/comparison carries a positional suffix, and no reason carries a positional pointer', () => {
    // ⛔ PROVE THE PREDICATE CAN FAIL FIRST, fed a fabricated value directly — never by mutating
    // the real table and watching it go red (that leaves no artifact and can be forgotten).
    // Revision 1's version of this check grepped literal `file:line` strings that no longer exist
    // under §2's array-of-triples shape, so it passed by having nothing to reject; this is the
    // auditor-caught fix.
    expect(hasPositionalKeySuffix('some/file.ts::Number(amount) <= 0:42')).toBe(true);
    expect(hasPositionalKeySuffix('some/file.ts::Number(amount) <= 0')).toBe(false);
    expect(hasPositionalPointer('routed — same `refunded` as :405')).toBe(true);
    expect(hasPositionalPointer('routed — createCashRequest, `amount` above')).toBe(false);

    // now point both predicates at the real table.
    const positionalKeys = Object.keys(CLASSIFIED).filter(hasPositionalKeySuffix);
    expect(positionalKeys).toEqual([]);

    const positionalComparisons = CLASSIFIED_ENTRIES.filter((e) =>
      hasPositionalKeySuffix(e.comparison),
    ).map((e) => censusKey(e.file, e.comparison));
    expect(positionalComparisons).toEqual([]);

    // ⭐ RULING: a reason may never legitimately cite a line number. If one wants to, the reason
    // is reworded — this check is not loosened (Invariant 5).
    const positionalReasons = CLASSIFIED_ENTRIES.filter((e) =>
      hasPositionalPointer(e.reason),
    ).map((e) => censusKey(e.file, e.comparison));
    expect(positionalReasons).toEqual([]);
  });

  it('T11 — the reason<->site pairing, on the mechanically checkable subset only (§5)', () => {
    // ⛔ COVERAGE, STATED PLAINLY: this checks only entries carrying `checkFunctions` and/or
    // `checkIdentifiers` — a reason naming a function backs that claim by confirming the function
    // is genuinely declared in the file (handling the two INNER-function cases, `runCreate` inside
    // `createMoneyTransfer` and `runWriteOff` inside `writeOffPrepaidItem`, by name rather than by
    // a naive top-level-export check); a reason backticking an identifier that also appears in the
    // guarded comparison confirms that substring match. Every OTHER entry's reason is AUDITED — read
    // by a person against the pre-change census — not TESTED, and that is a weaker guarantee. This
    // test does not claim to cover them.
    const withFunctionClaims = CLASSIFIED_ENTRIES.filter((e) => e.checkFunctions?.length);
    const withIdentifierClaims = CLASSIFIED_ENTRIES.filter((e) => e.checkIdentifiers?.length);
    expect(withFunctionClaims.length).toBeGreaterThan(0);
    expect(withIdentifierClaims.length).toBeGreaterThan(0);

    for (const entry of withFunctionClaims) {
      for (const fn of entry.checkFunctions ?? []) {
        expect(functionIsDeclaredIn(entry.file, fn)).toBe(true);
      }
    }

    for (const entry of withIdentifierClaims) {
      for (const id of entry.checkIdentifiers ?? []) {
        expect(entry.comparison).toContain(id);
      }
    }
  });

  it('T12 — EXPECTED_SITE_COUNT holds both directions (Contract §4)', () => {
    // ⭐ the failure message must print the offending site's file/line/comparison (Contract §4):
    // bumping a declared count is still a one-token edit that restores green, so the mitigation is
    // making sure whoever bumps it has already been shown the exact thing to examine.
    const sites = scanMoneyPositivitySites(DOMAIN_SRC);
    const sitesByKey = new Map<string, typeof sites>();
    for (const s of sites) {
      const list = sitesByKey.get(s.key) ?? [];
      list.push(s);
      sitesByKey.set(s.key, list);
    }

    const undeclaredOrMismatched: string[] = [];
    for (const [key, list] of sitesByKey) {
      if (list.length <= 1) continue;
      const declared = EXPECTED_SITE_COUNT[key];
      if (declared !== list.length) {
        const detail = list.map((s) => `    ${s.file}:${s.line}  ${s.comparison}`).join('\n');
        undeclaredOrMismatched.push(
          `  ${key} — found ${list.length} site(s), EXPECTED_SITE_COUNT says ` +
            `${declared ?? 'undeclared'}:\n${detail}`,
        );
      }
    }
    if (undeclaredOrMismatched.length > 0) {
      throw new Error(
        `${undeclaredOrMismatched.length} key(s) have an undeclared or mismatched multiplicity — ` +
          `a new site sharing a merged key, or a merge losing a site, needs a human to look at it:\n` +
          undeclaredOrMismatched.join('\n'),
      );
    }
    expect(undeclaredOrMismatched).toEqual([]);

    const mismatchedDeclarations: string[] = [];
    for (const [key, expected] of Object.entries(EXPECTED_SITE_COUNT)) {
      const list = sitesByKey.get(key) ?? [];
      if (list.length !== expected) {
        const detail =
          list.map((s) => `    ${s.file}:${s.line}  ${s.comparison}`).join('\n') ||
          '    (no sites found at all)';
        mismatchedDeclarations.push(`  ${key} — declared ${expected}, found ${list.length}:\n${detail}`);
      }
    }
    if (mismatchedDeclarations.length > 0) {
      throw new Error(
        `${mismatchedDeclarations.length} EXPECTED_SITE_COUNT entr(y/ies) no longer match reality:\n` +
          mismatchedDeclarations.join('\n'),
      );
    }
    expect(mismatchedDeclarations).toEqual([]);
  });
});

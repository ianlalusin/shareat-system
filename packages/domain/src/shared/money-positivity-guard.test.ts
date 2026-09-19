import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

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
 *    `creditApplied`, `trade/index.ts`'s `deliveryFee`/`otherFees`, and
 *    `cash-requests/index.ts`'s `settleCashRequest` (`returned`, `short`) are this shape — logged in
 *    `docs/DEFECTS-REGISTER.md` §E as the strictly-quieter truncation class (always re-derived via
 *    `.toFixed(2)` before any DB write, so nothing is refused — an amount is silently rounded, never
 *    stored malformed), not fixed here, and NOT caught by this guard either. If one of those ever
 *    starts writing a raw string to the database, this guard will not notice; the DEFECTS-REGISTER
 *    row is the only record of that risk today.
 * 3. **A property path, not a bare identifier**, e.g. `a.amountApplied` in `ap/index.ts`'s
 *    allocation loop. After DEF-272's fix that value IS pre-parsed (built in a `.map()` one block
 *    above via `parseMoneyInput`), but it no longer even matches this shape (the comparison is
 *    `applied <= 0` on a `Number()`-unwrapped local, not `Number(a.amountApplied) <= 0`) — the same
 *    blind spot as (2), for the same reason.
 * 4. **Textual, not type-resolved.** Like `scripts/production-caller-census.mjs`, this walks source
 *    text with comments and strings blanked out — it does not build an AST or trace real data flow
 *    across function boundaries. A `routed` classification below for a bare variable (e.g. `amount`
 *    in `cash-requests/index.ts:54`) was verified by a person reading the line above it
 *    (`const amount = parseMoneyInput(...)`), not inferred by this scanner. That is why the
 *    classification table is hand-maintained rather than derived — the same shape this project's
 *    caller census uses its `--names` baseline for.
 *
 * None of this makes the guard worthless — it is what caught `owners/index.ts` (`createOwner`'s
 * `drawingLimit`) and `cutover/opening.ts` (`addOpeningFigure`) as real, unfixed instances the
 * spec's own "known sites" table did not list. It means a clean run here is a floor, not a ceiling:
 * read the blind spots above before concluding "nothing else has this defect."
 */

const DOMAIN_SRC = fileURLToPath(new URL('..', import.meta.url));
const SKIP_DIR = new Set(['node_modules', '.next', 'dist', 'build', '.turbo', 'coverage']);

function walk(dir: string, out: string[]): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (SKIP_DIR.has(e)) continue;
      walk(p, out);
    } else if (/\.ts$/.test(e) && !/\.test\.ts$/.test(e) && !/\.d\.ts$/.test(e)) {
      out.push(p);
    }
  }
  return out;
}

/** Blank comments so prose never counts as a match. Strings are left alone — a positivity
 *  comparison never lives inside a string literal, and blanking them risks the exact failure
 *  mode `production-caller-census.mjs`'s own header warns about (swallowing real code). */
function stripComments(src: string): string {
  const out = src.split('');
  const n = src.length;
  let i = 0;
  const blank = (a: number, b: number) => {
    for (let k = a; k < b && k < n; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
  };
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      let j = i;
      while (j < n && src[j] !== '\n') j++;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '/' && d === '*') {
      let j = i + 2;
      while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++;
      blank(i, Math.min(j + 2, n));
      i = j + 2;
      continue;
    }
    i++;
  }
  return out.join('');
}

interface Match {
  file: string;
  line: number;
  raw: string;
}

const NUMBER_CMP = /Number\(((?:[^()]|\([^()]*\))*)\)\s*(<=|<|>=|>)\s*0/;
const NEG_PAREN_GT = /!\(\s*((?:[^()]|\([^()]*\))*?)\s*>\s*0\s*\)/;

function scan(): Match[] {
  const files = walk(DOMAIN_SRC, []).map((p) => relative(DOMAIN_SRC, p).split(sep).join('/'));
  const seen = new Set<string>();
  const matches: Match[] = [];
  for (const f of files) {
    const abs = join(DOMAIN_SRC, f);
    let text: string;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const stripped = stripComments(text);
    const lines = stripped.split(/\r?\n/);
    const rawLines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
      if (!NUMBER_CMP.test(line) && !NEG_PAREN_GT.test(line)) return;
      const key = `${f}:${i + 1}`;
      if (seen.has(key)) return;
      seen.add(key);
      matches.push({ file: f, line: i + 1, raw: (rawLines[i] ?? '').trim() });
    });
  }
  return matches;
}

/**
 * The hand-maintained classification. Every entry is a judgment call a person made by reading the
 * site — never regenerate this from the scanner's own output, or the guard stops being able to
 * catch a NEW site that happens to look like an old one (the exact DEF-243/DEF-269 failure the
 * spec names: "a text-scanning guard match a spelling where it needed a shape").
 */
const CLASSIFIED: Record<string, string> = {
  // ---- routed: parsed via parseMoneyInput()/money() on a preceding line (DEF-272 fix sites) ----
  'ar/index.ts:63': 'routed — `totalAmount = parseMoneyInput(input.totalAmount, ...)` above',
  'cash-requests/index.ts:54': 'routed — createCashRequest, `amount = parseMoneyInput(...)` above',
  'cash-requests/index.ts:110': 'routed — decideCashRequest, `approvedAmount = parseMoneyInput(...)` above',
  'cutover/opening.ts:69': 'routed — addOpeningFigure, `amount = parseMoneyInput(...)` above',
  'expenses/reimbursement.ts:46': 'routed — payReimbursement, `amount = parseMoneyInput(...)` above',
  'loans/index.ts:93': 'routed — disburseLoan, `amount = parseMoneyInput(...)` above',
  'loans/index.ts:168': 'routed — recordLoanPayment, `amount = parseMoneyInput(...)` above',
  'money-transfers/index.ts:158': 'routed — createMoneyTransfer, `amountOut`/`amountIn` parsed above (out/inn are their Number())',
  'owners/index.ts:88': 'routed — createOwner, `limit = parseMoneyInput(input.drawingLimit, ...)` above',
  'owners/index.ts:124': 'routed — recordContribution, `amount = parseMoneyInput(...)` above',
  'prepaid/index.ts:405': 'routed — writeOffPrepaidItem, `refunded = parseMoneyInput(input.refundAmount ?? \'0\', ...)` above',
  'prepaid/index.ts:415': 'routed — same `refunded` as :405',
  'prepaid/index.ts:426': 'routed — same `refunded` as :405',
  'recurring-expenses/index.ts:92': 'routed — createRecurringTemplate, `defaultAmount = parseMoneyInput(...)` above',
  'recurring-expenses/index.ts:173': 'routed — updateRecurringTemplate, `defaultAmount = parseMoneyInput(...)` above',
  'sales-days/create.ts:321': 'routed — writeTenders, `amount = parseMoneyInput(t.amount, ...)` above',
  'trade/index.ts:243': 'routed — createTradeOrder, `lineTotal = parseMoneyInput(...)` above (defense-in-depth; always 2dp by construction already)',
  'wastage/orders.ts:293': 'routed — recordOrderWastage, `amount = parseMoneyInput(input.amount, ...)` above',

  // ---- derived: a ledger-summed or computed value, never a raw string a person typed ----
  'cash-requests/index.ts:412': 'derived ledger position (`floatPositionOf`) + the codebase-standard 0.005 tolerance, not a raw input',
  'expenses/reimbursement.ts:53': 'derived ledger position (`reimbursablePayableOf`)',
  'liabilities/index.ts:211': 'derived ledger position + 0.005 tolerance',
  'liabilities/index.ts:279': 'derived ledger position + 0.005 tolerance',
  'loans/index.ts:175': 'derived ledger position (`positionOf`)',
  'loans/index.ts:199': 'derived — `split.overpayment` computed by `splitPayment()` from already-parsed Money',
  'loans/index.ts:218': 'derived — `split.principal`, same `splitPayment()` output',
  'loans/index.ts:227': 'derived — `split.interest`, same `splitPayment()` output',
  'loans/index.ts:253': 'derived ledger position (`positionOf`)',
  'loans/index.ts:315': 'derived ledger position (`positionOf`)',
  'money-transfers/index.ts:182': '`fee = (out - inn).toFixed(2)` — computed and already 2dp by construction',
  'prepaid/index.ts:396': 'derived — `remaining = subtract(money(item.totalCost), money(amortised))`',
  'prepaid/index.ts:423': 'derived — `expensed = subtract(remaining, refunded)`',
  'remittance/allocate.ts:65': 'derived ledger `owed`/`remaining` values, summed from journal_lines',
  'remittance/allocate.ts:66': 'derived ledger `owed`/`remaining` values, summed from journal_lines',
  'remittance/allocate.ts:75': 'derived ledger `owed`/`remaining` values, summed from journal_lines',
  'remittance/index.ts:141': 'derived ledger `owed` value',

  // ---- quantity: a count/conversion factor, not money — different CHECK, different column ----
  'cutover/index.ts:221': 'quantity — recordOpeningCount, not a money field',
  'deliveries/documents.ts:121': 'quantity — a unit conversion factor',
  'items/index.ts:183': 'quantity — validateInvoiceLines line quantity',
  'items/index.ts:184': 'quantity — validateInvoiceLines conversion factor',
  'pos/item-map.ts:46': 'quantity — `quantityPerSale`, explicitly out of scope per the T-260 spec',
  'trade/index.ts:232': 'quantity — `draft.quantity`',

  // ---- rate: numeric(14,4), a different column type with its own precision — out of money() scope ----
  'customers/index.ts:194': 'rate, numeric(14,4) — T-260 spec: "do not force a rate through a 2dp parser"',
  'pos/plan.ts:121': 'rate — `isPositiveDecimalString`, numeric(14,6) quantity-domain scale factor, not money',
  'trade/index.ts:231': 'rate — negative-only check on a numeric(14,4) rate, not a money positivity check',

  // ---- type-enforced: the function's own signature requires an already-parsed Money, not a string ----
  'loans/interest.ts:65': 'internal — `accruedInterest({ principal, outstanding }: { ...: Money }`) only ever receives already-parsed Money; every call site parses first',
  'shared/straight-line.ts:58': 'internal — `StraightLineInput.amount` is typed `Money`, not `string`; every call site parses first',

  // ---- log-only: a real DEF-272-shaped site, deliberately NOT fixed here — see DEFECTS-REGISTER §E ----
  'money-accounts/index.ts:232': 'renameMoneyAccount overdraftLimit — CHECK is `>= 0` (zero is a legitimate "no overdraft" value), so 0.004 rounding to 0.00 is silently ACCEPTED, not refused. Quieter-truncation class, not this task\'s DB-refusal class. Logged DEFECTS-REGISTER §E, not fixed — fixing it risks nothing, but it is out of T-260\'s scope as ruled by the orchestrator 2026-09-10.',

  // ---- not a guard at all: conditional display text, not a validity check ----
  'wastage/settlement-match.ts:108': 'not a guard — conditional string interpolation for a message, not a positivity check',
  'wastage/settlement-match.ts:109': 'not a guard — same as :108',
};

describe('DEF-272 — money-positivity shape guard (census as a test, not a census)', () => {
  it('finds a realistic number of comparisons — floor against a scanner that matches nothing', () => {
    const matches = scan();
    expect(matches.length).toBeGreaterThan(30);
  });

  it('positive control — a known, deliberately-unrouted rate check is still found', () => {
    const matches = scan();
    expect(matches.some((m) => m.file === 'customers/index.ts' && m.line === 194)).toBe(true);
  });

  it('every match is classified — an unclassified hit is either a missed DEF-272 site or a new one', () => {
    const matches = scan();
    const unexplained = matches.filter((m) => !(`${m.file}:${m.line}` in CLASSIFIED));
    if (unexplained.length > 0) {
      const detail = unexplained.map((m) => `  ${m.file}:${m.line}  ${m.raw}`).join('\n');
      throw new Error(
        `${unexplained.length} money-positivity comparison(s) are not in CLASSIFIED — read each one ` +
          `and either route it through parseMoneyInput() (if it is a raw money string) or add it to ` +
          `CLASSIFIED with a stated reason (quantity/rate/derived/type-enforced/log-only):\n${detail}`,
      );
    }
    expect(unexplained).toEqual([]);
  });

  it('CLASSIFIED names no site the scanner no longer finds — a stale entry hides scanner drift', () => {
    const matches = scan();
    const found = new Set(matches.map((m) => `${m.file}:${m.line}`));
    const stale = Object.keys(CLASSIFIED).filter((k) => !found.has(k));
    expect(stale).toEqual([]);
  });
});

/**
 * T-324 slice B — source-level guard tests for the remittance screen's overage wiring.
 *
 * `page.tsx` and `actions.ts` are server components / server actions, awkward to exercise
 * directly (see `action-link-sweep.test.ts` for the repo's precedent: read the source, assert
 * properties of it). These four guards exist because the spec (docs/tasks/324-cap-the-cash-
 * handover.md §6) names the single most likely way this ships broken as invisible to a domain
 * test: "a form field that posts nothing, a domain parameter nobody passes, and a cap that is
 * always + 0 on the only screen — while every integration test passes, because they call the
 * domain directly."
 *
 * Every helper below finds its target structurally (by call-site marker, then balanced-paren
 * extraction), never by line number — a guard keyed on a line number breaks on edits that have
 * nothing to do with what it guards (DEF-376).
 *
 * ⭐⭐ T-328 — ONE assertion in this file was converted from a source-SHAPE check to a
 * BEHAVIOURAL one; the rest were deliberately left as they were. Recorded here so a reader who
 * finds the one behavioural block does not assume the others are too.
 *
 * GROUP 1 replaced the inline `l.amount && Number(l.amount) > 0` filter predicate with a named
 * `isHandedOver(amount)` helper — same guarantee, different source shape — which broke the old
 * regex in "an overage on a zero-amount line must not resurrect it" below. Read `isHandedOver`
 * (`apps/erp/src/app/remittance/actions.ts`) before touching that test: it decides solely on
 * `amount` (blank → false; parsed-but-zero → false; never reads `.declaredOverage`), and a
 * malformed non-blank amount now THROWS `parseMoneyInput`'s sentence instead of silently
 * vanishing — a real improvement this task exists to make, not a regression. The guarantee the
 * test's name states is unbroken, so the fix below is EXTRACT-AND-EXECUTE the real
 * `isHandedOver` body against the real `parseMoneyInput`, never a re-implementation of it.
 *
 * ⛔ EVERY OTHER ASSERTION IN THIS FILE REMAINS SOURCE-SHAPE, on purpose, and was NOT touched by
 * this pass — they carry the same "awkward to exercise directly" property line 4-5 above states,
 * not a behavioural guarantee of their own:
 *   - the page.tsx / actions.ts index-pairing guards (loop variable resolution, `lineAmount_${i}`
 *     / `lineOverage_${i}` / `declaredOverage` read at the same index) — structural by nature,
 *     there is no "behaviour" to drive without rendering the JSX and posting real FormData;
 *   - the DEF-366 `result.varianceId` vs `result.variance` ternary guard — same reason;
 *   - the two rendered-paragraph-text guards (§6 item 5, and the stale heldBack claim) — these
 *     already match on MEANING via broad content regexes, not literal sentences, which is this
 *     file's existing answer to the same brittleness problem for prose rather than code;
 *   - line 187's `not.toContain('overage')` on the filter's own call-site block, kept alongside
 *     the new behavioural check below as a belt-and-suspenders guard against a FUTURE call site
 *     combining `isHandedOver(l.amount)` with `|| l.declaredOverage` directly, which behavioural
 *     testing of `isHandedOver` in isolation could not catch on its own.
 *
 * ⚠️ RESIDUAL, recorded rather than fixed — the behavioural conversion moved the brittleness, it
 * did not eliminate it. `extractArrowFunctionBody` still finds `isHandedOver` by NAME
 * (`const isHandedOver = `); it no longer cares what the body's TEXT looks like, but a rename or
 * a conversion to a different construct (e.g. a `function isHandedOver(...)` declaration, or
 * inlining it back into the filter) still breaks this test — later and louder than the old regex
 * did (a `not.toBeNull()` failure naming exactly what could not be found, not a silent wrong
 * match), but it breaks. The alternative — exporting `isHandedOver` so this test imports it
 * directly — was considered and rejected: that trades this for an export that exists only because
 * a test wanted one, which is precisely the shape `callers.mjs`'s zero-caller/test-only check
 * exists to catch. Extraction-by-name is the better trade, not a free one.
 *
 * ⭐⭐ T-328, ROUND TWO — the guarantee RELOCATED when GROUP 1 threaded the account name through.
 * `isHandedOver(amount: string)` stayed a bare scalar; a NEW wrapper, `handedOverOn(line: {
 * fromMoneyAccountId, amount })`, is what the `.filter(...)`/`.find(...)` call sites actually call
 * now. Both are tested below, and they carry DIFFERENT STRENGTHS of the same guarantee — say which
 * is which, because they no longer match:
 *   - `isHandedOver` — a SCALAR argument. Executed via `new Function('parseMoneyInput', 'amount',
 *     body)`, so a body that tried to read anything but `amount` would be a `ReferenceError` — a
 *     structural fact from the JS scope chain, true regardless of what the assertions check.
 *   - `handedOverOn` — an OBJECT argument. A body reading `line.declaredOverage` against a fixture
 *     that never sets that field gets `undefined` (falsy, no throw) and passes anyway — the
 *     scope-chain guarantee does NOT carry over once the parameter is a bag of fields. What
 *     protects it is only the TYPE ANNOTATION listing two fields, a convention one word away from
 *     silent widening, not a fact the runtime enforces. This is WHY the behavioural test for
 *     `handedOverOn` includes a fixture with `declaredOverage` set to a truthy value on a
 *     blank-amount line, asserting `false` — built into the first version, not added after a
 *     break, because the field's absence elsewhere is otherwise indistinguishable from a body that
 *     correctly ignores it.
 */
import { readControlSource } from './helpers/control-source';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compare, ZERO } from '@shareat/core/money';
import { parseMoneyInput } from '@shareat/domain/money-input';

const here = dirname(fileURLToPath(import.meta.url));
const pagePath = resolve(here, '..', 'src', 'app', 'remittance', 'page.tsx');
const actionsPath = resolve(here, '..', 'src', 'app', 'remittance', 'actions.ts');
const pageSource = readControlSource(pagePath, 'utf8');
const actionsSource = readControlSource(actionsPath, 'utf8');

/**
 * From just after an opening '(' at `openIdx`, scans to its matching ')', skipping characters
 * inside line comments, block comments, and `'...'`/`"..."`/`` `...` `` literals. A naive counter
 * that reads every literal `(`/`)` — including ones inside a comment's prose or a quoted string —
 * can be truncated by a stray paren (loud) or, worse, silently extended into an unrelated block by
 * one, which would let a same-index pairing guarantee pass while genuinely broken. Returns the
 * index just past the matching ')'.
 */
function scanToMatchingParen(source: string, openIdx: number): number {
  let depth = 1;
  let i = openIdx + 1;
  for (; i < source.length && depth > 0; i++) {
    const c = source[i];
    if (c === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i);
      i = end === -1 ? source.length : end;
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 1;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      i++;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') i++;
        i++;
      }
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') depth--;
  }
  return i;
}

/** Scans forward from the character just after an opening '(' to its matching ')'. */
function extractParenAt(source: string, openIdx: number): string {
  const end = scanToMatchingParen(source, openIdx);
  return source.slice(openIdx + 1, end - 1);
}

/**
 * ⭐ T-328 — the brace analogue of `scanToMatchingParen`, for extracting a FUNCTION BODY rather
 * than a call's argument list. Same comment/string-skipping discipline, so a `}` inside a comment
 * or a template literal in the body cannot truncate the extraction early.
 */
function scanToMatchingBrace(source: string, openIdx: number): number {
  let depth = 1;
  let i = openIdx + 1;
  for (; i < source.length && depth > 0; i++) {
    const c = source[i];
    if (c === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i);
      i = end === -1 ? source.length : end;
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 1;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      i++;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') i++;
        i++;
      }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') depth--;
  }
  return i;
}

/**
 * ⭐ T-328 — extracts a named `const <name> = (...) => { ... }` arrow function's BODY TEXT (the
 * content between its `{` and matching `}`), for BEHAVIOURAL testing: running the real extracted
 * code against real inputs, rather than pattern-matching what it looks like. Returns null if the
 * marker or its body cannot be found, so a caller can fail loudly and specifically rather than
 * proceed on an empty string that silently behaves like "no body" (`new Function` on '' always
 * returns undefined, which could pass a careless assertion for the wrong reason).
 */
function extractArrowFunctionBody(source: string, constMarker: string): string | null {
  const markerIdx = source.indexOf(constMarker);
  if (markerIdx === -1) return null;
  const arrowIdx = source.indexOf('=>', markerIdx);
  if (arrowIdx === -1) return null;
  const openBrace = source.indexOf('{', arrowIdx);
  if (openBrace === -1) return null;
  const end = scanToMatchingBrace(source, openBrace);
  return source.slice(openBrace + 1, end - 1);
}

/** Extracts the argument list of the first call to `marker` (which must end in the call name, no paren). */
function extractCall(source: string, marker: string): string {
  const markerIdx = source.indexOf(marker);
  if (markerIdx === -1) return '';
  const openIdx = source.indexOf('(', markerIdx + marker.length - 1);
  if (openIdx === -1) return '';
  return extractParenAt(source, openIdx);
}

/** Extracts the argument list of the next `.callName(` occurring at or after `fromIdx`. */
function extractCallAfter(source: string, fromIdx: number, callName: string): { block: string; endIdx: number } {
  const callIdx = source.indexOf(`${callName}(`, fromIdx);
  if (callIdx === -1) return { block: '', endIdx: -1 };
  const openIdx = callIdx + callName.length;
  const endIdx = scanToMatchingParen(source, openIdx);
  return { block: source.slice(openIdx + 1, endIdx - 1), endIdx };
}

/** Pulls the loop-index variable name out of an `(x, IDX) => ...` arrow-function signature. */
function loopIndexVar(block: string): string | null {
  const m = block.match(/\(\s*\w+\s*,\s*(\w+)\s*\)\s*=>/);
  return m?.[1] ?? null;
}

/**
 * Returns capture group `i` of `m`, or throws with `label`. `noUncheckedIndexedAccess` (tsconfig.json:12)
 * makes `m[i]` `string | undefined` even after `m` itself is checked non-null — a bare `!` would
 * silently switch that check off at the point of use (docs/RULES.md §2), so this is the guard instead.
 */
function requireGroup(m: RegExpMatchArray | null, i: number, label: string): string {
  const group = m?.[i];
  if (group === undefined) throw new Error(`${label}: capture group ${i} did not match`);
  return group;
}

describe('T-324 slice B — WIRING GUARD: overage field paired with amount field, same index', () => {
  const pageRowBlock = extractCall(pageSource, 'cashier.map(');
  const pageIdx = pageRowBlock ? loopIndexVar(pageRowBlock) : null;

  it('page.tsx: the per-account row block and its (account, index) loop variable are both resolvable', () => {
    expect(pageRowBlock, 'could not locate cashier.map(...) — the per-account row block').not.toBe('');
    expect(pageIdx, 'could not identify the (account, index) loop variable in cashier.map(...)').not.toBeNull();
  });

  it('page.tsx: every lineAmount_${i} row also renders lineOverage_${i} using the SAME loop index', () => {
    expect(pageIdx).not.toBeNull();
    const amountPattern = new RegExp('name=\\{`lineAmount_\\$\\{' + pageIdx + '\\}`\\}');
    const overagePattern = new RegExp('name=\\{`lineOverage_\\$\\{' + pageIdx + '\\}`\\}');
    // Sanity: the field we are pairing against must actually be there, or this proves nothing.
    expect(pageRowBlock).toMatch(amountPattern);
    expect(pageRowBlock).toMatch(overagePattern);
  });

  const getAllIdx = actionsSource.indexOf("getAll('lineAccountId')");
  const { block: linesMapBlock } = getAllIdx === -1
    ? { block: '' }
    : extractCallAfter(actionsSource, getAllIdx, '.map');
  const actionsIdx = linesMapBlock ? loopIndexVar(linesMapBlock) : null;

  it('actions.ts: the lines[] builder block and its (id, index) loop variable are both resolvable', () => {
    expect(getAllIdx, "could not locate getAll('lineAccountId') in actions.ts").not.toBe(-1);
    expect(linesMapBlock, 'could not locate the .map((id, i) => ({...})) building lines[]').not.toBe('');
    expect(actionsIdx, 'could not identify the (id, index) loop variable in the lines[] map').not.toBeNull();
  });

  it('actions.ts: declaredOverage is read from lineOverage_${i} using the SAME index as amount reads lineAmount_${i}', () => {
    expect(actionsIdx).not.toBeNull();
    const amountReadPattern = new RegExp(
      'amount:\\s*str\\(formData,\\s*`lineAmount_\\$\\{' + actionsIdx + '\\}`\\)',
    );
    const overageReadPattern = new RegExp(
      'declaredOverage:\\s*str\\(formData,\\s*`lineOverage_\\$\\{' + actionsIdx + '\\}`\\)\\s*\\|\\|\\s*null',
    );
    // Sanity: confirms the block we extracted is really the one building `lines[]`.
    expect(linesMapBlock).toMatch(amountReadPattern);
    // The guard: an index mismatch (a different variable, a fixed index, an off-by-one such as
    // `${i + 1}`) fails this even though both substrings "lineOverage_" and "declaredOverage"
    // exist somewhere in the file — which a plain existence check would miss entirely.
    expect(linesMapBlock).toMatch(overageReadPattern);
  });
});

describe('T-324 slice B — DEF-366: branch on varianceId (a row exists), never variance (a number)', () => {
  it('actions.ts: the "recorded as an open item" branch tests result.varianceId, not result.variance', () => {
    // The first `(result.variance[Id]` in the file, followed within a short window by `?`, is the
    // ternary deciding whether to promise the open-item message — as opposed to the later
    // `Number(result.variance)` calls inside that same message, which format the signed amount and
    // are correctly left alone (§3.7: this is about which field gates the message, not the number
    // displayed inside it).
    const condMatch = actionsSource.match(/\(\s*result\.(variance(?:Id)?)\b[\s\S]{0,60}?\?/);
    expect(
      condMatch,
      'could not find the ternary branching on result.variance(Id) that gates "recorded as an open item"',
    ).not.toBeNull();
    expect(requireGroup(condMatch, 1, 'DEF-366 ternary')).toBe('varianceId');
  });
});

describe('T-324 slice B — an overage on a zero-amount line must not resurrect it', () => {
  it('actions.ts: declaredOverage exists on the line, and the lines[] filter still keys on amount alone', () => {
    const getAllIdx = actionsSource.indexOf("getAll('lineAccountId')");
    expect(getAllIdx).not.toBe(-1);
    const { endIdx: mapEndIdx } = extractCallAfter(actionsSource, getAllIdx, '.map');
    expect(mapEndIdx, 'could not find the end of the .map(...) building lines[]').not.toBe(-1);

    // declaredOverage must be a real field on the built line (proven above too, but the zero-amount
    // property is meaningless to assert if there is nothing to resurrect in the first place).
    expect(actionsSource).toMatch(/declaredOverage:\s*str\(formData,/);

    const { block: filterBlock } = extractCallAfter(actionsSource, mapEndIdx, '.filter');
    expect(filterBlock, 'could not find the .filter(...) chained onto the lines[] builder').not.toBe('');
    // Belt-and-suspenders, kept alongside the behavioural check below: guards against a FUTURE
    // call site combining the decision with `|| l.declaredOverage` directly at the .filter(...)
    // site, which testing isHandedOver in isolation could never see.
    expect(filterBlock.toLowerCase()).not.toContain('overage');
  });

  /**
   * ⭐⭐ T-328 — BEHAVIOURAL, not source-shape. §6 item 2: "an overage on a line with no amount
   * must not resurrect that line." GROUP 1 renamed the inline `l.amount && Number(l.amount) > 0`
   * check to a named `isHandedOver(amount)` helper — same guarantee, different source text — so a
   * regex on the old expression is the wrong instrument now. This extracts `isHandedOver`'s REAL
   * body (structurally, same idiom as the rest of this file) and EXECUTES it against the REAL
   * `parseMoneyInput`, so the assertion is about what the code actually DOES for a blank or
   * zero amount, not what it happens to look like.
   */
  it('actions.ts: isHandedOver (the filter\'s real decision function) is false for blank and zero, true for a real amount, and never reads declaredOverage', () => {
    const body = extractArrowFunctionBody(actionsSource, 'const isHandedOver = ');
    expect(body, 'could not extract the isHandedOver arrow function\'s body').not.toBeNull();

    // Structural half of the behavioural check: the body text itself must never reference
    // declaredOverage — `isHandedOver` takes only `amount`, so this also catches a signature
    // change that smuggled a second parameter in without this test noticing via arity alone.
    expect(body!.toLowerCase()).not.toContain('overage');

    // The REAL function, running for real — never a re-implementation of what it should do.
    // `compare` and `ZERO` are the real @shareat/core/money exports the body reads (T-371: no Number() on a money string) — bound, not re-implemented.
    const isHandedOverFn = new Function('parseMoneyInput', 'compare', 'ZERO', 'amount', body!) as (
      parseMoneyInput: typeof import('@shareat/domain/money-input').parseMoneyInput,
      compare: typeof import('@shareat/core/money').compare,
      ZERO: typeof import('@shareat/core/money').ZERO,
      amount: string,
    ) => boolean;
    const isHandedOver = (pmi: typeof parseMoneyInput, amount: string): boolean => isHandedOverFn(pmi, compare, ZERO, amount);

    expect(isHandedOver(parseMoneyInput, ''), 'blank amount must not count as handed over').toBe(false);
    expect(isHandedOver(parseMoneyInput, '0'), 'a zero amount must not count as handed over').toBe(false);
    expect(isHandedOver(parseMoneyInput, '0.00'), 'a zero amount (2dp) must not count as handed over').toBe(false);
    // Control — if this were false too, the function would be vacuously refusing everything and
    // the three checks above would be proving nothing.
    expect(isHandedOver(parseMoneyInput, '100'), 'a genuine positive amount must count as handed over').toBe(true);
  });

  /**
   * ⭐⭐ T-328 — the guarantee RELOCATED, not merely widened. GROUP 1 threaded the account name
   * through by adding `handedOverOn(line)`, a wrapper around the still-scalar `isHandedOver` that
   * catches and re-labels its error with the account name. `isHandedOver` itself is untouched —
   * still `(amount: string) => boolean`, still closure-free, still a `ReferenceError` if its body
   * ever tried to read anything but `amount`. But the `.filter(...)`/`.find(...)` call sites now
   * call `handedOverOn(l)`, not `isHandedOver(l.amount)` — so `handedOverOn` is what actually
   * decides today, and NOTHING tested it until this. Verified independently before writing this
   * (never taken on the report that produced this test): read `handedOverOn` at source — it
   * decides solely by delegating to `isHandedOver(line.amount)`, and the only other thing its body
   * does is catch-and-relabel; `declaredOverage` is not referenced anywhere inside it.
   *
   * ⚠️ THE KIND OF GUARANTEE IS WEAKER HERE THAN FOR `isHandedOver` ABOVE, RECORD WHY:
   * `handedOverOn` takes an OBJECT (`{ fromMoneyAccountId, amount }`), so binding it for execution
   * needs a `line` object, not a scalar. A body that read `line.declaredOverage` against a fixture
   * that never sets that field would get `undefined` — falsy, no throw — and every assertion below
   * would still pass; the `ReferenceError`-on-any-other-identifier property `isHandedOver` has
   * (real, from the JS scope chain — `new Function` binds only the names listed) does NOT carry
   * over once the argument is a bag of fields rather than a single value. What protects
   * `handedOverOn` today is only the TYPE ANNOTATION listing two fields — a convention, one word
   * away from being silently widened, not a structural fact the way `isHandedOver`'s is. THAT is
   * why the fixture below explicitly sets `declaredOverage` to a truthy value on a blank-amount
   * line and asserts `false`, built in from the first version of this test rather than added after
   * a later break — the field's ABSENCE from other fixtures would otherwise be indistinguishable
   * from a body that correctly ignores it.
   */
  it("actions.ts: handedOverOn (what the filter ACTUALLY calls today) decides only via isHandedOver, ignores declaredOverage even when present, and labels a refusal with the account", () => {
    const isHandedOverBody = extractArrowFunctionBody(actionsSource, 'const isHandedOver = ');
    expect(isHandedOverBody, 'could not extract isHandedOver').not.toBeNull();
    const realIsHandedOverFn = new Function('parseMoneyInput', 'compare', 'ZERO', 'amount', isHandedOverBody!) as (
      parseMoneyInput: typeof import('@shareat/domain/money-input').parseMoneyInput,
      compare: typeof import('@shareat/core/money').compare,
      ZERO: typeof import('@shareat/core/money').ZERO,
      amount: string,
    ) => boolean;
    const realIsHandedOver = (pmi: typeof parseMoneyInput, amount: string): boolean => realIsHandedOverFn(pmi, compare, ZERO, amount);

    const handedOverOnBody = extractArrowFunctionBody(actionsSource, 'const handedOverOn = ');
    expect(handedOverOnBody, 'could not extract handedOverOn').not.toBeNull();

    // Bound to the REAL isHandedOver above (itself bound to the REAL parseMoneyInput) — never a
    // re-implementation at either layer. accountName is a stub; only its RESULT is inspected
    // (present in the thrown message), never its own logic — that belongs to a different guard.
    const realHandedOverOn = new Function('isHandedOver', 'accountName', 'line', handedOverOnBody!) as (
      isHandedOver: (amount: string) => boolean,
      accountName: (id: string) => string,
      line: { fromMoneyAccountId: string; amount: string; declaredOverage?: string },
    ) => boolean;
    const boundIsHandedOver = (amount: string) => realIsHandedOver(parseMoneyInput, amount);
    const accountName = (id: string) => `Account ${id}`;

    expect(
      realHandedOverOn(boundIsHandedOver, accountName, { fromMoneyAccountId: 'a', amount: '' }),
      'blank amount must not count as handed over',
    ).toBe(false);
    // ⭐ THE MANDATORY CASE — see the comment above. Without it, a body reading
    // `line.declaredOverage` would read `undefined` from every OTHER fixture here and pass anyway.
    expect(
      realHandedOverOn(boundIsHandedOver, accountName, {
        fromMoneyAccountId: 'a',
        amount: '',
        declaredOverage: '50',
      }),
      'a declared overage on a blank-amount line must NOT make it count as handed over',
    ).toBe(false);
    expect(
      realHandedOverOn(boundIsHandedOver, accountName, { fromMoneyAccountId: 'a', amount: '0' }),
      'a zero amount must not count as handed over, declaredOverage or not',
    ).toBe(false);
    expect(
      realHandedOverOn(boundIsHandedOver, accountName, { fromMoneyAccountId: 'a', amount: '100' }),
      'a genuine positive amount must count as handed over (control)',
    ).toBe(true);

    // The re-labelling half: a malformed amount still throws (isHandedOver's own job), and
    // handedOverOn's own job is to name which account it was on.
    expect(() =>
      realHandedOverOn(boundIsHandedOver, accountName, { fromMoneyAccountId: 'acct-123', amount: 'abc' }),
    ).toThrow(/Account acct-123/);
  });
});

describe('T-324 slice B — the explanatory paragraph must cover the over case, not only the short case', () => {
  it('page.tsx: the "Record a handover" paragraph describes what happens when the amount is OVER what is owed', () => {
    const headingIdx = pageSource.indexOf('Record a handover</h2>');
    expect(headingIdx, 'could not find the "Record a handover" heading').not.toBe(-1);
    const formIdx = pageSource.indexOf('<form action={createRemittanceAction}', headingIdx);
    expect(formIdx, 'could not find the form following the heading').not.toBe(-1);
    const between = pageSource.slice(headingIdx, formIdx);
    const pMatch = between.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    expect(pMatch, 'could not find the explanatory <p> between the heading and the form').not.toBeNull();
    const paragraphText = requireGroup(pMatch, 1, 'explanatory paragraph');

    // Matched on meaning, not on an exact sentence: today the paragraph only ever says what
    // happens when the handover is SHORT. §6 item 5 requires it to also say what happens when it
    // is OVER — the case this whole task exists to let through.
    expect(paragraphText).toMatch(/short|shortfall/i);
    // ⛔ NOT a bare /over/ — "over" is a substring of "handover" and of "handed over", both of
    // which a SHORT-only paragraph can say without ever describing the over case (a real finding:
    // the auditor's example, "a short handover lands the shortfall...", satisfied the old regex).
    // These four all require a genuine "more than owed" claim, not just the word "over" appearing.
    expect(paragraphText).toMatch(/overage|exceed|excess|more than\b.{0,25}\bowe/i);
  });
});

describe('T-324 slice B — the second stale paragraph: not settleable is not the same as not handable-over', () => {
  it('page.tsx: the heldBack paragraph no longer tells the cashier the money cannot be handed over', () => {
    // Not found via the diff — the slice does not touch these lines — but by searching for the
    // old claim elsewhere in the file (bible row 214's mirror). Before T-324, "cannot be remitted
    // yet" was true because there was no other way to move the cash. After T-324 it is false: the
    // cash can be declared as an overage and handed over today; only settlement waits on
    // verification. Matched on meaning, not an exact sentence.
    const heldBackIdx = pageSource.indexOf('heldBack.length > 0 &&');
    expect(heldBackIdx, 'could not find the heldBack.length > 0 && guard in page.tsx').not.toBe(-1);
    const pMatch = pageSource.slice(heldBackIdx).match(/<p[^>]*>([\s\S]*?)<\/p>/);
    expect(pMatch, 'could not find the heldBack <p> following the guard').not.toBeNull();
    const paragraphText = requireGroup(pMatch, 1, 'heldBack paragraph');

    // The fact that survives T-324 unchanged: the day cannot be SETTLED without verification.
    expect(paragraphText).toMatch(/settl|verif/i);
    // The fact T-324 changes: the cash CAN still be handed over today, by declaring the overage —
    // so the paragraph must not tell the cashier outright that it cannot be remitted/handed over.
    // ⛔ Allows 0-2 words between "cannot" and "be" — "cannot be remitted" is not the only way to
    // say it; "cannot yet be remitted" is a natural rewrite of the exact stale claim this checks
    // for, and a literal-adjacency regex would walk right past it (a real finding from the auditor).
    expect(paragraphText).not.toMatch(/\bcannot\s+(?:\w+\s+){0,2}be\s+(remitted|handed\s+over)\b/i);
    expect(paragraphText).toMatch(/hand(ed)?\s*over|overage/i);
  });
});

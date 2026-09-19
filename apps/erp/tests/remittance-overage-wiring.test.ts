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
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const pagePath = resolve(here, '..', 'src', 'app', 'remittance', 'page.tsx');
const actionsPath = resolve(here, '..', 'src', 'app', 'remittance', 'actions.ts');
const pageSource = readFileSync(pagePath, 'utf8');
const actionsSource = readFileSync(actionsPath, 'utf8');

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
    // §6 item 2: "an overage on a line with no amount must not resurrect that line." The filter
    // predicate must still decide solely on `.amount` — if it grows an `|| l.declaredOverage`
    // (or similar), a zero-amount line with a declared overage would survive the filter and reach
    // the domain, which is exactly what this guards against.
    expect(filterBlock).toMatch(/l\.amount\s*&&\s*Number\(l\.amount\)\s*>\s*0/);
    expect(filterBlock.toLowerCase()).not.toContain('overage');
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

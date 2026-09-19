/**
 * T-325/DEF-376 — the money-positivity census, extracted out of the guard test so `rootDir` can be
 * a parameter instead of a module constant: that is what lets `money-positivity-census.test.ts`
 * scan a disposable fixture directory instead of `packages/domain/src` itself.
 * `money-positivity-guard.test.ts` is the guard that consumes this module against the real tree.
 *
 * ⛔ DEVELOPMENT TOOLING — NEVER RE-EXPORT FROM `packages/domain/src/index.ts`. This module imports
 * `node:fs` and walks the filesystem; the domain package otherwise ships into the app bundle, and a
 * future barrel re-export would put `readdirSync` inside it for no functional reason. It is inert
 * today only because nothing imports it — keep it that way.
 *
 * ⛔⛔ THIS MODULE LIVES INSIDE THE DIRECTORY IT SCANS. `packages/domain/src` is exactly what
 * `scanMoneyPositivitySites` walks, and this file is a non-test `.ts` file in it — so a careless
 * comparison written in here (a bare `Number(x) <op> 0` or a negated-paren positivity check) would
 * join the census as an unclassified site and turn the guard red, pointing at this file. The fix if
 * that ever happens is to reword this file's own code — never to add this module to the skip-list,
 * which would blind the guard to a real directory. (A regex *literal* spells the two shapes escaped
 * — the source text reads `Number\(` and `!\(`, not `Number(` or `!(` — so it does not self-match.)
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

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

/**
 * Blank comments so prose never counts as a match. Strings are left alone — a positivity
 * comparison never lives inside a string literal, and blanking them risks swallowing real code.
 * Moved verbatim from the guard test this module was extracted from.
 */
export function stripComments(src: string): string {
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

export interface CensusSite {
  file: string;
  line: number;
  /** The untouched source line, payload and all — what a CLI or a failure message displays. */
  raw: string;
  /** The comparison text alone, full numeric literal included — what gets hashed into `key`. */
  comparison: string;
  key: string;
}

// MATCHING — decides which sites are found. Moved verbatim from the guard test; must never change
// (Contract §1) — changing either regex changes which sites the census finds, and this task
// changes none.
const NUMBER_CMP = /Number\(((?:[^()]|\([^()]*\))*)\)\s*(<=|<|>=|>)\s*0/;
const NEG_PAREN_GT = /!\(\s*((?:[^()]|\([^()]*\))*?)\s*>\s*0\s*\)/;

// KEY EXTRACTION — decides what the key says. New in this task: the same two shapes, but
// consuming the whole numeric literal in place of the bare `0` the matching pair stops at (three
// real sites compare against a 0.005 tolerance, and truncating it would make a 0.005 -> 0 edit
// invisible to the guard). ⛔ Never used to decide MEMBERSHIP on its own — it matches a superset
// (`> 5` would match), so it is always applied ANCHORED at a membership match's own index, never
// by researching the line independently. Researching independently let a key regex settle on a
// different `Number(...)` occurrence than the one membership actually found on a multi-comparison
// line (`Number(cap) > 5 || Number(amount) > 0`), making the real guard's operator editable without
// moving the key — a false green in exactly the direction this module exists to prevent. `y`
// (sticky): the match must start exactly at `lastIndex`, never later in the line.
const NUMBER_CMP_KEY = /Number\(((?:[^()]|\([^()]*\))*)\)\s*(<=|<|>=|>)\s*([0-9]+(?:\.[0-9]+)?)/y;
const NEG_PAREN_GT_KEY = /!\(\s*((?:[^()]|\([^()]*\))*?)\s*>\s*([0-9]+(?:\.[0-9]+)?)\s*\)/y;

/**
 * Returns the matched comparison text — including the whole numeric literal — from `codeLine`, or
 * `null` if the line has neither guarded shape. Intended input is an already comment-stripped
 * line.
 *
 * First runs the MATCHING (membership) pair to decide WHICH comparison on the line is a guarded
 * site and at what index, then extracts with the corresponding key regex anchored at that exact
 * index — never by running the key regex over the whole line independently. Anchoring matters
 * because the key regex accepts any numeric literal while the membership regex requires a literal
 * `0`: on a line with two `Number(...)` comparisons, an unanchored search can settle on the
 * non-guarded one, making the real guard's operator or literal editable with no effect on the key.
 *
 * When BOTH shapes match one line — e.g. `!(Number(amount) > 0)`, a `Number(...)` comparison
 * wrapped in a negated-paren guard — the OUTER match wins, never the inner one, WHEREVER the outer
 * shape can match it. Deleting just the `!` silently inverts that guard (from "refuse a
 * non-positive value" to "refuse a positive one"), and only a key built from the outer text moves
 * when that happens; a key built from the inner text alone would stay unchanged — a false green on
 * the single most dangerous edit that line can suffer. ⚠️ This does NOT cover every nesting depth:
 * `NEG_PAREN_GT`'s inner alternation tolerates only one level of nested parens, so at two-deep
 * nesting (`!(Number.isFinite(Number(x)) && Number(x) > 0)`, live at
 * `deliveries/documents.ts`) the outer shape does not match at all and extraction falls through to
 * the inner `Number(...)` — a pre-existing gap under the old `file:line` key too, unrelated to this
 * task's key change, tracked separately (DEF-381) rather than papered over by widening either
 * MATCHING regex, which Invariant 4 forbids here.
 */
export function extractComparison(codeLine: string): string | null {
  const numberMembership = NUMBER_CMP.exec(codeLine);
  const negParenMembership = NEG_PAREN_GT.exec(codeLine);

  let membershipMatch: RegExpExecArray;
  let keyRegex: RegExp;
  if (numberMembership && negParenMembership) {
    // Both shapes match this line — the OUTER (negated-paren) shape wins; see docstring.
    membershipMatch = negParenMembership;
    keyRegex = NEG_PAREN_GT_KEY;
  } else if (negParenMembership) {
    membershipMatch = negParenMembership;
    keyRegex = NEG_PAREN_GT_KEY;
  } else if (numberMembership) {
    membershipMatch = numberMembership;
    keyRegex = NUMBER_CMP_KEY;
  } else {
    return null;
  }

  keyRegex.lastIndex = membershipMatch.index;
  const extracted = keyRegex.exec(codeLine);
  return extracted ? extracted[0] : null;
}

/** Collapse every whitespace run to one space, then trim. Nothing else: no lowercasing, no quote
 *  folding, no punctuation stripping — each of those would make two genuinely different
 *  comparisons collide, which is the one failure this key must not have. */
export function normaliseComparison(comparison: string): string {
  return comparison.replace(/\s+/g, ' ').trim();
}

/**
 * `file` + `::` + the normalised comparison. The file stays in the key (DEF-376's own
 * recommendation): the same comparison text in two different modules is two different decisions —
 * and it is what keeps a `0.005` tolerance in one file distinct from an identical-looking `0.005`
 * tolerance in another.
 */
export function censusKey(file: string, comparison: string): string {
  return `${file}::${normaliseComparison(comparison)}`;
}

/**
 * Scans every `.ts` file under `rootDir` (excluding `.test.ts`/`.d.ts`) for the two guarded
 * money-positivity comparison shapes. `rootDir` is a parameter, not a module constant — that is
 * what lets a test scan a disposable fixture directory, and it is the only reason this extraction
 * is worth doing at all.
 */
export function scanMoneyPositivitySites(rootDir: string): CensusSite[] {
  const files = walk(rootDir, []).map((p) => relative(rootDir, p).split(sep).join('/'));
  const seen = new Set<string>();
  const sites: CensusSite[] = [];
  for (const f of files) {
    const abs = join(rootDir, f);
    let text: string;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const stripped = stripComments(text);
    const strippedLines = stripped.split(/\r?\n/);
    const rawLines = text.split(/\r?\n/);
    strippedLines.forEach((line, i) => {
      if (!NUMBER_CMP.test(line) && !NEG_PAREN_GT.test(line)) return;
      const dedupeKey = `${f}:${i + 1}`;
      if (seen.has(dedupeKey)) return;
      seen.add(dedupeKey);

      const comparison = extractComparison(line);
      if (comparison === null) {
        // The matching and key-extraction pairs are supersets of each other by construction
        // (Contract §1) — a line the matching pair found that yields no comparison here means the
        // two pairs have drifted apart. Never skip: a silent skip would drop a guarded money
        // comparison from the census entirely, with every test here staying green.
        throw new Error(
          `scanMoneyPositivitySites: matched a site at ${f}:${i + 1} but extractComparison found ` +
            'nothing there. The matching and key-extraction regex pairs have drifted apart — this ' +
            `is a bug in this module, not a new site. Stripped line: ${line}`,
        );
      }

      sites.push({
        file: f,
        line: i + 1,
        raw: (rawLines[i] ?? '').trim(),
        comparison,
        key: censusKey(f, comparison),
      });
    });
  }
  return sites;
}

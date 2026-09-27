/**
 * T-255 — DEF-257, bible §13 row 189. `docs/tasks/255-def-257-local-errormessage-copies.md`.
 *
 * ⛔ **What this file must prove**: the sanitising prefix-strip that turns a thrown error into a
 * sentence exists in exactly ONE place in the repo — `src/lib/constraint-messages.ts` — and every
 * screen that used to keep its own copy now routes its fallback through it. T-252 sanitised the
 * shared `errorMessage` so an unmapped constraint can never render raw Postgres driver text; 42
 * files had their own copy of the pre-T-252 logic and so never received that fix, including
 * `cash-requests`, `loans`, `ap` and `money-transfers` — the four DEF-246 names as its motivating
 * examples.
 *
 * ⚠️ **This is a SOURCE sweep, not a behaviour test, and that is forced rather than chosen**: 37 of
 * the 38 named local copies were module-private (only `commissary/orders/lib.ts` exported one), so
 * none of them could be imported and asserted on. That is not incidental — *being invisible to a
 * test is why they drifted*. The guard therefore reads the text, the way
 * `action-link-sweep.test.ts` does.
 *
 * ⭐ **Shape, not spelling** — DEF-243's lesson, and it earned its keep here within the hour. The
 * first census of this defect counted files declaring `function errorMessage`, found 38, and
 * MISSED FOUR: `attendance/[dayId]/actions.ts`, `payroll/lib.ts`, `payroll/separations/lib.ts` and
 * `payroll/thirteenth-month/lib.ts` inline the identical two lines in a `catch` block without ever
 * naming them. A spelling-based guard would have shipped that hole. This one matches the regex
 * literal's SHAPE, so a fifth copy under a fifth name is still caught.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { errorMessage } from '../src/lib/constraint-messages';

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(here, '..', 'src');

/** The one file allowed to hold the strip — it IS the shared implementation. */
const SHARED = 'lib/constraint-messages.ts';

function posix(absolute: string): string {
  return relative(srcRoot, absolute).split(sep).join('/');
}

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFilesUnder(full));
    else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) out.push(full);
  }
  return out;
}

const FILES = tsFilesUnder(srcRoot).map((absolute) => ({
  path: posix(absolute),
  text: readFileSync(absolute, 'utf8'),
}));

/**
 * A prefix-strip: `.replace(` a regex literal anchored at `^`, whose body ends with a colon and
 * optional whitespace. Matches all four spellings found in the tree — the `[a-z]`, `[a-zA-Z]` and
 * `[A-Za-z0-9_.]` character-class variants and the one named `deactivateLocation` strip — and any
 * future one, because it does not care what sits between `^` and the colon.
 *
 * ⚠️ The spellings are described rather than quoted on purpose: each ends in the two characters
 * that close a block comment, and pasting one here silently truncated this comment and broke the
 * parse the first time round.
 *
 * ⚠️ It deliberately does not match a bare `.test()` guard choosing a branch (as opposed to a
 * strip) — `admin/users/actions.ts`'s own `/^revokeCredential:/` branch was exactly that shape,
 * until T-343 S7 deleted it (presentable-first now wins, so the local branch was dead weight).
 * PREFIX_STRIP's own exclusion of `.test()` guards no longer depends on that specific branch
 * still existing; it is a general property of what this regex is written to match.
 */
const PREFIX_STRIP = /\.replace\(\s*\/\^[^/\n]*:\\s\*\//;

/** A file declaring its own copy of the helper, under either name it goes by. */
const DECLARES_LOCAL = /^\s*(?:export\s+)?function\s+errorMessage(?:Of)?\s*\(/m;

/** An import of the shared module, however deep the relative path or via the `@/` alias. */
const IMPORTS_SHARED = /from\s+'(?:\.\.\/)+lib\/constraint-messages'|from\s+'@\/lib\/constraint-messages'/;

/** `import { errorMessage }` with no `as` — the one shape that would shadow a local declaration. */
const IMPORTS_UNALIASED = /import\s*\{[^}]*\berrorMessage\b(?!\s+as)[^}]*\}\s*from\s+'[^']*lib\/constraint-messages'/;

describe('T-255 — the sanitising fallback exists in exactly one place', () => {
  it('no file outside constraint-messages.ts strips an error prefix itself', () => {
    const offenders = FILES.filter((f) => f.path !== SHARED && PREFIX_STRIP.test(f.text)).map(
      (f) => f.path,
    );
    expect(
      offenders,
      `${offenders.length} file(s) still carry their own prefix-strip. Each must delegate to ` +
        `errorMessage() from ${SHARED} instead:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('constraint-messages.ts still holds the strip — the guard is not passing by deleting it', () => {
    const shared = FILES.find((f) => f.path === SHARED);
    expect(shared, `${SHARED} not found under src/`).toBeDefined();
    expect(PREFIX_STRIP.test(shared!.text)).toBe(true);
  });
});

describe('T-255 — every screen that still has a local translator delegates to the shared one', () => {
  it('a file declaring a local errorMessage imports the shared module', () => {
    const offenders = FILES.filter((f) => DECLARES_LOCAL.test(f.text) && !IMPORTS_SHARED.test(f.text))
      .map((f) => f.path)
      .filter((p) => p !== SHARED);
    expect(
      offenders,
      `${offenders.length} file(s) declare their own errorMessage without importing the shared ` +
        `implementation to fall back to:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('no file both declares a local errorMessage and imports the shared name unaliased', () => {
    // The one mechanical way this refactor can produce a file that compiles in the wrong
    // direction: the import shadows, or is shadowed by, the local declaration.
    const offenders = FILES.filter(
      (f) => f.path !== SHARED && DECLARES_LOCAL.test(f.text) && IMPORTS_UNALIASED.test(f.text),
    ).map((f) => f.path);
    expect(
      offenders,
      `${offenders.length} file(s) shadow the shared errorMessage with a local one. Import it ` +
        `aliased — \`import { errorMessage as sharedErrorMessage }\`:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });
});

/**
 * ⭐ DEF-246's acceptance criterion, asserted per screen rather than in the abstract. These four
 * constraints are the ones DEF-246 cites, on the four screens it names — and each is reachable
 * today: the TypeScript guard above it compares the TYPED value (`Number(input.amount) <= 0`)
 * while the column is `numeric(14,2)`, so `0.004` passes the guard, stores as `0.00` and the CHECK
 * refuses it. See §7 finding E1 of the task spec.
 */
describe('T-255 — the four DEF-246 money screens can no longer render driver text', () => {
  const CASES: Array<[relation: string, constraint: string, noun: string]> = [
    ['cash_requests', 'cash_requests_amount_positive_check', 'cash requests'],
    ['loans', 'loans_principal_positive_check', 'loans'],
    ['ap_payments', 'ap_payments_amount_positive_check', 'ap payments'],
    ['money_transfers', 'money_transfers_distinct_accounts_check', 'money transfers'],
  ];

  for (const [relation, constraint, noun] of CASES) {
    it(`${constraint} degrades to a sentence, not SQL`, () => {
      const raw = `new row for relation "${relation}" violates check constraint "${constraint}"`;
      const message = errorMessage(new Error(raw));

      expect(message).not.toContain(constraint);
      expect(message).not.toContain('violates');
      expect(message).not.toContain('relation');
      expect(message).not.toContain('new row');
      expect(message).toContain(noun);
      expect(message.split('\n')).toHaveLength(1);
    });
  }
});

/**
 * The §5 regression table, executed. Each input is a real message shape one of the 42 files'
 * fallbacks handles today; each expectation is what that file's own fallback returns today. If
 * converging on the shared implementation changed any of them, these fail.
 */
describe('T-255 — no message a person reads changes', () => {
  const UNCHANGED: Array<[label: string, raw: string, expected: string]> = [
    [
      'an authorization refusal — the prefix is lower-case, both regexes strip it identically',
      "authorize: role 'staff' may not 'post_usage'",
      "role 'staff' may not 'post_usage'",
    ],
    [
      'a domain amount guard — the sentence the four money screens actually show today',
      'createCashRequest: the amount has to be greater than zero.',
      'the amount has to be greater than zero.',
    ],
    [
      'a closed-period refusal passed through by inventory usage/production/deliveries',
      'postProduction: fiscal period 2026-08 is closed',
      'fiscal period 2026-08 is closed',
    ],
    [
      'the one named strip — inventory/locations stripped this prefix by name',
      'deactivateLocation: that room holds stock and cannot be deactivated',
      'that room holds stock and cannot be deactivated',
    ],
    [
      'a sentence with no prefix at all is untouched',
      'A person needs a name.',
      'A person needs a name.',
    ],
    [
      'a sentence whose colon is not a prefix is untouched',
      'Two open shifts on one till: nobody would know who holds the cash.',
      'Two open shifts on one till: nobody would know who holds the cash.',
    ],
  ];

  for (const [label, raw, expected] of UNCHANGED) {
    it(label, () => {
      expect(errorMessage(new Error(raw))).toBe(expected);
    });
  }

  it('a non-Error throw still coerces to a string', () => {
    expect(errorMessage('plain string refusal')).toBe('plain string refusal');
  });
});

/**
 * T-261 — DEF-274, bible §13 rows 189/192. `docs/tasks/261-def-274-counter-reaches-money-screens.md`
 * §B6 / §B4.1.
 *
 * ⛔ **What this file must prove, in two parts.**
 *
 * Part 1 (§B6) — `withOrgPrincipal` is imported directly from `@shareat/db` in exactly ONE app
 * file, `app/expenses/lib.ts` (plus the one deliberately-excluded read-only reporting query at
 * `app/admin/prerequisite-refusals/lib.ts`). Every other one of the 117 files that reach it does so
 * through a re-export chain rooted there. That single import site is now also the constraint-refusal
 * counter's chokepoint — see the wrapper in `expenses/lib.ts`. A file that starts importing the
 * package directly again would silently create a second, unwrapped path to the database that the
 * counter cannot see.
 *
 * Part 2 (§B4.1) — production paths hand a domain function `null` and let it open its own
 * transaction, so they never pass through the chokepoint at all. Six are wrapped in
 * `recordingRefusalsFor`. ⚠️ **This paragraph's own "seven"/"six wrapped, one unwrapped" undercounts
 * even before this change** — the DEF-288 paragraph below already lists FIVE unwrapped sites, not
 * one, so the true prior total was eleven, not seven; the arithmetic here was never updated when
 * those four joined. Not re-derived in full here — flagged rather than silently perpetuated. T-304
 * adds a SIXTH unwrapped site, `resolveTerminalIdentity` (same shape, one layer earlier than the
 * DEF-288 calls it joins), making twelve. This is a CENSUS, not a prohibition on the shape itself:
 * a new one appearing (wrapped or not) must be accounted for explicitly, here, or the counter has
 * a new blind spot nobody decided to accept.
 *
 * ⚠️ **Discriminate by SHAPE, not by spelling — required, not advisory (§B4.1).** A naive sweep for
 * `(null` as a first argument returns 18 matches in this tree, not 7: the other 11 are React
 * `setState(null)` / `setError(null)` calls in client components. The discriminator is that the
 * called identifier is imported from `@shareat/domain` or `@shareat/auth` — verified independently
 * against the tree before this file was written.
 *
 * ⚠️ Match on shape, not on line endings, and case-insensitively where SQL/DDL is involved (neither
 * applies to this file's regexes, but the convention is inherited from
 * `local-errormessage-convergence.test.ts`, read first for the directory walker and `posix()`
 * helper this file reuses).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(here, '..', 'src');

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

// ---------------------------------------------------------------------------------------------
// §B6 — the single chokepoint.
// ---------------------------------------------------------------------------------------------

const WRAPPER_FILE = 'app/expenses/lib.ts';
const ALLOWED_DIRECT_IMPORTERS = new Set([WRAPPER_FILE, 'app/admin/prerequisite-refusals/lib.ts']);

/** `import { ..., withOrgPrincipal, ... } from '@shareat/db'` — `[^}]*` spans newlines by
 *  construction (a negated character class, not `.`), so a multi-line destructured import still
 *  matches. */
const IMPORTS_FROM_PACKAGE = /import\s*\{[^}]*\bwithOrgPrincipal\b[^}]*\}\s*from\s*'@shareat\/db'/;

describe('T-261 — withOrgPrincipal has exactly one chokepoint (§B6)', () => {
  it('no file outside the chokepoint imports withOrgPrincipal directly from @shareat/db', () => {
    const offenders = FILES.filter(
      (f) => !ALLOWED_DIRECT_IMPORTERS.has(f.path) && IMPORTS_FROM_PACKAGE.test(f.text),
    ).map((f) => f.path);
    expect(
      offenders,
      `${offenders.length} file(s) import withOrgPrincipal directly from @shareat/db. Import it ` +
        `from '../expenses/lib' instead — that is the chokepoint where the constraint-refusal ` +
        `counter lives:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('app/expenses/lib.ts still DEFINES the wrapper — the guard must not pass by its deletion', () => {
    const wrapper = FILES.find((f) => f.path === WRAPPER_FILE);
    expect(wrapper, `${WRAPPER_FILE} not found under src/`).toBeDefined();
    expect(wrapper!.text).toMatch(/export\s+async\s+function\s+withOrgPrincipal\s*</);
  });
});

// ---------------------------------------------------------------------------------------------
// §B4.1 — the null-tx census.
// ---------------------------------------------------------------------------------------------

const IMPORT_FROM_DOMAIN_OR_AUTH = /import\s*\{([^}]*)\}\s*from\s*'@shareat\/(?:domain|auth)'/g;

/** The local binding names a file imports from `@shareat/domain` or `@shareat/auth` — the only
 *  population §B4.1's discriminator allows. Skips `type X` entries (a type cannot be called) and
 *  resolves `X as Y` to the local name `Y`. */
function domainOrAuthImportedNames(text: string): string[] {
  const names: string[] = [];
  for (const m of text.matchAll(IMPORT_FROM_DOMAIN_OR_AUTH)) {
    for (const raw of m[1]!.split(',')) {
      const item = raw.trim();
      if (!item || /^type\s/.test(item)) continue;
      const asMatch = /\bas\s+(\w+)/.exec(item);
      names.push(asMatch ? asMatch[1]! : item.split(/\s+/)[0]!);
    }
  }
  return names;
}

/**
 * The call sites this guard knows about, keyed `file:identifier`. Six are wrapped in
 * `recordingRefusalsFor` so the refusal counter can still see them; the rest are the deliberate
 * exceptions below (see the header's note on the stale "seven" this file used to claim).
 */
// ⭐ T-342 / DEF-417 part 1, Amendment A1: the five cutover sites are wrapped in
// `withOrgPrincipal(actor.orgId, tx => domainFn(tx, actor, …))` now — fixed, dropped from this
// census. `runDepreciation` stays: its null branch is deliberate (per-asset transaction
// isolation, `packages/domain/src/fixed-assets/depreciate.ts:251-253,282`), not the DEF-417 shape,
// and the fix was reverted.
const WRAPPED_NULL_TX_SITES: ReadonlySet<string> = new Set([
  'app/fixed-assets/actions.ts:runDepreciation',
]);

/**
 * ⛔ The null-tx calls that must NEVER be wrapped. `setup/actions.ts` runs before any
 * organisation exists — first-run setup precedes every org — so there is no `orgId` to file a
 * refusal row under. Wrapping it would file a row with nothing to file it under.
 * `pre-session-message.ts` is the mechanism that covers `/setup` and `/sign-in` instead (§B9).
 *
 * ⭐ **The four authentication calls joined it 2026-09-11 — DEF-288, bible §13 row 194 — and for
 * the SAME reason, arrived at from the opposite direction.** They pass `null` deliberately so the
 * entry point opens `authTransaction()` itself: these run BEFORE anyone knows which organisation
 * is acting, because discovering that is what they are for. `recordingRefusalsFor(actor.orgId, …)`
 * is unavailable to them in the most literal sense — there is no `actor` yet, and no `orgId` to
 * file under.
 *
 * ⚠️ **They used to open bare `transaction()`s instead, and that is precisely what DEF-288 was:**
 * with a non-bypassing role, PIN sign-in said *"that PIN is not valid"*, Firebase sign-in said
 * *"not linked to a person"*, every authenticated request said *"Not signed in"*, and sign-out
 * silently ended nothing. Passing `null` here is the fix, not a new exemption — the refusal
 * counter could never see these paths under either shape.
 */
const ALLOWLISTED_UNWRAPPED_NULL_TX_SITES: ReadonlySet<string> = new Set([
  'app/setup/actions.ts:signInWithFirebase',
  'app/sign-in/actions.ts:signInWithPin',
  'app/sign-in/actions.ts:signOut',
  // T-304 — the SAME shape and the SAME reason as the four DEF-288 calls above, arrived at from
  // one layer earlier: `resolveTerminalIdentity` is what DISCOVERS the terminal's org and store,
  // so there is no `actor.orgId` yet to file a refusal under. It is called from both
  // `verifyTerminalAction` (layer 1) and `signInWithTerminalPinAction` (layer 2's re-resolve,
  // orchestrator's carrier ruling, 2026-09-13) — one key here covers both call sites.
  'app/sign-in/actions.ts:resolveTerminalIdentity',
  'app/sign-in/lib.ts:signInWithFirebase',
  'lib/session.ts:resolveActor',
]);

describe('T-261 — every null-tx call bypassing the chokepoint is accounted for (§B4.1)', () => {
  it('the null-tx population is exactly the known call sites, no unaccounted one', () => {
    const found = new Map<string, number>(); // "file:identifier" -> 1-based line

    for (const f of FILES) {
      for (const name of domainOrAuthImportedNames(f.text)) {
        const m = new RegExp(`\\b${name}\\s*\\(\\s*null\\b`).exec(f.text);
        if (m) found.set(`${f.path}:${name}`, f.text.slice(0, m.index).split('\n').length);
      }
    }

    const expected = new Set([...WRAPPED_NULL_TX_SITES, ...ALLOWLISTED_UNWRAPPED_NULL_TX_SITES]);
    const foundKeys = new Set(found.keys());

    const unexpected = [...foundKeys].filter((k) => !expected.has(k));
    const missing = [...expected].filter((k) => !foundKeys.has(k));

    expect(
      unexpected,
      `${unexpected.length} call(s) pass null as a first argument to a @shareat/domain or ` +
        `@shareat/auth import and are not accounted for. This path bypasses withOrgPrincipal, so ` +
        `the refusal counter cannot see it — wrap the call in ` +
        `recordingRefusalsFor(actor.orgId, () => ...), or add it to the allowlist above and say ` +
        `why:\n  ${unexpected.map((k) => `${k} (line ${found.get(k)})`).join('\n  ')}`,
    ).toEqual([]);
    expect(
      missing,
      `expected null-tx call site(s) no longer found — either fixed (update this census) or ` +
        `renamed in a way the discriminator no longer sees:\n  ${missing.join('\n  ')}`,
    ).toEqual([]);
  });

  it('setup/actions.ts:signInWithFirebase stays unwrapped — wrapping it would file a row with no org', () => {
    const setupFile = FILES.find((f) => f.path === 'app/setup/actions.ts');
    expect(setupFile, 'app/setup/actions.ts not found under src/').toBeDefined();
    expect(setupFile!.text).not.toMatch(/recordingRefusalsFor/);
  });
});

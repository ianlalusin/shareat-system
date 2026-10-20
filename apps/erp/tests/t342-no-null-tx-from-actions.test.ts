/**
 * T-342 / DEF-417 part 1 — guard: no app action may call a function with a literal `null`/
 * `undefined` as its first argument. `docs/tasks/342-def-417-cutover-null-tx-rls.md`.
 *
 * A null-tx call opens (or reuses) a transaction with NO principal applied
 * (`packages/db/src/client.ts`'s bare `transaction()`), so `authorize()`'s RLS-scoped read of
 * `person_roles` sees zero rows and throws "has no active role in org …" — DEF-417's whole bug.
 * The fix (BUILDER, out of scope here) is `withOrgPrincipal(actor.orgId, tx => domainFn(tx, actor, …))`
 * for each call site.
 *
 * ⭐ **Hardened after the first pass was dodgeable (auditor, this cycle).** The original matched
 * `(null|undefined)` only when immediately followed by `actor`/`ctx` on the SAME LINE — a call
 * reformatted across lines, or one whose second argument was renamed, walked straight past it.
 * This version:
 *   1. Scans whole-file text (not line-by-line), so a prettier-wrapped multi-line call is caught,
 *      and reports `file:line` by counting newlines up to the match start.
 *   2. Drops the `actor`/`ctx` name requirement entirely — ANY call whose first argument is a bare
 *      `null`/`undefined` (optionally `as <Type>`) in a server-trust file is suspect enough to flag
 *      and triage by hand, per the coordinator's instruction. A real, checked false positive gets
 *      one line in `ALLOWLIST` below, never a silent narrowing of the pattern.
 *   3. Covers `route.ts` route handlers too, not just `actions.ts` / `'use server'` files.
 */
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(here, '..', 'src');

/**
 * Matches `someCall(null,` / `someCall(undefined,` / `someCall(null as Foo<Bar>,` — across
 * whitespace and newlines (`\s` includes `\n`), so a prettier-wrapped call is caught the same as
 * a one-liner. Deliberately NOT anchored to `actor`/`ctx` as the second argument — see header.
 */
const NULL_FIRST_ARG_PATTERN = /\b\w+\(\s*(?:null|undefined)(?:\s+as\s+[\w<>[\].]+)?\s*,/g;

/**
 * `file:line` entries checked by hand and confirmed to be something OTHER than the DEF-417 shape
 * (a domain call that needs an org principal but is not given one). Dropping the `actor`/`ctx`
 * name requirement surfaced these five — all PRE-SESSION sign-in/setup calls whose second argument
 * is never an `Actor`/`Ctx` at all, because no person is authenticated yet at that point in the
 * flow: there is no org to scope a principal to. Each entry names the call and why.
 */
const ALLOWLIST: ReadonlySet<string> = new Set([
  // signInWithFirebase(null, { verifiedUid }) — first-run setup, before any session/org exists.
  'app/setup/actions.ts:105', // T-440: was :102 - the setup fields moved onto rules above it
  // resolveTerminalIdentity(null, identity.uid) — resolving WHO is signing in, pre-session.
  'app/sign-in/actions.ts:49',
  'app/sign-in/actions.ts:76',
  // signInWithPin(null, { orgId, storeId, pin, deviceId }) — the call that CREATES the session;
  // no actor/principal can exist before it returns.
  'app/sign-in/actions.ts:77',
  // signOut(null, token) — second arg is a raw session token, not an Actor/Ctx; DEF-288 already
  // covers why this one is deliberately a bare transaction (see its own comment at that line).
  'app/sign-in/actions.ts:151',
  // runDepreciation(null, actor, { through }) — Amendment A1 (spec ruling): deliberate, NOT the
  // DEF-417 shape. `packages/domain/src/fixed-assets/depreciate.ts:251-253` — "One transaction PER
  // ASSET is deliberate… one bad asset must not roll back the assets that posted cleanly" — and
  // `:282` — `if (tx) throw err; // Atomic mode: the caller asked for all-or-nothing, so give it.`
  // Wrapping the action in `withOrgPrincipal` and passing that tx through switches this call into
  // atomic mode, which is a regression, not a fix — the null branch already opens its own
  // per-asset `withOrgPrincipal` transactions internally (DEF-287), so it was never RLS-unsafe.
  'app/fixed-assets/actions.ts:228', // T-412: was :205; T-440: was :211 - the rule check moved above it
]);

function isUseServerFile(content: string): boolean {
  const firstLine = content.split(/\r?\n/).find((l) => l.trim() !== '');
  if (!firstLine) return false;
  return /^['"]use server['"];?$/.test(firstLine.trim());
}

interface Hit {
  file: string;
  line: number;
}

function lineOf(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (content.charCodeAt(i) === 10) line++;
  return line;
}

/**
 * Scans every `actions.ts`, every `route.ts`, and every `'use server'`-directive file under `root`
 * for a call whose first argument is a literal `null`/`undefined`. Returns hits sorted by file
 * then line, minus anything in `ALLOWLIST`, so the assertion is deterministic regardless of
 * filesystem traversal order.
 */
function scanForNullTx(root: string): Hit[] {
  const hits: Hit[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue;
      hits.push(...scanForNullTx(full));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue;
    const content = readFileSync(full, 'utf8');
    const isActionsFile = entry.name === 'actions.ts';
    const isRouteFile = entry.name === 'route.ts';
    if (!isActionsFile && !isRouteFile && !isUseServerFile(content)) continue;

    const relFile = relative(srcRoot, full).replace(/\\/g, '/');
    const pattern = new RegExp(NULL_FIRST_ARG_PATTERN.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(content))) {
      const line = lineOf(content, m.index);
      // T-412: `verifyAdminApproval(null, ...)` is the ONE deliberate null first argument that is not the DEF-417 shape: it opens
      // its own `withOrgPrincipal(actor.orgId, ...)` transactions (the attempt charge commits on its own, before the lookup), so
      // the null never reaches a bare transaction. Exempt by name, not by line, because every Tier P action carries one.
      if (/^verifyAdminApproval\(/.test(m[0])) continue;
      if (ALLOWLIST.has(`${relFile}:${line}`)) continue;
      hits.push({ file: relFile, line });
    }
  }
  return hits.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)));
}

describe('T-342 guard — no app action/route passes a literal null/undefined first argument (DEF-417 part 1)', () => {
  it('zero null-first-arg sites — RED TODAY, and the failure output lists the six sites the task census names', () => {
    // ⛔ The assertion is ZERO, not "these six": the builder fixes source, never a test. Until the
    // builder wraps each site in `withOrgPrincipal(actor.orgId, tx => domainFn(tx, actor, …))` per
    // the task's fix section, this fails and vitest's diff prints exactly the six current sites
    // (cutover/actions.ts:39,58,77,96,113; fixed-assets/actions.ts:147) — no edit to this file
    // makes it pass, only fixing the source does.
    const hits = scanForNullTx(srcRoot);
    expect(hits).toEqual([]);
  });

  it('negative half: the scanner sees a planted single-line fixture hit — it is not just returning empty by accident', () => {
    const tmp = mkdtempSync(join(tmpdir(), 't342-guard-'));
    try {
      const appDir = join(tmp, 'app', 'planted');
      mkdirSync(appDir, { recursive: true });
      writeFileSync(
        join(appDir, 'actions.ts'),
        ["'use server';", '', "import { someDomainFn } from '@shareat/domain';", '', 'export async function plantedAction() {', '  return someDomainFn(null, actor, {});', '}', ''].join('\n'),
      );
      const hits = scanForNullTx(tmp);
      expect(hits).toEqual([{ file: relative(srcRoot, join(appDir, 'actions.ts')).replace(/\\/g, '/'), line: 6 }]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('negative half: a prettier-wrapped MULTI-LINE call is still caught', () => {
    const tmp = mkdtempSync(join(tmpdir(), 't342-guard-multiline-'));
    try {
      const appDir = join(tmp, 'app', 'planted-multiline');
      mkdirSync(appDir, { recursive: true });
      const file = join(appDir, 'actions.ts');
      writeFileSync(
        file,
        [
          "'use server';",
          '',
          "import { someDomainFn } from '@shareat/domain';",
          '',
          'export async function plantedAction() {',
          '  return someDomainFn(',
          '    null,',
          '    actor,',
          '  );',
          '}',
          '',
        ].join('\n'),
      );
      // The call opens on line 6; the match starts at `someDomainFn(` on that same line even
      // though `null,` itself sits on line 7 — proving the scan crosses the newline rather than
      // stopping at end-of-line the way the original per-line regex did.
      expect(scanForNullTx(tmp)).toEqual([{ file: relative(srcRoot, file).replace(/\\/g, '/'), line: 6 }]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('negative half: `null as any` (a cast, not a bare literal) is still caught', () => {
    const tmp = mkdtempSync(join(tmpdir(), 't342-guard-nullas-'));
    try {
      const appDir = join(tmp, 'app', 'planted-nullas');
      mkdirSync(appDir, { recursive: true });
      const file = join(appDir, 'actions.ts');
      writeFileSync(
        file,
        ["'use server';", '', "import { someDomainFn } from '@shareat/domain';", '', 'export async function plantedAction() {', '  return someDomainFn(null as any, actor, {});', '}', ''].join('\n'),
      );
      expect(scanForNullTx(tmp)).toEqual([{ file: relative(srcRoot, file).replace(/\\/g, '/'), line: 6 }]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('covers route.ts handlers too, not just actions.ts / \'use server\' files', () => {
    const tmp = mkdtempSync(join(tmpdir(), 't342-guard-route-'));
    try {
      const appDir = join(tmp, 'app', 'api', 'planted');
      mkdirSync(appDir, { recursive: true });
      const file = join(appDir, 'route.ts');
      // No 'use server' directive and not named actions.ts — only the route.ts filename should
      // be enough to bring it into scope.
      writeFileSync(
        file,
        ["import { someDomainFn } from '@shareat/domain';", '', 'export async function GET() {', '  return someDomainFn(undefined, ctx, {});', '}', ''].join('\n'),
      );
      expect(scanForNullTx(tmp)).toEqual([{ file: relative(srcRoot, file).replace(/\\/g, '/'), line: 4 }]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('a wrapped call (withOrgPrincipal(actor.orgId, tx => domainFn(tx, actor, …))) is NOT flagged', () => {
    const tmp = mkdtempSync(join(tmpdir(), 't342-guard-clean-'));
    try {
      const appDir = join(tmp, 'app', 'clean');
      mkdirSync(appDir, { recursive: true });
      writeFileSync(
        join(appDir, 'actions.ts'),
        [
          "'use server';",
          '',
          "import { someDomainFn } from '@shareat/domain';",
          "import { withOrgPrincipal } from './lib';",
          '',
          'export async function cleanAction() {',
          '  return withOrgPrincipal(actor.orgId, (tx) => someDomainFn(tx, actor, {}));',
          '}',
          '',
        ].join('\n'),
      );
      expect(scanForNullTx(tmp)).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

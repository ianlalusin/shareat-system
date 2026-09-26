/**
 * T-343 S5.0 — W1-W3. `docs/tasks/343-def-417-human-readable-refusals.md` §S5, S5.0 table,
 * Amendment R1 item 3 (derived), Amendment R2 fold.
 *
 * Proves `tests/unit/lib/throw-census.ts`'s scanner: the 7 fixture shapes R1.3 names classify
 * id/derived exactly as designed, an id-free fixture yields nothing AND the `assertFinds` control
 * itself cannot be fooled by a scanner that finds nothing (DEF-179), and the real
 * `packages/db/src/repo` tree is walked correctly — the 3 `ap.ts` sites S3 never saw, plus the two
 * concatenated/nested-template throws (`attendance-punches.ts`, `remittance.ts`) the OLD regex
 * physically could not match (S3 census note, 2026-09-25).
 *
 * ⛔ Green on arrival — this is TESTER's own scanner code, proven against fixtures and the current
 * real tree, not the builder's conversion work (that starts at S5.1).
 */
import { describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertFinds, censusFixture, censusTree } from './lib/throw-census';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

// ---- W1: the 7 shapes, verbatim per the S5.0 table ----
const SHAPES_1_TO_5 = `
function shape1(supplierId: string) {
  throw new Error(\`supplier \${supplierId} does not exist\`);
}

function shape2(id: string) {
  throw new Error(
    \`this message spans
     multiple lines about \${id}\`,
  );
}

function shape3(x: { supplierId: string }) {
  throw new Error('prefix: ' + \`detail \${x.supplierId}\`);
}

function shape4(storeId: string) {
  throw new Error('store ' + storeId + ' is not active');
}

function shape5(a: boolean, b: { id: string }) {
  throw new Error(\`context: \${a ? \`inner \${b.id}\` : ''}\`);
}
`;

// Shape 6 is the `commissary/transfer.ts:170,174,178` shape: ids collected into a list, joined
// later, on an `Outcome` `reason:` property — never a `throw`. Shape 7 is `expenses/categories.ts:138`'s
// rewrap: an id smuggled through `err.message`.
const SHAPES_6_AND_7 = `
function shape6(lines: { itemId: string }[]) {
  const short: string[] = [];
  for (const l of lines) short.push(\`\${l.itemId} short\`);
  return { ok: false, reason: \`could not allocate: \${short.join(', ')}\` };
}

function shape7(err: Error) {
  throw new Error(\`x: \${err.message}\`);
}
`;

const SEVEN_SHAPES_FIXTURE = SHAPES_1_TO_5 + SHAPES_6_AND_7;

const ID_FREE_FIXTURE = `
function ok(amount: number, name: string, status: string) {
  throw new Error(\`amount \${amount} for \${name} is \${status}\`);
}
`;

/**
 * The OLD S3 regex (`packages/db/tests/t343-repo-refusal-census.test.ts`'s `findIdShapedThrows`),
 * copied here rather than imported — the point is what THAT SHAPE of regex could match, as a fixed
 * artefact for comparison, independent of whatever that file becomes as later S5 groups land.
 */
const OLD_ID_PATTERN = /\$\{(?:[\w]*\.)?(?:id|orgId|[a-zA-Z]*Id)\}/;
const OLD_THROW_RE = /throw new Error\(\s*`([^`]*(?:\n[^`]*){0,3}?)`\s*,?\s*\)/g;
function oldRegexIdHits(src: string): number {
  let count = 0;
  for (const m of src.matchAll(OLD_THROW_RE)) {
    if (OLD_ID_PATTERN.test(m[1]!)) count++;
  }
  return count;
}

describe('W1 — the widened scanner classifies all 7 R1.3 shapes correctly (5 id + 2 derived)', () => {
  it('finds exactly 7 non-plain hits: 5 id, 2 derived', () => {
    const hits = assertFinds(
      (src) => censusFixture(src, { includeReasonProps: true }).filter((s) => s.kind !== 'plain'),
      SEVEN_SHAPES_FIXTURE,
      7,
    );
    expect(hits.filter((h) => h.kind === 'id')).toHaveLength(5);
    expect(hits.filter((h) => h.kind === 'derived')).toHaveLength(2);
  });

  it('the two derived hits are shape 6 (short.join) and shape 7 (err.message), at the right lines', () => {
    const derived = censusFixture(SEVEN_SHAPES_FIXTURE, { includeReasonProps: true }).filter((s) => s.kind === 'derived');
    expect(derived).toHaveLength(2);
    const byCallee = new Map(derived.map((h) => [h.callee, h]));
    expect(byCallee.get('reason')?.text).toContain("short.join(', ')");
    expect(byCallee.get('Error')?.text).toContain('err.message');
    // Shape 6's `reason:` sits on the last non-blank line of SHAPES_1_TO_5 + 4; shape 7's throw
    // is the last line of the fixture — both inside their own function, so distinct lines.
    expect(byCallee.get('reason')!.line).not.toBe(byCallee.get('Error')!.line);
  });

  it('gap evidence: the OLD S3 regex finds only 2 of shapes 1-5 id-shaped — concatenation (3, 4) and nesting (5) are its blind spots', () => {
    expect(oldRegexIdHits(SHAPES_1_TO_5)).toBe(2);
  });
});

describe('W2 — an id-free fixture yields 0 hits, and assertFinds cannot be fooled by an empty scanner', () => {
  it('a plain amount/name/status template yields 0 non-plain hits', () => {
    const hits = censusFixture(ID_FREE_FIXTURE).filter((s) => s.kind !== 'plain');
    expect(hits).toHaveLength(0);
  });

  it('⛔ assertFinds(() => [], fixture, 5) fails — a scanner that matches nothing must fail (DEF-179)', () => {
    expect(() => assertFinds(() => [], ID_FREE_FIXTURE, 5)).toThrow('assertFinds: expected 5 hit(s), found 0');
  });
});

describe('W3 — the real packages/db/src/repo tree: the (converted) ap.ts sites, plus the two shapes the old regex could not see', () => {
  const REPO_DIR = resolve(repoRoot, 'packages', 'db', 'src', 'repo');

  // T-343 S5.2 (builder, landed): the 3 sites this test used to find as RAW id-shaped throws
  // (`:431,437,443`) are now `refuse(raw, sentence)` calls — `capacityOf` names the invoice/supplier
  // in the sentence instead. Rewritten so this test still proves the scanner VISITS and correctly
  // classifies real, current evidence (3 non-empty `refuse(` hits with distinctive text) rather than
  // weakening into "0 id-shaped hits", which would also pass if the scanner had simply gone blind
  // (the DEF-179 shape `assertFinds` exists to catch elsewhere in this file).
  it('the 3 former id-shaped sites are now refuse( calls, classified plain — the scanner still visits and reads them', () => {
    const all = censusTree(REPO_DIR).filter((s) => s.file.endsWith('/ap.ts'));
    const refuseSites = all.filter((s) => s.callee === 'refuse');
    expect(refuseSites).toHaveLength(3);
    expect(refuseSites.every((s) => s.kind === 'plain')).toBe(true);
    expect(refuseSites.some((s) => s.text.includes('voided'))).toBe(true);
    expect(refuseSites.some((s) => s.text.includes("hasn't been verified"))).toBe(true);
    expect(refuseSites.some((s) => s.text.includes("doesn't fit"))).toBe(true);
    // No raw id-shaped throw remains anywhere in ap.ts.
    expect(all.filter((s) => s.kind !== 'plain')).toEqual([]);
  });

  it('visits (does not skip) the remittance.ts nested-template throw and the attendance-punches.ts concatenated throw', () => {
    const all = censusTree(REPO_DIR);
    const remittance = all.find((s) => s.file.endsWith('/remittance.ts') && s.text.includes('accepts no party on its own lines'));
    const attendance = all.find((s) => s.file.endsWith('/attendance-punches.ts') && s.text.includes('conflicted on insert but is not readable'));
    expect(remittance).toBeDefined();
    expect(attendance).toBeDefined();
  });
});

describe('W-local-const — a bare identifier bound one hop away to a derived/id shape is not "plain" (/code-review, S5.1, 2026-09-26)', () => {
  // The shape `expenses/categories.ts:143-144`'s rewrap had at review time: `refuse`'s 2nd arg is
  // a conditional whose false branch is a bare identifier (`raw`), itself a local `const` bound to
  // a template that reads `err.message` a couple of lines earlier — the id-shaped risk is real even
  // though no ID_NAME_RE/KEY_NAME_RE name, `.message`, `.join(...)` or `String(...)` appears
  // directly in the argument expression the AST hands the classifier.
  const LOCAL_CONST_FIXTURE = `
function rewrap(err: unknown) {
  const raw = \`setCategoryAccount: \${err instanceof Error ? err.message : String(err)}\`;
  throw refuse('other raw', err instanceof RefusalError ? err.userMessage : raw);
}
`;

  it('refuse\'s 2nd arg resolves the local const one hop and classifies derived', () => {
    const hits = censusFixture(LOCAL_CONST_FIXTURE).filter((s) => s.callee === 'refuse');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.kind).toBe('derived');
  });

  it('stops at ONE hop — a const bound only to another const\'s bare name is not chased further', () => {
    const TWO_HOP_FIXTURE = `
function f(err: { id: string }) {
  const a = err.id;
  const b = a;
  throw new Error(b);
}
`;
    // \`b\`'s own initializer is the bare identifier \`a\` — one hop from \`b\` resolves to \`a\`
    // itself (an Identifier node), which the one-hop call classifies WITHOUT chasing further:
    // \`a\`'s own name doesn't match ID_NAME_RE, so this stays plain. Documents the bound,
    // not a defect — an unbounded constant-folder was explicitly rejected (see the header).
    const hits = censusFixture(TWO_HOP_FIXTURE);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.kind).toBe('plain');
  });
});

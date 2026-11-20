import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * T-598 S9 / DEF-402 and DEF-403 - the production-caller census's probe and its JSX handling, run against a planted two-file tree.
 * (The floors fail on a tree this small and the process exits 1; `--probe` still prints the symbol's detail, which is what is read here.)
 *   - DEF-402 MUTANT: the scan root is `args.find(a => !a.startsWith('--'))` again -> `--probe Card <dir>` scans a directory named "Card" and prints MISSING.
 *   - DEF-403 MUTANT: drop the `isJsx` pass in stripNonCode -> the word in JSX text counts as a caller (prodOtherN 1 for `Press`).
 */
const script = resolve(__dirname, '../../scripts/production-caller-census.mjs');

function probe(symbol: string, files: Record<string, string>): { name: string; prodOtherN?: number; verdict?: string; MISSING?: boolean } {
  const dir = mkdtempSync(join(tmpdir(), 't598-census-'));
  try {
    mkdirSync(join(dir, 'src'));
    for (const [rel, text] of Object.entries(files)) writeFileSync(join(dir, 'src', rel), text);
    const r = spawnSync(process.execPath, [script, '--probe', symbol, dir], { encoding: 'utf8' });
    return JSON.parse(r.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('production-caller-census --probe', () => {
  it('DEF-402: the symbol after --probe is not taken as the scan root', () => {
    const out = probe('Card', { 'card.tsx': 'export function Card() { return null; }\n' });
    expect(out.MISSING, 'the probe scanned a directory named after the symbol').toBeUndefined();
    expect(out.name).toBe('Card');
  });

  it('DEF-403: a word in JSX text is not a call site; a real <Press /> usage and a call are', () => {
    const decl = { 'press.tsx': 'export function Press() { return null; }\n' };
    const prose = probe('Press', { ...decl, 'page.tsx': 'export const Page = () => <p>please Press the button to continue</p>;\n' });
    expect(prose.prodOtherN, 'prose counted as a caller').toBe(0);
    const usage = probe('Press', { ...decl, 'page.tsx': 'import { Press } from "./press";\nexport const Page = () => <div><Press /></div>;\n' });
    expect(usage.prodOtherN, 'a real JSX usage must still count').toBeGreaterThanOrEqual(1);
    const call = probe('Press', { ...decl, 'page.tsx': 'import { Press } from "./press";\nexport const Page = () => <p>{Press()}</p>;\n' });
    expect(call.prodOtherN, 'a call inside braces must still count').toBeGreaterThanOrEqual(1);
  });
});

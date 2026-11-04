/**
 * T-511 S3 (G) - source-scan guards on `packages/domain/src/settlement-intake/`, and the wiring that is not a behaviour.
 *
 * The readers are PURE: no raw `throw new Error` (T-343 ratchet), no money comparison through `Number(...)`, no database
 * transaction, nothing written to disk, one CSV parser (`@shareat/core/csv`), zip from a Buffer only. Comments are blanked before
 * scanning so prose that explains a rule does not trip it.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const DOMAIN = resolve(__dirname, '..', '..');
const DIR = join(DOMAIN, 'src', 'settlement-intake');
const FILES = ['refusal.ts', 'safe-zip.ts', 'grab-transactions.ts', 'grab-transfers.ts', 'grab-payouts.ts', 'foodpanda-workbook.ts', 'deduction-mapping.ts', 'index.ts'];

function blankComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`\\])\/\/.*$/gm, (_m, p1: string) => p1);
}

const sources = (): Map<string, string> => {
  const out = new Map<string, string>();
  for (const f of readdirSync(DIR)) if ((f.endsWith('.ts') || f.endsWith('.mjs')) && !f.endsWith('.test.ts')) out.set(f, blankComments(readFileSync(join(DIR, f), 'utf8')));
  return out;
};

describe('the settlement-intake folder', () => {
  it('has the eight files of the spec', () => {
    expect(existsSync(DIR)).toBe(true);
    const have = readdirSync(DIR).filter((f) => f.endsWith('.ts'));
    for (const f of FILES) expect(have, f).toContain(f);
  });

  it('has no raw `throw new Error` (the T-343 ratchet ceiling for this folder is 0)', () => {
    for (const [f, src] of sources()) expect(src, f).not.toMatch(/throw new Error\(/);
  });

  it('has no `Number(x) <op> 0` money comparison (the money-positivity guard)', () => {
    for (const [f, src] of sources()) expect(src, f).not.toMatch(/\bNumber\([^()]*\)\s*(?:<=|>=|<|>|===|!==|==|!=)\s*0\b/);
  });

  it('opens no database transaction and imports none', () => {
    for (const [f, src] of sources()) {
      expect(src, f).not.toMatch(/(?<![.\w$])transaction\(/);
      expect(src, f).not.toMatch(/import[^;]*\btransaction\b[^;]*from\s*['"]@shareat\/db/);
    }
  });

  it('writes nothing to disk and reads no path: no write call, no temp dir, no yauzl open/fromFd, zip from a Buffer only', () => {
    for (const [f, src] of sources()) {
      expect(src, f).not.toMatch(/\b(writeFile|writeFileSync|createWriteStream|appendFile|appendFileSync|mkdtemp|mkdtempSync|copyFile|rename)\b/);
      expect(src, f).not.toMatch(/\byauzl\.(open|fromFd|fromRandomAccessReader)\b/);
      expect(src, f).not.toMatch(/\bfrom\s*['"](node:)?fs(\/promises)?['"]/);
    }
    expect(sources().get('safe-zip.ts')).toMatch(/\bfromBuffer\b/);
  });

  it('the Grab readers use the one CSV parser, @shareat/core/csv, and do not split on commas themselves', () => {
    const all = sources();
    for (const f of ['grab-transactions.ts', 'grab-transfers.ts']) {
      const src = all.get(f) as string;
      expect(src, f).toMatch(/from\s*['"]@shareat\/core\/csv['"]/);
      expect(src, f).toMatch(/\bparseCsv\b/);
      expect(src, f).not.toMatch(/\.split\(\s*['"],['"]\s*\)/);
    }
    for (const [f, src] of all) expect(src, f).not.toMatch(/function\s+parseCsv\b/);
  });

  it('refusal.ts defines SettlementIntakeRefusal on top of the shared refusal (refuse(...)), never a bare RefusalError', () => {
    const src = sources().get('refusal.ts') as string;
    expect(src).toMatch(/class\s+SettlementIntakeRefusal\s+extends\s+RefusalError/);
    expect(src).toMatch(/\brefuse\(/);
  });

  it('the barrel carries READER_VERSION = settlement-intake-reader/1', async () => {
    const { READER_VERSION } = await import('../../src/settlement-intake');
    expect(READER_VERSION).toBe('settlement-intake-reader/1');
    expect(sources().get('version.ts')).toMatch(/READER_VERSION\s*=\s*['"]settlement-intake-reader\/1['"]/);
    expect(sources().get('index.ts')).toMatch(/export\s*\{\s*READER_VERSION\s*\}\s*from\s*['"]\.\/version['"]/);
    for (const f of ['grab-transactions.ts', 'grab-transfers.ts', 'foodpanda-workbook.ts']) expect(sources().get(f), f).not.toMatch(/from\s*['"]\.\/index['"]/);
  });
});

describe('the worker containment', () => {
  it('only the worker file imports read-excel-file; the host starts it with a memory limit and a timer', () => {
    const all = sources();
    for (const [f, src] of all) {
      if (f.endsWith('.ts')) expect(src, f).not.toMatch(/read-excel-file/);
    }
    expect(all.get('xlsx-worker.mjs')).toMatch(/read-excel-file\/node/);
    const host = all.get('xlsx-worker-host.ts') as string;
    expect(host).toMatch(/maxOldGenerationSizeMb:\s*128/);
    expect(host).toMatch(/maxYoungGenerationSizeMb:\s*32/);
    expect(host).toMatch(/stackSizeMb:\s*4/);
    expect(host).toMatch(/\bterminate\(/);
    expect(host).toMatch(/new Worker\(/);
  });

  it('the saxen scan is gone', () => {
    expect(existsSync(join(DIR, 'xlsx-sheet-scan.ts'))).toBe(false);
    expect(existsSync(join(DIR, 'saxen.d.ts'))).toBe(false);
  });
});

describe('wiring', () => {
  it('packages/domain/src/index.ts re-exports the folder with a T-511 S3 comment', () => {
    const src = readFileSync(join(DOMAIN, 'src', 'index.ts'), 'utf8');
    expect(src).toMatch(/export \* from '\.\/settlement-intake';/);
    expect(src).toMatch(/T-511 S3/);
  });

  it('the dependencies are exact pins (no ^ or ~): yauzl 3.4.0, read-excel-file 9.3.14, @types/yauzl 3.4.0 as a dev dependency', () => {
    const pkg = JSON.parse(readFileSync(join(DOMAIN, 'package.json'), 'utf8')) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    expect(pkg.dependencies.yauzl).toBe('3.4.0');
    expect(pkg.dependencies['read-excel-file']).toBe('9.3.14');
  expect(pkg.dependencies.saxen).toBeUndefined();
  expect(pkg.devDependencies['read-excel-file']).toBeUndefined();
    expect(pkg.devDependencies['@types/yauzl']).toBe('3.4.0');
  });

  it('the fixtures are byte-preserved by .gitattributes (-text), and the README travels with them', () => {
    const root = resolve(DOMAIN, '..', '..');
    expect(readFileSync(join(root, '.gitattributes'), 'utf8')).toContain('packages/domain/tests/fixtures/settlement-intake/** -text');
    expect(readFileSync(join(root, '.gitattributes'), 'utf8')).toContain('*.sql text eol=lf');
    const dir = join(DOMAIN, 'tests', 'fixtures', 'settlement-intake');
    expect(readdirSync(dir)).toHaveLength(33);
    expect(existsSync(join(dir, 'README.md'))).toBe(true);
  });
});

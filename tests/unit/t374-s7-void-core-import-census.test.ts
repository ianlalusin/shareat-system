import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * T-374 S7 (audit 3): `voidPullUsageRecord` has no `authorize` and no actor. It must stay reachable only from
 * `pos/usage-pull.ts` (voidPosUsagePull, which authorizes once on the pull's store) and `stock/usage-records.ts`
 * (voidUsage, which authorizes and applies R10), and never through the `@shareat/domain` barrel.
 */
const repoRoot = path.resolve(__dirname, '../..');
const ALLOWED = new Set(['packages/domain/src/pos/usage-pull.ts', 'packages/domain/src/stock/usage-records.ts', 'packages/domain/src/stock/void-pull-usage-record.ts']);

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name === '.next') return [];
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}
const code = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => (l.indexOf('//') === -1 ? l : l.slice(0, l.indexOf('//'))))
    .join('\n');

describe('voidPullUsageRecord import census', () => {
  const files = ['apps', 'packages'].flatMap((d) => walk(path.join(repoRoot, d)).filter((f) => !/[\\/]tests?[\\/]/.test(f)));
  const mentioning = files
    .filter((f) => /voidPullUsageRecord/.test(code(readFileSync(f, 'utf8'))))
    .map((f) => path.relative(repoRoot, f).split(path.sep).join('/'));

  it('scanned real files', () => {
    expect(files.length).toBeGreaterThan(100);
  });
  it('only the three allowed modules mention it, and both importers are among them', () => {
    expect(mentioning.sort()).toEqual([...ALLOWED].sort());
  });
  it('the domain barrel does not export it', () => {
    const barrel = code(readFileSync(path.join(repoRoot, 'packages/domain/src/index.ts'), 'utf8'));
    expect(barrel).not.toMatch(/void-pull-usage-record/);
    expect(readFileSync(path.join(repoRoot, 'packages/domain/src/stock/usage-records.ts'), 'utf8')).not.toMatch(/export \{[^}]*voidPullUsageRecord/);
  });
});

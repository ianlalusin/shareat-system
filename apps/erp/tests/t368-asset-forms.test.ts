/**
 * T-368 S3 (DEF-436, DEF-442) W2 — source pins for the two web seams of S3 (`docs/tasks/368-periods-depreciation.md` §S3).
 *
 *   - `fixed-assets/new/page.tsx` draws its store list from `listActiveStores` (a deactivated store is not offered), while the
 *     register and the `[id]` page keep `listStores` (they must still NAME assets at inactive stores).
 *   - `updateTermsAction` calls the domain's `updateAssetTerms` and nothing else: no inline `authorize`, no
 *     `fixedAssetsRepo.updateTerms`, no inline life parse.
 *
 * Comments stripped. Red until the builder lands S3's web half.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, '..', 'src', 'app');
const code = (rel: string) =>
  readFileSync(resolve(app, rel), 'utf8')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

/** The body of one exported function, brace-matched from its signature. */
function bodyOf(src: string, name: string): string {
  const at = src.indexOf(`function ${name}`);
  if (at < 0) throw new Error(`${name} not found`);
  const open = src.indexOf('{', src.indexOf(')', at));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error(`${name} body not closed`);
}

describe('W2 — S3 web seams', () => {
  it('fixed-assets/lib.ts exports listActiveStores; new/page.tsx uses it and not listStores', () => {
    expect(code('fixed-assets/lib.ts')).toMatch(/export\s+(async\s+)?function\s+listActiveStores|export\s*\{[^}]*listActiveStores/);
    const page = code('fixed-assets/new/page.tsx');
    expect(page, 'the new-asset form does not use listActiveStores').toMatch(/listActiveStores/);
    expect(page, 'the new-asset form still lists every store').not.toMatch(/\blistStores\b/);
  });

  it('the register and [id] pages keep listStores (they must still name assets at inactive stores)', () => {
    for (const rel of ['fixed-assets/page.tsx', 'fixed-assets/[id]/page.tsx']) {
      const src = code(rel);
      expect(src, rel).toMatch(/\blistStores\b/);
      expect(src, rel).not.toMatch(/listActiveStores/);
    }
  });

  it('updateTermsAction calls updateAssetTerms and nothing else: no inline authorize, no repo write, no inline life parse', () => {
    const actions = code('fixed-assets/actions.ts');
    const body = bodyOf(actions, 'updateTermsAction');
    expect(body).toMatch(/updateAssetTerms/);
    expect(body, 'the action still writes through the repo').not.toMatch(/fixedAssetsRepo\.updateTerms|\.updateTerms\(/);
    expect(body, 'the action still authorizes inline').not.toMatch(/authorize/);
    expect(body, 'the life parse is still in the action').not.toMatch(/Number\.isInteger|Number\(lifeRaw\)/);
    expect(actions).toMatch(/import[^;]*updateAssetTerms[^;]*from\s+'@shareat\/domain'/);
  });
});

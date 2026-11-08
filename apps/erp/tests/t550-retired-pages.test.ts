/**
 * T-550 — the "POS usage pull" and "POS item mapping" pages are retired (bible row 452, Ian 8 Nov 2026:
 * v1 and v2 are separate backends; the v2 ERP covers only stores on POS v2). The tables, rows, domain and repo
 * code stay (`docs/tasks/550-retire-pos-usage-pull-and-item-mapping.md`); only the screens go.
 *
 * This guard stops a screen, a link, a redirect or a nav entry for either path from coming back by accident.
 * Bringing one back is a decision for Ian, and it starts by deleting this file in the same commit.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const srcRoot = path.resolve(__dirname, '../src');
const RETIRED_PATHS = ['/inventory/pos-usage', '/inventory/pos-map'];
const RETIRED_FOLDERS = ['app/inventory/pos-usage', 'app/inventory/pos-map'];
const RETIRED_NAV_LABELS = ['POS usage pull', 'POS item mapping'];

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
  );
}

describe('T-550 (row 452) - the retired POS usage pull and item mapping pages stay gone', () => {
  it('no file under apps/erp/src mentions either retired path', () => {
    const hits = walk(srcRoot)
      .filter((f) => /\.(tsx?|mdx?|json)$/.test(f))
      .flatMap((f) => {
        const src = readFileSync(f, 'utf8');
        return RETIRED_PATHS.filter((p) => src.includes(p)).map((p) => `${path.relative(srcRoot, f)} -> ${p}`);
      });
    expect(hits).toEqual([]);
  });

  it('the two page folders do not exist', () => {
    for (const folder of RETIRED_FOLDERS) expect(existsSync(path.join(srcRoot, folder)), folder).toBe(false);
  });

  it('the nav has no entry for either page', () => {
    const nav = readFileSync(path.join(srcRoot, 'components/nav.tsx'), 'utf8');
    for (const label of RETIRED_NAV_LABELS) expect(nav.includes(label), label).toBe(false);
  });
});

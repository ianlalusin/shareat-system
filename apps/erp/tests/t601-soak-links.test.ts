/**
 * T-601 - every "Fix this" link the soak checklist and the pre-flight give must open a real page. Four soak links and one pre-flight warning
 * pointed at `/menu/items`, which has no list page (it shows "Page not found"). The links are collected by running the pure evaluators on a
 * store where EVERYTHING is wrong, so a link added later is covered without anyone remembering to list it here.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluatePreflight, evaluateSoakChecks, type PreflightFacts, type SoakExtra } from '@shareat/domain';

const APP_DIR = join(__dirname, '..', 'src', 'app');
const STORE = '00000000-0000-4000-8000-000000000001';

const ALL_WRONG: PreflightFacts = {
  storeId: STORE,
  hasPosStoreRow: false,
  activeStands: 0,
  hasCashTender: false,
  tendersWithoutAlias: 1,
  v1Linked: true,
  bridgeDateAllowed: true,
  tillsWithLivePairing: 0,
  rulesNotSeeded: ['VAT included in prices (%)'],
  recordSalePeople: 0,
  managersWithPin: 0,
  keyFileConfigured: false,
  itemsWithoutStation: ['Pork belly'],
  packagesWithoutRefills: ['Unli Grill'],
  staffWithoutPin: 1,
  activePresets: 0,
};
const NOTHING_SET_UP: SoakExtra = {
  storeId: STORE,
  menu: { stations: [], items: [] },
  mode: 'off',
  terminalLinked: false,
  approvers: new Set<string>(),
  sellers: [],
  pinRuleOn: false,
  tenders: [],
  identity: { businessName: '', tin: null, addressLines: [] },
};

/** Does `/a/b/c` resolve to a `page.tsx` under the app folder? A segment matches a folder of that name, a `[param]` folder, or passes through a `(group)` folder. */
function hasPage(dir: string, segments: string[]): boolean {
  if (segments.length === 0) return existsSync(join(dir, 'page.tsx'));
  const [head, ...rest] = segments;
  const entries = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
  for (const e of entries) {
    const matches = e.name === head || /^\[[^.\]]+\]$/.test(e.name);
    if (matches && hasPage(join(dir, e.name), rest)) return true;
    if (/^\(.+\)$/.test(e.name) && hasPage(join(dir, e.name), segments)) return true;
  }
  return false;
}
const resolves = (href: string): boolean => hasPage(APP_DIR, href.split('?')[0]!.split('/').filter(Boolean));

const pre = evaluatePreflight(ALL_WRONG);
const soak = evaluateSoakChecks(pre, NOTHING_SET_UP);
const links = [
  ...pre.blocking.map((i) => ({ from: `pre-flight blocking ${i.code}`, href: i.href })),
  ...pre.warnings.map((i) => ({ from: `pre-flight warning ${i.code}`, href: i.href })),
  ...soak.map((c) => ({ from: `soak check ${c.code}`, href: c.href })),
].filter((l): l is { from: string; href: string } => l.href !== null);

describe('T-601 - the Fix this links point at real pages', () => {
  it('the all-wrong store really fires every pre-flight item and fails every soak check (so the links below are the whole set)', () => {
    expect(pre.blocking).toHaveLength(9);
    expect(pre.warnings).toHaveLength(4);
    expect(soak.filter((c) => !c.ok)).toHaveLength(soak.length);
    expect(soak).toHaveLength(15);
  });

  it('every link target resolves to a page.tsx under apps/erp/src/app', () => {
    const dead = links.filter((l) => !resolves(l.href)).map((l) => `${l.from} -> ${l.href}`);
    expect(dead).toEqual([]);
  });

  it('the resolver itself rejects a path with no page (the dead /menu/items) and accepts the real ones', () => {
    expect(resolves('/menu/items')).toBe(false);
    for (const ok of ['/menu', '/menu/hours', '/kitchen?store=abc', `/admin/stores/${STORE}`]) expect(resolves(ok), ok).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * T-401 S2, I16: THE LIVE v1 FEED IS UNTOUCHED. docs/tasks/401-erp-menu-catalog-master.md, banner after the header, R7 and section 4 I16.
 * POS v1 keeps selling through 1 Jan 2027: pos_item_maps stays the usage pull's only authority; the menu has no production reader until P1.
 * A static guard, both directions, and a vacuity guard so a moved directory cannot turn it green by scanning nothing.
 *
 *   (1) nothing under the v1 feed (packages/domain/src/pos/**, sales-days/**, the repos that feed them, packages/db/src/pos-v1/**)
 *       imports or names the menu module, repo or tables;
 *   (2) nothing under the menu domain (packages/domain/src/menu/**) or packages/db/src/repo/menu.ts imports or names a v1-feed module or table
 *       (the domain never writes pos_item_maps, the day feeds, tenders, the usage pull or the sales-day tables - and never reads them: no join, R7);
 *   (3) migration 0196 has no non-comment SQL touching a v1-feed table.
 *
 * Mutant killed: a builder "helpfully" reads menu_depletion_rules in plan.ts (1), or has setDepletionRule write pos_item_maps (2).
 * Red today for (2) and its vacuity guard: packages/domain/src/menu and packages/db/src/repo/menu.ts do not exist yet.
 */
const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name === 'dist') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...files(full));
    else if (/\.(ts|tsx|mts|sql)$/.test(name)) out.push(full);
  }
  return out;
}
const rel = (f: string) => relative(root, f).replace(/\\/g, '/');
const read = (f: string) => readFileSync(f, 'utf8');
/** Comments cannot call anything; strip them so prose ("nothing here reads pos_item_maps") is not a violation. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/^\s*--.*$/gm, '');

const V1_FEED_DIRS = [
  'packages/domain/src/pos',
  'packages/domain/src/sales-days',
  'packages/db/src/pos-v1',
];
const V1_FEED_FILES = [
  'packages/db/src/repo/pos-mapping.ts',
  'packages/db/src/repo/pos-v1.ts',
  'packages/db/src/repo/sales-days.ts',
  'packages/db/src/repo/stock-usage.ts',
];

/** Names that mean "the menu": the domain module, the repo, the schema file, the tables, the Drizzle exports. */
const MENU_NAMES = new RegExp(
  [
    String.raw`from\s+['"][^'"]*\bmenu(?:/[^'"]*)?['"]`, // ../menu, ../../menu/offers
    String.raw`['"][^'"]*schema/menu['"]`,
    String.raw`['"][^'"]*repo/menu['"]`,
    String.raw`\bmenuRepo\b`,
    String.raw`\bmenu_(?:categories|items|item_variants|option_groups|option_values|option_group_links|package_refills|depletion_rules|offers|option_offers)\b`,
    String.raw`\bmenu(?:Categories|Items|ItemVariants|OptionGroups|OptionValues|OptionGroupLinks|PackageRefills|DepletionRules|Offers|OptionOffers)\b`,
    String.raw`\b(?:setMenuOffer|setDepletionRule|projectStoreMenu|offersInForce|menuSnapshot)\b`,
  ].join('|'),
);

/** Names that mean "the live v1 feed". */
const V1_FEED_NAMES = new RegExp(
  [
    String.raw`from\s+['"][^'"]*(?:/pos|/pos/[^'"]*|/sales-days|/sales-days/[^'"]*|repo/pos-mapping|repo/pos-v1|repo/sales-days|repo/stock-usage|pos-v1/[^'"]*)['"]`,
    String.raw`\bpos_item_maps\b|\bposItemMaps\b|\bpos_map_requests\b|\bposMapRequests\b|\bpos_v1_[a-z_]+\b|\bposV1[A-Za-z]*\b`,
    String.raw`\bpos_usage_pulls?[a-z_]*\b|\bposUsagePulls?[A-Za-z]*\b|\btenders\b`,
    String.raw`\bsales_days\b|\bsalesDays\b|\bchannel_sales\b`,
    String.raw`\b(?:upsertPosItemMap|explodePosSales|requestMap|decideMapRequest)\b`,
  ].join('|'),
);

const feedFiles = [...V1_FEED_DIRS.flatMap((d) => files(join(root, d))), ...V1_FEED_FILES.map((f) => join(root, f)).filter(existsSync)];
const menuFiles = [...files(join(root, 'packages/domain/src/menu')), ...['packages/db/src/repo/menu.ts'].map((f) => join(root, f)).filter(existsSync)];

describe('T-401 I16 -- the live v1 feed is untouched', () => {
  it('vacuity: the v1 feed side really is scanned (a renamed directory must not make this green)', () => {
    expect(feedFiles.length, 'scanned v1 feed files').toBeGreaterThan(20);
    expect(feedFiles.map(rel)).toEqual(expect.arrayContaining(['packages/domain/src/pos/plan.ts', 'packages/db/src/repo/pos-mapping.ts']));
    expect(feedFiles.some((f) => rel(f).startsWith('packages/domain/src/sales-days/'))).toBe(true);
  });

  it('(1) no v1 feed file imports or names the menu (mutant: plan.ts reads menu_depletion_rules)', () => {
    const hits = feedFiles.filter((f) => MENU_NAMES.test(code(read(f)))).map(rel);
    expect(hits, 'v1 feed files that reach the menu').toEqual([]);
  });

  it('vacuity: the menu side exists and is scanned (red until S2 writes packages/domain/src/menu and packages/db/src/repo/menu.ts)', () => {
    expect(files(join(root, 'packages/domain/src/menu')).length, 'files under packages/domain/src/menu').toBeGreaterThan(0);
    expect(existsSync(join(root, 'packages/db/src/repo/menu.ts')), 'packages/db/src/repo/menu.ts').toBe(true);
  });

  it('(2) no menu file imports or names a v1-feed module or table: never written, never read, never joined (R7)', () => {
    const hits = menuFiles
      .map((f) => ({ f: rel(f), m: V1_FEED_NAMES.exec(code(read(f))) }))
      .filter((x) => x.m)
      .map((x) => `${x.f}: ${x.m![0]}`);
    expect(hits, 'menu files that reach the v1 feed').toEqual([]);
  });

  it('(3) migration 0196 has no executable SQL touching a v1-feed table', () => {
    const dir = join(root, 'packages/db/migrations');
    const mig = readdirSync(dir).find((n) => /^0196_.*\.sql$/.test(n));
    expect(mig, 'migration 0196').toBeDefined();
    const sqlText = code(read(join(dir, mig!)));
    const m = /\bpos_item_maps\b|\bpos_map_requests\b|\bpos_v1_[a-z_]+\b|\bpos_usage_pulls?[a-z_]*\b|\btenders\b|\bsales_days\b|\bchannel_sales\b/.exec(sqlText);
    expect(m?.[0], 'a v1 feed table named in executable SQL').toBeUndefined();
  });

  it('the detectors themselves bite (so a green (1)/(2) means something)', () => {
    expect(MENU_NAMES.test(code("import { x } from '../menu/offers';"))).toBe(true);
    expect(MENU_NAMES.test(code('select * from menu_depletion_rules'))).toBe(true);
    expect(MENU_NAMES.test(code('// menu_offers is prose\nconst a = 1;'))).toBe(false);
    expect(V1_FEED_NAMES.test(code('insert into pos_item_maps'))).toBe(true);
    expect(V1_FEED_NAMES.test(code("import { plan } from '../pos/plan';"))).toBe(true);
    expect(V1_FEED_NAMES.test(code('-- pos_item_maps in a comment\nselect 1'))).toBe(false);
  });
});

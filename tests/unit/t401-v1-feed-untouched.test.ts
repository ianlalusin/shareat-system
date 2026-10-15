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
    String.raw`\bmenu_(?:categories|items|item_variants|option_groups|option_values|option_group_links|package_refills|depletion_rules|offers|option_offers|pos_v1_links|usage_source_switches)\b`,
    String.raw`\bmenu(?:Categories|Items|ItemVariants|OptionGroups|OptionValues|OptionGroupLinks|PackageRefills|DepletionRules|Offers|OptionOffers|PosV1Links|UsageSourceSwitches)\b`,
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

const V1_TABLE = String.raw`"?(?:pos_item_maps|pos_map_requests|pos_v1_[a-z_]+|pos_usage_pulls?[a-z_]*|tenders|sales_days|channel_sales)"?\b`;
const V1_WRITE_OR_DDL = new RegExp(
  [
    String.raw`\binsert\s+into\s+(?:only\s+)?(?:public\.)?${V1_TABLE}`,
    String.raw`\bupdate\s+(?:only\s+)?(?:public\.)?${V1_TABLE}`,
    String.raw`\bdelete\s+from\s+(?:only\s+)?(?:public\.)?${V1_TABLE}`,
    String.raw`\btruncate\s+(?:table\s+)?(?:only\s+)?(?:public\.)?${V1_TABLE}`,
    String.raw`\balter\s+(?:table|index|policy)\s+(?:if\s+exists\s+)?(?:only\s+)?(?:public\.)?${V1_TABLE}`,
    String.raw`\bdrop\s+(?:table|trigger|index|policy|rule)\b[^;]*?${V1_TABLE}`,
    String.raw`\bcreate\s+(?:unique\s+)?(?:or\s+replace\s+)?(?:constraint\s+)?(?:trigger|index|policy|rule)\b[^;]*?\bon\s+(?:only\s+)?(?:public\.)?${V1_TABLE}`,
    String.raw`\b(?:grant|revoke)\b[^;]*?\bon\s+(?:table\s+)?(?:public\.)?${V1_TABLE}`,
  ].join('|'),
  'i',
);
/** The first write or DDL statement on a v1 feed table in (comment-stripped) SQL, or undefined. Reads (FROM/JOIN) pass. */
function v1FeedWriteOrDdl(sqlText: string): string | undefined {
  return V1_WRITE_OR_DDL.exec(sqlText)?.[0];
}

/**
 * T-401 S5 (Ian's Q3, I16): the ONE seam through which a switched store's usage pull reads menu depletion rules. It is the single
 * file under the v1 feed directories that may name the menu. Nothing else is allowed; plan.ts and usage-pull.ts stay menu-free.
 */
const FEED_FILES_ALLOWED_TO_NAME_MENU: readonly string[] = ['packages/domain/src/pos/depletion-source.ts'];

/** S5 ruling 2: guard (2) allows exactly ONE import specifier from menu/** into the v1 feed: the seam. Every other ../pos/* import still fails. */
const SEAM_IMPORT = /from\s+['"]\.\.\/pos\/depletion-source['"]/g;
const withoutSeamImport = (src: string): string => src.replace(SEAM_IMPORT, '');

const feedFiles = [...V1_FEED_DIRS.flatMap((d) => files(join(root, d))), ...V1_FEED_FILES.map((f) => join(root, f)).filter(existsSync)];
const menuFiles = [...files(join(root, 'packages/domain/src/menu')), ...['packages/db/src/repo/menu.ts'].map((f) => join(root, f)).filter(existsSync)];

describe('T-401 I16 -- the live v1 feed is untouched', () => {
  it('vacuity: the v1 feed side really is scanned (a renamed directory must not make this green)', () => {
    expect(feedFiles.length, 'scanned v1 feed files').toBeGreaterThan(20);
    expect(feedFiles.map(rel)).toEqual(expect.arrayContaining(['packages/domain/src/pos/plan.ts', 'packages/db/src/repo/pos-mapping.ts']));
    expect(feedFiles.some((f) => rel(f).startsWith('packages/domain/src/sales-days/'))).toBe(true);
  });

  it('(1) no v1 feed file imports or names the menu (mutant: plan.ts reads menu_depletion_rules)', () => {
    const hits = feedFiles.filter((f) => !FEED_FILES_ALLOWED_TO_NAME_MENU.includes(rel(f)) && MENU_NAMES.test(code(read(f)))).map(rel);
    expect(hits, 'v1 feed files that reach the menu').toEqual([]);
  });

  it('S5: the allow-list is exactly the one seam, the seam exists, and it is the only feed file that reaches the menu (red until S5 writes it)', () => {
    expect(FEED_FILES_ALLOWED_TO_NAME_MENU).toEqual(['packages/domain/src/pos/depletion-source.ts']);
    const seam = join(root, FEED_FILES_ALLOWED_TO_NAME_MENU[0]!);
    expect(existsSync(seam), 'packages/domain/src/pos/depletion-source.ts exists').toBe(true);
    expect(MENU_NAMES.test(code(read(seam))), 'the seam really reads the menu (an allow-list entry for a file that does not is a hole)').toBe(true);
    const others = feedFiles.filter((f) => rel(f) !== FEED_FILES_ALLOWED_TO_NAME_MENU[0] && MENU_NAMES.test(code(read(f)))).map(rel);
    expect(others, 'every other v1 feed file').toEqual([]);
  });

  it('vacuity: the menu side exists and is scanned (red until S2 writes packages/domain/src/menu and packages/db/src/repo/menu.ts)', () => {
    expect(files(join(root, 'packages/domain/src/menu')).length, 'files under packages/domain/src/menu').toBeGreaterThan(0);
    expect(existsSync(join(root, 'packages/db/src/repo/menu.ts')), 'packages/db/src/repo/menu.ts').toBe(true);
  });

  it('(2) no menu file imports or names a v1-feed module or table: never written, never read, never joined (R7)', () => {
    const hits = menuFiles
      .map((f) => ({ f: rel(f), m: V1_FEED_NAMES.exec(withoutSeamImport(code(read(f)))) }))
      .filter((x) => x.m)
      .map((x) => `${x.f}: ${x.m![0]}`);
    expect(hits, 'menu files that reach the v1 feed').toEqual([]);
  });

  it('(3) migration 0196 has no executable SQL that WRITES or ALTERS a v1-feed table (read-only references are allowed)', () => {
    const dir = join(root, 'packages/db/migrations');
    const mig = readdirSync(dir).find((n) => /^0196_.*\.sql$/.test(n));
    expect(mig, 'migration 0196').toBeDefined();
    const hit = v1FeedWriteOrDdl(code(read(join(dir, mig!))));
    expect(hit, 'a write or DDL on a v1 feed table in executable SQL').toBeUndefined();
  });

  it('(3) detector bites: writes and DDL on v1 tables are flagged; a read-only reference is not', () => {
    for (const bad of [
      "UPDATE pos_item_maps SET status = 'x' WHERE true;",
      'CREATE TRIGGER x AFTER INSERT ON pos_item_maps FOR EACH ROW EXECUTE FUNCTION f();',
      'INSERT INTO pos_map_requests (a) VALUES (1);',
      'DELETE FROM sales_days WHERE true;',
      'TRUNCATE TABLE pos_usage_pulls;',
      'ALTER TABLE "tenders" ADD COLUMN z int;',
      'DROP TABLE channel_sales;',
      'CREATE INDEX i ON sales_days (id);',
      'GRANT SELECT ON pos_item_maps TO app;',
      'REVOKE ALL ON TABLE pos_v1_batches FROM app;',
    ]) expect(v1FeedWriteOrDdl(code(bad)), bad).toBeDefined();
    for (const ok of [
      'SELECT 1 FROM pos_item_maps WHERE x = p_item;',
      'IF EXISTS (SELECT 1 FROM pos_item_maps m WHERE m.item_id = p_item) THEN RETURN true; END IF;',
      '-- UPDATE pos_item_maps SET a = 1\nSELECT 1;',
    ]) expect(v1FeedWriteOrDdl(code(ok)), ok).toBeUndefined();
  });

  it('S5: the single seam import is allowed from menu/**, every other ../pos/* import is not (no second allow-list)', () => {
    expect(V1_FEED_NAMES.test(withoutSeamImport(code("import { assertNoPlannedPullAtLinkedSwitchedStores } from '../pos/depletion-source';")))).toBe(false);
    for (const bad of ["import { x } from '../pos/plan';", "import { x } from '../pos/usage-pull';", "import { x } from '../pos/depletion-source/extra';", "import { x } from '../../pos/depletion-source';"]) {
      expect(V1_FEED_NAMES.test(withoutSeamImport(code(bad))), bad).toBe(true);
    }
  });

  it('S5: the seam writes only menu tables - no insert/update/delete/DDL on a v1 table, no v1 repo write call (red until S5 writes it)', () => {
    const seam = join(root, 'packages/domain/src/pos/depletion-source.ts');
    expect(existsSync(seam), 'packages/domain/src/pos/depletion-source.ts exists').toBe(true);
    const src = code(read(seam));
    expect(v1FeedWriteOrDdl(src), 'raw SQL write on a v1 table').toBeUndefined();
    const drizzleWrite = /\b(?:insert|update|delete)\s*\(\s*(?:posItemMaps|posMapRequests|posUsagePulls?\w*|posV1\w*|tenders|salesDays|channelSales)\b/;
    expect(drizzleWrite.exec(src)?.[0], 'drizzle write on a v1 table').toBeUndefined();
    const repoWrite = /\b(?:posMappingRepo|posV1Repo|salesDaysRepo|stockUsageRepo)\.(?:insert|upsert|replace|mark|refresh|set|void|update|delete|create|save|import)\w*/;
    expect(repoWrite.exec(src)?.[0], 'v1 repo write call').toBeUndefined();
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

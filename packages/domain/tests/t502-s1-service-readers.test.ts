/**
 * T-502 S1.1 (TESTER, red until built) - unit level (no database): the kind -> account maps and the reader census.
 *
 * 1. The kind-keyed maps must treat 'service' as "no stock account", never fall into a catch-all:
 *    - INVENTORY_ACCOUNT_BY_ITEM_KIND has no service entry (today true by omission: GUARD, green now). Every caller already
 *      refuses a kind with no account (trade/index.ts:667, commissary/transfer.ts:216, cutover/opening-stock.ts:93).
 *    - cogsCategoryForItemKind('service') must NOT answer 'food' (red now: its default branch silently files a service as food
 *      COGS). Assumed contract: it refuses (throws). Builder may instead make usage posting refuse a service line before this is
 *      reached - then replace this test with that refusal and say so.
 * 2. Census: every source file that reads items.kind is listed below; a NEW reader appears as a failing test until a human adds it
 *    and decides how it treats a service (the same pattern as t343-s5-domain-census).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

import { cogsCategoryForItemKind } from '../src/stock/usage-records';
import { INVENTORY_ACCOUNT_BY_ITEM_KIND } from '../src/stock/receipt-posting';

describe('kind-keyed maps', () => {
  it('GUARD: INVENTORY_ACCOUNT_BY_ITEM_KIND has no entry for service', () => {
    expect(Object.keys(INVENTORY_ACCOUNT_BY_ITEM_KIND)).not.toContain('service');
    expect(INVENTORY_ACCOUNT_BY_ITEM_KIND['service']).toBeUndefined();
  });

  it('cogsCategoryForItemKind does not file a service as food (assumed: throws)', () => {
    expect(() => cogsCategoryForItemKind('service')).toThrow();
  });

  it('cogsCategoryForItemKind still answers the five stocked kinds', () => {
    expect(cogsCategoryForItemKind('meat_slab')).toBe('meat');
    expect(cogsCategoryForItemKind('meat_sliced')).toBe('meat');
    expect(cogsCategoryForItemKind('retail')).toBe('retail');
    expect(cogsCategoryForItemKind('supply')).toBe('packaging');
    expect(cogsCategoryForItemKind('raw_material')).toBe('food');
  });
});

const ROOT = join(__dirname, '..', '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name === 'migrations' || name === 'tests' || name === '__tests__') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) out.push(p);
  }
  return out;
}

/** A file "reads items.kind" when it selects the column, filters on an item kind literal, or imports the kind vocabulary. */
const READS_KIND = /items\.kind|\bi\.kind\b|item\.kind|branchItem\.kind|itemKind|ITEM_KINDS|ItemKind|kind\s*(?:=|in|<>)\s*'(?:raw_material|supply|retail|meat_slab|meat_sliced)'|'meat_slab'|'meat_sliced'/;

/**
 * Every reader today (repo-relative, forward slashes) -> what a service item must do there.
 * STOCK = a stock/count/recipe/costing/inventory reader: a service must never reach it.
 * LABEL = presentation only (a kind label or filter): the service kind must render, not crash.
 * ACCOUNT = maps kind to a ledger account: a service has none and the caller must refuse.
 */
export const READERS: Readonly<Record<string, 'STOCK' | 'LABEL' | 'ACCOUNT'>> = {
  'packages/db/schema/items.ts': 'LABEL',
  'packages/db/src/index.ts': 'LABEL',
  'packages/db/src/repo/commissary-catalogue.ts': 'STOCK',
  'packages/db/src/repo/commissary.ts': 'STOCK',
  'packages/db/src/repo/count-sessions.ts': 'STOCK',
  'packages/db/src/repo/cutover.ts': 'STOCK',
  'packages/db/src/repo/deliveries.ts': 'STOCK',
  'packages/db/src/repo/findings.ts': 'STOCK',
  'packages/db/src/repo/items.ts': 'STOCK',
  'packages/db/src/repo/production.ts': 'STOCK',
  'packages/db/src/repo/stock-usage.ts': 'STOCK',
  'packages/domain/src/commissary/transfer.ts': 'ACCOUNT',
  'packages/domain/src/commissary/discrepancy.ts': 'ACCOUNT',
  'packages/domain/src/cutover/opening-stock.ts': 'ACCOUNT',
  'packages/domain/src/items/index.ts': 'LABEL',
  'packages/domain/src/stock/usage-post-core.ts': 'ACCOUNT',
  'packages/domain/src/stock/usage-records.ts': 'ACCOUNT',
  'packages/domain/src/stock/receipt-posting.ts': 'ACCOUNT',
  'packages/domain/src/trade/index.ts': 'ACCOUNT',
  'packages/etl/src/master-data/items-plan.ts': 'LABEL',
  'apps/erp/src/app/inventory/production/lib.ts': 'STOCK',
  'apps/erp/src/app/inventory/production/page.tsx': 'STOCK',
  'apps/erp/src/app/inventory/returns/page.tsx': 'STOCK',
  'apps/erp/src/app/items/actions.ts': 'LABEL',
  'apps/erp/src/app/items/family.ts': 'LABEL',
  'apps/erp/src/app/items/lib.ts': 'LABEL',
  'apps/erp/src/app/items/page.tsx': 'LABEL',
  'apps/erp/src/app/inventory/returns/actions.ts': 'STOCK',
  'apps/erp/src/app/items/[id]/page.tsx': 'LABEL',
  'packages/domain/src/cutover/tie-out.ts': 'STOCK',
  'packages/domain/src/deliveries/documents.ts': 'STOCK',
  'packages/domain/src/deliveries/receive.ts': 'ACCOUNT',
  'packages/domain/src/production/index.ts': 'STOCK',
  'packages/domain/src/production/validate.ts': 'STOCK',
  'packages/domain/src/stock/count-workflow.ts': 'STOCK',
  'packages/domain/src/stock/supplier-returns.ts': 'ACCOUNT',
  'packages/domain/src/trade/returns.ts': 'ACCOUNT',
};

describe('reader census (packages/ and apps/erp)', () => {
  it('every file that reads items.kind is in READERS (a new reader must be decided by a human)', () => {
    const found = [
      ...walk(join(ROOT, 'packages')),
      ...walk(join(ROOT, 'apps', 'erp', 'src')),
    ]
      .filter((p) => READS_KIND.test(readFileSync(p, 'utf8')))
      .map((p) => relative(ROOT, p).split(sep).join('/'))
      .sort();
    const unlisted = found.filter((f) => !(f in READERS));
    expect(unlisted, `unlisted readers: ${unlisted.join(', ')}`).toEqual([]);
  });

  it('every listed reader still exists (a deleted reader must leave the list)', () => {
    for (const f of Object.keys(READERS)) expect(() => statSync(join(ROOT, f)), f).not.toThrow();
  });
});

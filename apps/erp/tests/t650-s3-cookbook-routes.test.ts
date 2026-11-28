import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { capabilitiesForRoute } from '../src/lib/route-capability';
import { COOKBOOK_PATH, RECIPES_PATH, recipeBase } from '../src/app/inventory/production/recipes/lib';

/**
 * T-650 S3 - the Cookbook routes. Gated like the product recipes (read: record_stock_movement; new: manage_recipes), the two lists never mix, and an old link to a
 * recipe that lives in the other place still works by redirecting (a recipe's purpose decides where it lives).
 * MUTANTS (each red): the cookbook /new key removed from route-capability; the redirect dropped from either [id] page; a page that reads without requirePageAccess;
 * recipeBase returning the products path for a kitchen recipe; the sidebar link removed.
 */
const APP = path.resolve(__dirname, '../src/app/inventory');
const read = (rel: string) => readFileSync(path.join(APP, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

describe('T-650 S3 cookbook routes', () => {
  it('the paths: the cookbook is its own place; recipeBase sends each purpose to its own', () => {
    expect(COOKBOOK_PATH).toBe('/inventory/cookbook');
    expect(RECIPES_PATH).toBe('/inventory/production/recipes');
    expect(recipeBase('kitchen')).toBe(COOKBOOK_PATH);
    expect(recipeBase('product')).toBe(RECIPES_PATH);
  });

  it('capabilities: read by whoever may record a cook run, written by manage_recipes; /[id] inherits', () => {
    expect(capabilitiesForRoute(COOKBOOK_PATH)).toEqual(['record_stock_movement']);
    expect(capabilitiesForRoute(`${COOKBOOK_PATH}/0194a1b2-0000-7000-8000-000000000000`)).toEqual(['record_stock_movement']);
    expect(capabilitiesForRoute(`${COOKBOOK_PATH}/new`)).toEqual(['manage_recipes']);
  });

  it('every cookbook page gates with requirePageAccess', () => {
    for (const rel of ['cookbook/page.tsx', 'cookbook/[id]/page.tsx', 'cookbook/new/page.tsx']) {
      const src = read(rel);
      expect(src, rel).toContain('requirePageAccess(');
      expect(src, rel).not.toContain('requireSession(');
    }
  });

  it('an old recipe link still works: a kitchen recipe opened under Products we make redirects to the cookbook, and a product recipe opened in the cookbook redirects back', () => {
    expect(read('production/recipes/[id]/page.tsx')).toMatch(/recipe\.purpose === 'kitchen'\) redirect\(`\$\{COOKBOOK_PATH\}\/\$\{recipe\.id\}`\)/);
    expect(read('cookbook/[id]/page.tsx')).toMatch(/recipe\.purpose !== 'kitchen'\) redirect\(`\$\{RECIPES_PATH\}\/\$\{recipe\.id\}`\)/);
  });

  it('the sidebar links the Cookbook next to Production; the products page links to it and says what it is', () => {
    const nav = readFileSync(path.resolve(__dirname, '../src/components/nav.tsx'), 'utf8');
    expect(nav).toContain("{ href: '/inventory/cookbook', label: 'Cookbook' }");
    const products = read('production/recipes/page.tsx');
    expect(products).toContain('Products we make');
    expect(products).toContain('COOKBOOK_PATH');
  });

  it('the cook screen offers product recipes only (a cookbook recipe cannot be cooked into stock)', () => {
    expect(read('production/lib.ts')).toContain("listRecipes(tx, orgId, false, 'product')");
  });
});

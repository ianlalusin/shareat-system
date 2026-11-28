import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * T-648 (source shape, no database, no render): the /menu panel is gated on set_menu_depletion AND a count above zero, its button sits
 * in a tier="confirm" ConfirmDestructive inside a form posting the server action, and that action calls the domain function.
 * The behaviour itself is proven in packages/domain/tests/integration/t648-no-stock-packages-refills.test.ts.
 * MUTANTS: drop the capability test; drop the count test; point the form at another action; drop the domain call.
 */
const SRC = resolve(__dirname, '..', 'src', 'app', 'menu');
const page = readFileSync(resolve(SRC, 'page.tsx'), 'utf8');
const actions = readFileSync(resolve(SRC, 'actions.ts'), 'utf8');

describe('T-648 /menu no-stock panel', () => {
  it('the count is only read for a person holding set_menu_depletion', () => {
    expect(page).toMatch(/held\.has\('set_menu_depletion'\) \? await countPackageRefillVariantsNeedingNoStock\(/);
  });
  it('the panel renders only when the capability is held and the count is above zero', () => {
    expect(page).toMatch(/held\.has\('set_menu_depletion'\) && needNoStock > 0 && \(/);
  });
  it('the button is a confirm-tier ConfirmDestructive inside a form posting the batch action', () => {
    const at = page.indexOf('action={setNoStockForPackagesAndRefillsAction}');
    expect(at).toBeGreaterThan(-1);
    const panel = page.slice(at, page.indexOf('</form>', at));
    expect(panel).toMatch(/tier="confirm"/);
    expect(panel).toContain('label="Set all to Uses no stock"');
  });
  it('the server action calls the domain function', () => {
    const at = actions.indexOf('export async function setNoStockForPackagesAndRefillsAction(');
    expect(at).toBeGreaterThan(-1);
    expect(actions.slice(at)).toMatch(/setNoStockForPackagesAndRefills\(actor, tx\)/);
  });
});

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { capabilityForRoute, capabilitiesForRoute } from '../src/lib/route-capability';

/**
 * T-512 (T-511 S5c) TESTER - the screen `/settings/business-rules`. docs/tasks/512-business-rules-s5c-spec.md "Capability, audit, screen".
 * Source-shape guards (the screen's rendering is checked by a real render at 375, 1024 and 1440 by the lane, not here) plus the route gate.
 *
 * RED today: the route is not mapped and the three screen files do not exist.
 *
 * ASSUMPTIONS beyond the agreed list (builders must follow them):
 *   - the files are apps/erp/src/app/settings/business-rules/{page.tsx, actions.ts, lib.ts} (the spec writes `{page,actions,lib}`; `.tsx` for the page, `.ts` for the other two,
 *     the usage-tolerance precedent). A lib.tsx or actions.tsx is accepted too.
 *   - the form posts the field names `key`, `value`, `effectiveFrom` and `reason`, and the action reads them by those names from FormData.
 *   - the page is gated by `requirePageAccess('/settings/business-rules')`, the action by `requireActor('/settings/business-rules')`.
 */
const ROOT = join(__dirname, '..', '..', '..');
const DIR = 'apps/erp/src/app/settings/business-rules';
const find = (base: string): string | null => {
  for (const ext of ['.tsx', '.ts']) if (existsSync(join(ROOT, `${DIR}/${base}${ext}`))) return `${DIR}/${base}${ext}`;
  return null;
};
const src = (base: string): string => {
  const f = find(base);
  if (!f) throw new Error(`${DIR}/${base}.ts(x) does not exist`);
  return readFileSync(join(ROOT, f), 'utf8');
};
/** comments stripped */
const code = (base: string): string => src(base).replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/(^|[^:'"`])\/\/.*$/, '$1')).join('\n');

describe('T-512 route - /settings/business-rules is gated by manage_business_rules', () => {
  it('maps to manage_business_rules, alone (not any-of with a weaker right), and the sub-paths inherit it [kills: the route falling back to /settings (manager)]', () => {
    expect(capabilityForRoute('/settings/business-rules')).toBe('manage_business_rules');
    expect(capabilitiesForRoute('/settings/business-rules')).toEqual(['manage_business_rules']);
    expect(capabilityForRoute('/settings/business-rules/anything')).toBe('manage_business_rules');
  });

  it('the neighbours did not move: /settings stays manage_store_settings and /settings/usage-tolerance stays set_menu_depletion', () => {
    expect(capabilityForRoute('/settings')).toBe('manage_store_settings');
    expect(capabilityForRoute('/settings/usage-tolerance')).toBe('set_menu_depletion');
  });

  it('the Settings hub has a card for the screen, in plain words ("Business rules") [kills: a door nobody can find]', () => {
    const hub = readFileSync(join(ROOT, 'apps/erp/src/app/settings/page.tsx'), 'utf8');
    expect(hub).toMatch(/href="\/settings\/business-rules"/);
    expect(hub).toMatch(/title="Business rules"/);
  });
});

describe('T-512 screen - files exist and the write goes through the domain', () => {
  it('page, actions and lib exist', () => {
    expect(find('page'), 'page').not.toBeNull();
    expect(find('actions'), 'actions').not.toBeNull();
    expect(find('lib'), 'lib').not.toBeNull();
  });

  it('actions.ts: a server action file that calls setBusinessRule, with the gate on the route, the sentence of a refusal flashed, and the page revalidated [kills: a rule re-implemented in the action; a refusal swallowed]', () => {
    const a = code('actions');
    expect(a).toMatch(/['"]use server['"]/);
    expect(a).toMatch(/\bsetBusinessRule\b/);
    expect(a).toMatch(/requireActor\(\s*['"]\/settings\/business-rules['"]/);
    expect(a).toMatch(/redirectWithFlash/);
    expect(a).toMatch(/errorMessage\(/);
    expect(a).toMatch(/revalidatePath\(\s*['"]\/settings\/business-rules['"]/);
    for (const f of ['key', 'value', 'effectiveFrom', 'reason']) expect(a, `reads FormData field ${f}`).toMatch(new RegExp(`['"]${f}['"]`));
  });

  it('actions.ts re-implements no rule: no bound, no parse, no date arithmetic, no direct database import (the domain owns them) [kills: a second copy of the bounds that will drift]', () => {
    const a = code('actions');
    expect(a).not.toMatch(/\b(parseFloat|parseInt|Number)\(/);
    expect(a).not.toMatch(/\b100000\b|\b0\.01\b|new Date\(/);
    expect(a).not.toMatch(/from ['"]@shareat\/db['"]/);
  });

  it('lib.ts reads through the domain under the org principal: listBusinessRules, and no SQL of its own', () => {
    const l = code('lib');
    expect(l).toMatch(/\blistBusinessRules\b/);
    expect(l).toMatch(/withOrgPrincipal|transaction\(/);
    expect(l).not.toMatch(/\bselect\s+[\w*,\s]+\bfrom\b/i);
  });
});

describe('T-512 screen - what the page shows and how', () => {
  it('is gated by requirePageAccess on its own route, renders a refusal instead of the page, and is never cached [kills: an ungated read surface]', () => {
    const p = code('page');
    expect(p).toMatch(/requirePageAccess\(\s*['"]\/settings\/business-rules['"]\s*\)/);
    expect(p).toMatch(/if \(refusal\) return refusal/);
    expect(p).toMatch(/export const dynamic = ['"]force-dynamic['"]/);
  });

  it('uses the house pieces: EditableRecord (its own Save) for the change form, FlashBanner for the outcome [kills: a hand-rolled form]', () => {
    const p = code('page');
    expect(p).toMatch(/\bEditableRecord\b/);
    expect(p).toMatch(/\bFlashBanner\b/);
  });

  it('every table has phone card handling: no raw <table> without data-card-columns, and every shared <Table> carries a `card` prop (t411 / t450 rules) [kills: a table that clips on a phone]', () => {
    const p = code('page');
    for (const m of p.matchAll(/<table\b[^>]*>/g)) expect(m[0], 'raw <table>').toMatch(/data-card-columns=/);
    for (const m of p.matchAll(/<Table\b[^>]*>/g)) expect(m[0], 'shared <Table>').toMatch(/\bcard=/);
  });

  it('shows plain labels, never the raw key: the key is not rendered as text, the registry label is used, and the two headings Settlement and Tax exist [kills: "settlement.variance_floor_amount" on screen]', () => {
    const p = code('page') + '\n' + code('lib');
    expect(p).toMatch(/\blabel\b/);
    expect(p).toMatch(/Settlement/);
    expect(p).toMatch(/\bTax\b/);
    // a JSX text child that is a key: `>{rule.key}<` or `{item.key}` between tags
    expect(code('page')).not.toMatch(/>\s*\{[^{}]*\.key\s*\}\s*</);
    expect(code('page')).not.toMatch(/\{`[^`]*\$\{[^}]*\.key\}[^`]*`\}/);
  });

  it('offers a "Change from <date>" form with a value, a date and a reason, and shows what is in force today, what is scheduled and the history [kills: a screen that cannot schedule or explain]', () => {
    const p = code('page');
    expect(p).toMatch(/Change from/);
    for (const f of ['effectiveFrom', 'reason', 'value']) expect(p, f).toContain(f);
    expect(p).toMatch(/scheduled/i);
    expect(p).toMatch(/history/i);
  });

  it('the page and the action do not import the database (lib may, to read), and no screen file carries the rule figures as literals (the registry owns them)', () => {
    for (const base of ['page', 'actions', 'lib']) {
      const c = code(base);
      if (base !== 'lib') expect(c, base).not.toMatch(/from ['"]@shareat\/db['"]/);
      expect(c, base).not.toMatch(/['"]50\.00['"]|['"]settlement\.variance_floor_amount['"]/);
    }
  });
});

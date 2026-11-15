// @vitest-environment happy-dom
/**
 * T-589 B4a — the shared phone-card converter, fixed once for the ~10 pages the 15 Nov scan flagged.
 * Every test names the MUTANT it kills: undo that one change in phone-table-cards.ts / globals.css and the test goes red.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import { afterEach, describe, expect, it } from 'vitest';
import { observePhoneTables } from '../src/components/ui/phone-table-cards';

const stops: (() => void)[] = [];
afterEach(() => { stops.splice(0).forEach(stop => stop()); document.body.replaceChildren(); });
function mount(html: string) {
  const root = document.createElement('main'); root.innerHTML = html; document.body.append(root);
  stops.push(observePhoneTables(root)); return root;
}
const row = (root: HTMLElement, selector: string) => {
  const found = root.querySelector<HTMLElement>(selector); if (!found) throw new Error(`Missing ${selector}`); return found;
};
const head = (...labels: string[]) => `<thead><tr>${labels.map(l => `<th>${l}</th>`).join('')}</tr></thead>`;

describe('totals and blank rows are not cards', () => {
  const asset = `<table>${head('Asset', 'Cost', 'Book value')}<tbody><tr><td><a href="/a">Walk-in freezer</a></td><td>₱40,000.00</td><td>₱39,000.00</td></tr></tbody>
    <tfoot><tr><td>1 asset</td><td>₱40,000.00</td><td></td></tr></tfoot></table>`;

  // MUTANT: delete the `isTotalRow` early exit -> the footer becomes a "summary" card with an avatar and a chevron.
  it('a tfoot row is a total bar: no avatar, no chevron, its own words lead, empty cells drop out', () => {
    const root = mount(asset);
    const foot = row(root, 'tfoot tr');
    expect(foot.dataset.cardKind).toBe('total');
    expect(foot.hasAttribute('data-card-avatar')).toBe(false);
    expect(foot.querySelector('[data-card-toggle]')).toBeNull();
    expect(row(root, 'tfoot td:nth-child(1)').dataset.cardSlot).toBe('total-lead');
    expect(row(root, 'tfoot td:nth-child(2)').dataset.cardSlot).toBe('total');
    expect(row(root, 'tfoot td:nth-child(3)').dataset.cardSlot).toBe('empty');
    expect(row(root, 'tbody tr').dataset.cardKind).toBe('summary'); // control: a real record stays a card
  });

  // MUTANT: drop the exact-words test -> a body row reading "Total" stays a card with the avatar "T".
  it('a body row whose first words are exactly "Total" is a total bar, but a supplier called "Total Plus" is not', () => {
    const root = mount(`<table>${head('Name', 'Amount')}<tbody><tr><td>Total</td><td>₱5.00</td></tr><tr><td><a href="/s">Total Plus Trading</a></td><td>₱9.00</td></tr></tbody></table>`);
    const [sum, supplier] = Array.from(root.querySelectorAll<HTMLElement>('tbody tr'));
    expect(sum?.dataset.cardKind).toBe('total');
    expect(supplier?.dataset.cardKind).toBe('summary');
  });

  // MUTANT: drop the `nothing` early exit -> every blank count-sheet line is a card with a "·" avatar.
  it('a row with nothing in it is kind=blank (hidden on a phone), and one cell of text keeps it a card', () => {
    const root = mount(`<table data-card-columns="Item|Unit|Count">${'<tr><td></td><td></td><td></td></tr>'.repeat(2)}<tr><td>Rice</td><td></td><td></td></tr></table>`);
    const rows = Array.from(root.querySelectorAll<HTMLElement>('tr'));
    expect(rows.map(r => r.dataset.cardKind)).toEqual(['blank', 'blank', 'summary']);
    expect(rows[0]?.querySelector('[data-card-toggle]')).toBeNull();
  });
});

describe('the avatar is the initials of words', () => {
  const avatar = (name: string) => {
    const root = mount(`<table>${head('Name', 'Amount')}<tbody><tr><td><a href="/x">${name}</a></td><td>₱1.00</td></tr></tbody></table>`);
    return row(root, 'tbody tr').getAttribute('data-card-avatar');
  };
  // MUTANT: restore `[^A-Za-z0-9]` in the word strip -> "1400 Cash" draws the avatar "1C" and "3900" draws "3".
  it('an account number draws no avatar at all; a name draws two letters', () => {
    expect(avatar('1400')).toBeNull();
    expect(avatar('1400 · 3900')).toBeNull();
    expect(avatar('Demo Store Alpha')).toBe('DS');
    expect(avatar('T343S6C Test Item (slab)')).toBe('TT');
    expect(avatar('1400 Cash on hand')).toBe('CO');
  });
});

describe('the key figure beside the name', () => {
  const keyOf = (headers: string[], cells: string[]) => {
    const root = mount(`<table>${head(...headers)}<tbody><tr>${cells.map((c, i) => `<td>${i === 0 ? `<a href="/x">${c}</a>` : c}</td>`).join('')}</tr></tbody></table>`);
    return Array.from(root.querySelectorAll('[data-card-slot="key"]')).map(c => c.textContent);
  };
  // MUTANT: revert the ranked list to the old five patterns -> Owes / Payable / Still out are no key and the amount hides behind the chevron.
  it('what is owed leads: Owes, Payable and Still out are keys', () => {
    expect(keyOf(['Customer', 'Price list', 'Owes'], ['Acme', '—', '₱1,250.00'])).toEqual(['₱1,250.00']);
    expect(keyOf(['Supplier', 'TIN', 'Payable'], ['Meat Co', '123', '₱5,000.00'])).toEqual(['₱5,000.00']);
    expect(keyOf(['Purpose', 'Released', 'Still out', 'State'], ['Market', '₱5,000.00', '₱3,800.00', 'Released']).sort()).toEqual(['₱3,800.00', '₱5,000.00']);
  });
  // MUTANT: drop `saysSomething` -> the empty "Price list" dash is picked as a key beside the real amount.
  it('a column that only says a dash is never a key', () => {
    expect(keyOf(['Customer', 'Price list', 'Owes'], ['Acme', '—', '₱0.00'])).not.toContain('—');
  });
  // MUTANT: drop the money fallback -> a table with no column named like a figure shows nothing but the name.
  it('with no figure-named column, the last amount in the row is the key', () => {
    expect(keyOf(['Customer', 'Region', 'Limit'], ['Acme', 'North', '₱20,000.00'])).toEqual(['₱20,000.00']);
  });
});

describe('help tip tap area', () => {
  // MUTANT: delete the ::after rule -> the "?" button is a 24px target again (the scan measured ~20px).
  it('the "?" button keeps its 24px box and 16px glyph but reaches 44px with an invisible ring', () => {
    const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'app', 'globals.css'), 'utf8');
    const ring: Record<string, string> = {};
    postcss.parse(css).walkRules(r => { if (r.selector.trim() === '.erp-help-tip::after') r.walkDecls(d => { ring[d.prop] = d.value; }); });
    expect(ring['position']).toBe('absolute');
    expect(ring['inset']).toBe('-10px'); // 24 + 2 x 10 = 44
    const tip = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'ui', 'HelpTip.tsx'), 'utf8');
    expect(tip).toContain('h-6 w-6'); // the box (and so the census reading) is unchanged
    expect(tip).toContain('h-4 w-4'); // the visible glyph is unchanged
  });
});

describe('globals.css phone rules', () => {
  const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'app', 'globals.css'), 'utf8');
  const rule = (selector: string) => {
    const found: Record<string, string> = {};
    postcss.parse(css).walkRules(r => { if (r.selector.replace(/\s+/g, ' ').trim().includes(selector)) r.walkDecls(d => { found[d.prop] = d.value; }); });
    return found;
  };
  // MUTANT: remove `border-radius: 0; overflow: visible` -> the rounded box clips the first card's corners (a flat line over it).
  it('the box around a card list no longer clips the first card', () => {
    const wrapper = rule(':where(div.overflow-x-auto, div.overflow-auto):has(> table[data-phone-cards]:only-child)');
    expect(wrapper['border-radius']).toBe('0');
    expect(wrapper['overflow']).toBe('visible');
  });
  // MUTANT: delete the total-row rule -> a footer renders as a stacked card again.
  it('a total row is a wrapping bar and a blank row is not shown', () => {
    expect(rule('tr[data-card-kind="total"]')['flex-wrap']).toBe('wrap');
    expect(rule('tr[data-card-kind="blank"]')['display']).toBe('none');
  });
});

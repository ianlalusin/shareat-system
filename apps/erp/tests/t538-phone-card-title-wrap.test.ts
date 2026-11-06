/**
 * T-538 — phone card titles wrap to two lines instead of being cut off.
 * (impeccable audit 2026-11-03, finding P2 #12.)
 *
 * On a phone each table row becomes a card whose title is the item, supplier or staff name. That
 * title was `white-space: nowrap` + `text-overflow: ellipsis`, so at ~140px "Chili flakes" and
 * "Chili powder" both rendered as "Chili …" and a manager could not tell them apart.
 *
 * The fix is a two-line clamp on the title ONLY — the subtitle below it is deliberately still one
 * line, and that is asserted here too, because the obvious mistake with a `-webkit-box` display is
 * to inherit it into the sibling rule and silently grow every card.
 *
 * `postcss` reads the REAL declarations rather than substring-matching the file: half a dozen other
 * selectors in globals.css name `[data-card-slot="title"]` (image offset, the `:has()` override, the
 * tap-target resets), and a loose scan would read the wrong one as the base rule.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const globalsCssPath = resolve(here, '..', 'src', 'app', 'globals.css');

const TITLE = '[data-phone-table-root] [data-card-slot="title"]';
const SUBTITLE = '[data-phone-table-root] [data-card-slot="subtitle"]';

/** The declarations of the ONE rule whose selector is exactly this, `!important` included. */
function declarationsOf(selector: string): Record<string, { value: string; important: boolean }> {
  const css = readFileSync(globalsCssPath, 'utf8');
  const found: Record<string, { value: string; important: boolean }> = {};
  postcss.parse(css).walkRules((rule) => {
    if (rule.selector.replace(/\s+/g, ' ').trim() !== selector) return;
    rule.walkDecls((declaration) => {
      // postcss leaves `important` undefined rather than false when the flag is absent.
      found[declaration.prop] = { value: declaration.value, important: declaration.important === true };
    });
  });
  return found;
}

describe('T-538 — phone card title wraps to two lines', () => {
  it('the card title clamps at two lines', () => {
    const title = declarationsOf(TITLE);
    // A selector typo would make every assertion below vacuously true, so prove the rule was found.
    expect(Object.keys(title).length, `no rule with selector exactly ${TITLE}`).toBeGreaterThan(0);

    // Two lines, never more: the clamp truncates and draws its own ellipsis.
    expect(title['-webkit-line-clamp']).toEqual({ value: '2', important: false });
    expect(title['line-clamp']).toEqual({ value: '2', important: false });
    expect(title['display']).toEqual({ value: '-webkit-box', important: false });
    expect(title['-webkit-box-orient']).toEqual({ value: 'vertical', important: false });

    // Wrapping is the whole point, and it must out-rank the card's own cell reset (which sets
    // `white-space: normal` without `!important` and `nowrap` on nothing at all).
    expect(title['white-space']).toEqual({ value: 'normal', important: true });
    // A long unbroken name still has to be breakable, or it overflows instead of clamping.
    expect(title['overflow-wrap']).toEqual({ value: 'anywhere', important: false });
    expect(title['overflow']).toEqual({ value: 'hidden', important: false });

    // The old one-line truncation is GONE — `text-overflow: ellipsis` on a clamped box is dead
    // weight at best and misleading at worst.
    expect(title['text-overflow']).toBeUndefined();
    expect(JSON.stringify(title)).not.toContain('nowrap');

    // ...and the rest of the rule is untouched (the work order said keep these exactly).
    expect(title['grid-column']?.value).toBe('2');
    expect(title['grid-row']?.value).toBe('1');
    expect(title['font-size']?.value).toBe('1rem');
    expect(title['font-weight']?.value).toBe('600');
    expect(title['line-height']?.value).toBe('1.4');
  });

  it('the subtitle still stays on one line', () => {
    const subtitle = declarationsOf(SUBTITLE);
    expect(Object.keys(subtitle).length, `no rule with selector exactly ${SUBTITLE}`).toBeGreaterThan(0);

    // One line is right for the subtitle: it is the secondary detail, and the title now carries
    // the extra height.
    expect(subtitle['white-space']).toEqual({ value: 'nowrap', important: true });
    expect(subtitle['text-overflow']).toEqual({ value: 'ellipsis', important: false });
    // The clamp must NOT have leaked into the sibling rule.
    expect(subtitle['display']).toBeUndefined();
    expect(subtitle['-webkit-line-clamp']).toBeUndefined();
  });
});

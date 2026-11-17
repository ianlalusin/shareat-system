/**
 * T-538 — phone card titles wrap to two lines instead of being cut off.
 * (impeccable audit 2026-11-03, finding P2 #12, revision 2.)
 *
 * On a phone each table row becomes a card whose title is the item, supplier or staff name. That
 * title was `white-space: nowrap` + `text-overflow: ellipsis`, so at ~140px "Chili flakes" and
 * "Chili powder" both rendered as "Chili …" and a manager could not tell them apart.
 *
 * Revision 1 tried `display: -webkit-box` + `-webkit-line-clamp: 2`, which never renders here: the
 * title cell is an item of the card grid, and Blink blockifies a grid item's `-webkit-box` to
 * `flow-root`, leaving the clamp inert (measured: 5 lines). Revision 2 cuts at a line boundary with
 * `max-height: calc(2 * 1.4em)` on the untouched 1.4 line-height, so exactly two lines show and the
 * third is hidden. The assertions below pin BOTH halves of that: the cut is there, and the
 * line-clamp of revision 1 is gone rather than left behind as a second, dead mechanism.
 *
 * The subtitle below the title is deliberately still one line, and that is asserted too, because the
 * obvious mistake when growing the title rule is to carry `overflow: hidden` semantics into the
 * sibling and silently grow every card.
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

describe('T-538 — phone card title wraps (T-589 B4a: and is never cut)', () => {
  it('the card title wraps in full', () => {
    const title = declarationsOf(TITLE);
    // A selector typo would make every assertion below vacuously true, so prove the rule was found.
    expect(Object.keys(title).length, `no rule with selector exactly ${TITLE}`).toBeGreaterThan(0);

    // T-589 B4a: NOT cut any more. The title cell also holds the row's own second line (an owner's role),
    // and the two-line max-height sliced that line in half under the subtitle. MUTANT: restore
    // `max-height: calc(2 * 1.4em)` + `overflow: hidden` and the two assertions below go red.
    expect(title['max-height']).toBeUndefined();
    expect(title['line-height']?.value).toBe('1.4');

    // Wrapping is the whole point, and it must out-rank the card's own cell reset (which sets
    // `white-space: normal` without `!important`).
    expect(title['white-space']).toEqual({ value: 'normal', important: true });
    // A long unbroken name still has to be breakable; ordinary words wrap at word breaks (T-589 B5), not letter by letter.
    expect(title['overflow-wrap']).toEqual({ value: 'break-word', important: false });
    expect(title['word-break']).toEqual({ value: 'normal', important: false });
    // Nothing is clipped: the grid row grows with the title.
    expect(title['overflow']).toEqual({ value: 'visible', important: false });

    // Revision 1's `-webkit-line-clamp` is GONE, and must stay gone — it is inert on a grid item,
    // so leaving it in would look like a clamp while doing nothing, and the next reader would
    // trust it over the `max-height` that actually works.
    expect(title['-webkit-line-clamp']).toBeUndefined();
    expect(title['line-clamp']).toBeUndefined();
    expect(title['display']).toBeUndefined();
    expect(title['-webkit-box-orient']).toBeUndefined();

    // The old one-line truncation is gone too.
    expect(title['text-overflow']).toBeUndefined();
    expect(JSON.stringify(title)).not.toContain('nowrap');

    // ...and the rest of the rule is untouched (the work order said keep these exactly).
    expect(title['grid-column']?.value).toBe('2');
    expect(title['grid-row']?.value).toBe('1');
    expect(title['font-size']?.value).toBe('1rem');
    expect(title['font-weight']?.value).toBe('600');
  });

  // T-589 B4a: the subtitle wraps too (a room name read "Main stoc"). MUTANT: restore `nowrap` + `ellipsis` and this goes red.
  it('the subtitle wraps instead of ending in an ellipsis', () => {
    const subtitle = declarationsOf(SUBTITLE);
    expect(Object.keys(subtitle).length, `no rule with selector exactly ${SUBTITLE}`).toBeGreaterThan(0);

    expect(subtitle['white-space']).toEqual({ value: 'normal', important: true });
    expect(subtitle['text-overflow']).toBeUndefined();
    // Neither the clamp of revision 1 nor the height cut of revision 2 may have leaked next door.
    expect(subtitle['max-height']).toBeUndefined();
    expect(subtitle['display']).toBeUndefined();
    expect(subtitle['-webkit-line-clamp']).toBeUndefined();
  });
});

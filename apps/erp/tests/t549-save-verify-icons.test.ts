/** T-549: Save draws the floppy-disk icon; Verify draws the check icon. Icons only, nothing else moved. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ActionIcon, actionIconFor } from '../src/components/ui/action-icons';

describe('T-549 actionIconFor', () => {
  it.each([
    ['Save', 'save'],
    ['Save draft', 'save'],
    ['Update', 'save'],
    ['Keep "x"', 'check'],
    ['Verify', 'check'],
    ['Verify & post', 'check'],
    ['Close month', 'lock'],
    ['Close this branch', 'lock'],
    ['Close shift', 'lock'],
    ['Close', 'close'],
    ['Cancel', 'close'],
    ['Approve', 'thumbsUp'],
    ['Approve & post', 'thumbsUp'],
    ['Post separation', 'book'],
    ['Confirm term', 'check'],
    ['Submit', 'send'],
  ])('%s -> %s', (words, icon) => {
    expect(actionIconFor(words)).toBe(icon);
  });

  it.each(['lock', 'thumbsUp', 'book'] as const)('%s draws its own glyph', (name) => {
    const html = renderToStaticMarkup(createElement(ActionIcon, { name }));
    expect(html).toContain('<path');
    expect(html).not.toContain('M5 12.5l4.5 4.5L19 7.5');
  });

  it('the save icon draws the floppy path, not the tick', () => {
    const html = renderToStaticMarkup(createElement(ActionIcon, { name: 'save' }));
    expect(html).toContain('M5 3h11l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z');
    expect(html).not.toContain('M5 12.5l4.5 4.5L19 7.5');
  });
});

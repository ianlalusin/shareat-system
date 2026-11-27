/**
 * T-646 - the effective-from date sits behind a "Schedule for later" disclosure, closed by default.
 *
 * Page-level checks read the page SOURCE (the form needs the database to render; the markup does not). Each of the three
 * "From (Manila time" fields must be wrapped in a <details> whose <summary> says "Schedule for later", and no <details>
 * may carry `open`, so an empty closed box still submits "" = now.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const APP = resolve(__dirname, '..', 'src', 'app');
// Windows checkouts are CRLF; the source regexes below are written for LF.
const src = (rel: string) => readFileSync(resolve(APP, rel), 'utf8').replace(/\r\n/g, '\n');

const PAGES = ['menu/items/[id]/page.tsx', 'menu/prices/page.tsx'];
const LABEL = 'From (Manila time, empty = now)';
const WRAPPED = String.raw`<details className="text-sm">\s*<summary className="[^"]*">Schedule for later</summary>\s*<Field label="From \(Manila time, empty = now\)"[^>]*>[\s\S]*?</Field>\s*</details>`;

describe('T-646 schedule-later disclosure', () => {
  it('every effective-from field sits inside a "Schedule for later" details block', () => {
    for (const rel of PAGES) {
      const text = src(rel);
      const total = text.split(LABEL).length - 1;
      const wrapped = text.match(new RegExp(WRAPPED, 'g'))?.length ?? 0;
      expect(total, rel).toBeGreaterThan(0);
      expect(wrapped, rel).toBe(total);
    }
  });
  it('there are exactly three effective-from fields across the two pages', () => {
    const total = PAGES.map((rel) => src(rel).split(LABEL).length - 1).reduce((a, b) => a + b, 0);
    expect(total).toBe(3);
  });
  it('no details block is open by default', () => {
    for (const rel of PAGES) {
      expect(src(rel), rel).not.toMatch(String.raw`<details[^>]*\bopen\b`);
    }
  });
});

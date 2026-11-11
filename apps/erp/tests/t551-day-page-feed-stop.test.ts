/**
 * T-551 - the sales-day page stops offering "Re-import from POS" for a day dated after 2026-12-31 (bible row 452 b).
 * Source-structure test in the idiom of `t339-sales-day-new-store-picker.test.ts`: the day page needs a sales day dated 2027,
 * which the import can no longer create, so the rendered legs live in `integration/t375-s3-import-web.test.ts` (new-day page
 * and the two actions) and this file pins the day page's own guard.
 */
import { readControlSource } from './helpers/control-source';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const source = readControlSource(resolve(here, '..', 'src', 'app', 'sales-days', '[id]', 'page.tsx'), 'utf8');

/** The re-import form: from `<form action={reimportSalesDayAction}` to its closing tag, plus the 400 characters before it. */
function reimportBlock(src: string): string {
  const at = src.indexOf('<form action={reimportSalesDayAction}');
  if (at === -1) throw new Error('reimportSalesDayAction form not found - page structure changed.');
  return src.slice(Math.max(0, at - 400), src.indexOf('</form>', at) + '</form>'.length);
}

describe('T-551 - the day page and the feed cut-off', () => {
  it('the Re-import form is only rendered while the day is on or before the cut-off date', () => {
    expect(reimportBlock(source)).toMatch(/V1_DAY_FEED_LAST_DATE/);
  });

  it('a day after the cut-off shows the sentence instead', () => {
    expect(source).toContain('V1_DAY_FEED_STOPPED_SENTENCE');
  });

  it('the control is still there: the Re-import button exists for earlier days', () => {
    expect(source).toContain('Re-import from POS');
  });
});

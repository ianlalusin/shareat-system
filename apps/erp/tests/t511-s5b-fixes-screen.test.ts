import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { noteText } from '../src/app/channel-settlements/review/words';

/**
 * T-511 S5b FIXER (2026-11-05), the screen-side findings, judged from the pure helper and from source (the rendering itself is checked on the running page):
 *  P3-13 the "Note" column prints Grab's free-text Description: control characters stripped, one line, at most 120 characters (screen only; the stored text is untouched).
 *  P3-6  the "VAT on fees" line says it is the whole invoice's VAT (each day carries only its share).
 *  P3-14 every review form posts the page's filters back (the typed reason is NOT refilled after a refusal: that needs EditableRecord).
 *  P2-3  an unreadable stored invoice shows "could not be read again", never a VAT figure of 0.00.
 *  P3-9  `loanCheckForDay` is not on the domain barrel.
 */
const SRC = resolve(__dirname, '..', 'src');
const DIR = join(SRC, 'app', 'channel-settlements', 'review');
const read = (p: string): string => readFileSync(p, 'utf8');
const codeOnly = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('P3-13 noteText', () => {
  it('strips control and direction-override characters, joins lines, trims [kills: terminal escape or a text-flipping character reaching the page]', () => {
    expect(noteText('Refund\u0000 for\u001b[31m order\r\nnext\tline‮')).toBe('Refund for [31m order next line');
    expect(noteText('  spaced   out  ')).toBe('spaced out');
  });
  it('cuts a long description to 120 characters and says it was cut [kills: 200 characters of free text in a table cell]', () => {
    const out = noteText('a'.repeat(200));
    expect(out.length).toBeLessThanOrEqual(121);
    expect(out.endsWith('…')).toBe(true);
    expect(noteText('b'.repeat(120))).toBe('b'.repeat(120));
  });
  it('null and blank give nothing [kills: the word null on the page]', () => {
    expect(noteText(null)).toBe('');
    expect(noteText(' \n ')).toBe('');
  });
});

describe('the review screen sources', () => {
  const detail = (): string => codeOnly(read(join(DIR, 'DayDetail.tsx')));
  const page = (): string => codeOnly(read(join(DIR, 'page.tsx')));

  it('P3-13 the Note column goes through noteText [kills: the raw description printed]', () => {
    expect(detail()).toContain('noteText(o.description)');
    expect(detail()).not.toMatch(/\{o\.description\b/);
  });

  it('P3-6 the VAT line is labelled as the whole invoice\'s VAT, all days together, and the old "already inside ... above" wording is gone [kills: an invoice total read as one day\'s]', () => {
    expect(detail()).toContain("VAT on this invoice's fees, all days together");
    expect(detail()).toContain('VAT on fees');
    expect(detail()).not.toContain('already inside the platform fee and taxes above');
  });

  it('P2-3 an unreadable invoice shows words, not 0.00 [kills: VAT 0.00 for a file that was never read]', () => {
    expect(detail()).toContain('vatOnFeesUnreadable');
    expect(detail()).toMatch(/could not be read again/);
    expect(page()).toContain('p.unreadable');
  });

  it('P3-14 every form that posts to a review action carries the filters; the page passes them in [kills: filters lost on a refused action]', () => {
    const d = detail();
    expect(d).toContain('FilterFields');
    expect((d.match(/<FilterFields\b/g) ?? []).length).toBeGreaterThanOrEqual(3); // reject, reopen, override
    expect(page()).toContain('<FilterFields');
    expect(d).not.toContain('reasonDefault'); // no typed-reason refill: it would need EditableRecord (G7); filters only
    for (const name of ['store', 'platform', 'period', 'needs']) expect(read(join(DIR, 'words.ts'))).toContain(name);
  });

  it('P3-9 the domain barrel does not export loanCheckForDay [kills: the unredacted company result on the public surface]', () => {
    const barrel = read(resolve(SRC, '..', '..', '..', 'packages', 'domain', 'src', 'index.ts'));
    expect(barrel).not.toMatch(/\bloanCheckForDay\b/);
    expect(barrel).toMatch(/\bcheckLoanDay\b/);
  });
});

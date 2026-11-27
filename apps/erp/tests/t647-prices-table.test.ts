/**
 * T-647 - /menu/prices is a table from lg up (each price is the button that opens its form), cards below lg.
 *
 * Page-level checks read the page SOURCE (the data layer needs a database; the shape does not). Every check is a function of
 * the source; each mutant runs THE SAME function on the source with one keep removed and must get the opposite answer, so a
 * guard that cannot fail cannot pass.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const APP = resolve(__dirname, '..', 'src', 'app');
// Windows checkouts are CRLF; the source regexes below are written for LF.
const src = (rel: string) => readFileSync(resolve(APP, rel), 'utf8').replace(/\r\n/g, '\n');
const s = src('menu/prices/page.tsx');

/** The wide-screen block: from the `hidden lg:block` wrapper to the `lg:hidden` cards. */
const tableBlock = (source: string): string => source.match(/<div className="hidden lg:block">[\s\S]*?<div className="space-y-3 lg:hidden">/)?.[0] ?? '';
/** The card block: from the `lg:hidden` wrapper to the end of the category section. */
const cardBlock = (source: string): string => source.match(/<div className="space-y-3 lg:hidden">[\s\S]*?<\/section>/)?.[0] ?? '';
/** The links row: the flex wrapper holding the store link, the hours link and the copy dialog. */
const linksRow = (source: string): string => source.match(/<div className="flex[^"]*">\s*<Link href=\{`\/menu\/stores\/[\s\S]*?<CopyFromStoreDialog[^>]*\/>\s*\}?\s*<\/div>/)?.[0] ?? '';

const tableOk = (source: string): boolean => {
  const block = tableBlock(source);
  return block.includes('<Table') && block.includes('<Th>Item / variant</Th>') && block.includes('CHANNEL_LABEL[ch]') && /const CHANNEL_LABEL[^\n]*Store \(counter and tables\)[^\n]*Online/.test(source);
};
const cardsOk = (source: string): boolean => {
  const cards = cardBlock(source);
  return cards.includes('<Panel key={ch}') && !cards.includes('<Panel cell') && tableBlock(source) !== '';
};
const triggerOk = (source: string): boolean =>
  /<Panel cell\b/.test(tableBlock(source)) &&
  source.includes('{cell && canAdd ? (') &&
  // the cell's trigger is the figure itself, and its accessible name starts with those words (WCAG 2.5.3)
  source.includes('cellForm(figure, `${figure} — set the ${CHANNEL_SHORT[channel]} price for ${label}`, FIGURE_TRIGGER)') &&
  // PriceForm hands that trigger to FormModal, the one modal every price form uses
  /<FormModal trigger=\{trigger\} [^>]*triggerLabel=\{triggerLabel \?\? trigger\}/.test(source);
const withdrawOk = (source: string): boolean =>
  source.includes('const showAdd = canAdd && !(cell && !dayparted);') &&
  /\(showAdd \|\| \(!dayparted && row && !row\.withdrawn\)\)/.test(source) &&
  source.includes('aria-label={`Withdraw the ${CHANNEL_SHORT[channel]} price for ${label}`}') &&
  source.includes("aria-label={`Withdraw the ${info?.name ?? ''} price`}");
const statusOk = (source: string): boolean =>
  // a withdrawn / no-price status is plain text beside a small "Set price", never a pill
  source.includes('const isStatus = row !== undefined && (row.withdrawn ||') &&
  source.includes("cellForm('Set price',") &&
  /<span className="text-muted">\{figure\}<\/span>/.test(source);
const gapOk = (source: string): boolean => {
  const row = linksRow(source);
  return /className="flex [^"]*\bgap-x-\d+\b/.test(row) && row.includes('Change the menu hours');
};

describe('T-647 menu prices table', () => {
  it('a table shows only from lg up, with the three headers', () => {
    expect(tableOk(s)).toBe(true);
    // mutant: the table loses its lg-only wrapper -> it would show on phones too
    expect(tableOk(s.replace('<div className="hidden lg:block">', '<div className="block">'))).toBe(false);
    // mutant: a header dropped
    expect(tableOk(s.replace('<Th>Item / variant</Th>', ''))).toBe(false);
  });

  it('the card layout is hidden from lg up and still draws a Panel per channel', () => {
    expect(cardsOk(s)).toBe(true);
    // mutant: cards left visible on wide screens beside the table
    expect(cardsOk(s.replace('space-y-3 lg:hidden', 'space-y-3'))).toBe(false);
    // mutant: the cards draw the cell layout
    expect(cardsOk(s.replace('<Panel key={ch} label', '<Panel cell key={ch} label'))).toBe(false);
  });

  it('a table cell is a Panel in cell mode, and the price figure is the FormModal trigger', () => {
    expect(triggerOk(s)).toBe(true);
    // mutant: the cell falls back to plain text -> the price is no longer the way in
    expect(triggerOk(s.replace('{cell && canAdd ? (', '{false ? ('))).toBe(false);
    // mutant: the accessible name no longer carries the visible figure
    expect(triggerOk(s.replace('`${figure} — set the ', '`Set the '))).toBe(false);
    // mutant: the table draws plain Panels, not cells
    expect(triggerOk(s.replace('<Panel cell label', '<Panel label'))).toBe(false);
  });

  it('Withdraw is still reachable from the table path (all-day and time-of-day cells)', () => {
    expect(withdrawOk(s)).toBe(true);
    // mutant: the actions row gated on showAdd alone would lose the all-day Withdraw
    expect(withdrawOk(s.replace('(showAdd || (!dayparted && row && !row.withdrawn))', '(showAdd)'))).toBe(false);
    // mutant: the per-slot Withdraw label gone
    expect(withdrawOk(s.replace("aria-label={`Withdraw the ${info?.name ?? ''} price`}", ''))).toBe(false);
  });

  it('a status (Withdrawn, Offered with no price) is plain text with a small Set price beside it', () => {
    expect(statusOk(s)).toBe(true);
    // mutant: the status becomes the pill again
    expect(statusOk(s.replace("cellForm('Set price',", "cellForm('Withdrawn',"))).toBe(false);
    expect(statusOk(s.replace('<span className="text-muted">{figure}</span>', '{figure}'))).toBe(false);
  });

  it('the links row has a gap, so the links are not run together', () => {
    expect(gapOk(s)).toBe(true);
    // mutant: the gap removed
    expect(gapOk(s.replace('flex flex-wrap items-center gap-x-6 gap-y-2', 'flex flex-wrap items-center'))).toBe(false);
    // mutant: the hours link falls out of the row
    expect(gapOk(s.replace('Change the menu hours', 'Hours'))).toBe(false);
  });
});

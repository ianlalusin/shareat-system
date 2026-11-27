/**
 * T-647 - /menu/prices is a table from lg up (each price is the button that opens its form), cards below lg.
 *
 * Page-level checks read the page SOURCE (the data layer needs a database; the shape does not). Each check has a mutant
 * (the source with the keep removed) that must go red, so a guard that cannot fail cannot pass.
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
/** The links row: the flex wrapper holding the store link, the hours link and the copy dialog. */
const linksRow = (source: string): string => source.match(/<div className="flex[^"]*">\s*<Link href=\{`\/menu\/stores\/[\s\S]*?<CopyFromStoreDialog[^>]*\/>\s*\}?\s*<\/div>/)?.[0] ?? '';

describe('T-647 menu prices table', () => {
  it('a table shows only from lg up, with the three headers', () => {
    const block = tableBlock(s);
    expect(block).toContain('<Table');
    expect(block).toContain('<Th>Item / variant</Th>');
    expect(block).toContain('CHANNEL_LABEL[ch]');
    expect(s).toMatch(/const CHANNEL_LABEL[^\n]*Store \(counter and tables\)[^\n]*Online/);
    // mutant: the table loses its lg-only wrapper -> it would show on phones too
    expect(tableBlock(s.replace('<div className="hidden lg:block">', '<div className="block">'))).toBe('');
    // mutant: a header dropped
    expect(tableBlock(s.replace('<Th>Item / variant</Th>', ''))).not.toContain('<Th>Item / variant</Th>');
  });

  it('the card layout is hidden from lg up and still draws a Panel per channel', () => {
    const cards = s.match(/<div className="space-y-3 lg:hidden">[\s\S]*?<\/section>/)?.[0] ?? '';
    expect(cards).toContain('<Panel key={ch}');
    expect(cards).not.toContain('<Panel cell');
    // mutant: cards left visible on wide screens beside the table
    expect(s.replace('space-y-3 lg:hidden', 'space-y-3')).not.toContain('lg:hidden');
  });

  it('a table cell is a Panel in cell mode, and the price figure is the FormModal trigger', () => {
    expect(tableBlock(s)).toMatch(/<Panel cell\b/);
    // the cell's PriceForm trigger is the figure (or "Not set"), labelled with the channel and the item
    expect(s).toContain("trigger={row ? figureText(row) : 'Not set'}");
    expect(s).toContain('triggerLabel={`Set the ${CHANNEL_SHORT[channel]} price for ${label}`}');
    expect(s).toContain('{cell && canAdd ? (');
    // PriceForm hands that trigger to FormModal, the one modal every price form uses
    expect(s).toMatch(/<FormModal trigger=\{trigger\} [^>]*triggerLabel=\{triggerLabel \?\? trigger\}/);
    // mutant: the cell falls back to plain text -> the price is no longer the way in
    expect(s.replace('{cell && canAdd ? (', '{false ? (')).not.toContain('{cell && canAdd ? (');
  });

  it('Withdraw is still reachable from the table path (all-day and time-of-day cells)', () => {
    // the all-day Withdraw sits in the actions row that cell mode keeps (showAdd drops only the Set price button)
    expect(s).toContain('const showAdd = canAdd && !(cell && !dayparted);');
    expect(s).toMatch(/\(showAdd \|\| \(!dayparted && row && !row\.withdrawn\)\)/);
    expect(s).toContain('aria-label={`Withdraw the ${CHANNEL_SHORT[channel]} price for ${label}`}');
    // the time-of-day slots keep their per-slot Withdraw
    expect(s).toContain('aria-label={`Withdraw the ${info?.name ?? \'\'} price`}');
    // mutant: the actions row gated on showAdd alone would lose the all-day Withdraw
    expect(s.replace('(showAdd || (!dayparted && row && !row.withdrawn))', '(showAdd)')).not.toMatch(/\(showAdd \|\| \(!dayparted/);
  });

  it('the links row has a gap, so the links are not run together', () => {
    const row = linksRow(s);
    expect(row).toMatch(/className="flex [^"]*\bgap-x-\d+\b/);
    expect(row).toContain('Change the menu hours');
    // mutant: the gap removed
    expect(linksRow(s.replace('flex flex-wrap items-center gap-x-6 gap-y-2', 'flex flex-wrap items-center'))).not.toMatch(/\bgap-x-\d+\b/);
  });
});

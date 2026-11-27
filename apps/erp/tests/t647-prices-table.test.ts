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
  /<FormModal trigger=\{trigger\} [^>]*triggerLabel: accessibleName/.test(source);
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
/** The text of `source` from `from` up to (not including) `to`, or '' when either marker is missing. */
const between = (source: string, from: string, to: string): string => {
  const a = source.indexOf(from);
  const b = a === -1 ? -1 : source.indexOf(to, a);
  return b === -1 ? '' : source.slice(a, b);
};
const offBlock = (source: string): string => source.match(/if \(!isOn\) \{[\s\S]*?\n  \}\n/)?.[0] ?? '';
const isOnOk = (source: string): boolean =>
  source.includes("const isOn = !sellOnline || (row !== undefined && !row.withdrawn) || data.slots.some((r) => r.variantId === variantId && r.channel === 'online' && !r.withdrawn);");
/** OFF draws only the switch (or, without permission, the words) and any future-dated price: no price, no "Not set", no Withdraw. */
const offOnlySwitchOk = (source: string): boolean => {
  const off = offBlock(source);
  return off.includes('{switchOn || soldLine}') && off.includes('{laterLines}') && !/Withdraw|Not set|cellForm\(|\{figure\}|<Panel/.test(off);
};
/** The switch is the FormModal trigger (via PriceForm) of the ordinary Online Set price form; saving it is the ON. */
const switchTriggerOk = (source: string): boolean => {
  const on = between(source, 'const switchOn =', 'const switchOff =');
  return (
    on.includes('canAdd &&') &&
    on.includes('channel="online"') &&
    on.includes('trigger={<SwitchFace on={false} text="Sell online" />}') &&
    on.includes("triggerAttrs={{ role: 'switch', 'aria-checked': false }}") &&
    on.includes('triggerLabel={sellName}') &&
    source.includes('const sellName = `Sell ${label} online`;') &&
    /<FormModal trigger=\{trigger\} [^>]*\{\.\.\.\(triggerAttrs \? \{ triggerAttrs \} : \{\}\)\}/.test(source)
  );
};
/** Turning OFF goes through the existing withdraw form, behind a confirm; only someone who may price gets the switch. */
const switchOffOk = (source: string): boolean => {
  const off = between(source, 'const switchOff =', 'const soldLine =');
  return (
    off.includes('canPrice &&') &&
    off.includes("triggerAttrs={{ role: 'switch', 'aria-checked': true }}") &&
    off.includes('<form action={withdrawPriceAction}') &&
    off.includes('<ConfirmDestructive') &&
    off.includes('tier="confirm"') &&
    off.includes('Its online price is not kept; you will type it again to turn it back on.')
  );
};
const ACTIONS = ['cancelScheduledOptionPriceAction', 'cancelScheduledPriceAction', 'setOptionPriceAction', 'setPriceAction', 'withdrawPriceAction'];
const exportedActions = (source: string): string[] => [...source.matchAll(/export async function (\w+)/g)].map((m) => m[1] ?? '').sort();
const actionsOk = (page: string, actions: string): boolean =>
  JSON.stringify(exportedActions(actions)) === JSON.stringify(ACTIONS) && !/from '@shareat\/db\/schema/.test(page);
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

  it('Sell online: OFF shows only the switch (and any scheduled price)', () => {
    expect(offOnlySwitchOk(s)).toBe(true);
    // mutant: the OFF cell also draws the price figure ("Not set")
    expect(offOnlySwitchOk(s.replace('{switchOn || soldLine}\n        {laterLines}', '{figure}{switchOn || soldLine}\n        {laterLines}'))).toBe(false);
    // mutant: the scheduled line is hidden when OFF
    expect(offOnlySwitchOk(s.replace('{switchOn || soldLine}\n        {laterLines}', '{switchOn || soldLine}'))).toBe(false);
  });

  it('Sell online: ON/OFF is "a live online price that is not withdrawn", by the day or by time of day', () => {
    expect(isOnOk(s)).toBe(true);
    // mutant: a withdrawn row counts as ON
    expect(isOnOk(s.replace('(row !== undefined && !row.withdrawn)', '(row !== undefined)'))).toBe(false);
    // mutant: time-of-day prices no longer count
    expect(isOnOk(s.replace(' || data.slots.some(', ' || [].some('))).toBe(false);
  });

  it('Sell online: the switch is the Set price modal trigger for the Online channel, only where a price can be added', () => {
    expect(switchTriggerOk(s)).toBe(true);
    // mutant: the switch opens the Store form
    expect(switchTriggerOk(s.replace('      channel="online"\n      itemType', '      channel="store"\n      itemType'))).toBe(false);
    // mutant: no switch role
    expect(switchTriggerOk(s.replace("triggerAttrs={{ role: 'switch', 'aria-checked': false }}", ''))).toBe(false);
    // mutant: shown without the permission gate
    expect(switchTriggerOk(s.replace('sellOnline && !isOn && canAdd && (', 'sellOnline && !isOn && ('))).toBe(false);
  });

  it('Sell online: turning OFF is the existing Withdraw form behind a confirm', () => {
    expect(switchOffOk(s)).toBe(true);
    // mutant: no confirm
    expect(switchOffOk(s.replace('<ConfirmDestructive', '<Button'))).toBe(false);
    // mutant: the form posts to another action
    expect(switchOffOk(s.replace('<form action={withdrawPriceAction} className="space-y-3 text-sm">', '<form action={cancelScheduledPriceAction} className="space-y-3 text-sm">'))).toBe(false);
    // mutant: the confirm no longer says the price is lost
    expect(switchOffOk(s.replace('Its online price is not kept; ', ''))).toBe(false);
  });

  it('Sell online adds no server action and no schema import', () => {
    const actions = src('menu/prices/actions.ts');
    expect(actionsOk(s, actions)).toBe(true);
    // mutant: a new action appears
    expect(actionsOk(s, `${actions}\nexport async function sellOnlineAction() {}`)).toBe(false);
    // mutant: the page reaches into the schema
    expect(actionsOk(`${s}\nimport { x } from '@shareat/db/schema/menu';`, actions)).toBe(false);
  });

  it('the links row has a gap, so the links are not run together', () => {
    expect(gapOk(s)).toBe(true);
    // mutant: the gap removed
    expect(gapOk(s.replace('flex flex-wrap items-center gap-x-6 gap-y-2', 'flex flex-wrap items-center'))).toBe(false);
    // mutant: the hours link falls out of the row
    expect(gapOk(s.replace('Change the menu hours', 'Hours'))).toBe(false);
  });
});

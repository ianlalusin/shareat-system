/**
 * T-504 - the sales-day CHANNEL rule: a channel the person types is an amount above zero or "No sales" ticked, never blank
 * or zero on its own, and never both at once (DEF-628). docs/tasks/504-no-sales-tick-required.md.
 *
 * ONE copy: `createSalesDay` / `editSalesDay` / `setPlatformSales` / `submitSalesDay` throw `refuse(raw, <sentence>)` with the
 * sentences below, and the form's `<RuleCheck id="salesDay.channels.tickedOrTyped">` prints the very same words.
 * Client-safe leaf (see ./check.ts): imports only ./check, ../shared/money-input and @shareat/core/money.
 */
import { isZero } from '@shareat/core/money';
import { parseMoneyInput } from '../shared/money-input';
import { block, defineCheck, typed, warn, type FormValues } from './check';

export const channelMissingSentence = (name: string): string => `${name}: type the sales, or tick No sales if there were none.`;
export const channelBothSentence = (name: string): string => `${name}: you typed sales and ticked No sales — choose one.`;
/** Submit names EVERY channel still missing, in display order. */
export const submitMissingSentence = (names: readonly string[]): string => `Type the sales, or tick No sales, for: ${names.join(', ')}.`;

/** `'blank'`: nothing typed, box unticked (fine while drafting, refused at submit). `'missing'`: a zero, box unticked. `'both'`: an amount and the tick. */
export type ChannelProblem = 'blank' | 'missing' | 'both' | null;

/**
 * What is wrong with ONE typed channel, or null. An unreadable figure ("abc") is no problem HERE: the money parser has its own
 * sentence for it. A negative figure is not this rule's concern either.
 */
export function channelProblem(rawAmount: string, noSales: boolean): ChannelProblem {
  const raw = rawAmount.trim();
  if (raw === '') return noSales ? null : 'blank';
  let zero: boolean;
  try {
    zero = isZero(parseMoneyInput(raw, 'channel', 'The amount'));
  } catch {
    return null;
  }
  if (noSales) return zero ? null : 'both';
  return zero ? 'missing' : null;
}

export interface SalesChannelFacts {
  /** The channels the form shows, in display order. */
  channels: ReadonlyArray<{ id: string; name: string }>;
}

const controlNames = (facts: SalesChannelFacts): string[] => facts.channels.flatMap((c) => [`channel_${c.id}`, `nosales_${c.id}`]);

/** Save is off while a typed channel is a zero with no tick, or an amount with the tick. A blank is allowed (a draft). */
export const channelsTickedOrTypedCheck = defineCheck<SalesChannelFacts>({
  id: 'salesDay.channels.tickedOrTyped',
  watch: [],
  watchFor: controlNames,
  run(facts, values: FormValues) {
    for (const c of facts.channels) {
      const p = channelProblem(typed(values, `channel_${c.id}`), typed(values, `nosales_${c.id}`) !== '');
      if (p === 'missing') return block(channelMissingSentence(c.name));
      if (p === 'both') return block(channelBothSentence(c.name));
    }
    return null;
  },
});

/** A blank channel never blocks Save, but it will block Submit: a gentle line says so. */
export const channelsBlankHintCheck = defineCheck<SalesChannelFacts>({
  id: 'salesDay.channels.blankHint',
  watch: [],
  watchFor: controlNames,
  run(facts, values: FormValues) {
    const blanks = facts.channels.filter((c) => channelProblem(typed(values, `channel_${c.id}`), typed(values, `nosales_${c.id}`) !== '') === 'blank');
    return blanks.length === 0 ? null : warn(`Before this day can be submitted: ${submitMissingSentence(blanks.map((c) => c.name))}`);
  },
});

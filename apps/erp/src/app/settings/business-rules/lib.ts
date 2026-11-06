/**
 * Server-only reads and display helpers for `/settings/business-rules`. T-512 (T-511 S5c).
 *
 * The page gate (`requirePageAccess('/settings/business-rules')`, `manage_business_rules`, admin only) is the READ control, and
 * `listBusinessRules` checks the same capability itself. No rule is decided here: which row is in force, the labels and the bounds all
 * come from the domain's registry and rule book.
 */
import { listBusinessRules, type BusinessRuleChange, type BusinessRuleItem } from '@shareat/domain';
import type { Actor } from '@shareat/auth';
import { addDays, businessDayRange, formatBusinessDateTime, toBusinessDate, type BusinessDate } from '@shareat/core/datetime';
import { peso } from '../../../lib/format';
import { withOrgPrincipal } from '../../expenses/lib';

export { withOrgPrincipal };

/** The two group headings, in the order the page shows them. */
export const RULE_GROUPS = [
  { namespace: 'settlement', heading: 'Settlement' },
  { namespace: 'tax', heading: 'Tax' },
] as const;

export interface RulesView {
  /** Manila today: the earliest day a new value may start. */
  readonly today: string;
  /** The day the change form starts on unless the admin picks another. */
  readonly tomorrow: string;
  readonly groups: readonly { readonly heading: string; readonly items: readonly BusinessRuleItem[] }[];
}

export async function rulesView(actor: Actor): Promise<RulesView> {
  const items = await withOrgPrincipal(actor.orgId, (tx) => listBusinessRules(tx, actor));
  const today = toBusinessDate();
  return {
    today,
    tomorrow: addDays(today, 1),
    groups: RULE_GROUPS.map((g) => ({ heading: g.heading, items: items.filter((i) => i.namespace === g.namespace) })),
  };
}

/** '70.000000' -> '₱70.00' for money, '0.500000' -> '0.5%' for a percent. Exact: text surgery, no floats. */
export function showValue(unit: 'money' | 'percent', text: string): string {
  if (unit === 'money') return peso(inputValue('money', text));
  return `${inputValue('percent', text)}%`;
}

/** What goes in the box: money at two places ('70.00'), a percent without trailing zeros ('0.5'). */
export function inputValue(unit: 'money' | 'percent', text: string): string {
  const [whole = '0', frac = ''] = text.split('.');
  if (unit === 'money') return `${whole}.${frac.padEnd(2, '0').slice(0, 2)}`;
  const trimmed = frac.replace(/0+$/, '');
  return trimmed ? `${whole}.${trimmed}` : whole;
}

/** '2026-12-01' -> 'Dec 1, 2026'. */
export function showDay(day: string): string {
  return formatBusinessDateTime(businessDayRange(day as BusinessDate).start, { dateStyle: 'medium' });
}

/** The ids that win a start day shared by several rows: the newest of them is in force (history is newest first, so the first of each day). */
export function sharedDayWinners(item: BusinessRuleItem): ReadonlySet<string> {
  const seen = new Map<string, { first: string; n: number }>();
  for (const c of item.history) {
    const day = seen.get(c.effectiveFrom);
    if (day) day.n += 1;
    else seen.set(c.effectiveFrom, { first: c.id, n: 1 });
  }
  return new Set([...seen.values()].filter((d) => d.n > 1).map((d) => d.first));
}

/** 'from Dec 1, 2026', or 'since the start' for the starting value (the only row nobody set, dated far in the past). */
export function fromWords(change: BusinessRuleChange): string {
  return change.setByName === null ? 'since the start' : `from ${showDay(change.effectiveFrom)}`;
}

/** The Manila day a row was made. */
export function madeOn(change: BusinessRuleChange): string {
  return showDay(toBusinessDate(change.createdAt));
}

/**
 * T-512 (T-511 S5c) - the CLOSED registry of business rules an admin may change. docs/tasks/512-business-rules-s5c-spec.md.
 *
 * DB-free leaf: no `@shareat/db` import, so the settings screen and pure code read it alike. The values live in `business_rule_values`
 * (migration 0239), one dated row per change; this file says which keys exist, what they are called on screen, their starting value
 * (used when an org has no row) and their bounds. A typo in a key is a compile error here and a refusal in the writer.
 *
 * Adding a rule (T-519 adds `payroll.deduction_cap_percent`) is ONE entry here plus its caller; no migration for the table, only a seed
 * row if existing orgs need a starting row (the reader falls back to `default` when a row is absent).
 *
 * `default`, `min` and `max` are decimal strings with at most two decimals: money is pesos (centavos exact), a percent is exact in basis
 * points (percent x 100). A test pins that migration 0239's seed values equal these defaults.
 */

/** The one right that moves any rule today. A rule that needs another capability must widen `RuleDefinition.capability` and make the writer authorize it. */
export const RULE_ADMIN_CAPABILITY = 'manage_business_rules' as const;

export interface RuleDefinition {
  /** Plain words for the screen: never the key. */
  readonly label: string;
  /** One sentence saying what the number does. */
  readonly help: string;
  readonly unit: 'money' | 'percent';
  readonly default: string;
  readonly min: string;
  readonly max: string;
  readonly capability: typeof RULE_ADMIN_CAPABILITY;
  /** The key's first dotted segment; the screen groups by it. */
  readonly namespace: 'settlement' | 'tax';
}

export const RULE_REGISTRY = {
  'settlement.variance_floor_amount': {
    label: 'Smallest settlement difference that counts as large (pesos)',
    help: 'A platform payout can differ from what we expected by a few pesos and still be fine. A difference counts as large only when it is more than this amount and also more than the percent below. A large difference is marked on the review screen, and a settlement short by that much cannot be recorded until it is looked into.',
    unit: 'money',
    default: '50.00',
    min: '0',
    max: '100000',
    capability: RULE_ADMIN_CAPABILITY,
    namespace: 'settlement',
  },
  'settlement.variance_percent': {
    label: 'Settlement difference that counts as large (% of the day’s sales)',
    help: 'How far a platform payout may differ from what we expected, as a share of that day’s sales, before the difference counts as large. It works together with the smallest amount above: the difference must be more than both.',
    unit: 'percent',
    default: '10',
    min: '0',
    max: '100',
    capability: RULE_ADMIN_CAPABILITY,
    namespace: 'settlement',
  },
  'settlement.loan_final_tolerance': {
    label: 'Most the last loan payment may be short and still match (pesos)',
    help: 'A platform sometimes takes a centavo less on the final payment of a loan. A last payment short by no more than this still counts as paid in full.',
    unit: 'money',
    default: '0.01',
    min: '0',
    max: '1',
    capability: RULE_ADMIN_CAPABILITY,
    namespace: 'settlement',
  },
  'tax.withholding_rate_percent': {
    label: 'Tax withheld on each Foodpanda order (%)',
    help: 'The share of each Foodpanda order that Foodpanda holds back as tax. The system uses it to check the amount on the statement and to match the rounding to the invoice total.',
    unit: 'percent',
    default: '0.5',
    min: '0',
    max: '100',
    capability: RULE_ADMIN_CAPABILITY,
    namespace: 'tax',
  },
  'tax.vat_percent': {
    label: 'VAT included in a Foodpanda order amount (%)',
    help: 'Foodpanda order amounts already include VAT. The system takes it out before checking the tax withheld, so 12 means an amount is divided by 1.12.',
    unit: 'percent',
    default: '12',
    min: '0',
    max: '100',
    capability: RULE_ADMIN_CAPABILITY,
    namespace: 'tax',
  },
} as const satisfies Record<string, RuleDefinition>;

export type BusinessRuleKey = keyof typeof RULE_REGISTRY;

/** Own keys only: `'toString'`, `'__proto__'` and any near miss are not rules. */
export function isBusinessRuleKey(key: string): key is BusinessRuleKey {
  return Object.prototype.hasOwnProperty.call(RULE_REGISTRY, key);
}

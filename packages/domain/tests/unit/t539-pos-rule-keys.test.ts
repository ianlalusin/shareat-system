import { describe, expect, it } from 'vitest';
import { RULE_REGISTRY, isBusinessRuleKey, type BusinessRuleKey } from '../../src/business-rules/registry';
import { buildRuleBook } from '../../src/business-rules/book';

/**
 * T-539 S1 TESTER - the two POS rule keys, the `hour` unit, and the new VAT wording. docs/tasks/539-pos-business-rule-keys.md R1, R2, R5.
 *
 * RED today: the registry has neither POS key, `RuleValue.hour()` does not exist, and the VAT label is still the Foodpanda one.
 *
 * NOTE for the builder: t512-registry.test.ts pins "exactly the five keys" and the namespace set {settlement, tax}; both must be narrowed to
 * "the five T-512 keys are present, unchanged" when the two POS keys land (the spec widens `namespace` to include 'pos'). Not edited here.
 */
const SC = 'pos.senior_pwd_discount_percent' as BusinessRuleKey;
const HOUR = 'pos.business_day_start_hour' as BusinessRuleKey;
const VAT: BusinessRuleKey = 'tax.vat_percent';
const FLOOR: BusinessRuleKey = 'settlement.variance_floor_amount';

// A throw only counts when it is the unit/range refusal, not a missing method or a key the registry does not know yet (those would make every "throws" test green today).
const refuses = (fn: () => unknown): void => {
  let err: unknown;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  expect(err, 'did not throw').toBeInstanceOf(Error);
  expect((err as Error).message).not.toMatch(/is not a function|not in the registry|undefined/);
};

const def = (k: string) => (RULE_REGISTRY as Record<string, Record<string, unknown>>)[k];

// A real UUID shape is not needed by the pure book; the id only breaks ties.
const row = (key: string, value: string, effectiveFrom: string, n: number) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  key,
  value,
  effectiveFrom,
  createdAt: new Date('2026-01-01T00:00:00Z'),
});
// `hour()` is the API under test; the book type does not carry it yet.
type WithHour = { hour(): number };
const hourOf = (value: string) => buildRuleBook([row(HOUR, value, '2026-01-01', 1)]).valueOn(HOUR, '2026-11-06') as unknown as WithHour;

describe('T-539 registry - the two POS keys', () => {
  it('pos.senior_pwd_discount_percent: percent, default 20, bounds 0..100, namespace pos, admin capability, exact label [kills: a wrong default, unit or bound]', () => {
    expect(isBusinessRuleKey('pos.senior_pwd_discount_percent')).toBe(true);
    expect(def('pos.senior_pwd_discount_percent')).toMatchObject({
      label: 'Senior citizen and PWD discount (%)',
      unit: 'percent',
      default: '20',
      min: '0',
      max: '100',
      namespace: 'pos',
      capability: 'manage_business_rules',
    });
  });

  it('pos.business_day_start_hour: hour, default 4, bounds 0..23, namespace pos, admin capability, exact label [kills: a wrong default, unit or bound]', () => {
    expect(isBusinessRuleKey('pos.business_day_start_hour')).toBe(true);
    expect(def('pos.business_day_start_hour')).toMatchObject({
      label: 'Hour a new POS business day starts (0–23)',
      unit: 'hour',
      default: '4',
      min: '0',
      max: '23',
      namespace: 'pos',
      capability: 'manage_business_rules',
    });
  });

  it('pos.table_warn_minutes (S3): minutes, default 90, bounds 1..600, namespace pos, admin capability, exact label and help [kills: a wrong default, unit or bound]', () => {
    expect(isBusinessRuleKey('pos.table_warn_minutes')).toBe(true);
    expect(def('pos.table_warn_minutes')).toMatchObject({
      label: 'Minutes before a table tile turns red',
      help: 'A table seated longer than this shows a red time bar on the POS Orders screen, so staff check on it.',
      unit: 'minutes',
      default: '90',
      min: '1',
      max: '600',
      namespace: 'pos',
      capability: 'manage_business_rules',
    });
  });

  it('the help texts say what the number does, in the spec words [kills: a help that drifted from the spec]', () => {
    expect(def('pos.senior_pwd_discount_percent')!.help).toBe(
      'The discount the law gives a senior citizen or a person with disability on their own share of the bill, after VAT is taken out of that share. The law sets it at 20. Change it only when the law changes.',
    );
    expect(def('pos.business_day_start_hour')!.help).toBe(
      'Until a store closes its first day on the POS, a sale made before this hour belongs to the day before. 4 means a sale at 3:30 in the morning counts for yesterday. After the first day close, the day runs from close to close.',
    );
  });

  it('tax.vat_percent keeps its key, unit, default and bounds, and takes the new label and help [kills: a second VAT row; a moved default]', () => {
    expect(def('tax.vat_percent')).toMatchObject({
      label: 'VAT included in prices (%)',
      unit: 'percent',
      default: '12',
      min: '0',
      max: '100',
      namespace: 'tax',
    });
    expect(def('tax.vat_percent')!.help).toBe(
      'Prices and platform order amounts already include VAT. 12 means an amount is divided by 1.12 to take the VAT out. The POS uses it for every bill and senior/PWD discount, and the settlement checks use it for Foodpanda statements.',
    );
    // one VAT rate, not two rows that could drift apart
    expect(Object.keys(RULE_REGISTRY).filter((k) => /vat/i.test(k))).toEqual(['tax.vat_percent']);
  });

  it('the other T-512 rules keep their old values (the registry only grew) [kills: an edit to an existing default]', () => {
    expect(def('settlement.variance_floor_amount')).toMatchObject({ default: '50.00', unit: 'money', min: '0', max: '100000' });
    expect(def('settlement.variance_percent')).toMatchObject({ default: '10', unit: 'percent' });
    expect(def('settlement.loan_final_tolerance')).toMatchObject({ default: '0.01', unit: 'money', max: '1' });
    expect(def('tax.withholding_rate_percent')).toMatchObject({ default: '0.5', unit: 'percent' });
  });
});

// `minutes()` is the S3 API under test.
const TABLE: BusinessRuleKey = 'pos.table_warn_minutes';
const minutesOf = (value: string) => buildRuleBook([row(TABLE, value, '2026-01-01', 1)]).valueOn(TABLE, '2026-11-06');

describe('T-539 S3 rule book - minutes()', () => {
  it('a minutes rule with no row answers its default as the whole number 90, unit minutes [kills: minutes() missing; a float; a wrong default]', () => {
    const v = buildRuleBook([]).valueOn(TABLE, '2026-11-06');
    expect(v.unit).toBe('minutes');
    expect(v.minutes()).toBe(90);
    expect(typeof v.minutes()).toBe('number');
  });

  it('a stored row wins and is read exactly: 1, 30, 600 [kills: an off-by-one at either end]', () => {
    expect(minutesOf('1.000000').minutes()).toBe(1);
    expect(minutesOf('30.000000').minutes()).toBe(30);
    expect(minutesOf('600.000000').minutes()).toBe(600);
  });

  it('minutes() throws on a stored 30.5 or 30.000001, never rounding [kills: truncating a fraction of a minute]', () => {
    expect(minutesOf('30').minutes()).toBe(30); // control
    for (const bad of ['30.5', '30.500000', '30.000001']) refuses(() => minutesOf(bad).minutes());
  });

  it('minutes() throws on money, percent and hour rules; money, percent and hour conversions throw on a minutes rule [kills: minutes() accepting any unit]', () => {
    const book = buildRuleBook([]);
    expect(book.valueOn(TABLE, '2026-11-06').minutes()).toBe(90); // control
    for (const k of [VAT, SC, HOUR, FLOOR]) refuses(() => book.valueOn(k, '2026-11-06').minutes());
    const v = book.valueOn(TABLE, '2026-11-06');
    refuses(() => v.centavos());
    refuses(() => v.basisPoints());
    refuses(() => (v as unknown as WithHour).hour());
  });
});

describe('T-539 rule book - hour() and the POS percent', () => {
  it('an hour rule with no row answers its default as the whole number 4, unit hour [kills: hour() missing; a float]', () => {
    const v = buildRuleBook([]).valueOn(HOUR, '2026-11-06');
    expect(v.unit).toBe('hour');
    expect((v as unknown as WithHour).hour()).toBe(4);
    expect(Number(v.text)).toBe(4);
  });

  it('a stored row wins and hour() reads it exactly across 0..23 [kills: an off-by-one at either end]', () => {
    expect(hourOf('0.000000').hour()).toBe(0);
    expect(hourOf('16.000000').hour()).toBe(16);
    expect(hourOf('23.000000').hour()).toBe(23);
    expect(typeof hourOf('23.000000').hour()).toBe('number');
  });

  it('the senior/PWD percent reads as 2000 basis points by default and 2500 from its start day [kills: 20 read as 20n]', () => {
    expect(buildRuleBook([]).valueOn(SC, '2026-11-06').basisPoints()).toBe(2000n);
    const b = buildRuleBook([row(SC, '25.000000', '2026-12-01', 2)]);
    expect(b.valueOn(SC, '2026-11-30').basisPoints()).toBe(2000n);
    expect(b.valueOn(SC, '2026-12-01').basisPoints()).toBe(2500n);
  });

  it('hour() throws on a percent rule and on a money rule [kills: hour() accepting any unit]', () => {
    expect(hourOf('4').hour()).toBe(4); // control: hour() exists and works on an hour rule
    const book = buildRuleBook([]);
    refuses(() => (book.valueOn(TABLE, '2026-11-06') as unknown as WithHour).hour());
    refuses(() => (book.valueOn(VAT, '2026-11-06') as unknown as WithHour).hour());
    refuses(() => (book.valueOn(SC, '2026-11-06') as unknown as WithHour).hour());
    refuses(() => (book.valueOn(FLOOR, '2026-11-06') as unknown as WithHour).hour());
  });

  it('hour() throws on a stored 4.5, 4.000001 or 24 [kills: rounding or truncating an hour; an hour past 23]', () => {
    expect(hourOf('4').hour()).toBe(4); // control: a whole hour reads
    for (const bad of ['4.5', '4.500000', '4.000001', '24', '24.000000']) refuses(() => hourOf(bad).hour());
  });

  it('centavos() and basisPoints() throw on an hour [kills: an hour read as money or a percent]', () => {
    const v = buildRuleBook([]).valueOn(HOUR, '2026-11-06');
    expect((v as unknown as WithHour).hour()).toBe(4); // control: the hour reads as an hour
    refuses(() => v.basisPoints());
    refuses(() => v.centavos());
  });

  it('the old conversions are unchanged: money is centavos, a percent is basis points, and each refuses the other [kills: a regression in the existing units]', () => {
    const book = buildRuleBook([]);
    expect(book.valueOn(FLOOR, '2026-11-06').centavos()).toBe(5000n);
    expect(book.valueOn(VAT, '2026-11-06').basisPoints()).toBe(1200n);
    expect(() => book.valueOn(FLOOR, '2026-11-06').basisPoints()).toThrow();
    expect(() => book.valueOn(VAT, '2026-11-06').centavos()).toThrow();
  });
});

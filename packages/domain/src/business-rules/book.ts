/**
 * T-512 (T-511 S5c) - the pure half of the rule reader: which row of a rule is in force on a date, and the exact conversions.
 *
 * DB-free. `loadRuleBook` (rules.ts) reads every row of the keys it is asked for in ONE statement and hands them here; asking the book
 * for any key and date afterwards costs nothing, so a batched caller stays flat.
 *
 * In force on a date = the row with the greatest (effectiveFrom, createdAt, id) among rows whose effectiveFrom <= date; none -> the registry default.
 * Money comes out as bigint centavos and a percent as bigint basis points (percent x 100), by scaled integer arithmetic, never a float. A stored
 * figure finer than a centavo / a basis point is refused, never rounded.
 */
import { internalFault } from '../shared/refusal-leaf';
import { RULE_REGISTRY, isBusinessRuleKey, type BusinessRuleKey, type RuleUnit } from './registry';

export interface RuleRowInput {
  readonly id: string;
  readonly key: string;
  /** The stored numeric text, e.g. '50.000000'. */
  readonly value: string;
  /** YYYY-MM-DD. */
  readonly effectiveFrom: string;
  readonly createdAt: Date;
}

/** A rule's value on one date. */
export interface RuleValue {
  readonly key: BusinessRuleKey;
  readonly unit: RuleUnit;
  /** The number as text ('80.000000', or the registry default '50.00'). */
  readonly text: string;
  /** Money only: whole centavos. Throws for a percent or for a figure finer than a centavo. */
  centavos(): bigint;
  /** Percent only: percent x 100. Throws for money or for a figure finer than a hundredth of a percent. */
  basisPoints(): bigint;
  /** Hour only: a whole number from 0 to 23. Throws for any other unit or a stored figure that is not a whole hour. */
  hour(): number;
  /** Minutes only: a whole number of minutes. Throws for any other unit or a stored figure that is not a whole number. */
  minutes(): number;
  /** Days only: a whole number of days. Throws for any other unit or a stored figure that is not a whole number. */
  days(): number;
  /** Flag only: true for 1, false for 0. Throws for any other unit or a stored figure that is neither. */
  flag(): boolean;
}

export interface RuleBook {
  /** Throws for a key outside the registry (or, when the book was loaded for named keys, one it was not loaded for). */
  valueOn(key: BusinessRuleKey, date: string): RuleValue;
}

const DECIMAL = /^\d+(\.\d+)?$/;
const SCALE = 6;

/** Text of a non-negative decimal as an integer count of 10^-6, or throws. */
function scaled(text: string, what: string): bigint {
  if (!DECIMAL.test(text)) throw internalFault(`business rule ${what}: not a non-negative decimal: ${JSON.stringify(text)}`);
  const [whole = '0', frac = ''] = text.split('.');
  if (frac.length > SCALE && /[1-9]/.test(frac.slice(SCALE))) throw internalFault(`business rule ${what}: finer than 6 decimals: ${text}`);
  return BigInt(whole) * 10n ** BigInt(SCALE) + BigInt(frac.slice(0, SCALE).padEnd(SCALE, '0'));
}

/** money centavos and percent basis points are both value x 100: scaled / 10^4, which must be exact. */
function hundredths(text: string, what: string): bigint {
  const n = scaled(text, what);
  if (n % 10_000n !== 0n) throw internalFault(`business rule ${what}: ${text} is finer than two decimals`);
  return n / 10_000n;
}

const KIND_WORD: Record<RuleUnit, string> = { money: 'money', percent: 'a percent', hour: 'an hour', minutes: 'minutes', days: 'days', flag: 'a flag' };

function valueOf(key: BusinessRuleKey, text: string): RuleValue {
  const unit = RULE_REGISTRY[key].unit as RuleUnit; // widened: no `flag` key exists yet (T-576 adds the first)
  return {
    key,
    unit,
    text,
    centavos() {
      if (unit !== 'money') throw internalFault(`business rule ${key} is ${KIND_WORD[unit]}, not money`);
      return hundredths(text, key);
    },
    basisPoints() {
      if (unit !== 'percent') throw internalFault(`business rule ${key} is ${KIND_WORD[unit]}, not a percent`);
      return hundredths(text, key);
    },
    hour() {
      if (unit !== 'hour') throw internalFault(`business rule ${key} is ${unit}, not an hour`);
      const n = scaled(text, key);
      if (n % 1_000_000n !== 0n || n > 23_000_000n) throw internalFault(`business rule ${key}: ${text} is not a whole hour from 0 to 23`);
      return Number(n / 1_000_000n);
    },
    minutes() {
      if (unit !== 'minutes') throw internalFault(`business rule ${key} is ${unit}, not minutes`);
      const n = scaled(text, key);
      if (n % 1_000_000n !== 0n) throw internalFault(`business rule ${key}: ${text} is not a whole number of minutes`);
      return Number(n / 1_000_000n);
    },
    days() {
      if (unit !== 'days') throw internalFault(`business rule ${key} is ${unit}, not days`);
      const n = scaled(text, key);
      if (n % 1_000_000n !== 0n) throw internalFault(`business rule ${key}: ${text} is not a whole number of days`);
      return Number(n / 1_000_000n);
    },
    flag() {
      if (unit !== 'flag') throw internalFault(`business rule ${key} is ${unit}, not a flag`);
      const n = scaled(text, key);
      if (n !== 0n && n !== 1_000_000n) throw internalFault(`business rule ${key}: ${text} is not 0 or 1`);
      return n === 1_000_000n;
    },
  };
}

/** Positive when `a` is in force over `b`: later start day, then later creation, then the greater id. ISO days and lowercase UUIDs order the same under localeCompare as byte order. */
const order = (a: RuleRowInput, b: RuleRowInput): number =>
  a.effectiveFrom.localeCompare(b.effectiveFrom) || a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id);

/** `loaded` (when given) is the keys the rows were read for: asking for another key then throws instead of quietly answering its default. */
export function buildRuleBook(rows: readonly RuleRowInput[], loaded?: readonly BusinessRuleKey[]): RuleBook {
  const byKey = new Map<string, RuleRowInput[]>();
  for (const r of rows) {
    const list = byKey.get(r.key);
    if (list) list.push(r);
    else byKey.set(r.key, [r]);
  }
  return {
    valueOn(key, date) {
      if (!isBusinessRuleKey(key)) throw internalFault(`business rule: ${JSON.stringify(key)} is not in the registry`);
      if (loaded && !loaded.includes(key)) throw internalFault(`business rule ${key} was not loaded into this book`);
      let best: RuleRowInput | undefined;
      for (const r of byKey.get(key) ?? []) if (r.effectiveFrom.localeCompare(date) <= 0 && (!best || order(r, best) > 0)) best = r;
      return valueOf(key, best ? best.value : RULE_REGISTRY[key].default);
    },
  };
}

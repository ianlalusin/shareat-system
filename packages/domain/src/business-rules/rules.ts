/**
 * T-512 (T-511 S5c) - read and change the business rules. docs/tasks/512-business-rules-s5c-spec.md "Reader and writer".
 *
 * SERVER-ONLY (imports `@shareat/db`); the client-safe leaf is `./index.ts`, which must not import this file. The pure half (which row is in
 * force on a date, the exact conversions) is `./book.ts`; the closed list of keys is `./registry.ts`.
 *
 * Reader: `loadRuleBook` costs ONE query for any number of keys and dates, so a batched path stays flat; `ruleValue` is the one-off form.
 * Writer: `setBusinessRule` is admin only (`manage_business_rules`, the gate FIRST), refuses a key or value the registry does not allow, a
 * missing or enormous reason, and a start day before today (Manila business date, judged by the field rule: a mistake is fixed by a newer row,
 * never by rewriting the past). It only INSERTs; the table refuses UPDATE and DELETE (migration 0239). The audit row is written in the same transaction.
 */
import { authorize, type Actor } from '@shareat/auth';
import { auditLogRepo, businessRulesRepo, type Tx } from '@shareat/db';
import { toBusinessDate } from '@shareat/core/datetime';
import { decimal } from '@shareat/core/money';
import { SETTINGS_BUSINESS_RULE_RULES } from '../field-rules/settings';
import { capAuditText } from '../shared/audit-text';
import { assertFieldRules } from '../shared/field-rules-assert';
import { refuse } from '../shared/refusal';
import { internalFault } from '../shared/refusal-leaf';
import { buildRuleBook, type RuleBook, type RuleValue } from './book';
import { RULE_ADMIN_CAPABILITY, RULE_REGISTRY, isBusinessRuleKey, type BusinessRuleKey, type RuleDefinition } from './registry';

const ALL_KEYS = Object.keys(RULE_REGISTRY) as BusinessRuleKey[];

/** One statement for every row of `keys`; the answers for any date then cost nothing. */
export async function loadRuleBook(tx: Tx, orgId: string, keys: readonly BusinessRuleKey[]): Promise<RuleBook> {
  for (const k of keys) if (!isBusinessRuleKey(k)) throw internalFault(`business rule: ${JSON.stringify(k)} is not in the registry`);
  return buildRuleBook(await businessRulesRepo.listRuleValueRows(tx, orgId, keys), keys);
}

/** One rule on one date. Prefer `loadRuleBook` when more than one answer is needed. */
export async function ruleValue(tx: Tx, orgId: string, key: BusinessRuleKey, onDate: string): Promise<RuleValue> {
  return (await loadRuleBook(tx, orgId, [key])).valueOn(key, onDate);
}

// -------------------------------------------------------------------------------------------------------------------
// The writer
// -------------------------------------------------------------------------------------------------------------------
/** A plain decimal with at most two places (the field rule has already said so) as a count of hundredths. */
function hundredths(text: string): bigint {
  const [whole = '0', frac = ''] = text.split('.');
  return BigInt(whole) * 100n + BigInt(frac.padEnd(2, '0'));
}

function checkedBounds(def: RuleDefinition, key: string, value: string): void {
  const n = hundredths(value);
  if (n < hundredths(def.min) || n > hundredths(def.max)) {
    throw refuse(`business rule ${key}: out of bounds`, `${def.label} must be between ${def.min} and ${def.max}.`);
  }
}

/** '50.000000' -> '50', '0.500000' -> '0.5' */
const plain = (text: string): string => (text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text);

// A NUL (Postgres refuses it as a raw error) or any other control character except tab, line break and carriage return, which a typed reason may hold.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;
/** Zero-width characters print as nothing, so a reason made only of them is blank; they are dropped before the blank check and never stored. */
const ZERO_WIDTH = /[\u200B-\u200D\uFEFF]/g;

export interface SetBusinessRuleInput {
  readonly key: string;
  /** A plain decimal with at most two places, in the key's unit (pesos or percent). */
  readonly value: string;
  /** YYYY-MM-DD, today (Manila) or later. */
  readonly effectiveFrom: string;
  readonly reason: string;
}

/**
 * Schedules a new value for one rule from a date. Admin only. The value in force before it is read first and goes into the audit row.
 * Audited as `business_rule.changed`, in the same transaction.
 */
export async function setBusinessRule(tx: Tx, actor: Actor, input: SetBusinessRuleInput): Promise<{ id: string; key: BusinessRuleKey; value: string; effectiveFrom: string }> {
  await authorize(tx, actor, RULE_ADMIN_CAPABILITY, {});
  if (!isBusinessRuleKey(input.key)) throw refuse(`business rule: unknown key ${JSON.stringify(input.key)}`, 'That is not a rule that can be changed here.');
  const key = input.key;
  const def: RuleDefinition = RULE_REGISTRY[key];
  // The shape of the value, a real start day that is not before today (Manila), and the reason: one definition shared with the screen's live line.
  if (CONTROL_CHARS.test(input.reason)) throw refuse('business rule: reason holds a control character', 'The reason may only hold ordinary text. Remove any unusual characters and try again.');
  const typed = assertFieldRules(SETTINGS_BUSINESS_RULE_RULES, { value: input.value, effectiveFrom: input.effectiveFrom, reason: input.reason.replace(ZERO_WIDTH, '') });
  const value = typed.value!;
  const effectiveFrom = typed.effectiveFrom!;
  const reason = typed.reason!;
  checkedBounds(def, key, value);

  const before = await ruleValue(tx, actor.orgId, key, effectiveFrom);
  const row = await businessRulesRepo.insertRuleValue(tx, { orgId: actor.orgId, key, value: decimal(value, '18,6'), effectiveFrom, setBy: actor.personId, reason });
  await auditLogRepo.append(tx, actor.orgId, {
    actorPersonId: actor.personId,
    action: 'business_rule.changed',
    storeId: null,
    entityId: row.id,
    before: { key, value: plain(before.text) },
    after: { key, value, effectiveFrom, reason: capAuditText(reason) },
    source: 'web',
  });
  return { id: row.id, key, value, effectiveFrom };
}

// -------------------------------------------------------------------------------------------------------------------
// The screen's read
// -------------------------------------------------------------------------------------------------------------------
export interface BusinessRuleChange {
  readonly id: string;
  /** The stored number as text ('70.000000'). */
  readonly value: string;
  readonly effectiveFrom: string;
  /** When the row was made. */
  readonly createdAt: Date;
  /** Null for the starting value migration 0239 wrote. */
  readonly setByName: string | null;
  readonly reason: string;
}

export interface BusinessRuleItem {
  readonly key: BusinessRuleKey;
  readonly label: string;
  readonly help: string;
  readonly unit: 'money' | 'percent';
  readonly namespace: 'settlement' | 'tax';
  readonly min: string;
  readonly max: string;
  /** The value in force today (Manila), as text. A rule with no row shows its starting value. */
  readonly current: string;
  /** Rows that start after today, soonest first. */
  readonly scheduled: readonly BusinessRuleChange[];
  /** Every row, newest first. */
  readonly history: readonly BusinessRuleChange[];
}

/** Every rule with what is in force today, what is scheduled and who changed what. Admin only (`manage_business_rules`). */
export async function listBusinessRules(tx: Tx, actor: Actor): Promise<BusinessRuleItem[]> {
  await authorize(tx, actor, RULE_ADMIN_CAPABILITY, {});
  const today = toBusinessDate();
  const rows = await businessRulesRepo.listRuleHistoryRows(tx, actor.orgId, ALL_KEYS);
  const book = buildRuleBook(rows, ALL_KEYS);
  return ALL_KEYS.map((key) => {
    const def: RuleDefinition = RULE_REGISTRY[key];
    const mine: BusinessRuleChange[] = rows
      .filter((r) => r.key === key)
      .map((r) => ({ id: r.id, value: r.value, effectiveFrom: r.effectiveFrom, createdAt: r.createdAt, setByName: r.setByName, reason: r.reason }));
    return {
      key,
      label: def.label,
      help: def.help,
      unit: def.unit,
      namespace: def.namespace,
      min: def.min,
      max: def.max,
      current: book.valueOn(key, today).text,
      scheduled: mine.filter((r) => r.effectiveFrom.localeCompare(today) > 0),
      history: [...mine].reverse(),
    };
  });
}

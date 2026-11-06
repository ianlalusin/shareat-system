/**
 * The only place SQL is written for business rules. T-512 (T-511 S5c).
 *
 * `business_rule_values` is append-only (migration 0239): this file only INSERTs and SELECTs. Which row is "in force" on a date is
 * NOT decided here (that is `buildRuleBook` in the domain, pure and tested); the reads return every row of the keys asked for, in one
 * statement, so a batched caller (`listReviewDays`) stays flat. Every read filters by the org; RLS backstops (bible section 15.11).
 */
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Tx } from '../client';
import { businessRuleValues } from '../../schema/business-rules';
import { persons } from '../../schema/persons';
import type { Decimal } from '@shareat/core/money';

/** A rule row as the reader needs it (value is the stored numeric text, e.g. '50.000000'). */
export interface RuleValueRow {
  id: string;
  key: string;
  value: string;
  effectiveFrom: string;
  createdAt: Date;
}

/** A rule row as the screen shows it: who set it (null for the seed) and why. */
export interface RuleHistoryRow extends RuleValueRow {
  setBy: string | null;
  setByName: string | null;
  reason: string;
}

export async function insertRuleValue(
  tx: Tx,
  input: { orgId: string; key: string; value: Decimal<'18,6'>; effectiveFrom: string; setBy: string; reason: string },
): Promise<{ id: string }> {
  const [row] = await tx
    .insert(businessRuleValues)
    .values({ orgId: input.orgId, key: input.key, value: input.value, effectiveFrom: input.effectiveFrom, setBy: input.setBy, reason: input.reason })
    .returning({ id: businessRuleValues.id });
  return row!;
}

/** Every row of the given keys for the org, one statement. Order is not meaningful (the book sorts). */
export async function listRuleValueRows(tx: Tx, orgId: string, keys: readonly string[]): Promise<RuleValueRow[]> {
  if (keys.length === 0) return [];
  return tx
    .select({
      id: businessRuleValues.id,
      key: businessRuleValues.key,
      value: businessRuleValues.value,
      effectiveFrom: businessRuleValues.effectiveFrom,
      createdAt: businessRuleValues.createdAt,
    })
    .from(businessRuleValues)
    .where(and(eq(businessRuleValues.orgId, orgId), inArray(businessRuleValues.key, [...keys])));
}

/** Every row of the given keys with who set it and why, oldest first. For the screen. */
export async function listRuleHistoryRows(tx: Tx, orgId: string, keys: readonly string[]): Promise<RuleHistoryRow[]> {
  if (keys.length === 0) return [];
  return tx
    .select({
      id: businessRuleValues.id,
      key: businessRuleValues.key,
      value: businessRuleValues.value,
      effectiveFrom: businessRuleValues.effectiveFrom,
      createdAt: businessRuleValues.createdAt,
      setBy: businessRuleValues.setBy,
      setByName: persons.displayName,
      reason: businessRuleValues.reason,
    })
    .from(businessRuleValues)
    .leftJoin(persons, and(eq(persons.orgId, businessRuleValues.orgId), eq(persons.id, businessRuleValues.setBy)))
    .where(and(eq(businessRuleValues.orgId, orgId), inArray(businessRuleValues.key, [...keys])))
    .orderBy(asc(businessRuleValues.effectiveFrom), asc(businessRuleValues.createdAt), asc(businessRuleValues.id));
}

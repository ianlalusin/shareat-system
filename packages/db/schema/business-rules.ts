/**
 * T-512 (T-511 S5c, migration 0239) - the business rules an admin may change, as dated rows.
 * docs/tasks/512-business-rules-s5c-spec.md.
 *
 * ONE generic table. A rule is a `key` from the closed registry in `packages/domain/src/business-rules/registry.ts` (a typo is a
 * compile error there, and the writer refuses it at runtime); this table only holds the numbers.
 *
 * APPEND-ONLY, like `pay_rates`, and there is no `effective_to`. The value in force on a date is the row with the greatest
 * `(effective_from, created_at, id)` among rows whose `effective_from <= date`. A same-day correction is a NEWER row, which is why
 * there is no unique index. A mistake is never edited: it is superseded.
 *
 * `set_by` is null only for the seed rows migration 0239 writes (one per existing org per key, effective 2000-01-01).
 *
 * NOTE: hand-added in migration 0239 (the builder cannot say these): ENABLE + FORCE RLS and the policy
 * `business_rule_values_org_isolation` (app_current_org()); the trigger `business_rule_values_append_only` (BEFORE UPDATE OR DELETE,
 * refuses with restrict_violation) set ENABLE ALWAYS so `session_replication_role = 'replica'` does not bypass it, and its function
 * `business_rule_values_refuse_mutation`; the grants (the app role gets SELECT and INSERT only, UPDATE, DELETE and TRUNCATE are
 * revoked); and the seed INSERT. The `reason`, finite, non-negative and two-decimals CHECKs are mirrored below.
 */
import { sql } from 'drizzle-orm';
import { check, date, foreignKey, index, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { persons } from './persons';

export const businessRuleValues = pgTable(
  'business_rule_values',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /** A key of the registry, e.g. a settlement or tax rule. Plain text here; the registry is the closed set. */
    key: text('key').notNull(),
    /** Money (pesos) or a percent, by the key's unit. numeric(18,6) holds both exactly. */
    value: numeric('value', { precision: 18, scale: 6 }).notNull(),
    effectiveFrom: date('effective_from').notNull(),
    /** Who set it. Null only for the seed. */
    setBy: uuid('set_by'),
    reason: text('reason').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('business_rule_values_org_key_from_idx').on(t.orgId, t.key, t.effectiveFrom),
    check('business_rule_values_reason_check', sql`length(trim(${t.reason})) > 0`),
    check('business_rule_values_value_finite_check', sql`${t.value} > '-Infinity'::numeric and ${t.value} < 'Infinity'::numeric`),
    check('business_rule_values_value_nonneg_check', sql`${t.value} >= 0`),
    check('business_rule_values_value_two_decimals_check', sql`${t.value} = round(${t.value}, 2)`),
    // T-398 C1: same-org twin of the person reference (RLS checks only this row's org_id).
    foreignKey({
      columns: [t.orgId, t.setBy],
      foreignColumns: [persons.orgId, persons.id],
      name: 'business_rule_values_set_by_same_org_fk',
    }).onDelete('restrict'),
  ],
);

export type BusinessRuleValueRow = typeof businessRuleValues.$inferSelect;

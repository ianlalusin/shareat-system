/**
 * Payment options - the six of Ian's list (22-23 Nov 2026), seeded for a new org by `seedReferenceData` and for every existing org by migration 0277
 * (which carries its own copy of this list; `tests/unit/t629-payment-option-seed.test.ts` keeps the two equal). `docs/tasks/629-payment-options-master-list.md`.
 *
 * Cards are kept simple: a card is a `wallet` option tied (per store) to the bank money account the card machine pays into; the bank fee is booked later as a bank charge.
 * Idempotent and matched by NORMALISED name (lowercase, a-z0-9 only, the alias normalisation), so an org that already has "G-Cash" does not get a second GCash.
 */
import type postgres from 'postgres';

export interface PaymentOptionSeed {
  readonly name: string;
  readonly kind: 'cash' | 'wallet';
  readonly sortOrder: number;
}

export const PAYMENT_OPTION_SEED: readonly PaymentOptionSeed[] = [
  { name: 'Cash', kind: 'cash', sortOrder: 10 },
  { name: 'GCash', kind: 'wallet', sortOrder: 20 },
  { name: 'Maya', kind: 'wallet', sortOrder: 30 },
  { name: 'QRPH', kind: 'wallet', sortOrder: 40 },
  { name: 'Credit card', kind: 'wallet', sortOrder: 50 },
  { name: 'Debit card', kind: 'wallet', sortOrder: 60 },
];

/** Adds whichever of the six the org lacks. Returns how many were inserted. */
export async function seedPaymentOptions(sql: postgres.Sql, orgId: string): Promise<{ inserted: number }> {
  // Bound as text and cast in SQL (`(${json})::text::jsonb`): the same reason as `seedExpenseCategories` - it runs inside a Drizzle transaction and on a plain client.
  const rows = await sql<{ id: string }[]>`
    insert into payment_options (org_id, name, kind, sort_order)
    select ${orgId}::uuid, v.name, v.kind, v.sort_order
    from jsonb_to_recordset((${JSON.stringify(PAYMENT_OPTION_SEED.map((s) => ({ name: s.name, kind: s.kind, sort_order: s.sortOrder })))})::text::jsonb)
      as v(name text, kind text, sort_order integer)
    where not exists (
        select 1 from payment_options p
        where p.org_id = ${orgId}::uuid and regexp_replace(lower(p.name), '[^a-z0-9]', '', 'g') = regexp_replace(lower(v.name), '[^a-z0-9]', '', 'g'))
    returning payment_options.id
  `;
  return { inserted: rows.length };
}

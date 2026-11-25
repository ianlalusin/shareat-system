/**
 * Document kinds - the seven an organisation starts with (T-637, Ian 25 Nov 2026), seeded for a new org by `seedReferenceData` and for every existing org by migration 0281
 * (which carries its own copy of this list; `packages/db/tests/t637-document-kind-seed.test.ts` keeps the two equal). Ian edits the list on /documents/templates: add, rename, retire.
 *
 * The first five replace the old hard-coded enum (coe, memo, nte, contract, other) under readable names; the last two are new. Idempotent and matched by name ignoring case,
 * so an org that already has one of them does not get a second.
 */
import type postgres from 'postgres';

export interface DocumentKindSeed {
  readonly name: string;
  readonly sortOrder: number;
}

export const DOCUMENT_KIND_SEED: readonly DocumentKindSeed[] = [
  { name: 'Certificate of employment', sortOrder: 10 },
  { name: 'Memo', sortOrder: 20 },
  { name: 'Notice to explain', sortOrder: 30 },
  { name: 'Contract', sortOrder: 40 },
  { name: 'Other', sortOrder: 50 },
  { name: 'Explanation letter', sortOrder: 60 },
  { name: 'Incident report', sortOrder: 70 },
];

/** Adds whichever of the seven the org lacks. Returns how many were inserted. */
export async function seedDocumentKinds(sql: postgres.Sql, orgId: string): Promise<{ inserted: number }> {
  // Bound as text and cast in SQL, like `seedPaymentOptions`: it runs inside a Drizzle transaction and on a plain client.
  const rows = await sql<{ id: string }[]>`
    insert into document_kinds (org_id, name, sort_order)
    select ${orgId}::uuid, v.name, v.sort_order
    from jsonb_to_recordset((${JSON.stringify(DOCUMENT_KIND_SEED.map((s) => ({ name: s.name, sort_order: s.sortOrder })))})::text::jsonb) as v(name text, sort_order integer)
    where not exists (select 1 from document_kinds k where k.org_id = ${orgId}::uuid and lower(k.name) = lower(v.name))
    returning document_kinds.id
  `;
  return { inserted: rows.length };
}

import type postgres from 'postgres';
import type { Capability } from '@shareat/auth';

/**
 * The 21 capabilities T-318 (2026-09-14) moved off the automatic `staff` matrix cell onto
 * position grants — Ian's ruling to shrink the staff baseline
 * (`docs/tasks/318-position-decides-access.md`). Kept here as the one place a domain-integration
 * fixture needs the list; the reasoning for each lives in `docs/decisions/CAPABILITY-MATRIX.md`'s
 * Notes column, unchanged by the mechanism moving.
 */
export const EVERYDAY_CAPABILITIES: readonly Capability[] = [
  'record_sale',
  'submit_sales_day',
  'record_statutory_discount',
  'record_till_count',
  'create_expense',
  'edit_own_expense',
  'record_stock_movement',
  'record_wastage',
  'transfer_stock',
  'record_supplier_return',
  'record_customer_return',
  'confirm_receipt',
  'set_item_threshold',
  'post_order_message',
  'place_branch_order',
  'fulfil_branch_order',
  'receive_delivery',
  'record_supplier_invoice',
  'create_wholesale_order',
  'record_order_wastage',
  'request_pos_map',
];

/**
 * Give a 'staff' employment the everyday, position-granted access T-318 moved off the automatic
 * matrix. Inserts one ad-hoc position for this employment, defaults it for the requested
 * capabilities (default: all 21 of `EVERYDAY_CAPABILITIES`), links it to `employmentId` as the
 * primary position, and writes the matching `person_grants` rows directly — the same end state
 * `reconcilePositionGrants` (`packages/domain/src/people/position-defaults.ts`) produces, without
 * needing an `authorize()`-capable admin actor in every calling fixture.
 *
 * ⛔ **T-318: an open employment with NO position is a DATA ERROR** — migration `0152`'s backfill
 * refuses to run against one in production. A fixture that omits this call is modelling a state
 * production is not allowed to be in; the old bare-`insertRoleRaw`-only fixture was WRONG, not
 * merely under-provisioned. Call with `capabilities: []` for a test that specifically wants a
 * refused staff actor — the point of a refusal test is that NO position grants what is denied.
 *
 * ⚠️ Assumes `employmentId` has no primary position yet (`employment_positions_one_primary_unique`
 * would reject a second one). ⭐ **Corrected 2026-09-16 by the lane A measurement:** the original
 * sentence here said this was *"true of every fixture this exists to fix, which built a bare
 * employment with none"*. In fact most of those fixtures build **no `employments` row at all** —
 * they go straight to a raw role insert — so the caller usually has to create the employment
 * before calling this. The assumption still holds (a freshly inserted employment trivially has no
 * primary position); its stated reason did not, and a reason that is wrong is worse than none
 * (bible §13 row 206).
 *
 * ⛔ **`positionName` MUST be unique per (org, scope, name) — `positions_org_scope_name_unique`.**
 * The default below derives it from the FULL `employmentId` on purpose. ⚠️ **It used to use
 * `employmentId.slice(0, 8)` and that was a near-certain collision, not a rare one:** `uuidv7()`'s
 * first twelve hex characters are a 48-bit millisecond timestamp, so the first EIGHT are its top
 * 32 bits — which advance once every 65,536 ms. Measured 2026-09-16: five `uuidv7()` values minted
 * together share **one** eight-character prefix. So any two employments created within the same
 * ~65 seconds — i.e. any two in one test file — collided. Found by lane A hitting it for real in
 * `expenses-staff-float.test.ts`, and it would have hit slice C's own "two people, one store, two
 * different positions" test hardest of all.
 */
export async function grantEverydayPositionAccess(
  sql: postgres.Sql<{}>,
  args: {
    orgId: string;
    storeId: string;
    employmentId: string;
    personId: string;
    /** Any real `persons.id` in this org — attributed as who set the default and granted it.
     *  Does not need `grant_capability`: this writes the rows `setPositionDefault` would have
     *  written after checking it, not the check itself. */
    setBy: string;
    positionName?: string;
    capabilities?: readonly Capability[];
  },
): Promise<{ positionId: string }> {
  const capabilities = args.capabilities ?? EVERYDAY_CAPABILITIES;
  const positionName = args.positionName ?? `Everyday Access ${args.employmentId}`;

  const [position] = await sql<{ id: string }[]>`
    insert into positions (org_id, store_id, name, is_canonical)
    values (${args.orgId}, ${args.storeId}, ${positionName}, false)
    returning id
  `;
  const positionId = position!.id;

  await sql`
    insert into employment_positions (employment_id, position_id, is_primary)
    values (${args.employmentId}, ${positionId}, true)
  `;

  for (const capability of capabilities) {
    const [def] = await sql<{ id: string }[]>`
      insert into position_capability_defaults (org_id, position_id, store_id, capability, set_by)
      values (${args.orgId}, ${positionId}, ${args.storeId}, ${capability}, ${args.setBy})
      returning id
    `;
    await sql`
      insert into person_grants (person_id, grant_name, granted_by, grant_source, source_ref)
      values (${args.personId}, ${capability}, ${args.setBy}, 'position', ${def!.id})
    `;
  }

  return { positionId };
}

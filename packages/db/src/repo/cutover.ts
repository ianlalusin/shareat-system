/**
 * The only place SQL is written for the cutover. T-134.
 *
 * ⭐ Every `*Holds` function is a QUERY over real state. **None of them can be satisfied by a
 * click**, which is invariant 1 and the difference between a verified step and an honest tick.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { Tx } from '../client';
import { cutoverSteps, openingCounts } from '../../schema/cutover';
import { tablesInClass } from '../cutover/classification';

export const OPENING_EQUITY_CODE = '3900';

// -------------------------------------------------------------------------------------
// The verified checks
// -------------------------------------------------------------------------------------

/**
 * ⭐ C2 — every purge-class table is empty.
 *
 * ⚠️ Enumerated from `CUTOVER_CLASSIFICATION` at runtime, never a hand-written list: a table added
 * later and classified `purge` is covered without anybody remembering. That is the same lesson
 * DEF-077 taught, where an invariant was proven for one hand-picked table.
 */
export async function purgeComplete(
  tx: Tx,
  orgId: string,
): Promise<{ holds: boolean; remaining: { table: string; rows: number }[] }> {
  const tables = tablesInClass('purge');
  const remaining: { table: string; rows: number }[] = [];
  for (const table of tables) {
    const [row] = (await tx.execute(
      sql.raw(`select count(*)::text as n from "${table}" where org_id = '${orgId}'`),
    )) as unknown as Record<string, string>[];
    const n = Number(row?.n ?? 0);
    if (n > 0) remaining.push({ table, rows: n });
  }
  return { holds: remaining.length === 0, remaining };
}

/**
 * ⭐ C4 — `3900 Opening balance equity` nets to exactly zero.
 *
 * ⚠️ Counts the DRAFT entry too. The whole value of the running residual is that it is visible
 * while you are still typing: *an imbalance found on the tenth supplier is a typo; the same
 * imbalance found after the last one is an investigation.*
 */
export async function openingEquityResidual(tx: Tx, orgId: string): Promise<string> {
  const [row] = (await tx.execute(sql`
    select coalesce(sum(jl.credit - jl.debit), 0)::text as residual
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a on a.id = jl.account_id
    where je.org_id = ${orgId} and a.code = ${OPENING_EQUITY_CODE}
  `)) as unknown as Record<string, string>[];
  return Number(row?.residual ?? 0).toFixed(2);
}

/** C5 — debits equal credits across everything, draft included. */
export async function trialBalanceDrift(tx: Tx, orgId: string): Promise<string> {
  const [row] = (await tx.execute(sql`
    select coalesce(sum(jl.debit - jl.credit), 0)::text as drift
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    where je.org_id = ${orgId}
  `)) as unknown as Record<string, string>[];
  return Number(row?.drift ?? 0).toFixed(2);
}

/**
 * ⭐ B3 — every active item has a counted quantity at this store, **or an explicit zero**.
 *
 * Returns the items still missing a row. An item silently absent and an item counted as zero must
 * not look the same, so the absence is what is reported.
 */
export async function itemsWithoutCount(
  tx: Tx,
  orgId: string,
  storeId: string,
): Promise<{ itemId: string; name: string }[]> {
  const rows = (await tx.execute(sql`
    select i.id, i.name
    from items i
    where i.org_id = ${orgId} and i.status = 'active'
      and not exists (
        select 1 from opening_counts oc
        where oc.item_id = i.id and oc.store_id = ${storeId}
      )
    order by i.name
  `)) as unknown as Record<string, string>[];
  return rows.map((r) => ({ itemId: String(r.id), name: String(r.name) }));
}

/** Counted items that still have no cost — a quantity nobody can value. */
export async function countsWithoutCost(
  tx: Tx,
  orgId: string,
): Promise<{ itemId: string; name: string; storeId: string }[]> {
  const rows = (await tx.execute(sql`
    select oc.item_id, i.name, oc.store_id
    from opening_counts oc
    join items i on i.id = oc.item_id
    where oc.org_id = ${orgId} and oc.unit_cost is null and oc.quantity > 0
    order by i.name
  `)) as unknown as Record<string, string>[];
  return rows.map((r) => ({
    itemId: String(r.item_id),
    name: String(r.name),
    storeId: String(r.store_id),
  }));
}

// -------------------------------------------------------------------------------------
// Step completion
// -------------------------------------------------------------------------------------

export interface CutoverStepRow {
  stepCode: string;
  storeId: string | null;
  completion: 'verified' | 'attested' | 'performed';
  note: string | null;
  completedBy: string;
  completedAt: Date;
}

export async function recordedSteps(tx: Tx, orgId: string): Promise<CutoverStepRow[]> {
  const rows = await tx.select().from(cutoverSteps).where(eq(cutoverSteps.orgId, orgId));
  return rows as unknown as CutoverStepRow[];
}

export async function recordStep(
  tx: Tx,
  input: {
    orgId: string;
    storeId: string | null;
    stepCode: string;
    completion: 'verified' | 'attested' | 'performed';
    note: string | null;
    completedBy: string;
  },
): Promise<void> {
  // Re-attesting replaces: the latest statement by a named person is the record, and the old one
  // was never a posting.
  await tx.execute(sql`
    insert into cutover_steps (org_id, store_id, step_code, completion, note, completed_by)
    values (${input.orgId}, ${input.storeId}, ${input.stepCode}, ${input.completion},
            ${input.note}, ${input.completedBy})
    on conflict (org_id, step_code, coalesce(store_id, '00000000-0000-0000-0000-000000000000'::uuid))
    do update set completion = excluded.completion, note = excluded.note,
                  completed_by = excluded.completed_by, completed_at = now()
  `);
}

// -------------------------------------------------------------------------------------
// The opening count
// -------------------------------------------------------------------------------------

export async function upsertOpeningCount(
  tx: Tx,
  input: {
    orgId: string;
    storeId: string;
    itemId: string;
    quantity: string;
    unitCost: string | null;
    note: string | null;
    countedBy: string;
  },
): Promise<void> {
  await tx
    .insert(openingCounts)
    .values(input)
    .onConflictDoUpdate({
      target: [openingCounts.storeId, openingCounts.itemId],
      set: {
        quantity: input.quantity,
        unitCost: input.unitCost,
        note: input.note,
        countedBy: input.countedBy,
        countedAt: sql`now()`,
      },
    });
}

/** The valued total of everything counted — what the inventory opening figure should come to. */
export async function countedValue(tx: Tx, orgId: string, storeId?: string): Promise<string> {
  const [row] = (await tx.execute(sql`
    select coalesce(sum(oc.quantity * coalesce(oc.unit_cost, 0)), 0)::text as value
    from opening_counts oc
    where oc.org_id = ${orgId}
      ${storeId ? sql`and oc.store_id = ${storeId}` : sql``}
  `)) as unknown as Record<string, string>[];
  return Number(row?.value ?? 0).toFixed(2);
}

/**
 * ⛔ **The double-counting guard.** ADR-005 enters AR/AP as a lump per party, which is the
 * deliberate minority position — Xero and QuickBooks both recommend entering each outstanding
 * invoice individually. Ian weighed that and chose simplicity.
 *
 * ⚠️ **But the named failure mode of the lump approach must be guarded explicitly**: if a party's
 * opening lump AND a re-entered pre-cutover invoice both exist, the same money is counted twice.
 * This is what finds it.
 */
export async function partiesWithOpeningAndPreCutoverDocs(
  tx: Tx,
  orgId: string,
  conversionDate: string,
): Promise<{ partyType: string; partyId: string }[]> {
  const rows = (await tx.execute(sql`
    with opening as (
      select distinct jl.party_type, jl.party_id
      from journal_lines jl
      join journal_entries je on je.id = jl.entry_id
      where je.org_id = ${orgId} and je.source_type = 'opening_balance' and jl.party_id is not null
    )
    select o.party_type, o.party_id
    from opening o
    where exists (
      select 1
      from journal_lines jl2
      join journal_entries je2 on je2.id = jl2.entry_id
      where je2.org_id = ${orgId}
        and je2.source_type <> 'opening_balance'
        and je2.entry_date < ${conversionDate}
        and jl2.party_type = o.party_type and jl2.party_id = o.party_id
    )
  `)) as unknown as Record<string, string>[];
  return rows.map((r) => ({ partyType: String(r.party_type), partyId: String(r.party_id) }));
}

// -------------------------------------------------------------------------------------
// The opening drafts — C3's working set
// -------------------------------------------------------------------------------------

export interface OpeningDraft {
  id: string;
  entryDate: string;
  memo: string | null;
  accountCode: string;
  storeId: string | null;
  debit: string;
  credit: string;
  partyType: string | null;
  partyId: string | null;
}

/**
 * Every opening figure entered so far, still in draft.
 *
 * ⚠️ Returns the REAL account's line, not 3900's — 3900 is the other half of every one of them and
 * listing it would double the screen for no information.
 */
export async function openingDrafts(tx: Tx, orgId: string): Promise<OpeningDraft[]> {
  const rows = (await tx.execute(sql`
    select je.id, je.entry_date::text as entry_date, je.memo,
           a.code as account_code, jl.store_id,
           jl.debit::text as debit, jl.credit::text as credit,
           jl.party_type, jl.party_id
    from journal_entries je
    join journal_lines jl on jl.entry_id = je.id
    join accounts a on a.id = jl.account_id
    where je.org_id = ${orgId} and je.source_type = 'opening_balance'
      and je.status = 'draft' and a.code <> '3900'
    order by a.code
  `)) as unknown as Record<string, string | null>[];
  return rows.map((r) => ({
    id: String(r.id),
    entryDate: String(r.entry_date),
    memo: r.memo ?? null,
    accountCode: String(r.account_code),
    storeId: r.store_id ?? null,
    debit: String(r.debit),
    credit: String(r.credit),
    partyType: r.party_type ?? null,
    partyId: r.party_id ?? null,
  }));
}

/**
 * Delete a draft entry and its lines.
 *
 * ⛔ Guarded on `status = 'draft'` in the WHERE clause as well as by the caller: the posted-
 * immutability trigger would refuse a posted row anyway, and belt-and-braces here means the
 * failure is a clean no-op rather than an exception from a trigger.
 */
export async function deleteDraftEntry(tx: Tx, orgId: string, entryId: string): Promise<void> {
  await tx.execute(sql`
    delete from journal_lines
    where entry_id in (
      select id from journal_entries
      where id = ${entryId} and org_id = ${orgId} and status = 'draft'
    )
  `);
  await tx.execute(sql`
    delete from journal_entries where id = ${entryId} and org_id = ${orgId} and status = 'draft'
  `);
}

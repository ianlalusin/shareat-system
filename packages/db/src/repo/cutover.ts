/**
 * The only place SQL is written for the cutover. T-134.
 *
 * ⭐ Every `*Holds` function is a QUERY over real state. **None of them can be satisfied by a
 * click**, which is invariant 1 and the difference between a verified step and an honest tick.
 */
import { and, eq, ne, sql } from 'drizzle-orm';
import { decimal, type Decimal, type Quantity } from '@shareat/core/money';
import type { Tx } from '../client';
import { cutoverSteps, openingCounts } from '../../schema/cutover';
import { tablesInClass } from '../cutover/classification';
import type { SafeInsert } from './numeric-input';

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
    where oc.org_id = ${orgId}
    group by oc.item_id, i.name, oc.store_id
    having sum(oc.quantity) > 0 and bool_and(oc.unit_cost is null)
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
  // T-390 R16: a C3P attestation records a fingerprint of the party opening lines it vouched for, so C5 can tell when they changed.
  // Re-attesting replaces the row and so replaces the fingerprint.
  if (input.stepCode === 'C3P') {
    const fp = await partyLinesFingerprint(tx, input.orgId);
    input = { ...input, note: `${input.note ?? ''} ${C3P_FINGERPRINT_OPEN}${fp}]`.trim() };
  }
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

/** T-390 R13: the SHARED opening lock. Writers run side by side; `postOpeningBalances` (S2) takes the EXCLUSIVE twin. Taken BEFORE the R8 check. */
export async function lockOpeningShared(tx: Tx, orgId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock_shared(390001, hashtext(${orgId}::text))`);
}

/**
 * T-390 R3: serialise writers of ONE item in ONE store (cost propagation reads and writes every room row of the item).
 * LOCK ORDER, always: (1) shared org opening lock (390001), (2) this item lock (390002), (3) row writes. The exclusive C5 lock is
 * taken first by its own transaction, so no cycle exists.
 */
export async function lockOpeningItem(tx: Tx, storeId: string, itemId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(390002, hashtext(${storeId}::text || ':' || ${itemId}::text))`);
}

/** T-390 R8: has the opening been posted? An `opening_balance` entry was POSTED, even if it was reversed since (the books were opened; corrections are ordinary stock documents). The reversal entry itself is not an opening. */
export async function openingPosted(tx: Tx, orgId: string): Promise<{ posted: boolean; entryDate: string | null }> {
  const [row] = (await tx.execute(sql`
    select min(entry_date)::text as entry_date
    from journal_entries
    where org_id = ${orgId} and source_type = 'opening_balance' and status in ('posted', 'reversed') and reversal_of_entry_id is null
  `)) as unknown as Record<string, string | null>[];
  const entryDate = row?.entry_date ?? null;
  return { posted: entryDate !== null, entryDate };
}

/** A room's store and status, or null when there is no such room in this org. */
export async function roomOf(
  tx: Tx,
  orgId: string,
  locationId: string,
): Promise<{ storeId: string; status: string } | null> {
  const [row] = (await tx.execute(sql`
    select store_id, status from stock_locations where id = ${locationId} and org_id = ${orgId}
  `)) as unknown as Record<string, string>[];
  return row ? { storeId: String(row.store_id), status: String(row.status) } : null;
}

/** The store's one active default room, or null when it has none (or, defensively, more than one). */
export async function defaultRoomId(tx: Tx, orgId: string, storeId: string): Promise<string | null> {
  const rows = (await tx.execute(sql`
    select id from stock_locations
    where org_id = ${orgId} and store_id = ${storeId} and is_default and status = 'active'
  `)) as unknown as Record<string, string>[];
  return rows.length === 1 ? String(rows[0]!.id) : null;
}

/**
 * T-390 R1-R3. One row per (store, room, item).
 *
 * - A cost (with its source) is written on this row AND on every other room row of that item in that store: one cost per item
 *   per store.
 * - A count WITHOUT a cost never changes any cost: an existing row keeps its own, and a NEW room row takes the cost and source
 *   the item already has in this store (if any).
 */
export async function upsertOpeningCount(
  tx: Tx,
  input: Pick<SafeInsert<typeof openingCounts>, 'orgId' | 'storeId' | 'itemId'> & {
    locationId: string;
    // T-371 C2/R3: each numeric column takes its own minted shape — quantity (14,3), unit_cost (14,4), nullable.
    quantity: Quantity;
    unitCost: Decimal<'14,4'> | null;
    costSource: string | null;
    costEvidence: string | null;
    note: string | null;
    countedBy: string;
  },
): Promise<void> {
  let { unitCost, costSource, costEvidence } = input;
  const withCost = unitCost !== null;
  if (!withCost) {
    const [sib] = (await tx.execute(sql`
      select unit_cost::text as unit_cost, cost_source, cost_evidence from opening_counts
      where org_id = ${input.orgId} and store_id = ${input.storeId} and item_id = ${input.itemId} and unit_cost is not null
      order by counted_at desc limit 1
    `)) as unknown as Record<string, string | null>[];
    if (sib) {
      unitCost = sib.unit_cost == null ? null : decimal(sib.unit_cost, '14,4');
      costSource = sib.cost_source ?? null;
      costEvidence = sib.cost_evidence ?? null;
    }
  }
  const { locationId, quantity, note, countedBy } = input;
  // Leg 2: a cost-less recount of a row that has no cost of its own takes the sibling cost found above.
  let inherit = false;
  if (!withCost && unitCost !== null) {
    const [own] = (await tx.execute(sql`
      select unit_cost is not null as costed from opening_counts
      where store_id = ${input.storeId} and location_id = ${locationId} and item_id = ${input.itemId}
    `)) as unknown as { costed: boolean }[];
    inherit = own !== undefined && !own.costed;
  }
  await tx
    .insert(openingCounts)
    .values({
      orgId: input.orgId,
      storeId: input.storeId,
      locationId,
      itemId: input.itemId,
      quantity,
      unitCost,
      costSource,
      costEvidence,
      note,
      countedBy,
    })
    .onConflictDoUpdate({
      target: [openingCounts.storeId, openingCounts.locationId, openingCounts.itemId],
      set: {
        quantity,
        // A typed cost overwrites. A cost-less recount never changes a costed row; a row with NO cost of its own takes the
        // store's existing cost and source from a costed sibling (`inherit`, computed above; absent when there is none).
        ...(withCost || inherit ? { unitCost, costSource, costEvidence } : {}),
        note,
        countedBy,
        countedAt: sql`now()`,
      },
    });
  if (withCost) {
    await tx
      .update(openingCounts)
      .set({ unitCost, costSource, costEvidence })
      .where(
        and(
          eq(openingCounts.orgId, input.orgId),
          eq(openingCounts.storeId, input.storeId),
          eq(openingCounts.itemId, input.itemId),
          ne(openingCounts.locationId, locationId),
        ),
      );
  }
}

/** T-390 R13: the EXCLUSIVE opening lock `postOpeningBalances` takes first. Every other opening writer holds the SHARED twin (390001) before its R8 check. */
export async function lockOpeningExclusive(tx: Tx, orgId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(390001, hashtext(${orgId}::text))`);
}

/** T-390 R7: has any `opening_count` movement been written for this org? (C5 writes them once, ever.) */
export async function openingStockMovementsExist(tx: Tx, orgId: string): Promise<boolean> {
  const [row] = (await tx.execute(sql`
    select count(*)::int as n from stock_movements
    where org_id = ${orgId} and kind = 'opening' and source_type = 'opening_count'
  `)) as unknown as { n: number }[];
  return Number(row?.n ?? 0) > 0;
}

export interface OpeningCountRow {
  id: string;
  storeId: string;
  locationId: string;
  locationName: string;
  itemId: string;
  itemName: string;
  itemKind: string;
  /** numeric(14,3) as text. */
  quantity: string;
  /** numeric(14,4) as text, or null when the row has no cost. */
  unitCost: string | null;
  costSource: string | null;
}

/**
 * T-390 R5/R7/R17: every counted row (all rooms) of one store, or of the whole org, with the item's name and kind and the room's
 * name. The ONE read behind `planOpeningStock`; the float `countedValue` it replaces is gone.
 */
export async function countsForStore(tx: Tx, orgId: string, storeId?: string): Promise<OpeningCountRow[]> {
  const rows = (await tx.execute(sql`
    select oc.id, oc.store_id, oc.location_id, sl.name as location_name, oc.item_id, i.name as item_name, i.kind as item_kind,
           oc.quantity::text as quantity, oc.unit_cost::text as unit_cost, oc.cost_source
    from opening_counts oc
    join items i on i.id = oc.item_id
    join stock_locations sl on sl.id = oc.location_id
    where oc.org_id = ${orgId}
      ${storeId ? sql`and oc.store_id = ${storeId}` : sql``}
    order by oc.store_id, i.name, i.id, sl.name, oc.id
  `)) as unknown as Record<string, string | null>[];
  return rows.map((r) => ({
    id: String(r.id),
    storeId: String(r.store_id),
    locationId: String(r.location_id),
    locationName: String(r.location_name),
    itemId: String(r.item_id),
    itemName: String(r.item_name),
    itemKind: String(r.item_kind),
    quantity: String(r.quantity),
    unitCost: r.unit_cost == null ? null : String(r.unit_cost),
    costSource: r.cost_source == null ? null : String(r.cost_source),
  }));
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
  // T-390 audit 5: LIVE entries only (not reversed, not a reversal), and only on the SAME party-control account on both sides, so an
  // old payroll or transfer line on another account never refuses.
  const rows = (await tx.execute(sql`
    with opening as (
      select distinct a.code, jl.party_type, jl.party_id
      from journal_lines jl
      join journal_entries je on je.id = jl.entry_id
      join accounts a on a.id = jl.account_id
      where je.org_id = ${orgId} and je.source_type = 'opening_balance' and je.status in ('draft', 'posted')
        and je.reversal_of_entry_id is null and jl.party_id is not null and a.code in ('1210', '2110', '2400', '1230')
    )
    select distinct o.party_type, o.party_id
    from opening o
    where exists (
      select 1
      from journal_lines jl2
      join journal_entries je2 on je2.id = jl2.entry_id
      join accounts a2 on a2.id = jl2.account_id
      where je2.org_id = ${orgId}
        and je2.source_type <> 'opening_balance'
        and je2.status = 'posted' and je2.reversal_of_entry_id is null
        and je2.entry_date < ${conversionDate}
        and a2.code = o.code
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

// -------------------------------------------------------------------------------------
// T-390 S3 — the tie-out's queries (R9, §5.3) and the writers' R8 gates
// -------------------------------------------------------------------------------------

/** T-390 R8: has the purge (C2) been RECORDED as performed? Only `performed` counts; an `attested` C2 row does not. */
export async function c2Performed(tx: Tx, orgId: string): Promise<boolean> {
  const [row] = (await tx.execute(sql`
    select count(*)::int as n from cutover_steps
    where org_id = ${orgId} and step_code = 'C2' and completion = 'performed'
  `)) as unknown as { n: number }[];
  return Number(row?.n ?? 0) > 0;
}

/** Every store of the org, by id, so a sentence can name the store. */
export async function storeNamesOf(tx: Tx, orgId: string): Promise<Map<string, string>> {
  const rows = (await tx.execute(sql`select id, name from stores where org_id = ${orgId}`)) as unknown as Record<string, string>[];
  return new Map(rows.map((r) => [String(r.id), String(r.name)]));
}

export interface OpeningLine {
  entryId: string;
  entryDate: string;
  accountCode: string;
  storeId: string | null;
  debit: string;
  credit: string;
  partyType: string | null;
  partyId: string | null;
  /** The party name when it resolves under its own type; null for an orphan or a party with no name. */
  partyName: string | null;
  /** loan / money_account only: the store the party belongs to. */
  partyStoreId: string | null;
  /** money_account only: its GL code and whether it is active. */
  partyGlCode: string | null;
  partyActive: boolean | null;
  /** employee only: has this person an employment (ANY status) at the line's store? */
  employedAtStore: boolean | null;
}

/**
 * EVERY line of every opening entry, draft and posted alike (3900 included), with its party resolved under the party's OWN type.
 * The registers T2-T10 are decided over this one set; the arithmetic happens in the domain, in centavos.
 */
export async function openingLines(tx: Tx, orgId: string): Promise<OpeningLine[]> {
  const rows = (await tx.execute(sql`
    select je.id as entry_id, je.entry_date::text as entry_date, a.code as account_code, jl.store_id,
           jl.debit::text as debit, jl.credit::text as credit, jl.party_type, jl.party_id,
           case jl.party_type
             when 'customer' then (select c.name from customers c where c.id::text = jl.party_id and c.org_id = je.org_id)
             when 'supplier' then (select s.name from suppliers s where s.id::text = jl.party_id and s.org_id = je.org_id)
             when 'employee' then (select p.display_name from persons p where p.id::text = jl.party_id and p.org_id = je.org_id)
             when 'loan' then (select l.name from loans l where l.id::text = jl.party_id and l.org_id = je.org_id)
             when 'money_account' then (select m.name from money_accounts m where m.id::text = jl.party_id and m.org_id = je.org_id)
             when 'store' then (select st.name from stores st where st.id::text = jl.party_id and st.org_id = je.org_id)
             else null end as party_name,
           case jl.party_type
             when 'loan' then (select l.store_id::text from loans l where l.id::text = jl.party_id and l.org_id = je.org_id)
             when 'money_account' then (select m.store_id::text from money_accounts m where m.id::text = jl.party_id and m.org_id = je.org_id)
             else null end as party_store_id,
           (select m.gl_account_code from money_accounts m
             where jl.party_type = 'money_account' and m.id::text = jl.party_id and m.org_id = je.org_id) as party_gl_code,
           (select m.is_active from money_accounts m
             where jl.party_type = 'money_account' and m.id::text = jl.party_id and m.org_id = je.org_id) as party_active,
           case when jl.party_type = 'employee' then exists (
             select 1 from employments e
             where e.person_id::text = jl.party_id and e.store_id = jl.store_id and e.org_id = je.org_id) else null end as employed_at_store
    from journal_entries je
    join journal_lines jl on jl.entry_id = je.id
    join accounts a on a.id = jl.account_id
    where je.org_id = ${orgId} and je.source_type = 'opening_balance' and je.status in ('draft', 'posted')
      and je.reversal_of_entry_id is null
    order by je.entry_date, a.code, jl.line_no, je.id
  `)) as unknown as Record<string, string | boolean | null>[];
  return rows.map((r) => ({
    entryId: String(r.entry_id),
    entryDate: String(r.entry_date),
    accountCode: String(r.account_code),
    storeId: r.store_id == null ? null : String(r.store_id),
    debit: String(r.debit),
    credit: String(r.credit),
    partyType: r.party_type == null ? null : String(r.party_type),
    partyId: r.party_id == null ? null : String(r.party_id),
    partyName: r.party_name == null ? null : String(r.party_name),
    partyStoreId: r.party_store_id == null ? null : String(r.party_store_id),
    partyGlCode: r.party_gl_code == null ? null : String(r.party_gl_code),
    partyActive: r.party_active == null ? null : Boolean(r.party_active),
    employedAtStore: r.employed_at_store == null ? null : Boolean(r.employed_at_store),
  }));
}

/** T2 register side: the cost of the ACTIVE assets acquired on the conversion date, per store. */
export async function openingAssetCostByStore(
  tx: Tx,
  orgId: string,
  conversionDate: string,
): Promise<{ storeId: string; cost: string }[]> {
  const rows = (await tx.execute(sql`
    select store_id, coalesce(sum(cost), 0)::text as cost
    from fixed_assets
    where org_id = ${orgId} and status = 'active' and acquired_on = ${conversionDate}::date
    group by store_id
  `)) as unknown as Record<string, string>[];
  return rows.map((r) => ({ storeId: String(r.store_id), cost: String(r.cost) }));
}

/** T2: every shell still waiting for a value (it blocks C5 by name). */
export async function pendingAssetShells(tx: Tx, orgId: string): Promise<{ id: string; storeId: string; name: string }[]> {
  const rows = (await tx.execute(sql`
    select id, store_id, name from fixed_assets
    where org_id = ${orgId} and status = 'pending_valuation'
    order by name, id
  `)) as unknown as Record<string, string>[];
  return rows.map((r) => ({ id: String(r.id), storeId: String(r.store_id), name: String(r.name) }));
}

/** One asset's store, name and status, or null when there is no such asset in this org (R10's lookup). */
export async function assetOf(
  tx: Tx,
  orgId: string,
  assetId: string,
): Promise<{ storeId: string; name: string; status: string } | null> {
  const [row] = (await tx.execute(sql`
    select store_id, name, status from fixed_assets where id = ${assetId} and org_id = ${orgId}
  `)) as unknown as Record<string, string>[];
  return row ? { storeId: String(row.store_id), name: String(row.name), status: String(row.status) } : null;
}

/** T3 register side: the total cost of the ACTIVE prepaid items, per store. */
export async function activePrepaidTotalByStore(tx: Tx, orgId: string): Promise<{ storeId: string; total: string }[]> {
  const rows = (await tx.execute(sql`
    select store_id, coalesce(sum(total_cost), 0)::text as total
    from prepaid_items
    where org_id = ${orgId} and status = 'active'
    group by store_id
  `)) as unknown as Record<string, string>[];
  return rows.map((r) => ({ storeId: String(r.store_id), total: String(r.total) }));
}

/** T4 register side: every ACTIVE loan, with its store. */
export async function activeLoans(tx: Tx, orgId: string): Promise<{ id: string; storeId: string; name: string }[]> {
  const rows = (await tx.execute(sql`
    select id, store_id, name from loans where org_id = ${orgId} and status = 'active' order by name, id
  `)) as unknown as Record<string, string>[];
  return rows.map((r) => ({ id: String(r.id), storeId: String(r.store_id), name: String(r.name) }));
}

/** A party name under its own type, for a sentence about it (the double-counting guard). Null when it does not resolve. */
export async function partyNameOf(tx: Tx, orgId: string, partyType: string, partyId: string): Promise<string | null> {
  const [row] = (await tx.execute(sql`
    select case ${partyType}::text
             when 'customer' then (select c.name from customers c where c.id::text = ${partyId} and c.org_id = ${orgId})
             when 'supplier' then (select s.name from suppliers s where s.id::text = ${partyId} and s.org_id = ${orgId})
             when 'employee' then (select p.display_name from persons p where p.id::text = ${partyId} and p.org_id = ${orgId})
             when 'loan' then (select l.name from loans l where l.id::text = ${partyId} and l.org_id = ${orgId})
             when 'money_account' then (select m.name from money_accounts m where m.id::text = ${partyId} and m.org_id = ${orgId})
             when 'store' then (select st.name from stores st where st.id::text = ${partyId} and st.org_id = ${orgId})
             else null end as name
  `)) as unknown as Record<string, string | null>[];
  return row?.name ?? null;
}

export const C3P_FINGERPRINT_OPEN = '[party-lines:';

/** T-390 R16: count and total (debits plus credits) of the opening lines on the party-control accounts 1210, 2110, 2400, 1230. */
export async function partyLinesFingerprint(tx: Tx, orgId: string): Promise<string> {
  const [row] = (await tx.execute(sql`
    select count(*)::text as n, coalesce(sum(jl.debit + jl.credit), 0)::text as total
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a on a.id = jl.account_id
    where je.org_id = ${orgId} and je.source_type = 'opening_balance' and je.status in ('draft', 'posted')
      and je.reversal_of_entry_id is null and a.code in ('1210', '2110', '2400', '1230')
  `)) as unknown as Record<string, string>[];
  return `${row?.n ?? '0'}:${row?.total ?? '0'}`;
}

/** The C3P attestation as recorded: when, and the fingerprint it vouched for (null when the row carries none). */
export async function c3pAttestation(
  tx: Tx,
  orgId: string,
): Promise<{ completedAt: Date; fingerprint: string | null } | null> {
  const [row] = (await tx.execute(sql`
    select completed_at, note from cutover_steps where org_id = ${orgId} and step_code = 'C3P' and store_id is null
  `)) as unknown as { completed_at: Date | string; note: string | null }[];
  if (!row) return null;
  const m = /\[party-lines:([^\]]*)\]/.exec(row.note ?? '');
  return { completedAt: new Date(row.completed_at), fingerprint: m ? (m[1] ?? null) : null };
}

// -------------------------------------------------------------------------------------
// T-390 S5: the reads behind the cutover screens (the screens' lib.ts holds no SQL)
// -------------------------------------------------------------------------------------

type Row = Record<string, string | null>;

/** The store's active rooms, default first. */
export async function activeRoomsOf(
  tx: Tx,
  orgId: string,
  storeId: string,
): Promise<{ id: string; code: string; name: string; isDefault: boolean }[]> {
  const rows = (await tx.execute(sql`
    select id, code, name, is_default from stock_locations
    where org_id = ${orgId} and store_id = ${storeId} and status = 'active'
    order by is_default desc, name, id
  `)) as unknown as Record<string, unknown>[];
  return rows.map((r) => ({ id: String(r.id), code: String(r.code), name: String(r.name), isDefault: Boolean(r.is_default) }));
}

/** One room's counts (quantity, cost, cost source) keyed by item id. */
export async function countsForRoom(
  tx: Tx,
  orgId: string,
  storeId: string,
  roomId: string,
): Promise<Map<string, { quantity: string; unitCost: string | null; costSource: string | null }>> {
  const rows = (await tx.execute(sql`
    select item_id, quantity::text as quantity, unit_cost::text as unit_cost, cost_source
    from opening_counts where org_id = ${orgId} and store_id = ${storeId} and location_id = ${roomId}
  `)) as unknown as Row[];
  return new Map(
    rows.map((r) => [String(r.item_id), { quantity: String(r.quantity), unitCost: r.unit_cost ?? null, costSource: r.cost_source ?? null }]),
  );
}

/** Per item across every room of the store: summed quantity (as text) and the cost. */
export async function countTotalsByItem(
  tx: Tx,
  orgId: string,
  storeId: string,
): Promise<Map<string, { quantity: string; unitCost: string | null }>> {
  const rows = (await tx.execute(sql`
    select item_id, sum(quantity)::text as quantity, max(unit_cost)::text as unit_cost
    from opening_counts where org_id = ${orgId} and store_id = ${storeId}
    group by item_id
  `)) as unknown as Row[];
  return new Map(rows.map((r) => [String(r.item_id), { quantity: String(r.quantity), unitCost: r.unit_cost ?? null }]));
}

export interface SheetItemRow {
  code: string;
  name: string;
  baseUnit: string;
  purchaseUnit: string | null;
  purchaseFactor: string | null;
}

/** ACTIVE items with a stock movement in this room in the last 90 days. Reads no quantity: the count sheet is blind. */
export async function itemsMovedInRoom(tx: Tx, orgId: string, storeId: string, roomId: string): Promise<SheetItemRow[]> {
  const rows = (await tx.execute(sql`
    select i.code, i.name, i.base_unit, i.purchase_unit, i.purchase_factor::text as purchase_factor
    from items i
    where i.org_id = ${orgId} and i.status = 'active'
      and exists (
        select 1 from stock_movements m
        where m.org_id = ${orgId} and m.store_id = ${storeId} and m.location_id = ${roomId}
          and m.item_id = i.id and m.moved_at >= now() - interval '90 days'
      )
    order by i.name, i.id
  `)) as unknown as Row[];
  return rows.map((r) => ({
    code: String(r.code),
    name: String(r.name),
    baseUnit: String(r.base_unit),
    purchaseUnit: r.purchase_unit ?? null,
    purchaseFactor: r.purchase_factor ?? null,
  }));
}

/** Suppliers and customers by name, for the opening-figure party picker. */
export async function partyOptions(tx: Tx, orgId: string): Promise<{ type: 'supplier' | 'customer'; id: string; name: string }[]> {
  const sup = (await tx.execute(sql`select id, name from suppliers where org_id = ${orgId} order by name, id`)) as unknown as Row[];
  const cus = (await tx.execute(sql`select id, name from customers where org_id = ${orgId} order by name, id`)) as unknown as Row[];
  return [
    ...sup.map((r) => ({ type: 'supplier' as const, id: String(r.id), name: String(r.name) })),
    ...cus.map((r) => ({ type: 'customer' as const, id: String(r.id), name: String(r.name) })),
  ];
}

/** Postable accounts an opening figure may be entered against. 3900 is excluded at the source. */
export async function postableOpeningAccounts(
  tx: Tx,
  orgId: string,
): Promise<{ code: string; name: string; requiresParty: boolean }[]> {
  const rows = (await tx.execute(sql`
    select code, name, requires_party from accounts
    where org_id = ${orgId} and is_postable = true and status = 'active' and code <> '3900'
    order by code
  `)) as unknown as Record<string, unknown>[];
  return rows.map((r) => ({ code: String(r.code), name: String(r.name), requiresParty: Boolean(r.requires_party) }));
}

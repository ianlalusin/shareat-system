/**
 * The only place SQL is written for customers and price lists. T-129.
 *
 * ⭐ `balanceOf` is why there is no `outstanding_balance` column. v1 keeps one on `ARCustomerPlain`
 * and another on `ApSupplierPlain` (DEF-075). Here it is summed from `1210` by party from day one,
 * so there is never a column for T-131 (AR) to have to remove.
 */
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../client';
import {
  customers,
  priceListItems,
  priceLists,
  type CustomerGroup,
  type CustomerStatus,
  type CustomerTreatment,
} from '../../schema/customers';

export const AR_CONTROL_CODE = '1210';
export const PARTY_TYPE = 'customer';

export interface CustomerRow {
  id: string;
  orgId: string;
  name: string;
  address: string | null;
  contactNo: string | null;
  counterpartyStoreId: string | null;
  counterpartyOrgId: string | null;
  priceListId: string | null;
  customerGroup: CustomerGroup;
  status: CustomerStatus;
  notes: string | null;
  reconciledAsOf: string | null;
  reconciledAt: Date | null;
  reconciledBy: string | null;
  createdBy: string;
  createdAt: Date;
}

/**
 * ⭐ **The treatment is DERIVED from the links, never stored** — ADR-008 §2.
 *
 * ⛔ A declared `is_internal` flag beside the link would be a second copy of the same fact, free to
 * drift, and it would drift silently. Deriving is right here (unlike `normal_balance`, bible row 39,
 * which is declared) because this reads a FOREIGN KEY rather than guessing from a name.
 *
 * ⚠️ The database already refuses both links at once, so this cannot be ambiguous — see the
 * `customers_one_counterparty_check` CHECK.
 */
export function treatmentOf(
  customer: Pick<CustomerRow, 'counterpartyStoreId' | 'counterpartyOrgId'>,
): CustomerTreatment {
  if (customer.counterpartyStoreId) return 'internal';
  if (customer.counterpartyOrgId) return 'inter_entity';
  return 'external';
}

export async function insertCustomer(
  tx: Tx,
  input: {
    orgId: string;
    name: string;
    address: string | null;
    contactNo: string | null;
    counterpartyStoreId: string | null;
    counterpartyOrgId: string | null;
    priceListId: string | null;
    customerGroup: CustomerGroup;
    notes: string | null;
    createdBy: string;
  },
): Promise<{ id: string }> {
  const [row] = await tx.insert(customers).values(input).returning({ id: customers.id });
  return row!;
}

export async function getById(tx: Tx, orgId: string, id: string): Promise<CustomerRow | undefined> {
  const [row] = await tx
    .select()
    .from(customers)
    .where(and(eq(customers.id, id), eq(customers.orgId, orgId)))
    .limit(1);
  return row as CustomerRow | undefined;
}

export async function listCustomers(tx: Tx, orgId: string): Promise<CustomerRow[]> {
  const rows = await tx
    .select()
    .from(customers)
    .where(eq(customers.orgId, orgId))
    .orderBy(asc(customers.name));
  return rows as CustomerRow[];
}

export async function updateCustomer(
  tx: Tx,
  orgId: string,
  id: string,
  values: Partial<{
    name: string;
    address: string | null;
    contactNo: string | null;
    priceListId: string | null;
    customerGroup: CustomerGroup;
    status: CustomerStatus;
    notes: string | null;
    reconciledAsOf: string | null;
    reconciledAt: Date | null;
    reconciledBy: string | null;
  }>,
): Promise<void> {
  const updated = await tx
    .update(customers)
    .set({ ...values, updatedAt: sql`now()` })
    .where(and(eq(customers.id, id), eq(customers.orgId, orgId)))
    .returning({ id: customers.id });
  if (updated.length === 0) {
    throw new Error(`updateCustomer: customer ${id} does not exist in org ${orgId}`);
  }
}

// -------------------------------------------------------------------------------------
// ⭐ Derived — the balance, from the ledger
// -------------------------------------------------------------------------------------

/**
 * What this customer owes, summed from `1210`.
 *
 * ⚠️ Reversed entries are INCLUDED: they and their originals net to zero, so counting both is
 * correct and counting only one is not.
 *
 * ⚠️ **Nothing posts to `1210` yet** — AR is T-131. This returns `0.00` for everyone today, and
 * that is the point: the figure is derived from the day the table exists, so AR has no column to
 * remove when it arrives.
 */
export async function balanceOf(tx: Tx, orgId: string, customerId: string): Promise<string> {
  const [row] = (await tx.execute(sql`
    select coalesce(sum(jl.debit - jl.credit), 0)::text as balance
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a on a.id = jl.account_id
    where je.org_id = ${orgId}
      and jl.party_type = ${PARTY_TYPE}
      and jl.party_id = ${customerId}
      and a.code = ${AR_CONTROL_CODE}
      and je.status <> 'draft'
  `)) as unknown as Record<string, string>[];
  return Number(row?.balance ?? 0).toFixed(2);
}

/** Every customer's balance in one query — the register's N+1 guard. */
export async function balancesByCustomer(tx: Tx, orgId: string): Promise<Map<string, string>> {
  const rows = (await tx.execute(sql`
    select jl.party_id as customer_id, coalesce(sum(jl.debit - jl.credit), 0)::text as balance
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a on a.id = jl.account_id
    where je.org_id = ${orgId}
      and jl.party_type = ${PARTY_TYPE}
      and a.code = ${AR_CONTROL_CODE}
      and je.status <> 'draft'
    group by jl.party_id
  `)) as unknown as Record<string, string>[];
  const map = new Map<string, string>();
  for (const r of rows) {
    map.set(String(r.customer_id ?? r.customerId), Number(r.balance ?? 0).toFixed(2));
  }
  return map;
}

// -------------------------------------------------------------------------------------
// Price lists
// -------------------------------------------------------------------------------------

export interface PriceListRow {
  id: string;
  orgId: string;
  name: string;
  description: string | null;
  retiredAt: Date | null;
  createdBy: string;
  createdAt: Date;
}

export interface PriceListItemRow {
  id: string;
  orgId: string;
  priceListId: string;
  itemCode: string;
  itemName: string | null;
  rate: string;
  unit: string | null;
}

export async function insertPriceList(
  tx: Tx,
  input: { orgId: string; name: string; description: string | null; createdBy: string },
): Promise<{ id: string }> {
  const [row] = await tx.insert(priceLists).values(input).returning({ id: priceLists.id });
  return row!;
}

export async function listPriceLists(
  tx: Tx,
  orgId: string,
  filter: { includeRetired?: boolean } = {},
): Promise<PriceListRow[]> {
  const conditions = [eq(priceLists.orgId, orgId)];
  if (!filter.includeRetired) conditions.push(isNull(priceLists.retiredAt));
  const rows = await tx
    .select()
    .from(priceLists)
    .where(and(...conditions))
    .orderBy(asc(priceLists.name));
  return rows as PriceListRow[];
}

export async function getPriceList(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<PriceListRow | undefined> {
  const [row] = await tx
    .select()
    .from(priceLists)
    .where(and(eq(priceLists.id, id), eq(priceLists.orgId, orgId)))
    .limit(1);
  return row as PriceListRow | undefined;
}

/** ⭐ Upsert on `(price_list_id, item_code)` — re-quoting an item is a NEW RATE, not a second row. */
export async function upsertPriceListItem(
  tx: Tx,
  input: {
    orgId: string;
    priceListId: string;
    itemCode: string;
    itemName: string | null;
    rate: string;
    unit: string | null;
  },
): Promise<void> {
  await tx
    .insert(priceListItems)
    .values(input)
    .onConflictDoUpdate({
      target: [priceListItems.priceListId, priceListItems.itemCode],
      set: {
        // ⚠️ The RATE always replaces — that is the point of a re-quote. The label and unit only
        // replace when a new one is supplied.
        //
        // ⛔ Overwriting them unconditionally blanked both when someone re-priced an item with just
        // a code and a number, which is the normal way to change a price. Caught in the browser: a
        // ₱380 "Pork belly / kg" came back as a bare code at ₱410.
        itemName: sql`coalesce(${input.itemName}, ${priceListItems.itemName})`,
        rate: input.rate,
        unit: sql`coalesce(${input.unit}, ${priceListItems.unit})`,
        updatedAt: sql`now()`,
      },
    });
}

export async function listPriceListItems(
  tx: Tx,
  orgId: string,
  priceListId: string,
): Promise<PriceListItemRow[]> {
  const rows = await tx
    .select()
    .from(priceListItems)
    .where(and(eq(priceListItems.orgId, orgId), eq(priceListItems.priceListId, priceListId)))
    .orderBy(asc(priceListItems.itemCode));
  return rows as PriceListItemRow[];
}

/**
 * ⭐ **What one item costs a given customer.** Returns `null` when the customer has no price list,
 * or the list has no rate for that item.
 *
 * ⛔ **Null, not zero, and not a fallback to some other list.** A missing rate means nobody has
 * priced this item for this customer — and inventing a number there is how something ships free.
 */
export async function rateFor(
  tx: Tx,
  orgId: string,
  customerId: string,
  itemCode: string,
): Promise<string | null> {
  const [row] = (await tx.execute(sql`
    select pli.rate::text as rate
    from customers c
    join price_list_items pli on pli.price_list_id = c.price_list_id
    where c.org_id = ${orgId} and c.id = ${customerId} and pli.item_code = ${itemCode}
    limit 1
  `)) as unknown as Record<string, string>[];
  return row?.rate ? Number(row.rate).toFixed(2) : null;
}

/**
 * Other organisations in the system — the franchise link's picker.
 *
 * ⚠️ **Never this org.** Linking a customer to our own organisation would derive as an
 * inter-entity sale to ourselves: real revenue against no external party. The service refuses it
 * too; excluding it here means the UI cannot offer the mistake in the first place.
 */
export async function otherOrgs(
  tx: Tx,
  orgId: string,
): Promise<{ id: string; name: string; code: string }[]> {
  const rows = (await tx.execute(sql`
    select id, name, code from organizations where id <> ${orgId} and is_active order by name
  `)) as unknown as Record<string, string>[];
  return rows.map((r) => ({ id: String(r.id), name: String(r.name), code: String(r.code) }));
}


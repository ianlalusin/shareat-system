import Link from 'next/link';
import { and, asc, desc, eq, inArray, sql as dsql } from 'drizzle-orm';
import { schema } from '@shareat/db';
import { compare, ZERO } from '@shareat/core/money';
import { isPositiveQuantity, quantity, subtractQuantity, supplierCreditBalance } from '@shareat/domain';
import { listStores } from '../lib';
import { recordReturnAction, refundCreditAction, voidReturnAction } from './actions';
import { requireSession } from '../../../lib/session';
import { withOrgPrincipal } from '../../expenses/lib';
import { Page } from '@/components/shell/Page';
import { FilterRow } from '@/components/FilterRow';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';
import { Badge, Button, ConfirmDestructive, Field, FlashBanner, Input, Select } from '@/components/ui';
import { CheckedForm } from '@/components/forms';
import { INVENTORY_REFUND_RULES, INVENTORY_RETURN_RULES, INVENTORY_RETURN_VOID_RULES, nativeAttrs } from '@shareat/domain/field-rules';

export const metadata = { title: 'Supplier returns — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  store?: string;
  error?: string;
  ok?: string;
}

export default async function ReturnsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await withFlash(searchParams);
  const { actor } = await requireSession('/inventory/returns');
  const stores = await listStores(actor.orgId);
  const storeId = sp.store && stores.some((s) => s.id === sp.store) ? sp.store : stores[0]?.id;

  if (!storeId) {
    return (
      <Page density="table" className="">
        <h1 className="text-2xl font-semibold">Supplier returns</h1>
        <p className="mt-4 text-sm text-neutral-600">This organisation has no stores yet.</p>
      </Page>
    );
  }

  const { returnableLines, suppliers, credits, recent, locations, moneyAccountId } = await withOrgPrincipal(actor.orgId, async (tx) => {
    // ⭐ Returnable = received − already returned (posted only) — invariant 2's cap, rendered.
    const lines = await tx.execute(dsql`
      select dl.id as delivery_line_id, d.id as delivery_id, d.supplier_id, s.name as supplier_name,
             i.id as item_id, i.name as item_name, i.kind as item_kind, i.base_unit,
             dl.received_quantity, dl.location_id,
             coalesce((
               select sum(srl.quantity) from supplier_return_lines srl
               join supplier_returns sr on sr.id = srl.return_id
               where srl.delivery_line_id = dl.id and sr.status = 'posted'
             ), 0) as already_returned
      from delivery_lines dl
      join deliveries d on d.id = dl.delivery_id
      join suppliers s on s.id = d.supplier_id
      join items i on i.id = dl.item_id
      where d.store_id = ${storeId} and d.status = 'received' and d.kind = 'supplier'
      order by d.delivered_on desc
    `) as unknown as {
      delivery_line_id: string; delivery_id: string; supplier_id: string; supplier_name: string;
      item_id: string; item_name: string; item_kind: string; base_unit: string;
      received_quantity: string | null; location_id: string | null; already_returned: string;
    }[];

    const returnable = lines
      // T-371 C4: exact (14,3) arithmetic on minted values, never `Number(...) - Number(...)` and a float `> 0`.
      .map((l) => ({ ...l, returnable: subtractQuantity(quantity(l.received_quantity ?? '0'), quantity(l.already_returned)) }))
      .filter((l) => isPositiveQuantity(l.returnable));

    const supplierRows = await tx
      .select({ id: schema.suppliers.id, name: schema.suppliers.name })
      .from(schema.suppliers)
      .where(eq(schema.suppliers.orgId, actor.orgId))
      .orderBy(asc(schema.suppliers.name));

    const creditBySupplier = new Map<string, string>();
    for (const s of supplierRows) {
      const bal = await supplierCreditBalance(tx, actor.orgId, s.id);
      if (compare(bal, ZERO) === 1) creditBySupplier.set(s.id, bal);
    }

    const recentReturns = await tx
      .select({
        id: schema.supplierReturns.id,
        status: schema.supplierReturns.status,
        creditBasis: schema.supplierReturns.creditBasis,
        reason: schema.supplierReturns.reason,
        returnedOn: schema.supplierReturns.returnedOn,
        supplierId: schema.supplierReturns.supplierId,
      })
      .from(schema.supplierReturns)
      .where(eq(schema.supplierReturns.storeId, storeId))
      .orderBy(desc(schema.supplierReturns.createdAt))
      .limit(15);

    const locs = await tx
      .select({ id: schema.stockLocations.id, name: schema.stockLocations.name })
      .from(schema.stockLocations)
      .where(and(eq(schema.stockLocations.storeId, storeId), eq(schema.stockLocations.status, 'active')));

    const [money] = await tx
      .select({ id: schema.moneyAccounts.id })
      .from(schema.moneyAccounts)
      .where(and(eq(schema.moneyAccounts.storeId, storeId), eq(schema.moneyAccounts.instrument, 'cash')))
      .limit(1);

    return {
      returnableLines: returnable,
      suppliers: supplierRows,
      credits: creditBySupplier,
      recent: recentReturns,
      locations: locs,
      moneyAccountId: money?.id,
    };
  });

  const supplierName = new Map(suppliers.map((s) => [s.id, s.name]));
  const locName = new Map(locations.map((l) => [l.id, l.name]));

  return (
    <Page density="table" className="">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <h1 className="text-2xl font-semibold">Supplier returns</h1>
        <Link href="/inventory" className="text-sm underline underline-offset-4">
          ← Stock on hand
        </Link>
      </div>
      <PageDescription className="mt-1">
        The goods go back, and we hold a credit. ⭐ Which account it lands in is derived from
        whether the receipt was invoiced — never a choice on this form.
      </PageDescription>

      <FlashBanner flash={sp} />

      <FilterRow className="mt-6">
        <label className="text-sm">
          <span className="block text-neutral-600 dark:text-neutral-400">Store</span>
          <Select name="store" defaultValue={storeId} className="mt-1">
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.code})
              </option>
            ))}
          </Select>
        </label>
      </FilterRow>

      {credits.size > 0 && (
        <section className="mt-8 rounded-lg border border-warning-ink bg-warning-soft p-4">
          <h2 className="text-sm font-medium">Spendable supplier credit</h2>
          <ul className="mt-2 text-sm">
            {[...credits.entries()].map(([supplierId, balance]) => (
              <li key={supplierId} className="flex items-center justify-between gap-3 py-1">
                <span>{supplierName.get(supplierId) ?? supplierId}: ₱{balance}</span>
                <CheckedForm rules={INVENTORY_REFUND_RULES} action={refundCreditAction} className="flex min-w-0 flex-1 items-center justify-end gap-2">
                  <input type="hidden" name="storeId" value={storeId} />
                  <input type="hidden" name="supplierId" value={supplierId} />
                  <input type="hidden" name="moneyAccountId" value={moneyAccountId ?? ''} />
                  <Field label={<span className="sr-only">Refund amount</span>} className="min-w-0 flex-1" rule={INVENTORY_REFUND_RULES.amount}>
                    <Input {...nativeAttrs(INVENTORY_REFUND_RULES.amount)} placeholder="refund amount" className="min-w-0 w-full" />
                  </Field>
                  <Button type="submit" variant="secondary" disabled={!moneyAccountId}>
                    Refund
                  </Button>
                </CheckedForm>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-neutral-500">
            Apply it against a later AP payment instead by ticking &ldquo;use credit&rdquo; there —
            spending it is not a separate document.
          </p>
        </section>
      )}

      <h2 className="mt-10 text-lg font-medium">Returnable lines</h2>
      {returnableLines.length === 0 ? (
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
          Nothing received at this store has any quantity left to return.
        </p>
      ) : (
        <table className="mt-3 w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-neutral-300 text-left dark:border-neutral-700">
              <th className="py-2 pr-4 font-medium">Supplier</th>
              <th className="py-2 pr-4 font-medium">Item</th>
              <th className="py-2 pr-4 text-right font-medium">Returnable</th>
              <th className="py-2 font-medium">Record</th>
            </tr>
          </thead>
          <tbody>
            {returnableLines.map((l) => (
              <tr key={l.delivery_line_id} className="border-b border-neutral-200 align-top dark:border-neutral-800">
                <td className="py-2 pr-4">{l.supplier_name}</td>
                <td className="py-2 pr-4">
                  {l.item_name} <span className="text-xs text-neutral-500">({l.base_unit})</span>
                </td>
                <td className="py-2 pr-4 text-right tabular-nums">{l.returnable}</td>
                <td className="py-2">
                  <CheckedForm rules={INVENTORY_RETURN_RULES} action={recordReturnAction} className="flex flex-wrap items-center gap-2">
                    <input type="hidden" name="storeId" value={storeId} />
                    <input type="hidden" name="supplierId" value={l.supplier_id} />
                    <input type="hidden" name="deliveryId" value={l.delivery_id} />
                    <input type="hidden" name="deliveryLineId" value={l.delivery_line_id} />
                    <input type="hidden" name="itemId" value={l.item_id} />
                    <input type="hidden" name="itemKind" value={l.item_kind} />
                    <input type="hidden" name="locationId" value={l.location_id ?? ''} />
                    <Field label={<span className="sr-only">Quantity</span>} rule={INVENTORY_RETURN_RULES.quantity}>
                      <Input {...nativeAttrs(INVENTORY_RETURN_RULES.quantity)} placeholder={`up to ${l.returnable}`} className="w-24 tabular-nums" />
                    </Field>
                    <Field label={<span className="sr-only">Reason</span>} rule={INVENTORY_RETURN_RULES.reason}>
                      <Input {...nativeAttrs(INVENTORY_RETURN_RULES.reason)} placeholder="reason" className="w-32" />
                    </Field>
                    <Button type="submit" variant="secondary" disabled={!l.location_id}>
                      Return
                    </Button>
                  </CheckedForm>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 className="mt-10 text-lg font-medium">Recent</h2>
      {recent.length === 0 ? (
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">No returns recorded yet at this store.</p>
      ) : (
        <table className="mt-3 w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-neutral-300 text-left dark:border-neutral-700">
              <th className="py-2 pr-4 font-medium">Date</th>
              <th className="py-2 pr-4 font-medium">Supplier</th>
              <th className="py-2 pr-4 font-medium">Basis</th>
              <th className="py-2 pr-4 font-medium">Status</th>
              <th className="py-2 font-medium">Action</th>
            </tr>
          </thead>
          <tbody>
            {recent.map((r) => (
              <tr key={r.id} className="border-b border-neutral-200 dark:border-neutral-800">
                <td className="py-2 pr-4">{r.returnedOn}</td>
                <td className="py-2 pr-4">{supplierName.get(r.supplierId) ?? r.supplierId}</td>
                <td className="py-2 pr-4">{r.creditBasis}</td>
                <td className="py-2 pr-4">
                  <Badge status={r.status} />
                </td>
                <td className="py-2">
                  {r.status === 'posted' && (
                    <CheckedForm rules={INVENTORY_RETURN_VOID_RULES} action={voidReturnAction} className="flex items-center gap-1">
                      <input type="hidden" name="returnId" value={r.id} />
                      <input type="hidden" name="store" value={storeId} />
                      <Field label={<span className="sr-only">Void reason</span>} rule={INVENTORY_RETURN_VOID_RULES.reason}>
                        <Input {...nativeAttrs(INVENTORY_RETURN_VOID_RULES.reason)} placeholder="void reason" className="w-28" />
                      </Field>
                      <ConfirmDestructive
                        tier="admin-pin"
                        label="Void supplier return"
                        consequence="Gives the stock back and reverses the credit. An administrator must approve with their own PIN."
                      />
                    </CheckedForm>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Page>
  );
}

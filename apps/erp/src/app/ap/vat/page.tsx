import Link from 'next/link';
import { authorize } from '@shareat/auth';
import { toBusinessDate } from '@shareat/core/datetime';
import { apRepo } from '@shareat/db';
import { requireSession } from '../../../lib/session';
import { listStores, peso, withOrgPrincipal } from '../lib';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { Button, Input, Select } from '@/components/ui';
import { ACTION_LINK } from '@/components/action-link';

export const metadata = { title: 'Invoices by VAT type and OR — Shareat System' };
export const dynamic = 'force-dynamic';

/** T-408 R4. The rows of the grid, in reading order; `null` is "not recorded". */
const TYPES = [
  { key: 'vatable', label: 'Vatable' },
  { key: 'zero_rated', label: 'Zero-rated' },
  { key: 'exempt', label: 'Exempt' },
  { key: 'non_vat', label: 'Non-VAT' },
  { key: null, label: 'Not recorded' },
] as const;
const TYPE_LABEL = new Map<string | null, string>(TYPES.map((t) => [t.key, t.label]));

export default async function VatListPage({ searchParams }: { searchParams: Promise<{ store?: string; month?: string }> }) {
  const sp = await searchParams;
  const { actor } = await requireSession('/ap/vat');
  const stores = await listStores(actor.orgId);
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(sp.month ?? '') ? sp.month! : toBusinessDate().slice(0, 7);
  const storeId = sp.store ?? '';

  // The gate is the verifier's capability at the chosen store: the manager who checks bills against the paper.
  const data = storeId
    ? await withOrgPrincipal(actor.orgId, async (tx) => {
        await authorize(tx, actor, 'verify_supplier_invoice', { storeId });
        return apRepo.invoicesByVatAndOr(tx, actor.orgId, storeId, month);
      })
    : null;
  const cell = (type: string | null, or: boolean) => data?.groups.find((g) => g.vatType === type && g.isOfficialReceipt === or);

  return (
    <Page density="table">
      <div>
        <Link href="/ap" className={ACTION_LINK}>
          ← Accounts payable
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">Invoices by VAT type and OR</h1>
        <PageDescription>
          Supplier invoices for one store and month, by invoice date. Voided invoices are left out. Use it to match the
          paper receipt file.
        </PageDescription>
      </div>

      <form method="get" className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs font-medium text-neutral-600 dark:text-neutral-400">
          Store
          <Select name="store" defaultValue={storeId} className="w-full">
            <option value="" disabled>Choose…</option>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </Select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-neutral-600 dark:text-neutral-400">
          Month
          <Input type="month" name="month" defaultValue={month} />
        </label>
        <Button type="submit" variant="secondary">Show</Button>
      </form>

      {!data ? (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">Choose a store to see its invoices.</p>
      ) : (
        <>
          <section className="space-y-2">
            <h2 className="font-medium">Summary</h2>
            <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
              <table className="w-full min-w-[600px] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                    <th className="px-3 py-2 font-medium">VAT type</th>
                    <th className="px-3 py-2 font-medium">Official receipt</th>
                    <th className="px-3 py-2 font-medium">Not an official receipt</th>
                  </tr>
                </thead>
                <tbody>
                  {TYPES.map((t) => (
                    <tr key={t.label} className="border-b border-neutral-100 last:border-0 dark:border-neutral-900">
                      <td className="px-3 py-2">{t.label}</td>
                      {[true, false].map((or) => {
                        const c = cell(t.key, or);
                        return (
                          <td key={String(or)} className="px-3 py-2 font-mono text-xs tabular-nums">
                            {c ? (
                              <>
                                {c.count} {c.count === 1 ? 'invoice' : 'invoices'} · total {peso(c.total)}
                                {c.vat != null && <> · VAT {peso(c.vat)}</>}
                              </>
                            ) : (
                              '—'
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="space-y-2">
            <h2 className="font-medium">Invoices</h2>
            {data.invoices.length > 0 ? (
              <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
                <table className="w-full min-w-[720px] border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                      <th className="px-3 py-2 font-medium">Date</th>
                      <th className="px-3 py-2 font-medium">Supplier</th>
                      <th className="px-3 py-2 font-medium">Invoice no.</th>
                      <th className="px-3 py-2 text-right font-medium">Total</th>
                      <th className="px-3 py-2 text-right font-medium">VAT</th>
                      <th className="px-3 py-2 font-medium">VAT type</th>
                      <th className="px-3 py-2 font-medium">OR</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.invoices.map((i) => (
                      <tr key={i.id} className="border-b border-neutral-100 last:border-0 dark:border-neutral-900">
                        <td className="px-3 py-2">{i.invoiceDate}</td>
                        <td className="px-3 py-2">{i.supplierName}</td>
                        <td className="px-3 py-2">
                          <Link href={`/ap/invoices/${i.id}`} className={ACTION_LINK}>
                            {i.invoiceNo ?? i.id.slice(0, 8)}
                          </Link>
                        </td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums">{peso(i.totalAmount)}</td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums">{i.vatAmount != null ? peso(i.vatAmount) : '—'}</td>
                        <td className="px-3 py-2">{TYPE_LABEL.get(i.vatType)}</td>
                        <td className="px-3 py-2">{i.isOfficialReceipt ? 'Yes' : 'No'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-neutral-500 dark:text-neutral-400">No invoices for this store and month.</p>
            )}
          </section>
        </>
      )}
    </Page>
  );
}

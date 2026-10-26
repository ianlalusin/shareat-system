import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requirePageAccess } from '../../../../../lib/page-access';
import { peso } from '../../../../../lib/format';
import { receiveInterEntityShipmentAction } from '../actions';
import { inboundReceiveChoices, inboundShipment, listStores } from '../lib';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { Badge, Button, FlashBanner, Input, Select } from '@/components/ui';
import { withFlash } from '@/lib/flash';

export const metadata = { title: 'Receive a shipment — Shareat System' };
export const dynamic = 'force-dynamic';

export default async function InboundShipmentPage({
  params,
  searchParams,
}: {
  params: Promise<{ shipmentId: string }>;
  searchParams: Promise<{ ok?: string; error?: string; warning?: string }>;
}) {
  const { shipmentId } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(shipmentId)) notFound();
  const sp = await withFlash(searchParams);
  const { actor, refusal } = await requirePageAccess(`/inventory/deliveries/inbound/${shipmentId}`);
  if (refusal) return refusal;
  const [shipment, choices] = await Promise.all([inboundShipment(actor, shipmentId), inboundReceiveChoices(actor, shipmentId)]);
  if (!shipment || !choices) notFound();
  const { supplierName, items } = choices;
  const stores = await listStores(actor.orgId);
  const canReceive = shipment.status === 'in_transit';
  const action = receiveInterEntityShipmentAction.bind(null, shipment.id);

  return (
    <Page view="detail" sectioned density="table">
      <div>
        <Link href="/inventory/deliveries/inbound" className="inline-flex min-h-6 items-center text-sm underline underline-offset-4">
          ← Shipments to receive
        </Link>
        <h1 className="mt-2 flex items-center gap-3 text-2xl font-semibold">
          Shipment{supplierName ? ` from ${supplierName}` : ''}
          <Badge status={shipment.status} />
        </h1>
        <PageDescription className="mt-1">
          Shipped {shipment.shippedOn} · billed {peso(shipment.billedTotal)}
          {shipment.receivedTotal !== null && <> · received {peso(shipment.receivedTotal)}</>}
        </PageDescription>
      </div>

      <FlashBanner flash={sp} />

      {shipment.status === 'void' && (
        <p className="text-sm text-neutral-700 dark:text-neutral-300">The sender cancelled this shipment. It cannot be received.</p>
      )}

      {canReceive && items.length === 0 && (
        <p className="text-sm text-neutral-700 dark:text-neutral-300">
          None of your items are listed under {supplierName ?? 'this supplier'} yet. Add them to the supplier&apos;s item list first, then come back
          to receive.
        </p>
      )}

      <form action={action} className="space-y-4">
        <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
          <table className="w-full min-w-[720px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                <th className="px-3 py-2 font-medium">Sent as</th>
                <th className="px-3 py-2 text-right font-medium">Shipped</th>
                <th className="px-3 py-2 text-right font-medium">Rate</th>
                {canReceive ? (
                  <>
                    <th className="px-3 py-2 font-medium">Your item</th>
                    <th className="px-3 py-2 text-right font-medium">Received</th>
                  </>
                ) : (
                  <th className="px-3 py-2 text-right font-medium">Received</th>
                )}
              </tr>
            </thead>
            <tbody>
              {shipment.lines.map((l) => {
                const shippedQty = l.quantity;
                const sentAs = l.itemName;
                const unit = l.unit;
                const match = items.find((i) => i.name.trim().toLowerCase() === sentAs.trim().toLowerCase());
                const matchId = match ? match.id : '';
                return (
                  <tr key={l.id} className="border-b border-neutral-100 align-top last:border-0 dark:border-neutral-900">
                    <td className="px-3 py-2">{sentAs}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {shippedQty} {unit}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">{peso(l.rate)}</td>
                    {canReceive ? (
                      <>
                        <td className="px-3 py-2">
                          <input type="hidden" name="line" value={l.id} />
                          <Select name="item" defaultValue={matchId} className="text-xs">
                            <option value="">— choose your item —</option>
                            {items.map((i) => (
                              <option key={i.id} value={i.id}>
                                {i.name} ({i.baseUnit})
                              </option>
                            ))}
                          </Select>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          <Input name="receivedQuantity" defaultValue={shippedQty} className="w-24 text-right tabular-nums" />
                        </td>
                      </>
                    ) : (
                      <td className="px-3 py-2 text-right tabular-nums">{l.receivedQuantity !== null ? `${l.receivedQuantity} ${unit}` : '—'}</td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {canReceive && (
          <div className="flex flex-wrap items-end gap-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
            <label className="text-sm">
              <span className="block text-neutral-600 dark:text-neutral-400">Receive into store</span>
              <Select name="store" defaultValue={stores[0]?.id ?? ''} className="mt-1">
                {stores.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.code})
                  </option>
                ))}
              </Select>
            </label>
            <p className="grow text-xs text-neutral-500 dark:text-neutral-400">
              Count what actually arrived; enter 0 for a line that did not. Your stock goes up at the shipment rate, and what you owe the sender is
              for what you counted, not what was shipped.
            </p>
            <Button type="submit" variant="primary">
              Receive
            </Button>
          </div>
        )}
      </form>
    </Page>
  );
}

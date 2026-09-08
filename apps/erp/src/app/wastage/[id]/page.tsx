import Link from 'next/link';
import { notFound } from 'next/navigation';
import { asc, eq } from 'drizzle-orm';
import { orderWastageRepo, schema } from '@shareat/db';
import { listPostedSettlementsForStore, matchWastagesToSettlement, type SettleableOrderWastage } from '@shareat/domain';
import { toBusinessDate } from '@shareat/core/datetime';
import { peso } from '../../../lib/format';
import { requireSession } from '../../../lib/session';
import { withOrgPrincipal } from '../../expenses/lib';
import {
  confirmSettlementMatchAction,
  disputeOrderWastageAction,
  resolveOrderWastageAction,
  reverseAutoChargeAction,
} from '../actions';
import { Page } from '@/components/shell/Page';

export const metadata = { title: 'Order wastage — Shareat System' };
export const dynamic = 'force-dynamic';

const ALLOCATION_ROWS = [1, 2, 3];

interface SearchParams {
  error?: string;
  ok?: string;
}

export default async function WastageDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const { actor } = await requireSession(`/wastage/${id}`);

  const data = await withOrgPrincipal(actor.orgId, async (tx) => {
    const row = await orderWastageRepo.findById(tx, actor.orgId, id);
    if (!row) return null;
    const allocations = await orderWastageRepo.listAllocations(tx, row.id);
    const [salesDay] = await tx
      .select({ businessDate: schema.salesDays.businessDate })
      .from(schema.salesDays)
      .where(eq(schema.salesDays.id, row.salesDayId));
    const people = await tx
      .select({ id: schema.persons.id, name: schema.persons.displayName })
      .from(schema.persons)
      .where(eq(schema.persons.orgId, actor.orgId))
      .orderBy(asc(schema.persons.displayName));
    const settlements =
      row.typeMode === 'tracked' && row.status !== 'resolved'
        ? await listPostedSettlementsForStore(tx, actor, { storeId: row.storeId })
        : [];
    return { row, allocations, businessDate: salesDay?.businessDate ?? null, people, settlements };
  });

  if (!data) notFound();
  const { row, allocations, businessDate, people, settlements } = data;

  const match =
    businessDate && row.status !== 'resolved'
      ? matchWastagesToSettlement(
          [
            {
              wastageId: row.id, storeId: row.storeId, channelId: row.channelId, channel: row.channel,
              businessDate,
              amount: row.amount, orderRef: row.orderRef, status: row.status as 'open' | 'disputed',
            } satisfies SettleableOrderWastage,
          ],
          settlements,
        )[0]
      : undefined;

  const nameById = new Map(people.map((p) => [p.id, p.name]));
  const canReverse =
    row.autoCharged && row.resolvedAt !== null &&
    (Date.now() - row.resolvedAt.getTime()) / 86_400_000 <= 30;

  return (
    <Page density="form">
      <div>
        <Link href={`/wastage?store=${row.storeId}`} className="text-sm underline underline-offset-4">
          ← Order wastage
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">
          {row.channel} — {peso(row.amount)}
        </h1>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          {row.typeMode === 'instant' ? 'Instant' : 'Tracked'} · opened {row.openedAt.toISOString().slice(0, 10)}
          {row.orderRef ? ` · order ${row.orderRef}` : ''}
        </p>
        <p className="mt-1 text-sm">&ldquo;{row.reason}&rdquo;</p>
      </div>

      {sp.error && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-300">{sp.error}</div>
      )}
      {sp.ok && (
        <div className="rounded-lg border border-green-300 bg-green-50 p-4 text-sm text-green-900 dark:border-green-800 dark:bg-green-950 dark:text-green-300">{sp.ok}</div>
      )}

      <section className="rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
        <h2 className="font-medium">Status</h2>
        <p className="mt-1">
          {row.status === 'resolved'
            ? `Resolved as ${row.disposition}${row.autoCharged ? ' — by the 15-day backstop' : ''}.`
            : row.status === 'disputed'
              ? 'Disputed — the 15-day clock is unaffected (it runs from opened_at, uniformly).'
              : 'Open, awaiting a disposition.'}
        </p>
        {allocations.length > 0 && (
          <div className="mt-2">
            <span className="text-neutral-600 dark:text-neutral-400">Responsible party:</span>{' '}
            {allocations.map((a) => `${nameById.get(a.personId) ?? a.personId} ${a.percent}%`).join(', ')}
          </div>
        )}
      </section>

      {match && (
        <section className="rounded-lg border border-amber-400 bg-amber-50 p-4 text-sm dark:border-amber-700 dark:bg-amber-950">
          <h2 className="font-medium">⭐ Possible settlement match</h2>
          <p className="mt-1 text-neutral-700 dark:text-neutral-300">{match.rationale}</p>
          <form action={confirmSettlementMatchAction} className="mt-3">
            <input type="hidden" name="id" value={row.id} />
            <input type="hidden" name="storeId" value={row.storeId} />
            <input type="hidden" name="settlementId" value={match.settlementId} />
            <button type="submit" className="rounded-md border border-neutral-300 px-3 py-1.5 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900">
              Mark paid by the platform — posts nothing
            </button>
          </form>
        </section>
      )}

      {row.status !== 'resolved' && (
        <section className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="font-medium">Decide</h2>
          <form action={resolveOrderWastageAction} className="mt-3 space-y-3 text-sm">
            <input type="hidden" name="id" value={row.id} />
            <input type="hidden" name="storeId" value={row.storeId} />
            <input type="hidden" name="resolvedOn" value={toBusinessDate()} />
            <label className="flex flex-col gap-1">
              <span className="text-neutral-600 dark:text-neutral-400">Disposition</span>
              <select name="disposition" defaultValue="absorbed" className="rounded-md border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900">
                <option value="platform_paid">Platform paid — posts nothing</option>
                <option value="absorbed">Store absorbs — Dr 5300 / Cr 1220</option>
                <option value="charged">Charge staff — Dr 1230 / Cr 1220, split by allocation</option>
              </select>
            </label>
            <div>
              <p className="text-xs text-neutral-500 dark:text-neutral-500">
                For &ldquo;Charge staff&rdquo; — leave blank to reuse the allocation already on
                this wastage, or name one to three people whose percentages sum to exactly 100.
              </p>
              {ALLOCATION_ROWS.map((n) => (
                <div key={n} className="mt-1 grid grid-cols-[1fr_6rem] gap-2">
                  <select name="personId" defaultValue={allocations[n - 1]?.personId ?? ''} className="rounded-md border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900">
                    <option value="">— person {n} (optional) —</option>
                    {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                  <input name="percent" inputMode="decimal" placeholder="%" defaultValue={allocations[n - 1]?.percent ?? ''} className="rounded-md border border-neutral-300 px-2 py-1 tabular-nums dark:border-neutral-700 dark:bg-neutral-900" />
                </div>
              ))}
            </div>
            <button type="submit" className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200">
              Resolve
            </button>
          </form>

          {row.status === 'open' && row.typeMode === 'tracked' && (
            <form action={disputeOrderWastageAction} className="mt-4">
              <input type="hidden" name="id" value={row.id} />
              <input type="hidden" name="storeId" value={row.storeId} />
              <button type="submit" className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900">
                Dispute — flag for review, does not stop the 15-day clock
              </button>
            </form>
          )}
        </section>
      )}

      {row.status === 'resolved' && row.autoCharged && (
        <section className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="font-medium">Reverse the backstop&apos;s decision</h2>
          {canReverse ? (
            <form action={reverseAutoChargeAction} className="mt-3 space-y-2 text-sm">
              <input type="hidden" name="id" value={row.id} />
              <input type="hidden" name="storeId" value={row.storeId} />
              <input name="reason" required placeholder="Why is this being reversed?" className="w-full rounded-md border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900" />
              <button type="submit" className="rounded-md border border-neutral-300 px-3 py-1.5 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900">
                Reverse — then resolve again with the correct disposition
              </button>
            </form>
          ) : (
            <p className="mt-1 text-sm text-neutral-500">More than 30 days since the backstop resolved this — no longer reversible here.</p>
          )}
        </section>
      )}
    </Page>
  );
}

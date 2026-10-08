import Link from 'next/link';
import { ORDER_WASTAGE_DISPOSITION_LABEL, orderWastageDispositionLabel, orderWastageRepo, salesDaysRepo, schema, storesRepo } from '@shareat/db';
import { listPostedSettlementsForStore, matchWastagesToSettlement, type SettleableOrderWastage } from '@shareat/domain';
import { inArray } from 'drizzle-orm';
import { toBusinessDate } from '@shareat/core/datetime';
import { peso } from '../../lib/format';
import { requireSession } from '../../lib/session';
import { listStores, withOrgPrincipal } from '../expenses/lib';
import { recordOrderWastageAction } from './actions';
import { Page } from '@/components/shell/Page';
import { FormGrid, Field } from '@/components/ui';
import { FilterRow } from '@/components/FilterRow';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';

export const metadata = { title: 'Order wastage — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  store?: string;
  error?: string;
  ok?: string;
}

const STATUS_LABEL: Record<string, string> = { open: 'Open', disputed: 'Disputed', resolved: 'Resolved' };

export default async function WastagePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await withFlash(searchParams);
  const { actor } = await requireSession('/wastage');
  const stores = await listStores(actor.orgId);
  const storeId = sp.store && stores.some((s) => s.id === sp.store) ? sp.store : stores[0]?.id;

  if (!storeId) {
    return (
      <Page density="table" className="">
        <h1 className="text-2xl font-semibold">Order wastage</h1>
        <p className="mt-4 text-sm text-neutral-600">This organisation has no stores yet.</p>
      </Page>
    );
  }

  const { open, channels, recent, monitor } = await withOrgPrincipal(actor.orgId, async (tx) => ({
    open: await orderWastageRepo.listOpen(tx, actor.orgId, storeId),
    // ⭐ ACTIVE only — a retired channel must not be offered for a NEW wastage. T-230 shipped the
    // first writer `is_active` has ever had, so before it this distinction could not bite.
    channels: await salesDaysRepo.listChannels(tx, actor.orgId, storeId, { activeOnly: true }),
    // ⭐ T-229 slice 3 — named, not assumed. This screen used to instruct people to "set the
    // Monitor under Settings" without knowing, or saying, whether one was set.
    monitor: await storesRepo.wastageMonitorWithName(tx, actor.orgId, storeId),
    recent: await orderWastageRepo.listRecent(tx, actor.orgId, storeId, 20),
  }));
  const resolvedHistory = recent.filter((w) => w.status === 'resolved');

  // ⭐ Settlement matching (§4/§9) — proposes only. Built from the store's open wastages plus
  // every posted settlement for the store; the pure matcher decides which pairs share a
  // channel-day. Only TRACKED, unresolved rows are candidates.
  const trackedOpen = open.filter((w) => w.typeMode === 'tracked' && w.status !== 'resolved');
  const { businessDates, settlements } = await withOrgPrincipal(actor.orgId, async (tx) => {
    const salesDayIds = [...new Set(trackedOpen.map((w) => w.salesDayId))];
    const days = salesDayIds.length
      ? await tx
          .select({ id: schema.salesDays.id, businessDate: schema.salesDays.businessDate })
          .from(schema.salesDays)
          .where(inArray(schema.salesDays.id, salesDayIds))
      : [];
    return {
      businessDates: new Map(days.map((d) => [d.id, d.businessDate])),
      settlements: await listPostedSettlementsForStore(tx, actor, { storeId }),
    };
  });
  // ⚠️ **The map's return type is annotated, and the filter carries NO type predicate.** That is
  // the whole guard, and it was learned the hard way: this literal was missing `channelId` and
  // typecheck stayed clean, because a `(w): w is SettleableOrderWastage` predicate on the filter
  // ASSERTED the shape rather than checking it. The matcher then keyed on `store|undefined|date`
  // and this page proposed no settlement match ever again — silently, because a proposal that
  // never renders is one nobody can miss. Annotating the map makes an incomplete literal a
  // COMPILE error; TS 5.5+ infers the narrowing predicate for `w !== null` on its own, so nothing
  // is lost by removing it.
  const wastagesForMatch: SettleableOrderWastage[] = trackedOpen
    .map((w): SettleableOrderWastage | null => {
      const businessDate = businessDates.get(w.salesDayId);
      if (!businessDate) return null;
      return {
        wastageId: w.id, storeId: w.storeId, channelId: w.channelId, channel: w.channel, businessDate,
        amount: w.amount, orderRef: w.orderRef, status: w.status as 'open' | 'disputed',
      };
    })
    .filter((w) => w !== null);
  const matches = matchWastagesToSettlement(wastagesForMatch, settlements);

  return (
    <Page density="table">
      <div>
        <h1 className="text-2xl font-semibold">Order wastage</h1>
        <PageDescription className="mt-1">
          A refunded or remade order — economics and staff accountability, never stock. Raw-stock
          wastage is recorded under Inventory.
        </PageDescription>
      </div>

      <FilterRow>
        <label className="text-sm">
          <span className="block text-neutral-600 dark:text-neutral-400">Store</span>
          <select name="store" defaultValue={storeId} className="mt-1 rounded-md border border-neutral-300 px-2 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950">
            {stores.map((s) => (
              <option key={s.id} value={s.id}>{s.name} ({s.code})</option>
            ))}
          </select>
        </label>
      </FilterRow>

      {sp.error && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-300">{sp.error}</div>
      )}
      {sp.ok && (
        <div className="rounded-lg border border-green-300 bg-green-50 p-4 text-sm text-green-900 dark:border-green-800 dark:bg-green-950 dark:text-green-300">{sp.ok}</div>
      )}

      <section className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="font-medium">Record a wastage</h2>
        <form action={recordOrderWastageAction} className="mt-3 space-y-3 text-sm">
          <input type="hidden" name="storeId" value={storeId} />
          <FormGrid>
            {/* ⭐ T-230 — a SELECT of configured channels, not free text with a datalist hint.
                Two reasons, and the first is the whole task: the channel now carries the wastage
                policy (bible §13 row 180), so `recordOrderWastage` must resolve a REAL channel at
                creation to derive it. The second is a defect this closes on the way past — a typed
                name nothing matched used to create a tracked wastage that no human and no backstop
                could ever resolve, and it only surfaced days later at posting time. */}
            <Field label={<span className="text-neutral-600 dark:text-neutral-400">Channel</span>}>
              <select name="channel" required defaultValue="" className="mt-1 block w-full rounded-md border border-neutral-300 px-2 py-2 dark:border-neutral-700 dark:bg-neutral-950">
                <option value="" disabled>Choose a channel…</option>
                {channels.map((c) => (
                  <option key={c.id} value={c.name}>
                    {c.name} — {c.wastageTypeMode === 'tracked' ? 'reviewed' : 'decided on the spot'}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={<span className="text-neutral-600 dark:text-neutral-400">Business date</span>}>
              <input type="date" name="businessDate" defaultValue={toBusinessDate()} required className="mt-1 block w-full rounded-md border border-neutral-300 px-2 py-2 dark:border-neutral-700 dark:bg-neutral-950" />
            </Field>
            <Field label={<span className="text-neutral-600 dark:text-neutral-400">Platform order ref (optional)</span>}>
              <input name="orderRef" className="mt-1 block w-full rounded-md border border-neutral-300 px-2 py-2 dark:border-neutral-700 dark:bg-neutral-950" />
            </Field>
            <Field label={<span className="text-neutral-600 dark:text-neutral-400">Amount</span>}>
              <input name="amount" inputMode="decimal" required placeholder="0.00" className="mt-1 block w-full rounded-md border border-neutral-300 px-2 py-2 tabular-nums dark:border-neutral-700 dark:bg-neutral-950" />
            </Field>
            <Field label={<span className="text-neutral-600 dark:text-neutral-400">Reason</span>} span="wide">
              <input name="reason" required className="mt-1 block w-full rounded-md border border-neutral-300 px-2 py-2 dark:border-neutral-700 dark:bg-neutral-950" />
            </Field>
          {/* ⛔ THE TWO MODE RADIOS ARE GONE — bible §13 row 180, Ian 2026-09-07. They let the
              person recording a loss mark it `instant` + `absorbed` and skip the Wastage Monitor,
              the 48-hour dispute window and the 15-day auto-charge backstop in one click: the
              control was optional to the person it controls. The CHANNEL carries the policy now,
              and the channel dropdown above says which policy each one has.
              ⚠️ The DISPOSITION stays, because it is a different kind of thing — a fact about what
              happened to the money, not a decision about whether that fact may be made on the
              spot. It is required on an instant channel and refused on a tracked one. */}
            <Field
              span="wide"
              label={
                <span className="text-neutral-600 dark:text-neutral-400">
                  Disposition <span className="text-neutral-400">— only for a decided-on-the-spot channel</span>
                </span>
              }
            >
              <select name="disposition" defaultValue="" className="mt-1 block w-full rounded-md border border-neutral-300 px-2 py-2 dark:border-neutral-700 dark:bg-neutral-900">
                <option value="">(reviewed channel — leave blank)</option>
                <option value="platform_paid">Platform paid — posts nothing</option>
                <option value="absorbed">Store absorbs — Dr 5300</option>
              </select>
            </Field>
          </FormGrid>
          {/* ⭐ T-229 slice 3 — this used to say "set the Monitor under Settings", pointing at a
              screen that did not exist, and it never said whether one WAS set. Now it names them,
              or says plainly that nobody is named and what that costs. */}
          <p className="text-xs text-neutral-500 dark:text-neutral-500">
            On a <strong>reviewed</strong> channel this waits for a decision, and is created in the
            name of{' '}
            {monitor ? (
              <>
                this store&apos;s Wastage Monitor, <strong>{monitor.displayName}</strong>
                {!monitor.isActive && <> ⚠️ (no longer active)</>}
              </>
            ) : (
              <strong>nobody — no Monitor is named at this store</strong>
            )}
            .{' '}
            {!monitor && (
              <>
                ⚠️ It will be created ownerless, and after 15 days the store absorbs it: nothing is
                recovered and nothing errors.{' '}
              </>
            )}
            A &ldquo;{ORDER_WASTAGE_DISPOSITION_LABEL.charged}&rdquo; disposition needs an allocation, which this quick form does not
            offer; record it and use the detail page.{' '}
            <a href="/settings/wastage-monitor" className="underline underline-offset-2">
              {monitor ? 'Change the Monitor' : 'Name a Monitor'}
            </a>{' '}
            ·{' '}
            <a href="/settings/sales-channels" className="underline underline-offset-2">
              Change a channel&apos;s wastage policy
            </a>
            .
          </p>
          <button type="submit" className="rounded-md bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200">Save</button>
        </form>
      </section>

      {matches.length > 0 && (
        <section className="rounded-lg border border-amber-400 bg-amber-50 p-4 text-sm dark:border-amber-700 dark:bg-amber-950">
          <h2 className="font-medium">⭐ {matches.length} possible settlement match{matches.length === 1 ? '' : 'es'}</h2>
          <p className="mt-1 text-neutral-700 dark:text-neutral-300">
            A posted channel settlement exists for the same store, channel and business date as
            these open wastages. Review each before deciding — this list proposes; nothing here
            posts on its own.
          </p>
          <ul className="mt-3 space-y-1">
            {matches.map((m) => (
              <li key={`${m.wastageId}:${m.settlementId}`}>
                <Link href={`/wastage/${m.wastageId}`} className="underline underline-offset-4">
                  {m.channel} · {m.businessDate} · {peso(m.amount)}
                </Link>{' '}
                — {m.rationale}
              </li>
            ))}
          </ul>
        </section>
      )}

      {open.length === 0 ? (
        <p className="text-sm text-neutral-600 dark:text-neutral-400">Nothing open at this store.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
          <table className="w-full min-w-[640px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                <th className="px-3 py-2 font-medium">Opened</th>
                <th className="px-3 py-2 font-medium">Channel</th>
                <th className="px-3 py-2 font-medium">Order ref</th>
                <th className="px-3 py-2 text-right font-medium">Amount</th>
                <th className="px-3 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {open.map((w) => (
                <tr key={w.id} className="border-b border-neutral-100 last:border-0 dark:border-neutral-900">
                  <td className="px-3 py-2 tabular-nums">
                    <Link href={`/wastage/${w.id}`} className="underline underline-offset-4">
                      {toBusinessDate(w.openedAt)}
                    </Link>
                  </td>
                  <td className="px-3 py-2">{w.channel}</td>
                  <td className="px-3 py-2 text-neutral-600 dark:text-neutral-400">{w.orderRef ?? '—'}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">{peso(w.amount)}</td>
                  <td className="px-3 py-2">{STATUS_LABEL[w.status] ?? w.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {resolvedHistory.length > 0 && (
        <section>
          <h2 className="font-medium">Recent history</h2>
          <div className="mt-2 overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
            <table className="w-full min-w-[640px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                  <th className="px-3 py-2 font-medium">Opened</th>
                  <th className="px-3 py-2 font-medium">Channel</th>
                  <th className="px-3 py-2 text-right font-medium">Amount</th>
                  <th className="px-3 py-2 font-medium">Disposition</th>
                </tr>
              </thead>
              <tbody>
                {resolvedHistory.map((w) => (
                  <tr key={w.id} className="border-b border-neutral-100 last:border-0 dark:border-neutral-900">
                    <td className="px-3 py-2 tabular-nums">
                      <Link href={`/wastage/${w.id}`} className="underline underline-offset-4">
                        {toBusinessDate(w.openedAt)}
                      </Link>
                    </td>
                    <td className="px-3 py-2">{w.channel}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">{peso(w.amount)}</td>
                    <td className="px-3 py-2 text-neutral-600 dark:text-neutral-400">
                      {w.disposition ? orderWastageDispositionLabel(w.disposition) : ''}
                      {w.autoCharged ? ' (15-day backstop)' : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </Page>
  );
}

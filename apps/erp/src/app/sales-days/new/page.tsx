import { notFound } from 'next/navigation';
import { toBusinessDate } from '@shareat/core/datetime';
import { listOrgs, listStores, listActingPersons, listChannels } from '../lib';
import { createSalesDayAction } from '../actions';

export const metadata = { title: 'New sales day — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  org?: string;
  store?: string;
  as?: string;
  error?: string;
}

const FIELD =
  'w-full rounded border border-neutral-300 bg-white px-2 py-1 text-right tabular-nums dark:border-neutral-700 dark:bg-neutral-950';
const LABEL = 'text-xs font-medium text-neutral-500 dark:text-neutral-400';

export default async function NewSalesDayPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;

  const orgs = await listOrgs();
  if (orgs.length === 0) notFound();
  const orgId = sp.org && orgs.some((o) => o.id === sp.org) ? sp.org : orgs[0]!.id;

  const [stores, persons] = await Promise.all([listStores(orgId), listActingPersons(orgId)]);
  const storeId = sp.store && stores.some((s) => s.id === sp.store) ? sp.store : stores[0]?.id;
  const actingPersonId =
    sp.as && persons.some((p) => p.id === sp.as)
      ? sp.as
      : (persons.find((p) => p.role === 'manager')?.id ?? persons[0]?.id ?? '');

  const channels = storeId ? await listChannels(orgId, storeId) : [];
  const activeChannels = channels.filter((c) => c.isActive);

  const carry = new URLSearchParams();
  carry.set('org', orgId);
  if (storeId) carry.set('store', storeId);
  if (actingPersonId) carry.set('as', actingPersonId);

  return (
    <main className="mx-auto max-w-4xl space-y-6 p-8">
      <div>
        <a
          href={`/sales-days?${carry.toString()}`}
          className="text-sm text-neutral-500 underline hover:no-underline dark:text-neutral-400"
        >
          ← All sales days
        </a>
        <h1 className="mt-1 text-2xl font-semibold">New sales day</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Saved as a draft. <strong>Nothing posts to the ledger until it is verified</strong> — and
          verifying is what recognises the revenue.
        </p>
      </div>

      {sp.error && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          <strong className="font-medium">Refused:</strong> {sp.error}
        </div>
      )}

      <form action={createSalesDayAction} className="space-y-6 text-sm">
        <input type="hidden" name="orgId" value={orgId} />

        <section className="grid gap-4 sm:grid-cols-3">
          <label className="flex flex-col gap-1">
            <span className={LABEL}>Store</span>
            <select
              name="storeId"
              defaultValue={storeId ?? ''}
              className="rounded border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-950"
            >
              {stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.code})
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className={LABEL}>Business date</span>
            <input
              type="date"
              name="businessDate"
              defaultValue={toBusinessDate()}
              className="rounded border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-950"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className={LABEL}>
              Acting as <span className="italic">(no login yet)</span>
            </span>
            <select
              name="actingPersonId"
              defaultValue={actingPersonId}
              className="rounded border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-950"
            >
              {persons.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName} ({p.role})
                </option>
              ))}
            </select>
          </label>
        </section>

        <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="font-medium">Revenue</h2>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            <strong>Unli + à la carte must equal the total.</strong> À la carte absorbs dine-in à la
            carte, take-out and delivery alike — POS has no take-out flag.
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            <Money name="totalSales" label="Total sales" />
            <Money name="unliSales" label="Unlimited (→ 4100)" />
            <Money name="alaCarteSales" label="À la carte (→ 4150)" />
          </div>
        </section>

        <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="font-medium">Discounts and comps</h2>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            Senior and PWD are separate because <strong>RR 5-2017 requires the breakout</strong>.
            All three post to 4900; <strong>comps post to 4950</strong>, never 4900 and never a
            marketing expense.
          </p>
          <div className="grid gap-3 sm:grid-cols-4">
            <Money name="seniorDiscount" label="Senior" />
            <Money name="pwdDiscount" label="PWD" />
            <Money name="otherDiscount" label="Other" />
            <Money name="comps" label="Comps (→ 4950)" />
          </div>
        </section>

        <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="font-medium">Tender — where the money went</h2>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            Cash + online + credit + non-remitted channels + discounts + comps{' '}
            <strong>must equal the total</strong>. Card tenders go through online.
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            <Money name="cashCollected" label="Cash (→ 1110 cashier)" />
            <Money name="onlineCollected" label="Online / e-wallet (→ 1140)" />
            <Money name="creditSales" label="Credit / on account" />
          </div>
        </section>

        {activeChannels.length > 0 && (
          <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
            <h2 className="font-medium">Sales channels</h2>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              A <strong>remitted</strong> channel&apos;s money reaches the till. A{' '}
              <strong>non-remitted</strong> one (Foodpanda, GrabFood) settles to a bank later and
              posts a receivable instead. ⭐ Tick <em>no sales</em> to say so explicitly —{' '}
              <strong>that is different from leaving it blank.</strong>
            </p>
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-neutral-200 text-left dark:border-neutral-800">
                  <th className="py-2 font-medium">Channel</th>
                  <th className="py-2 font-medium">Remittance</th>
                  <th className="py-2 text-right font-medium">Amount</th>
                  <th className="py-2 text-center font-medium">No sales</th>
                </tr>
              </thead>
              <tbody>
                {activeChannels.map((c) => (
                  <tr key={c.id} className="border-b border-neutral-100 last:border-0 dark:border-neutral-900">
                    <td className="py-2">{c.name}</td>
                    <td className="py-2">
                      {c.isRemittedDaily ? (
                        <span className="text-xs text-neutral-500 dark:text-neutral-400">
                          reaches the till
                        </span>
                      ) : (
                        <span className="text-xs text-amber-700 dark:text-amber-400">
                          settles later → {c.receivableAccountCode}
                        </span>
                      )}
                    </td>
                    <td className="py-2">
                      <input name={`channel_${c.id}`} placeholder="0.00" className={FIELD} />
                    </td>
                    <td className="py-2 text-center">
                      <input type="checkbox" name={`nosales_${c.id}`} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        <label className="flex items-center gap-2">
          <input type="checkbox" name="posSourced" />
          <span className="text-neutral-600 dark:text-neutral-400">
            Figures pulled from POS (rather than typed by hand)
          </span>
        </label>

        <button
          type="submit"
          className="rounded bg-neutral-900 px-4 py-2 font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
        >
          Save draft
        </button>
      </form>
    </main>
  );
}

function Money({ name, label }: { name: string; label: string }) {
  return (
    <label className="flex flex-col gap-1">
      <span className={LABEL}>{label}</span>
      <input name={name} placeholder="0.00" className={FIELD} />
    </label>
  );
}

import { notFound } from 'next/navigation';
import { toBusinessDate } from '@shareat/core/datetime';
import { listStores, listChannels, listMoneyAccountsForPicker } from '../lib';
import { requireSession } from '../../../lib/session';
import { createSalesDayAction } from '../actions';
import { Page } from '@/components/shell/Page';
import { FilterRow } from '@/components/FilterRow';
import { PageDescription } from '@/components/shell/PageDescription';

export const metadata = { title: 'New sales day — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  store?: string;
  error?: string;
}

const FIELD =
  'w-full rounded border border-neutral-300 bg-white px-2 py-1 text-right tabular-nums dark:border-neutral-700 dark:bg-neutral-950';
const LABEL = 'text-xs font-medium text-neutral-500 dark:text-neutral-400';

export default async function NewSalesDayPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;

  const { actor } = await requireSession('/sales-days/new');
  const orgId = actor.orgId;
  const stores = await listStores(orgId);
  const storeId = sp.store && stores.some((s) => s.id === sp.store) ? sp.store : stores[0]?.id;

  const channels = storeId ? await listChannels(orgId, storeId) : [];
  const activeChannels = channels.filter((c) => c.isActive);
  // DEF-148, other half (/code-review): unfiltered wallets let a form built for store A render
  // store B's wallets — create.ts's tender resolver refuses that at save time; filter here to the
  // same storeId the hidden input and the channel listing already use.
  const wallets = (await listMoneyAccountsForPicker(orgId)).filter((w) => w.storeId === storeId);

  const carry = new URLSearchParams();
  if (storeId) carry.set('store', storeId);

  return (
    <Page density="table">
      <div>
        <a
          href={`/sales-days?${carry.toString()}`}
          className="text-sm text-neutral-500 underline hover:no-underline dark:text-neutral-400"
        >
          ← All sales days
        </a>
        <h1 className="mt-1 text-2xl font-semibold">New sales day</h1>
        <PageDescription>
          Saved as a draft. <strong>Nothing posts to the ledger until it is verified</strong> — and
          verifying is what recognises the revenue.
        </PageDescription>
      </div>

      {sp.error && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          <strong className="font-medium">Refused:</strong> {sp.error}
        </div>
      )}

      {stores.length === 0 ? (
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          This organisation has no stores yet.
        </p>
      ) : (
        <>
          {stores.length > 1 && (
            <FilterRow submitLabel="Switch store">
              <label className="flex flex-col gap-1">
                <span className={LABEL}>Store</span>
                {/* text-sm is load-bearing: it used to inherit from the POST form's ancestor
                    className; FilterRow hides that ancestry from the touch-target census, so
                    removing this changes the modelled control size. */}
                <select
                  name="store"
                  defaultValue={storeId}
                  className="rounded border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-950"
                >
                  {stores.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} ({s.code})
                    </option>
                  ))}
                </select>
              </label>
            </FilterRow>
          )}

          <form action={createSalesDayAction} className="space-y-6 text-sm">
            {/* ⭐ No orgId and no "acting as" — both come from the session now (T-138). */}
            <input type="hidden" name="storeId" value={storeId} />
            <section className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1">
                <span className={LABEL}>Store</span>
                <p className="rounded border border-neutral-300 bg-neutral-50 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900">
                  {stores.find((s) => s.id === storeId)?.name} ({stores.find((s) => s.id === storeId)?.code})
                </p>
              </div>
              <label className="flex flex-col gap-1">
            <span className={LABEL}>Business date</span>
            <input
              type="date"
              name="businessDate"
              defaultValue={toBusinessDate()}
              className="rounded border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-950"
            />
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
          <h2 className="font-medium">Charges</h2>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            ⭐ <strong>Only one of these is yours.</strong> Leftover, packaging and other charges{' '}
            <strong>are income (4500)</strong> — you keep them. A <strong>service charge</strong> is
            neither income nor a payable: RA 11360 sends 100% of it to staff, so it sits in a{' '}
            <strong>float (2160)</strong> that fills here and empties through payroll.{' '}
            <strong>It never reaches the P&amp;L</strong>, so it cannot bloat revenue.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Money name="serviceCharge" label="Service charge (→ 2160 float, held for staff)" />
            <Money name="otherCharges" label="Other charges — leftover, packaging (→ 4500)" />
          </div>
        </section>

        <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="font-medium">Tender — where the money went</h2>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            Everything taken in plus everything given away{' '}
            <strong>must equal everything earned</strong> — cash + online + credit + non-remitted
            channels + discounts + comps = gross sales + charges. Card tenders go through online.
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

        {/* ⭐ DEF-068 — WHERE the online money landed. NOT the same question as the channel
            breakdown above: a channel says where the sale came FROM, this says where the money
            WENT. A Foodpanda sale can settle into any wallet, so neither answers the other. */}
        {wallets.length > 0 && (
          <section className="space-y-2 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
            <div>
              <h2 className="font-medium">Where the online money landed</h2>
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                Must add up to the online figure above. 1140 is one account for every wallet, so
                each peso has to say which one it reached — otherwise &ldquo;how much is in the
                cashier&apos;s hands&rdquo; cannot be answered.
              </p>
            </div>
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-neutral-200 text-left dark:border-neutral-800">
                  <th className="py-2 font-medium">Wallet</th>
                  <th className="py-2 font-medium">Held by</th>
                  <th className="py-2 font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {wallets.map((w) => (
                  <tr key={w.id} className="border-b border-neutral-100 last:border-0 dark:border-neutral-900">
                    <td className="py-2">{w.name}</td>
                    <td className="py-2 text-xs text-neutral-500 dark:text-neutral-400">{w.custodian}</td>
                    <td className="py-2">
                      <input name={`tender_${w.id}`} placeholder="0.00" className={FIELD} />
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
        </>
      )}
    </Page>
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

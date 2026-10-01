/**
 * The body of the sales-day form, shared by `/sales-days/new` and `/sales-days/[id]/edit`.
 * T-369 S3 (DEF-479): extracted from `new/page.tsx` so an edit is the SAME form, prefilled.
 *
 * ⚠️ Renders the SECTIONS only - the `<form action=...>` and its hidden `storeId` / `salesDayId`
 * stay on each page. `apps/erp/tests/t339-sales-day-new-store-picker.test.ts` reads `new/page.tsx`'s
 * own source for the form tag and the identifier its hidden `storeId` is bound to; moving the tag in
 * here would silently stop that guard from looking at the thing it guards.
 *
 * R1: the store and the date are never edited, so on an edit the date is plain text, not an input.
 */
import type { ChannelOption } from './lib';

const FIELD =
  'w-full rounded border border-neutral-300 bg-white px-2 py-1 text-sm text-right tabular-nums dark:border-neutral-700 dark:bg-neutral-950';
const LABEL = 'text-xs font-medium text-neutral-500 dark:text-neutral-400';

export interface SalesDayDefaults {
  /** The day's own figures, by input name (`totalSales`, `cashCollected`, ...). Absent = blank. */
  figures?: Record<string, string>;
  /** Channel id -> what the day already says about it. */
  channels?: Record<string, { amount: string; noSales: boolean }>;
  /** Money account id -> the amount the day landed there. */
  tenders?: Record<string, string>;
  posSourced?: boolean;
}

export interface SalesDayFormProps {
  storeLabel: string;
  /** New: an editable date defaulting to this. Edit: shown as text, never an input (R1). */
  businessDate: string;
  dateEditable: boolean;
  channels: ChannelOption[];
  wallets: { id: string; name: string; custodian: string }[];
  defaults?: SalesDayDefaults;
  /** Wallets the day already has money recorded against that are no longer active: shown, never an
   *  input (an edit keeps them as they are). */
  retiredTenders?: { name: string; amount: string }[];
  submitLabel: string;
}

export function SalesDayForm({ storeLabel, businessDate, dateEditable, channels, wallets, defaults, retiredTenders, submitLabel }: SalesDayFormProps) {
  const fig = (name: string) => defaults?.figures?.[name];
  return (
    <>
      <section className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <span className={LABEL}>Store</span>
          <p className="rounded border border-neutral-300 bg-neutral-50 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900">
            {storeLabel}
          </p>
        </div>
        {dateEditable ? (
          <label className="flex flex-col gap-1">
            <span className={LABEL}>Business date</span>
            <input
              type="date"
              name="businessDate"
              defaultValue={businessDate}
              className="rounded border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-950"
            />
          </label>
        ) : (
          <div className="flex flex-col gap-1">
            <span className={LABEL}>Business date</span>
            <p className="rounded border border-neutral-300 bg-neutral-50 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900">
              {businessDate}
            </p>
          </div>
        )}
      </section>

      <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="font-medium">Revenue</h2>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          <strong>Unli + à la carte must equal the total.</strong> À la carte absorbs dine-in à la
          carte, take-out and delivery alike — POS has no take-out flag.
        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          <Money name="totalSales" label="Total sales" value={fig('totalSales')} />
          <Money name="unliSales" label="Unlimited (→ 4100)" value={fig('unliSales')} />
          <Money name="alaCarteSales" label="À la carte (→ 4150)" value={fig('alaCarteSales')} />
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
          <Money name="seniorDiscount" label="Senior" value={fig('seniorDiscount')} />
          <Money name="pwdDiscount" label="PWD" value={fig('pwdDiscount')} />
          <Money name="otherDiscount" label="Other" value={fig('otherDiscount')} />
          <Money name="comps" label="Comps (→ 4950)" value={fig('comps')} />
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
          <Money name="serviceCharge" label="Service charge (→ 2160 float, held for staff)" value={fig('serviceCharge')} />
          <Money name="otherCharges" label="Other charges — leftover, packaging (→ 4500)" value={fig('otherCharges')} />
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
          <Money name="cashCollected" label="Cash (→ 1110 cashier)" value={fig('cashCollected')} />
          <Money name="onlineCollected" label="Online / e-wallet (→ 1140)" value={fig('onlineCollected')} />
          <Money name="creditSales" label="Credit / on account" value={fig('creditSales')} />
        </div>
      </section>

      {channels.length > 0 && (
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
              {channels.map((c) => {
                const prior = defaults?.channels?.[c.id];
                return (
                  <tr key={c.id} className="border-b border-neutral-100 last:border-0 dark:border-neutral-900">
                    <td className="py-2">{c.name}</td>
                    <td className="py-2">
                      {c.isRemittedDaily ? (
                        <span className="text-xs text-neutral-500 dark:text-neutral-400">reaches the till</span>
                      ) : (
                        <span className="text-xs text-amber-700 dark:text-amber-400">
                          settles later → {c.receivableAccountCode}
                        </span>
                      )}
                    </td>
                    <td className="py-2">
                      <input
                        name={`channel_${c.id}`}
                        placeholder="0.00"
                        defaultValue={prior && !prior.noSales ? prior.amount : undefined}
                        className={FIELD}
                      />
                    </td>
                    <td className="py-2 text-center">
                      <input type="checkbox" name={`nosales_${c.id}`} defaultChecked={prior?.noSales ?? false} />
                    </td>
                  </tr>
                );
              })}
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
                    <input name={`tender_${w.id}`} placeholder="0.00" defaultValue={defaults?.tenders?.[w.id]} className={FIELD} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {retiredTenders && retiredTenders.length > 0 && (
        <section className="space-y-2 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="font-medium">Wallets no longer in use</h2>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            Money this day already recorded against wallets that have since been retired. It stays as it
            is and cannot be changed here.
          </p>
          <ul className="text-sm">
            {retiredTenders.map((t) => (
              <li key={t.name} className="flex justify-between gap-4 py-1">
                <span>{t.name}</span>
                <span className="tabular-nums">{t.amount}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <label className="flex items-center gap-2">
        <input type="checkbox" name="posSourced" defaultChecked={defaults?.posSourced ?? false} />
        <span className="text-neutral-600 dark:text-neutral-400">
          Figures pulled from POS (rather than typed by hand)
        </span>
      </label>

      <button
        type="submit"
        className="rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
      >
        {submitLabel}
      </button>
    </>
  );
}

function Money({ name, label, value }: { name: string; label: string; value?: string }) {
  return (
    <label className="flex flex-col gap-1">
      <span className={LABEL}>{label}</span>
      <input name={name} placeholder="0.00" defaultValue={value} className={FIELD} />
    </label>
  );
}

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireSession } from '../../../lib/session';
import {
  recordCollectionAction,
  voidChargeAction,
  voidCollectionAction,
  writeOffChargeAction,
} from '../actions';
import {
  TREATMENT_LABEL,
  TREATMENT_TONE,
  creditBalance,
  getCustomer,
  getPosition,
  listCharges,
  listCollections,
  moneyAccountsFor,
  openItemsFor,
  peso,
  storesWithOpenItems,
  today,
} from '../lib';

export const metadata = { title: 'Customer — Shareat System' };
export const dynamic = 'force-dynamic';

/**
 * T-226 / DEF-190 — **the screen that clears a receivable.**
 *
 * ⛔ `1210 Accounts receivable` was raised automatically by trade dispatch (`trade/index.ts:460` —
 * dispatch IS the billing event) and reported by `/reports/ar-aging` and by a balance column on
 * `/customers`, and **nothing anywhere cleared it**. `recordCollection`, `voidCollection` and
 * `writeOffCharge` shipped with T-131 on 2 September, gated and tested, with zero callers under
 * `apps/`. That is not merely a missing convenience: `recordCharge` enforces the credit limit from
 * the live position, so a customer whose debt can never be cleared eventually hits their limit and
 * can no longer be dispatched to — **the missing screen eventually stops sales.**
 *
 * ⭐ **Every figure here is derived.** There is no `outstanding` column and this task adds none:
 * v1's stored `outstandingBalance` disagreed with its own inputs on 106 of 794 live rows (13.3%),
 * and its *"recompute balance"*, *"repair collection"* and *"mark reconciled"* buttons all exist
 * only to patch that. Nothing to recompute here, so none of the three is ported.
 *
 * ⛔ **The page gates nothing itself.** Every domain function authorizes by contract; this file
 * renders controls and surfaces refusals. DEF-189's lesson binds the reads: never call a gated
 * domain function to satisfy a page read — that returns HTTP 500 where a refusal is wanted.
 */
interface SearchParams {
  error?: string;
  ok?: string;
  /** Which store's receivables are being settled. AR is store-scoped, exactly as AP is. */
  store?: string;
}

export default async function CustomerDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ customerId: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { customerId } = await params;
  const sp = await searchParams;
  const { actor } = await requireSession(`/customers/${customerId}`);
  const orgId = actor.orgId;

  const customer = await getCustomer(orgId, customerId);
  if (!customer) notFound();

  const [owedOverall, credit, storeOptions] = await Promise.all([
    getPosition(orgId, customerId),
    creditBalance(orgId, customerId),
    storesWithOpenItems(orgId, customerId),
  ]);

  // ⭐ CHOSEN, never inferred from whichever open item sorted first — `/ap/suppliers/[id]`'s rule,
  // copied with its reason: that older AP behaviour booked every leg of a payment at one store when
  // the supplier was owed at two, so one store's control account went negative and the other's
  // never cleared. ⚠️ A customer with nothing open still renders; the actions that need an open
  // item are simply absent, with the reason on screen.
  const storeId =
    sp.store && storeOptions.some((s) => s.storeId === sp.store)
      ? sp.store
      : (storeOptions[0]?.storeId ?? '');

  const [charges, collections, openItems, wallets, owedHere] = await Promise.all([
    listCharges(orgId, customerId),
    listCollections(orgId, customerId),
    storeId ? openItemsFor(orgId, customerId, storeId) : Promise.resolve([]),
    storeId ? moneyAccountsFor(orgId, storeId) : Promise.resolve([]),
    storeId ? getPosition(orgId, customerId, storeId) : Promise.resolve('0.00'),
  ]);

  const now = today();
  const storeName = (id: string) => storeOptions.find((s) => s.storeId === id)?.storeName ?? '—';

  return (
    <main className="mx-auto max-w-4xl space-y-6 p-4 sm:p-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link
            href="/customers"
            className="text-sm text-neutral-500 underline hover:no-underline dark:text-neutral-400"
          >
            ← Customers
          </Link>
          <h1 className="mt-1 text-2xl font-semibold">{customer.name}</h1>
          <p className={`text-xs ${TREATMENT_TONE[customer.treatment] ?? ''}`}>
            {TREATMENT_LABEL[customer.treatment]}
            {customer.status !== 'active' && (
              <span className="ml-2 rounded bg-neutral-200 px-1.5 py-0.5 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
                {customer.status}
              </span>
            )}
          </p>
        </div>
        <div className="text-right">
          {/* ⚠️ Two positions, deliberately kept apart. The credit limit is judged ORG-WIDE — a
              limit is extended to a buyer, not to a buyer at one branch — while allocation happens
              per store. Conflating them is how a limit silently becomes per-branch. */}
          <p className="text-xs text-neutral-500 dark:text-neutral-400">Owed overall (1210)</p>
          <p className="text-2xl font-semibold tabular-nums">{peso(owedOverall)}</p>
          {customer.creditLimit !== null && (
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              limit {peso(customer.creditLimit)}
              {Number(owedOverall) > Number(customer.creditLimit) && (
                <span className="ml-1 font-medium text-red-700 dark:text-red-400">over</span>
              )}
            </p>
          )}
          {storeId && (
            <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
              {peso(owedHere)} at {storeName(storeId)}
            </p>
          )}
          {Number(credit) > 0 && (
            <p className="mt-1 text-xs text-emerald-700 dark:text-emerald-400">
              {peso(credit)} store credit held (2140)
            </p>
          )}
        </div>
      </div>

      {sp.error && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          <strong className="font-medium">Refused:</strong> {sp.error}
        </div>
      )}
      {sp.ok && (
        <div className="rounded-lg border border-green-300 bg-green-50 p-4 text-sm text-green-900 dark:border-green-800 dark:bg-green-950 dark:text-green-300">
          {sp.ok}
        </div>
      )}

      {storeOptions.length > 1 && (
        <section className="space-y-2 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="font-medium">Which store&rsquo;s receivables?</h2>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            This customer owes money at more than one store. A collection settles ONE store&rsquo;s
            charges and lands in that store&rsquo;s own account &mdash; collecting across stores
            would clear a receivable the receiving store never recorded.
          </p>
          <div className="flex flex-wrap gap-2">
            {storeOptions.map((s) => (
              <Link
                key={s.storeId}
                href={`/customers/${customerId}?store=${s.storeId}`}
                className={
                  s.storeId === storeId
                    ? 'rounded-lg border border-neutral-900 bg-neutral-900 px-3 py-1.5 text-sm text-white dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900'
                    : 'rounded-lg border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900'
                }
              >
                {s.storeName} &mdash; {peso(s.outstanding)} <span className="opacity-60">({s.count})</span>
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* ------------------------------------------------------------------ Record a collection */}
      {openItems.length > 0 ? (
        <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="font-medium">Record a payment</h2>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            ⛔ Name the charges this settles (bible §16.10 &mdash; a collection must never float
            unallocated). <strong>Total received is GROSS</strong>: the receivable is relieved by
            it, and the account receives it minus the fee. Paying more than allocated becomes real
            store credit at 2140, which the next payment can draw on.
          </p>
          <form action={recordCollectionAction} className="space-y-3">
            <input type="hidden" name="customerId" value={customerId} />
            <input type="hidden" name="storeId" value={storeId} />

            <div className="space-y-1">
              {openItems.map((i) => (
                <label key={i.chargeId} className="flex flex-wrap items-center gap-3 text-sm">
                  <input type="checkbox" name="allocateChargeId" value={i.chargeId} defaultChecked />
                  <span className="min-w-0 flex-1">
                    {i.referenceNo ?? i.chargeDate} &mdash; owed {peso(i.outstanding)}
                    {i.dueDate && (
                      <span
                        className={
                          i.dueDate < now
                            ? 'ml-2 text-xs font-medium text-red-700 dark:text-red-400'
                            : 'ml-2 text-xs text-neutral-500'
                        }
                      >
                        due {i.dueDate}
                        {i.dueDate < now && ' · overdue'}
                      </span>
                    )}
                  </span>
                  <input
                    type="text"
                    inputMode="decimal"
                    name={`allocateAmount_${i.chargeId}`}
                    defaultValue={i.outstanding}
                    aria-label={`Amount applied to ${i.referenceNo ?? i.chargeDate}`}
                    className="w-28 rounded border border-neutral-300 bg-white px-2 py-1 text-right dark:border-neutral-700 dark:bg-neutral-950"
                  />
                </label>
              ))}
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Total received (gross)">
                <input name="amount" required inputMode="decimal" placeholder="0.00" className={INPUT} />
              </Field>
              <Field
                label="Platform fee"
                hint="⛔ Booked here (6400) and NOWHERE else. Never also as an expense."
              >
                <input name="platformFee" inputMode="decimal" placeholder="0.00" className={INPUT} />
              </Field>
              <Field label="Date">
                <input type="date" name="collectionDate" required defaultValue={now} className={INPUT} />
              </Field>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Into account">
                <select name="moneyAccountId" required defaultValue="" className={INPUT}>
                  <option value="" disabled>
                    Choose…
                  </option>
                  {wallets.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name} ({w.custodian}) — {peso(w.balance)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Reference no." hint="Optional.">
                <input name="referenceNo" className={INPUT} />
              </Field>
            </div>

            {/* ⭐ Offered only when there is credit to spend. A field that is always zero teaches
                people to ignore it. */}
            {Number(credit) > 0 && (
              <Field
                label="Store credit to apply"
                hint={`${peso(credit)} held at 2140. Spending it draws the liability down instead of taking cash.`}
              >
                <input name="creditApplied" inputMode="decimal" placeholder="0.00" className={INPUT} />
              </Field>
            )}

            {/* ⚠️ Required by the domain when the account is not cash and the payment is not fully
                credit-funded — v1's real rule. Uploaded, never typed: the old shape took a URL text
                box, so `x` was a valid proof. */}
            <Field
              label="Proof of payment"
              hint="Required for an online or e-wallet account: the deposit slip or transfer screenshot."
            >
              <input type="file" name="receiptPhoto" accept="image/*" className="text-sm" />
            </Field>

            <button
              type="submit"
              className="rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-neutral-900"
            >
              Record payment
            </button>
          </form>
        </section>
      ) : (
        <p className="rounded-lg border border-neutral-200 p-4 text-sm text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
          Nothing outstanding — there is no open charge to collect against.
          {charges.length === 0 && ' This customer has never been charged.'}
        </p>
      )}

      {/* ------------------------------------------------------------------------------ Charges */}
      <section className="space-y-2">
        <h2 className="font-medium">Charges</h2>
        {charges.length > 0 ? (
          <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
            <table className="w-full min-w-[720px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                  <th className="px-3 py-2 font-medium">Date</th>
                  <th className="px-3 py-2 font-medium">Due</th>
                  <th className="px-3 py-2 font-medium">Reference</th>
                  <th className="px-3 py-2 text-right font-medium">Total</th>
                  <th className="px-3 py-2 text-right font-medium">Settled</th>
                  <th className="px-3 py-2 text-right font-medium">Written off</th>
                  <th className="px-3 py-2 text-right font-medium">Outstanding</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {charges.map((c) => {
                  const overdue = c.dueDate !== null && c.dueDate < now && Number(c.outstanding) > 0;
                  return (
                    <tr
                      key={c.chargeId}
                      className={`border-b border-neutral-100 last:border-0 dark:border-neutral-900 ${
                        c.status === 'posted' ? '' : 'opacity-60'
                      }`}
                    >
                      <td className="px-3 py-2">{c.chargeDate}</td>
                      <td className={`px-3 py-2 ${overdue ? 'font-medium text-red-700 dark:text-red-400' : ''}`}>
                        {c.dueDate ?? '—'}
                        {overdue && <span className="ml-1 text-xs">overdue</span>}
                      </td>
                      <td className="px-3 py-2">
                        {c.referenceNo ?? '—'}
                        {/* ⭐ Every figure walks back to the entry that produced it — the thing v1
                            structurally cannot do, because its "entry" was a single leg. */}
                        {c.journalEntryId && (
                          <Link
                            href={`/reports/journal-lines?entry=${c.journalEntryId}`}
                            className="ml-2 text-xs underline underline-offset-2"
                          >
                            entry
                          </Link>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums">{peso(c.totalAmount)}</td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums">{peso(c.allocatedAmount)}</td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums">{peso(c.writtenOffAmount)}</td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums">{peso(c.outstanding)}</td>
                      <td className="px-3 py-2 text-xs">{c.status}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            No charges yet. A charge is raised when a trade order is dispatched — dispatch is the
            billing event.
          </p>
        )}
      </section>

      {/* --------------------------------------------------------- Write off / void a charge */}
      {charges.some((c) => c.status === 'posted') && (
        <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="font-medium">Write off or void a charge</h2>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            ⛔ <strong>A write-off takes two people.</strong> Whoever recorded the charge cannot
            also declare it dead — the service refuses it by identity, whatever the role. A partial
            write-off is allowed and leaves the remainder outstanding. ⚠️ <strong>Void</strong> is a
            different act: it says the charge should never have existed, and reverses its entry.
          </p>
          {charges
            .filter((c) => c.status === 'posted')
            .map((c) => (
              <div
                key={c.chargeId}
                className="space-y-2 rounded border border-neutral-200 p-3 text-sm dark:border-neutral-800"
              >
                <p className="font-medium">
                  {c.referenceNo ?? c.chargeDate} &mdash; {peso(c.outstanding)} outstanding of{' '}
                  {peso(c.totalAmount)}
                  <span className="ml-2 text-xs font-normal text-neutral-500">{storeName(c.storeId)}</span>
                </p>
                {Number(c.outstanding) > 0 && (
                  <form action={writeOffChargeAction} className="flex flex-wrap items-end gap-2">
                    <input type="hidden" name="customerId" value={customerId} />
                    <input type="hidden" name="storeId" value={storeId} />
                    <input type="hidden" name="chargeId" value={c.chargeId} />
                    <Field label="Write off">
                      <input
                        name="amount"
                        inputMode="decimal"
                        defaultValue={c.outstanding}
                        className={`${INPUT} w-32`}
                      />
                    </Field>
                    <Field label="Why is it uncollectible?">
                      <input name="reason" required className={`${INPUT} w-64`} />
                    </Field>
                    <button
                      type="submit"
                      className="rounded border border-neutral-300 px-3 py-2 text-sm hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900"
                    >
                      Write off to 6860
                    </button>
                  </form>
                )}
                <form action={voidChargeAction} className="flex flex-wrap items-end gap-2">
                  <input type="hidden" name="customerId" value={customerId} />
                  <input type="hidden" name="storeId" value={storeId} />
                  <input type="hidden" name="chargeId" value={c.chargeId} />
                  <Field label="Void this charge — why?">
                    <input name="reason" required className={`${INPUT} w-64`} />
                  </Field>
                  <button
                    type="submit"
                    className="rounded border border-neutral-300 px-3 py-2 text-sm hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900"
                  >
                    Void charge
                  </button>
                </form>
              </div>
            ))}
        </section>
      )}

      {/* -------------------------------------------------------------------------- Collections */}
      <section className="space-y-2">
        <h2 className="font-medium">Collections</h2>
        {collections.length > 0 ? (
          <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
            <table className="w-full min-w-[720px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                  <th className="px-3 py-2 font-medium">Date</th>
                  <th className="px-3 py-2 text-right font-medium">Gross</th>
                  <th className="px-3 py-2 text-right font-medium">Fee</th>
                  <th className="px-3 py-2 font-medium">Into</th>
                  <th className="px-3 py-2 font-medium">Settled</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {collections.map((c) => (
                  <tr
                    key={c.collectionId}
                    className={`border-b border-neutral-100 last:border-0 dark:border-neutral-900 ${
                      c.status === 'posted' ? '' : 'opacity-60'
                    }`}
                  >
                    <td className="px-3 py-2">
                      {c.collectionDate}
                      {c.journalEntryId && (
                        <Link
                          href={`/reports/journal-lines?entry=${c.journalEntryId}`}
                          className="ml-2 text-xs underline underline-offset-2"
                        >
                          entry
                        </Link>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">{peso(c.amount)}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">{peso(c.platformFee)}</td>
                    <td className="px-3 py-2 text-xs">
                      {c.moneyAccountName ?? '—'}
                      {c.referenceNo && <div className="text-neutral-400">{c.referenceNo}</div>}
                    </td>
                    {/* ⭐ WHAT it settled, not merely how much came in. A list of amounts cannot
                        answer the only question a disputed payment ever raises. */}
                    <td className="px-3 py-2 text-xs">
                      {c.allocations.length === 0 ? (
                        <span className="text-neutral-400">—</span>
                      ) : (
                        c.allocations.map((a) => (
                          <div key={`${c.collectionId}-${a.chargeId}`}>
                            {a.referenceNo ?? a.chargeDate} — {peso(a.amountApplied)}
                          </div>
                        ))
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {c.status}
                      {c.status === 'posted' && (
                        <form action={voidCollectionAction} className="mt-1 flex flex-wrap items-center gap-1">
                          <input type="hidden" name="customerId" value={customerId} />
                          <input type="hidden" name="storeId" value={storeId} />
                          <input type="hidden" name="collectionId" value={c.collectionId} />
                          <input
                            name="reason"
                            required
                            placeholder="why?"
                            aria-label="Why is this collection being voided?"
                            className="w-28 rounded border border-neutral-300 bg-white px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-950"
                          />
                          <button type="submit" className="underline underline-offset-2">
                            void
                          </button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">Nothing has been collected yet.</p>
        )}
      </section>

      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        ⭐ Every figure on this page is a query over the ledger and the AR tables&rsquo; own CTEs.
        There is no stored balance to recompute, repair or reconcile &mdash; which is why the three
        buttons v1 needed for exactly that are not here.
      </p>
    </main>
  );
}

const INPUT =
  'w-full rounded border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950';

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">{label}</span>
      {children}
      {hint && <span className="text-xs text-neutral-500 dark:text-neutral-500">{hint}</span>}
    </label>
  );
}

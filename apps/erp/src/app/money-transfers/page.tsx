import Link from 'next/link';
import { requireSession } from '../../lib/session';
import { createMoneyTransferAction, voidMoneyTransferAction } from './actions';
import {
  CUSTODIAN_LABEL,
  listRecentTransfers,
  listStores,
  listTransferableAccounts,
  peso,
  type AccountOption,
  type StoreOption,
} from './lib';

export const metadata = { title: 'Money transfers — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  error?: string;
  ok?: string;
}

export default async function MoneyTransfersPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const { actor } = await requireSession('/money-transfers');

  const [stores, accounts, transfers] = await Promise.all([
    listStores(actor.orgId),
    listTransferableAccounts(actor.orgId),
    listRecentTransfers(actor.orgId),
  ]);
  const storeById = new Map(stores.map((s) => [s.id, s]));
  const today = new Date().toISOString().slice(0, 10);

  // ⭐ Grouped by store, because a transfer must have both ends at ONE store — so the picker
  // shows that rule instead of letting someone pick across stores and meet an error afterwards.
  // ⚠️ Names repeat across stores ("Office safe" exists at every branch), which made a flat list
  // genuinely unusable: two identical labels, different money.
  const byStore = stores
    .map((s) => ({ store: s, accounts: accounts.filter((a) => a.storeId === s.id) }))
    .filter((g) => g.accounts.length > 0);

  return (
    <main className="mx-auto max-w-5xl space-y-6 p-4 sm:p-8">
      <div>
        <h1 className="text-2xl font-semibold">Money transfers</h1>
        <p className="max-w-2xl text-sm text-neutral-600 dark:text-neutral-400">
          Moving money between the places it already sits — drawer to safe, safe to drawer, cash
          to wallet, wallet to bank. Money never appears or disappears here; it only changes
          hands.{' '}
          <Link href="/money-accounts" className="underline underline-offset-2">
            Manage the accounts themselves
          </Link>
          .
        </p>
      </div>

      {sp.error && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {sp.error}
        </div>
      )}
      {sp.ok && (
        <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-4 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
          {sp.ok === 'created' ? 'Transfer recorded.' : 'Transfer reversed.'}
        </div>
      )}

      {accounts.length < 2 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
          <strong className="font-medium">A transfer needs two accounts.</strong> Add them on{' '}
          <Link href="/money-accounts" className="underline underline-offset-2">
            money accounts
          </Link>{' '}
          first — a transfer has to name where the money left and where it landed.
        </div>
      )}

      {/* ── What is where ────────────────────────────────────────────────────────────── */}
      {accounts.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-medium">What is where, right now</h2>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {accounts.map((a) => (
              <div
                key={a.id}
                className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-800"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-sm font-medium">{a.name}</span>
                  <span className="font-mono text-sm tabular-nums">{peso(a.balance)}</span>
                </div>
                <div className="text-xs text-neutral-500 dark:text-neutral-400">
                  {storeById.get(a.storeId)?.code ?? '—'} ·{' '}
                  {CUSTODIAN_LABEL[a.custodian] ?? a.custodian} ·{' '}
                  <span className="font-mono">{a.glAccountCode}</span>
                </div>
              </div>
            ))}
          </div>
          {/* ⭐ Every figure above is summed from the journal on this request. There is no balance
              column anywhere in this feature — v1 kept one and it drifted. */}
          <p className="text-xs text-neutral-400 dark:text-neutral-600">
            Each figure is summed from the ledger on load, not stored — so it cannot drift from
            the books it is meant to describe.
          </p>
        </section>
      )}

      {/* ── Record one ───────────────────────────────────────────────────────────────── */}
      <section className="space-y-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <div>
          <h2 className="font-medium">Record a transfer</h2>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            Both accounts must be at the same store, and a retired account cannot be either end.
          </p>
        </div>

        <form action={createMoneyTransferAction} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="From — money left here">
              <AccountPicker name="fromMoneyAccountId" byStore={byStore} />
            </Field>
            <Field label="To — money landed here">
              <AccountPicker name="toMoneyAccountId" byStore={byStore} />
            </Field>

            {/*
              ⭐ TWO amounts, deliberately — see T-139 §3.

              v1 asks for one "amount" and adds the fee to the source; this project's own posting
              doc narrates the same legs the other way round. Both readings are real here (a bank
              wire adds its fee to the source; a cash-out deducts it from the target), so a single
              box would silently mean different things on different days. Both figures are
              observable — one on each statement — which is what makes a transfer checkable.
            */}
            <Field label="Amount that left" hint="What the source account was reduced by">
              <input
                name="amountOut"
                type="number"
                step="0.01"
                min="0.01"
                required
                inputMode="decimal"
                placeholder="0.00"
                className={INPUT}
              />
            </Field>
            <Field
              label="Amount that arrived"
              hint="Leave blank if nothing was deducted — the usual case"
            >
              <input
                name="amountIn"
                type="number"
                step="0.01"
                min="0.01"
                inputMode="decimal"
                placeholder="Same as above"
                className={INPUT}
              />
            </Field>

            <Field label="Date">
              <input
                name="transferDate"
                type="date"
                required
                defaultValue={today}
                className={INPUT}
              />
            </Field>
            <Field label="Reference" hint="The bank or wallet reference, if there is one">
              <input name="reference" maxLength={120} className={INPUT} />
            </Field>
          </div>

          <Field label="Notes">
            <input name="notes" className={INPUT} />
          </Field>

          <p className="text-xs text-neutral-400 dark:text-neutral-600">
            Any gap between the two amounts is booked as a fee to <span className="font-mono">6870</span>{' '}
            Bank charges — a real expense, not a rounding difference. Money that arrives without
            leaving somewhere is income, and cannot be recorded here.
          </p>

          <button
            type="submit"
            className="rounded bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
          >
            Record transfer
          </button>
        </form>
      </section>

      {/* ── History ──────────────────────────────────────────────────────────────────── */}
      {transfers.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-medium">Recent transfers</h2>
          <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
            <table className="w-full min-w-[820px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                  <th className="px-3 py-2 font-medium">Date</th>
                  <th className="px-3 py-2 font-medium">From</th>
                  <th className="px-3 py-2 font-medium">To</th>
                  <th className="px-3 py-2 text-right font-medium">Left</th>
                  <th className="px-3 py-2 text-right font-medium">Arrived</th>
                  <th className="px-3 py-2 text-right font-medium">Fee</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {transfers.map((t) => (
                  <tr
                    key={t.id}
                    className={`border-b border-neutral-100 last:border-0 dark:border-neutral-900 ${
                      t.status === 'voided' ? 'opacity-50' : ''
                    }`}
                  >
                    <td className="px-3 py-2 whitespace-nowrap">{t.transferDate}</td>
                    <td className="px-3 py-2">{t.fromName}</td>
                    <td className="px-3 py-2">
                      {t.toName}
                      {t.status === 'voided' && (
                        <span className="ml-2 rounded bg-neutral-200 px-1.5 py-0.5 text-xs font-medium text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
                          Reversed
                        </span>
                      )}
                      {t.reference && (
                        <div className="text-xs text-neutral-400 dark:text-neutral-600">
                          {t.reference}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {peso(t.amountOut)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {peso(t.amountIn)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {Number(t.fee) > 0 ? (
                        <span className="text-amber-700 dark:text-amber-400">{peso(t.fee)}</span>
                      ) : (
                        <span className="text-neutral-300 dark:text-neutral-700">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {t.status === 'posted' && (
                        <form action={voidMoneyTransferAction} className="flex justify-end gap-1">
                          <input type="hidden" name="moneyTransferId" value={t.id} />
                          {/* A reversal without a reason is a gap, so the reason is part of the
                              same control rather than a confirmation step that can be skipped. */}
                          <input
                            name="reason"
                            required
                            placeholder="Reason…"
                            className="w-28 rounded border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-950"
                          />
                          <button
                            type="submit"
                            className="rounded border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-800 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-900"
                          >
                            Reverse
                          </button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-neutral-400 dark:text-neutral-600">
            Reversing writes an opposite entry — it never deletes the original. Both stay in the
            ledger, which is what makes the correction auditable.
          </p>
        </section>
      )}
    </main>
  );
}

const INPUT =
  'w-full rounded border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950';

function AccountPicker({
  name,
  byStore,
}: {
  name: string;
  byStore: { store: StoreOption; accounts: AccountOption[] }[];
}) {
  return (
    <select name={name} required defaultValue="" className={INPUT}>
      <option value="">Choose an account…</option>
      {byStore.map((g) => (
        <optgroup key={g.store.id} label={`${g.store.name} (${g.store.code})`}>
          {g.accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} — {peso(a.balance)}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">{label}</span>
      {children}
      {hint && <span className="text-xs text-neutral-400 dark:text-neutral-600">{hint}</span>}
    </label>
  );
}

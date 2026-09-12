import Link from 'next/link';
import { requirePageAccess } from '../../lib/page-access';
import type { PickerOption } from '../../components/two-way-picker';
import { createMoneyTransferAction, voidMoneyTransferAction } from './actions';
import { RecordTransferForm } from './RecordTransferForm';
import { CUSTODIAN_LABEL, listRecentTransfers, listStores, listTransferableAccounts, peso } from './lib';
import { Page } from '@/components/shell/Page';

export const metadata = { title: 'Money transfers — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  error?: string;
  ok?: string;
  warning?: string;
}

export default async function MoneyTransfersPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const { actor, refusal } = await requirePageAccess('/money-transfers');
  // ⭐ T-288 — the READ gate. Ian, 2026-09-12: "do both hide the menu and gate the reads."
  if (refusal) return refusal;

  const [stores, accounts, transfers] = await Promise.all([
    listStores(actor.orgId),
    listTransferableAccounts(actor.orgId),
    listRecentTransfers(actor.orgId),
  ]);
  const storeById = new Map(stores.map((s) => [s.id, s]));
  const today = new Date().toISOString().slice(0, 10);

  // ⭐ Grouped by store because names REPEAT across stores — "Office safe" exists at every
  // branch — and a flat list showed two identical labels holding different money, which made the
  // picker genuinely unusable.
  //
  // ⚠️ The grouping is for disambiguation, NOT a same-store restriction: office-to-office across
  // stores is allowed (bible row 152). The rule that matters there is about the CUSTODIAN, not
  // the store, so the domain enforces it and says why rather than the picker hiding options.
  const overdrawn = accounts.filter((a) => Number(a.balance) < 0);

  const byStore = stores
    .map((s) => ({ store: s, accounts: accounts.filter((a) => a.storeId === s.id) }))
    .filter((g) => g.accounts.length > 0);

  // ⭐ Built server-side, WITH `peso` already applied — a plain function cannot cross the
  // server/client boundary as a prop, so `RecordTransferForm` (a client component, for
  // `TwoWayPicker`'s From/To state) receives finished labels, never the formatter itself.
  const accountOptions: PickerOption[] = byStore.flatMap((g) =>
    g.accounts.map((a) => ({
      id: a.id,
      label: `${a.name} — ${peso(a.balance)}`,
      groupLabel: `${g.store.name} (${g.store.code})`,
    })),
  );

  return (
    <Page density="table">
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
      {/* ⚠️ A warning is NOT an error — the transfer posted. Shown in amber beside the green
          confirmation rather than in place of it, so nobody reads it as a failure. */}
      {sp.warning && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
          {sp.warning}
        </div>
      )}

      {/* ⭐ OVERDRAWN ACCOUNTS — derived on every load, never a stored flag, so it cannot linger
          after the money arrives or go missing when it does not. Bible row 154. */}
      {overdrawn.length > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
          <strong className="font-medium">
            {overdrawn.length === 1 ? 'One account is' : `${overdrawn.length} accounts are`} below
            zero in the books.
          </strong>{' '}
          {overdrawn.map((a) => `${a.name} (${peso(a.balance)})`).join(', ')}.
          <div className="mt-1 text-xs">
            For a <strong>cashier</strong> drawer this is expected while the day&apos;s sales are
            unverified — the cash is in the till before it is in the ledger. Verify the sales day
            and it should clear. If it does not, or if the account is an office safe or a staff
            float, the money is genuinely missing and needs counting.
          </div>
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
                  {/* ⚠️ A negative reads as an ordinary figure unless it is coloured — and a
                      negative cash balance is never ordinary. */}
                  <span
                    className={`font-mono text-sm tabular-nums ${
                      Number(a.balance) < 0 ? 'text-amber-600 dark:text-amber-400' : ''
                    }`}
                  >
                    {peso(a.balance)}
                  </span>
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
            A retired account cannot be either end, and{' '}
            <strong>between stores money moves office to office only</strong> — a store remits to
            its own office first, and only office money can fund another store. An office safe
            cannot send more than it holds; a cashier drawer can, and says so, because the till
            holds the day&apos;s takings before the ledger does.
          </p>
        </div>

        <RecordTransferForm action={createMoneyTransferAction} options={accountOptions} today={today} />
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
    </Page>
  );
}


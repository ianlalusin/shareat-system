import { toBusinessDate } from '@shareat/core/datetime';
import Link from 'next/link';
import { compare, money, ZERO } from '@shareat/core/money';
import { requirePageAccess } from '../../lib/page-access';
import type { PickerOption } from '../../components/two-way-picker';
import { createMoneyTransferAction, settleBetweenStoresAction, voidMoneyTransferAction } from './actions';
import { RecordTransferForm } from './RecordTransferForm';
import { SettleBetweenStoresForm, type SettlePairOption } from './SettleBetweenStoresForm';
import { CUSTODIAN_LABEL, listAccountBalances, listRecentTransfers, listSettlementPairs, listStores, listTransferableAccounts, peso } from './lib';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';
import { Badge, Banner, Button, FlashBanner, Input } from '@/components/ui';

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
  const sp = await withFlash(searchParams);
  const { actor, refusal } = await requirePageAccess('/money-transfers');
  // ⭐ T-288 — the READ gate. Ian, 2026-09-12: "do both hide the menu and gate the reads."
  if (refusal) return refusal;

  const [stores, accounts, transfers] = await Promise.all([
    listStores(actor.orgId),
    listAccountBalances(actor.orgId),
    listRecentTransfers(actor.orgId),
  ]);
  // Balances are read once; the usable set is those at stores where the viewer may move money.
  const usable = await listTransferableAccounts(actor, accounts);
  // T-369 S9: the pairs of stores where one owes the other, only where this person holds `transfer_funds` at both.
  const settlementPairs = await listSettlementPairs(actor, usable);
  const storeById = new Map(stores.map((s) => [s.id, s]));
  const today = toBusinessDate();

  // ⭐ Grouped by store because names REPEAT across stores — "Office safe" exists at every
  // branch — and a flat list showed two identical labels holding different money, which made the
  // picker genuinely unusable.
  //
  // ⚠️ The grouping is for disambiguation, NOT a same-store restriction: office-to-office across
  // stores is allowed (bible row 152). The rule that matters there is about the CUSTODIAN, not
  // the store, so the domain enforces it and says why rather than the picker hiding options.
  const overdrawn = accounts.filter((a) => compare(money(a.balance), ZERO) < 0);

  const byStore = stores
    .map((s) => ({ store: s, accounts: usable.filter((a) => a.storeId === s.id) }))
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

  // ⭐ Finished labels, server-side (a plain function cannot cross to the client form). "Lipa owes Malvar ₱650.00".
  const storeName = (id: string) => storeById.get(id)?.name ?? '—';
  const settleOptions: SettlePairOption[] = settlementPairs.map((p) => {
    const accountOption = (a: (typeof usable)[number]) => ({ id: a.id, label: `${a.name} — ${peso(a.balance)}` });
    return {
      label: `${storeName(p.debtorStoreId)} owes ${storeName(p.creditorStoreId)} ${peso(p.owed)}`,
      owed: p.owed,
      from: p.fromAccounts.map(accountOption),
      to: p.toAccounts.map(accountOption),
    };
  });
  // Generated per render: the form submits it back, so a double click is a replay of ONE settlement.
  const settlementId = crypto.randomUUID();

  return (
    <Page density="table">
      <div>
        <h1 className="text-2xl font-semibold">Money transfers</h1>
        <PageDescription>
          Moving money between the places it already sits — drawer to safe, safe to drawer, cash
          to wallet, wallet to bank. Money never appears or disappears here; it only changes
          hands.{' '}
          <Link href="/money-accounts" className="underline underline-offset-2">
            Manage the accounts themselves
          </Link>
          .
        </PageDescription>
      </div>

      <FlashBanner flash={sp} />

      {/* ⭐ OVERDRAWN ACCOUNTS — derived on every load, never a stored flag, so it cannot linger
          after the money arrives or go missing when it does not. Bible row 154. */}
      {overdrawn.length > 0 && (
        <Banner tone="warning">
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
        </Banner>
      )}

      {usable.length === 0 && (
        <Banner tone="warning">You can&apos;t move money at any store.</Banner>
      )}

      {usable.length > 0 && usable.length < 2 && (
        <Banner tone="warning">
          <strong className="font-medium">A transfer needs two accounts.</strong> Add them on{' '}
          <Link href="/money-accounts" className="text-sm underline underline-offset-2">
            money accounts
          </Link>{' '}
          first — a transfer has to name where the money left and where it landed.
        </Banner>
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
                      compare(money(a.balance), ZERO) < 0 ? 'text-warning-ink' : ''
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
      {usable.length > 0 && (
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
      )}

      {/* ── Settle between stores ────────────────────────────────────────────────────── */}
      {usable.length > 0 && (
        <details className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <summary className="inline-flex min-h-[44px] cursor-pointer items-center text-sm font-medium">Settle between stores</summary>
          <div className="mt-3 space-y-3">
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              When one store has paid for another, the two stores carry a balance. Paying it back here moves the cash
              <strong> and</strong> clears the balance in one entry — an ordinary transfer back would grow both balances
              instead. Money moves office to office, and no more than what is owed.
            </p>
            {settleOptions.length === 0 ? (
              <p className="text-sm text-neutral-500 dark:text-neutral-400">No store owes another.</p>
            ) : (
              <SettleBetweenStoresForm
                action={settleBetweenStoresAction}
                pairs={settleOptions}
                settlementId={settlementId}
                today={today}
              />
            )}
          </div>
        </details>
      )}

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
                      {t.settles && (
                        <Badge tone="info" label="Settlement" className="ml-2" />
                      )}
                      {t.status === 'voided' && (
                        <Badge tone="closed" label="Reversed" className="ml-2" />
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
                      {compare(money(t.fee), ZERO) > 0 ? (
                        <span className="text-warning-ink">{peso(t.fee)}</span>
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
                          <Input name="reason" required placeholder="Reason…" className="w-28" />
                          <Button type="submit" variant="danger">
                            Reverse
                          </Button>
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


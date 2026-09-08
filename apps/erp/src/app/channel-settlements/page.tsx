import Link from 'next/link';
import { requireSession } from '../../lib/session';
import {
  previewSettlementAction,
  recordSettlementAction,
  setPayoutDestinationAction,
  voidSettlementAction,
} from './actions';
import { SettlementForm } from './SettlementForm';
import {
  listActiveLoans,
  listChannels,
  listDestinationAccounts,
  listRecentSettlements,
  listWaitingDays,
  peso,
} from './lib';
import { Page } from '@/components/shell/Page';

export const metadata = { title: 'Channel settlements — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  error?: string;
  ok?: string;
  channel?: string;
  day?: string;
}

const OK_MESSAGE: Record<string, string> = {
  posted: 'Settlement posted. The receivable it cleared is gone from the list above.',
  voided: 'Settlement reversed — every leg, including the receivable, is back where it was.',
  destination: 'Payout account set. This channel can be settled now.',
};

export default async function ChannelSettlementsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const { actor } = await requireSession('/channel-settlements');

  const [channels, waiting, settlements, loans, accounts] = await Promise.all([
    listChannels(actor.orgId),
    listWaitingDays(actor.orgId),
    listRecentSettlements(actor.orgId),
    listActiveLoans(actor.orgId),
    listDestinationAccounts(actor.orgId),
  ]);

  const today = new Date().toISOString().slice(0, 10);
  const unwired = channels.filter((c) => !c.destinationMoneyAccountId && c.isActive);
  const owed = channels.reduce((sum, c) => sum + Number(c.outstanding), 0);
  const oldest = waiting.reduce((max, d) => Math.max(max, d.ageDays), 0);

  return (
    <Page density="table">
      <div>
        <h1 className="text-2xl font-semibold">Channel settlements</h1>
        <p className="max-w-2xl text-sm text-neutral-600 dark:text-neutral-400">
          Foodpanda and Grab sell today and pay days later, so every verified platform day raises a
          receivable on <span className="font-mono">1220</span>. This is the screen that clears it —
          the platform&apos;s gross, every deduction it made as its own signed line, and what
          actually reached the bank.
        </p>
      </div>

      {sp.error && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {sp.error}
        </div>
      )}
      {sp.ok && OK_MESSAGE[sp.ok] && (
        <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-4 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
          {OK_MESSAGE[sp.ok]}
        </div>
      )}

      {/* ── ⛔ The configuration that makes everything else impossible ────────────────── */}
      {unwired.length > 0 && (
        <section className="space-y-3 rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950">
          <div className="text-sm text-amber-900 dark:text-amber-300">
            <strong className="font-medium">
              {unwired.length === 1 ? 'One channel has' : `${unwired.length} channels have`} nowhere
              to bank a payout.
            </strong>{' '}
            A settlement debits the account the channel pays into, so it cannot be recorded until
            that account is named. Pick it here — it is the store&apos;s own wallet, and money
            reaching another store&apos;s account is a transfer, not a setting.
          </div>
          <div className="space-y-2">
            {unwired.map((c) => (
              <form
                key={c.id}
                action={setPayoutDestinationAction}
                className="flex flex-wrap items-center gap-2"
              >
                <input type="hidden" name="channelId" value={c.id} />
                <span className="min-w-40 text-sm font-medium text-amber-900 dark:text-amber-200">
                  {c.storeName} — {c.name}
                </span>
                <select
                  name="moneyAccountId"
                  required
                  defaultValue=""
                  className="rounded border border-amber-300 bg-white px-2 py-1.5 text-sm dark:border-amber-700 dark:bg-neutral-950"
                >
                  <option value="" disabled>
                    Choose an account…
                  </option>
                  {accounts
                    .filter((a) => a.storeId === c.storeId)
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} ({a.custodian} · {a.glAccountCode})
                      </option>
                    ))}
                </select>
                <button
                  type="submit"
                  className="rounded border border-amber-400 px-3 py-1.5 text-xs font-medium text-amber-900 hover:bg-amber-100 dark:border-amber-700 dark:text-amber-200 dark:hover:bg-amber-900"
                >
                  Set
                </button>
              </form>
            ))}
          </div>
        </section>
      )}

      {/* ── What the platforms owe us ────────────────────────────────────────────────── */}
      <section className="space-y-2">
        <h2 className="font-medium">What the platforms owe us</h2>
        {channels.length === 0 ? (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            No channel raises a receivable yet.
          </p>
        ) : (
          <>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {channels.map((c) => (
                <div
                  key={c.id}
                  className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-800"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-sm font-medium">{c.name}</span>
                    <span
                      className={`font-mono text-sm tabular-nums ${
                        Number(c.outstanding) < 0 ? 'text-amber-600 dark:text-amber-400' : ''
                      }`}
                    >
                      {peso(c.outstanding)}
                    </span>
                  </div>
                  <div className="text-xs text-neutral-500 dark:text-neutral-400">
                    {c.storeCode} · {c.destinationAccountName ?? 'no payout account'}
                    {!c.isActive && ' · retired'}
                  </div>
                </div>
              ))}
            </div>
            <p className="text-xs text-neutral-400 dark:text-neutral-600">
              {peso(owed.toFixed(2))} outstanding across every channel — summed from{' '}
              <span className="font-mono">1220</span> by party on this request, never from a stored
              balance. A negative would mean more was settled than was ever owed.
            </p>
          </>
        )}
      </section>

      {/* ── The queue ────────────────────────────────────────────────────────────────── */}
      <section className="space-y-2">
        <h2 className="font-medium">Days waiting to be settled</h2>
        {waiting.length === 0 ? (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            Nothing waiting. Only a <strong>verified</strong> sales day appears here — an
            unverified one has posted nothing, so it has raised no receivable to clear.
          </p>
        ) : (
          <>
            <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
              <table className="w-full min-w-[640px] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                    <th className="px-3 py-2 font-medium">Day</th>
                    <th className="px-3 py-2 font-medium">Store</th>
                    <th className="px-3 py-2 font-medium">Channel</th>
                    <th className="px-3 py-2 text-right font-medium">Reported</th>
                    <th className="px-3 py-2 text-right font-medium">Waiting</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {waiting.map((d) => (
                    <tr
                      key={`${d.salesDayId}:${d.channelId}`}
                      className="border-b border-neutral-100 last:border-0 dark:border-neutral-900"
                    >
                      <td className="px-3 py-2 whitespace-nowrap">{d.businessDate}</td>
                      <td className="px-3 py-2">{d.storeName}</td>
                      <td className="px-3 py-2">{d.channelName}</td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums">
                        {peso(d.reportedAmount)}
                      </td>
                      {/* ⭐ Age, not only amount — ₱200 waiting 40 days is a worse finding than
                          ₱9,000 waiting since yesterday (bible row 147). */}
                      <td
                        className={`px-3 py-2 text-right tabular-nums ${
                          d.ageDays >= 14 ? 'font-medium text-amber-700 dark:text-amber-400' : ''
                        }`}
                      >
                        {d.ageDays}d
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Link
                          href={`/channel-settlements?channel=${d.channelId}&day=${d.salesDayId}#record`}
                          className="rounded border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-800 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-900"
                        >
                          Settle
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {oldest >= 14 && (
              <p className="text-xs text-amber-700 dark:text-amber-400">
                The oldest is {oldest} days old. A platform receivable that keeps ageing is either a
                payout nobody recorded or money that never arrived — both are worth chasing before
                the month closes.
              </p>
            )}
          </>
        )}
      </section>

      {/* ── Record one ───────────────────────────────────────────────────────────────── */}
      <section
        id="record"
        className="space-y-4 scroll-mt-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800"
      >
        <div>
          <h2 className="font-medium">Record a settlement</h2>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            One payout, one channel, one verified day. A payout covering several days is one
            settlement per day sharing a reference — which is what keeps each day&apos;s receivable
            checkable on its own.
          </p>
        </div>
        <SettlementForm
          postAction={recordSettlementAction}
          previewAction={previewSettlementAction}
          channels={channels
            .filter((c) => c.isActive)
            .map((c) => ({
              id: c.id,
              name: c.name,
              storeId: c.storeId,
              storeName: c.storeName,
              outstanding: c.outstanding,
              destinationAccountName: c.destinationAccountName,
              destinationMoneyAccountId: c.destinationMoneyAccountId,
            }))}
          days={waiting.map((d) => ({
            salesDayId: d.salesDayId,
            channelId: d.channelId,
            businessDate: d.businessDate,
            reportedAmount: d.reportedAmount,
            ageDays: d.ageDays,
          }))}
          loans={loans}
          today={today}
          preselectChannelId={sp.channel}
          preselectSalesDayId={sp.day}
        />
      </section>

      {/* ── History ──────────────────────────────────────────────────────────────────── */}
      {settlements.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-medium">Recent settlements</h2>
          <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
            <table className="w-full min-w-[900px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                  <th className="px-3 py-2 font-medium">Day</th>
                  <th className="px-3 py-2 font-medium">Channel</th>
                  <th className="px-3 py-2 text-right font-medium">Cleared</th>
                  <th className="px-3 py-2 text-right font-medium">Deductions</th>
                  <th className="px-3 py-2 text-right font-medium">Loan</th>
                  <th className="px-3 py-2 text-right font-medium">Variance</th>
                  <th className="px-3 py-2 text-right font-medium">Banked</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {settlements.map((s) => (
                  <tr
                    key={s.id}
                    className={`border-b border-neutral-100 last:border-0 dark:border-neutral-900 ${
                      s.status === 'voided' ? 'opacity-50' : ''
                    }`}
                  >
                    <td className="px-3 py-2 whitespace-nowrap">
                      {s.businessDate}
                      <div className="text-xs text-neutral-400 dark:text-neutral-600">
                        settled {s.settledOn}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      {s.storeName} — {s.channelName}
                      {s.status === 'voided' && (
                        <span className="ml-2 rounded bg-neutral-200 px-1.5 py-0.5 text-xs font-medium text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
                          Voided
                        </span>
                      )}
                      {s.reference && (
                        <div className="text-xs text-neutral-400 dark:text-neutral-600">
                          {s.reference}
                        </div>
                      )}
                      {s.voidReason && (
                        <div className="text-xs text-neutral-400 dark:text-neutral-600">
                          {s.voidReason}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {peso(s.outstandingCleared)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {peso(s.feesTotal)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {Number(s.loanDeduction) !== 0 ? (
                        peso(s.loanDeduction)
                      ) : (
                        <span className="text-neutral-300 dark:text-neutral-700">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {Number(s.variance) !== 0 ? (
                        <span className="text-amber-700 dark:text-amber-400">
                          −{peso(s.variance)}
                        </span>
                      ) : Number(s.settlementGain) !== 0 ? (
                        <span className="text-emerald-700 dark:text-emerald-400">
                          +{peso(s.settlementGain)}
                        </span>
                      ) : (
                        <span className="text-neutral-300 dark:text-neutral-700">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {peso(s.netDeposited)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {s.status === 'posted' && (
                        <form action={voidSettlementAction} className="flex justify-end gap-1">
                          <input type="hidden" name="settlementId" value={s.id} />
                          {/* A void without a reason is a gap, so the reason is part of the same
                              control rather than a confirmation step that can be skipped. */}
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
                            Void
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
            Voiding writes an opposite entry and puts the receivable back — it never deletes the
            original. A correction is void and re-post, because a posted settlement is immutable.
          </p>
        </section>
      )}
    </Page>
  );
}

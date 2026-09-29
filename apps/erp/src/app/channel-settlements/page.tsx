import Link from 'next/link';
import { authorize, AuthorizationError, heldCapabilities } from '@shareat/auth';
import { auditLogRepo } from '@shareat/db';
import { logger } from '@shareat/core/logger';
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
  withOrgPrincipal,
} from './lib';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';

export const metadata = { title: 'Channel settlements — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  error?: string;
  ok?: string;
  /** The settlement form's own preselect register (`page.tsx`'s `<SettlementForm>` below) — never
   *  read for the banner (T-350 S4 / G4: the two collided when both used `channel`). */
  channel?: string;
  day?: string;
  /** T-350 S4 (G4) / S5 — which channel a payout-destination save was about. The ONLY thing the
   *  redirect says; everything else (was it a first set, a change, a no-op?) is derived from the
   *  audit row, never carried in the URL (T-350 S5). */
  changedChannel?: string;
}

const OK_MESSAGE: Record<string, string> = {
  posted: 'Settlement posted. The receivable it cleared is gone from the list above.',
  voided: 'Settlement reversed — every leg, including the receivable, is back where it was.',
  // T-350 S5 — no `destination` entry, on purpose. `?ok=destination` alone (or with a
  // `changedChannel` that fails verification) shows NO banner; there is no generic fallback text
  // to fall back to any more (S4's `same=1`/`changed=1` re-created the same "URL says so" hole
  // one branch over — S5's fix is that the URL says NOTHING about what happened).
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
  // T-350 (DEF-477). Ian, 2026-09-28: admin only — gates both the unwired panel's form and the
  // wired card's Change control. `authorize()` in the domain is the real gate; this decides what
  // renders, PER CHANNEL AT ITS OWN STORE (T-350 S2 / F2 — `heldCapabilities` alone is store-blind
  // by design, per its own JSDoc, so it cannot answer "at store Y"). `heldCapabilities` is still
  // the cheap org-wide pre-check; a per-store `authorize()` call, its own real gate, narrows that
  // down per store — the same "throw → value" idiom `admin/stores/lib.ts`'s `storeDetail` already
  // uses, not a new auth helper.
  const distinctStoreIds = [...new Set(channels.map((c) => c.storeId))];
  const canSetChannelPayoutByStore = await withOrgPrincipal(actor.orgId, async (tx) => {
    const held = await heldCapabilities(tx, actor);
    if (!held.has('set_channel_payout')) return new Set<string>();
    const ok = new Set<string>();
    for (const storeId of distinctStoreIds) {
      try {
        await authorize(tx, actor, 'set_channel_payout', { storeId });
        ok.add(storeId);
      } catch (err) {
        if (err instanceof AuthorizationError) continue;
        throw err;
      }
    }
    return ok;
  });
  const canSetChannelPayoutAt = (storeId: string) => canSetChannelPayoutByStore.has(storeId);

  // T-350 S5 — the payout banner is derived ONLY from the audit row, never from anything the URL
  // claims. The redirect after a save carries just `changedChannel=<id>`; whether that was a first
  // set, a change, or a same-account no-op (which writes no row at all) is read back here from the
  // channel's latest `set_channel_payout` row — viewer is the actor, under 10 minutes old, this
  // org, AND `changedChannel` must name a channel this page actually listed (a review finding: an
  // id for a channel nobody listed used to fall through to the first-set sentence). No qualifying
  // row (nothing written, an unlisted/forged/stale id, someone else's change, or a failed read)
  // shows NO banner; there is no generic fallback sentence to fall back to.
  let payoutBannerMessage: string | undefined;
  if (sp.ok === 'destination' && sp.changedChannel && channels.some((c) => c.id === sp.changedChannel)) {
    const changedChannelId = sp.changedChannel;
    try {
      const entry = await withOrgPrincipal(actor.orgId, (tx) =>
        auditLogRepo.latestForEntity(tx, actor.orgId, {
          entity: 'sales_channels',
          entityId: changedChannelId,
          action: 'set_channel_payout',
        }),
      );
      const TEN_MINUTES_MS = 10 * 60 * 1000;
      const fresh =
        entry !== undefined &&
        entry.actorPersonId === actor.personId &&
        Date.now() - entry.occurredAt.getTime() < TEN_MINUTES_MS;
      if (fresh) {
        const after = entry.after as { moneyAccountName?: string } | null;
        const before = entry.before as { moneyAccountId?: string | null } | null;
        const afterName = after?.moneyAccountName ?? 'the new account';
        payoutBannerMessage =
          before?.moneyAccountId == null
            ? `Payout account set. ${afterName} is where this channel's settlements bank.`
            : `Payout account changed. New settlements bank into ${afterName}.`;
      }
    } catch (err) {
      // A failed READ must not fall back to anything else — that would re-create the exact
      // unverified claim S5 exists to remove, just moved from a query param to a caught exception.
      // No banner, logged once, and the page still renders (bible §7's "loud, never silent" is for
      // the log, not for taking the whole page down over a banner).
      logger.warn({ err }, 'channel-settlements: could not verify the payout-change banner against audit_log');
    }
  }

  const okMessage = payoutBannerMessage ?? (sp.ok ? OK_MESSAGE[sp.ok] : undefined);

  const today = new Date().toISOString().slice(0, 10);
  const unwired = channels.filter((c) => !c.destinationMoneyAccountId && c.isActive);
  const owed = channels.reduce((sum, c) => sum + Number(c.outstanding), 0);
  const oldest = waiting.reduce((max, d) => Math.max(max, d.ageDays), 0);

  return (
    <Page density="table">
      <div>
        <h1 className="text-2xl font-semibold">Channel settlements</h1>
        <PageDescription>
          Foodpanda and Grab sell today and pay days later, so every verified platform day raises a
          receivable on <span className="font-mono">1220</span>. This is the screen that clears it —
          the platform&apos;s gross, every deduction it made as its own signed line, and what
          actually reached the bank.
        </PageDescription>
      </div>

      {sp.error && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {sp.error}
        </div>
      )}
      {okMessage && (
        <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-4 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
          {okMessage}
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
            {unwired.map((c) =>
              canSetChannelPayoutAt(c.storeId) ? (
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
              ) : (
                // T-350: a non-holder sees the channel named, but no picker — an admin has to do this.
                <div
                  key={c.id}
                  className="flex flex-wrap items-center gap-2 text-sm text-amber-900 dark:text-amber-200"
                >
                  <span className="min-w-40 font-medium">
                    {c.storeName} — {c.name}
                  </span>
                  <span className="text-xs text-amber-700 dark:text-amber-400">
                    An admin must set it.
                  </span>
                </div>
              ),
            )}
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
                  {(() => {
                    const storeAccounts = accounts.filter((a) => a.storeId === c.storeId);
                    // T-350 S2 (F1) — `accounts` is active-only (`listDestinationAccounts`), so a
                    // retired current account is absent from it. Naming it here, and never
                    // pre-selecting a real option for it, is what stops Save silently repointing
                    // to whichever account happens to render first.
                    const currentRetired =
                      c.destinationMoneyAccountId !== null &&
                      !storeAccounts.some((a) => a.id === c.destinationMoneyAccountId);
                    return (
                      <>
                        <div className="text-xs text-neutral-500 dark:text-neutral-400">
                          {c.storeCode} · {c.destinationAccountName ?? 'no payout account'}
                          {currentRetired && ' (retired)'}
                          {!c.isActive && ' · retired'}
                        </div>
                        {c.destinationMoneyAccountId && canSetChannelPayoutAt(c.storeId) && (
                          <details className="mt-1">
                            <summary className="cursor-pointer px-1 py-1.5 text-xs font-medium text-neutral-500 hover:text-neutral-800 dark:text-neutral-500 dark:hover:text-neutral-300">
                              Change
                            </summary>
                            <form
                              action={setPayoutDestinationAction}
                              className="mt-2 flex flex-wrap items-center gap-2"
                            >
                              <input type="hidden" name="channelId" value={c.id} />
                              {storeAccounts.length === 0 ? (
                                // T-350 S2 (F6) — nothing to pick, so no picker is offered as if
                                // choosable. Same sentinel idiom as the unwired panel's own gaps.
                                <span className="text-xs text-neutral-500 dark:text-neutral-400">
                                  No active account at this store to change into.
                                </span>
                              ) : (
                                <>
                                  <select
                                    name="moneyAccountId"
                                    required
                                    defaultValue={currentRetired ? '' : c.destinationMoneyAccountId}
                                    className="rounded border border-neutral-300 bg-white px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-950"
                                  >
                                    {currentRetired && (
                                      <option value="" disabled>
                                        — choose the new account —
                                      </option>
                                    )}
                                    {storeAccounts.map((a) => (
                                      <option key={a.id} value={a.id}>
                                        {a.name} ({a.custodian} · {a.glAccountCode})
                                      </option>
                                    ))}
                                  </select>
                                  <button
                                    type="submit"
                                    className="rounded border border-neutral-300 px-2 py-1 text-xs font-medium text-neutral-800 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-900"
                                  >
                                    Save
                                  </button>
                                </>
                              )}
                              <Link
                                href="/channel-settlements"
                                className="px-1 py-1.5 text-xs font-medium text-neutral-400 hover:text-neutral-700 dark:text-neutral-500 dark:hover:text-neutral-300"
                              >
                                Cancel
                              </Link>
                            </form>
                          </details>
                        )}
                      </>
                    );
                  })()}
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

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { compare, money, ZERO } from '@shareat/core/money';
import { requireSession } from '../../../lib/session';
import { cancelAction, decideAction, releaseAction, settleAction } from '../actions';
import {
  STATUS_LABEL,
  getDetail,
  listActivePersons,
  listStores,
  moneyAccounts,
  peso,
  today,
} from '../lib';
import { DetailLayout } from '@/components/shell/DetailLayout';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';

export const metadata = { title: 'Cash request — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  error?: string;
  ok?: string;
}

export default async function CashRequestPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { id } = await params;
  const sp = await withFlash(searchParams);
  const { actor } = await requireSession(`/cash-requests/${id}`);

  const req = await getDetail(actor.orgId, id);
  if (!req) notFound();

  const [accounts, stores, persons] = await Promise.all([
    moneyAccounts(actor.orgId, req.storeId),
    listStores(actor.orgId),
    listActivePersons(actor.orgId),
  ]);
  const store = stores.find((s) => s.id === req.storeId);
  const holder = persons.find((p) => p.id === req.requestedFor);

  const outstanding = money(req.float.outstanding);
  const canDecide = req.status === 'requested';
  const canRelease = req.status === 'approved';
  const canSettle = req.status === 'released';
  const canCancel = req.status === 'requested' || req.status === 'approved';

  return (
    <Page density="table">
      <div>
        <Link href="/cash-requests" className="text-sm underline underline-offset-2">
          ← Cash requests
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">{req.purpose}</h1>
        <PageDescription>
          {holder?.displayName ?? 'Unknown holder'} · {store?.name ?? '—'} ·{' '}
          {STATUS_LABEL[req.status] ?? req.status} · asked {req.requestedOn}
        </PageDescription>
      </div>

      {sp.error && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {sp.error}
        </div>
      )}
      {sp.ok && (
        <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-4 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
          {sp.ok}
        </div>
      )}

      <DetailLayout
        summary={
          /* ── The float ──────────────────────────────────────────────────────────────── */
          <section className="space-y-3">
            {/* ⚠️ `min-[1440px]:grid-cols-1`: `sm` is a VIEWPORT query, so without it these FIVE
                tiles stay five-across inside a 320px rail — 58px each, the worst of the six.
                T-240 §3.5. */}
            <div className="grid gap-3 sm:grid-cols-5 min-[1440px]:grid-cols-1">
              <Figure label="Released" value={peso(req.float.released)} />
              <Figure label="Spent" value={peso(req.float.spent)} />
              <Figure label="Returned" value={peso(req.float.returned)} />
              <Figure label="Short" value={peso(req.float.short)} />
              <Figure label="Still out" value={peso(req.float.outstanding)} emphasis />
            </div>
            <p className="text-xs text-neutral-500 dark:text-neutral-500">
              ⭐ <strong>Still out</strong> is the balance of <code>1120</code> for this request. The
              other four are the same balance broken up by what happened to the money — which is why
              they cannot disagree with it.{' '}
              {req.isSettled && req.float.released !== '0.00' && (
                <>
                  It has reached <strong>zero</strong>, so the request is closed.
                </>
              )}
            </p>
          </section>
        }
      >

      {/* ── Decide ───────────────────────────────────────────────────────────────────── */}
      {canDecide && (
        <section className="space-y-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <div>
            <h2 className="font-medium">Decide</h2>
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              Asked for <strong>{peso(req.requestedAmount)}</strong>. ⚠️ Approving is{' '}
              <strong>not</strong> handing over — the money moves at release, and this decision
              cannot be revisited once it is made.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <form action={decideAction} className="space-y-3">
              <input type="hidden" name="requestId" value={req.id} />
              <input type="hidden" name="decision" value="approve" />
              <Field
                label="Approve for"
                hint="May differ from what was asked — less is common, more is allowed."
              >
                <input
                  name="amount"
                  required
                  inputMode="decimal"
                  defaultValue={req.requestedAmount}
                  className={INPUT}
                />
              </Field>
              <button
                type="submit"
                className="rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-neutral-900"
              >
                Approve
              </button>
            </form>

            <form action={decideAction} className="space-y-3">
              <input type="hidden" name="requestId" value={req.id} />
              <input type="hidden" name="decision" value="reject" />
              <Field label="Refuse, because" hint="A refusal without a reason is not recorded.">
                <input name="reason" required className={INPUT} />
              </Field>
              <button
                type="submit"
                className="rounded border border-neutral-300 px-4 py-2 text-sm font-medium dark:border-neutral-700"
              >
                Refuse
              </button>
            </form>
          </div>
        </section>
      )}

      {/* ── Release ──────────────────────────────────────────────────────────────────── */}
      {canRelease && (
        <section className="space-y-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <div>
            <h2 className="font-medium">Hand the cash over</h2>
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              Approved for <strong>{peso(req.approvedAmount ?? '0')}</strong>. This is the posting
              that moves money: it leaves the account below and becomes a float charged to{' '}
              {holder?.displayName ?? 'the holder'}.
            </p>
          </div>
          <form action={releaseAction} className="space-y-4">
            <input type="hidden" name="requestId" value={req.id} />
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Amount">
                <input
                  name="amount"
                  required
                  inputMode="decimal"
                  defaultValue={req.approvedAmount ?? ''}
                  className={INPUT}
                />
              </Field>
              <Field label="From" hint="Balances shown are derived from the ledger.">
                <select name="fromMoneyAccountId" required defaultValue="" className={INPUT}>
                  <option value="" disabled>
                    Choose…
                  </option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} — {peso(a.balance)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="On">
                <input name="on" type="date" required defaultValue={today()} className={INPUT} />
              </Field>
            </div>
            <button
              type="submit"
              className="rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-neutral-900"
            >
              Release
            </button>
          </form>
        </section>
      )}

      {/* ── Settle ───────────────────────────────────────────────────────────────────── */}
      {canSettle && (
        <section className="space-y-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <div>
            <h2 className="font-medium">Close the float</h2>
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              <strong>{peso(req.float.outstanding)}</strong> is still out.{' '}
              {/* ⚠️ Says where the spending goes, because the absence of a field here looks like an
                  omission. Expenses paid from a float already credit 1120; recording them twice is
                  the mistake this sentence exists to prevent. */}
              ⚠️ Money <em>spent</em> is not entered here — record it as an expense paid from this
              request, and the float reduces itself. This form is for what comes{' '}
              <strong>back</strong>, and what does not.
            </p>
          </div>
          <form action={settleAction} className="space-y-4">
            <input type="hidden" name="requestId" value={req.id} />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Returned" hint="Cash physically handed back. Leave blank if none.">
                <input name="returnedAmount" inputMode="decimal" className={INPUT} />
              </Field>
              <Field label="Into" hint="Where the returned cash landed.">
                <select name="toMoneyAccountId" defaultValue="" className={INPUT}>
                  <option value="">—</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} — {peso(a.balance)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field
                label="Short"
                hint="Unaccounted-for. Becomes a receivable from the holder, not a write-off."
              >
                <input name="shortAmount" inputMode="decimal" className={INPUT} />
              </Field>
              <Field label="Short because" hint="Required if anything is short.">
                <input name="shortReason" className={INPUT} />
              </Field>
              <Field label="On">
                <input name="on" type="date" required defaultValue={today()} className={INPUT} />
              </Field>
            </div>
            <button
              type="submit"
              className="rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-neutral-900"
            >
              Record
            </button>
          </form>
        </section>
      )}

      {/* ── Withdraw ─────────────────────────────────────────────────────────────────── */}
      {canCancel && (
        <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <div>
            <h2 className="font-medium">Withdraw</h2>
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              No longer needed. Nothing has posted, so there is nothing to undo — and any approval
              is cleared rather than left behind.
            </p>
          </div>
          <form action={cancelAction} className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="requestId" value={req.id} />
            <Field label="Because" hint="Optional.">
              <input name="reason" className={INPUT} />
            </Field>
            <button
              type="submit"
              className="rounded border border-neutral-300 px-4 py-2 text-sm font-medium dark:border-neutral-700"
            >
              Withdraw
            </button>
          </form>
        </section>
      )}

      {/* ── What happened ────────────────────────────────────────────────────────────── */}
      <section className="space-y-2 rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
        <h2 className="font-medium">Trail</h2>
        <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
          <Row label="Asked for" value={`${peso(req.requestedAmount)} on ${req.requestedOn}`} />
          <Row
            label="Decision"
            value={
              req.decidedOn
                ? req.status === 'rejected'
                  ? `Refused on ${req.decidedOn} — ${req.rejectReason ?? ''}`
                  : `Approved for ${peso(req.approvedAmount ?? '0')} on ${req.decidedOn}`
                : '—'
            }
          />
          <Row
            label="Released"
            value={
              req.releasedOn
                ? `${peso(req.float.released)} on ${req.releasedOn} from ${
                    accounts.find((a) => a.id === req.releasedFromMoneyAccountId)?.name ?? '—'
                  }`
                : '—'
            }
          />
          <Row
            label="Outstanding"
            value={compare(outstanding, ZERO) > 0 ? `${peso(outstanding)} still with the holder` : 'Nothing'}
          />
          {req.notes && <Row label="Notes" value={req.notes} />}
        </dl>
      </section>
      </DetailLayout>
    </Page>
  );
}

const INPUT =
  'w-full rounded border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950';

function Figure({ label, value, emphasis }: { label: string; value: string; emphasis?: boolean }) {
  return (
    <div className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
      <div className="text-xs text-neutral-500 dark:text-neutral-400">{label}</div>
      <div className={`font-mono tabular-nums ${emphasis ? 'text-lg font-medium' : 'text-lg'}`}>
        {value}
      </div>
    </div>
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
      {hint && <span className="text-xs text-neutral-500 dark:text-neutral-500">{hint}</span>}
    </label>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-neutral-500 dark:text-neutral-400">{label}</dt>
      <dd className="mb-1 sm:mb-0">{value}</dd>
    </>
  );
}

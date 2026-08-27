import { requireSession } from '../../lib/session';
import { listActingPersons } from '../expenses/lib';
import {
  createRemittanceAction,
  resolveVarianceAction,
  reverseRemittanceAction,
} from './actions';
import {
  STATE_LABEL,
  cashierAccounts,
  endDays,
  listStores,
  officeAccounts,
  openVariances,
  peso,
  recentRemittances,
  today,
} from './lib';

export const metadata = { title: 'Remittance — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  error?: string;
  ok?: string;
  store?: string;
}

export default async function RemittancePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const { actor } = await requireSession('/remittance');

  const stores = await listStores(actor.orgId);
  const storeId = sp.store || stores[0]?.id;

  if (!storeId) {
    return (
      <main className="mx-auto max-w-5xl space-y-6 p-4 sm:p-8">
        <h1 className="text-2xl font-semibold">Remittance</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">No stores yet.</p>
      </main>
    );
  }

  const [days, cashier, office, recent, variances, people] = await Promise.all([
    endDays(actor.orgId, storeId, today()),
    cashierAccounts(actor.orgId, storeId),
    officeAccounts(actor.orgId, storeId),
    recentRemittances(actor.orgId, storeId),
    openVariances(actor.orgId),
    listActingPersons(actor.orgId),
  ]);

  const owing = days.filter((d) => Number(d.owed) > 0);
  const remittable = owing.filter((d) => d.remittable);
  const totalRemittable = remittable.reduce((s, d) => s + Number(d.owed), 0);
  const heldBack = owing.filter((d) => !d.remittable);

  return (
    <main className="mx-auto max-w-5xl space-y-6 p-4 sm:p-8">
      <div>
        <h1 className="text-2xl font-semibold">Remittance</h1>
        <p className="max-w-2xl text-sm text-neutral-600 dark:text-neutral-400">
          What the cashier holds, day by day, and the handover that clears it. A day is owed{' '}
          <strong>everything the cashier touched</strong> — sales, collections and returns in;
          expenses paid from the till, cash requests and advances out. One handover can settle
          several days.
        </p>
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

      {/*
        ⭐ OPEN VARIANCES FIRST, AND THAT ORDER IS THE POINT (bible row 147).

        Ian: "it won't block — but it must be flagged and dedicate a separated table so it won't
        hide from sight like v1 does." It does not block the next handover; it simply cannot be
        got past without being seen.
      */}
      {variances.length > 0 && (
        <section className="space-y-3 rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950">
          <div className="text-sm text-amber-900 dark:text-amber-300">
            <strong className="font-medium">
              {variances.length} unresolved remittance{' '}
              {variances.length === 1 ? 'variance' : 'variances'}.
            </strong>{' '}
            Money that was counted and signed for did not arrive. ⚠️ This is a{' '}
            <strong>custody</strong> question, not a counting one — the daily counts already
            reconciled, so the date below is where the arithmetic left the residual, not who was
            holding it.
          </div>
          {variances.map((v) => (
            <form
              key={v.id}
              action={resolveVarianceAction}
              className="flex flex-wrap items-end gap-2 border-t border-amber-200 pt-3 dark:border-amber-900"
            >
              <input type="hidden" name="varianceId" value={v.id} />
              <input type="hidden" name="storeId" value={storeId} />
              <div className="mr-2 text-sm text-amber-900 dark:text-amber-300">
                <span className="font-mono tabular-nums">
                  {Number(v.amount) < 0 ? 'Short ' : 'Over '}
                  {peso(Math.abs(Number(v.amount)))}
                </span>
                <span className="ml-2 text-xs">on {v.businessDate}</span>
              </div>
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-amber-900 dark:text-amber-300">
                  Charge to
                </span>
                <select name="personId" defaultValue="" className={`${INPUT} w-44`}>
                  <option value="">Nobody yet…</option>
                  {people.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.displayName}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-amber-900 dark:text-amber-300">
                  Reason
                </span>
                <input name="reason" className={`${INPUT} w-48`} />
              </label>
              <button
                type="submit"
                name="action"
                value="charge"
                className="rounded bg-amber-700 px-3 py-2 text-xs font-medium text-white hover:bg-amber-600"
              >
                Charge
              </button>
              {/* ⚠️ Writing off needs a reason instead of a person — the two ways out, and both
                  require somebody to say something. */}
              <button
                type="submit"
                name="action"
                value="write_off"
                className="rounded border border-amber-400 px-3 py-2 text-xs font-medium text-amber-900 hover:bg-amber-100 dark:border-amber-700 dark:text-amber-300 dark:hover:bg-amber-900"
              >
                Write off
              </button>
            </form>
          ))}
        </section>
      )}

      {/* ── Store picker ─────────────────────────────────────────────────────────────── */}
      {stores.length > 1 && (
        <form className="flex items-end gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">Store</span>
            <select name="store" defaultValue={storeId} className={INPUT}>
              {stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.code})
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            className="rounded border border-neutral-300 px-3 py-2 text-sm font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            Show
          </button>
        </form>
      )}

      {/* ── The end-day reports ──────────────────────────────────────────────────────── */}
      <section className="space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-medium">End-day reports</h2>
          <span className="text-sm text-neutral-600 dark:text-neutral-400">
            Ready to remit:{' '}
            <span className="font-mono font-medium tabular-nums">{peso(totalRemittable)}</span>
          </span>
        </div>

        {days.length === 0 ? (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            Nothing has moved through the cashier yet.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
            <table className="w-full min-w-[720px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                  <th className="px-3 py-2 font-medium">Date</th>
                  <th className="px-3 py-2 text-right font-medium">Cashier movement</th>
                  <th className="px-3 py-2 text-right font-medium">Settled</th>
                  <th className="px-3 py-2 text-right font-medium">Still owed</th>
                  <th className="px-3 py-2 font-medium">State</th>
                </tr>
              </thead>
              <tbody>
                {days.map((d) => (
                  <tr
                    key={d.businessDate}
                    className="border-b border-neutral-100 last:border-0 dark:border-neutral-900"
                  >
                    <td className="px-3 py-2 font-mono whitespace-nowrap">
                      {d.businessDate}
                      {!d.remittable && (
                        <span className="ml-2 rounded bg-neutral-200 px-1.5 py-0.5 text-xs font-medium text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
                          {d.salesDayStatus ? `day ${d.salesDayStatus}` : 'no sales day'}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {peso(d.movement)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {peso(d.allocated)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">{peso(d.owed)}</td>
                    <td className="px-3 py-2 text-xs">{STATE_LABEL[d.state]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* ⚠️ Named rather than hidden: a day with money in it that CANNOT be remitted is a thing
            somebody has to act on — verify the sales day — and silently excluding it from the
            total would leave them wondering where the money went. */}
        {heldBack.length > 0 && (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            {heldBack.length} day{heldBack.length === 1 ? '' : 's'} holding{' '}
            {peso(heldBack.reduce((s, d) => s + Number(d.owed), 0))} cannot be remitted yet — the
            sales day has to be verified first, because that is the signed count behind it.
          </p>
        )}
        <p className="text-xs text-neutral-400 dark:text-neutral-600">
          Every figure is summed from the ledger on load, not stored — so a document type nobody
          has invented yet is already counted.
        </p>
      </section>

      {/* ── Record a handover ────────────────────────────────────────────────────────── */}
      {remittable.length > 0 && cashier.length > 0 && office.length > 0 && (
        <section className="space-y-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <div>
            <h2 className="font-medium">Record a handover</h2>
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              It settles the oldest days first. If it is short, the shortfall lands on the last day
              it reached — and is recorded as an open item, charged to nobody until somebody says
              who.
            </p>
          </div>

          <form action={createRemittanceAction} className="space-y-4">
            <input type="hidden" name="storeId" value={storeId} />

            <div className="space-y-3">
              {cashier.map((a, i) => (
                <div key={a.id} className="grid gap-3 sm:grid-cols-3">
                  <input type="hidden" name="lineAccountId" value={a.id} />
                  <Field label={a.name} hint={`Holds ${peso(a.balance)}`}>
                    <input
                      name={`lineAmount_${i}`}
                      type="number"
                      step="0.01"
                      min="0"
                      inputMode="decimal"
                      placeholder="0.00"
                      className={INPUT}
                    />
                  </Field>
                  {/* ⚠️ Defaults to the office account of the SAME KIND. Cash handed into a bank
                      account is a deposit, not a remittance, and letting the first office account
                      alphabetically win made "BDO — office" the default for the till. */}
                  <Field label="Lands in">
                    <select
                      name={`lineTo_${i}`}
                      defaultValue={
                        office.find((o) => o.instrument === a.instrument)?.id ?? office[0]?.id
                      }
                      className={INPUT}
                    >
                      {office.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
              ))}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Date">
                <input
                  name="remittedOn"
                  type="date"
                  required
                  defaultValue={today()}
                  className={INPUT}
                />
              </Field>
              <Field label="Reference">
                <input name="reference" maxLength={120} className={INPUT} />
              </Field>
            </div>
            <Field label="Notes">
              <input name="notes" className={INPUT} />
            </Field>

            <button
              type="submit"
              className="rounded bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
            >
              Record handover
            </button>
          </form>
        </section>
      )}

      {/* ── History ──────────────────────────────────────────────────────────────────── */}
      {recent.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-medium">Recent handovers</h2>
          <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
            <table className="w-full min-w-[620px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                  <th className="px-3 py-2 font-medium">Date</th>
                  <th className="px-3 py-2 font-medium">Reference</th>
                  <th className="px-3 py-2 font-medium">State</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {recent.map((r) => (
                  <tr
                    key={r.id}
                    className={`border-b border-neutral-100 last:border-0 dark:border-neutral-900 ${
                      r.status === 'reversed' ? 'opacity-50' : ''
                    }`}
                  >
                    <td className="px-3 py-2 font-mono whitespace-nowrap">{r.remittedOn}</td>
                    <td className="px-3 py-2">{r.reference ?? '—'}</td>
                    <td className="px-3 py-2 text-xs">
                      {r.status === 'reversed' ? `Reversed — ${r.reverseReason}` : 'Posted'}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {r.status === 'posted' && (
                        <form action={reverseRemittanceAction} className="flex justify-end gap-1">
                          <input type="hidden" name="remittanceId" value={r.id} />
                          <input type="hidden" name="storeId" value={storeId} />
                          <input
                            name="reason"
                            required
                            placeholder="Reason…"
                            className="w-28 rounded border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-950"
                          />
                          <button
                            type="submit"
                            className="rounded border border-neutral-300 px-3 py-1.5 text-xs font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900"
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
            Reversing writes opposite entries and un-settles the days — nothing is deleted, and the
            days simply become owed again.
          </p>
        </section>
      )}
    </main>
  );
}

const INPUT =
  'w-full rounded border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950';

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

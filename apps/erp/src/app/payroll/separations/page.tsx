import { requireSession } from '../../../lib/session';
import { SEPARATION_CAUSES } from '@shareat/db/schema';
import { postSeparationAction, voidSeparationAction } from './actions';
import { cashAccountsFor, listStores, peso, preview, separationsFor, worklistFor } from './lib';

export const metadata = { title: 'Separations — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  store?: string;
  employmentId?: string;
  separationDate?: string;
  ok?: string;
  error?: string;
}

const CAUSE_LABELS: Record<string, string> = {
  resignation: 'Resignation',
  just_cause: 'Just cause (employee fault)',
  redundancy: 'Redundancy',
  retrenchment: 'Retrenchment',
  closure: 'Business closure',
  disease: 'Disease',
  other: 'Other',
};

/**
 * `/payroll/separations`. T-192.
 *
 * ⭐ Separation pay is a DECISION, not a calculation — the amount field defaults to 0 and is
 * never pre-filled from `cause`. See `docs/tasks/192-separation-final-pay-clearance.md` §1.
 */
export default async function SeparationsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const { actor } = await requireSession('/payroll/separations');

  const stores = await listStores(actor.orgId);
  const storeId = sp.store || stores[0]?.id;
  if (!storeId) {
    return (
      <main className="mx-auto max-w-5xl space-y-4 p-4 sm:p-8">
        <h1 className="text-2xl font-semibold">Separations</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">No store is set up yet.</p>
      </main>
    );
  }

  const [worklist, accounts, separations] = await Promise.all([
    worklistFor(actor.orgId, storeId),
    cashAccountsFor(actor.orgId, storeId),
    separationsFor(actor.orgId, storeId),
  ]);

  const selected = sp.employmentId ? worklist.find((w) => w.employmentId === sp.employmentId) : undefined;
  const separationDate = sp.separationDate || selected?.endedOn || '';
  const pvResult = selected && separationDate
    ? await preview(actor.orgId, actor, { storeId, employmentId: selected.employmentId, separationDate })
    : null;

  return (
    <main className="mx-auto max-w-6xl space-y-6 p-4 sm:p-8">
      <div>
        <h1 className="text-2xl font-semibold">Separations</h1>
        <p className="max-w-3xl text-sm text-neutral-600 dark:text-neutral-400">
          Final pay&rsquo;s wages are just a regular pay run whose period ends on the last worked
          day — use <a href="/payroll" className="underline">/payroll</a> for that. This screen
          prices the pro-rated 13th month and gates the payout on clearance. ⚠️{' '}
          <b>Separation pay is a decision, not a calculation</b> — the amount below is never
          pre-filled from the cause; PH law owes it only for specific authorized causes, and this
          build does not guess which.
        </p>
      </div>

      <form className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className={LABEL}>Store</span>
          <select name="store" defaultValue={storeId} className={`${FIELD} w-52`}>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className={BTN}>
          Switch
        </button>
      </form>

      {sp.error && <Banner tone="error">{sp.error}</Banner>}
      {sp.ok && <Banner tone="ok">{sp.ok}</Banner>}

      <section className="space-y-3 rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
        <h2 className="text-sm font-medium">Worklist — ended, not yet processed</h2>
        {worklist.length === 0 ? (
          <p className="rounded border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700">
            Nobody is waiting on separation processing at this store.
          </p>
        ) : (
          <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
            {worklist.map((w) => (
              <li key={w.employmentId} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span>
                  {w.personName} <span className="text-neutral-500">— {w.employmentStatus}{w.endedOn ? `, ended ${w.endedOn}` : ''}</span>
                </span>
                <a
                  href={`/payroll/separations?store=${storeId}&employmentId=${w.employmentId}${w.endedOn ? `&separationDate=${w.endedOn}` : ''}`}
                  className="underline"
                >
                  Process
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>

      {selected && (
        <section className="space-y-4 rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
          <h2 className="text-sm font-medium">Processing {selected.personName}</h2>

          <form className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="store" value={storeId} />
            <input type="hidden" name="employmentId" value={selected.employmentId} />
            <label className="flex flex-col gap-1">
              <span className={LABEL}>Separation date</span>
              <input name="separationDate" type="date" defaultValue={separationDate} className={`${FIELD} w-44`} />
            </label>
            <button type="submit" className={BTN}>
              Preview
            </button>
          </form>

          {pvResult?.error && <Banner tone="error">{pvResult.error}</Banner>}

          {pvResult?.preview && (
            <form action={postSeparationAction} className="space-y-3">
              <input type="hidden" name="storeId" value={storeId} />
              <input type="hidden" name="employmentId" value={selected.employmentId} />
              <input type="hidden" name="separationDate" value={separationDate} />

              <p className="text-xs text-neutral-500">
                Pro-rated 13th month: basic pay earned {peso(Number(pvResult.preview.thirteenthMonthBasicPayEarned))} →
                gross <b className="text-neutral-700 dark:text-neutral-300">{peso(Number(pvResult.preview.thirteenthMonthGross))}</b>.
                Outstanding advance: {peso(Number(pvResult.preview.outstandingAdvance))}.
              </p>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <label className="flex flex-col gap-1">
                  <span className={LABEL}>Cause</span>
                  <select name="cause" defaultValue="resignation" className={FIELD}>
                    {SEPARATION_CAUSES.map((c) => (
                      <option key={c} value={c}>
                        {CAUSE_LABELS[c] ?? c}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1">
                  <span className={LABEL}>Separation pay (₱)</span>
                  <input name="separationPayAmount" type="number" step="0.01" min="0" defaultValue="0" className={FIELD} />
                  <span className="text-[11px] text-neutral-500">A decision, not a calculation — see above.</span>
                </label>
                <label className="flex flex-col gap-1">
                  <span className={LABEL}>Pay from</span>
                  <select name="moneyAccountId" className={FIELD}>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <label className="flex items-start gap-2 rounded border border-neutral-200 px-3 py-2 dark:border-neutral-800">
                <input type="checkbox" name="clearanceConfirmed" className="mt-0.5" />
                <span>
                  <span className="block text-xs font-medium">Clearance confirmed</span>
                  <span className="block text-[11px] text-neutral-500">
                    No outstanding accountabilities. ⛔ Required — posting refuses without this.
                  </span>
                </span>
              </label>
              <input name="clearanceNotes" placeholder="Clearance notes (optional)" className={`${FIELD} w-full`} />
              <input name="notes" placeholder="Notes (optional)" className={`${FIELD} w-full`} />

              <button type="submit" className={BTN_PRIMARY}>
                Post separation
              </button>
            </form>
          )}
        </section>
      )}

      <section className="space-y-3">
        <h2 className="text-sm font-medium">Processed</h2>
        {separations.length === 0 ? (
          <p className="rounded-lg border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700">
            No separation processed yet at this store.
          </p>
        ) : (
          separations.map((s) => (
            <div key={s.id} className="space-y-2 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="text-sm font-medium">{s.personName}</span>
                <span className="text-xs text-neutral-500">{CAUSE_LABELS[s.cause] ?? s.cause} · {s.separationDate}</span>
                <span className="rounded bg-neutral-200 px-1.5 py-0.5 text-xs dark:bg-neutral-800">{s.status}</span>
                {s.voidReason && <span className="text-xs text-neutral-500">voided — {s.voidReason}</span>}
              </div>
              <p className="text-xs text-neutral-600 dark:text-neutral-400">
                13th month {peso(Number(s.thirteenthMonthGross))} + separation pay {peso(Number(s.separationPayAmount))} −
                advance {peso(Number(s.advanceRecovered))} = net {peso(Number(s.netPay))}
              </p>
              {s.status === 'posted' && (
                <form action={voidSeparationAction} className="flex flex-wrap items-end gap-2">
                  <input type="hidden" name="storeId" value={storeId} />
                  <input type="hidden" name="id" value={s.id} />
                  <input name="reason" placeholder="Why void it?" className={`${FIELD} w-64`} />
                  <button type="submit" className={BTN}>
                    Void
                  </button>
                </form>
              )}
            </div>
          ))
        )}
      </section>
    </main>
  );
}

function Banner({ tone, children }: { tone: 'error' | 'ok'; children: React.ReactNode }) {
  const cls =
    tone === 'error'
      ? 'border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-300'
      : 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300';
  return <div className={`rounded-lg border p-4 text-sm ${cls}`}>{children}</div>;
}

const FIELD =
  'rounded border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950';
const LABEL = 'text-xs font-medium text-neutral-600 dark:text-neutral-400';
const BTN =
  'rounded border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900';
const BTN_PRIMARY =
  'rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300';

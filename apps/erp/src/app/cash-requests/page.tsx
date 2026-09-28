import Link from 'next/link';
import { requireSession } from '../../lib/session';
import { createRequestAction } from './actions';
import {
  STATUS_LABEL,
  STATUS_TONE,
  listActivePersons,
  listRegister,
  listStores,
  peso,
  today,
} from './lib';
import { Page } from '@/components/shell/Page';

export const metadata = { title: 'Cash requests — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  error?: string;
}

export default async function CashRequestsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const { actor } = await requireSession('/cash-requests');

  const [stores, persons, requests] = await Promise.all([
    listStores(actor.orgId),
    listActivePersons(actor.orgId),
    listRegister(actor.orgId),
  ]);
  const storeById = new Map(stores.map((s) => [s.id, s]));
  const personById = new Map(persons.map((p) => [p.id, p]));

  // ⭐ Floats still in someone's hands. This is the number that must not hide behind a filter —
  // an unsettled float is money the business owns and cannot see, and the whole document exists
  // to make it visible.
  const open = requests.filter((r) => r.status === 'released');
  const outstanding = open.reduce((sum, r) => sum + Number(r.float.outstanding), 0);
  const waiting = requests.filter((r) => r.status === 'requested');

  return (
    <Page density="table">
      <div>
        <h1 className="text-2xl font-semibold">Cash requests</h1>
        <p className="max-w-2xl text-sm text-neutral-600 dark:text-neutral-400">
          Money handed to a person for an errand, spent, and reconciled. Every figure is summed from
          the ledger — <strong>a request closes when its float reaches zero</strong>, not when
          someone marks it done.
        </p>
      </div>

      {sp.error && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {sp.error}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
          <div className="text-xs text-neutral-500 dark:text-neutral-400">
            Out with holders, across {open.length} {open.length === 1 ? 'float' : 'floats'}
          </div>
          <div className="font-mono text-lg tabular-nums">{peso(outstanding)}</div>
        </div>
        <div className="rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
          <div className="text-xs text-neutral-500 dark:text-neutral-400">Waiting on a decision</div>
          <div className="font-mono text-lg tabular-nums">{waiting.length}</div>
        </div>
      </div>

      {/* ── The register ─────────────────────────────────────────────────────────────── */}
      {requests.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
          <table className="w-full min-w-[900px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                <th className="px-3 py-2 font-medium">Purpose</th>
                <th className="px-3 py-2 font-medium">Holder</th>
                <th className="px-3 py-2 font-medium">Store</th>
                <th className="px-3 py-2 font-medium">Asked</th>
                <th className="px-3 py-2 text-right font-medium">Released</th>
                <th className="px-3 py-2 text-right font-medium">Spent</th>
                <th className="px-3 py-2 text-right font-medium">Still out</th>
                <th className="px-3 py-2 font-medium">State</th>
              </tr>
            </thead>
            <tbody>
              {requests.map((r) => {
                const dormant =
                  r.status === 'rejected' ||
                  r.status === 'cancelled' ||
                  r.status === 'liquidated';
                return (
                  <tr
                    key={r.id}
                    className={`border-b border-neutral-100 last:border-0 dark:border-neutral-900 ${
                      dormant ? 'opacity-60' : ''
                    }`}
                  >
                    <td className="px-3 py-2">
                      <Link
                        href={`/cash-requests/${r.id}`}
                        className="underline underline-offset-2"
                      >
                        {r.purpose}
                      </Link>
                      <div className="text-xs text-neutral-400 dark:text-neutral-600">
                        {r.requestedOn}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      {personById.get(r.requestedFor)?.displayName ?? '—'}
                    </td>
                    <td className="px-3 py-2">{storeById.get(r.storeId)?.code ?? '—'}</td>
                    <td className="px-3 py-2 font-mono text-xs tabular-nums">
                      {peso(r.requestedAmount)}
                      {/* ⚠️ Approved may differ from asked, deliberately — approving less is the
                          common case and approving more is allowed. Hiding the difference would
                          make the approval look decorative. */}
                      {r.approvedAmount && r.approvedAmount !== r.requestedAmount && (
                        <div className="text-neutral-400 dark:text-neutral-600">
                          approved {peso(r.approvedAmount)}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {peso(r.float.released)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {peso(r.float.spent)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {peso(r.float.outstanding)}
                    </td>
                    <td className={`px-3 py-2 text-xs ${STATUS_TONE[r.status] ?? ''}`}>
                      {STATUS_LABEL[r.status] ?? r.status}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">No cash requests yet.</p>
      )}

      {/* ── Ask for one ──────────────────────────────────────────────────────────────── */}
      <section className="space-y-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <div>
          <h2 className="font-medium">Ask for cash</h2>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            ⚠️ This records the <strong>ask</strong>. Nothing posts — a request that moved money
            would show a float in someone&rsquo;s hands before anyone handed it over.
          </p>
        </div>

        <form action={createRequestAction} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Store">
              <select name="storeId" required defaultValue="" className={INPUT}>
                <option value="" disabled>
                  Choose…
                </option>
                {stores.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="Who holds the money"
              hint="The person the float is charged to — a shortage lands on them by name."
            >
              <select name="requestedFor" required defaultValue="" className={INPUT}>
                <option value="" disabled>
                  Choose…
                </option>
                {persons.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="What it is for">
              <input
                name="purpose"
                required
                placeholder="Market run, permit fee…"
                className={INPUT}
              />
            </Field>
            <Field label="Amount">
              <input
                name="amount"
                required
                inputMode="decimal"
                className={INPUT}
              />
            </Field>
            <Field label="Date">
              <input name="on" type="date" required defaultValue={today()} className={INPUT} />
            </Field>
            <Field label="Notes" hint="Optional.">
              <input name="notes" className={INPUT} />
            </Field>
          </div>
          <button
            type="submit"
            className="rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-neutral-900"
          >
            Submit request
          </button>
        </form>
      </section>
    </Page>
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
      {hint && <span className="text-xs text-neutral-500 dark:text-neutral-500">{hint}</span>}
    </label>
  );
}

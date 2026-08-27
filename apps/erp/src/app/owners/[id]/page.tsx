import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireSession } from '../../../lib/session';
import {
  closeMonthAction,
  contributionAction,
  drawingAction,
  settleAction,
} from '../actions';
import {
  TREATMENT_LABEL,
  getDetail,
  listActivePersons,
  listStores,
  moneyAccounts,
  peso,
  today,
} from '../lib';

export const metadata = { title: 'Owner — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  error?: string;
  ok?: string;
}

export default async function OwnerPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const { actor } = await requireSession(`/owners/${id}`);

  const owner = await getDetail(actor.orgId, id);
  if (!owner) notFound();

  const [accounts, stores, persons] = await Promise.all([
    moneyAccounts(actor.orgId, owner.storeId),
    listStores(actor.orgId),
    listActivePersons(actor.orgId),
  ]);
  const store = stores.find((s) => s.id === owner.storeId);
  const who = persons.find((p) => p.id === owner.personId);
  const owes = Number(owner.position.receivable);

  return (
    <main className="mx-auto max-w-4xl space-y-6 p-4 sm:p-8">
      <div>
        <Link href="/owners" className="text-sm underline underline-offset-2">
          ← Owners
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">{who?.displayName ?? 'Unknown owner'}</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          {owner.role ?? '—'} · {store?.name ?? '—'} ·{' '}
          {owner.drawingLimit
            ? `${peso(owner.drawingLimit)} ${owner.drawingLimitPeriod} limit`
            : 'no drawing limit'}{' '}
          · {TREATMENT_LABEL[owner.personalExpenseTreatment]}
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

      {/* ── The position ─────────────────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-4">
          <Figure label="Contributed" value={peso(owner.position.contributed)} />
          <Figure label="Drawn" value={peso(owner.position.drawn)} />
          <Figure label="Net equity" value={peso(owner.position.net)} emphasis />
          <Figure label="Still owes us" value={peso(owner.position.receivable)} />
        </div>
        <p className="text-xs text-neutral-500 dark:text-neutral-500">
          ⭐ <strong>Net</strong> is contributed minus drawn — arithmetic on the two figures beside
          it, never a stored third number.{' '}
          <strong>Still owes us</strong> is separate on purpose: a personal expense the business
          expects back has not reduced equity, and it is not part of net.
          {owner.aged && (
            <>
              {' '}
              ⚠️ Oldest unsettled charge {owner.aged.oldestOn} —{' '}
              <strong>{owner.aged.daysOutstanding} days</strong>.
            </>
          )}
        </p>
      </section>

      {/* ── Settle what is owed ──────────────────────────────────────────────────────── */}
      {owes > 0 && (
        <section className="space-y-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <div>
            <h2 className="font-medium">Settle {peso(owner.position.receivable)}</h2>
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              Three ways, and they are not equivalent. ⚠️ Only <strong>cash back</strong> actually
              returns the money — recovering from pay moves it to a salary advance and nothing has
              come back yet, so it keeps counting against the drawing limit. Writing it off turns it
              into a drawing, which is the moment equity really falls.
            </p>
          </div>
          <form action={settleAction} className="space-y-4">
            <input type="hidden" name="ownerId" value={owner.id} />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="How">
                <select name="how" required defaultValue="" className={INPUT}>
                  <option value="" disabled>
                    Choose…
                  </option>
                  <option value="cash">Cash back — the money returns to an account</option>
                  <option value="pay">Recover from pay — becomes a salary advance</option>
                  <option value="writeoff">Write off — it becomes a drawing</option>
                </select>
              </Field>
              <Field label="Amount">
                <input
                  name="amount"
                  required
                  type="number"
                  step="0.01"
                  min="0.01"
                  defaultValue={owner.position.receivable}
                  className={INPUT}
                />
              </Field>
              <Field label="Into (cash back only)">
                <select name="intoMoneyAccountId" defaultValue="" className={INPUT}>
                  <option value="">—</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} — {peso(a.balance)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Because (write-off only)" hint="A write-off with no reason is indistinguishable from nobody collecting.">
                <input name="reason" className={INPUT} />
              </Field>
              <Field label="On">
                <input name="on" type="date" required defaultValue={today()} className={INPUT} />
              </Field>
            </div>
            <button
              type="submit"
              className="rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-neutral-900"
            >
              Settle
            </button>
          </form>
        </section>
      )}

      {/* ── Move money ───────────────────────────────────────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-2">
        <section className="space-y-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <div>
            <h2 className="font-medium">Capital in</h2>
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              Money the owner puts into the business. Equity goes up.
            </p>
          </div>
          <form action={contributionAction} className="space-y-3">
            <input type="hidden" name="ownerId" value={owner.id} />
            <Field label="Amount">
              <input name="amount" required type="number" step="0.01" min="0.01" className={INPUT} />
            </Field>
            <Field label="Into">
              <select name="intoMoneyAccountId" required defaultValue="" className={INPUT}>
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
            <button
              type="submit"
              className="rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-neutral-900"
            >
              Record contribution
            </button>
          </form>
        </section>

        <section className="space-y-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <div>
            <h2 className="font-medium">Drawing out</h2>
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              Money the owner takes. Equity goes down.
              {owner.drawingLimit && (
                <>
                  {' '}
                  ⚠️ Refused above {peso(owner.drawingLimit)} {owner.drawingLimitPeriod} — unrepaid
                  personal expenses count towards it.
                </>
              )}
            </p>
          </div>
          <form action={drawingAction} className="space-y-3">
            <input type="hidden" name="ownerId" value={owner.id} />
            <Field label="Amount">
              <input name="amount" required type="number" step="0.01" min="0.01" className={INPUT} />
            </Field>
            <Field label="From">
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
            <button
              type="submit"
              className="rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-neutral-900"
            >
              Record drawing
            </button>
          </form>
        </section>
      </div>

      {/* ── The monthly close ────────────────────────────────────────────────────────── */}
      <section className="space-y-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <div>
          <h2 className="font-medium">Monthly drawings close</h2>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            Agree what this owner drew in a month and shut it. ⛔ <strong>Closing locks it</strong> —
            a drawing dated into a closed month is refused afterwards, which is what makes the agreed
            figure stay true. If your figure differs from the ledger, the difference is{' '}
            <strong>posted to the books</strong>, and it needs a reason.
          </p>
        </div>

        {owner.closableMonth ? (
          <form action={closeMonthAction} className="space-y-4">
            <input type="hidden" name="ownerId" value={owner.id} />
            <input type="hidden" name="month" value={owner.closableMonth} />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Month">
                <input
                  disabled
                  value={owner.closableMonth.slice(0, 7)}
                  className={`${INPUT} opacity-70`}
                />
              </Field>
              <Field
                label="Agreed amount"
                hint={`The ledger says ${peso(owner.closableAmount)}. Leave as-is to agree with it.`}
              >
                <input
                  name="acknowledgedAmount"
                  type="number"
                  step="0.01"
                  min="0"
                  defaultValue={owner.closableAmount}
                  className={INPUT}
                />
              </Field>
              <Field label="Difference because" hint="Required only if your figure differs.">
                <input name="adjustmentReason" className={INPUT} />
              </Field>
              <Field label="On">
                <input name="on" type="date" required defaultValue={today()} className={INPUT} />
              </Field>
            </div>
            <button
              type="submit"
              className="rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-neutral-900"
            >
              Close {owner.closableMonth.slice(0, 7)}
            </button>
          </form>
        ) : (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            Last month is already closed for this owner.
          </p>
        )}

        {owner.closes.length > 0 && (
          <div className="overflow-x-auto rounded border border-neutral-200 dark:border-neutral-800">
            <table className="w-full min-w-[560px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                  <th className="px-3 py-2 font-medium">Month</th>
                  <th className="px-3 py-2 text-right font-medium">Agreed</th>
                  <th className="px-3 py-2 text-right font-medium">Adjustment</th>
                  <th className="px-3 py-2 font-medium">Closed</th>
                </tr>
              </thead>
              <tbody>
                {owner.closes.map((c) => (
                  <tr key={c.id} className="border-b border-neutral-100 last:border-0 dark:border-neutral-900">
                    <td className="px-3 py-2 font-mono">{c.periodMonth.slice(0, 7)}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {peso(c.acknowledgedAmount)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {c.adjustmentAmount ? (
                        <>
                          {peso(c.adjustmentAmount)}
                          <div className="text-xs font-sans text-neutral-400 dark:text-neutral-600">
                            {c.adjustmentReason}
                          </div>
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs">{c.closedOn}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
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

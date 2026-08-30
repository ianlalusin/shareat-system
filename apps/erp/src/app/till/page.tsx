import { requireSession } from '../../lib/session';
import { listActingPersons } from '../expenses/lib';
import {
  chargeShortageAction,
  closeShiftAction,
  openShiftAction,
  recordCountAction,
} from './actions';
import {
  chargeableShortages,
  listStores,
  nextMomentFor,
  peso,
  tillOverview,
  today,
  varianceOf,
  varianceSentence,
  type ShiftView,
  type TillCountRow,
} from './lib';

export const metadata = { title: 'Till custody — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  error?: string;
  ok?: string;
  store?: string;
}

export default async function TillPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const { actor } = await requireSession('/till');

  const stores = await listStores(actor.orgId);
  const storeId = sp.store || stores[0]?.id;

  if (!storeId) {
    return (
      <main className="mx-auto max-w-5xl space-y-4 p-4 sm:p-8">
        <h1 className="text-2xl font-semibold">Till custody</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          No store is set up yet.
        </p>
      </main>
    );
  }

  const { open, recent, accounts, chargedLineIds } = await tillOverview(actor.orgId, storeId);
  const people = await listActingPersons(actor.orgId);

  // ⭐ The shift a new one would take over from: the most recent CLOSED shift that nobody has
  // already inherited. A branching chain is refused by the database; this stops it being offered.
  const inherited = new Set(recent.map((v) => v.shift.prevShiftId).filter(Boolean));
  const handoverFrom = recent.find(
    (v) => v.shift.status === 'closed' && !inherited.has(v.shift.id),
  );

  return (
    <main className="mx-auto max-w-5xl space-y-6 p-4 sm:p-8">
      <div>
        <h1 className="text-2xl font-semibold">Till custody</h1>
        <p className="max-w-3xl text-sm text-neutral-600 dark:text-neutral-400">
          Who is holding the till, and what they counted. ⭐ A count here is a{' '}
          <strong>physical</strong> figure measured against the ledger — not the ledger measured
          against a target. Those look identical as a number and mean opposite things, and only
          this one names somebody who owes money.
        </p>
      </div>

      <form className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">Store</span>
          <select name="store" defaultValue={storeId} className={`${INPUT} w-64`}>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className={BTN}>
          Show
        </button>
      </form>

      {sp.error && <Banner tone="error">{sp.error}</Banner>}
      {sp.ok && <Banner tone="ok">{sp.ok}</Banner>}

      {/* ---------------------------------------------------------------- the open shift */}
      {open ? (
        <OpenShift view={open} storeId={storeId} accounts={accounts} />
      ) : (
        <section className="space-y-3 rounded-lg border border-dashed border-neutral-300 p-5 dark:border-neutral-700">
          <h2 className="text-sm font-medium">Nobody is holding this till</h2>
          <p className="max-w-2xl text-xs text-neutral-500">
            ⛔ A store may have only one open shift at a time — the database enforces it, because
            two open shifts mean two people believe they hold the same cash.
          </p>
          <form action={openShiftAction} className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="storeId" value={storeId} />
            <label className="flex flex-col gap-1">
              <span className={LABEL}>Trading date</span>
              <input name="businessDate" type="date" defaultValue={today()} className={`${INPUT} w-44`} />
            </label>
            {handoverFrom && (
              <label className="flex flex-col gap-1">
                <span className={LABEL}>Taking over from</span>
                <select name="prevShiftId" defaultValue="" className={`${INPUT} w-64`}>
                  <option value="">Nobody — first shift of the day</option>
                  <option value={handoverFrom.shift.id}>
                    Shift {handoverFrom.shift.shiftNo}, {handoverFrom.shift.businessDate} (
                    {handoverFrom.shift.closedByName ?? 'unknown'})
                  </option>
                </select>
              </label>
            )}
            <button type="submit" className={BTN_PRIMARY}>
              Open shift
            </button>
          </form>
        </section>
      )}

      {/* ---------------------------------------------------------------- history */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium">Recent shifts</h2>
        {recent.length === 0 ? (
          <p className="rounded-lg border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700">
            No shift has been closed at this store yet.
          </p>
        ) : (
          recent.map((v) => (
            <ClosedShift
              key={v.shift.id}
              view={v}
              storeId={storeId}
              people={people}
              chargedLineIds={chargedLineIds}
            />
          ))
        )}
      </section>
    </main>
  );
}

/* -------------------------------------------------------------------------------------- */

function OpenShift({
  view,
  storeId,
  accounts,
}: {
  view: ShiftView;
  storeId: string;
  accounts: { id: string; name: string; glAccountCode: string; floatTarget: string | null }[];
}) {
  const { shift, counts } = view;
  const closeCounts = counts.filter((c) => c.moment === 'close');
  // ⚠️ `null` once every pocket counted in has been counted out — the form then disappears
  // rather than offering a duplicate the database would refuse.
  const nextMoment = nextMomentFor(counts, accounts);

  return (
    <section className="space-y-4 rounded-lg border border-emerald-300 p-5 dark:border-emerald-800">
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="text-sm font-medium">
          Shift {shift.shiftNo} — {shift.businessDate}
        </h2>
        <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-xs text-emerald-900 dark:bg-emerald-950 dark:text-emerald-300">
          open
        </span>
        <span className="text-xs text-neutral-500">
          held by {shift.openedByName ?? 'unknown'}
          {shift.prevShiftId && ' · taken over by handover'}
        </span>
      </div>

      {counts.length > 0 && <CountTable counts={counts} />}

      {nextMoment && (
      <form action={recordCountAction} className="space-y-3">
        <input type="hidden" name="storeId" value={storeId} />
        <input type="hidden" name="shiftId" value={shift.id} />
        <input type="hidden" name="moment" value={nextMoment} />
        <p className="text-xs font-medium">
          {nextMoment === 'open' ? 'Opening count' : 'Closing count'}
          <span className="ml-2 font-normal text-neutral-500">
            ⚠️ Leave a pocket blank if you did not count it — blank is not zero.
          </span>
        </p>
        <div className="flex flex-wrap gap-3">
          {accounts.map((a) => (
            <label key={a.id} className="flex flex-col gap-1">
              <span className={LABEL}>
                {a.name}
                {a.floatTarget && (
                  <span className="ml-1 text-neutral-400">float {peso(Number(a.floatTarget))}</span>
                )}
              </span>
              <input
                name={`count:${a.id}`}
                type="number"
                step="0.01"
                min="0"
                inputMode="decimal"
                placeholder="0.00"
                className={`${INPUT} w-40`}
              />
            </label>
          ))}
        </div>
        <button type="submit" className={BTN_PRIMARY}>
          Record {nextMoment === 'open' ? 'opening' : 'closing'} count
        </button>
      </form>
      )}

      {closeCounts.length > 0 && (
        <form action={closeShiftAction} className="flex flex-wrap items-end gap-3 border-t border-neutral-200 pt-4 dark:border-neutral-800">
          <input type="hidden" name="storeId" value={storeId} />
          <input type="hidden" name="shiftId" value={shift.id} />
          <input name="notes" placeholder="Handover notes (optional)" className={`${INPUT} w-72`} />
          <button type="submit" className={BTN}>
            Close shift
          </button>
        </form>
      )}
    </section>
  );
}

function ClosedShift({
  view,
  storeId,
  people,
  chargedLineIds,
}: {
  view: ShiftView;
  storeId: string;
  people: { id: string; displayName: string }[];
  chargedLineIds: ReadonlySet<string>;
}) {
  const { shift, counts } = view;
  // ⛔ Already-charged shortages are NOT offered again — the debt is on the books against a
  // named person, and a form saying otherwise is worse than no form.
  const shortages = chargeableShortages(counts, chargedLineIds);
  const settled = counts.filter((c) => c.moment === 'close' && chargedLineIds.has(c.id));

  return (
    <div className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-sm font-medium">
          Shift {shift.shiftNo} — {shift.businessDate}
        </span>
        <span className="rounded bg-neutral-200 px-1.5 py-0.5 text-xs dark:bg-neutral-800">
          {shift.status}
        </span>
        <span className="text-xs text-neutral-500">
          {shift.openedByName ?? 'unknown'} → closed by {shift.closedByName ?? 'unknown'}
        </span>
      </div>

      {counts.length > 0 && <CountTable counts={counts} />}

      {settled.map((c) => (
        <p
          key={c.id}
          className="rounded border border-neutral-200 p-3 text-xs text-neutral-500 dark:border-neutral-800"
        >
          {peso(Math.abs(varianceOf(c)))} charged to a named person against{' '}
          <code>1230</code>. ⚠️ The office replenishment is a separate transfer.
        </p>
      ))}

      {shortages.map((c) => (
        <form
          key={c.id}
          action={chargeShortageAction}
          className="flex flex-wrap items-end gap-2 rounded border border-red-300 p-3 dark:border-red-800"
        >
          <input type="hidden" name="storeId" value={storeId} />
          <input type="hidden" name="countLineId" value={c.id} />
          <div className="w-full text-xs text-red-900 dark:text-red-300">
            {/* ⭐ The wording is the guard: a COUNTED short is chargeable, a LEDGER short is not. */}
            {varianceSentence(varianceOf(c), peso)}
          </div>
          <label className="flex flex-col gap-1">
            <span className={LABEL}>Charge to</span>
            <select name="personId" defaultValue="" className={`${INPUT} w-56`}>
              <option value="">Choose a person…</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName}
                </option>
              ))}
            </select>
          </label>
          <input name="note" placeholder="Note (optional)" className={`${INPUT} w-56`} />
          <button type="submit" className={BTN}>
            Charge to 1230
          </button>
        </form>
      ))}
    </div>
  );
}

function CountTable({ counts }: { counts: TillCountRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[34rem] text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-neutral-500">
            <th className="py-1 pr-3 font-medium">Moment</th>
            <th className="py-1 pr-3 font-medium">Pocket</th>
            <th className="py-1 pr-3 text-right font-medium">Counted</th>
            <th className="py-1 pr-3 text-right font-medium">Ledger</th>
            <th className="py-1 font-medium">Variance</th>
          </tr>
        </thead>
        <tbody>
          {counts.map((c) => {
            const v = varianceOf(c);
            return (
              <tr key={c.id} className="border-t border-neutral-200 dark:border-neutral-800">
                <td className="py-1.5 pr-3 text-xs text-neutral-500">{c.moment}</td>
                <td className="py-1.5 pr-3">
                  {c.moneyAccountName}{' '}
                  <code className="text-xs text-neutral-500">{c.glAccountCode}</code>
                </td>
                <td className="py-1.5 pr-3 text-right font-mono tabular-nums">
                  {peso(Number(c.counted))}
                </td>
                <td className="py-1.5 pr-3 text-right font-mono tabular-nums text-neutral-500">
                  {peso(Number(c.expected))}
                </td>
                <td
                  className={`py-1.5 text-xs ${
                    v === 0
                      ? 'text-neutral-500'
                      : v < 0
                        ? 'text-red-700 dark:text-red-400'
                        : 'text-amber-700 dark:text-amber-400'
                  }`}
                >
                  {varianceSentence(v, peso)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Banner({ tone, children }: { tone: 'error' | 'ok'; children: React.ReactNode }) {
  const cls =
    tone === 'error'
      ? 'border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-300'
      : 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300';
  return <div className={`rounded-lg border p-4 text-sm ${cls}`}>{children}</div>;
}

const INPUT =
  'w-full rounded border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950';
const LABEL = 'text-xs font-medium text-neutral-600 dark:text-neutral-400';
const BTN =
  'rounded border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900';
const BTN_PRIMARY =
  'rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300';

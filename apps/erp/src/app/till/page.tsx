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
import { CheckedForm, FieldCheck } from '@/components/forms';
import { TILL_OPEN_SHIFT_RULES, nativeAttrs, type FieldRule } from '@shareat/domain/field-rules';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';
import { Button, FlashBanner, FormGrid, Input, Select } from '@/components/ui';
import { SubmitButton } from '@/components/feedback/SubmitButton';

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
  const sp = await withFlash(searchParams);
  const { actor } = await requireSession('/till');

  const stores = await listStores(actor.orgId);
  const storeId = sp.store || stores[0]?.id;

  if (!storeId) {
    return (
      <Page density="table" className="space-y-4">
        <h1 className="text-2xl font-semibold">Till custody</h1>
        <PageDescription>
          No store is set up yet.
        </PageDescription>
      </Page>
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
    <Page density="table">
      <div>
        <h1 className="text-2xl font-semibold">Till custody</h1>
        <PageDescription>
          Who is holding the till, and what they counted. ⭐ A count here is a{' '}
          <strong>physical</strong> figure measured against the ledger — not the ledger measured
          against a target. Those look identical as a number and mean opposite things, and only
          this one names somebody who owes money.
        </PageDescription>
      </div>

      <form className="flex flex-wrap items-end gap-3">
        <label className="flex min-w-0 flex-1 basis-56 flex-col gap-1">
          <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">Store</span>
          <Select name="store" defaultValue={storeId} className="w-full">
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </label>
        <Button type="submit">Show</Button>
      </form>

      <FlashBanner flash={sp} />

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
          <CheckedForm rules={TILL_OPEN_SHIFT_RULES} action={openShiftAction} className="space-y-3">
            <input type="hidden" name="storeId" value={storeId} />
            <FormGrid>
            <Field label="Trading date" rule={TILL_OPEN_SHIFT_RULES.businessDate}>
              <Input {...nativeAttrs(TILL_OPEN_SHIFT_RULES.businessDate)} type="date" defaultValue={today()} className="w-full" />
            </Field>
            {handoverFrom && (
              <label className="flex flex-col gap-1">
                <span className={LABEL}>Taking over from</span>
                <Select name="prevShiftId" defaultValue="" className="w-full">
                  <option value="">Nobody — first shift of the day</option>
                  <option value={handoverFrom.shift.id}>
                    Shift {handoverFrom.shift.shiftNo}, {handoverFrom.shift.businessDate} (
                    {handoverFrom.shift.closedByName ?? 'unknown'})
                  </option>
                </Select>
              </label>
            )}
            </FormGrid>
            <SubmitButton pendingLabel="Saving…">Open shift</SubmitButton>
          </CheckedForm>
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
    </Page>
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
    <section className="space-y-4 rounded-lg border border-success p-5">
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="text-sm font-medium">
          Shift {shift.shiftNo} — {shift.businessDate}
        </h2>
        <span className="rounded bg-success-soft px-1.5 py-0.5 text-xs text-success">
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
        <FormGrid>
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
                inputMode="decimal"
                placeholder="0.00"
                className="w-full rounded-[10px] border border-field-border bg-field px-3 py-2 min-h-11 text-sm text-ink"
              />
            </label>
          ))}
        </FormGrid>
        <SubmitButton pendingLabel="Saving…">
          {nextMoment === 'open' ? 'Record opening count' : 'Record closing count'}
        </SubmitButton>
      </form>
      )}

      {closeCounts.length > 0 && (
        <form action={closeShiftAction} className="flex flex-wrap items-end gap-3 border-t border-neutral-200 pt-4 dark:border-neutral-800">
          <input type="hidden" name="storeId" value={storeId} />
          <input type="hidden" name="shiftId" value={shift.id} />
          <Input name="notes" placeholder="Handover notes (optional)" className="w-full min-w-0 flex-1 basis-64" />
          <Button type="submit">Close shift</Button>
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
        <span className="rounded bg-closed-soft px-1.5 py-0.5 text-xs text-closed">
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
          {peso(Math.abs(varianceOf(c)))} charged to a named person as an advance to that employee. ⚠️ The office replenishment is a separate transfer.
        </p>
      ))}

      {shortages.map((c) => (
        <form
          key={c.id}
          action={chargeShortageAction}
          className="flex flex-wrap items-end gap-2 rounded border border-danger p-3"
        >
          <input type="hidden" name="storeId" value={storeId} />
          <input type="hidden" name="countLineId" value={c.id} />
          <div className="w-full text-xs text-danger">
            {/* ⭐ The wording is the guard: a COUNTED short is chargeable, a LEDGER short is not. */}
            {varianceSentence(varianceOf(c), peso)}
          </div>
          <FormGrid className="w-full">
          <label className="flex flex-col gap-1">
            <span className={LABEL}>Charge to</span>
            <Select name="personId" defaultValue="" className="w-full">
              <option value="">Choose a person…</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName}
                </option>
              ))}
            </Select>
          </label>
          <Input name="note" placeholder="Note (optional)" className="w-full" />
          </FormGrid>
          <Button type="submit">Charge to this person</Button>
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
                  {c.moneyAccountName}
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
                        ? 'text-danger'
                        : 'text-warning-ink'
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

const LABEL = 'text-xs font-medium text-neutral-600 dark:text-neutral-400';

function Field({ label, rule, children }: { label: string; rule: FieldRule; children: React.ReactNode }) {
  // T-440: the label keeps its look; the live helper line sits OUTSIDE it (never part of the accessible name).
  return (
    <div>
      <label className="flex flex-col gap-1">
        <span className={LABEL}>{label}</span>
        {children}
      </label>
      <FieldCheck rule={rule} />
    </div>
  );
}

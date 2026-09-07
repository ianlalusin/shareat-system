import { notFound } from 'next/navigation';
import { salesDaysRepo, journalRepo } from '@shareat/db';
import { formatMoney, money } from '@shareat/core/money';
import { listStores, listActingPersons } from '../lib';
import { requireSession } from '../../../lib/session';
import { submitSalesDayAction, verifySalesDayAction, voidSalesDayAction } from '../actions';
import { withOrgPrincipal } from '../../expenses/lib';

export const metadata = { title: 'Sales day — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  store?: string;
  error?: string;
}

export default async function SalesDayDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { id } = await params;
  const sp = await searchParams;

  const { actor } = await requireSession(`/sales-days/${id}`);
  const orgId = actor.orgId;

  const day = await withOrgPrincipal(orgId, (tx) => salesDaysRepo.getById(tx, orgId, id));
  if (!day) notFound();

  const [channels, stores, persons] = await Promise.all([
    withOrgPrincipal(orgId, (tx) => salesDaysRepo.getChannelsForDay(tx, day.id)),
    listStores(orgId),
    listActingPersons(orgId),
  ]);

  // Shown whenever an entry EXISTS, not only while verified — a void is a REVERSAL and both
  // entries stand, so hiding them on void would make the page contradict its own void copy.
  const entryId = day.journalEntryId;
  const { lines, reversalId, reversalLines } = entryId
    ? await withOrgPrincipal(orgId, async (tx) => {
        const original = await journalRepo.findLinesForEntryWithAccountCodes(tx, entryId);
        const reversal = await journalRepo.findReversalOfEntry(tx, orgId, entryId);
        return {
          lines: original,
          reversalId: reversal?.id ?? null,
          reversalLines: reversal ? await journalRepo.findLinesForEntryWithAccountCodes(tx, reversal.id) : [],
        };
      })
    : { lines: [], reversalId: null, reversalLines: [] };

  const personName = (pid: string | null) =>
    pid ? (persons.find((p) => p.id === pid)?.displayName ?? pid) : '—';
  const storeName = stores.find((s) => s.id === day.storeId)?.name ?? day.storeId;

  const carry = new URLSearchParams();
  if (sp.store) carry.set('store', sp.store);

  const discountsTotal =
    Number(day.seniorDiscount) + Number(day.pwdDiscount) + Number(day.otherDiscount);
  const nonRemitted = channels.filter((c) => !c.isRemittedDaily);
  const nonRemittedTotal = nonRemitted.reduce((a, c) => a + Number(c.amount), 0);

  // ⭐ Only the DOCUMENT is named here. Who is acting comes from the session (T-138) — this used
  // to carry an actingPersonId, which is what made the submit/verify segregation unenforceable.
  const hiddenIds = (
    <>
      <input type="hidden" name="storeId" value={sp.store ?? ''} />
      <input type="hidden" name="salesDayId" value={day.id} />
    </>
  );

  return (
    <main className="mx-auto max-w-5xl space-y-6 p-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <a
            href={`/sales-days?${carry.toString()}`}
            className="text-sm text-neutral-500 underline hover:no-underline dark:text-neutral-400"
          >
            ← All sales days
          </a>
          <h1 className="mt-1 text-2xl font-semibold">{day.businessDate}</h1>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            {storeName} · figures {day.posSourced ? 'pulled from POS' : 'entered by hand'}
          </p>
        </div>
        <div className="text-right">
          <StatusBadge status={day.status} />
          <p className="mt-2 text-2xl font-semibold tabular-nums">{formatMoney(money(day.totalSales))}</p>
        </div>
      </div>

      {sp.error && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          <strong className="font-medium">Refused:</strong> {sp.error}
        </div>
      )}

      {day.status !== 'verified' && day.status !== 'voided' && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
          ⚠️ <strong>This day recognises no revenue yet.</strong> Nothing is posted to the ledger
          until it is verified, and no newer day can be created for this store meanwhile.
        </div>
      )}

      <section className="grid gap-4 md:grid-cols-2">
        <Panel title="Revenue">
          <Row label="Unlimited → 4100" value={formatMoney(money(day.unliSales))} />
          <Row label="À la carte → 4150" value={formatMoney(money(day.alaCarteSales))} />
          <Row label="Total" value={formatMoney(money(day.totalSales))} strong />
        </Panel>

        <Panel title="Tender">
          <Row label="Cash → 1110" value={formatMoney(money(day.cashCollected))} />
          <Row label="Online → 1140" value={formatMoney(money(day.onlineCollected))} />
          {Number(day.creditSales) > 0 && (
            <Row label="Credit / on account" value={formatMoney(money(day.creditSales))} />
          )}
          {nonRemittedTotal > 0 && (
            <Row label="Non-remitted channels" value={formatMoney(money(String(nonRemittedTotal)))} />
          )}
          <Row label="Discounts → 4900" value={formatMoney(money(String(discountsTotal)))} />
          <Row label="Comps → 4950" value={formatMoney(money(day.comps))} />
          {Number(day.otherCharges) > 0 && (
            <Row label="Other charges → 4500" value={formatMoney(money(day.otherCharges))} />
          )}
          {/* ⭐ A float — neither revenue nor AP. Fills here, empties through payroll, and never
              reaches the P&L (bible row 135). */}
          {Number(day.serviceCharge) > 0 && (
            <Row label="Service charge → 2160 float (held for staff)" value={formatMoney(money(day.serviceCharge))} />
          )}
        </Panel>

        <Panel title="Discounts, itemised">
          {/* Separate because RR 5-2017 requires the breakout — statutory, not reporting taste. */}
          <Row label="Senior" value={formatMoney(money(day.seniorDiscount))} />
          <Row label="PWD" value={formatMoney(money(day.pwdDiscount))} />
          <Row label="Other" value={formatMoney(money(day.otherDiscount))} />
        </Panel>

        <Panel title="Trail">
          <Row label="Created by" value={personName(day.createdBy)} />
          <Row label="Submitted by" value={personName(day.submittedBy)} />
          <Row label="Verified by" value={personName(day.verifiedBy)} />
          {day.status === 'voided' && (
            <>
              <Row label="Voided by" value={personName(day.voidedBy)} />
              <Row label="Void reason" value={day.voidReason ?? '—'} />
            </>
          )}
        </Panel>
      </section>

      {channels.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-medium">Channels</h2>
          <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
            <table className="w-full min-w-[520px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                  <th className="px-3 py-2 font-medium">Channel</th>
                  <th className="px-3 py-2 font-medium">Remittance</th>
                  <th className="px-3 py-2 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {channels.map((c) => (
                  <tr key={c.id} className="border-b border-neutral-100 last:border-0 dark:border-neutral-900">
                    <td className="px-3 py-2">{c.channelName}</td>
                    <td className="px-3 py-2 text-xs text-neutral-500 dark:text-neutral-400">
                      {c.isRemittedDaily ? 'reaches the till' : `settles later → ${c.receivableAccountCode}`}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {/* ⭐ "confirmed no sales" is a different claim from a blank, and from a zero. */}
                      {c.noSales ? (
                        <span className="text-xs italic text-neutral-500 dark:text-neutral-400">
                          confirmed no sales
                        </span>
                      ) : (
                        formatMoney(money(c.amount))
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {entryId && (
        <section className="space-y-4">
          <div className="space-y-2">
            <h2 className="font-medium">
              Ledger entry{' '}
              <span className="font-mono text-xs text-neutral-500 dark:text-neutral-400">{entryId}</span>
            </h2>
            <LedgerTable lines={lines} />
          </div>
          {reversalId && (
            <div className="space-y-2">
              <h2 className="font-medium">
                Reversing entry{' '}
                <span className="font-mono text-xs text-neutral-500 dark:text-neutral-400">{reversalId}</span>
              </h2>
              <p className="text-sm text-neutral-600 dark:text-neutral-400">
                The void posted this. <strong>Both entries stand</strong> — the ledger records what
                happened and what undid it.
              </p>
              <LedgerTable lines={reversalLines} />
            </div>
          )}
        </section>
      )}

      <section className="grid gap-4 md:grid-cols-2">
        {day.status === 'open' && (
          <form action={submitSalesDayAction} className="space-y-3 rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
            {hiddenIds}
            <h2 className="font-medium">Submit</h2>
            <p className="text-neutral-600 dark:text-neutral-400">
              Hands the day on for checking. <strong>Still recognises nothing</strong> — submitting
              is not verifying.
            </p>
            <button type="submit" className="rounded border border-neutral-300 px-4 py-1.5 font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900">
              Submit
            </button>
          </form>
        )}

        {(day.status === 'open' || day.status === 'submitted') && (
          <form action={verifySalesDayAction} className="flex flex-col justify-between gap-3 rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
            {hiddenIds}
            <div>
              <h2 className="font-medium">Verify &amp; post</h2>
              <p className="mt-1 text-neutral-600 dark:text-neutral-400">
                <strong>This is what recognises the revenue.</strong> The entry dates on{' '}
                {day.businessDate}, not today. ⚠️ The person who submits should not be the one who
                verifies.
              </p>
            </div>
            <button type="submit" className="rounded bg-neutral-900 px-4 py-1.5 font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300">
              Verify &amp; post
            </button>
          </form>
        )}
      </section>

      {day.status === 'verified' && (
        <form action={voidSalesDayAction} className="space-y-3 rounded-lg border border-red-200 p-4 text-sm dark:border-red-900">
          {hiddenIds}
          <h2 className="font-medium text-red-800 dark:text-red-300">Void</h2>
          <p className="text-neutral-600 dark:text-neutral-400">
            A verified day is voided by <strong>reversing</strong> its entry — the original stays
            visible and both sides remain in the ledger. A reason is required.
          </p>
          <div className="flex gap-2">
            <input
              name="reason"
              required
              placeholder="Why is this being voided?"
              className="flex-1 rounded border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-950"
            />
            <button type="submit" className="rounded border border-red-300 px-4 py-1.5 font-medium text-red-800 hover:bg-red-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950">
              Void
            </button>
          </div>
        </form>
      )}
    </main>
  );
}

type EntryLine = Awaited<ReturnType<typeof journalRepo.findLinesForEntryWithAccountCodes>>[number];

function LedgerTable({ lines }: { lines: EntryLine[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
      <table className="w-full min-w-[560px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
            <th className="px-3 py-2 font-medium">#</th>
            <th className="px-3 py-2 font-medium">Account</th>
            <th className="px-3 py-2 font-medium">Party</th>
            <th className="px-3 py-2 text-right font-medium">Debit</th>
            <th className="px-3 py-2 text-right font-medium">Credit</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.lineNo} className="border-b border-neutral-100 last:border-0 dark:border-neutral-900">
              <td className="px-3 py-2 text-neutral-400">{l.lineNo}</td>
              <td className="px-3 py-2 font-mono">{l.accountCode}</td>
              <td className="px-3 py-2 text-xs text-neutral-500 dark:text-neutral-400">
                {l.partyType ? `${l.partyType}:${l.partyId}` : '—'}
              </td>
              {/* Blank, not ₱0.00 — compared numerically because Postgres returns "0.00". */}
              <td className="px-3 py-2 text-right tabular-nums">
                {Number(l.debit) === 0 ? '' : formatMoney(money(l.debit))}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {Number(l.credit) === 0 ? '' : formatMoney(money(l.credit))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
      <h2 className="mb-3 font-medium">{title}</h2>
      <dl className="space-y-1.5">{children}</dl>
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: React.ReactNode; strong?: boolean }) {
  return (
    <div className={`flex justify-between gap-4 ${strong ? 'border-t border-neutral-200 pt-1.5 font-medium dark:border-neutral-800' : ''}`}>
      <dt className="text-neutral-500 dark:text-neutral-400">{label}</dt>
      <dd className="text-right tabular-nums">{value}</dd>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === 'verified'
      ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
      : status === 'voided'
        ? 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300'
        : status === 'submitted'
          ? 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300'
          : 'bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300';
  const label = status.charAt(0).toUpperCase() + status.slice(1);
  return <span className={`rounded px-2 py-0.5 text-xs font-medium ${cls}`}>{label}</span>;
}

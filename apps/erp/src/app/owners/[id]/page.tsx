import Link from 'next/link';
import { notFound } from 'next/navigation';
import { compare, money, ZERO } from '@shareat/core/money';
import { requirePageAccess } from '../../../lib/page-access';
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
import { DetailLayout } from '@/components/shell/DetailLayout';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';
import { Button, FlashBanner, Input, Select } from '@/components/ui';
import { SettleHow } from './SettleHow';

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
  const sp = await withFlash(searchParams);
  const { actor, refusal } = await requirePageAccess(`/owners/${id}`);
  // ⭐ T-288 — the READ gate. Ian, 2026-09-12: "do both hide the menu and gate the reads."
  if (refusal) return refusal;

  const owner = await getDetail(actor.orgId, id);
  if (!owner) notFound();

  const [accounts, stores, persons] = await Promise.all([
    moneyAccounts(actor.orgId, owner.storeId),
    listStores(actor.orgId),
    listActivePersons(actor.orgId),
  ]);
  const store = stores.find((s) => s.id === owner.storeId);
  const who = persons.find((p) => p.id === owner.personId);
  // T-371 — decided on the (14,2) brand, not `Number(x) > 0`: the repo hands back a fixed two-place string, re-minted here.
  const owes = compare(money(owner.position.receivable), ZERO) > 0;

  return (
    <Page view="detail" density="table">
      <div>
        <Link href="/owners" className="text-sm underline underline-offset-2">
          ← Owners
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">{who?.displayName ?? 'Unknown owner'}</h1>
        <PageDescription>
          {owner.role ?? '—'} · {store?.name ?? '—'} ·{' '}
          {owner.drawingLimit
            ? `${peso(owner.drawingLimit)} ${owner.drawingLimitPeriod} limit`
            : 'no drawing limit'}{' '}
          · {TREATMENT_LABEL[owner.personalExpenseTreatment]}
        </PageDescription>
      </div>

      <FlashBanner flash={sp} />

      <DetailLayout
        summary={
          /* ── The position ───────────────────────────────────────────────────────────── */
          <section className="space-y-3">
            {/* ⚠️ `min-[1440px]:grid-cols-1`: `sm` is a VIEWPORT query, so without it these four
                tiles stay four-across inside a 320px rail. T-240 §3.5. */}
            <div className="grid gap-3 sm:grid-cols-4 min-[1440px]:grid-cols-1">
              <Figure label="Contributed" value={peso(owner.position.contributed)} />
              <Figure label="Drawn" value={peso(owner.position.drawn)} />
              <Figure label="Net equity" value={peso(owner.position.net)} emphasis />
              <Figure label="Still owes us" value={peso(owner.position.receivable)} />
            </div>
            <p className="text-xs text-neutral-500 dark:text-neutral-500">
              ⭐ <strong>Net</strong> is contributed minus drawn — arithmetic on the two figures
              beside it, never a stored third number.{' '}
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
        }
      >
      {/* ── Settle what is owed ──────────────────────────────────────────────────────── */}
      {owes && (
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
              <SettleHow />
              <Field label="Amount">
                <input
                  name="amount"
                  required
                  inputMode="decimal"
                  defaultValue={owner.position.receivable}
                  className={INPUT}
                />
              </Field>
              <Field label="Into (cash back only)">
                <Select name="intoMoneyAccountId" defaultValue="" className="w-full">
                  <option value="">—</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} — {peso(a.balance)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Because (write-off only)" hint="A write-off with no reason is indistinguishable from nobody collecting.">
                <Input name="reason" className="w-full" />
              </Field>
              <Field label="On">
                <Input name="on" type="date" required defaultValue={today()} className="w-full" />
              </Field>
            </div>
            <Button type="submit" variant="secondary">
              Settle
            </Button>
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
              <input name="amount" required inputMode="decimal" className={INPUT} />
            </Field>
            <Field label="Into">
              <Select name="intoMoneyAccountId" required defaultValue="" className="w-full">
                <option value="" disabled>
                  Choose…
                </option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} — {peso(a.balance)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="On">
              <Input name="on" type="date" required defaultValue={today()} className="w-full" />
            </Field>
            <Button type="submit" variant="secondary">
              Record contribution
            </Button>
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
              <input name="amount" required inputMode="decimal" className={INPUT} />
            </Field>
            <Field label="From">
              <Select name="fromMoneyAccountId" required defaultValue="" className="w-full">
                <option value="" disabled>
                  Choose…
                </option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} — {peso(a.balance)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="On">
              <Input name="on" type="date" required defaultValue={today()} className="w-full" />
            </Field>
            <Button type="submit" variant="primary">
              Record drawing
            </Button>
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
                <Input
                  disabled
                  value={owner.closableMonth.slice(0, 7)}
                  className={`w-full opacity-70`}
                />
              </Field>
              <Field
                label="Agreed amount"
                hint={`The ledger says ${peso(owner.closableAmount)}. Leave as-is to agree with it.`}
              >
                <input
                  name="acknowledgedAmount"
                  inputMode="decimal"
                  defaultValue={owner.closableAmount}
                  className={INPUT}
                />
              </Field>
              <Field label="Difference because" hint="Required only if your figure differs.">
                <Input name="adjustmentReason" className="w-full" />
              </Field>
              <Field label="On">
                <Input name="on" type="date" required defaultValue={today()} className="w-full" />
              </Field>
            </div>
            <Button type="submit" variant="secondary">
              Close {owner.closableMonth.slice(0, 7)}
            </Button>
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
      </DetailLayout>
    </Page>
  );
}

const INPUT =
  'w-full rounded-[10px] border border-field-border bg-field px-3 py-2 min-h-11 text-sm text-ink';

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

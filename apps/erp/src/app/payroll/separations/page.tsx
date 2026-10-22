import { FormDisclosure } from '@/components/forms/FormDisclosure';
import { requirePageAccess, StoreNotAvailable } from '../../../lib/page-access';
import { SEPARATION_CAUSES } from '@shareat/db/schema';
import { postSeparationAction, voidSeparationAction } from './actions';
import { cashAccountsFor, payrollStoresFor, peso, preview, separationsFor, worklistFor } from './lib';
import { Page } from '@/components/shell/Page';
import { CheckedForm } from '@/components/forms';
import { PAYROLL_SEPARATION_RULES, nativeAttrs } from '@shareat/domain/field-rules';
import { Badge, Banner, Button, ConfirmDestructive, Field, FlashBanner, FormGrid, Input, Select } from '@/components/ui';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';

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
  const sp = await withFlash(searchParams, { getKeys: ['separationDate'] });
  const { actor, refusal } = await requirePageAccess('/payroll/separations');
  // ⭐ T-288 — the READ gate. Ian, 2026-09-12: "do both hide the menu and gate the reads."
  if (refusal) return refusal;

  const stores = await payrollStoresFor(actor);
  if (stores.length === 0) return <StoreNotAvailable />;
  // T-435: a requested store the actor does not hold is one sentence — never a fallback to another store.
  if (sp.store && !stores.some((s) => s.id === sp.store)) return <StoreNotAvailable />;
  const storeId = sp.store || stores[0]?.id;
  if (!storeId) {
    return (
      <Page density="table" className="space-y-4">
        <h1 className="text-2xl font-semibold">Separations</h1>
        <PageDescription>No store is set up yet.</PageDescription>
      </Page>
    );
  }

  const [worklist, accounts, separations] = await Promise.all([
    worklistFor(actor, storeId),
    cashAccountsFor(actor, storeId),
    separationsFor(actor, storeId),
  ]);

  const selected = sp.employmentId ? worklist.find((w) => w.employmentId === sp.employmentId) : undefined;
  const separationDate = sp.separationDate || selected?.endedOn || '';
  const pvResult = selected && separationDate
    ? await preview(actor.orgId, actor, { storeId, employmentId: selected.employmentId, separationDate })
    : null;

  return (
    <Page density="table">
      <div>
        <h1 className="text-2xl font-semibold">Separations</h1>
        <PageDescription>
          Final pay&rsquo;s wages are just a regular pay run whose period ends on the last worked
          day — use <a href="/payroll" className="underline">/payroll</a> for that. This screen
          prices the pro-rated 13th month and gates the payout on clearance. ⚠️{' '}
          <b>Separation pay is a decision, not a calculation</b> — the amount below is never
          pre-filled from the cause; PH law owes it only for specific authorized causes, and this
          build does not guess which.
        </PageDescription>
      </div>

      <form method="get" className="flex flex-wrap items-end gap-3">
        <label className="flex min-w-0 flex-1 basis-48 flex-col gap-1">
          <span className={LABEL}>Store</span>
          <Select name="store" defaultValue={storeId} className="w-full">
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </label>
        <Button type="submit" variant="secondary">
          Switch
        </Button>
      </form>

      <FlashBanner flash={sp} />

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

          <form method="get" className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="store" value={storeId} />
            <input type="hidden" name="employmentId" value={selected.employmentId} />
            <label className="flex min-w-0 flex-1 basis-40 flex-col gap-1">
              <span className={LABEL}>Separation date</span>
              <Input name="separationDate" type="date" defaultValue={separationDate} className="w-full" />
            </label>
            <Button type="submit" variant="secondary">
              Preview
            </Button>
          </form>

          {pvResult?.error && <Banner tone="error">{pvResult.error}</Banner>}

          {pvResult?.preview && (
            <CheckedForm rules={PAYROLL_SEPARATION_RULES} action={postSeparationAction} className="space-y-3">
              <input type="hidden" name="storeId" value={storeId} />
              <input type="hidden" name="employmentId" value={selected.employmentId} />
              <input type="hidden" name="separationDate" value={separationDate} />

              <p className="text-xs text-neutral-500">
                Pro-rated 13th month: basic pay earned {peso(Number(pvResult.preview.thirteenthMonthBasicPayEarned))} →
                gross <b className="text-neutral-700 dark:text-neutral-300">{peso(Number(pvResult.preview.thirteenthMonthGross))}</b>.
                Outstanding advance: {peso(Number(pvResult.preview.outstandingAdvance))}.
              </p>

              <FormGrid>
                <Field label="Cause">
                  <Select name="cause" defaultValue="resignation" className="mt-1 w-full">
                    {SEPARATION_CAUSES.map((c) => (
                      <option key={c} value={c}>
                        {CAUSE_LABELS[c] ?? c}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Separation pay (₱)" hint="A decision, not a calculation — see above." rule={PAYROLL_SEPARATION_RULES.separationPayAmount}>
                  <Input {...nativeAttrs(PAYROLL_SEPARATION_RULES.separationPayAmount)} defaultValue="0" className="mt-1 w-full" />
                </Field>
                <Field label="Pay from">
                  <Select name="moneyAccountId" className="mt-1 w-full">
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              </FormGrid>

              <label className="flex items-start gap-2 rounded border border-neutral-200 px-3 py-2 dark:border-neutral-800">
                <input type="checkbox" name="clearanceConfirmed" className="mt-0.5" />
                <span>
                  <span className="block text-xs font-medium">Clearance confirmed</span>
                  <span className="block text-[11px] text-neutral-500">
                    No outstanding accountabilities. ⛔ Required — posting refuses without this.
                  </span>
                </span>
              </label>
              <Input name="clearanceNotes" placeholder="Clearance notes (optional)" className="w-full" />
              <Input name="notes" placeholder="Notes (optional)" className="w-full" />

              <ConfirmDestructive
                tier="admin-pin"
                label="Post separation"
                consequence="Pays out and ends this employment. An administrator must approve with their own PIN."
              />
            </CheckedForm>
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
                <Badge status={s.status} />
                {s.voidReason && <span className="text-xs text-neutral-500">voided — {s.voidReason}</span>}
              </div>
              <p className="text-xs text-neutral-600 dark:text-neutral-400">
                13th month {peso(Number(s.thirteenthMonthGross))} + separation pay {peso(Number(s.separationPayAmount))} −
                advance {peso(Number(s.advanceRecovered))} = net {peso(Number(s.netPay))}
              </p>
              {s.status === 'posted' && (
                <FormDisclosure><form action={voidSeparationAction} className="flex flex-wrap items-end gap-2">
                  <input type="hidden" name="storeId" value={storeId} />
                  <input type="hidden" name="id" value={s.id} />
                  <Input name="reason" placeholder="Why void it?" className="min-w-0 flex-1 basis-48" />
                  <ConfirmDestructive
                    tier="admin-pin"
                    label="Void separation"
                    consequence="Voids this separation and reverses its entries. An administrator must approve with their own PIN."
                  />
                </form></FormDisclosure>
              )}
            </div>
          ))
        )}
      </section>
    </Page>
  );
}

const LABEL = 'text-xs font-medium text-neutral-600 dark:text-neutral-400';

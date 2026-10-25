import { requireSession } from '../../lib/session';
import { createRequestAction } from './actions';
import {
  STATUS_LABEL,
  listActivePersons,
  listRegister,
  listStores,
  peso,
  today,
} from './lib';
import { CheckedForm, FieldCheck } from '@/components/forms';
import { CASH_REQUEST_CREATE_RULES, nativeAttrs, type FieldRule } from '@shareat/domain/field-rules';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { Badge, Button, FlashBanner, FormModal, Input, LinkRow, RowLink, Select, statusTone } from '@/components/ui';
import { withFlash } from '@/lib/flash';

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
  const sp = await withFlash(searchParams);
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
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold">Cash requests</h1>
          <PageDescription>
            Money handed to a person for an errand, spent, and reconciled. Every figure is summed from
            the ledger — <strong>a request closes when its float reaches zero</strong>, not when
            someone marks it done.
          </PageDescription>
        </div>
        <FormModal trigger="+ Ask for cash" title="Ask for cash" size="md"
          description="This records the ask. Nothing posts: a request that moved money would show a float in someone's hands before anyone handed it over.">
          <CheckedForm rules={CASH_REQUEST_CREATE_RULES} action={createRequestAction} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Store" rule={CASH_REQUEST_CREATE_RULES.storeId}>
                <Select id="store" {...nativeAttrs(CASH_REQUEST_CREATE_RULES.storeId)} defaultValue="" invalid={sp.field === 'store'} className="w-full">
                  <option value="" disabled>
                    Choose…
                  </option>
                  {stores.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field
                label="Who holds the money"
                hint="The person the float is charged to — a shortage lands on them by name."
                rule={CASH_REQUEST_CREATE_RULES.requestedFor}
              >
                <Select id="requested-for" {...nativeAttrs(CASH_REQUEST_CREATE_RULES.requestedFor)} defaultValue="" invalid={sp.field === 'requested-for'} className="w-full">
                  <option value="" disabled>
                    Choose…
                  </option>
                  {persons.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.displayName}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="What it is for" rule={CASH_REQUEST_CREATE_RULES.purpose}>
                <Input
                  {...nativeAttrs(CASH_REQUEST_CREATE_RULES.purpose)}
                  placeholder="Market run, permit fee…"
                  className="w-full"
                />
              </Field>
              <Field label="Amount" rule={CASH_REQUEST_CREATE_RULES.amount}>
                {/* raw <input>: t343-s5-5v-number-boxes.test.ts scans the source for this tag */}
                <input
                  {...nativeAttrs(CASH_REQUEST_CREATE_RULES.amount)}
                  className="w-full rounded-[10px] border border-field-border bg-field px-3 py-2 min-h-11 text-sm text-ink"
                />
              </Field>
              <Field label="Date" rule={CASH_REQUEST_CREATE_RULES.on}>
                <Input {...nativeAttrs(CASH_REQUEST_CREATE_RULES.on)} type="date" defaultValue={today()} className="w-full" />
              </Field>
              <Field label="Notes" hint="Optional.">
                <Input name="notes" className="w-full" />
              </Field>
            </div>
            <Button type="submit" variant="primary">
              Submit request
            </Button>
          </CheckedForm>
        </FormModal>
      </div>

      <FlashBanner flash={sp} fieldLabels={{ store: 'Store', 'requested-for': 'Who holds the money' }} />

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
                  <LinkRow
                    key={r.id}
                    className={`border-b border-neutral-100 last:border-0 dark:border-neutral-900 ${
                      dormant ? 'opacity-60' : ''
                    }`}
                  >
                    <td className="px-3 py-2">
                      <RowLink href={`/cash-requests/${r.id}`}>
                        {r.purpose}
                      </RowLink>
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
                    <td className="px-3 py-2">
                      <Badge tone={statusTone(r.status)} label={STATUS_LABEL[r.status] ?? r.status} />
                    </td>
                  </LinkRow>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">No cash requests yet.</p>
      )}
    </Page>
  );
}

function Field({ label, hint, rule, children }: { label: string; hint?: string; rule?: FieldRule; children: React.ReactNode }) {
  const body = (
    <>      <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">{label}</span>
      {children}
      {hint && <span className="text-xs text-neutral-500 dark:text-neutral-500">{hint}</span>}
    
    </>
  );
  // T-440: a ruled field keeps its label and puts the live helper line OUTSIDE it (never part of the accessible name).
  if (!rule) return <label className="flex flex-col gap-1">{body}</label>;
  return (
    <div>
      <label className="flex flex-col gap-1">{body}</label>
      <FieldCheck rule={rule} />
    </div>
  );
}

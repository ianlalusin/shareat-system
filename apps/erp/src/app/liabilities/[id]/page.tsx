import Link from 'next/link';
import { notFound } from 'next/navigation';
import { compare, money, ZERO } from '@shareat/core/money';
import { requirePageAccess } from '../../../lib/page-access';
import { chargeAction, payAction, retireAction, reverseAction } from '../actions';
import {
  CATEGORY_LABEL,
  SOURCE_LABEL,
  chargeableAccounts,
  getDetail,
  listStores,
  moneyAccounts,
  peso,
  today,
} from '../lib';
import { DetailLayout } from '@/components/shell/DetailLayout';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';
import { Button, ConfirmDestructive, FlashBanner, FormModal, Input, Select } from '@/components/ui';
import { CheckedForm, FieldCheck } from '@/components/forms';
import { LIABILITY_CHARGE_RULES, LIABILITY_PAY_RULES, nativeAttrs, type FieldRule } from '@shareat/domain/field-rules';

export const metadata = { title: 'Liability — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  error?: string;
  ok?: string;
}

export default async function LiabilityPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { id } = await params;
  const sp = await withFlash(searchParams);
  const { actor, refusal } = await requirePageAccess(`/liabilities/${id}`);
  // ⭐ T-288 — the READ gate. Ian, 2026-09-12: "do both hide the menu and gate the reads."
  if (refusal) return refusal;

  const liability = await getDetail(actor.orgId, id);
  if (!liability) notFound();

  const [accounts, targets, stores] = await Promise.all([
    moneyAccounts(actor.orgId, liability.storeId),
    chargeableAccounts(actor.orgId),
    listStores(actor.orgId),
  ]);
  const store = stores.find((s) => s.id === liability.storeId);
  // T-371 — the ledger's figure is re-minted and ordered in scaled bigint, never as a float.
  const owing = compare(money(liability.position.outstanding), ZERO);

  return (
    <Page view="detail" density="table">
      <div>
        <Link href="/liabilities" className="text-sm underline underline-offset-2">
          ← Liabilities
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">{liability.name}</h1>
        <PageDescription>
          {CATEGORY_LABEL[liability.category] ?? liability.category} · {store?.name ?? '—'} ·{' '}
          {liability.dueOn ? `due ${liability.dueOn}` : 'no due date'}
          {liability.overdue && (
            <span className="text-warning-ink"> · overdue</span>
          )}
        </PageDescription>
      </div>

      <FlashBanner flash={sp} />

      <DetailLayout
        summary={
          <section className="space-y-3">
            {/* ⚠️ `min-[1440px]:grid-cols-1`: `sm` is a VIEWPORT query, so without it these tiles
                stay three-across inside a 320px rail. T-240 §3.5. */}
            <div className="grid gap-3 sm:grid-cols-3 min-[1440px]:grid-cols-1">
              <Figure label="Charged" value={peso(liability.position.charged)} />
              <Figure label="Paid" value={peso(liability.position.paid)} />
              <Figure label="Outstanding" value={peso(liability.position.outstanding)} emphasis />
            </div>
            <p className="text-xs text-neutral-500 dark:text-neutral-500">
              ⭐ <strong>Outstanding</strong> is what the ledger still shows owed on this
              obligation. Charged and paid are the same balance split by what happened — which is
              why they cannot disagree with it, and why nothing here is stored.
              {owing <= 0 && liability.position.charged !== '0.00' && (
                <> It has reached <strong>zero</strong>, so this is settled.</>
              )}
            </p>
          </section>
        }
      >
      <div className="grid gap-4 sm:grid-cols-2">
        <section className="space-y-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <div>
            <h2 className="font-medium">Charge it</h2>
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              The obligation is incurred. ⚠️ Name what it was <strong>for</strong> — an expense, or
              an asset. Charging it to another liability would move a debt without settling it.
            </p>
          </div>
          <FormModal trigger="Charge it" title="Charge this obligation" size="md">
            <CheckedForm rules={LIABILITY_CHARGE_RULES} action={chargeAction} className="space-y-3">
              <input type="hidden" name="liabilityId" value={liability.id} />
              <Field label="Amount" rule={LIABILITY_CHARGE_RULES.amount}>
                <input {...nativeAttrs(LIABILITY_CHARGE_RULES.amount)} name="amount" inputMode="decimal" className={INPUT} />
              </Field>
              <Field
                label="For"
                rule={
                  // Written across lines on purpose: t406 reads a one-line `{…AccountCode}` as a chart code printed on screen, and this is a rule reference.
                  LIABILITY_CHARGE_RULES.againstAccountCode
                }
              >
                <Select {...nativeAttrs(LIABILITY_CHARGE_RULES.againstAccountCode)} defaultValue="" className="w-full">
                  <option value="" disabled>
                    Choose…
                  </option>
                  {targets.map((a) => (
                    <option key={a.code} value={a.code}>
                      {a.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="On" rule={LIABILITY_CHARGE_RULES.on}>
                <Input type="date" {...nativeAttrs(LIABILITY_CHARGE_RULES.on)} defaultValue={today()} className="w-full" />
              </Field>
              <Button type="submit" variant="secondary">
                Charge
              </Button>
            </CheckedForm>
          </FormModal>
        </section>

        <section className="space-y-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <div>
            <h2 className="font-medium">Pay it</h2>
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              {owing > 0 ? (
                <>
                  <strong>{peso(liability.position.outstanding)}</strong> is owed. Paying more than
                  that is refused — it would turn a debt into a receivable.
                </>
              ) : (
                'Nothing is owed on this obligation.'
              )}
            </p>
          </div>
          {owing > 0 && (
            <FormModal trigger="Pay it" title="Pay this obligation" size="md">
              <CheckedForm rules={LIABILITY_PAY_RULES} action={payAction} className="space-y-3">
                <input type="hidden" name="liabilityId" value={liability.id} />
                <Field label="Amount" rule={LIABILITY_PAY_RULES.amount}>
                  <input
                    {...nativeAttrs(LIABILITY_PAY_RULES.amount)}
                    name="amount"
                    inputMode="decimal"
                    defaultValue={liability.position.outstanding}
                    className={INPUT}
                  />
                </Field>
                <Field label="From" hint="Balances shown are derived from the ledger." rule={LIABILITY_PAY_RULES.fromMoneyAccountId}>
                  <Select {...nativeAttrs(LIABILITY_PAY_RULES.fromMoneyAccountId)} defaultValue="" className="w-full">
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
                <Field label="On" rule={LIABILITY_PAY_RULES.on}>
                  <Input type="date" {...nativeAttrs(LIABILITY_PAY_RULES.on)} defaultValue={today()} className="w-full" />
                </Field>
                <Button type="submit" variant="primary">
                  Pay
                </Button>
              </CheckedForm>
            </FormModal>
          )}
        </section>
      </div>

      {/* ── The trail ────────────────────────────────────────────────────────────────── */}
      <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="font-medium">Movements</h2>
        {liability.entries.length > 0 ? (
          <div className="overflow-x-auto rounded border border-neutral-200 dark:border-neutral-800">
            <table className="w-full min-w-[680px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                  <th className="px-3 py-2 font-medium">Date</th>
                  <th className="px-3 py-2 font-medium">What</th>
                  <th className="px-3 py-2 text-right font-medium">Charged</th>
                  <th className="px-3 py-2 text-right font-medium">Paid</th>
                  <th className="px-3 py-2 font-medium">Reverse</th>
                </tr>
              </thead>
              <tbody>
                {liability.entries.map((e) => (
                  <tr
                    key={e.entryId}
                    className="border-b border-neutral-100 last:border-0 dark:border-neutral-900"
                  >
                    <td className="px-3 py-2 font-mono text-xs">{e.entryDate}</td>
                    <td className="px-3 py-2">
                      {SOURCE_LABEL[e.sourceType] ?? e.sourceType}
                      {e.memo && (
                        <div className="text-xs text-neutral-400 dark:text-neutral-600">
                          {e.memo}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {e.charged === '0.00' ? '—' : peso(e.charged)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {e.paid === '0.00' ? '—' : peso(e.paid)}
                    </td>
                    <td className="px-3 py-2">
                      <form action={reverseAction} className="flex items-center gap-2">
                        <input type="hidden" name="liabilityId" value={liability.id} />
                        <input type="hidden" name="entryId" value={e.entryId} />
                        <Input name="reason" placeholder="Reason…" className="w-32" />
                        <ConfirmDestructive
                          tier="admin-pin"
                          label="Reverse liability entry"
                          consequence="Reverses this entry; both stay on the ledger. An administrator must approve with their own PIN."
                        />
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            Nothing charged yet — this obligation exists but owes nothing.
          </p>
        )}
        <p className="text-xs text-neutral-500 dark:text-neutral-500">
          ⚠️ A reversal writes the opposite entry; both stay here and net to nothing. Nothing is ever
          deleted, so this list always adds up to the balance above it.
        </p>
      </section>

      {/* ── Retire ───────────────────────────────────────────────────────────────────── */}
      {owing <= 0 && !liability.retiredAt && (
        <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <div>
            <h2 className="font-medium">Retire</h2>
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              Stop using this obligation. ⚠️ Retiring is not settling — it says nobody expects to
              charge it again. It stays on the ledger and its history is untouched.
            </p>
          </div>
          <form action={retireAction}>
            <input type="hidden" name="liabilityId" value={liability.id} />
            <ConfirmDestructive tier="retype" label="Retire" consequence="Retires this obligation. It stays on the ledger and its history is untouched." expectedName={liability.name} />
          </form>
        </section>
      )}
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
  rule,
  children,
}: {
  label: React.ReactNode;
  hint?: string;
  rule?: FieldRule;
  children: React.ReactNode;
}) {
  const body = (
    <>
      <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">{label}</span>
      {children}
      {hint && <span className="text-xs text-neutral-500 dark:text-neutral-500">{hint}</span>}
    </>
  );
  // T-440: a ruled field puts its live helper line OUTSIDE the label, so the line never joins the accessible name.
  if (!rule) return <label className="flex flex-col gap-1">{body}</label>;
  return (
    <div>
      <label className="flex flex-col gap-1">{body}</label>
      <FieldCheck rule={rule} />
    </div>
  );
}

import Link from 'next/link';
import { toBusinessDate } from '@shareat/core/datetime';
import { compare, formatMoney, money, ZERO } from '@shareat/core/money';
import { PAYROLL_STATUTORY_PAYMENT_RULES, nativeAttrs } from '@shareat/domain/field-rules';
import { requirePageAccess } from '../../../../lib/page-access';
import { closedMonths } from '../../../../lib/period-override';
import { canOverrideClosedMonth } from '../../../expenses/reimbursements/lib';
import { recordStatutoryPaymentAction } from '../actions';
import { STATUTORY_PAYMENT_RECORD } from '../typed-forms';
import { typedFor } from '@/lib/keep-typing';
import { AGENCIES, agencyLabel, isAgency, monthWords, monthsFor, payFromAccountsFor, storeNamesFor, type StatutoryAgency } from '../lib';
import { ClosedMonthOverride } from '@/components/ClosedMonthOverride';
import { CheckedForm } from '@/components/forms';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';
import { ACTION_LINK } from '@/components/action-link';
import { Button, Field, FlashBanner, FormGrid, FormSection, Input, Select } from '@/components/ui';

export const metadata = { title: 'Record a government payment — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  agency?: string;
  month?: string;
  period?: string;
  ok?: string;
  error?: string;
}

const LABEL = 'text-xs font-medium text-neutral-600 dark:text-neutral-400';

/** '2026-10-01', '2026-10' (the flash's `period`) -> '2026-10-01'; anything else -> undefined. */
function asMonth(raw: string | undefined): string | undefined {
  const m = /^(\d{4}-\d{2})(-01)?$/.exec(raw ?? '');
  return m ? `${m[1]}-01` : undefined;
}

/**
 * `/payroll/statutory-payments/new`. T-193 S5.
 *
 * One payment to one agency for one month, across as many stores as the receipt covers. Every store with something outstanding is a
 * line, filled with what it still owes; lower a line to pay part, or clear it to leave that store out. The form's own id is minted
 * here, on the server, once per render: a double click or a back button re-sends the SAME id, which records one payment, not two.
 */
export default async function NewStatutoryPaymentPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await withFlash(searchParams);
  const { actor, refusal } = await requirePageAccess('/payroll/statutory-payments/new');
  if (refusal) return refusal;

  const agency: StatutoryAgency = isAgency(sp.agency) ? sp.agency : 'sss';
  const [totals, accounts, storeNames, canOverride, closed] = await Promise.all([
    monthsFor(actor, { agency }),
    payFromAccountsFor(actor),
    storeNamesFor(actor),
    canOverrideClosedMonth(actor),
    closedMonths(actor.orgId),
  ]);

  const owing = totals.filter((t) => compare(money(t.outstanding), ZERO) > 0);
  const months = [...new Set(owing.map((t) => t.month))].sort();
  const wanted = asMonth(sp.month) ?? asMonth(sp.period);
  const month = wanted ?? months[0];
  const lines = month ? owing.filter((t) => t.month === month).sort((a, b) => (storeNames.get(a.storeId) ?? '').localeCompare(storeNames.get(b.storeId) ?? '')) : [];

  // One id per render. Never reused, never taken from the address.
  const paymentId = crypto.randomUUID();
  const today = toBusinessDate();

  // A refused save reopens with what was typed (T-389): the slot is bound to this person and lives a minute in the signed cookie.
  const typed = typedFor(sp, STATUTORY_PAYMENT_RECORD, '', actor.personId);
  const kept = (name: string): string | undefined => {
    const v = typed?.kind === 'typed' ? typed.fields[name] : undefined;
    return Array.isArray(v) ? v[0] : v;
  };
  const keptList = (name: string): string[] => {
    const v = typed?.kind === 'typed' ? typed.fields[name] : undefined;
    return v === undefined ? [] : Array.isArray(v) ? v : [v];
  };
  const keptAmounts = new Map(keptList('lineStoreId').map((id, i) => [id, keptList('lineAmount')[i]] as const));

  return (
    <Page density="table" className="space-y-6">
      <div>
        <Link href="/payroll/statutory-payments" className={ACTION_LINK}>
          ← All government payments
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">Record a government payment</h1>
        <PageDescription>
          Use this after the payment has been made at the agency or the bank. It records the agency&rsquo;s receipt number, takes the money
          out of the account you paid from, and clears what payroll owed. It does not send any money.
        </PageDescription>
      </div>

      <FlashBanner flash={sp} />

      <form method="get" className="flex flex-wrap items-end gap-3">
        <label className="flex min-w-0 flex-1 basis-40 flex-col gap-1">
          <span className={LABEL}>Agency</span>
          <Select name="agency" defaultValue={agency} className="w-full">
            {AGENCIES.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex min-w-0 flex-1 basis-48 flex-col gap-1">
          <span className={LABEL}>Month</span>
          <Select name="month" defaultValue={month ?? ''} className="w-full">
            {months.length === 0 && <option value="">Nothing outstanding</option>}
            {months.map((m) => (
              <option key={m} value={m}>
                {monthWords(m)}
              </option>
            ))}
          </Select>
        </label>
        <Button type="submit" variant="secondary">
          Show stores
        </Button>
      </form>

      {month && lines.length > 0 ? (
        <CheckedForm rules={PAYROLL_STATUTORY_PAYMENT_RULES} action={recordStatutoryPaymentAction} className="space-y-6">
          <input type="hidden" name="paymentId" value={paymentId} />
          <input type="hidden" name="agency" value={agency} />
          <input type="hidden" name="month" value={month} />

          <FormSection title={`${agencyLabel(agency)} for ${monthWords(month)}`}>
            <FormGrid layout="fields">
              <Field label="Paid on" rule={PAYROLL_STATUTORY_PAYMENT_RULES.paidOn}>
                <Input {...nativeAttrs(PAYROLL_STATUTORY_PAYMENT_RULES.paidOn)} defaultValue={kept('paidOn') ?? today} className="w-full" />
              </Field>
              <Field label="Paid from" hint="The account the money left. A staff cash float cannot be used.">
                <Select name="moneyAccountId" defaultValue={kept('moneyAccountId') ?? ''} className="w-full">
                  <option value="" disabled>
                    Choose an account…
                  </option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.storeName ? `${a.storeName} — ${a.name}` : a.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Agency receipt number" hint="The payment reference on the agency's receipt. Each receipt can be recorded once." rule={PAYROLL_STATUTORY_PAYMENT_RULES.referenceNo}>
                <Input {...nativeAttrs(PAYROLL_STATUTORY_PAYMENT_RULES.referenceNo)} defaultValue={kept('referenceNo')} className="w-full" />
              </Field>
              <Field label="Penalty or surcharge" hint="Only if the agency charged one for paying late. It is an expense, not part of what payroll owed." rule={PAYROLL_STATUTORY_PAYMENT_RULES.penalty}>
                <Input {...nativeAttrs(PAYROLL_STATUTORY_PAYMENT_RULES.penalty)} defaultValue={kept('penalty')} placeholder="0.00" className="w-full" />
              </Field>
              <Field label="Notes" span="wide" rule={PAYROLL_STATUTORY_PAYMENT_RULES.notes}>
                <Input {...nativeAttrs(PAYROLL_STATUTORY_PAYMENT_RULES.notes)} defaultValue={kept('notes')} className="w-full" />
              </Field>
            </FormGrid>
          </FormSection>

          <FormSection title="Amount for each store">
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              Each store is filled with what it still owes. Lower an amount to pay part of it, or clear it to leave that store out.
            </p>
            <ul className="space-y-3">
              {lines.map((l) => {
                const name = storeNames.get(l.storeId) ?? 'A store';
                return (
                  <li key={l.storeId} className="grid items-end gap-2 sm:grid-cols-[minmax(0,1fr)_12rem]">
                    <div>
                      <p className="text-sm font-medium">{name}</p>
                      <p className="text-xs text-neutral-500 dark:text-neutral-400">Still owes {formatMoney(money(l.outstanding))}</p>
                    </div>
                    <div>
                      <input type="hidden" name="lineStoreId" value={l.storeId} />
                      <Input name="lineAmount" defaultValue={keptAmounts.get(l.storeId) ?? l.outstanding} aria-label={`Amount paid for ${name}`} className="w-full" />
                    </div>
                  </li>
                );
              })}
            </ul>
          </FormSection>

          {canOverride && <ClosedMonthOverride
              closedMonths={closed}
              dateFieldName="paidOn"
              initialDate={kept('paidOn') ?? today}
              defaults={{ confirm: kept('periodOverrideConfirm') === 'on', ...(kept('periodOverrideReason') ? { reason: kept('periodOverrideReason')! } : {}), ...(kept('periodOverrideNote') ? { note: kept('periodOverrideNote')! } : {}) }}
            />}

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" variant="primary">
              Record payment
            </Button>
            <Link href="/payroll/statutory-payments" className={ACTION_LINK}>
              Cancel
            </Link>
          </div>
        </CheckedForm>
      ) : (
        <p className="rounded-lg border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700">
          Nothing is outstanding to {agencyLabel(agency)}{month ? ` for ${monthWords(month)}` : ''}. Choose another agency or month.
        </p>
      )}
    </Page>
  );
}

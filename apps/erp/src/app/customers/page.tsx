import { CUSTOMER_ADD_RULES, CUSTOMER_RECONCILE_RULES, nativeAttrs, type FieldRule } from '@shareat/domain/field-rules';
import { CheckedForm, FieldCheck } from '@/components/forms';
import Link from 'next/link';
import { CUSTOMER_GROUPS } from '@shareat/db/schema';
import { requirePageAccess, StoreNotAvailable } from '../../lib/page-access';
import { createCustomerAction, reconcileCustomerAction } from './actions';
import {
  GROUP_LABEL,
  TREATMENT_LABEL,
  TREATMENT_TONE,
  listLists,
  listRegister,
  arStoresFor,
  otherOrgs,
  peso,
  today,
} from './lib';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';
import { Button, FlashBanner, Input, LinkRow, RowAction, RowLink, Select, FormGrid, FormSection, type FieldProps } from '@/components/ui';

export const metadata = { title: 'Customers — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  error?: string;
  ok?: string;
}

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await withFlash(searchParams);
  // T-435 / bible row 353 - the READ gate: `record_ar_collection`; the register shows the viewer's own stores' customers only.
  const { actor, refusal } = await requirePageAccess('/customers');
  if (refusal) return refusal;
  const stores = await arStoresFor(actor);
  if (stores.length === 0) return <StoreNotAvailable />;

  const [customers, orgs, priceLists] = await Promise.all([
    listRegister(actor),
    otherOrgs(actor.orgId),
    listLists(actor.orgId),
  ]);
  const storeById = new Map(stores.map((s) => [s.id, s]));
  const orgById = new Map(orgs.map((o) => [o.id, o]));
  const listById = new Map(priceLists.map((l) => [l.id, l]));

  return (
    <Page density="table">
      <div>
        <h1 className="text-2xl font-semibold">Customers</h1>
        <PageDescription>
          Who the business sells to <strong>on terms</strong>. ⛔ A diner who pays at the counter is
          not a customer — a row here exists because there is a balance or a credit relationship,
          and a retail sale creates neither.{' '}
          <Link href="/customers/price-lists" className="underline underline-offset-2">
            Price lists
          </Link>
          .
        </PageDescription>
      </div>

      <FlashBanner flash={sp} />

      {customers.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
          <table className="w-full min-w-[900px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                <th className="px-3 py-2 font-medium">Customer</th>
                <th className="px-3 py-2 font-medium">Treatment</th>
                <th className="px-3 py-2 font-medium">Price list</th>
                <th className="px-3 py-2 text-right font-medium">Owes</th>
                <th className="px-3 py-2 font-medium">Verified at zero</th>
              </tr>
            </thead>
            <tbody>
              {customers.map((c) => (
                <LinkRow
                  key={c.id}
                  className={`border-b border-neutral-100 last:border-0 dark:border-neutral-900 ${
                    c.status === 'active' ? '' : 'opacity-60'
                  }`}
                >
                  <td className="px-3 py-2">
                    {/* ⭐ T-226 — the register listed a balance and led nowhere, so `1210` could be
                        raised and never cleared (DEF-190). This link is the whole entry point. */}
                    <RowLink href={`/customers/${c.id}`} className="hover:no-underline">
                      {c.name}
                    </RowLink>
                    <div className="text-xs text-neutral-400 dark:text-neutral-600">
                      {GROUP_LABEL[c.customerGroup] ?? c.customerGroup}
                      {c.contactNo && ` · ${c.contactNo}`}
                    </div>
                  </td>
                  <td className={`px-3 py-2 text-xs ${TREATMENT_TONE[c.treatment] ?? ''}`}>
                    {TREATMENT_LABEL[c.treatment]}
                    {/* ⭐ Show WHICH counterparty, because "internal" without a name is unverifiable. */}
                    {c.counterpartyStoreId && (
                      <div className="text-neutral-400 dark:text-neutral-600">
                        {storeById.get(c.counterpartyStoreId)?.name ?? '—'}
                      </div>
                    )}
                    {c.counterpartyOrgId && (
                      <div className="text-neutral-400 dark:text-neutral-600">
                        {orgById.get(c.counterpartyOrgId)?.name ?? '—'}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {c.priceListId ? (listById.get(c.priceListId)?.name ?? '—') : '—'}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">{peso(c.balance)}</td>
                  <td className="px-3 py-2 text-xs">
                    {c.reconciledAsOf ? (
                      c.reconciledAsOf
                    ) : (
                      <RowAction>
                        <CheckedForm rules={CUSTOMER_RECONCILE_RULES} action={reconcileCustomerAction} className="flex items-center gap-1">
                          <input type="hidden" name="customerId" value={c.id} />
                          <Field label={<span className="sr-only">Date verified at zero</span>} rule={CUSTOMER_RECONCILE_RULES.asOf}>
                            <Input type="date" {...nativeAttrs(CUSTOMER_RECONCILE_RULES.asOf)} defaultValue={today()} />
                          </Field>
                          <button
                            type="submit"
                            className="rounded border border-neutral-300 px-2 py-0.5 text-xs dark:border-neutral-700"
                          >
                            Anchor
                          </button>
                        </CheckedForm>
                      </RowAction>
                    )}
                  </td>
                </LinkRow>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">No customers recorded.</p>
      )}

      <p className="text-xs text-neutral-500 dark:text-neutral-500">
        ⚠️ <strong>Verified at zero</strong> is an anchor, not a balance: it records that somebody
        confirmed this customer owed nothing on that date, so an aging report can start there
        without migrating history. It does not change when the ledger does — which is what makes a
        later disagreement visible.
      </p>

      {/* ── Add one ──────────────────────────────────────────────────────────────────── */}
      <section className="space-y-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <div>
          <h2 className="font-medium">Record a customer</h2>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            ⭐ The <strong>counterparty</strong> decides how sales to them are treated, and the two
            answers are not close: one of our own stores <em>eliminates</em> and is never revenue;
            another company is <em>real revenue and a real receivable</em>.
          </p>
        </div>

        <CheckedForm rules={CUSTOMER_ADD_RULES} action={createCustomerAction} className="space-y-4">
          <FormSection title="Customer identity">
            <FormGrid layout="fields">
              <Field rule={CUSTOMER_ADD_RULES.name} width="name" label="Name">
                <Input {...nativeAttrs(CUSTOMER_ADD_RULES.name)}   placeholder="Resto Bulacan" className="w-full" />
              </Field>
              <Field
                label="Counterparty"
                hint="Leave as “External” for an ordinary wholesale buyer. A customer has at most one."
              >
                {/* ⭐ ONE picker, not two. Two independent dropdowns would let someone fill both, and
                  the whole design rests on a customer having at most one counterparty. */}
                <Select name="counterparty" defaultValue="" className="w-full">
                  <option value="">External — an outside buyer</option>
                  {stores.length > 0 && (
                    <optgroup label="One of our own stores — eliminates">
                      {stores.map((s) => (
                        <option key={s.id} value={`store:${s.id}`}>
                          {s.name}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {orgs.length > 0 && (
                    <optgroup label="Another company — real revenue">
                      {orgs.map((o) => (
                        <option key={o.id} value={`org:${o.id}`}>
                          {o.name}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </Select>
              </Field>
            </FormGrid>
          </FormSection>
          <FormSection title="Pricing defaults">
            <FormGrid layout="fields">
              <Field width="code"
                label="Group"
                hint="Reporting and defaults only — it never decides how a sale is treated."
              >
                <Select name="customerGroup" defaultValue="wholesale" className="w-full">
                  {CUSTOMER_GROUPS.map((g) => (
                    <option key={g} value={g}>
                      {GROUP_LABEL[g] ?? g}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Price list" hint="Optional — without one, nothing has a rate for them.">
                <Select name="priceListId" defaultValue="" className="w-full">
                  <option value="">—</option>
                  {priceLists.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </FormGrid>
          </FormSection>
          <FormSection title="Contact details">
            <FormGrid layout="fields">
              <Field width="code" label="Contact" hint="Optional.">
                <Input name="contactNo" className="w-full" />
              </Field>
              <Field width="long" label="Address" hint="Optional.">
                <Input name="address" className="w-full" />
              </Field>
            </FormGrid>
          </FormSection>
          <Button type="submit" variant="primary">
            Save
          </Button>
        </CheckedForm>
      </section>
    </Page>
  );
}

function Field({ width, label, hint, rule, children }: FieldProps) {
  const body = <><span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">{label}</span>{children}{hint && <span className="text-xs text-neutral-500 dark:text-neutral-500">{hint}</span>}</>;
  const sizing = width ? ` erp-field-${width}` : '';
  if (!rule) return <label className={`flex min-w-0 flex-col gap-1${sizing}`}>{body}</label>;
  return <div className={`min-w-0${sizing}`}><label className="flex min-w-0 flex-col gap-1">{body}</label><FieldCheck rule={rule} /></div>;
}

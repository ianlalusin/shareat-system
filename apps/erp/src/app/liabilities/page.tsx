import Link from 'next/link';
import { LIABILITY_ADD_RULES, nativeAttrs } from '@shareat/domain/field-rules';
import { CheckedForm } from '@/components/forms';
import { add, compare, money, ZERO } from '@shareat/core/money';
import { LIABILITY_CATEGORIES } from '@shareat/db/schema';
import { requirePageAccess } from '../../lib/page-access';
import { createLiabilityAction } from './actions';
import { CATEGORY_LABEL, listRegister, listStores, peso, today } from './lib';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';
import { ACTION_LINK } from '@/components/action-link';
import { Banner, Button, Field, FlashBanner, FormGrid, FormModal, FormSection, Input, LinkRow, RowLink, Select } from '@/components/ui';

export const metadata = { title: 'Liabilities — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  error?: string;
}

export default async function LiabilitiesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await withFlash(searchParams);
  const { actor, refusal } = await requirePageAccess('/liabilities');
  // ⭐ T-288 — the READ gate. Ian, 2026-09-12: "do both hide the menu and gate the reads."
  if (refusal) return refusal;

  const [stores, rows] = await Promise.all([listStores(actor.orgId), listRegister(actor.orgId)]);
  const storeById = new Map(stores.map((s) => [s.id, s]));

  // ⭐ Overdue first. v1 has no due date at all, so it can show what is owed and never what is late
  // — the question people open this screen to ask.
  const overdue = rows.filter((r) => r.overdue);
  const owed = add(ZERO, ...rows.map((r) => money(r.position.outstanding)));

  return (
    <Page density="table">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold">Liabilities</h1>
          <PageDescription>
            What the business owes that nothing else already tracks. Supplier invoices, loans, wages
            and statutory contributions each have their own home —{' '}
            <strong>this is the residual</strong>, and naming it precisely is what stops it becoming a
            dumping ground.
          </PageDescription>
          <Link href="/liabilities/unpaid" className={ACTION_LINK}>
            Everything unpaid
          </Link>
        </div>
        {/* T-448: the add form is a modal opened from the header. */}
        <FormModal
          trigger="+ Record obligation"
          title="Record an obligation"
          description="This records what it is. Nothing is owed until it is charged, the same separation as a loan that has not been drawn."
          size="md"
        >
          <CheckedForm rules={LIABILITY_ADD_RULES} action={createLiabilityAction} className="space-y-4">
            <FormSection title="Obligation">
              <FormGrid layout="fields">
                <Field label="Store" width="name" rule={LIABILITY_ADD_RULES.storeId}>
                  <Select {...nativeAttrs(LIABILITY_ADD_RULES.storeId)} defaultValue="" className="w-full">
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
                <Field label="What it is" width="name" rule={LIABILITY_ADD_RULES.name}>
                  <Input {...nativeAttrs(LIABILITY_ADD_RULES.name)} placeholder="Accrued rent — January" className="w-full" />
                </Field>
                <Field label="Category" width="code">
                  <Select name="category" defaultValue="other" className="w-full">
                    {LIABILITY_CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {CATEGORY_LABEL[c] ?? c}
                      </option>
                    ))}
                  </Select>
                </Field>
              </FormGrid>
            </FormSection>
            <FormSection title="Due date and details">
              <FormGrid layout="fields">
                <Field
                  label="Due"
                  width="date"
                  rule={LIABILITY_ADD_RULES.dueOn}
                  hint="Optional — but an obligation with no due date can never be reported late."
                >
                  <Input {...nativeAttrs(LIABILITY_ADD_RULES.dueOn)} type="date" defaultValue={today()} className="w-full" />
                </Field>
                <Field label="Description" width="name" hint="Optional.">
                  <Input name="description" className="w-full" />
                </Field>
                <Field label="Notes" width="name" hint="Optional.">
                  <Input name="notes" className="w-full" />
                </Field>
              </FormGrid>
            </FormSection>
            <Button type="submit" variant="primary">
              Record obligation
            </Button>
          </CheckedForm>
        </FormModal>
      </div>

      <FlashBanner flash={sp} />

      {overdue.length > 0 && (
        <Banner tone="warning">
          <h2 className="font-medium">
            {overdue.length === 1 ? 'One obligation is' : `${overdue.length} obligations are`} past
            due
          </h2>
          <ul className="space-y-1">
            {overdue.map((r) => (
              <li key={r.id}>
                <Link href={`/liabilities/${r.id}`} className="text-sm underline underline-offset-2">
                  {r.name}
                </Link>{' '}
                — <span className="font-mono tabular-nums">{peso(r.position.outstanding)}</span>, due{' '}
                {r.dueOn}
              </li>
            ))}
          </ul>
        </Banner>
      )}

      {rows.length > 0 && (
        <div className="rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
          <span className="text-neutral-600 dark:text-neutral-400">Still owed, across all</span>{' '}
          <span className="font-mono font-medium tabular-nums">{peso(owed)}</span>
        </div>
      )}

      {rows.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
          <table className="w-full min-w-[820px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                <th className="px-3 py-2 font-medium">Obligation</th>
                <th className="px-3 py-2 font-medium">Store</th>
                <th className="px-3 py-2 font-medium">Due</th>
                <th className="px-3 py-2 text-right font-medium">Charged</th>
                <th className="px-3 py-2 text-right font-medium">Paid</th>
                <th className="px-3 py-2 text-right font-medium">Outstanding</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <LinkRow
                  key={r.id}
                  className={`border-b border-neutral-100 last:border-0 dark:border-neutral-900 ${
                    compare(money(r.position.outstanding), ZERO) > 0 ? '' : 'opacity-60'
                  }`}
                >
                  <td className="px-3 py-2">
                    <RowLink href={`/liabilities/${r.id}`}>
                      {r.name}
                    </RowLink>
                    <div className="text-xs text-neutral-400 dark:text-neutral-600">
                      {CATEGORY_LABEL[r.category] ?? r.category}
                    </div>
                  </td>
                  <td className="px-3 py-2">{storeById.get(r.storeId)?.code ?? '—'}</td>
                  <td
                    className={`px-3 py-2 text-xs whitespace-nowrap ${
                      r.overdue ? 'text-warning-ink' : ''
                    }`}
                  >
                    {r.dueOn ?? '—'}
                    {r.overdue && ' · overdue'}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">
                    {peso(r.position.charged)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">
                    {peso(r.position.paid)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">
                    {peso(r.position.outstanding)}
                  </td>
                </LinkRow>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">No obligations recorded.</p>
      )}
    </Page>
  );
}

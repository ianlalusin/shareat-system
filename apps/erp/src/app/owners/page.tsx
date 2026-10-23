import { OWNERS_CREATE_RULES, nativeAttrs } from '@shareat/domain/field-rules';
import { CheckedForm } from '@/components/forms';
import Link from 'next/link';
import { requirePageAccess } from '../../lib/page-access';
import { createOwnerAction } from './actions';
import {
  AGED_DAYS,
  TREATMENT_LABEL,
  listActivePersons,
  listRegister,
  listStores,
  peso,
} from './lib';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';
import { Banner, Button, Field, FlashBanner, FormGrid, FormModal, FormSection, Input, LinkRow, RowLink, Select } from '@/components/ui';

export const metadata = { title: 'Owners — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  error?: string;
}

export default async function OwnersPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await withFlash(searchParams);
  const { actor, refusal } = await requirePageAccess('/owners');
  // ⭐ T-288 — the READ gate. Ian, 2026-09-12: "do both hide the menu and gate the reads."
  if (refusal) return refusal;

  const [stores, persons, owners] = await Promise.all([
    listStores(actor.orgId),
    listActivePersons(actor.orgId),
    listRegister(actor.orgId),
  ]);
  const storeById = new Map(stores.map((s) => [s.id, s]));
  const personById = new Map(persons.map((p) => [p.id, p]));

  // ⭐ Aged receivables render FIRST, above the register. An owner balance left uncollected long
  // enough stops looking like a loan to anyone examining it, and nobody should have to remember to
  // go looking for it — the same reason remittance surfaces open variances at the top.
  const stale = owners.filter((o) => o.aged && o.aged.daysOutstanding >= AGED_DAYS);

  return (
    <Page density="table">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold">Owners</h1>
          <PageDescription>
            What each owner has put in, taken out, and still owes. Every figure is summed from the
            ledger — <strong>no total is stored anywhere</strong>, so none of them can drift from the
            books.
          </PageDescription>
        </div>
        {/* T-448: the add form is a modal opened from the header. */}
        <FormModal
          trigger="+ Record owner"
          title="Record an owner"
          description="Who they are and what they are allowed to withdraw. No money moves; this is the record, not a contribution."
          size="md"
        >
          <CheckedForm rules={OWNERS_CREATE_RULES} action={createOwnerAction} className="space-y-4">
            <FormSection title="Ownership">
              <FormGrid layout="fields">
                <Field label="Store" width="name" rule={OWNERS_CREATE_RULES.storeId}>
                  <Select {...nativeAttrs(OWNERS_CREATE_RULES.storeId)} defaultValue="" className="w-full">
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
                <Field label="Who" width="name" rule={OWNERS_CREATE_RULES.personId}>
                  <Select {...nativeAttrs(OWNERS_CREATE_RULES.personId)} defaultValue="" className="w-full">
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
                <Field label="Role" width="code" hint="Managing Partner, Silent Partner…">
                  <Input name="role" className="w-full" />
                </Field>
                <Field
                  label="Ownership %"
                  width="short"
                  rule={OWNERS_CREATE_RULES.ownershipPercentage}
                  hint="Indicative only — nothing checks that these add to 100, because a store mid-restructure legitimately does not."
                >
                  <Input {...nativeAttrs(OWNERS_CREATE_RULES.ownershipPercentage)} className="w-full" />
                </Field>
              </FormGrid>
            </FormSection>
            <FormSection title="Drawings policy">
              <FormGrid layout="fields">
                <Field label="Drawing limit" width="short" rule={OWNERS_CREATE_RULES.drawingLimit} hint="Leave both blank for no limit.">
                  <Input {...nativeAttrs(OWNERS_CREATE_RULES.drawingLimit)} className="w-full" />
                </Field>
                <Field label="Limit period" width="code">
                  <Select name="drawingLimitPeriod" defaultValue="" className="w-full">
                    <option value="">—</option>
                    <option value="monthly">Monthly — resets each calendar month</option>
                    <option value="total">Total — across all time</option>
                  </Select>
                </Field>
                <Field
                  label="Personal expenses"
                  width="code"
                  hint="Decides where a personal expense lands. It is the line the tax treatment turns on, so it is a stated policy rather than a per-expense guess."
                >
                  <Select name="personalExpenseTreatment" defaultValue="repayable" className="w-full">
                    <option value="repayable">{TREATMENT_LABEL.repayable}</option>
                    <option value="drawing">{TREATMENT_LABEL.drawing}</option>
                  </Select>
                </Field>
              </FormGrid>
            </FormSection>
            <FormGrid layout="fields">
              <Field label="Notes" width="long" hint="Optional.">
                <Input name="notes" className="w-full" />
              </Field>
            </FormGrid>
            <Button type="submit" variant="primary">
              Save
            </Button>
          </CheckedForm>
        </FormModal>
      </div>

      <FlashBanner flash={sp} />

      {/* ── Aged receivables ─────────────────────────────────────────────────────────── */}
      {stale.length > 0 && (
        <Banner tone="warning">
          <h2 className="font-medium">
            {stale.length === 1 ? 'An owner balance has' : `${stale.length} owner balances have`}{' '}
            been outstanding a long time
          </h2>
          <p>
            A personal expense the business is owed stops looking like a loan once it sits
            uncollected. Take it back in cash, recover it from pay, or write it off deliberately —
            leaving it is the one option that decides itself.
          </p>
          <ul className="space-y-1">
            {stale.map((o) => (
              <li key={o.id}>
                <Link href={`/owners/${o.id}`} className="text-sm underline underline-offset-2">
                  {personById.get(o.personId)?.displayName ?? 'Unknown'}
                </Link>{' '}
                — <span className="font-mono tabular-nums">{peso(o.aged!.outstanding)}</span>, oldest
                charge {o.aged!.oldestOn} ({o.aged!.daysOutstanding} days)
              </li>
            ))}
          </ul>
        </Banner>
      )}

      {/* ── The register ─────────────────────────────────────────────────────────────── */}
      {owners.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
          <table className="w-full min-w-[880px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                <th className="px-3 py-2 font-medium">Owner</th>
                <th className="px-3 py-2 font-medium">Store</th>
                <th className="px-3 py-2 text-right font-medium">Contributed</th>
                <th className="px-3 py-2 text-right font-medium">Drawn</th>
                <th className="px-3 py-2 text-right font-medium">Net</th>
                <th className="px-3 py-2 text-right font-medium">Owes</th>
                <th className="px-3 py-2 font-medium">Limit</th>
              </tr>
            </thead>
            <tbody>
              {owners.map((o) => (
                <LinkRow
                  key={o.id}
                  className={`border-b border-neutral-100 last:border-0 dark:border-neutral-900 ${
                    o.status === 'active' ? '' : 'opacity-60'
                  }`}
                >
                  <td className="px-3 py-2">
                    <RowLink href={`/owners/${o.id}`}>
                      {personById.get(o.personId)?.displayName ?? 'Unknown'}
                    </RowLink>
                    <div className="text-xs text-neutral-400 dark:text-neutral-600">
                      {o.role ?? '—'}
                      {o.ownershipPercentage && (
                        // ⚠️ Labelled advisory on purpose: nothing validates that these sum to 100,
                        // because a store mid-restructure legitimately does not.
                        <> · {Number(o.ownershipPercentage)}% (indicative)</>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2">{storeById.get(o.storeId)?.code ?? '—'}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">
                    {peso(o.position.contributed)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">
                    {peso(o.position.drawn)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">
                    {peso(o.position.net)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">
                    {peso(o.position.receivable)}
                  </td>
                  <td className="px-3 py-2 text-xs whitespace-nowrap">
                    {o.drawingLimit
                      ? `${peso(o.drawingLimit)} ${o.drawingLimitPeriod}`
                      : 'none'}
                  </td>
                </LinkRow>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">No owners recorded.</p>
      )}
    </Page>
  );
}

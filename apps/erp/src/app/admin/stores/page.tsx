import { requirePageAccess } from '../../../lib/page-access';
import { listStoresForAdmin } from './lib';
import { createStoreAction } from './actions';
import { Page } from '@/components/shell/Page';

export const metadata = { title: 'Stores — Shareat System' };
export const dynamic = 'force-dynamic';

/** T-222 — opening and closing a branch. ⭐ Until this shipped, nothing in the codebase created a store. */
export default async function StoresPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const sp = await withFlash(searchParams);
  const { actor, refusal } = await requirePageAccess('/admin/stores');
  if (refusal) return refusal;
  const stores = await listStoresForAdmin(actor.orgId);

  return (
    <Page density="table" title="Stores" description="Opening a branch creates its default room and grants every admin access in one transaction so a half-made store cannot exist. What is left is the business half."
      className="erp-page mx-auto w-full px-4 py-4 md:px-6 md:py-6 xl:px-6 xl:py-4 space-y-6 xl:space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          {/* h1 removed — now rendered by PageHeader from the title prop */}
          {/* PageDescription removed — now rendered by PageHeader from the description prop */}
        </div>
        {/* T-448: the create form lives in a dialog; the header button replaces the old "Open a branch" disclosure. */}
        <FormModal trigger="+ Add store" title="Open a branch" size="lg" defaultOpen={Boolean(sp.error)}>
        <CheckedForm
          rules={ADMIN_STORE_CREATE_RULES}
          action={createStoreAction}
          className="space-y-3 text-sm"
        >
          <>
            <FormSection title="Branch identity">
              <FormGrid layout="fields">
                <div className="min-w-0 erp-field-code">
                  <Field rule={ADMIN_STORE_CREATE_RULES.code}
                    label={<span className="text-neutral-600 dark:text-neutral-400">Code</span>}
                    hint="The stable handle. Not editable afterwards."
                  >
                    <Input {...nativeAttrs(ADMIN_STORE_CREATE_RULES.code)} className="mt-1 w-full" />
                  </Field>
                </div>
                <div className="min-w-0 erp-field-name">
                  <Field rule={ADMIN_STORE_CREATE_RULES.name} label={<span className="text-neutral-600 dark:text-neutral-400">Name</span>}
                  >
                    <Input {...nativeAttrs(ADMIN_STORE_CREATE_RULES.name)} className="mt-1 w-full" />
                  </Field>
                </div>
              </FormGrid>
            </FormSection>
            <FormSection title="Stock and remittance">
              <FormGrid layout="fields">
                <div className="min-w-0 erp-field-code">
                  <Field label={<span className="text-neutral-600 dark:text-neutral-400">Stock model</span>}
                  >
                    <Select name="stockModel" className="mt-1 w-full">
                      <option value="single_room">single_room</option>
                      <option value="multi_room">multi_room</option>
                    </Select>
                  </Field>
                </div>
                <div className="min-w-0 erp-field-code">
                  <Field label={<span className="text-neutral-600 dark:text-neutral-400">Remittance cadence</span>}
                  >
                    <Select name="remittanceCadence" className="mt-1 w-full">
                      <option value="daily">daily</option>
                      <option value="every_2_days">every_2_days</option>
                      <option value="weekly">weekly</option>
                      <option value="monthly">monthly</option>
                    </Select>
                  </Field>
                </div>
              </FormGrid>
            </FormSection>
            <FormSection title="Opening and cash ceiling">
              <FormGrid layout="fields">
                <div className="min-w-0 erp-field-date">
                  <Field rule={ADMIN_STORE_CREATE_RULES.openingDate}
                    label={<span className="text-neutral-600 dark:text-neutral-400">Opening date</span>}
                    hint="Leave blank if it has not opened. The first day this store trades."
                  >
                    <Input {...nativeAttrs(ADMIN_STORE_CREATE_RULES.openingDate)} type="date" className="mt-1 w-full" />
                  </Field>
                </div>
                <div className="min-w-0">
                  <Field rule={ADMIN_STORE_CREATE_RULES.unremittedCeiling}
                    span="full"
                    label={
                      <span className="text-neutral-600 dark:text-neutral-400">
                        Unremitted ceiling (required unless the cadence is daily)
                      </span>
                    }
                    hint="A store that pools cash must name the ceiling that bounds it. The database refuses the unsafe combination; this field is where you satisfy it."
                  >
                    <Input {...nativeAttrs(ADMIN_STORE_CREATE_RULES.unremittedCeiling)} placeholder="e.g. 20000.00" className="mt-1 w-full" />
                  </Field>
                </div>
              </FormGrid>
            </FormSection>
          </>
          <div>
            <Button type="submit" variant="primary">
              Open branch
            </Button>
          </div>
        </CheckedForm>
        </FormModal>
      </div>

      <FlashBanner flash={sp} />

      <section className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500 dark:bg-neutral-900 dark:text-neutral-400">
            <tr>
              <th className="p-3">Code</th>
              <th className="p-3">Name</th>
              <th className="p-3">Cadence</th>
              <th className="p-3 text-right">Rooms</th>
              <th className="p-3">Status</th>
              <th className="p-3">Opening</th>
            </tr>
          </thead>
          <tbody>
            {stores.map((s) => (
              <LinkRow
                key={s.id}
                className="border-t border-neutral-200 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900"
              >
                <td className="p-3 font-medium">
                  <RowLink
                    href={`/admin/stores/${s.id}`}
                    aria-label={`Open store ${s.code} — ${s.name}`}
                  >
                    {s.code}
                  </RowLink>
                </td>
                <td className="p-3">{s.name}</td>
                <td className="p-3">
                  {s.remittanceCadence}
                  {s.unremittedCeiling ? ` · ceiling ${s.unremittedCeiling}` : ''}
                </td>
                <td className="p-3 text-right tabular-nums">{s.roomCount}</td>
                <td className="p-3">
                  <Badge status={s.isActive ? 'active' : 'inactive'} />
                </td>
                <td className="p-3">
                  {s.openingDate === null ? (
                    <span className="text-neutral-500">Not yet open</span>
                  ) : s.preOpening ? (
                    <span className="text-warning-ink">Opens {s.openingDate}</span>
                  ) : (
                    <span className="text-success">Opened {s.openingDate}</span>
                  )}
                </td>
              </LinkRow>
            ))}
            {stores.length === 0 && (
              <tr>
                <td className="p-4 text-neutral-500" colSpan={6}>
                  No stores yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </Page>
  );
}
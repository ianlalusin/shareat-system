import { requirePageAccess } from '../../../lib/page-access';
import { withFlash } from '../../../lib/flash';
import { setItemUsageToleranceAction, setOrgUsageToleranceAction } from './actions';
import { percentOf, toleranceView } from './lib';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { ACTION_LINK } from '@/components/action-link';
import { CheckedForm } from '@/components/forms';
import { Button, Field, FlashBanner, Input, Select } from '@/components/ui';
import { SETTINGS_ITEM_TOLERANCE_RULES, SETTINGS_ORG_TOLERANCE_RULES, nativeAttrs } from '@shareat/domain/field-rules';

export const metadata = { title: 'Usage tolerance — Shareat System' };
export const dynamic = 'force-dynamic';

/**
 * `/settings/usage-tolerance`. T-401 S6 (Ian, 15 Oct).
 *
 * How far recorded usage may stray from what the POS sales say it should have been before a manager needs a reason to post it.
 * One organisation-wide band, and an optional band per item (saffron may be tighter than rice). Admin only
 * (`set_menu_depletion`): a manager posts against the band, a manager does not move it.
 */
export default async function UsageToleranceSettingsPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const sp = await withFlash(searchParams);
  const { actor, refusal } = await requirePageAccess('/settings/usage-tolerance');
  if (refusal) return refusal;
  const view = await toleranceView(actor.orgId);
  const overridden = view.items.filter((i) => i.override !== null);

  return (
    <Page density="table" className="space-y-6">
      <div>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          <a href="/settings" className={ACTION_LINK}>
            Settings
          </a>{' '}
          / Usage tolerance
        </p>
        <h1 className="text-2xl font-semibold">Usage tolerance</h1>
        <PageDescription>
          How far the usage staff record may differ from what the day&apos;s POS sales say was used. Inside the band a manager posts as usual;
          outside it the manager must give a reason, and a draft nobody posts is posted at the expected quantity the next afternoon.
        </PageDescription>
      </div>

      <FlashBanner flash={sp} />

      <section className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="text-sm font-medium">Whole organisation: {percentOf(view.org)}</h2>
        <CheckedForm rules={SETTINGS_ORG_TOLERANCE_RULES} action={setOrgUsageToleranceAction} className="mt-3 flex flex-wrap items-end gap-3">
          <Field label="Tolerance, as a fraction (0.10 is 10%)" rule={SETTINGS_ORG_TOLERANCE_RULES.tolerance} className="text-sm">
            <Input
              {...nativeAttrs(SETTINGS_ORG_TOLERANCE_RULES.tolerance)}
              defaultValue={view.org}
              inputMode="decimal"
              className="w-full sm:w-auto sm:min-w-48 sm:flex-1"
            />
          </Field>
          <Button type="submit" variant="primary">
            Save
          </Button>
        </CheckedForm>
      </section>

      <section className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="text-sm font-medium">One item&apos;s own tolerance</h2>
        <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
          Leave the box empty to remove an item&apos;s own setting, so the organisation-wide one applies to it again.
        </p>
        <CheckedForm rules={SETTINGS_ITEM_TOLERANCE_RULES} action={setItemUsageToleranceAction} className="mt-3 flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="block text-neutral-600 dark:text-neutral-400">Item</span>
            <Select name="itemId" defaultValue={view.items[0]?.id}>
              {view.items.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name} ({i.code}){i.override !== null ? ` - ${percentOf(i.override)}` : ''}
                </option>
              ))}
            </Select>
          </label>
          <Field label="Tolerance, as a fraction" rule={SETTINGS_ITEM_TOLERANCE_RULES.tolerance} className="text-sm">
            <Input
              {...nativeAttrs(SETTINGS_ITEM_TOLERANCE_RULES.tolerance)}
              inputMode="decimal"
              placeholder="0.05"
              className="w-full sm:w-auto sm:min-w-48 sm:flex-1"
            />
          </Field>
          <Button type="submit" variant="primary">
            Save
          </Button>
        </CheckedForm>
        {overridden.length > 0 && (
          <ul className="mt-3 space-y-1 text-sm text-neutral-700 dark:text-neutral-300">
            {overridden.map((i) => (
              <li key={i.id}>
                {i.name}: {percentOf(i.override!)}
              </li>
            ))}
          </ul>
        )}
      </section>
    </Page>
  );
}

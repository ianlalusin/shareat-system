import { POS_DISCOUNT_RULES, nativeAttrs } from '@shareat/domain/field-rules';
import { peso } from '@/lib/format';
import { CheckedForm } from '@/components/forms';
import { Button, ConfirmDestructive, DialogActions, Field, FormGrid, FormModal, Input, Select } from '@/components/ui';
import { CopyFromStoreDialog } from '../../copy-from-store/CopyFromStoreDialog';
import type { CopyStoreChoice } from '../../copy-from-store/lib';
import { retirePresetAction, savePresetAction } from './actions';
import { presetText, type DiscountPresetView } from './lib';

/**
 * T-622 (docs/tasks/622-pos-discount-presets-screen.md): the store's named discounts, the ones a cashier picks on the till (Staff meal 20%).
 * Add and Change are the same window (Change locks the name: the name is the key, so a rename is Retire then Add). Retire is a light confirm.
 * `canManage` (`manage_store_settings` at the store) only decides whether the controls are drawn; the domain gates every write again.
 * Senior and PWD are fixed by law and are not presets, so they are not here.
 */
const TYPES = [
  { value: 'percent', label: 'Percent' },
  { value: 'fixed', label: 'Peso amount' },
] as const;

/** The Add and Change window: one form, Change locks the name. The fields sit inside the CheckedForm so the live checks and the guards can see them. */
function PresetForm({ storeId, preset }: { storeId: string; preset?: DiscountPresetView }) {
  const type = preset?.valueType ?? 'percent';
  return (
    <CheckedForm rules={POS_DISCOUNT_RULES} action={savePresetAction} className="space-y-3 text-sm">
      <input type="hidden" name="storeId" value={storeId} />
      <FormGrid layout="fields">
        <Field label="Name (up to 40 letters)" width="name" rule={POS_DISCOUNT_RULES.name}>
          <Input {...nativeAttrs(POS_DISCOUNT_RULES.name)} defaultValue={preset?.name ?? ''} readOnly={!!preset} autoComplete="off" placeholder="Staff meal" />
        </Field>
        <Field label="Type" width="name">
          <Select name="valueType" defaultValue={type}>
            {TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Value (a percent from 1 to 100, or pesos off each item)" width="short" rule={POS_DISCOUNT_RULES.value}>
          <Input {...nativeAttrs(POS_DISCOUNT_RULES.value)} defaultValue={preset ? (preset.valueType === 'percent' ? String(Number(preset.value)) : preset.value) : ''} autoComplete="off" />
        </Field>
      </FormGrid>
      {preset && <p className="text-xs text-muted">The name stays. To rename a discount, retire it and add a new one.</p>}
      <DialogActions>
        <Button type="submit" variant="primary">
          Save
        </Button>
      </DialogActions>
    </CheckedForm>
  );
}

export function DiscountsSection({
  store,
  presets,
  canManage,
  copyStores,
}: {
  store: { id: string; name: string };
  presets: DiscountPresetView[];
  canManage: boolean;
  copyStores: CopyStoreChoice[] | null;
}) {
  return (
    <section data-discounts className="space-y-3 rounded-lg border border-surface-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-medium">Discounts</h2>
        {canManage && (
          <div className="flex flex-wrap items-center gap-2">
            {copyStores && <CopyFromStoreDialog kind="presets" currentStoreId={store.id} stores={copyStores} />}
            <FormModal trigger="+ Add discount" title="Add a discount" size="md">
              <PresetForm storeId={store.id} />
            </FormModal>
          </div>
        )}
      </div>
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        The named discounts a cashier at {store.name} can pick (for example Staff meal 20%). A change reaches the tablet after its next refresh.
        Senior and PWD discounts are fixed by law and are not listed here. To rename one, retire it and add it again.
      </p>
      {presets.length === 0 ? (
        <p className="text-sm text-neutral-600 dark:text-neutral-400">No named discounts at {store.name} yet.{canManage ? ' Add one, or copy them from another store.' : ''}</p>
      ) : (
        <ul className="divide-y divide-surface-border text-sm">
          {presets.map((p) => (
            <li key={p.id} data-preset className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
              <div className="min-w-0">
                <span className="font-medium text-ink">{p.name}</span>
                <span className="ml-2 tabular-nums text-muted">{presetText(p, peso)}</span>
              </div>
              {canManage && (
                <div className="flex flex-wrap items-center gap-2">
                  <FormModal trigger="Change" triggerIcon={null} triggerVariant="secondary" triggerLabel={`Change ${p.name}`} title={`Change ${p.name}`} size="md">
                    <PresetForm storeId={store.id} preset={p} />
                  </FormModal>
                  <form action={retirePresetAction}>
                    <input type="hidden" name="storeId" value={store.id} />
                    <input type="hidden" name="presetId" value={p.id} />
                    <ConfirmDestructive
                      tier="confirm"
                      label="Retire"
                      quiet
                      consequence={`Retire ${p.name}? Cashiers stop seeing it at once. Past sales keep it.`}
                    />
                  </form>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

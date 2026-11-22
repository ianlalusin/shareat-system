import { POS_CHARGE_RULES, nativeAttrs } from '@shareat/domain/field-rules';
import { peso } from '@/lib/format';
import { CheckedForm } from '@/components/forms';
import { Button, Checkbox, ConfirmDestructive, DialogActions, Field, FormGrid, FormModal, Input } from '@/components/ui';
import { CopyFromStoreDialog } from '../../copy-from-store/CopyFromStoreDialog';
import type { CopyStoreChoice } from '../../copy-from-store/lib';
import { retireChargeAction, saveChargeAction } from './actions';
import { chargeText, type ChargePresetView } from './lib';

/**
 * T-627 (docs/tasks/627-pos-charges.md): the store's named charges, the ones a cashier adds to a bill on the till (Leftover, Extra griller). Add and Change are the same
 * window (Change locks the name: the name is the key, so a rename is Retire then Add). Retire is a light confirm. A charge is added AFTER discounts and VAT and stays
 * out of the VAT amount (as in v1). `canManage` (`manage_store_settings` at the store) only decides whether the controls are drawn; the domain gates every write again.
 */
function ChargeForm({ storeId, preset }: { storeId: string; preset?: ChargePresetView }) {
  return (
    <CheckedForm rules={POS_CHARGE_RULES} action={saveChargeAction} className="space-y-3 text-sm">
      <input type="hidden" name="storeId" value={storeId} />
      <FormGrid layout="fields">
        <Field label="Name (up to 40 letters)" width="name" rule={POS_CHARGE_RULES.name}>
          <Input {...nativeAttrs(POS_CHARGE_RULES.name)} defaultValue={preset?.name ?? ''} readOnly={!!preset} autoComplete="off" placeholder="Leftover" />
        </Field>
        <Field label="Amount in pesos" width="short" rule={POS_CHARGE_RULES.amount}>
          <Input {...nativeAttrs(POS_CHARGE_RULES.amount)} defaultValue={preset?.amount ?? ''} autoComplete="off" />
        </Field>
      </FormGrid>
      <Checkbox name="perUnit" defaultChecked={preset?.perUnit ?? false} label="The cashier enters how many (for example per 100 g or per tray)" />
      <p className="text-xs text-muted">Leave it unticked for a charge taken once per bill.</p>
      {preset && <p className="text-xs text-muted">The name stays. To rename a charge, retire it and add a new one.</p>}
      <DialogActions>
        <Button type="submit" variant="primary">
          Save
        </Button>
      </DialogActions>
    </CheckedForm>
  );
}

export function ChargesSection({
  store,
  presets,
  canManage,
  copyStores,
}: {
  store: { id: string; name: string };
  presets: ChargePresetView[];
  canManage: boolean;
  copyStores: CopyStoreChoice[] | null;
}) {
  return (
    <section data-charges className="space-y-3 rounded-lg border border-surface-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-medium">Charges</h2>
        {canManage && (
          <div className="flex flex-wrap items-center gap-2">
            {copyStores && <CopyFromStoreDialog kind="charges" currentStoreId={store.id} stores={copyStores} />}
            <FormModal trigger="+ Add charge" title="Add a charge" size="md">
              <ChargeForm storeId={store.id} />
            </FormModal>
          </div>
        )}
      </div>
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        The extra charges a cashier at {store.name} can add to a bill (for example Leftover or Extra griller). A charge is added after discounts and VAT and is not part of the VAT amount.
        Any cashier can add or remove one. A change reaches the tablet after its next refresh. To rename one, retire it and add it again.
      </p>
      {presets.length === 0 ? (
        <p className="text-sm text-neutral-600 dark:text-neutral-400">No charges at {store.name} yet.{canManage ? ' Add one, or copy them from another store.' : ''}</p>
      ) : (
        <ul className="divide-y divide-surface-border text-sm">
          {presets.map((p) => (
            <li key={p.id} data-charge className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
              <div className="min-w-0">
                <span className="font-medium text-ink">{p.name}</span>
                <span className="ml-2 tabular-nums text-muted">{chargeText(p, peso)}</span>
              </div>
              {canManage && (
                <div className="flex flex-wrap items-center gap-2">
                  <FormModal trigger="Change" triggerIcon={null} triggerVariant="secondary" triggerLabel={`Change ${p.name}`} title={`Change ${p.name}`} size="md">
                    <ChargeForm storeId={store.id} preset={p} />
                  </FormModal>
                  <form action={retireChargeAction}>
                    <input type="hidden" name="storeId" value={store.id} />
                    <input type="hidden" name="presetId" value={p.id} />
                    <ConfirmDestructive tier="confirm" label="Retire" quiet consequence={`Retire ${p.name}? Cashiers stop seeing it at once. Past sales keep it.`} />
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

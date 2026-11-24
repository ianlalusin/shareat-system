import { POS_CHARGE_AMOUNT_RULES, POS_CHARGE_RULES, nativeAttrs } from '@shareat/domain/field-rules';
import { peso } from '@/lib/format';
import { CheckedForm, EditableRecord } from '@/components/forms';
import { Button, Checkbox, ConfirmDestructive, DialogActions, Field, FormGrid, FormModal, Input, NumTd, Table, Td, Th } from '@/components/ui';
import { createChargeOptionAction, setChargeOptionStatusAction, updateChargeOptionAction } from './actions';
import { chargeText, type ChargeOptionView } from './lib';

/**
 * T-634 (docs/tasks/634-central-charges.md): "Charges (all stores)", the org's ONE list of charges (Leftover, Extra griller). Ian, 24 Nov: "charges i guess shall be
 * centralized so charges are uniform across the brand". One name, amount and per unit for every store; each store only switches a charge on or off (the store's
 * Charges section below). The T-631 compact-table look: Charge / Amount / Stores using / a quiet Edit. `canManage` is `manage_menu` (org): it only decides whether
 * Add, Edit, Retire and Restore are drawn; the domain gates every write again.
 */
export function ChargeOptionsSection({ options, canManage, storeId }: { options: ChargeOptionView[]; canManage: boolean; storeId: string }) {
  const active = options.filter((o) => o.status === 'active');
  const retired = options.filter((o) => o.status === 'retired');
  const used = active.filter((o) => o.storesOn > 0).length;
  return (
    <section data-charge-options className="space-y-3 rounded-lg border border-surface-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-medium">
          Charges (all stores){' '}
          <span className="ml-1 inline-flex rounded-full bg-canvas px-2 py-0.5 text-xs font-normal text-muted">
            {used} of {active.length} switched on at a store
          </span>
        </h2>
        {canManage && (
          <FormModal trigger="+ Add charge" title="Add a charge for all stores" size="md">
            <CheckedForm rules={POS_CHARGE_RULES} action={createChargeOptionAction} className="space-y-3 text-sm">
              <input type="hidden" name="storeId" value={storeId} />
              <FormGrid layout="fields">
                <Field label="Name (up to 40 letters)" width="name" rule={POS_CHARGE_RULES.name}>
                  <Input {...nativeAttrs(POS_CHARGE_RULES.name)} autoComplete="off" placeholder="Leftover" />
                </Field>
                <Field label="Amount in pesos" width="short" rule={POS_CHARGE_RULES.amount}>
                  <Input {...nativeAttrs(POS_CHARGE_RULES.amount)} autoComplete="off" />
                </Field>
              </FormGrid>
              <Checkbox name="perUnit" label="The cashier enters how many (for example per 100 g or per tray)" />
              <p className="text-xs text-muted">Leave it unticked for a charge taken once per bill. The charge starts switched off at every store.</p>
              <DialogActions>
                <Button type="submit" variant="primary">
                  Save
                </Button>
              </DialogActions>
            </CheckedForm>
          </FormModal>
        )}
      </div>
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        One list for the whole brand: the same name and amount at every store. A changed amount applies to every store from the next charge added; a charge already on a
        table keeps its amount. A charge is added after discounts and VAT and is not part of the VAT amount. To rename one, retire it and add it again.
      </p>
      {active.length === 0 ? (
        <p className="text-sm text-neutral-600 dark:text-neutral-400">No charges yet.{canManage ? ' Add one, then switch it on at the stores that use it.' : ''}</p>
      ) : (
        <Table label="Charges for all stores" card={{ title: 'Charge', subtitle: 'Amount', keys: ['Stores using'] }}>
          <thead>
            <tr>
              <Th>Charge</Th>
              <Th>Amount</Th>
              <Th numeric>Stores using</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {active.map((o) => (
              <tr key={o.id} data-charge-option>
                <Td className="font-medium">{o.name}</Td>
                <Td className="tabular-nums">{chargeText(o, peso)}</Td>
                <NumTd className={o.storesOn > 0 ? undefined : 'text-muted'}>{o.storesOn > 0 ? o.storesOn : 'Not used yet'}</NumTd>
                <Td className="text-right whitespace-nowrap">
                  {canManage && (
                    <div data-card-ignore className="flex items-center justify-end">
                      <EditableRecord
                        quiet
                        action={updateChargeOptionAction}
                        label={o.name}
                        hidden={{ chargeOptionId: o.id, storeId }}
                        rules={POS_CHARGE_AMOUNT_RULES}
                        extra={
                          <form action={setChargeOptionStatusAction} className="mt-2">
                            <input type="hidden" name="chargeOptionId" value={o.id} />
                            <input type="hidden" name="storeId" value={storeId} />
                            <input type="hidden" name="status" value="retired" />
                            <ConfirmDestructive
                              tier="confirm"
                              quiet
                              label="Retire"
                              consequence={
                                o.storesOn > 0
                                  ? `${o.name} is switched on at ${o.storesOn} ${o.storesOn === 1 ? 'store' : 'stores'}: switch it off there first, or this is refused.`
                                  : `${o.name} can no longer be switched on at a store. Past bills keep it. You can bring it back later.`
                              }
                            />
                          </form>
                        }
                      >
                        <FormGrid layout="fields">
                          <Field label="Amount in pesos" width="short" rule={POS_CHARGE_AMOUNT_RULES.amount}>
                            <Input {...nativeAttrs(POS_CHARGE_AMOUNT_RULES.amount)} defaultValue={o.amount} autoComplete="off" />
                          </Field>
                        </FormGrid>
                        <Checkbox name="perUnit" defaultChecked={o.perUnit} label="The cashier enters how many" />
                        <p className="text-xs text-muted">
                          Applies to every store from the next charge added. A charge already on a table keeps its amount. The name stays: to rename it, retire it and add a new one.
                        </p>
                      </EditableRecord>
                    </div>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {retired.length > 0 && (
        <details className="text-xs text-neutral-500 dark:text-neutral-400">
          <summary className="inline-flex min-h-11 cursor-pointer items-center [@media(pointer:fine)]:min-h-8">Retired charges ({retired.length})</summary>
          <ul className="mt-2 divide-y divide-surface-border">
            {retired.map((o) => (
              <li key={o.id} data-charge-option-retired className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  <span className="font-medium text-ink">{o.name}</span> <span className="tabular-nums">{chargeText(o, peso)}</span>
                </span>
                {canManage && (
                  <form action={setChargeOptionStatusAction}>
                    <input type="hidden" name="chargeOptionId" value={o.id} />
                    <input type="hidden" name="storeId" value={storeId} />
                    <input type="hidden" name="status" value="active" />
                    <Button type="submit" variant="secondary" aria-label={`Restore ${o.name}`}>
                      Restore
                    </Button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

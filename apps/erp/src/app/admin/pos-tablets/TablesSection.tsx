import { POS_TABLE_ADD_RULES, nativeAttrs } from '@shareat/domain/field-rules';
import { CheckedForm } from '@/components/forms';
import { Button, ConfirmDestructive, DialogActions, Field, FormGrid, FormModal, Input, Select } from '@/components/ui';
import { addTablesAction, retireTableAction } from './actions';
import type { TableView } from './lib';

/**
 * T-633 (docs/tasks/633-tables-screen.md): the store's table numbers, the ones a cashier seats a party at on the till. Each store has its own.
 * Add takes one number or a range ("1-20") in one go; Retire picks one number and asks once. A retired number is never reused, so it is listed in a
 * collapsed "Retired" block rather than offered again. The numbers are plain chips (not controls), so a long list stays compact and never needs a
 * 44px target each; the two controls are Add and Retire. `canManage` (`manage_store_settings` at the store) only decides whether they are drawn;
 * the domain gates every write again.
 */
function Chips({ tables, muted }: { tables: TableView[]; muted?: boolean }) {
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label={muted ? 'Retired table numbers' : 'Table numbers'}>
      {[...tables].sort((a, b) => a.number - b.number).map((t) => (
        <li
          key={t.id}
          data-table
          className={`inline-flex min-w-9 items-center justify-center rounded-full border px-2 py-0.5 text-sm tabular-nums ${
            muted ? 'border-dashed border-surface-border text-muted line-through' : 'border-surface-border bg-surface font-medium text-ink'
          }`}
        >
          {t.number}
        </li>
      ))}
    </ul>
  );
}

export function TablesSection({
  store,
  active,
  retired,
  canManage,
}: {
  store: { id: string; name: string };
  active: TableView[];
  retired: TableView[];
  canManage: boolean;
}) {
  return (
    <section data-tables className="space-y-3 rounded-lg border border-surface-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-medium">
          Tables <span className="font-normal text-muted">({active.length})</span>
        </h2>
        {canManage && (
          <div className="flex flex-wrap items-center gap-2">
            {active.length > 0 && (
              <FormModal trigger="Retire a table" triggerIcon={null} triggerVariant="secondary" title="Retire a table" size="sm">
                <form action={retireTableAction} className="space-y-3 text-sm">
                  <input type="hidden" name="storeId" value={store.id} />
                  <label className="flex flex-col gap-1">
                    <span>Table number</span>
                    {/* No placeholder: a select starts on its first option (the lowest number), so it is never empty. `retirePosStand` checks the id again. */}
                    <Select name="standId">
                      {[...active].sort((a, b) => a.number - b.number).map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.number}
                        </option>
                      ))}
                    </Select>
                  </label>
                  <p className="text-xs text-muted">A table with an open bill cannot be retired. A retired number is never used again at {store.name}.</p>
                  <DialogActions>
                    <ConfirmDestructive tier="confirm" label="Retire" consequence="Retire this table? The tablet stops showing it after its next refresh. Past sales keep it." />
                  </DialogActions>
                </form>
              </FormModal>
            )}
            <FormModal trigger="+ Add tables" title="Add tables" size="sm">
              <CheckedForm rules={POS_TABLE_ADD_RULES} action={addTablesAction} className="space-y-3 text-sm">
                <input type="hidden" name="storeId" value={store.id} />
                <FormGrid layout="fields">
                  <Field label="Table number, or a range" width="short" rule={POS_TABLE_ADD_RULES.numbers}>
                    <Input {...nativeAttrs(POS_TABLE_ADD_RULES.numbers)} autoComplete="off" inputMode="numeric" placeholder="1-20" />
                  </Field>
                </FormGrid>
                <p className="text-xs text-muted">One number like 5, or a range like 1-20 (up to 200 at a time). Numbers already there are skipped.</p>
                <DialogActions>
                  <Button type="submit" variant="primary">
                    Add
                  </Button>
                </DialogActions>
              </CheckedForm>
            </FormModal>
          </div>
        )}
      </div>
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        The table numbers a cashier at {store.name} can seat a party at. A change reaches the tablet after its next refresh.
      </p>
      {active.length === 0 ? (
        <p className="text-sm text-neutral-600 dark:text-neutral-400">No tables at {store.name} yet.{canManage ? ' Add a range like 1-20.' : ''}</p>
      ) : (
        <Chips tables={active} />
      )}
      {retired.length > 0 && (
        <details className="text-xs text-neutral-500 dark:text-neutral-400">
          <summary className="inline-flex min-h-11 cursor-pointer items-center [@media(pointer:fine)]:min-h-8">Retired ({retired.length})</summary>
          <div className="mt-2">
            <Chips tables={retired} muted />
          </div>
        </details>
      )}
    </section>
  );
}

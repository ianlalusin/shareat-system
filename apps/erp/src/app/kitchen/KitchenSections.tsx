import { EditableRecord } from '@/components/forms';
import { Banner, Button, Field, FormGrid, Input, Select } from '@/components/ui';
import type { KitchenSetup } from '@shareat/domain';
import type { TypedView } from '@/lib/keep-typing';
import {
  createKitchenStationAction,
  retireKitchenStationAction,
  saveKitchenRoutingAction,
  setKitchenCategoryAction,
  updateKitchenStationAction,
} from '../kitchen-actions';

const CARD = 'space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800';
const MUTED = 'text-neutral-600 dark:text-neutral-400';

/**
 * T-508 S2b: Kitchen stations and Kitchen routing. Rendered only for someone who may manage this store's settings
 * (`kitchenForStore` returns null otherwise); the domain functions enforce the same gate again on every write.
 */
export function KitchenSections({
  storeId,
  setup,
  typedStations,
  typedRouting,
}: {
  storeId: string;
  setup: KitchenSetup;
  /** `typedFor(...)` results, built in page.tsx (the keep-typing guard wants the call there), by station id. */
  typedStations: Record<string, TypedView | null>;
  typedRouting: TypedView | null;
}) {
  const stationName = new Map(setup.stations.map((s) => [s.id, s.name]));
  const categories = [...new Map(setup.offeredItems.map((i) => [i.categoryId, i.categoryName])).entries()];
  const hasStations = setup.stations.length > 0;
  return (
    <>
      {setup.notOnPos.length > 0 && (
        <Banner tone="error">
          <div>
            <strong>Not on the POS yet.</strong> These {setup.notOnPos.length} item{setup.notOnPos.length === 1 ? ' has' : 's have'} a price here
            but no kitchen station, so the cashier cannot sell {setup.notOnPos.length === 1 ? 'it' : 'them'}. Choose a station under Kitchen routing.
            <ul data-testid="not-on-pos" className="mt-1 list-disc pl-5">
              {setup.notOnPos.map((i) => (
                <li key={i.itemId}>
                  {i.name} <span className={MUTED}>({i.categoryName})</span>
                </li>
              ))}
            </ul>
          </div>
        </Banner>
      )}

      <section className={CARD}>
        <h2 className="text-sm font-medium">Kitchen stations</h2>
        <p className="text-xs text-neutral-500">A station is a place that cooks, like Grill or Drinks. Each item is sent to one station.</p>
        {hasStations ? (
          <ul className="divide-y divide-neutral-200 text-sm dark:divide-neutral-800">
            {setup.stations.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  <span className="font-medium">{s.name}</span>
                  <span className={`ml-2 ${MUTED}`}>
                    {s.slaMinutes} min · {s.printOnOutage ? 'prints if the screen is down' : 'no paper backup'} · order {s.sortOrder}
                  </span>
                </span>
                <EditableRecord
                  action={updateKitchenStationAction}
                  label={s.name}
                  hidden={{ storeId, stationId: s.id }}
                  typed={typedStations[s.id] ?? null}
                  extra={
                    <form action={retireKitchenStationAction}>
                      <input type="hidden" name="storeId" value={storeId} />
                      <input type="hidden" name="stationId" value={s.id} />
                      <Button type="submit" variant="secondary">
                        Retire
                      </Button>
                    </form>
                  }
                >
                  <FormGrid className="text-sm">
                    <Field label="Station name">
                      <Input name="name" defaultValue={s.name} className="mt-1 w-full" />
                    </Field>
                    <Field label="Minutes to cook" hint="How long a ticket may wait before it shows as late.">
                      <Input name="slaMinutes" defaultValue={String(s.slaMinutes)} className="mt-1 w-full tabular-nums" />
                    </Field>
                    <Field label="Print if the screen is down" hint="Prints the ticket on paper when the kitchen screen cannot be reached.">
                      <Select name="printOnOutage" defaultValue={s.printOnOutage ? 'yes' : 'no'} className="mt-1 w-full">
                        <option value="no">No</option>
                        <option value="yes">Yes</option>
                      </Select>
                    </Field>
                    <Field label="Order on the screen" hint="Smaller numbers come first.">
                      <Input name="sortOrder" defaultValue={String(s.sortOrder)} className="mt-1 w-full tabular-nums" />
                    </Field>
                  </FormGrid>
                  <p className="mt-3 text-xs text-neutral-500">Retire is refused while any item still cooks at this station. Move those items first.</p>
                </EditableRecord>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-neutral-600 dark:text-neutral-400">No kitchen station yet. Add one below, then choose which items cook there.</p>
        )}
        <form action={createKitchenStationAction} className="space-y-3 border-t border-neutral-200 pt-3 text-sm dark:border-neutral-800">
          <input type="hidden" name="storeId" value={storeId} />
          <FormGrid>
            <Field label="New station name">
              <Input name="name" placeholder="Grill, Drinks, Dessert…" className="mt-1 w-full" />
            </Field>
            <Field label="Minutes to cook" hint="Leave blank for 10.">
              <Input name="slaMinutes" className="mt-1 w-full tabular-nums" />
            </Field>
          </FormGrid>
          <Button type="submit" variant="secondary">
            Save
          </Button>
        </form>
      </section>

      <section className={CARD}>
        <h2 className="text-sm font-medium">Kitchen routing</h2>
        <p className="text-xs text-neutral-500">
          Which station cooks each item sold at this store. All sizes of a dish go to the same station. An item with no station stays off the POS.
        </p>
        {setup.offeredItems.length === 0 ? (
          <p className="text-sm text-neutral-600 dark:text-neutral-400">No item has a price at this store yet.</p>
        ) : !hasStations ? (
          <p className="text-sm text-neutral-600 dark:text-neutral-400">Add a kitchen station first.</p>
        ) : (
          <>
            <form action={setKitchenCategoryAction} className="space-y-3 text-sm">
              <input type="hidden" name="storeId" value={storeId} />
              <FormGrid>
                <Field label="Set every item in this category to…">
                  <Select name="categoryId" className="mt-1 w-full" defaultValue="">
                    <option value="" disabled>
                      Choose a category
                    </option>
                    {categories.map(([id, name]) => (
                      <option key={id} value={id}>
                        {name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Station">
                  <Select name="stationId" className="mt-1 w-full" defaultValue="">
                    <option value="" disabled>
                      Choose a station
                    </option>
                    {setup.stations.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              </FormGrid>
              <Button type="submit" variant="secondary">
                Save
              </Button>
            </form>

            <div className="flex items-center gap-2 text-sm">
              <EditableRecord
                action={saveKitchenRoutingAction}
                label="kitchen routing"
                hidden={{ storeId }}
                typed={typedRouting}
              >
                <div className="space-y-4 text-sm">
                  {categories.map(([categoryId, categoryName]) => (
                    <fieldset key={categoryId} className="space-y-2">
                      <legend className="text-xs font-medium uppercase tracking-wide text-neutral-500">{categoryName}</legend>
                      {setup.offeredItems
                        .filter((i) => i.categoryId === categoryId)
                        .map((i) => (
                          <label key={i.itemId} className="flex items-center justify-between gap-3">
                            <span>{i.name}</span>
                            <Select name={`route_${i.itemId}`} defaultValue={i.stationId ?? ''}>
                              <option value="">No station (not on the POS)</option>
                              {setup.stations.map((s) => (
                                <option key={s.id} value={s.id}>
                                  {s.name}
                                </option>
                              ))}
                            </Select>
                          </label>
                        ))}
                    </fieldset>
                  ))}
                </div>
              </EditableRecord>
              <span className={MUTED}>Change stations one by one</span>
            </div>

            <ul className="text-sm" data-testid="routing-list">
              {setup.offeredItems.map((i) => (
                <li key={i.itemId} className="flex flex-wrap items-center justify-between gap-2 border-t border-neutral-200 py-1.5 dark:border-neutral-800">
                  <span>
                    {i.name} <span className={MUTED}>({i.categoryName})</span>
                  </span>
                  {i.stationId ? <span>{stationName.get(i.stationId) ?? 'Unknown station'}</span> : <span className="text-danger">No station</span>}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </>
  );
}

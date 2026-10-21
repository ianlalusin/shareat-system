import Link from 'next/link';
import { LOCATION_ROLES } from '@shareat/db/schema';
import { requireSession } from '../../../lib/session';
import {
  createLocationAction,
  deactivateLocationAction,
  reactivateLocationAction,
  setDefaultAction,
  setupRoomsAction,
  updateLocationAction,
} from './actions';
import { listStores, locationsPageData } from './lib';
import { Page } from '@/components/shell/Page';
import { CheckedForm, EditableRecord } from '@/components/forms';
import { INVENTORY_LOCATION_RULES, nativeAttrs } from '@shareat/domain/field-rules';
import { Button, Checkbox, ConfirmDestructive, Field, FlashBanner, FormGrid, Input, Select } from '@/components/ui';
import { FilterRow } from '@/components/FilterRow';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';
import { typedFor } from '@/lib/keep-typing';
import { LOCATION_EDIT } from './typed-forms';

export const metadata = { title: 'Stock locations — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  store?: string;
  error?: string;
  ok?: string;
}

const STOCK_MODEL_EXPLANATION: Record<'single_room' | 'multi_room', string> = {
  single_room:
    'This store keeps stock in ONE room (a branch or kiosk) — it may hold exactly one active room besides Receiving.',
  multi_room:
    'This store manages several rooms (a commissary) — it may hold as many active rooms as it needs.',
};

export default async function StockLocationsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await withFlash(searchParams);
  const { actor } = await requireSession('/inventory/locations');
  const stores = await listStores(actor.orgId);
  const storeId = sp.store && stores.some((s) => s.id === sp.store) ? sp.store : stores[0]?.id;

  if (!storeId) {
    return (
      <Page density="table" className="">
        <h1 className="text-2xl font-semibold">Stock locations</h1>
        <p className="mt-4 text-sm text-neutral-600">This organisation has no stores yet.</p>
      </Page>
    );
  }

  const data = await locationsPageData(actor.orgId, storeId);
  if (!data) {
    return (
      <Page density="table" className="">
        <h1 className="text-2xl font-semibold">Stock locations</h1>
        <p className="mt-4 text-sm text-neutral-600">That store could not be found.</p>
      </Page>
    );
  }
  const { stockModel, locations, types } = data;

  return (
    <Page density="table" className="space-y-8">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Stock locations</h1>
          <PageDescription className="mt-1">
            The rooms every stock movement is keyed to — Stockroom, Kitchen, Receiving, and so on.
            No movement in this store can happen without a room to name.
          </PageDescription>
        </div>
        <Link href="/inventory" className="text-sm underline underline-offset-4">
          ← Stock on hand
        </Link>
      </div>

      <FlashBanner flash={sp} />

      <FilterRow>
        <label className="text-sm">
          <span className="block text-neutral-600 dark:text-neutral-400">Store</span>
          <Select name="store" defaultValue={storeId}>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.code})
              </option>
            ))}
          </Select>
        </label>
      </FilterRow>

      <section className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <p className="text-sm">
          <span className="font-medium">How this store organises stock: </span>
          {stockModel === 'single_room' ? 'One room' : 'Multiple rooms'}.{' '}
          {STOCK_MODEL_EXPLANATION[stockModel]}
        </p>
      </section>

      {locations.length === 0 ? (
        <section className="rounded-lg border border-warning bg-warning-soft p-4">
          <p className="text-sm text-warning-ink">
            This store has no rooms yet — nothing can be received, used, or counted until it does.
          </p>
          <form action={setupRoomsAction} className="mt-3">
            <input type="hidden" name="storeId" value={storeId} />
            <Button type="submit" variant="primary">
              Set up rooms
            </Button>
          </form>
        </section>
      ) : (
        <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="font-medium">Rooms</h2>
          <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
            <table className="w-full min-w-[720px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                  <th className="px-3 py-2 font-medium">Room</th>
                  <th className="px-3 py-2 font-medium">Type / role</th>
                  <th className="px-3 py-2 font-medium">Purpose</th>
                  <th className="px-3 py-2 font-medium">Default</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {locations.map((loc) => (
                  <tr key={loc.id} className="border-b border-neutral-100 align-top last:border-0 dark:border-neutral-900">
                    <td className="px-3 py-2">
                      <div className="font-medium">{loc.name}</div>
                      <div className="font-mono text-xs text-neutral-500">{loc.code}</div>
                    </td>
                    <td className="px-3 py-2 text-neutral-600 dark:text-neutral-400">
                      {loc.typeName} · {loc.role}
                    </td>
                    <td className="px-3 py-2">{loc.purpose === 'receiving' ? 'Receiving' : 'Normal'}</td>
                    <td className="px-3 py-2">{loc.isDefault ? '★ default' : ''}</td>
                    <td className="px-3 py-2">{loc.status}</td>
                    <td className="px-3 py-2">
                      <div className="flex flex-col gap-2">
                        <EditableRecord
                          action={updateLocationAction}
                          label={loc.name}
                          hidden={{ storeId, id: loc.id }}
                          typed={typedFor(sp, LOCATION_EDIT, loc.id, actor.personId)}
                        >
                          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                            <Input
                              name="name"
                              aria-label="Name"
                              defaultValue={loc.name}
                              className="col-span-2 sm:col-span-1"
                            />
                            <Select name="typeId" aria-label="Type" defaultValue={loc.typeId}>
                              {types.map((t) => (
                                <option key={t.id} value={t.id}>
                                  {t.name}
                                </option>
                              ))}
                            </Select>
                            {loc.purpose === 'receiving' ? (
                              <span className="self-center text-xs text-neutral-500">storage (fixed)</span>
                            ) : (
                              <Select name="role" aria-label="Role" defaultValue={loc.role}>
                                {LOCATION_ROLES.map((r) => (
                                  <option key={r} value={r}>
                                    {r}
                                  </option>
                                ))}
                              </Select>
                            )}
                          </div>
                        </EditableRecord>
                        <div className="flex flex-wrap gap-2">
                          {loc.status === 'active' && !loc.isDefault && (
                            <form action={setDefaultAction}>
                              <input type="hidden" name="storeId" value={storeId} />
                              <input type="hidden" name="id" value={loc.id} />
                              <Button type="submit" variant="secondary" className="text-xs">
                                Make default
                              </Button>
                            </form>
                          )}
                          {loc.status === 'active' && loc.isDefault ? (
                            // ⚠️ The default room cannot be retired (the service refuses it —
                            // review 2026-09-03); say so instead of offering a button that fails.
                            <span className="text-xs text-neutral-500">default — pick another default to retire this room</span>
                          ) : loc.status === 'active' ? (
                            <form action={deactivateLocationAction}>
                              <input type="hidden" name="storeId" value={storeId} />
                              <input type="hidden" name="id" value={loc.id} />
                              <ConfirmDestructive
                                tier="retype"
                                label="Deactivate room"
                                consequence="Deactivates this room."
                                expectedName={loc.name}
                              />
                            </form>
                          ) : (
                            <form action={reactivateLocationAction}>
                              <input type="hidden" name="storeId" value={storeId} />
                              <input type="hidden" name="id" value={loc.id} />
                              <Button type="submit" variant="secondary" className="text-xs">
                                Reactivate
                              </Button>
                            </form>
                          )}
                        </div>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3 className="border-t border-neutral-200 pt-3 font-medium dark:border-neutral-800">Add a room</h3>
          <CheckedForm rules={INVENTORY_LOCATION_RULES} action={createLocationAction} className="space-y-3">
            <input type="hidden" name="storeId" value={storeId} />
            <FormGrid>
              <Field label={<span className="text-neutral-600 dark:text-neutral-400">Code</span>} className="text-sm" rule={INVENTORY_LOCATION_RULES.code}>
                <Input {...nativeAttrs(INVENTORY_LOCATION_RULES.code)} className="w-full" />
              </Field>
              <Field label={<span className="text-neutral-600 dark:text-neutral-400">Name</span>} className="text-sm" rule={INVENTORY_LOCATION_RULES.name}>
                <Input {...nativeAttrs(INVENTORY_LOCATION_RULES.name)} className="w-full" />
              </Field>
              <Field label={<span className="text-neutral-600 dark:text-neutral-400">Type</span>} className="text-sm" rule={INVENTORY_LOCATION_RULES.typeId}>
                <Select {...nativeAttrs(INVENTORY_LOCATION_RULES.typeId)} defaultValue="" className="w-full">
                  <option value="" disabled>
                    Select a type
                  </option>
                  {types.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={<span className="text-neutral-600 dark:text-neutral-400">Role</span>} className="text-sm">
                <Select name="role" defaultValue="storage" className="w-full">
                  {LOCATION_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </Select>
              </Field>
              <Checkbox name="isReceiving" label="This is the Receiving room" />
              <Checkbox name="isDefault" label="Make it the default" />
            </FormGrid>
            <Button type="submit" variant="primary">
              Save
            </Button>
          </CheckedForm>
        </section>
      )}
    </Page>
  );
}

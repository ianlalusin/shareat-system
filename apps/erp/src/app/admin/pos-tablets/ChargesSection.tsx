import { peso } from '@/lib/format';
import { Button, ConfirmDestructive, Table, Td, Th } from '@/components/ui';
import { setStoreChargeAction } from './actions';
import { chargeText, type ChargeOptionView } from './lib';

/**
 * T-634 (docs/tasks/634-central-charges.md): the store's Charges are now on/off switches over the org's one list ("Charges (all stores)" above); the name and
 * amount are the brand's, never set per store. The T-631 compact-table look: Charge / Amount / Status / the switch. On is one tap; Off asks once (cashiers stop
 * seeing it; past bills keep it). `canManage` (`manage_store_settings` at the store) only decides whether the switches are drawn; the domain gates every write again.
 */
export function ChargesSection({ store, rows, canManage }: { store: { id: string; name: string }; rows: { option: ChargeOptionView; on: boolean }[]; canManage: boolean }) {
  const onCount = rows.filter((r) => r.on).length;
  return (
    <section data-charges className="space-y-3 rounded-lg border border-surface-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-medium">
          Charges at {store.name}{' '}
          <span className="ml-1 inline-flex rounded-full bg-canvas px-2 py-0.5 text-xs font-normal text-muted">
            {onCount} of {rows.length} on
          </span>
        </h2>
      </div>
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        Which of the brand&apos;s charges a cashier at {store.name} can add to a bill. Any cashier can add or remove one on a bill. A change reaches the tablet after its next
        refresh. The names and amounts are set once for all stores, in the list above.
      </p>
      {rows.length === 0 ? (
        <p className="text-sm text-neutral-600 dark:text-neutral-400">No charges yet. They are added once for all stores, in the list above.</p>
      ) : (
        <Table label={`Charges at ${store.name}`} card={{ title: 'Charge', subtitle: 'Amount', keys: ['Status'] }}>
          <thead>
            <tr>
              <Th>Charge</Th>
              <Th>Amount</Th>
              <Th>Status</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {rows.map(({ option, on }) => (
              <tr key={option.id} data-charge>
                <Td className="font-medium">{option.name}</Td>
                <Td className="tabular-nums">{chargeText(option, peso)}</Td>
                <Td>
                  {on ? (
                    <span className="inline-flex rounded-full bg-success-soft px-2 py-0.5 text-xs font-medium text-success">On</span>
                  ) : (
                    <span className="text-muted">Off</span>
                  )}
                </Td>
                <Td className="text-right whitespace-nowrap">
                  {canManage && (
                    <div data-card-ignore className="flex items-center justify-end">
                      <form action={setStoreChargeAction}>
                        <input type="hidden" name="storeId" value={store.id} />
                        <input type="hidden" name="chargeOptionId" value={option.id} />
                        <input type="hidden" name="on" value={on ? '0' : '1'} />
                        {on ? (
                          <ConfirmDestructive
                            tier="confirm"
                            quiet
                            label="Off"
                            consequence={`Switch ${option.name} off at ${store.name}? Cashiers stop seeing it after the tablet's next refresh. Past bills keep it.`}
                          />
                        ) : (
                          <Button type="submit" variant="secondary" aria-label={`Switch ${option.name} on at ${store.name}`}>
                            On
                          </Button>
                        )}
                      </form>
                    </div>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </section>
  );
}

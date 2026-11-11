import { POS_TILL_ADD_RULES, nativeAttrs } from '@shareat/domain/field-rules';
import { CheckedForm } from '@/components/forms';
import { Button, Field, FormGrid, Input, Select, Table, Td, Th } from '@/components/ui';
import { createTillAction, linkTillAction, setTillPrinterAction } from './actions';
import { nextFreeTillNo, type loadTills } from './lib';

/**
 * T-546 R4: the Tills section, rendered on `/admin/pos-tablets` (admins) and `/settings/pos-tablet` (a store's manager, their store only).
 * One component for both: `returnTo` says which page the actions send the person back to. The caller has already authorized at the store
 * (`loadTills` is `listPosTerminals`, which checks `pair_pos_tablet` there); the actions check it again.
 */
export function TillsSection({ store, tills, returnTo }: { store: { id: string; name: string }; tills: Awaited<ReturnType<typeof loadTills>>; returnTo: string }) {
  const nextTillNo = nextFreeTillNo(tills.terminals.map((t) => t.terminalNo));
  return (
    <section data-tills className="space-y-3 rounded-lg border border-surface-border p-4">
      <h2 className="font-medium">Tills</h2>
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        A till keeps its number and its receipt printer settings when its tablet is replaced. Choose the tablet that acts as each till, and the
        paper and copies its printer uses. Tills stay for good, because receipts carry their number. A tablet picks up a change after its next refresh.
      </p>
      <p className="text-xs text-neutral-500 dark:text-neutral-400">One tablet per store. To replace it, un-pair the old tablet first.</p>
      {tills.terminals.length === 0 ? (
        <p className="text-sm text-neutral-600 dark:text-neutral-400">No till at {store.name} yet. Add till 1 below, then choose its tablet.</p>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Till</Th>
              <Th>Tablet</Th>
              <Th>Paper</Th>
              <Th>Copies</Th>
              <Th>Save</Th>
            </tr>
          </thead>
          <tbody>
            {tills.terminals.map((t) => (
              <tr key={t.id}>
                <Td className="font-medium">Till {t.terminalNo}</Td>
                <Td>
                  <form action={linkTillAction} className="flex flex-wrap items-center gap-2">
                    <input type="hidden" name="storeId" value={store.id} />
                    <input type="hidden" name="returnTo" value={returnTo} />
                    <input type="hidden" name="terminalId" value={t.id} />
                    <Select name="pairingId" defaultValue={t.pairingId ?? ''} aria-label={`Tablet for till ${t.terminalNo}`}>
                      <option value="">No tablet</option>
                      {t.pairingId && <option value={t.pairingId}>{t.pairingLabel}</option>}
                      {tills.freePairings.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label}
                        </option>
                      ))}
                    </Select>
                    <Button type="submit">Set tablet</Button>
                  </form>
                </Td>
                <Td>
                  <div role="radiogroup" aria-label={`Paper for till ${t.terminalNo}`} className="flex flex-wrap gap-x-4">
                    {([58, 80] as const).map((mm) => (
                      <label key={mm} className="inline-flex min-h-11 cursor-pointer items-center gap-2 text-sm text-ink">
                        <input type="radio" name="receiptPaperMm" value={mm} form={`printer-${t.id}`} defaultChecked={t.receiptPaperMm === mm} className="h-4 w-4 accent-ink" />
                        {mm} mm
                      </label>
                    ))}
                  </div>
                </Td>
                <Td>
                  <Select name="receiptCopies" form={`printer-${t.id}`} defaultValue={String(t.receiptCopies)} aria-label={`Copies for till ${t.terminalNo}`}>
                    {[1, 2, 3].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </Select>
                </Td>
                <Td>
                  <form id={`printer-${t.id}`} action={setTillPrinterAction}>
                    <input type="hidden" name="storeId" value={store.id} />
                    <input type="hidden" name="returnTo" value={returnTo} />
                    <input type="hidden" name="terminalId" value={t.id} />
                    <Button type="submit" variant="primary">
                      Save printer
                    </Button>
                  </form>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <CheckedForm rules={POS_TILL_ADD_RULES} action={createTillAction} className="space-y-3 text-sm">
        <input type="hidden" name="storeId" value={store.id} />
                    <input type="hidden" name="returnTo" value={returnTo} />
        <FormGrid layout="fields">
          <Field label="New till number (1 to 99)" width="short" rule={POS_TILL_ADD_RULES.terminalNo}>
            <Input {...nativeAttrs(POS_TILL_ADD_RULES.terminalNo)} defaultValue={nextTillNo} />
          </Field>
        </FormGrid>
        <Button type="submit" variant="primary">
          Add till
        </Button>
      </CheckedForm>
    </section>
  );
}

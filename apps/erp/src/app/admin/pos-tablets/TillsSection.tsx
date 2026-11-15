import { POS_TILL_ADD_RULES, nativeAttrs } from '@shareat/domain/field-rules';
import { CheckedForm } from '@/components/forms';
import { Badge, Button, DialogActions, Field, FormGrid, FormModal, Input, Select } from '@/components/ui';
import { createTillAction, linkTillAction, setTillPrinterAction } from './actions';
import { nextFreeTillNo, type loadTills } from './lib';

/**
 * T-546 R4 / T-582: the Cash registers section (code name: tills), rendered on `/admin/pos-tablets` (admins) and `/settings/pos-tablet` (a store's
 * manager, their store only). One component for both: `returnTo` says which page the actions send the person back to. The caller has already
 * authorized at the store (`loadTills` is `listPosTerminals`, which checks `pair_pos_tablet` there); the actions check it again.
 * T-582: one card per cash register (its tablet form and its printer form, each exactly as before); adding one is behind a header button.
 */
export function TillsSection({ store, tills, returnTo }: { store: { id: string; name: string }; tills: Awaited<ReturnType<typeof loadTills>>; returnTo: string }) {
  const nextTillNo = nextFreeTillNo(tills.terminals.map((t) => t.terminalNo));
  return (
    <section data-tills className="space-y-3 rounded-lg border border-surface-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-medium">Cash registers</h2>
        <FormModal trigger="+ Add cash register" title="Add a cash register" size="md">
          <CheckedForm rules={POS_TILL_ADD_RULES} action={createTillAction} className="space-y-3 text-sm">
            <input type="hidden" name="storeId" value={store.id} />
            <input type="hidden" name="returnTo" value={returnTo} />
            <FormGrid layout="fields">
              <Field label="Cash register number (1 to 99)" width="short" rule={POS_TILL_ADD_RULES.terminalNo}>
                <Input {...nativeAttrs(POS_TILL_ADD_RULES.terminalNo)} defaultValue={nextTillNo} />
              </Field>
            </FormGrid>
            <DialogActions>
              <Button type="submit" variant="primary">
                Add cash register
              </Button>
            </DialogActions>
          </CheckedForm>
        </FormModal>
      </div>
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        A cash register keeps its number and its receipt printer settings when its tablet is replaced. Choose the tablet that acts as each cash
        register, and the paper and copies its printer uses. Cash registers stay for good, because receipts carry their number. A tablet picks up a
        change after its next refresh.
      </p>
      <p className="text-xs text-neutral-500 dark:text-neutral-400">One tablet per store. To replace it, un-pair the old tablet first.</p>
      {tills.terminals.length === 0 ? (
        <p className="text-sm text-neutral-600 dark:text-neutral-400">No cash register at {store.name} yet. Add cash register 1, then choose its tablet.</p>
      ) : (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {tills.terminals.map((t) => (
            <li key={t.id} className="flex flex-col gap-4 rounded-[20px] border border-surface-border bg-surface p-4">
              <div className="flex items-start justify-between gap-3">
                <h3 className="text-base font-semibold text-ink">Cash register {t.terminalNo}</h3>
                {t.pairingId ? <Badge tone="success" label="Tablet set" /> : <Badge tone="warning" label="No tablet" />}
              </div>
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted">Tablet</p>
                <form action={linkTillAction} className="flex flex-wrap items-center gap-2">
                  <input type="hidden" name="storeId" value={store.id} />
                  <input type="hidden" name="returnTo" value={returnTo} />
                  <input type="hidden" name="terminalId" value={t.id} />
                  <Select name="pairingId" defaultValue={t.pairingId ?? ''} aria-label={`Tablet for cash register ${t.terminalNo}`}>
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
              </div>
              <div className="space-y-2 border-t border-surface-border pt-3">
                <p className="text-xs font-medium text-muted">Receipt printer</p>
                <div role="radiogroup" aria-label={`Paper for cash register ${t.terminalNo}`} className="flex flex-wrap gap-x-4">
                  {([58, 80] as const).map((mm) => (
                    <label key={mm} className="inline-flex min-h-11 cursor-pointer items-center gap-2 text-sm text-ink">
                      <input type="radio" name="receiptPaperMm" value={mm} form={`printer-${t.id}`} defaultChecked={t.receiptPaperMm === mm} className="h-4 w-4 accent-ink" />
                      {mm} mm
                    </label>
                  ))}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="inline-flex items-center gap-2 text-sm text-ink">
                    Copies
                    <Select name="receiptCopies" form={`printer-${t.id}`} defaultValue={String(t.receiptCopies)} aria-label={`Copies for cash register ${t.terminalNo}`}>
                      {[1, 2, 3].map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </Select>
                  </label>
                  <form id={`printer-${t.id}`} action={setTillPrinterAction}>
                    <input type="hidden" name="storeId" value={store.id} />
                    <input type="hidden" name="returnTo" value={returnTo} />
                    <input type="hidden" name="terminalId" value={t.id} />
                    <Button type="submit" variant="primary">
                      Save printer
                    </Button>
                  </form>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

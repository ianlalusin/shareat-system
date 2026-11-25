import Link from 'next/link';
import { formatBusinessDayLong } from '@shareat/core/datetime';
import { SLICER_RATE_RULES, nativeAttrs } from '@shareat/domain/field-rules';
import { storePageScope } from '../../../../lib/store-scope';
import { currentPeriod, periodsForMonth, peso, premiumSettingsFor } from '../../../payroll/lib';
import { saveSlicerRateAction } from './actions';
import { slicerPayData } from './lib';
import { Page } from '@/components/shell/Page';
import { Banner, Button, DialogActions, Field, FlashBanner, FormGrid, FormModal, Input, NumTd, Select, Table, Td, Th } from '@/components/ui';
import { CheckedForm } from '@/components/forms';
import { withFlash } from '@/lib/flash';
import { NAV_LINK } from '@/components/action-link';

export const metadata = { title: 'Slicer pay — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  store?: string;
  /** `start|end` from the period picker, same as the payroll screen. */
  period?: string;
  start?: string;
  end?: string;
  ok?: string;
  error?: string;
}

/**
 * Slicer pay. T-635. Per slicer, for a period: how many records still wait for a second person to confirm them, the kilograms and amount
 * that are confirmed and due, and what was already paid. The pay itself goes out with payroll (the pay run adds it to the payslip).
 */
export default async function SlicerPayPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await withFlash(searchParams);
  const scope = await storePageScope('/inventory/production/slicer-pay', sp.store);
  if ('refusal' in scope) return scope.refusal;
  const { actor, stores, storeId } = scope;
  if (!storeId) {
    return (
      <Page density="table" title="Slicer pay">
        <p className="text-sm text-neutral-600">This organisation has no stores yet.</p>
      </Page>
    );
  }

  // The store's own pay periods, exactly as the payroll screen offers them.
  const cfg = await premiumSettingsFor(actor, storeId);
  const periodOptions = cfg ? periodsForMonth(cfg) : [];
  const fallback = cfg ? currentPeriod(cfg) : { start: '', end: '', label: '' };
  const picked = sp.period?.split('|') ?? [];
  const periodStart = (picked[0] || sp.start || fallback.start) as string;
  const periodEnd = (picked[1] || sp.end || fallback.end) as string;

  const { overview, rates, slicedItems, canSetRate } = periodStart && periodEnd
    ? await slicerPayData(actor, storeId, periodStart, periodEnd)
    : { overview: { rows: [], problems: [] as string[] }, rates: [], slicedItems: [], canSetRate: false };

  return (
    <Page
      density="table"
      title="Slicer pay"
      description={
        <>
          A slicer records the run; another staff member checks it and confirms. Confirmed slicing is paid per kg of the paid lines, with the next pay run, as part of salary.
        </>
      }
      actions={
        <Link href={`/inventory/production?store=${storeId}`} className={NAV_LINK}>
          ← Production
        </Link>
      }
    >
      <form method="get">
        <FormGrid layout="fields">
          <Field label="Store" width="name">
            <Select name="store" defaultValue={storeId} className="w-full">
              {stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
          {periodOptions.length > 0 && (
            <Field label="Period" width="name">
              <Select name="period" defaultValue={`${periodStart}|${periodEnd}`} className="w-full">
                {periodOptions.map((p) => (
                  <option key={p.start} value={`${p.start}|${p.end}`}>
                    {p.label}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <div className="!flex-none self-end">
            <Button type="submit" variant="secondary" icon={null}>
              Show
            </Button>
          </div>
        </FormGrid>
      </form>

      <FlashBanner flash={sp} />
      {overview.problems.length > 0 && (
        <Banner tone="error">
          <strong>Some slicing cannot be priced:</strong> {overview.problems.join(' ')}
        </Banner>
      )}

      <section className="space-y-3">
        <h2 className="text-sm font-medium">
          {formatBusinessDayLong(periodStart)} to {formatBusinessDayLong(periodEnd)}
        </h2>
        {overview.rows.length === 0 ? (
          <p className="rounded-[20px] border border-dashed border-surface-border p-6 text-center text-sm text-muted">
            No posted slicing in these dates names a slicer.
          </p>
        ) : (
          <Table card={{ title: 'Slicer', keys: ['Amount due', 'Waiting to be confirmed'] }}>
            <thead>
              <tr>
                <Th>Slicer</Th>
                <Th numeric>Waiting to be confirmed</Th>
                <Th numeric>Confirmed kg</Th>
                <Th numeric>Amount due</Th>
                <Th numeric>Already paid</Th>
              </tr>
            </thead>
            <tbody>
              {overview.rows.map((r) => (
                <tr key={r.personId}>
                  <Td>{r.personName}</Td>
                  <NumTd>{r.unconfirmed}</NumTd>
                  <NumTd className="font-mono">{r.confirmedKg}</NumTd>
                  <NumTd className="font-mono font-semibold">{peso(Number(r.amountDue))}</NumTd>
                  <NumTd className="font-mono text-muted">
                    {r.paidRecords > 0 ? `${peso(Number(r.paidAmount))} (${r.paidRecords})` : '—'}
                  </NumTd>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <p className="text-xs text-muted">
          Only confirmed records count. An unconfirmed one waits for a later run. Open the record on the Production screen to confirm it (not the slicer who made it).
        </p>
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-medium">Slicer pay rates (per kg)</h2>
          {canSetRate && (
            <FormModal trigger="Set a rate" triggerVariant="secondary" title="Set a slicer rate" description="Takes effect from the date below. An earlier rate is never changed." size="sm">
              <CheckedForm rules={SLICER_RATE_RULES} action={saveSlicerRateAction}>
                <input type="hidden" name="storeId" value={storeId} />
                <FormGrid layout="fields">
                  <Field label="Applies to" width="name">
                    <Select name="itemId" defaultValue="" className="w-full">
                      <option value="">All sliced products (default)</option>
                      {slicedItems.map((i) => (
                        <option key={i.id} value={i.id}>
                          Only {i.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Rate per kg" width="short" rule={SLICER_RATE_RULES.ratePerKg}>
                    <Input {...nativeAttrs(SLICER_RATE_RULES.ratePerKg)} placeholder="0.00" autoComplete="off" className="w-full" />
                  </Field>
                  <Field label="From" width="date" rule={SLICER_RATE_RULES.effectiveFrom}>
                    <Input {...nativeAttrs(SLICER_RATE_RULES.effectiveFrom)} defaultValue={periodStart} className="w-full" />
                  </Field>
                </FormGrid>
                <DialogActions>
                  <Button type="submit" variant="secondary">
                    Save
                  </Button>
                </DialogActions>
              </CheckedForm>
            </FormModal>
          )}
        </div>
        {rates.length === 0 ? (
          <Banner tone="warning">No slicer rate is set yet, so confirmed slicing cannot be paid. {canSetRate ? 'Set the default rate above.' : 'Ask an administrator to set it.'}</Banner>
        ) : (
          <Table card={{ title: 'Applies to', keys: ['Rate per kg', 'From'] }}>
            <thead>
              <tr>
                <Th>Applies to</Th>
                <Th numeric>Rate per kg</Th>
                <Th>From</Th>
              </tr>
            </thead>
            <tbody>
              {rates.map((r) => (
                <tr key={r.id}>
                  <Td>{r.itemName ?? 'All sliced products (default)'}</Td>
                  <NumTd className="font-mono">{peso(Number(r.ratePerKg))}</NumTd>
                  <Td>{formatBusinessDayLong(r.effectiveFrom)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <p className="text-xs text-muted">A product with its own rate in force is paid at that rate; every other sliced product is paid at the default.</p>
      </section>
    </Page>
  );
}

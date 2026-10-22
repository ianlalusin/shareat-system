import Link from 'next/link';
import { countsRegister, listStores } from './lib';
import { openCountSessionAction } from './actions';
import { requireSession } from '../../../lib/session';
import { Page } from '@/components/shell/Page';
import { Badge, Button, FlashBanner, FormGrid, Field, Input, LinkRow, RowLink, Select, statusTone } from '@/components/ui';
import { CheckedForm } from '@/components/forms';
import { INVENTORY_COUNT_OPEN_RULES, nativeAttrs } from '@shareat/domain/field-rules';
import { FilterRow } from '@/components/FilterRow';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';

export const metadata = { title: 'Physical counts — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  store?: string;
  ok?: string;
  error?: string;
}

const STATUS_LABEL: Record<string, string> = {
  open: 'Open — no lines counted yet',
  counting: 'Counting',
  reviewing: 'Reviewing',
  closed: 'Closed',
  cancelled: 'Cancelled',
};

function when(d: Date): string {
  return new Date(d).toLocaleString('en-PH', { timeZone: 'Asia/Manila' });
}

function today(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
}

export default async function CountsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await withFlash(searchParams);
  const { actor } = await requireSession('/inventory/counts');
  const stores = await listStores(actor.orgId);
  const storeId = sp.store && stores.some((s) => s.id === sp.store) ? sp.store : stores[0]?.id;

  if (!storeId) {
    return (
      <Page density="table" className="">
        <h1 className="text-2xl font-semibold">Physical counts</h1>
        <p className="mt-4 text-sm text-neutral-600">This organisation has no stores yet.</p>
      </Page>
    );
  }

  const { locations, sessions } = await countsRegister(actor.orgId, storeId);

  return (
    <Page density="table">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <h1 className="text-2xl font-semibold">Physical counts</h1>
        <Link href="/inventory" className="text-sm underline underline-offset-4">
          ← Stock on hand
        </Link>
      </div>
      <PageDescription>
        Freeze a room, count it, and the difference between what was counted and what the ledger said
        posts to <strong>stock count differences</strong> at FIFO cost — the gap v1 never closed.
      </PageDescription>

      <FlashBanner flash={sp} />

      <FilterRow>
        <label className="text-sm">
          <span className="block text-neutral-600 dark:text-neutral-400">Store</span>
          <Select name="store" defaultValue={storeId} className="mt-1">
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.code})
              </option>
            ))}
          </Select>
        </label>
      </FilterRow>

      <section className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="font-medium">Open a count</h2>
        <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
          Every room ticked freezes the moment you submit — usage, wastage, transfers and receipts into
          it are refused until this count is committed or cancelled.
        </p>
        {locations.length === 0 ? (
          <p className="mt-3 text-sm text-warning-ink">This store has no active rooms yet.</p>
        ) : (
          <CheckedForm rules={INVENTORY_COUNT_OPEN_RULES} action={openCountSessionAction} className="mt-3 space-y-3">
            <input type="hidden" name="storeId" value={storeId} />
            <fieldset className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {locations.map((l) => (
                <label key={l.id} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="locationIds" value={l.id} disabled={l.frozen} />
                  <span>{l.name}</span>
                  {l.frozen && (
                    <span className="rounded bg-warning-soft px-1.5 py-0.5 text-xs text-warning-ink">
                      frozen — already counting
                    </span>
                  )}
                </label>
              ))}
            </fieldset>
            <FormGrid>
              <Field label="Counted on" className="text-xs text-neutral-600 dark:text-neutral-400" rule={INVENTORY_COUNT_OPEN_RULES.countedOn}>
                <Input {...nativeAttrs(INVENTORY_COUNT_OPEN_RULES.countedOn)} type="date" defaultValue={today()} className="mt-1 block w-full" />
              </Field>
              <Field label="Note (optional)" span="wide" className="text-xs text-neutral-600 dark:text-neutral-400">
                <Input name="note" className="mt-1 block w-full" />
              </Field>
            </FormGrid>
            <Button type="submit" variant="primary">
              Open count
            </Button>
          </CheckedForm>
        )}
      </section>

      <section>
        <h2 className="text-lg font-medium">Sessions</h2>
        {sessions.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">No counts recorded for this store yet.</p>
        ) : (
          <table className="mt-3 w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-neutral-300 text-left dark:border-neutral-700">
                <th className="py-2 pr-4 font-medium">Rooms</th>
                <th className="py-2 pr-4 font-medium">Counted on</th>
                <th className="py-2 pr-4 font-medium">Status</th>
                <th className="py-2 pr-4 font-medium">Lines</th>
                <th className="py-2 font-medium">Opened</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <LinkRow key={s.id} className="border-b border-neutral-200 align-top dark:border-neutral-800">
                  <td className="py-2 pr-4">
                    <RowLink href={`/inventory/counts/${s.id}`}>
                      {s.locations.map((l) => l.name).join(', ') || '—'}
                    </RowLink>
                    {s.note && <div className="text-xs text-neutral-500">{s.note}</div>}
                  </td>
                  <td className="py-2 pr-4 tabular-nums">{s.countedOn}</td>
                  <td className="py-2 pr-4">
                    <Badge tone={statusTone(s.status)} label={STATUS_LABEL[s.status] ?? s.status} />
                  </td>
                  <td className="py-2 pr-4 tabular-nums">{s.lineCount}</td>
                  <td className="py-2 text-xs text-neutral-500">
                    {s.openedByName} · {when(s.openedAt)}
                  </td>
                </LinkRow>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </Page>
  );
}

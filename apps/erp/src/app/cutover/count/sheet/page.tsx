import Link from 'next/link';
import { requirePageAccess } from '../../../../lib/page-access';
import { CONVERSION_DATE, listStores, loadRooms, loadSheetItems } from '../../lib';
import { Page } from '@/components/shell/Page';
import { ACTION_LINK } from '@/components/action-link';
import { withFlash } from '@/lib/flash';

export const metadata = { title: 'Count sheet — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  store?: string;
  room?: string;
}

/** The count date: the day before the conversion date, e.g. 31 December 2026. */
function countDateText(): string {
  const d = new Date(`${CONVERSION_DATE}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

const BLANK_ROWS = 10;

/**
 * T-390 S5: the printable count sheet, one section per room (or one room).
 *
 * ⛔ A BLIND COUNT. The sheet lists what has moved in the room lately and leaves the quantity box empty. It reads no quantity
 * from the ledger, so it cannot tell the counter what he is "supposed" to find.
 */
export default async function CountSheetPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await withFlash(searchParams);
  const { actor, refusal } = await requirePageAccess('/cutover/count/sheet');
  if (refusal) return refusal;
  const stores = await listStores(actor.orgId);
  const store = stores.find((s) => s.id === sp.store) ?? stores[0];
  if (!store) {
    return (
      <Page density="table" className="">
        <p className="text-sm">There are no stores to count yet.</p>
      </Page>
    );
  }

  const allRooms = await loadRooms(actor.orgId, store.id);
  const chosen = allRooms.find((r) => r.id === sp.room);
  const rooms = chosen ? [chosen] : allRooms;
  const sections = await Promise.all(rooms.map(async (r) => ({ room: r, items: await loadSheetItems(actor.orgId, store.id, r.id) })));
  const date = countDateText();

  return (
    <Page density="table">
      <style>{`
        @media print {
          nav, header, aside, footer, .no-print { display: none !important; }
          .sheet-section { break-after: page; }
          .sheet-section:last-child { break-after: auto; }
          body { background: #fff !important; color: #000 !important; }
        }
      `}</style>

      <div className="no-print">
        <Link href={`/cutover/count?store=${store.id}`} className={`${ACTION_LINK} text-neutral-500 dark:text-neutral-400`}>
          ← Back to the count
        </Link>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          Print this page (Ctrl+P). Navigation is hidden on paper.
        </p>
      </div>

      {sections.length === 0 && <p className="text-sm">This store has no stock rooms.</p>}

      {sections.map(({ room, items }, n) => (
        <section key={room.id} className="sheet-section space-y-3">
          <header>
            <h1 className="text-xl font-semibold">
              {store.name} — {room.name} ({room.code})
            </h1>
            <p className="text-sm">
              Count date: {date} · Room {n + 1} of {sections.length}
            </p>
          </header>

          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-neutral-400 text-left">
                <th className="py-1 pr-2">Code</th>
                <th className="py-1 pr-2">Item</th>
                <th className="py-1 pr-2">Unit</th>
                <th className="py-1 pr-2">Bought as</th>
                <th className="w-28 py-1 pr-2">Qty</th>
                <th className="w-40 py-1">Remarks</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.code} className="border-b border-neutral-300">
                  <td className="py-2 pr-2 font-mono text-xs">{i.code}</td>
                  <td className="py-2 pr-2">{i.name}</td>
                  <td className="py-2 pr-2">{i.baseUnit}</td>
                  <td className="py-2 pr-2 text-xs">{i.purchaseHint ?? ''}</td>
                  <td className="py-2 pr-2" />
                  <td className="py-2" />
                </tr>
              ))}
            </tbody>
          </table>
          {items.length === 0 && <p className="text-xs">Nothing has moved in this room in the last 90 days. Use the blank rows.</p>}

          <h2 className="pt-2 text-sm font-medium">Found here, not listed</h2>
          <table data-card-columns="Item|Unit|Count" className="w-full border-collapse text-sm">
            <tbody>
              {Array.from({ length: BLANK_ROWS }, (_, k) => (
                <tr key={k} className="border-b border-neutral-300">
                  <td className="h-8 w-1/2 pr-2" />
                  <td className="h-8 w-28 pr-2" />
                  <td className="h-8" />
                </tr>
              ))}
            </tbody>
          </table>

          <footer className="grid grid-cols-3 gap-4 pt-4 text-sm">
            <div className="border-t border-neutral-500 pt-1">Counted by</div>
            <div className="border-t border-neutral-500 pt-1">Checked by</div>
            <div className="border-t border-neutral-500 pt-1">Time</div>
          </footer>
        </section>
      ))}
    </Page>
  );
}

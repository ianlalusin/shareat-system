'use client';

/**
 * T-531 R6 - the Till tab's client half: it hands TillPanel the three online doors (Z, close by day, Resend), the printer and an id maker, and reloads the page's
 * figures after a write. Closing the day is an API call, not an outbox event: it needs the internet and the shell's `online` says whether this tablet has it.
 * Nothing here logs or keeps the manager's PIN: it goes straight into the request body of the one call.
 */
import { useRouter } from 'next/navigation';
import { formatZSlip } from '@/lib/pos-print';
import { printLines } from '@/lib/pos-print/adapter';
import { printSettingsOf } from '../_payment/logic';
import { usePos } from '../_shell/pos-context';
import { TillPanel, type CloseAnswer, type TillDeps, type TillHistoryRow } from './TillPanel';
import { zSlipView, type ReadingJson } from './slips';

interface Props {
  reading: ReadingJson;
  history: TillHistoryRow[];
  isManager: boolean;
  store: { name: string; vatRegistered: boolean; receiptPaperMm: 58 | 80; receiptCopies: number };
  cashierName: string;
  tillCountsHref: string;
}

async function post(url: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}
const failed = (json: Record<string, unknown>, fallback: string): CloseAnswer => ({ ok: false, error: typeof json.error === 'string' ? json.error : fallback });

export function TillView({ reading, history, isManager, store, cashierName, tillCountsHref }: Props) {
  const router = useRouter();
  const pos = usePos();
  const { layout, copies } = printSettingsOf(store);
  const deps: TillDeps = {
    postClose: async (body) => {
      const { json } = await post('/api/pos/day-close', body);
      if (json.ok !== true) return failed(json, 'The day could not be closed.');
      const r = json as unknown as { dayCloseId: string; zNo: number; businessDate: string; reading: ReadingJson; closedByName: string; approvedByName: string };
      const slip = formatZSlip(zSlipView(r.reading, { storeName: store.name, vatRegistered: store.vatRegistered, printedBy: r.closedByName }, { zNo: r.zNo, businessDate: r.businessDate, approvedBy: r.approvedByName, reprint: false }), layout);
      router.refresh();
      return { ok: true, dayCloseId: r.dayCloseId, zNo: r.zNo, slip };
    },
    postBacklog: async (body) => {
      const { json } = await post('/api/pos/day-close/backlog', body);
      if (json.ok !== true) return failed(json, 'The days could not be closed.');
      const closes = (json.closes as { dayCloseId: string; zNo: number }[]) ?? [];
      router.refresh();
      // Each earlier day's Z-slip is printed from Recent closes (Reprint): the run writes several Zs, and one sheet cannot show them all.
      return { ok: true, dayCloseId: closes[closes.length - 1]?.dayCloseId, zNo: closes[closes.length - 1]?.zNo ?? 0, slip: [] };
    },
    postResend: async (businessDate) => {
      const { json } = await post('/api/pos/day-close/resend-v1', { businessDate });
      if (json.ok === true) router.refresh();
      return json.ok === true ? { ok: true } : { ok: false, error: typeof json.error === 'string' ? json.error : 'v1 could not be reached. Try again.' };
    },
    print: (lines) => printLines(lines, { copies }), // the till's own copy count (T-546), as Payment's receipt does
    newId: () => globalThis.crypto.randomUUID(),
  };
  return <TillPanel reading={reading} history={history} online={pos?.online ?? true} isManager={isManager} layout={layout} store={store} cashierName={cashierName} tillCountsHref={tillCountsHref} deps={deps} />;
}

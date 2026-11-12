// @vitest-environment happy-dom
/**
 * T-529 follow-up - the shell's two hooks, rendered for real in happy-dom with the device store and the printer replaced:
 *   use-outage-replay: an unloaded outbox never wipes the printed set; the replay prints once (across re-renders and offline switches); the printed-set is
 *     pruned only for events the outbox dropped.
 *   use-device-sync: `pendingLoaded` is false until the outbox has been read, and the whole outbox is read in one call, never cut off.
 */
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MENU, STORE } from './helpers/t529-fixtures';

const DEVICE = vi.hoisted(() => ({
  meta: new Map<string, unknown>(),
  outbox: [] as { seq: number; kind: string; personId: string; occurredAtDevice: string; payload: Record<string, unknown> }[],
  reads: [] as number[],
  failCounter: false,
  print: vi.fn(async (_l: string[], _o: { copies: number }): Promise<'printed' | 'failed'> => 'printed'),
}));
vi.mock('@/lib/pos-device', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getMeta: async (k: string) => (DEVICE.meta.get(k) as never) ?? null,
  setMeta: async (k: string, v: unknown) => {
    if (DEVICE.failCounter && k === 'app.kitchenTicketSeq') throw new Error('disk full');
    DEVICE.meta.set(k, v);
  },
  countPending: async () => DEVICE.outbox.length,
  listPending: async (limit: number) => {
    DEVICE.reads.push(limit);
    return DEVICE.outbox.slice(0, limit);
  },
  readSnapshot: async () => null,
  listVerifiers: async () => [],
}));
vi.mock('@/lib/pos-print/adapter', () => ({ printLines: (...a: [string[], { copies: number }]) => DEVICE.print(...a), printerMode: () => 'browser' }));

import { outageNotice, reportOutage } from '../src/app/pos/_kitchen/outage-jobs';
import { useOutageReplay } from '../src/app/pos/_kitchen/use-outage-replay';
import { useDeviceSync, type DeviceSync } from '../src/app/pos/_shell/use-device-sync';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  DEVICE.meta.clear();
  DEVICE.outbox = [];
  DEVICE.reads = [];
  DEVICE.failCounter = false;
  DEVICE.print.mockClear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  vi.stubGlobal('fetch', async () => {
    throw new Error('offline');
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 20))));

const SNAP = { stands: [{ id: STORE, number: 7 }], menu: MENU, payment: { store: { storeId: STORE, name: 'Lipa', terminalNo: 2, vatRegistered: true, receiptPaperMm: 58, receiptCopies: 1 }, tenders: [], discountPresets: [], rules: { vatPercentBasisPoints: 1200, scPwdPercentBasisPoints: 2000 }, staff: [] } };
const ORDER = (seq: number) => ({ seq, kind: 'lines.added' as const, personId: 'p', occurredAtDevice: '2026-11-07T11:59:00.000Z', payload: { sessionId: 's1', lines: [{ lineId: `l${seq}`, menuItemId: MENU.items[0]!.id, qty: 1, addedAtDevice: '2026-11-07T11:59:00.000Z' }] } });

type ReplayProps = Parameters<typeof useOutageReplay>[0];
const base: ReplayProps = { paired: true, online: true, snapshot: SNAP as never, pending: [], loaded: true, openStands: [] };
function Replay(p: ReplayProps) {
  useOutageReplay(p);
  return null;
}
const replay = (o: Partial<ReplayProps>) => act(async () => root.render(createElement(Replay, { ...base, ...o })));

describe('use-outage-replay', () => {
  it('an order saved while online prints when the shell goes offline, exactly once, and never again on a second offline switch or a re-render', async () => {
    const e = [ORDER(1)] as never;
    await replay({ pending: e });
    await settle();
    expect(DEVICE.print).not.toHaveBeenCalled();
    await replay({ pending: e, online: false });
    await settle();
    expect(DEVICE.print).toHaveBeenCalledTimes(1);
    await replay({ pending: e, online: false, openStands: [] }); // a re-render offline
    await replay({ pending: e, online: true });
    await replay({ pending: e, online: false }); // the second offline switch
    await settle();
    expect(DEVICE.print).toHaveBeenCalledTimes(1);
    expect(DEVICE.meta.get('app.outagePrinted')).toEqual([1]);
  });

  it('an outbox that is not loaded yet never wipes the printed set (the list is empty only because nothing was read)', async () => {
    DEVICE.meta.set('app.outagePrinted', [1, 2]);
    await replay({ pending: [], loaded: false, online: false });
    await settle();
    expect(DEVICE.meta.get('app.outagePrinted')).toEqual([1, 2]);
    expect(DEVICE.print).not.toHaveBeenCalled();
  });

  it('after the first read it keeps only what is still pending; later it forgets only what the outbox dropped', async () => {
    DEVICE.meta.set('app.outagePrinted', [1, 2, 3]);
    await replay({ pending: [ORDER(2), ORDER(3)] as never });
    await settle();
    expect(DEVICE.meta.get('app.outagePrinted')).toEqual([2, 3]);
    await replay({ pending: [ORDER(3)] as never }); // 2 was sent
    await settle();
    expect(DEVICE.meta.get('app.outagePrinted')).toEqual([3]);
    await replay({ pending: [ORDER(3), ORDER(4)] as never }); // 4 is new, not yet printed: nothing is dropped
    await settle();
    expect(DEVICE.meta.get('app.outagePrinted')).toEqual([3]);
  });

  it('T-561: a ticket that could not be printed is not marked printed, and the message reaches the screen state instead of being swallowed', async () => {
    DEVICE.failCounter = true;
    await replay({ pending: [ORDER(1)] as never, online: false });
    await settle();
    expect(DEVICE.print).not.toHaveBeenCalled();
    expect(DEVICE.meta.get('app.outagePrinted') ?? []).toEqual([]);
    expect(outageNotice()).not.toBeNull();
  });

  it('T-561 follow-up: a crash leftover whose ticket counter write fails keeps its seq in flight and the banner state names the table', async () => {
    DEVICE.failCounter = true;
    DEVICE.meta.set('app.outageInflight', [1]);
    await replay({ pending: [ORDER(1)] as never, online: false, openStands: [] });
    await settle();
    expect(DEVICE.meta.get('app.outageInflight')).toEqual([1]);
    expect(DEVICE.meta.get('app.outagePrinted') ?? []).toEqual([]);
    expect(outageNotice()).toContain('could not be rebuilt');
    expect(outageNotice()).toContain('event 1');
  });

  it('T-561 follow-up: after the Reprint job is saved, the stored reprint list (read back from the device store) holds it once, and reportOutage does not add a second copy', async () => {
    DEVICE.print.mockImplementation(async () => 'failed');
    await replay({ pending: [ORDER(1)] as never, online: false });
    await settle();
    const saved = DEVICE.meta.get('app.outageReprint') as unknown[];
    expect(saved).toHaveLength(1);
    expect(DEVICE.meta.get('app.outagePrinted')).toEqual([1]);
    reportOutage({ printed: 0, failed: [], message: null });
    await settle();
    expect(DEVICE.meta.get('app.outageReprint')).toHaveLength(1);
    DEVICE.print.mockImplementation(async () => 'printed');
  });

  it('a phone (not paired) never prints', async () => {
    await replay({ paired: false, online: false, pending: [ORDER(1)] as never });
    await settle();
    expect(DEVICE.print).not.toHaveBeenCalled();
  });
});

describe('use-device-sync pendingLoaded and paging', () => {
  let latest: DeviceSync | null = null;
  function Sync() {
    latest = useDeviceSync({ paired: true, personId: 'p', online: true });
    return null;
  }
  it('pendingLoaded is false until the outbox has been read, then true', async () => {
    latest = null;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => (release = r));
    const original = DEVICE.outbox;
    DEVICE.outbox = original;
    // hold the first read until the first render has been seen
    const mod = await import('@/lib/pos-device');
    const spy = vi.spyOn(mod, 'countPending').mockImplementation(async () => {
      await gate;
      return 0;
    });
    await act(async () => root.render(createElement(Sync)));
    expect(latest!.pendingLoaded).toBe(false);
    release?.();
    await settle();
    expect(latest!.pendingLoaded).toBe(true);
    spy.mockRestore();
  });

  it('reads the WHOLE outbox in one call (1,200 events come back in ONE read sized by the count, in order)', async () => {
    DEVICE.outbox = Array.from({ length: 1200 }, (_, i) => ORDER(i + 1)) as never;
    latest = null;
    await act(async () => root.render(createElement(Sync)));
    await settle();
    expect(latest!.pendingEvents).toHaveLength(1200);
    expect(latest!.pendingEvents[0]!.seq).toBe(1);
    expect(latest!.pendingEvents.at(-1)!.seq).toBe(1200);
    expect(DEVICE.reads.every((n) => n === 1200)).toBe(true);
    expect(DEVICE.reads.length).toBeGreaterThan(0);
  });
});

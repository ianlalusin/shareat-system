/**
 * T-563 (audit P-004) - the device and screen half: the batch carries its pairing, a good snapshot binds the tablet to its pairing, a held origin shows
 * the banner, and the pair / un-pair buttons are fenced while the outbox holds sales. docs/tasks/563-pos-pairing-boundary.md R1, R2, R4, R5.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';

const { dev } = vi.hoisted(() => ({
  dev: {
    saveSnapshot: vi.fn(async () => undefined),
    touchSnapshot: vi.fn(async () => undefined),
    readSnapshot: vi.fn(async (): Promise<unknown> => null),
    resumeAbove: vi.fn(async () => undefined),
    bindPairing: vi.fn(async (_id: string) => undefined),
    listVerifiers: vi.fn(async (): Promise<unknown[]> => []),
    deleteVerifier: vi.fn(async (_personId: string): Promise<void> => undefined),
    countPending: vi.fn(async (): Promise<number> => 0),
  },
}));
vi.mock('@/lib/pos-device', () => dev);

import { posHeldSalesMessage } from '@/app/pos/_shell/messages';
import { heldSalesCount, nextHeldOrigins } from '@/app/pos/_shell/held-sales';
import { makePosSend } from '@/app/pos/_shell/drain-send';
import { refreshSnapshot } from '@/app/pos/_shell/snapshot-sync';
import { FenceView } from '@/app/settings/pos-tablet/PendingSalesFence';
import { pendingSalesSentence } from '@/app/settings/pos-tablet/pending-sales';

const NOW = 1_800_000_000_000;
beforeEach(() => {
  for (const f of Object.values(dev)) f.mockClear();
  dev.readSnapshot.mockResolvedValue(null);
});

describe('T-563 R2 - the batch names the pairing it was made under', () => {
  const batch = [
    { seq: 4, pairingId: 'P1', kind: 'stand.opened', personId: 'p', occurredAtDevice: '2026-11-07T01:00:00.000Z', payload: {} },
    { seq: 5, pairingId: 'P1', kind: 'lines.added', personId: 'p', occurredAtDevice: '2026-11-07T01:00:00.000Z', payload: {} },
  ] as never;
  const asFetch = (f: unknown) => f as typeof fetch;
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

  it('POSTs { pairingId, events } with the pairing the events carry', async () => {
    const f = vi.fn(async () => json({ ok: true, stateVersion: 1, results: [] }));
    await makePosSend(asFetch(f))(batch);
    const [, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ pairingId: 'P1', events: batch });
  });

  it('a batch with no pairing is never posted', async () => {
    const f = vi.fn(async () => json({ ok: true, stateVersion: 1, results: [] }));
    const out = await makePosSend(asFetch(f))([{ seq: 4, kind: 'stand.opened', personId: 'p', occurredAtDevice: '2026-11-07T01:00:00.000Z', payload: {} }] as never);
    expect(f).not.toHaveBeenCalled();
    expect(out.kind).not.toBe('ok');
  });

  it("a 409 carries the server's code on; other statuses stay bare", async () => {
    expect(await makePosSend(asFetch(async () => json({ ok: false, error: 'x', code: 'POS_PAIRING_MISMATCH' }, 409)))(batch)).toEqual({ kind: 'http', status: 409, code: 'POS_PAIRING_MISMATCH' });
    expect(await makePosSend(asFetch(async () => json({ ok: false, error: 'x' }, 409)))(batch)).toEqual({ kind: 'http', status: 409 });
  });
});

describe('T-563 R1 - a good snapshot binds the tablet to its pairing', () => {
  const staff = [{ personId: 'p-ana', displayName: 'Ana Cruz', employeeId: '007', posCapabilities: ['record_sale'] }];
  const body = { ok: true, staff, device: { pairingId: 'pair-7', lastSeq: 1, lastTerminalSeq: 1 }, rules: null };
  it('a 200 binds device.pairingId; a failure, 304 or 401 binds nothing', async () => {
    const good = vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { etag: '"v1"' } }));
    await refreshSnapshot({ fetch: good as unknown as typeof fetch, nowMs: NOW });
    expect(dev.bindPairing).toHaveBeenCalledTimes(1);
    expect(dev.bindPairing).toHaveBeenCalledWith('pair-7');
    for (const status of [304, 401, 500]) {
      dev.bindPairing.mockClear();
      await refreshSnapshot({ fetch: (async () => new Response(null, { status })) as unknown as typeof fetch, nowMs: NOW });
      expect(dev.bindPairing, String(status)).not.toHaveBeenCalled();
    }
  });
});

describe('T-563 R4 - held sales and the banner', () => {
  const e = (seq: number, pairingId?: string) => ({ seq, pairingId, kind: 'lines.added', personId: 'p', occurredAtDevice: 'x', payload: {} }) as never;

  it('the sentence, singular and plural', () => {
    expect(posHeldSalesMessage(3)).toBe('3 sales from another store are waiting on this tablet. Pair it back to that store to send them, or ask a manager.');
    expect(posHeldSalesMessage(1)).toBe('1 sale from another store is waiting on this tablet. Pair it back to that store to send them, or ask a manager.');
  });

  it('counts only pending events of a held origin that is not the current pairing', () => {
    const events = [e(1, 'A'), e(2, 'A'), e(3, 'B'), e(4, 'CUR'), e(5)];
    expect(heldSalesCount(events, ['A'], 'CUR')).toBe(2);
    expect(heldSalesCount(events, ['A', 'CUR'], 'CUR')).toBe(2); // the current pairing is never "another store"
    expect(heldSalesCount(events, [], 'CUR')).toBe(0);
  });

  it('a drain that reached the end forgets what it did not hold again; one that stopped early keeps what it knew', () => {
    expect(nextHeldOrigins(['A'], { stopped: 'empty', heldOrigins: [] })).toEqual([]);
    expect(nextHeldOrigins(['A'], { stopped: 'empty', heldOrigins: ['B'] })).toEqual(['B']);
    expect(nextHeldOrigins(['A'], { stopped: 'network', heldOrigins: ['B'] }).sort()).toEqual(['A', 'B']);
  });

  it('the shell shows the banner from the hook', () => {
    const shell = readFileSync('apps/erp/src/app/pos/_shell/PosShell.tsx', 'utf8');
    expect(shell).toContain('posHeldSalesMessage(sync.heldSales)');
    const hook = readFileSync('apps/erp/src/app/pos/_shell/use-device-sync.ts', 'utf8');
    expect(hook).toContain('heldSalesCount(');
  });
});

describe('T-563 R5 - the pair and un-pair buttons are fenced while sales are unsent', () => {
  const view = (count: number | null) => renderToStaticMarkup(createElement(FenceView, { count, children: createElement('button', { type: 'submit' }, 'Pair this tablet') }));

  it('the sentence', () => {
    expect(pendingSalesSentence(4)).toBe('This tablet still has 4 unsent sales. Connect it to the internet and open the POS until they send, then pair again.');
    expect(pendingSalesSentence(1)).toBe('This tablet still has 1 unsent sale. Connect it to the internet and open the POS until they send, then pair again.');
  });

  it('with sales waiting: the controls are disabled and the sentence is on screen', () => {
    const html = view(2);
    expect(html).toMatch(/<fieldset[^>]*disabled/);
    expect(html).toContain(pendingSalesSentence(2));
  });

  it('with an empty outbox (or one not read yet): enabled, no sentence', () => {
    for (const c of [0, null]) {
      const html = view(c);
      expect(html).not.toMatch(/<fieldset[^>]*disabled/);
      expect(html).not.toContain('unsent');
    }
  });

  it('both forms on the page sit inside the fence', () => {
    const page = readFileSync('apps/erp/src/app/settings/pos-tablet/page.tsx', 'utf8');
    expect(page.match(/<PendingSalesFence>/g)?.length).toBe(2);
  });
});

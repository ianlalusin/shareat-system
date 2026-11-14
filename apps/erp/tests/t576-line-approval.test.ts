// @vitest-environment happy-dom
/**
 * T-576 - the till side of "manager PIN for a line cancel / line discount" (docs/tasks/576-pos-manager-pin-setting-line-actions.md as amended 13 Nov 2026).
 *   - the mode: rule off = nothing; rule on + online = ask for the manager PIN; rule on + offline = go ahead and flag it ("needs manager review", event carries offline: true);
 *   - online the till asks the server FIRST (POST /api/pos/line-approval): a wrong PIN comes back as the dialog's sentence and nothing is saved; a right one returns a token and the
 *     event carries `approval: { token, approverId, exp }` - the PIN is never in an event, so never in the tablet's outbox (IndexedDB);
 *   - the snapshot's rule reaches the Orders tab (false for a cached snapshot older than the rule);
 *   - the cancel dialog and the discount sheet render the PIN box / the review note / neither.
 * The server side (the gate, the audit row, the replay) is packages/domain/tests/integration/t576-line-action-pin.test.ts.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APPROVAL_UNREACHABLE, lineApprovalMode, PIN_NEEDED, resolveApproval, REVIEW_NOTE, type LineApprovalGrant } from '@/app/pos/_shell/line-approval';
import { bindPairing, enqueue } from '@/lib/pos-device';
import { OUTBOX_STORE } from '@/lib/pos-device/db';
import { createFakeIdb, type FakeIdbFactory } from './helpers/fake-idb';
import { cancelLineEvent } from '@/app/pos/_orders/payloads';
import { CancelLineDialog } from '@/app/pos/_orders/OrderDialogs';
import { applyToAllEvent, discountAddedEvent, discountRemovedEvent } from '@/app/pos/_payment/logic';
import { DiscountSheet } from '@/app/pos/_payment/DiscountSheet';
import { ManagerPinDialog } from '@/app/pos/_shell/LineApprovalField';
import { id } from './helpers/t527-menu';

const NOW = new Date('2026-11-13T09:00:00.000Z');
const P = id(1);
const L = id(2);

describe('T-576 till - the mode', () => {
  it('rule off, or an older snapshot that does not carry it: none, online or not', () => {
    for (const rule of [false, undefined, null]) for (const online of [true, false]) expect(lineApprovalMode(rule, online)).toBe('none');
  });
  it('rule on: pin while online, review while offline', () => {
    expect(lineApprovalMode(true, true)).toBe('pin');
    expect(lineApprovalMode(true, false)).toBe('review');
  });
});

const GRANT: LineApprovalGrant = { token: 'tok.abc', approverId: id(9), exp: 1_900_000_000_000 };
const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
const ask = (mode: 'none' | 'pin' | 'review', pin: string, f: typeof fetch) => resolveApproval({ mode, pin, action: 'line.cancelled', targetId: L, fetch: f });
const never = (async () => {
  throw new Error('no request expected');
}) as unknown as typeof fetch;

describe('T-576 till - asking the server first', () => {
  it('none: no fields and no request; review: offline: true and no request', async () => {
    expect(await ask('none', '1234', never)).toEqual({ fields: {} });
    expect(await ask('review', '1234', never)).toEqual({ fields: { offline: true } });
  });
  it('pin: a discount request carries its kind / preset / value / units so the server can bind the token to them', async () => {
    let body = '';
    const f = (async (_url: string, init: RequestInit) => {
      body = String(init.body);
      return new Response(JSON.stringify({ ok: true, ...GRANT }), { status: 200 });
    }) as unknown as typeof fetch;
    await resolveApproval({ mode: 'pin', pin: '4321', action: 'discount.added', targetId: L, detail: { kind: 'custom', valueType: 'percent', value: '10', qty: 1, presetId: undefined }, fetch: f });
    expect(JSON.parse(body)).toEqual({ pin: '4321', action: 'discount.added', targetId: L, kind: 'custom', valueType: 'percent', value: '10', qty: 1 });
  });
  it('pin: a right PIN gives the grant (token, approver, expiry) and nothing else; the request names the action and the target', async () => {
    let sent: { url: string; init: RequestInit } | undefined;
    const f = (async (url: string, init: RequestInit) => {
      sent = { url, init };
      return new Response(JSON.stringify({ ok: true, ...GRANT }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await ask('pin', '4321', f)).toEqual({ fields: { approval: GRANT } });
    expect(sent!.url).toBe('/api/pos/line-approval');
    expect(sent!.init.method).toBe('POST');
    expect(JSON.parse(String(sent!.init.body))).toEqual({ pin: '4321', action: 'line.cancelled', targetId: L });
  });
  it("pin: a wrong PIN returns the server's own sentence and no fields (so nothing is applied)", async () => {
    expect(await ask('pin', '0000', reply(401, { ok: false, error: 'That PIN cannot approve this. Ask a store manager.' }))).toEqual({ error: 'That PIN cannot approve this. Ask a store manager.' });
  });
  it('pin: no PIN typed is a sentence with no request; a network failure or an unreadable reply is the one "could not reach" sentence', async () => {
    expect(await ask('pin', '', never)).toEqual({ error: PIN_NEEDED });
    expect(await ask('pin', '4321', never)).toEqual({ error: APPROVAL_UNREACHABLE });
    expect(await ask('pin', '4321', reply(500, 'oops'))).toEqual({ error: APPROVAL_UNREACHABLE });
    expect(await ask('pin', '4321', reply(200, { ok: true }))).toEqual({ error: APPROVAL_UNREACHABLE });
  });
});

describe('T-576 till - the events', () => {
  it('a plain event (rule off) is byte for byte what it was: no approval, no offline', () => {
    expect(cancelLineEvent({ personId: P, lineId: L, reason: 'Wrong order', now: NOW }).payload).toEqual({ lineId: L, reason: 'Wrong order' });
    expect(Object.keys(discountRemovedEvent({ personId: P, now: NOW, discountId: id(3) }).payload).sort()).toEqual(['discountId', 'removedAtDevice']);
    expect(Object.keys(discountAddedEvent({ personId: P, now: NOW, discountId: id(3), lineId: L, kind: 'preset', qty: 1, presetId: id(4) }).payload).sort()).toEqual(['appliedAtDevice', 'discountId', 'kind', 'lineId', 'presetId', 'qty']);
    expect(Object.keys(applyToAllEvent({ personId: P, now: NOW, sessionId: id(5), presetId: id(4), applyId: id(6) }).payload).sort()).toEqual(['appliedAtDevice', 'applyId', 'presetId', 'sessionId']);
  });
  it('the four events carry the grant, or offline: true, when given', () => {
    const grant = { approval: GRANT };
    const off = { offline: true as const };
    expect(cancelLineEvent({ personId: P, lineId: L, reason: 'Wrong order', now: NOW, approval: grant }).payload.approval).toEqual(GRANT);
    expect(discountAddedEvent({ personId: P, now: NOW, discountId: id(3), lineId: L, kind: 'custom', qty: 1, valueType: 'percent', value: '10', approval: grant }).payload.approval).toEqual(GRANT);
    expect(discountRemovedEvent({ personId: P, now: NOW, discountId: id(3), approval: off }).payload.offline).toBe(true);
    expect(applyToAllEvent({ personId: P, now: NOW, sessionId: id(5), presetId: id(4), applyId: id(6), approval: off }).payload.offline).toBe(true);
  });
});

describe('T-576 till - the PIN never reaches the outbox (IndexedDB)', () => {
  let idb: FakeIdbFactory;
  beforeEach(async () => {
    idb = createFakeIdb({ commitDelayMs: 2 });
    vi.stubGlobal('indexedDB', idb);
    await bindPairing('pair-1');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  it('a PIN typed for a cancel goes to the server and the stored event holds the token only [kills: the PIN riding in the event]', async () => {
    const PIN = '987654';
    const out = await resolveApproval({ mode: 'pin', pin: PIN, action: 'line.cancelled', targetId: L, fetch: reply(200, { ok: true, ...GRANT }) });
    expect('fields' in out).toBe(true);
    await enqueue(cancelLineEvent({ personId: P, lineId: L, reason: 'Wrong order', now: NOW, approval: 'fields' in out ? out.fields : {} }));
    const rows = idb.rows(OUTBOX_STORE);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(PIN);
    expect(rows[0].payload.approval).toEqual(GRANT);
  });
});

describe('T-576 till - the dialogs', () => {
  const cancel = (mode: 'none' | 'pin' | 'review') => renderToStaticMarkup(createElement(CancelLineDialog, { lineName: '2 × Pork belly', approvalMode: mode, onClose: () => undefined, onConfirm: async () => null }));
  it('the cancel dialog: a PIN box in pin mode, the review note in review mode, neither when the rule is off', () => {
    expect(cancel('pin')).toContain('Manager PIN');
    expect(cancel('pin')).toContain('type="password"');
    expect(cancel('review')).toContain(REVIEW_NOTE);
    expect(cancel('review')).not.toContain('type="password"');
    expect(cancel('none')).not.toContain('Manager PIN');
    expect(cancel('none')).not.toContain(REVIEW_NOTE);
  });

  const sheet = (mode: 'none' | 'pin' | 'review') =>
    renderToStaticMarkup(createElement(DiscountSheet, { target: { kind: 'all' }, bill: [], heads: 2, presets: [{ id: id(4), name: 'Employee 10%', valueType: 'percent', value: '10' }], approvalMode: mode, onClose: () => undefined, onAdd: async () => null, onApplyAll: async () => null }));
  it('the discount sheet shows no PIN box until a discount is chosen (nothing to approve yet)', () => {
    expect(sheet('pin')).not.toContain('type="password"');
  });

  it('the remove-discount prompt is a manager PIN box with its own button', () => {
    const html = renderToStaticMarkup(createElement(ManagerPinDialog, { title: 'Remove this discount?', description: 'A manager PIN is needed to remove a discount.', confirmLabel: 'Remove discount', onClose: () => undefined, onConfirm: async () => null }));
    expect(html).toContain('Manager PIN');
    expect(html).toContain('Remove discount');
  });
});

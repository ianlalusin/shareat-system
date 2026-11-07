/**
 * T-529 (TESTER) - R1 "On the store tablet" and R2 "Writes": which buttons a person gets on Kitchen and Refills, and the two offline sentences.
 * docs/tasks/529-pos-kitchen-refills.md. Pure functions. `held` is the set of capability names the signed-in person holds at the store.
 *
 * ASSUMED API:
 *   apps/erp/src/app/pos/_kitchen/access.ts
 *     kitchenAccess({ held: ReadonlySet<string>; paired: boolean; online: boolean }): { canServe: boolean; note: string | null }
 *       canServe = holds serve_pos_ticket AND online (there is no `line.served` outbox kind, T-525 R3: serving is online only).
 *       note = KITCHEN_OFFLINE_NOTE when a paired tablet is offline, else null.
 *   apps/erp/src/app/pos/_refills/access.ts
 *     refillAccess({ held, paired, online }): { canAsk: boolean; canServe: boolean; canConfirmHeads: boolean; note: string | null }
 *       phone (paired=false): canAsk = request_pos_refill AND online; canServe = serve_pos_ticket AND online; canConfirmHeads = confirm_pos_heads AND online;
 *         offline: note = REFILLS_PHONE_OFFLINE_NOTE.
 *       store tablet (paired=true): canAsk = request_pos_refill (online OR offline: it goes through the outbox); canServe = serve_pos_ticket AND online;
 *         canConfirmHeads = false always (the tablet uses heads.set); note null.
 *
 * RED NOW FOR THE RIGHT REASON: the modules do not exist (lazy import: "MISSING MODULE ... not built").
 */
import { describe, expect, it } from 'vitest';

async function load(path: string): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any -- the modules under test do not exist yet
  try {
    return await import(/* @vite-ignore */ `../src/app/pos/${path}`);
  } catch (e) {
    throw new Error(`MISSING MODULE: apps/erp/src/app/pos/${path} cannot be loaded (T-529 not built): ${String((e as Error).message).slice(0, 160)}`);
  }
}
const held = (...caps: string[]) => new Set(caps);
const KITCHEN_OFFLINE = 'The kitchen screen updates when the internet is back. Use the printed tickets.';
const REFILLS_PHONE_OFFLINE = 'Refills need the internet on this phone. Ask at the till.';

describe('Kitchen access', () => {
  it('a kitchen browser (not paired) online with serve_pos_ticket can serve; no note', async () => {
    const { kitchenAccess } = await load('_kitchen/access');
    expect(kitchenAccess({ held: held('serve_pos_ticket'), paired: false, online: true })).toEqual({ canServe: true, note: null });
  });
  it('the store tablet online with serve_pos_ticket can serve', async () => {
    const { kitchenAccess } = await load('_kitchen/access');
    expect(kitchenAccess({ held: held('serve_pos_ticket', 'record_sale'), paired: true, online: true })).toEqual({ canServe: true, note: null });
  });
  it('the store tablet, a person WITHOUT serve_pos_ticket: read-only (no Served buttons)', async () => {
    const { kitchenAccess } = await load('_kitchen/access');
    expect(kitchenAccess({ held: held('record_sale', 'request_pos_refill'), paired: true, online: true }).canServe).toBe(false);
  });
  it('a kitchen browser without serve_pos_ticket is read-only too (every ✅ has its ✗)', async () => {
    const { kitchenAccess } = await load('_kitchen/access');
    expect(kitchenAccess({ held: held(), paired: false, online: true }).canServe).toBe(false);
  });
  it('the store tablet OFFLINE cannot serve even with the capability, and says the exact sentence', async () => {
    const { kitchenAccess } = await load('_kitchen/access');
    expect(kitchenAccess({ held: held('serve_pos_ticket'), paired: true, online: false })).toEqual({ canServe: false, note: KITCHEN_OFFLINE });
  });
  it('the note constant is exported with the same words', async () => {
    const m = await load('_kitchen/access');
    expect(m.KITCHEN_OFFLINE_NOTE).toBe(KITCHEN_OFFLINE);
  });
});

describe('Refills access', () => {
  it('a server\'s phone online: can ask and confirm heads, cannot serve (0240: Server has no serve_pos_ticket)', async () => {
    const { refillAccess } = await load('_refills/access');
    expect(refillAccess({ held: held('request_pos_refill', 'confirm_pos_heads'), paired: false, online: true })).toEqual({ canAsk: true, canServe: false, canConfirmHeads: true, note: null });
  });
  it('a phone person without confirm_pos_heads cannot confirm heads (a cashier on everyday access only)', async () => {
    const { refillAccess } = await load('_refills/access');
    expect(refillAccess({ held: held('request_pos_refill', 'record_sale'), paired: false, online: true }).canConfirmHeads).toBe(false);
  });
  it('a phone person without request_pos_refill cannot ask', async () => {
    const { refillAccess } = await load('_refills/access');
    expect(refillAccess({ held: held('confirm_pos_heads'), paired: false, online: true }).canAsk).toBe(false);
  });
  it('a phone with serve_pos_ticket gets the Served button', async () => {
    const { refillAccess } = await load('_refills/access');
    expect(refillAccess({ held: held('request_pos_refill', 'serve_pos_ticket'), paired: false, online: true }).canServe).toBe(true);
  });
  it('a phone OFFLINE can do nothing and says the exact sentence', async () => {
    const { refillAccess } = await load('_refills/access');
    expect(refillAccess({ held: held('request_pos_refill', 'confirm_pos_heads', 'serve_pos_ticket'), paired: false, online: false })).toEqual({
      canAsk: false, canServe: false, canConfirmHeads: false, note: REFILLS_PHONE_OFFLINE,
    });
  });
  it('the store tablet can ask for a refill ONLINE and OFFLINE (outbox), never confirms heads, even holding confirm_pos_heads', async () => {
    const { refillAccess } = await load('_refills/access');
    const caps = held('request_pos_refill', 'confirm_pos_heads', 'record_sale');
    expect(refillAccess({ held: caps, paired: true, online: true })).toEqual({ canAsk: true, canServe: false, canConfirmHeads: false, note: null });
    expect(refillAccess({ held: caps, paired: true, online: false })).toEqual({ canAsk: true, canServe: false, canConfirmHeads: false, note: null });
  });
  it('the store tablet serves a refill only online, and only with serve_pos_ticket', async () => {
    const { refillAccess } = await load('_refills/access');
    const caps = held('request_pos_refill', 'serve_pos_ticket');
    expect(refillAccess({ held: caps, paired: true, online: true }).canServe).toBe(true);
    expect(refillAccess({ held: caps, paired: true, online: false }).canServe).toBe(false);
    expect(refillAccess({ held: held('request_pos_refill'), paired: true, online: true }).canServe).toBe(false);
  });
  it('the note constant is exported with the same words', async () => {
    const m = await load('_refills/access');
    expect(m.REFILLS_PHONE_OFFLINE_NOTE).toBe(REFILLS_PHONE_OFFLINE);
  });
});

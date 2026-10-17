import { describe, it, expect } from 'vitest';
import { add, multiply, toCentavos } from '@shareat/core/money';
import { createFixtureCustomerData } from '@/data/fixture-data';
import { DEMO_TABLES, DEMO_MENU } from '@/data/fixtures';
import type { Result } from '@/data/types';

/**
 * T-437 slice T: the A6 rules the P3 server must own, pinned against the fixture. Every test names the mutant it kills.
 * Method signatures are exactly the spec's. Fixture values (PINs, QR tokens, item ids, prices) come from
 * '@/data/fixtures' so the builder chooses them.
 */

const MIN = 60_000;
const SEATS = 4; // fixture seat limit per table (spec rule 2)

function make() {
  const clock = { t: 1_000_000 };
  const data = createFixtureCustomerData({ now: () => clock.t });
  return { data, clock, advance: (ms: number) => void (clock.t += ms) };
}
type Data = ReturnType<typeof make>['data'];

function ok<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`expected ok, got refused: ${r.reason}`);
  return r.value;
}
function reasonOf(r: Result<unknown>): string {
  if (r.ok) throw new Error('expected a refusal, got ok');
  expect(typeof r.reason).toBe('string');
  expect(r.reason.length).toBeGreaterThan(0);
  return r.reason;
}

const PINS = DEMO_TABLES.map((t) => t.pin);
function wrongPins(count: number): string[] {
  const out: string[] = [];
  for (let i = 123456; out.length < count; i++) {
    const p = String(i).padStart(6, '0');
    if (!PINS.includes(p) && p !== '000000') out.push(p);
  }
  return out;
}

const ADDONS = DEMO_MENU.filter((i) => i.kind === 'addon');
const REFILLS = DEMO_MENU.filter((i) => i.kind === 'refill');
const T0 = DEMO_TABLES[0]!;

async function joinT0(data: Data, device: string) {
  return ok(await data.joinByPin(T0.pin, device));
}
async function sessionWithOrder(lines: { itemId: string; qty: number }[], rid = 'rid-1') {
  const m = make();
  const sess = await joinT0(m.data, 'dev-1');
  const order = ok(await m.data.placeOrder(sess.sessionId, lines, rid));
  return { ...m, sess, order };
}
async function serve(data: Data, orderId: string) {
  await data.advanceOrderForDemo(orderId); // -> partly_served
  await data.advanceOrderForDemo(orderId); // -> served
}

describe('fixture seed sanity (so the other tests are not vacuous)', () => {
  it('has 3+ tables with 6-digit PINs and QR tokens, addons and 3 refills', () => {
    expect(DEMO_TABLES.length).toBeGreaterThanOrEqual(3);
    for (const t of DEMO_TABLES) {
      expect(t.pin).toMatch(/^\d{6}$/);
      expect(t.qrToken.length).toBeGreaterThan(0);
    }
    expect(new Set(PINS).size).toBe(PINS.length);
    expect(PINS).not.toContain('000000');
    expect(ADDONS.length).toBeGreaterThanOrEqual(3);
    expect(REFILLS.length).toBe(3);
    for (const r of REFILLS) expect(r.price).toBe('0.00');
  });
});

describe('rule 1 + acceptance 1 - PIN lock per device', () => {
  it('rejects malformed PINs (not 6 digits). Kills: no format check', async () => {
    const { data } = make();
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 456']) {
      reasonOf(await data.joinByPin(bad, 'dev-x'));
    }
  });

  it('malformed PINs are refused and do NOT count toward the lock. Kills: format errors counted as wrong tries', async () => {
    const { data } = make();
    for (let i = 0; i < 6; i++) reasonOf(await data.joinByPin('12345', 'dev-1'));
    ok(await data.joinByPin(T0.pin, 'dev-1'));
  });

  it('5th wrong PIN locks that device; correct PIN refused during lock. Kills: no lock', async () => {
    const { data } = make();
    for (const p of wrongPins(5)) reasonOf(await data.joinByPin(p, 'dev-1'));
    reasonOf(await data.joinByPin(T0.pin, 'dev-1'));
  });

  it('4 wrong tries do NOT lock. Kills: off-by-one lock at 4', async () => {
    const { data } = make();
    for (const p of wrongPins(4)) reasonOf(await data.joinByPin(p, 'dev-1'));
    expect(ok(await data.joinByPin(T0.pin, 'dev-1')).tableLabel).toBe(T0.label);
  });

  it('a correct PIN resets the count. Kills: counter never resets', async () => {
    const { data } = make();
    for (const p of wrongPins(4)) await data.joinByPin(p, 'dev-1');
    ok(await data.joinByPin(T0.pin, 'dev-1'));
    for (const p of wrongPins(4)) await data.joinByPin(p, 'dev-1');
    ok(await data.joinByPin(T0.pin, 'dev-1'));
  });

  it('another device is not locked. Kills: lock is global', async () => {
    const { data } = make();
    for (const p of wrongPins(5)) await data.joinByPin(p, 'dev-1');
    ok(await data.joinByPin(T0.pin, 'dev-2'));
  });

  it('QR join still works on a PIN-locked device. Kills: lock blocks QR', async () => {
    const { data } = make();
    for (const p of wrongPins(5)) await data.joinByPin(p, 'dev-1');
    ok(await data.joinByQr(T0.qrToken, 'dev-1'));
  });

  it('lock lasts 5 minutes then PIN works. Kills: lock never expires / expires early', async () => {
    const { data, advance } = make();
    for (const p of wrongPins(5)) await data.joinByPin(p, 'dev-1');
    advance(5 * MIN - 1);
    reasonOf(await data.joinByPin(T0.pin, 'dev-1'));
    advance(2);
    ok(await data.joinByPin(T0.pin, 'dev-1'));
  });

  it('after the lock expires the count starts fresh. Kills: stale counter relocks on 1st wrong', async () => {
    const { data, advance } = make();
    for (const p of wrongPins(5)) await data.joinByPin(p, 'dev-1');
    advance(5 * MIN + 1);
    for (const p of wrongPins(4)) await data.joinByPin(p, 'dev-1');
    ok(await data.joinByPin(T0.pin, 'dev-1'));
  });
});

describe('rule 1 + acceptance 2 - 000000 is an ordinary wrong PIN', () => {
  it('refused with the same reason as any other wrong PIN. Kills: v1 admin shortcut', async () => {
    const { data } = make();
    const normal = reasonOf(await data.joinByPin(wrongPins(1)[0]!, 'dev-1'));
    expect(reasonOf(await data.joinByPin('000000', 'dev-2'))).toBe(normal);
  });

  it('counts toward the lock like any wrong PIN. Kills: 000000 special-cased (uncounted)', async () => {
    const { data } = make();
    for (let i = 0; i < 5; i++) reasonOf(await data.joinByPin('000000', 'dev-1'));
    reasonOf(await data.joinByPin(T0.pin, 'dev-1'));
  });
});

describe('rule 2 + acceptance 3 - seat limit and stable participantId', () => {
  it('5th distinct device refused. Kills: no seat limit', async () => {
    const { data } = make();
    for (let i = 1; i <= SEATS; i++) ok(await data.joinByPin(T0.pin, `dev-${i}`));
    reasonOf(await data.joinByPin(T0.pin, `dev-${SEATS + 1}`));
  });

  it('same device re-joining gets the same participantId and no new seat. Kills: re-join burns a seat', async () => {
    const { data } = make();
    const first = await joinT0(data, 'dev-1');
    for (let i = 0; i < 3; i++) {
      const again = ok(await data.joinByPin(T0.pin, 'dev-1'));
      expect(again.participantId).toBe(first.participantId);
      expect(again.sessionId).toBe(first.sessionId);
    }
    for (let i = 2; i <= SEATS; i++) ok(await data.joinByPin(T0.pin, `dev-${i}`));
    reasonOf(await data.joinByPin(T0.pin, 'dev-9'));
  });

  it('re-join of a seated device still works when the table is full. Kills: full table refuses its own diners', async () => {
    const { data } = make();
    const first = await joinT0(data, 'dev-1');
    for (let i = 2; i <= SEATS; i++) ok(await data.joinByPin(T0.pin, `dev-${i}`));
    expect(ok(await data.joinByPin(T0.pin, 'dev-1')).participantId).toBe(first.participantId);
  });

  it('different devices get different participantIds. Kills: shared participant id', async () => {
    const { data } = make();
    const a = await joinT0(data, 'dev-1');
    const b = await joinT0(data, 'dev-2');
    expect(a.participantId).not.toBe(b.participantId);
  });

  it('QR join takes seats too. Kills: QR path bypasses the seat limit', async () => {
    const { data } = make();
    for (let i = 1; i <= SEATS; i++) ok(await data.joinByQr(T0.qrToken, `dev-${i}`));
    reasonOf(await data.joinByQr(T0.qrToken, `dev-${SEATS + 1}`));
  });

  it('an unknown QR token is refused. Kills: any token joins', async () => {
    const { data } = make();
    reasonOf(await data.joinByQr('not-a-real-token', 'dev-1'));
  });
});

describe('rule 3 + acceptance 4 - placeOrder takes ids and quantities, idempotent', () => {
  const A = ADDONS[0]!;

  it('same clientRequestId twice returns the first order, one order only. Kills: double order on retry', async () => {
    const { data, sess, order } = await sessionWithOrder([{ itemId: A.id, qty: 2 }], 'rid-X');
    const again = ok(await data.placeOrder(sess.sessionId, [{ itemId: A.id, qty: 2 }], 'rid-X'));
    expect(again.orderId).toBe(order.orderId);
    expect(ok(await data.getOrders(sess.sessionId))).toHaveLength(1);
  });

  it('a different clientRequestId is a new order. Kills: dedupe on everything', async () => {
    const { data, sess, order } = await sessionWithOrder([{ itemId: A.id, qty: 1 }], 'rid-1');
    const second = ok(await data.placeOrder(sess.sessionId, [{ itemId: A.id, qty: 1 }], 'rid-2'));
    expect(second.orderId).not.toBe(order.orderId);
    expect(ok(await data.getOrders(sess.sessionId))).toHaveLength(2);
  });

  it('new order starts as preparing with the clientRequestId echoed', async () => {
    const { order } = await sessionWithOrder([{ itemId: A.id, qty: 1 }], 'rid-echo');
    expect(order.status).toBe('preparing');
    expect(order.clientRequestId).toBe('rid-echo');
  });

  it('refuses unknown item. Kills: unknown item accepted', async () => {
    const { data } = make();
    const s = await joinT0(data, 'dev-1');
    reasonOf(await data.placeOrder(s.sessionId, [{ itemId: 'no-such-item', qty: 1 }], 'r1'));
    expect(ok(await data.getOrders(s.sessionId))).toHaveLength(0);
  });

  it('qty must be a whole number 1-20. Kills: 0 / 21 / fraction / negative / NaN / string accepted; off-by-one at 20', async () => {
    const { data } = make();
    const s = await joinT0(data, 'dev-1');
    let n = 0;
    for (const qty of [0, 21, 1.5, -1, Number.NaN, '2' as unknown as number]) {
      reasonOf(await data.placeOrder(s.sessionId, [{ itemId: A.id, qty }], `bad-${n++}`));
    }
    ok(await data.placeOrder(s.sessionId, [{ itemId: A.id, qty: 1 }], 'good-1'));
    ok(await data.placeOrder(s.sessionId, [{ itemId: A.id, qty: 20 }], 'good-20'));
    expect(ok(await data.getOrders(s.sessionId))).toHaveLength(2); // refused ones left no order behind
  });

  it('a smuggled client price is ignored: stored lines carry no price and the bill uses the menu price. Kills: client-priced bill', async () => {
    const { data, sess } = await sessionWithOrder([{ itemId: A.id, qty: 1 }], 'seed');
    const cheat = ok(
      await data.placeOrder(sess.sessionId, [{ itemId: A.id, qty: 2, price: '0.01' } as never], 'cheat'),
    );
    for (const l of cheat.lines) expect(Object.keys(l).sort()).toEqual(['itemId', 'qty']);
    await serve(data, cheat.orderId);
    const bill = ok(await data.getBill(sess.sessionId));
    expect(bill.subtotal).toBe(multiply(A.price, 2));
  });
});

describe('rule 3b + 4 + acceptance 5 - bill on serve, exact money', () => {
  const A = ADDONS[0]!;

  it('preparing order adds nothing to the bill. Kills: unserved billed', async () => {
    const { data, sess } = await sessionWithOrder([{ itemId: A.id, qty: 3 }]);
    const bill = ok(await data.getBill(sess.sessionId));
    expect(toCentavos(bill.subtotal)).toBe(0n);
  });

  it('partly_served bills half the qty rounded down (3 -> 1). Kills: bills full qty early / rounds up / bills nothing', async () => {
    const { data, sess, order } = await sessionWithOrder([{ itemId: A.id, qty: 3 }]);
    await data.advanceOrderForDemo(order.orderId);
    expect(ok(await data.getOrders(sess.sessionId))[0]!.status).toBe('partly_served');
    expect(ok(await data.getBill(sess.sessionId)).subtotal).toBe(multiply(A.price, 1));
  });

  it('partly_served with qty 1 bills 0 (rounded down). Kills: round-half-up', async () => {
    const { data, sess, order } = await sessionWithOrder([{ itemId: A.id, qty: 1 }]);
    await data.advanceOrderForDemo(order.orderId);
    expect(toCentavos(ok(await data.getBill(sess.sessionId)).subtotal)).toBe(0n);
  });

  it('served bills price x qty in exact centavos for several quantities. Kills: float math / wrong price', async () => {
    for (const qty of [1, 3, 7, 20]) {
      for (const item of ADDONS) {
        const { data, sess, order } = await sessionWithOrder([{ itemId: item.id, qty }]);
        await serve(data, order.orderId);
        const bill = ok(await data.getBill(sess.sessionId));
        expect(bill.subtotal).toBe(multiply(item.price, qty));
        expect(bill.subtotal).toMatch(/^\d+\.\d{2}$/);
        expect(bill.lines).toHaveLength(1);
        expect(bill.lines[0]!.qty).toBe(qty);
        expect(bill.lines[0]!.amount).toBe(multiply(item.price, qty));
      }
    }
  });

  it('one order of every addon sums exactly. Kills: float accumulation drift', async () => {
    const lines = ADDONS.map((i) => ({ itemId: i.id, qty: 3 }));
    const { data, sess, order } = await sessionWithOrder(lines);
    await serve(data, order.orderId);
    const bill = ok(await data.getBill(sess.sessionId));
    const expected = add(...ADDONS.map((i) => multiply(i.price, 3)));
    expect(bill.subtotal).toBe(expected);
    const amounts = bill.lines.map((l) => toCentavos(l.amount)).sort();
    expect(amounts).toEqual(ADDONS.map((i) => toCentavos(multiply(i.price, 3))).sort());
  });

  it('two served orders add up; a still-preparing third adds nothing. Kills: only latest order billed / unserved billed', async () => {
    const { data, sess, order } = await sessionWithOrder([{ itemId: A.id, qty: 2 }], 'a');
    const o2 = ok(await data.placeOrder(sess.sessionId, [{ itemId: A.id, qty: 1 }], 'b'));
    ok(await data.placeOrder(sess.sessionId, [{ itemId: A.id, qty: 5 }], 'c')); // stays preparing
    await serve(data, order.orderId);
    await serve(data, o2.orderId);
    expect(ok(await data.getBill(sess.sessionId)).subtotal).toBe(multiply(A.price, 3));
  });

  it('refill items are free in the bill. Kills: refills priced', async () => {
    const r = REFILLS[0]!;
    const { data, sess, order } = await sessionWithOrder([{ itemId: r.id, qty: 4 }]);
    await serve(data, order.orderId);
    expect(toCentavos(ok(await data.getBill(sess.sessionId)).subtotal)).toBe(0n);
  });

  it('getBill is idempotent (reading does not accumulate). Kills: bill mutates on read', async () => {
    const { data, sess, order } = await sessionWithOrder([{ itemId: A.id, qty: 2 }]);
    await serve(data, order.orderId);
    const a = ok(await data.getBill(sess.sessionId));
    const b = ok(await data.getBill(sess.sessionId));
    expect(b.subtotal).toBe(a.subtotal);
  });

  it('bill is always an estimate. Kills: isEstimate false / missing', async () => {
    const { data, sess } = await sessionWithOrder([{ itemId: A.id, qty: 1 }]);
    expect(ok(await data.getBill(sess.sessionId)).isEstimate).toBe(true);
    const empty = make();
    const s = await joinT0(empty.data, 'dev-1');
    expect(ok(await empty.data.getBill(s.sessionId)).isEstimate).toBe(true);
  });

  it('no method on the data object takes a payment. Kills: pay/split/charge added to the interface', () => {
    const { data } = make();
    const names = new Set<string>();
    for (let o: object | null = data; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
      for (const n of Object.getOwnPropertyNames(o)) names.add(n);
    }
    for (const n of names) expect(n).not.toMatch(/pay|split|charge|checkout|tender/i);
  });

  it('cancelled order adds nothing to the bill (cancelOrderForDemo is fixture-only). Kills: cancelled billed', async () => {
    const { data, sess, order } = await sessionWithOrder([{ itemId: A.id, qty: 3 }], 'c1');
    const kept = ok(await data.placeOrder(sess.sessionId, [{ itemId: A.id, qty: 1 }], 'c2'));
    await serve(data, kept.orderId);
    await data.cancelOrderForDemo(order.orderId);
    const orders = ok(await data.getOrders(sess.sessionId));
    expect(orders.find((o) => o.orderId === order.orderId)!.status).toBe('cancelled');
    expect(ok(await data.getBill(sess.sessionId)).subtotal).toBe(multiply(A.price, 1));
  });
});

describe('rule 7 + acceptance 5b - unknown sessionId is {ok:false} on every call', () => {
  it('Kills: a stale session silently ordering / reading', async () => {
    const { data } = make();
    const ghost = 'session-that-does-not-exist';
    expect((await data.getMenu(ghost)).ok).toBe(false);
    expect((await data.placeOrder(ghost, [{ itemId: ADDONS[0]!.id, qty: 1 }], 'r')).ok).toBe(false);
    expect((await data.getOrders(ghost)).ok).toBe(false);
    expect((await data.getBill(ghost)).ok).toBe(false);
    expect((await data.submitFeedback(ghost, 'p', 5, 'x')).ok).toBe(false);
  });

  it('a known session still works (the refusal is about the id, not the call)', async () => {
    const { data } = make();
    const s = await joinT0(data, 'dev-1');
    expect((await data.getMenu(s.sessionId)).ok).toBe(true);
  });
});

describe('rule 5 + acceptance 6 - feedback', () => {
  async function fresh(tableIdx = 0) {
    const m = make();
    const s = ok(await m.data.joinByPin(DEMO_TABLES[tableIdx]!.pin, 'dev-1'));
    return { ...m, s };
  }
  async function tableWithUrl(has: boolean): Promise<number> {
    const m = make();
    for (let i = 0; i < DEMO_TABLES.length; i++) {
      const s = ok(await m.data.joinByPin(DEMO_TABLES[i]!.pin, `probe-${i}`));
      if ((s.store.googleReviewUrl !== null) === has) return i;
    }
    return -1;
  }

  it('rating must be an integer 1-5: 0, 6, 2.5, -1, NaN refused. Kills: range/integer checks missing', async () => {
    const { data, s } = await fresh();
    for (const r of [0, 6, 2.5, -1, Number.NaN]) {
      reasonOf(await data.submitFeedback(s.sessionId, s.participantId, r, ''));
    }
  });

  it('a refused rating does not use up the participant\'s one slot. Kills: dedupe counts refused attempts', async () => {
    const { data, s } = await fresh();
    reasonOf(await data.submitFeedback(s.sessionId, s.participantId, 6, ''));
    ok(await data.submitFeedback(s.sessionId, s.participantId, 5, ''));
  });

  it('one per participant: second refused, even with a different rating. Kills: no dedupe', async () => {
    const { data, s } = await fresh();
    ok(await data.submitFeedback(s.sessionId, s.participantId, 3, 'fine'));
    reasonOf(await data.submitFeedback(s.sessionId, s.participantId, 5, 'again'));
  });

  it('a different participant at the same table may still send one. Kills: dedupe per session instead of per participant', async () => {
    const m = make();
    const a = await joinT0(m.data, 'dev-1');
    const b = await joinT0(m.data, 'dev-2');
    ok(await m.data.submitFeedback(a.sessionId, a.participantId, 3, ''));
    ok(await m.data.submitFeedback(b.sessionId, b.participantId, 3, ''));
  });

  it('managerAlerted only for 1-2. Kills: threshold off-by-one (<=1 or <=3)', async () => {
    const expected: Record<number, boolean> = { 1: true, 2: true, 3: false, 4: false, 5: false };
    for (const rating of [1, 2, 3, 4, 5]) {
      const { data, s } = await fresh();
      expect(ok(await data.submitFeedback(s.sessionId, s.participantId, rating, '')).managerAlerted).toBe(expected[rating]);
    }
  });

  it('google review URL only for 4-5 when the store has one. Kills: threshold off-by-one, URL leaked on low ratings', async () => {
    const withUrl = await tableWithUrl(true);
    expect(withUrl, 'fixture must have at least one store WITH a googleReviewUrl').toBeGreaterThanOrEqual(0);
    for (const rating of [1, 2, 3, 4, 5]) {
      const { data, s } = await fresh(withUrl);
      const v = ok(await data.submitFeedback(s.sessionId, s.participantId, rating, ''));
      expect(v.googleReviewUrl).toBe(rating >= 4 ? s.store.googleReviewUrl : null);
      if (rating >= 4) expect(s.store.googleReviewUrl).toMatch(/^https?:\/\//);
    }
  });

  it('rating 4-5 with a store that has no URL gives null. Kills: undefined/placeholder URL invented', async () => {
    const noUrl = await tableWithUrl(false);
    expect(noUrl, 'fixture must have at least one store-less (null googleReviewUrl) table').toBeGreaterThanOrEqual(0);
    for (const rating of [4, 5]) {
      const { data, s } = await fresh(noUrl);
      expect(ok(await data.submitFeedback(s.sessionId, s.participantId, rating, '')).googleReviewUrl).toBeNull();
    }
  });
});

describe('rule 6 + acceptance 7 - sign up and sign in', () => {
  const PHONE = '09171234567';
  const GOOD = {
    name: 'Juan Dela Cruz',
    phone: PHONE,
    password: 'correct-horse',
  };
  async function codeFor(data: Data, phone: string): Promise<string> {
    return ok(await data.requestSignUpCode(phone)).code; // Result<{code}> (ruling)
  }
  function wrongCode(code: string): string {
    return code.replace(/\d$/, (d) => String((Number(d) + 1) % 10));
  }
  async function signUp(data: Data, over: Record<string, unknown> = {}, phone = PHONE) {
    const code = await codeFor(data, phone);
    return data.signUp({ ...GOOD, phone, code, consent: true, ...over } as never);
  }

  it('happy path: consent true + valid fields signs up, then sign-in works. Kills: sign-up always refuses', async () => {
    const { data } = make();
    ok(await signUp(data));
    ok(await data.signIn(PHONE, GOOD.password));
  });

  it('consent false or missing or truthy-but-not-true is refused. Kills: optional consent', async () => {
    const { data } = make();
    reasonOf(await signUp(data, { consent: false }));
    const code = await codeFor(data, PHONE);
    const { name, phone, password } = { ...GOOD };
    reasonOf(await data.signUp({ name, phone, password, code } as never)); // consent missing
    reasonOf(await data.signUp({ name, phone, password, code, consent: 'yes' } as never));
    reasonOf(await data.signIn(PHONE, GOOD.password)); // none of those created an account
  });

  it('bad phone formats refused. Kills: no phone validation', async () => {
    for (const phone of ['9171234567', '0917123456', '091712345678', '+639171234567', '08171234567', '0917123456a']) {
      const { data } = make();
      const code = await codeFor(data, PHONE).catch(() => '123456');
      reasonOf(await data.signUp({ ...GOOD, phone, code, consent: true } as never));
    }
  });

  it('password 7 chars refused, 8 chars accepted. Kills: min length off-by-one', async () => {
    const a = make();
    reasonOf(await signUp(a.data, { password: '1234567' }));
    const b = make();
    ok(await signUp(b.data, { password: '12345678' }));
  });

  it('wrong code refused. Kills: code not checked', async () => {
    const { data } = make();
    const code = await codeFor(data, PHONE);
    reasonOf(await data.signUp({ ...GOOD, code: wrongCode(code), consent: true } as never));
  });

  it('duplicate phone refused. Kills: duplicate accounts', async () => {
    const { data } = make();
    ok(await signUp(data));
    const r = await data.requestSignUpCode(PHONE);
    if (r.ok) {
      const code = r.value.code;
      reasonOf(await data.signUp({ ...GOOD, code, consent: true } as never));
    } else {
      reasonOf(r); // refusing at the code step is also acceptable
    }
  });

  it('signIn gives ONE reason for unknown phone and wrong password. Kills: member enumeration', async () => {
    const { data } = make();
    ok(await signUp(data));
    const unknown = reasonOf(await data.signIn('09999999999', 'whatever-123'));
    const wrong = reasonOf(await data.signIn(PHONE, 'definitely-wrong'));
    expect(unknown).toBe(wrong);
  });

  it('5 wrong passwords lock the phone; the 6th with the RIGHT password is refused with the same generic reason. Kills: no lockout / distinct lock message', async () => {
    const { data } = make();
    ok(await signUp(data));
    const generic = reasonOf(await data.signIn(PHONE, 'wrong-1'));
    for (let i = 2; i <= 5; i++) reasonOf(await data.signIn(PHONE, `wrong-${i}`));
    expect(reasonOf(await data.signIn(PHONE, GOOD.password))).toBe(generic);
  });

  it('4 wrong then the right password still works. Kills: lock at 4', async () => {
    const { data } = make();
    ok(await signUp(data));
    for (let i = 1; i <= 4; i++) reasonOf(await data.signIn(PHONE, `wrong-${i}`));
    ok(await data.signIn(PHONE, GOOD.password));
  });

  it('sign-in lock lasts 15 minutes. Kills: lock never expires / wrong duration', async () => {
    const { data, advance } = make();
    ok(await signUp(data));
    for (let i = 1; i <= 5; i++) await data.signIn(PHONE, `wrong-${i}`);
    advance(15 * MIN - 1);
    reasonOf(await data.signIn(PHONE, GOOD.password));
    advance(2);
    ok(await data.signIn(PHONE, GOOD.password));
  });

  it('the lock is per phone. Kills: global sign-in lock', async () => {
    const { data } = make();
    ok(await signUp(data));
    ok(await signUp(data, { phone: '09181234567' }, '09181234567'));
    for (let i = 1; i <= 5; i++) await data.signIn(PHONE, `wrong-${i}`);
    ok(await data.signIn('09181234567', GOOD.password));
  });
});

describe('rule 8 - advanceOrderForDemo and subscribe', () => {
  const A = ADDONS[0]!;

  it('moves preparing -> partly_served -> served and stays served. Kills: wrong order / wraps around', async () => {
    const { data, sess, order } = await sessionWithOrder([{ itemId: A.id, qty: 2 }]);
    const status = async () => ok(await data.getOrders(sess.sessionId)).find((o) => o.orderId === order.orderId)!.status;
    expect(await status()).toBe('preparing');
    await data.advanceOrderForDemo(order.orderId);
    expect(await status()).toBe('partly_served');
    await data.advanceOrderForDemo(order.orderId);
    expect(await status()).toBe('served');
    await data.advanceOrderForDemo(order.orderId);
    expect(await status()).toBe('served');
  });

  it('notifies subscribers of that session on each change. Kills: no notification (notice strip dead)', async () => {
    const { data, sess, order } = await sessionWithOrder([{ itemId: A.id, qty: 2 }]);
    let calls = 0;
    data.subscribe(sess.sessionId, () => void calls++);
    await data.advanceOrderForDemo(order.orderId);
    expect(calls).toBe(1);
    await data.advanceOrderForDemo(order.orderId);
    expect(calls).toBe(2);
  });

  it('unsubscribe stops notifications. Kills: unsubscribe is a no-op (leak)', async () => {
    const { data, sess, order } = await sessionWithOrder([{ itemId: A.id, qty: 2 }]);
    let calls = 0;
    const off = data.subscribe(sess.sessionId, () => void calls++);
    off();
    await data.advanceOrderForDemo(order.orderId);
    expect(calls).toBe(0);
  });

  it('other sessions are not notified. Kills: broadcast to every session', async () => {
    const { data, order } = await sessionWithOrder([{ itemId: A.id, qty: 2 }]);
    const other = ok(await data.joinByPin(DEMO_TABLES[1]!.pin, 'dev-other'));
    let calls = 0;
    data.subscribe(other.sessionId, () => void calls++);
    await data.advanceOrderForDemo(order.orderId);
    expect(calls).toBe(0);
  });
});

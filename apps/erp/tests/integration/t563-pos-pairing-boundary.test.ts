import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T-563 (audit P-004) - the server half of "an event is sent under the pairing it was made on, or it is held".
 * docs/tasks/563-pos-pairing-boundary.md R3. The route is called as a route would be (real Request, real cookies, real Postgres on a "_test" database).
 *
 *   own pairing           -> as before
 *   another pairing of the SAME org and store (live or revoked) -> carry-over: stored under the pairing it was made on, one audit row
 *   anything else (other store, other org, unknown) -> 409 POS_PAIRING_MISMATCH and NOTHING applied
 */
const state = vi.hoisted(() => ({ cookie: '' }));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => {
      for (const part of state.cookie.split(';')) {
        const i = part.indexOf('=');
        if (i > 0 && part.slice(0, i).trim() === name) return { name, value: part.slice(i + 1).trim() };
      }
      return undefined;
    },
    set: () => undefined,
    delete: () => undefined,
  }),
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
  notFound: () => {
    throw new Error('notFound() called');
  },
}));

import { newSessionToken, posTabletTokenHash, POS_TABLET_COOKIE } from '@shareat/auth';
import {
  asOrg, auditRows, closeAll, counts, ev, eventsOf, fixture, pinSession, plainDay, receiptOfSession, sql, standOpenedPayload, uuid, type Ev, type Fx,
} from '../../../../packages/domain/tests/integration/_fixtures/t525-pos';
import { replayQuarantinedEvent } from '../../../../packages/domain/src/pos';

afterAll(closeAll);
afterEach(() => {
  vi.restoreAllMocks();
});
beforeEach(() => {
  state.cookie = '';
});

const MISMATCH = 'These sales were made on this tablet when it was paired to another store. Pair it back to that store to send them.';

async function postBatch(cookieToken: string, body: unknown): Promise<Response> {
  const { POST } = await import('../../src/app/api/pos/events/route');
  state.cookie = `${POS_TABLET_COOKIE}=${cookieToken}`;
  return POST(
    new Request('http://localhost:9008/api/pos/events', {
      method: 'POST',
      headers: { cookie: state.cookie, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}
const results = async (res: Response) => ((await res.json()) as { results: { seq: number; status: string; error?: string }[] }).results;

/** What "pair a different tablet at this store" does, in rows: the live pairing is revoked with its sessions, a new one goes live, the till follows it. */
async function replaceTablet(f: Fx, from: string, storeId = f.storeId): Promise<{ id: string; token: string }> {
  await sql`update pos_tablet_pairings set revoked_at = now(), revoked_by = ${f.adminId}, revoke_reason = 'replaced by a new tablet' where id = ${from}`;
  await sql`update sessions set ended_at = now() + interval '1 hour', ended_reason = 'revoked' where device_id = ${from}::text and ended_at is null`;
  const token = newSessionToken();
  const [row] = await sql<{ id: string }[]>`
    insert into pos_tablet_pairings (org_id, store_id, label, cookie_digest, paired_by)
    values (${f.orgId}, ${storeId}, ${'tablet-' + uuid().slice(0, 8)}, ${posTabletTokenHash(token)}, ${f.adminId}) returning id`;
  await sql`update pos_terminals set pairing_id = ${row!.id} where org_id = ${f.orgId} and store_id = ${storeId} and pairing_id = ${from}`;
  return { id: row!.id, token };
}

/** A person signed in on `pairingId` an hour ago; the session ended (revoked) later, as a re-pair ends it - after the events were made. */
const signedInOn = (f: Fx, personId: string, pairingId: string) => pinSession(f, personId, { pairingId, issuedAt: new Date(Date.now() - 30 * 60e3), ended: 'revoked' });

const carriedAudit = (f: Fx) => auditRows(f, 'pos_events.carried_over');

describe('T-563 R3 - carry-over inside one store', () => {
  it('3. same-store replace: the day made on P1 drains through P2, is stored under P1, the sale posts to store A, one audit row; a replay is a duplicate', async () => {
    const f = await fixture();
    const p1 = f.pairingId;
    await signedInOn(f, f.counterId, p1);
    const day = plainDay(f, 1);
    const p2 = await replaceTablet(f, p1);

    const res = await postBatch(p2.token, { pairingId: p1, events: day.events });
    expect(res.status).toBe(200);
    expect((await results(res)).map((r) => r.status)).toEqual(['applied', 'applied', 'applied']);

    const rows = await eventsOf(f);
    expect(rows.map((r) => r.pairing_id)).toEqual([p1, p1, p1]);
    const receipt = await receiptOfSession(day.sessionId);
    expect(receipt, 'the sale posted').toBeDefined();
    const [store] = await sql<{ store_id: string }[]>`select store_id from pos_sales_receipts where id = ${receipt!.id}`;
    expect(store!.store_id).toBe(f.storeId);

    const audit = await carriedAudit(f);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.store_id).toBe(f.storeId);
    expect(audit[0]!.after).toMatchObject({ fromPairingId: p1, toPairingId: p2.id, count: 3 });

    const again = await postBatch(p2.token, { pairingId: p1, events: day.events });
    expect((await results(again)).map((r) => r.status)).toEqual(['duplicate', 'duplicate', 'duplicate']);
    expect((await counts(f)).receipts, 'never a double sale').toBe(1);
    expect(await carriedAudit(f), 'a replay writes no second audit row').toHaveLength(1);
  });

  it('3b. a PIN session only on P2 (not on P1) is refused as today: the check uses the pairing the event was made on', async () => {
    const f = await fixture();
    const p1 = f.pairingId;
    const day = plainDay(f, 1);
    const p2 = await replaceTablet(f, p1);
    await pinSession(f, f.counterId, { pairingId: p2.id });

    const res = await postBatch(p2.token, { pairingId: p1, events: day.events });
    expect(res.status).toBe(200);
    const r = await results(res);
    expect(r.every((x) => x.status === 'quarantined')).toBe(true);
    expect(r[0]!.error).toContain('POS_EVENT_PERSON_REFUSED');
    expect((await counts(f)).receipts).toBe(0);
  });

  it('3c. a P1 session that was revoked BEFORE the event was made does not vouch for it', async () => {
    const f = await fixture();
    const p1 = f.pairingId;
    // issued 3 h ago, ended 2 h ago (issue + 1 h): the event below is made now
    await pinSession(f, f.counterId, { pairingId: p1, issuedAt: new Date(Date.now() - 3 * 3600e3), ended: 'revoked' });
    const day = plainDay(f, 1);
    const p2 = await replaceTablet(f, p1);
    const res = await postBatch(p2.token, { pairingId: p1, events: day.events });
    expect((await results(res))[0]!.status).toBe('quarantined');
    expect((await counts(f)).receipts).toBe(0);
  });

  it('7. R3 terminal case: the till was re-linked to P2 and the carried-over sale still posts under the till it was rung on', async () => {
    const f = await fixture();
    const p1 = f.pairingId;
    await signedInOn(f, f.counterId, p1);
    const day = plainDay(f, 1);
    const p2 = await replaceTablet(f, p1);
    const [till] = await sql<{ pairing_id: string }[]>`select pairing_id from pos_terminals where org_id = ${f.orgId} and store_id = ${f.storeId} and terminal_no = 1`;
    expect(till!.pairing_id, 'the till now follows P2, not P1').toBe(p2.id);

    const res = await postBatch(p2.token, { pairingId: p1, events: day.events });
    expect((await results(res)).map((r) => r.status)).toEqual(['applied', 'applied', 'applied']);
    const receipt = await receiptOfSession(day.sessionId);
    expect(receipt?.receipt_seq).toBe(day.terminalSeq);
    const [t] = await sql<{ terminal_no: number }[]>`select terminal_no from pos_terminals where id = ${receipt!.terminal_id}`;
    expect(t!.terminal_no).toBe(1);
  });
});

describe('T-563 R3 - never under another store', () => {
  it('4. cross-store: store A sales sent by a tablet now paired to store B are a 409, nothing is stored or applied; pairing back to A drains them to A', async () => {
    const f = await fixture();
    const p1 = f.pairingId; // store A
    await signedInOn(f, f.counterId, p1);
    // store B is switched on (so only the pairing rule can stop the batch) and its tablet is live
    await sql`insert into pos_stores (org_id, store_id, mode, live_from, changed_by) values (${f.orgId}, ${f.store2Id}, 'test', null, ${f.personId})`;
    const day = plainDay(f, 1);

    const res = await postBatch(f.pairingBToken, { pairingId: p1, events: day.events });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { ok: boolean; error: string; code: string };
    expect(body).toMatchObject({ ok: false, error: MISMATCH, code: 'POS_PAIRING_MISMATCH' });
    expect(await counts(f)).toMatchObject({ events: 0, receipts: 0, sessions: 0, lines: 0 });
    expect(await carriedAudit(f)).toHaveLength(0);

    // pair back to store A: the tablet is a NEW pairing of store A, and the old one is revoked
    const p3 = await replaceTablet(f, p1);
    const back = await postBatch(p3.token, { pairingId: p1, events: day.events });
    expect((await results(back)).map((r) => r.status)).toEqual(['applied', 'applied', 'applied']);
    expect((await counts(f)).receipts).toBe(1);
    const rows = await eventsOf(f);
    expect(rows.every((r) => r.pairing_id === p1)).toBe(true);
  });

  it('5. a forged pairingId (another organisation, or one that does not exist) is a 409 and nothing is applied', async () => {
    const f = await fixture();
    await signedInOn(f, f.counterId, f.pairingId);
    const stranger = await fixture();
    const day = plainDay(f, 1);
    for (const forged of [stranger.pairingId, stranger.pairingRevokedId, uuid()]) {
      const res = await postBatch(f.pairingToken, { pairingId: forged, events: day.events });
      expect(res.status, forged).toBe(409);
      expect(((await res.json()) as { code: string }).code).toBe('POS_PAIRING_MISMATCH');
    }
    expect(await counts(f)).toMatchObject({ events: 0, receipts: 0 });
    expect(await counts(stranger)).toMatchObject({ events: 0, receipts: 0 });
  });

  it('a missing or malformed pairingId is a 400, and an event with no events checked first keeps its own sentence', async () => {
    const f = await fixture();
    const day = plainDay(f, 1);
    for (const body of [{ events: day.events }, { pairingId: 7, events: day.events }, { pairingId: 'not-a-uuid', events: day.events }]) {
      const res = await postBatch(f.pairingToken, body);
      expect(res.status).toBe(400);
    }
    expect((await postBatch(f.pairingToken, { pairingId: f.pairingId, events: [] })).status).toBe(400);
    expect((await counts(f)).events).toBe(0);
  });

  it('a batch under the cookie\'s own pairing is unchanged: applied, no audit row', async () => {
    const f = await fixture();
    await pinSession(f, f.counterId);
    const day = plainDay(f, 1);
    const res = await postBatch(f.pairingToken, { pairingId: f.pairingId, events: day.events as Ev[] });
    expect((await results(res)).map((r) => r.status)).toEqual(['applied', 'applied', 'applied']);
    expect(await carriedAudit(f)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// BOSS rule: a carried-over event is vouched for only by a sign-in on its origin tablet that began at or before it (no slack), had not ended before it,
// on a tablet not yet replaced when the event was made, for the same person and store. A failure is a per-event quarantine plus an audit row.
// ---------------------------------------------------------------------------------------------------------------------------------
const PIN_SENTENCE = 'That person has not signed in with a PIN on this tablet in the last week.';
const standEvent = (f: Fx, at: Date, who = f.counterId): Ev => ev(1, 'stand.opened', who, standOpenedPayload(uuid(), f.stand7), at);
const refusedAudit = (f: Fx) => auditRows(f, 'pos_events.carry_over_refused');
async function carriedFirstResult(f: Fx, event: Ev, p2: { token: string }) {
  const res = await postBatch(p2.token, { pairingId: f.pairingId, events: [event] });
  expect(res.status, 'a PIN refusal is a per-event quarantine, never a batch 409').toBe(200);
  return (await results(res))[0]!;
}

describe('T-563 carry-over PIN rule (BOSS)', () => {
  it('a session that STARTED AFTER the event (even inside the old 10-minute slack) does not vouch; the refusal writes carry_over_refused', async () => {
    const f = await fixture();
    const at = new Date();
    await pinSession(f, f.counterId, { pairingId: f.pairingId, issuedAt: new Date(at.getTime() + 30e3), ended: 'revoked' });
    const p2 = await replaceTablet(f, f.pairingId);
    const r = await carriedFirstResult(f, standEvent(f, at), p2);
    expect(r.status).toBe('quarantined');
    expect(r.error).toContain(PIN_SENTENCE);
    expect((await counts(f)).sessions).toBe(0);
    const audit = await refusedAudit(f);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.store_id).toBe(f.storeId);
    expect(audit[0]!.after).toMatchObject({ fromPairingId: f.pairingId, toPairingId: p2.id, seq: 1, reason: PIN_SENTENCE });
  });

  it('a backdated event made BEFORE the session began is refused', async () => {
    const f = await fixture();
    await pinSession(f, f.counterId, { pairingId: f.pairingId, issuedAt: new Date(Date.now() - 30 * 60e3), ended: 'revoked' });
    const p2 = await replaceTablet(f, f.pairingId);
    const r = await carriedFirstResult(f, standEvent(f, new Date(Date.now() - 2 * 3600e3)), p2);
    expect(r.status).toBe('quarantined');
    expect(r.error).toContain(PIN_SENTENCE);
    expect(await refusedAudit(f)).toHaveLength(1);
  });

  it('an event made AFTER the origin tablet was replaced is refused, even with a session that outlived it', async () => {
    const f = await fixture();
    await pinSession(f, f.counterId, { pairingId: f.pairingId, issuedAt: new Date(Date.now() - 30 * 60e3), ended: 'revoked' });
    const p2 = await replaceTablet(f, f.pairingId);
    await sql`update pos_tablet_pairings set revoked_at = now() - interval '1 hour' where id = ${f.pairingId}`;
    const r = await carriedFirstResult(f, standEvent(f, new Date()), p2);
    expect(r.status).toBe('quarantined');
    expect(r.error).toContain('after the tablet it came from was replaced');
    expect(await refusedAudit(f)).toHaveLength(1);
  });

  it('a session of another PERSON, or of another STORE, does not vouch', async () => {
    const f = await fixture();
    const issuedAt = new Date(Date.now() - 30 * 60e3);
    await pinSession(f, f.kitchenId, { pairingId: f.pairingId, issuedAt, ended: 'revoked' }); // not the counter
    await pinSession(f, f.counterId, { pairingId: f.pairingId, issuedAt, ended: 'revoked', storeId: f.store2Id }); // the counter, but at store B
    const made = standEvent(f, new Date()); // made while the tablet was still valid
    const p2 = await replaceTablet(f, f.pairingId);
    const r = await carriedFirstResult(f, made, p2);
    expect(r.status).toBe('quarantined');
    expect(r.error).toContain(PIN_SENTENCE);
  });

  it('F4: a carried sale quarantined because the till was not re-linked is replayed under the live pairing once the till follows it, and posts once', async () => {
    const f = await fixture();
    await signedInOn(f, f.counterId, f.pairingId);
    const day = plainDay(f, 1);
    const p2 = await replaceTablet(f, f.pairingId);
    // the till still points at the replaced tablet
    await sql`update pos_terminals set pairing_id = ${f.pairingId} where org_id = ${f.orgId} and store_id = ${f.storeId} and terminal_no = 1`;
    const res = await postBatch(p2.token, { pairingId: f.pairingId, events: day.events });
    expect((await results(res)).map((r) => r.status)).toEqual(['applied', 'applied', 'quarantined']);
    expect((await counts(f)).receipts).toBe(0);

    await sql`update pos_terminals set pairing_id = ${p2.id} where org_id = ${f.orgId} and store_id = ${f.storeId} and terminal_no = 1`;
    const [row] = await sql<{ id: string }[]>`select id from pos_events where org_id = ${f.orgId} and kind = 'sale.completed'`;
    const out = await asOrg(f.orgId, (tx) => replayQuarantinedEvent(tx, f.manager, { storeId: f.storeId, eventId: row!.id }));
    expect(out).toEqual({ replayed: true });
    expect((await counts(f)).receipts, 'posts once').toBe(1);
    expect((await receiptOfSession(day.sessionId))?.receipt_seq).toBe(day.terminalSeq);
    await expect(asOrg(f.orgId, (tx) => replayQuarantinedEvent(tx, f.manager, { storeId: f.storeId, eventId: row!.id }))).rejects.toThrow();
    expect((await counts(f)).receipts).toBe(1);
  });
});

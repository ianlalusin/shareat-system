import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T-644 S4 - the senior / PWD claim Server Actions (`apps/erp/src/app/pos/lobby/actions.ts`) with REAL Postgres and the REAL T-455 staff twins. Only the session, `next/cache` and
 * `next/navigation` are replaced. Any scratch "_test" database (nothing pins a lane database). docs/tasks/644-lobby-in-erp-pos.md, S4 and ruling 6.
 * Fixture: packages/domain/tests/integration/_fixtures/t525-pos.ts (counter = record_sale at store A; kitchen = NO record_sale; admin holds both stores; pairingToken = store A's tablet).
 * PERSONAL DATA: the name and ID number below are SYNTHETIC test values.
 *
 * MUTANT INDEX (each title ends with "[kills: ...]"): a list that shows another store's claims or carries a name or ID number; an open that returns data across stores, skips the audit row or audits the
 * name; an approve that answers ok without writing, with no card tick, on a party that is not seated or seated on another session, across stores, with a store from the body, without the
 * pairing or record_sale; a reference that is not `${sessionId}:${dinerNo}`; a diner number or session the domain would not take reaching it; a field rule judged before authorize; a reject with
 * free text, or one that answers ok without writing; a status that leaks across stores; a retried approve that is repeated instead of refused; an approved-claims read that shows pending,
 * rejected, another session's or another store's claims, or a name.
 */
const HOLD = vi.hoisted(() => ({ actor: null as null | { orgId: string; personId: string }, token: null as string | null }));
vi.mock('../../src/lib/session', () => {
  const resolved = () => ({ actor: HOLD.actor!, sessionId: 'session-1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01') });
  return {
    requireSession: vi.fn(async () => resolved()),
    requireActor: vi.fn(async () => HOLD.actor!),
    currentSession: vi.fn(async () => resolved()),
    readPosTabletToken: vi.fn(async () => HOLD.token),
  };
});
vi.mock('next/cache', () => ({ revalidatePath: () => undefined, revalidateTag: () => undefined }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
  notFound: () => {
    throw new Error('notFound() called');
  },
}));

import { parkWalkIn, seatEntry } from '../../../../packages/domain/src/lobby/staff';
import { asOrg, closeAll, fixture, sql, uuid, type Fx } from '../../../../packages/domain/tests/integration/_fixtures/t525-pos';

afterAll(closeAll);
afterEach(() => {
  vi.restoreAllMocks();
});
beforeEach(() => {
  HOLD.actor = null;
  HOLD.token = null;
});

const NAME = 'Zyxwv Quillfeather';
const IDNO = 'OSCA-9990042';
type Out = { ok: boolean; error?: string; final?: true } & Record<string, unknown>;
type Name = 'listClaimsAction' | 'openClaimAction' | 'claimStatusAction' | 'approveClaimAction' | 'rejectClaimAction' | 'approvedClaimsForSessionAction';
async function call(name: Name, as: { orgId: string; personId: string }, input: unknown, token: string | null = null): Promise<Out> {
  const m = await import('../../src/app/pos/lobby/actions');
  HOLD.actor = as;
  HOLD.token = token;
  return name === 'listClaimsAction' ? m.listClaimsAction() : (m[name] as (i: unknown) => Promise<Out>)(input);
}

/** A walk-in at `storeId`, seated on `sessionId` when given. */
async function entry(f: Fx, storeId: string, sessionId: string | null = null, partySize = 4): Promise<string> {
  const parked = await asOrg(f.orgId, (tx) => parkWalkIn(tx, f.admin, { storeId, displayName: 'Ana', partySize }));
  if (sessionId) await asOrg(f.orgId, (tx) => seatEntry(tx, f.admin, { entryId: parked.entryId, sessionId, standLabel: '7', joinUrl: null }));
  return parked.entryId;
}
/** A pending claim with the synthetic name and ID number. */
async function claim(f: Fx, entryId: string, kind: 'senior' | 'pwd' = 'senior', last4 = '1187'): Promise<string> {
  const [c] = await sql<{ id: string }[]>`
    insert into lobby_discount_claims (org_id, entry_id, kind, holder_name, id_number, id_last4, status)
    values (${f.orgId}, ${entryId}, ${kind}, ${NAME}, ${IDNO}, ${last4}, 'pending') returning id`;
  return c!.id;
}
/** A claim that was approved earlier at `sessionId` for `dinerNo` (the same end state the approve action leaves). */
async function approved(f: Fx, entryId: string, sessionId: string, dinerNo: number, kind: 'senior' | 'pwd' = 'senior', last4 = '1187'): Promise<string> {
  const id = await claim(f, entryId, kind, last4);
  await sql`update lobby_discount_claims set status = 'approved', holder_name = null, id_number = null, session_ref = ${sessionId}, statutory_diner_ref = ${`${sessionId}:${dinerNo}`},
    acted_by_person_id = ${f.adminId}, card_seen_at = now(), decided_at = now() where id = ${id}`;
  return id;
}
const rowOf = async (id: string) =>
  (await sql<{ status: string; session_ref: string | null; statutory_diner_ref: string | null; holder_name: string | null; id_number: string | null; reject_reason: string | null }[]>`
    select status, session_ref, statutory_diner_ref, holder_name, id_number, reject_reason from lobby_discount_claims where id = ${id}`)[0]!;
const audits = (id: string, action: string) =>
  sql<{ before: unknown; after: unknown }[]>`select before, after from audit_log where entity_id = ${id} and action = ${action}`;
const oneSentence = (s: unknown) => {
  expect(typeof s).toBe('string');
  expect((s as string).length).toBeGreaterThan(10);
  expect(s, 'one sentence, no UUID').not.toMatch(/\n|[0-9a-f]{8}-[0-9a-f]{4}-/i);
};
const noPersonalData = (v: unknown, what: string) => expect(JSON.stringify(v), what).not.toMatch(/Zyxwv|Quillfeather|OSCA|9990042/);
const SENTENCE_CARD = 'Please check the card first, then tick that you have seen it.';

describe('listClaimsAction', () => {
  it('the paired tablet sees ONLY its own store pending claims, masked, with ISO times and no name or ID number anywhere in the answer [kills: a list that shows another store, a list that leaks a name or an ID number]', async () => {
    const f = await fixture();
    const mine = await claim(f, await entry(f, f.storeId, uuid()), 'senior', '1187');
    const mine2 = await claim(f, await entry(f, f.storeId), 'pwd', '5521');
    const decided = await claim(f, await entry(f, f.storeId, uuid()));
    await sql`update lobby_discount_claims set status = 'rejected', holder_name = null, id_number = null, reject_reason = 'x', decided_at = now() where id = ${decided}`;
    await claim(f, await entry(f, f.store2Id));
    const r = await call('listClaimsAction', f.counter, {}, f.pairingToken);
    expect(r.ok).toBe(true);
    const rows = r.claims as Record<string, unknown>[];
    expect(rows.map((x) => x.claimId).sort()).toEqual([mine, mine2].sort());
    expect(rows.map((x) => x.idMasked).sort()).toEqual(['****1187', '****5521']);
    expect(Object.keys(rows[0]!).sort()).toEqual(['claimId', 'code', 'createdAt', 'displayName', 'entryId', 'idMasked', 'kind', 'partySize', 'standLabel', 'status']);
    expect(typeof rows[0]!.createdAt).toBe('string');
    noPersonalData(r, 'the list answer');
  });

  it('a person without record_sale, and a browser with no pairing, are refused with a sentence and see nothing [kills: a list that skips the record_sale check or the pairing]', async () => {
    const f = await fixture();
    await claim(f, await entry(f, f.storeId));
    for (const r of [await call('listClaimsAction', f.kitchen, {}, f.pairingToken), await call('listClaimsAction', f.counter, {}, null)]) {
      expect(r.ok).toBe(false);
      oneSentence(r.error);
      expect(r.claims).toBeUndefined();
    }
  });
});

describe('openClaimAction', () => {
  it('opens a claim of this store: name, ID number and the seated session come back and ONE audit row is written with no name or ID number [kills: an open with no audit row, an audit that carries the name or number]', async () => {
    const f = await fixture();
    const session = uuid();
    const id = await claim(f, await entry(f, f.storeId, session));
    const r = await call('openClaimAction', f.counter, { claimId: id }, f.pairingToken);
    expect(r.ok).toBe(true);
    expect(r.claim).toMatchObject({ claimId: id, kind: 'senior', holderName: NAME, idNumber: IDNO, sessionRef: session, standLabel: '7', partySize: 4 });
    const a = await audits(id, 'lobby.claim_open');
    expect(a).toHaveLength(1);
    noPersonalData(a, 'the open audit row');
  });

  it('a claim of ANOTHER store answers like a ghost id even for a person who holds record_sale at both stores, and a store in the body is ignored [kills: an open that trusts the claim id instead of the pairing store, a store read from the body]', async () => {
    const f = await fixture();
    const other = await claim(f, await entry(f, f.store2Id));
    const across = await call('openClaimAction', f.admin, { claimId: other }, f.pairingToken);
    const viaBody = await call('openClaimAction', f.admin, { storeId: f.store2Id, claimId: other }, f.pairingToken);
    const ghost = await call('openClaimAction', f.admin, { claimId: uuid() }, f.pairingToken);
    for (const r of [across, viaBody]) {
      expect(r.ok).toBe(false);
      expect(r.error).toBe(ghost.error);
      expect(r.final, 'a ghost id is final').toBe(true);
      noPersonalData(r, 'a refused open');
    }
    expect(await audits(other, 'lobby.claim_open')).toHaveLength(0);
  });

  it('a person without record_sale, no pairing and a bad id are refused and nothing is audited [kills: an open that skips the capability, the pairing or the id check]', async () => {
    const f = await fixture();
    const id = await claim(f, await entry(f, f.storeId));
    for (const r of [await call('openClaimAction', f.kitchen, { claimId: id }, f.pairingToken), await call('openClaimAction', f.counter, { claimId: id }, null)]) {
      expect(r.ok).toBe(false);
      oneSentence(r.error);
      expect(r.claim).toBeUndefined();
      expect(r.final, 'an access or pairing refusal may pass: not final').toBeUndefined();
    }
    expect(await call('openClaimAction', f.counter, { claimId: 'nope' }, f.pairingToken)).toEqual({ ok: false, error: 'Choose a claim from the list.' });
    expect(await audits(id, 'lobby.claim_open')).toHaveLength(0);
  });
});

describe('claimStatusAction', () => {
  it('answers the status of a claim of this store and nothing else; another store, no capability and no pairing are refused [kills: a status that leaks across stores, a status that carries data]', async () => {
    const f = await fixture();
    const id = await claim(f, await entry(f, f.storeId));
    const done = await approved(f, await entry(f, f.storeId, uuid()), uuid(), 1);
    const other = await claim(f, await entry(f, f.store2Id));
    expect(await call('claimStatusAction', f.counter, { claimId: id }, f.pairingToken)).toEqual({ ok: true, status: 'pending' });
    expect(await call('claimStatusAction', f.counter, { claimId: done }, f.pairingToken)).toEqual({ ok: true, status: 'approved' });
    const across = await call('claimStatusAction', f.admin, { claimId: other }, f.pairingToken);
    const ghost = await call('claimStatusAction', f.admin, { claimId: uuid() }, f.pairingToken);
    expect(across.ok).toBe(false);
    expect(across.error).toBe(ghost.error);
    for (const r of [await call('claimStatusAction', f.kitchen, { claimId: id }, f.pairingToken), await call('claimStatusAction', f.counter, { claimId: id }, null)]) {
      expect(r.ok).toBe(false);
      expect(r.status).toBeUndefined();
    }
    expect(await audits(id, 'lobby.claim_open')).toHaveLength(0);
  });
});

describe('approveClaimAction', () => {
  it('approves a claim of the seated party: the reference is `${sessionId}:${dinerNo}`, name and ID number are gone, and one audit row is written [kills: an approve that answers ok without writing, a reference built another way, a name kept after approval]', async () => {
    const f = await fixture();
    const session = uuid();
    const id = await claim(f, await entry(f, f.storeId, session));
    const r = await call('approveClaimAction', f.counter, { claimId: id, sessionId: session, dinerNo: 3, cardSeen: true }, f.pairingToken);
    expect(r).toEqual({ ok: true });
    expect(await rowOf(id)).toEqual({ status: 'approved', session_ref: session, statutory_diner_ref: `${session}:3`, holder_name: null, id_number: null, reject_reason: null });
    const a = await audits(id, 'lobby.claim_approve');
    expect(a).toHaveLength(1);
    noPersonalData(a, 'the approve audit row');
  });

  it('is refused without the card tick, whatever else is sent, and the claim stays pending [kills: an approve without cardSeen, a truthy value taken for true]', async () => {
    const f = await fixture();
    const session = uuid();
    const id = await claim(f, await entry(f, f.storeId, session));
    for (const cardSeen of [false, undefined, 'true', 1, null]) {
      const r = await call('approveClaimAction', f.counter, { claimId: id, sessionId: session, dinerNo: 1, cardSeen }, f.pairingToken);
      expect(r, JSON.stringify(cardSeen)).toEqual({ ok: false, error: SENTENCE_CARD });
    }
    expect((await rowOf(id)).status).toBe('pending');
    expect(await audits(id, 'lobby.claim_approve')).toHaveLength(0);
  });

  it('is refused when the party is not seated, and when it is seated on another session; the claim stays pending [kills: an approve on a waiting party, an approve against the session of another table]', async () => {
    const f = await fixture();
    const waiting = await claim(f, await entry(f, f.storeId));
    const session = uuid();
    const seated = await claim(f, await entry(f, f.storeId, session));
    const notSeated = await call('approveClaimAction', f.counter, { claimId: waiting, sessionId: session, dinerNo: 1, cardSeen: true }, f.pairingToken);
    const wrongSession = await call('approveClaimAction', f.counter, { claimId: seated, sessionId: uuid(), dinerNo: 1, cardSeen: true }, f.pairingToken);
    for (const r of [notSeated, wrongSession]) {
      expect(r.ok).toBe(false);
      expect(r.error).toBe('The party must be seated at this table before the discount can be approved.');
      expect(r.final, 'seating the party can fix it: not final').toBeUndefined();
    }
    expect((await rowOf(waiting)).status).toBe('pending');
    expect((await rowOf(seated)).status).toBe('pending');
  });

  it('a claim of ANOTHER store answers like a ghost id and stays pending, even for a person who holds record_sale at both stores; a store in the body is ignored [kills: an approve that trusts the claim id instead of the pairing store, a store read from the body]', async () => {
    const f = await fixture();
    const session = uuid();
    const other = await claim(f, await entry(f, f.store2Id, session));
    const across = await call('approveClaimAction', f.admin, { claimId: other, sessionId: session, dinerNo: 1, cardSeen: true }, f.pairingToken);
    const viaBody = await call('approveClaimAction', f.admin, { storeId: f.store2Id, claimId: other, sessionId: session, dinerNo: 1, cardSeen: true }, f.pairingToken);
    const ghost = await call('approveClaimAction', f.admin, { claimId: uuid(), sessionId: session, dinerNo: 1, cardSeen: true }, f.pairingToken);
    for (const r of [across, viaBody]) {
      expect(r.ok).toBe(false);
      expect(r.error).toBe(ghost.error);
    }
    expect((await rowOf(other)).status).toBe('pending');
  });

  it('no pairing and no record_sale are refused, and a bad session or diner number gives the access refusal to a person who may not act, not the field rule [kills: an approve without the pairing or capability, a field rule judged before authorize]', async () => {
    const f = await fixture();
    const session = uuid();
    const id = await claim(f, await entry(f, f.storeId, session));
    const good = { claimId: id, sessionId: session, dinerNo: 1, cardSeen: true };
    const noPair = await call('approveClaimAction', f.counter, good, null);
    const noCap = await call('approveClaimAction', f.kitchen, good, f.pairingToken);
    const noCapBad = await call('approveClaimAction', f.kitchen, { ...good, dinerNo: 99 }, f.pairingToken);
    for (const r of [noPair, noCap]) {
      expect(r.ok).toBe(false);
      oneSentence(r.error);
    }
    expect(noCapBad).toEqual(noCap);
    expect(noCapBad.error).not.toBe('Choose the diner number, and seat the party first.');
    expect((await rowOf(id)).status).toBe('pending');
  });

  it('a diner number or session the reference could not hold is refused with one sentence before anything is written [kills: a diner 0, 31, 1.5 or "2", or a session that is not a uuid, reaching the database]', async () => {
    const f = await fixture();
    const session = uuid();
    const id = await claim(f, await entry(f, f.storeId, session));
    for (const bad of [{ dinerNo: 0 }, { dinerNo: 31 }, { dinerNo: 1.5 }, { dinerNo: '2' }, { dinerNo: undefined }, { sessionId: 'not-a-uuid' }, { sessionId: undefined }, { sessionId: `${session}:1` }]) {
      const r = await call('approveClaimAction', f.counter, { claimId: id, sessionId: session, dinerNo: 1, cardSeen: true, ...bad }, f.pairingToken);
      expect(r, JSON.stringify(bad)).toEqual({ ok: false, error: 'Choose the diner number, and seat the party first.' });
    }
    expect((await rowOf(id)).status).toBe('pending');
  });

  it('a retried approve (the first reply was lost) is refused as closed and FINAL, the first stands, and the status call says approved [kills: a retried approve that is repeated, a closed claim that is not final, a status that cannot confirm]', async () => {
    const f = await fixture();
    const session = uuid();
    const id = await claim(f, await entry(f, f.storeId, session));
    const input = { claimId: id, sessionId: session, dinerNo: 2, cardSeen: true };
    expect((await call('approveClaimAction', f.counter, input, f.pairingToken)).ok).toBe(true);
    const again = await call('approveClaimAction', f.counter, { ...input, dinerNo: 4 }, f.pairingToken);
    expect(again).toEqual({ ok: false, error: 'That discount claim can no longer be changed.', final: true });
    expect((await rowOf(id)).statutory_diner_ref).toBe(`${session}:2`);
    expect(await audits(id, 'lobby.claim_approve')).toHaveLength(1);
    expect(await call('claimStatusAction', f.counter, { claimId: id }, f.pairingToken)).toEqual({ ok: true, status: 'approved' });
  });

  it('two claims of one party cannot take the same diner number, and the second can take another [kills: one diner linked to two claims]', async () => {
    const f = await fixture();
    const session = uuid();
    const e = await entry(f, f.storeId, session);
    const a = await claim(f, e);
    const b = await claim(f, e, 'pwd', '7733');
    expect((await call('approveClaimAction', f.counter, { claimId: a, sessionId: session, dinerNo: 1, cardSeen: true }, f.pairingToken)).ok).toBe(true);
    const clash = await call('approveClaimAction', f.counter, { claimId: b, sessionId: session, dinerNo: 1, cardSeen: true }, f.pairingToken);
    expect(clash).toEqual({ ok: false, error: 'This senior / PWD diner is already linked to another claim on this table.' });
    expect((await rowOf(b)).status).toBe('pending');
    expect((await call('approveClaimAction', f.counter, { claimId: b, sessionId: session, dinerNo: 2, cardSeen: true }, f.pairingToken)).ok).toBe(true);
  });
});

describe('rejectClaimAction', () => {
  it('one of the four fixed reasons rejects: the row is rejected with that sentence, name and ID number are gone, and one audit row is written [kills: a reject that answers ok without writing, a name kept after a reject]', async () => {
    const f = await fixture();
    const id = await claim(f, await entry(f, f.storeId));
    const r = await call('rejectClaimAction', f.counter, { claimId: id, reasonCode: 'id_mismatch' }, f.pairingToken);
    expect(r).toEqual({ ok: true });
    expect(await rowOf(id)).toMatchObject({ status: 'rejected', reject_reason: 'The ID number did not match the card.', holder_name: null, id_number: null });
    const a = await audits(id, 'lobby.claim_reject');
    expect(a).toHaveLength(1);
    noPersonalData(a, 'the reject audit row');
  });

  it('free text is refused in every shape, with one sentence, and the claim stays pending [kills: a free-text reject reason reaching the database, a label accepted for a code]', async () => {
    const f = await fixture();
    const id = await claim(f, await entry(f, f.storeId));
    const bad: Record<string, unknown>[] = [
      { reasonCode: 'The ID is fake' },
      { reasonCode: 'The ID number did not match the card.' },
      { reasonCode: '' },
      { reasonCode: 'ID_MISMATCH' },
      {},
      { reasonCode: 'id_mismatch', reason: 'typed by hand' },
      { reasonCode: 'id_mismatch', note: 'typed by hand' },
      { reasonCode: 'id_mismatch', text: 'typed by hand' },
      { reasonCode: 'id_mismatch', message: 'typed by hand' },
    ];
    for (const b of bad) {
      const r = await call('rejectClaimAction', f.counter, { claimId: id, ...b }, f.pairingToken);
      expect(r, JSON.stringify(b)).toEqual({ ok: false, error: 'Choose one of the reasons.' });
    }
    expect(await rowOf(id)).toMatchObject({ status: 'pending', reject_reason: null });
  });

  it('a person who may not act gets the access refusal for a bad reason, not the reason rule; another store, no pairing and a bad id are refused [kills: a reason check before authorize, a reject across stores or without the pairing]', async () => {
    const f = await fixture();
    const mine = await claim(f, await entry(f, f.storeId));
    const other = await claim(f, await entry(f, f.store2Id));
    const good = await call('rejectClaimAction', f.kitchen, { claimId: mine, reasonCode: 'id_mismatch' }, f.pairingToken);
    const bad = await call('rejectClaimAction', f.kitchen, { claimId: mine, reasonCode: 'free text' }, f.pairingToken);
    expect(good.ok).toBe(false);
    expect(bad).toEqual(good);
    expect(bad.error).not.toBe('Choose one of the reasons.');
    const across = await call('rejectClaimAction', f.admin, { claimId: other, reasonCode: 'id_mismatch' }, f.pairingToken);
    const ghost = await call('rejectClaimAction', f.admin, { claimId: uuid(), reasonCode: 'id_mismatch' }, f.pairingToken);
    expect(across.ok).toBe(false);
    expect(across.error).toBe(ghost.error);
    expect((await call('rejectClaimAction', f.counter, { claimId: mine, reasonCode: 'id_mismatch' }, null)).ok).toBe(false);
    expect(await call('rejectClaimAction', f.counter, { claimId: 'nope', reasonCode: 'id_mismatch' }, f.pairingToken)).toEqual({ ok: false, error: 'Choose a claim from the list.' });
    expect((await rowOf(mine)).status).toBe('pending');
    expect((await rowOf(other)).status).toBe('pending');
  });
});

describe('approvedClaimsForSessionAction (ruling 6: the paying screen of one session)', () => {
  it('returns only the kind, the last 4 and the diner number of APPROVED claims of this session at this store: not pending, rejected, another session, another store, and no name [kills: a read that shows pending or rejected claims, the claims of another table or another store, or a name]', async () => {
    const f = await fixture();
    const session = uuid();
    const e = await entry(f, f.storeId, session);
    await approved(f, e, session, 2, 'senior', '1187');
    await approved(f, e, session, 1, 'pwd', '5521');
    await claim(f, e); // pending: not offered
    const rejected = await claim(f, e);
    await sql`update lobby_discount_claims set status = 'rejected', holder_name = null, id_number = null, reject_reason = 'x', decided_at = now() where id = ${rejected}`;
    await approved(f, await entry(f, f.storeId, uuid()), uuid(), 1, 'senior', '9999'); // another table
    await approved(f, await entry(f, f.store2Id, session), session, 3, 'senior', '8888'); // same session text, another store
    const r = await call('approvedClaimsForSessionAction', f.counter, { sessionId: session }, f.pairingToken);
    expect(r.ok).toBe(true);
    const rows = r.claims as Record<string, unknown>[];
    expect(rows.map((x) => `${x.kind}:${x.dinerNo}:${x.idLast4}`).sort()).toEqual(['pwd:1:5521', 'senior:2:1187']);
    expect(Object.keys(rows[0]!).sort()).toEqual(['dinerNo', 'idLast4', 'kind']);
    noPersonalData(r, 'the approved claims answer');
    expect(await call('approvedClaimsForSessionAction', f.counter, { sessionId: uuid() }, f.pairingToken)).toEqual({ ok: true, claims: [] });
  });

  it('a person without record_sale, no pairing and a bad session id are refused and see nothing [kills: a read that skips the capability, the pairing or the id check]', async () => {
    const f = await fixture();
    const session = uuid();
    await approved(f, await entry(f, f.storeId, session), session, 1);
    for (const r of [await call('approvedClaimsForSessionAction', f.kitchen, { sessionId: session }, f.pairingToken), await call('approvedClaimsForSessionAction', f.counter, { sessionId: session }, null)]) {
      expect(r.ok).toBe(false);
      oneSentence(r.error);
      expect(r.claims).toBeUndefined();
    }
    expect(await call('approvedClaimsForSessionAction', f.counter, { sessionId: 'nope' }, f.pairingToken)).toEqual({ ok: false, error: 'Choose a claim from the list.' });
  });

  it('approving never takes money off: no discount, session or event row is written by an approve [kills: an approve that writes a discount]', async () => {
    const f = await fixture();
    const session = uuid();
    const id = await claim(f, await entry(f, f.storeId, session));
    const count = async () =>
      (await sql<{ n: string }[]>`select ((select count(*) from table_session_line_discounts where org_id = ${f.orgId}) + (select count(*) from table_sessions where org_id = ${f.orgId}) + (select count(*) from pos_events where org_id = ${f.orgId}))::text n`)[0]!.n;
    const before = await count();
    expect((await call('approveClaimAction', f.counter, { claimId: id, sessionId: session, dinerNo: 1, cardSeen: true }, f.pairingToken)).ok).toBe(true);
    expect(await count()).toBe(before);
  });
});

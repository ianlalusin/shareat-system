import { config } from 'dotenv';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * T-455 S6a (TESTER) - the birthday-song request, DOMAIN, cashier side: docs/tasks/455-customer-lobby.md sections 2.4, 3.2 (birthday prompt),
 * 4.6 (every accept, decline and play is an audit_log row with the tablet's person), "S5 rulings" 1-2 (terminal actor, no authorize()), and the S6a
 * row of section 5. Real Postgres via TEST_DATABASE_URL.
 *
 * RED TODAY, for one reason: packages/domain/src/lobby/birthday.ts does not exist (the import below fails to resolve).
 *
 * CONTRACT ASSUMED (see the hand-back; every line is an orchestrator ruling to confirm):
 *   WHO ACTS: BOTH doors, like every other lobby move - an ERP person (staff.ts style: authorize(record_sale) at the request's OWN store) and a POS
 *   tablet (terminal.ts style: TerminalActor, no authorize(), the request's store must be the tablet's store, another store's request answers exactly
 *   like a ghost id = LOBBY_NOT_FOUND). One shared core, as in S5.
 *   Staff:    listBirthdayRequests(tx, actor, storeId), acceptBirthday(tx, actor, { requestId, scheduledAt: Date }),
 *             declineBirthday(tx, actor, { requestId, reason: string }), markBirthdayPlayed(tx, actor, requestId)
 *   Terminal: listBirthdayForTerminal(tx, terminalActor), acceptBirthdayForTerminal(tx, terminalActor, { requestId, scheduledAt }),
 *             declineBirthdayForTerminal(tx, terminalActor, { requestId, reason }), markBirthdayPlayedForTerminal(tx, terminalActor, requestId)
 *   Results:  accept -> { requestId, status: 'accepted', scheduledAt: Date }; decline -> { requestId, status: 'declined' }; played -> { requestId, status: 'played' }
 *   List row: { requestId, entryId, code, displayName, standLabel, celebrantName, status ('requested' | 'accepted' only), scheduledAt, createdAt }, oldest first,
 *             requested + accepted only; never deviceHash / ipHash / handoffUrl / phone.
 *   decline reason: trimmed, 1..80 chars after trimming, free text (the POS offers three presets; the domain does not enumerate them).
 *   Audit actions (catalogue cap raised by 3): lobby.birthday_accept, lobby.birthday_decline, lobby.birthday_play. store_id = the entry's store, entity_id = the
 *   request id, source 'pos', actor = the acting person (terminal: the terminal person, after.cashier = the cashier's name). Payloads hold NO celebrant or diner name.
 *
 * MUTANT INDEX: accept without a time (or a bogus time) allowed; decline with no/blank/huge reason; accept/decline/play on a request in the wrong state
 * (incl. cancelled-by-diner and expired); played straight from requested; scheduled_at or acted_by not stored; another store's request moved by a store-A
 * cashier or tablet (authorize missing, store taken from the caller); a role without record_sale allowed; terminal calling authorize(); another store's
 * request answered differently from a ghost id; audit missing, wrong actor, cashier missing, a name in the payload; a refused move still audited; list
 * leaking hashes or other stores' or closed requests.
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { APP_ROLE, closeDb, transaction, type Tx } from '@shareat/db';
import { AuthorizationError, flushSecurityEvents, type Actor } from '@shareat/auth';
import {
  acceptBirthday,
  acceptBirthdayForTerminal,
  declineBirthday,
  declineBirthdayForTerminal,
  listBirthdayForTerminal,
  listBirthdayRequests,
  markBirthdayPlayed,
  markBirthdayPlayedForTerminal,
} from '../../src/lobby/birthday';
import { LobbyRefusal } from '../../src/lobby/refusal';
import type { TerminalActor } from '../../src/lobby/terminal';

const sql = postgres(url, { max: 6 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

// ------------------------------------------------------------------------------------------------ helpers
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const inMin = (m: number) => new Date(Date.now() + m * 60_000);

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}
async function refusedIn(orgId: string, fn: (tx: Tx) => Promise<unknown>): Promise<unknown> {
  return asOrg(orgId, async (tx) => {
    let err: unknown;
    try {
      await fn(tx);
    } catch (e) {
      if (e instanceof TypeError && /is not a function|is not defined/.test(e.message)) throw e;
      err = e;
    }
    await tx.execute(dsql`select 1`);
    return err;
  });
}
function expectRefusal(err: unknown, code: string, what: string): LobbyRefusal {
  expect(err, `${what}: was not refused (or not a LobbyRefusal)`).toBeInstanceOf(LobbyRefusal);
  const e = err as LobbyRefusal;
  expect(e.code, `${what}: wrong code (${e.message})`).toBe(code);
  expect(e.userMessage, `${what}: plain sentence`).toMatch(/^[A-Z][^\n]{8,160}[.]$/);
  expect(e.userMessage, `${what}: database wording`).not.toMatch(/violates|constraint|duplicate|relation|lobby_|null value|23\d{3}|LOBBY_/i);
  return e;
}
function expectAuthRefusal(err: unknown, what: string) {
  expect(err, `${what}: not refused with AuthorizationError`).toBeInstanceOf(AuthorizationError);
  expect(`${(err as Error).message}`, `${what}: database wording`).not.toMatch(/violates|duplicate key|relation "/i);
}

type S = { orgId: string; storeId: string };
type Raw = Record<string, string | number | boolean | null>;
const CELEBRANT = 'Benedict Quillfeather';
const DINER = 'Zanzibar Tuckerman';
const CASHIER = 'Cora Cashier';

async function fx(hint: string) {
  const code = uid(`t455s6a-staff-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const store = async (): Promise<S> => {
    const [st] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('ST')}, 'Lipa') returning id`;
    await sql`insert into lobby_stores (org_id, store_id, enabled, paused, max_live_entries, birthday_enabled, pos_seen_at) values (${orgId}, ${st!.id}, true, false, 60, true, now())`;
    return { orgId, storeId: st!.id };
  };
  const A = await store();
  const B = await store();
  const person = async (name: string, role: string | null, scope: string[]): Promise<Actor> => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    if (role) await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    for (const s of scope) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s})`;
    return { personId: p!.id, orgId };
  };
  const cashierA = await person('Cashier A', 'manager', [A.storeId]);
  const floorA = await person('Floor A', 'staff', [A.storeId]); // role without record_sale
  const terminal = await person('Terminal 01', null, []); // NO role, NO store scope: the tablet's person
  const tabletFor = (s: S): TerminalActor => ({ orgId, erpStoreId: s.storeId, terminalPersonId: terminal.personId, cashierName: CASHIER });
  return { orgId, A, B, cashierA, floorA, terminal, tabletFor };
}
type Fx = Awaited<ReturnType<typeof fx>>;

let codeN = Math.floor(Math.random() * 3000);
async function entry(s: S, o: { status?: string; extra?: Raw } = {}): Promise<string> {
  const status = o.status ?? 'waiting';
  const row: Raw = {
    org_id: s.orgId, store_id: s.storeId, source: 'lobby', code: String(1000 + (++codeN % 9000)), display_name: DINER, party_size: 3,
    status, device_hash: uid('dev'), ip_hash: uid('ip'), client_request_id: uid('req'), created_at: ago(5),
    ...(status === 'called' ? { called_at: ago(1) } : {}),
    ...(status === 'seated' ? { session_ref: 'S-1', stand_label: '7', closed_at: ago(1) } : {}),
    ...(o.extra ?? {}),
  };
  const [r] = await sql<{ id: string }[]>`insert into lobby_entries ${sql(row)} returning id`;
  return r!.id;
}
type State = 'requested' | 'accepted' | 'declined' | 'played' | 'expired' | 'cancelled';
/** A request in any state at store s (its own fresh entry, seated if asked so the stand label shows). */
async function request(f: Fx, s: S, state: State = 'requested', o: { seated?: boolean } = {}): Promise<{ id: string; entryId: string }> {
  const entryId = await entry(s, o.seated ? { status: 'seated' } : {});
  const [b] = await sql<{ id: string }[]>`insert into lobby_birthday_requests (org_id, entry_id, celebrant_name, status) values (${f.orgId}, ${entryId}, ${CELEBRANT}, 'requested') returning id`;
  const id = b!.id;
  if (state === 'accepted' || state === 'played') await sql`update lobby_birthday_requests set status = 'accepted', scheduled_at = ${ago(-20)} where id = ${id}`;
  if (state === 'played') await sql`update lobby_birthday_requests set status = 'played', played_at = now() where id = ${id}`;
  if (state === 'declined') await sql`update lobby_birthday_requests set status = 'declined', decline_reason = 'Not tonight' where id = ${id}`;
  if (state === 'expired' || state === 'cancelled') await sql`update lobby_birthday_requests set status = ${state} where id = ${id}`;
  return { id, entryId };
}
const rowOf = async (id: string) => (await sql<Record<string, any>[]>`select * from lobby_birthday_requests where id = ${id}`)[0]!;
const auditFor = async (s: S, action?: string) =>
  await sql<{ action: string; actor_person_id: string | null; source: string; before: unknown; after: unknown; entity_id: string }[]>`
    select action, actor_person_id, source, before, after, entity_id from audit_log
     where org_id = ${s.orgId} and store_id = ${s.storeId} and action like 'lobby.birthday%' ${action ? sql`and action = ${action}` : sql``} order by occurred_at, id`;
const denials = async (f: Fx, actor: Actor) => {
  await flushSecurityEvents();
  return sql<{ after: { capability?: string } | null }[]>`
    select after from audit_log where org_id = ${f.orgId} and action = 'security.authorize_denied' and actor_person_id = ${actor.personId}`;
};

// ================================================================================================ A. the cashier answers (staff door)
describe('A. acceptBirthday / declineBirthday / markBirthdayPlayed by an ERP cashier', () => {
  it('A1 ACCEPT stores the time, the status and who acted; the entry and the celebrant are untouched; one lobby.birthday_accept audit row by the cashier at the entry\'s store [kills: time dropped, acted_by missing, no audit, wrong actor]', async () => {
    const f = await fx('a1');
    const r = await request(f, f.A);
    const when = inMin(30);
    const out = await asOrg(f.orgId, (tx) => acceptBirthday(tx, f.cashierA, { requestId: r.id, scheduledAt: when }));
    expect(out).toMatchObject({ requestId: r.id, status: 'accepted' });
    const row = await rowOf(r.id);
    expect(row).toMatchObject({ status: 'accepted', celebrant_name: CELEBRANT, acted_by_person_id: f.cashierA.personId, decline_reason: null, played_at: null });
    expect(new Date(row.scheduled_at).getTime()).toBe(when.getTime());
    expect(row.accepted_at).not.toBeNull();
    const audit = await auditFor(f.A);
    expect(audit.map((a) => a.action)).toEqual(['lobby.birthday_accept']);
    expect(audit[0]).toMatchObject({ actor_person_id: f.cashierA.personId, entity_id: r.id });
  });

  it('A2 ACCEPT WITHOUT A TIME REFUSED: no time or null -> LOBBY_BIRTHDAY_NEEDS_TIME, an invalid date -> LOBBY_BAD_INPUT; the request stays requested and nothing is audited [kills: accepting with no scheduled_at, DB CHECK as the only guard]', async () => {
    const f = await fx('a2');
    const r = await request(f, f.A);
    const run = (input: unknown) => refusedIn(f.orgId, (tx) => acceptBirthday(tx, f.cashierA, input as { requestId: string; scheduledAt: Date }));
    expectRefusal(await run({ requestId: r.id }), 'LOBBY_BIRTHDAY_NEEDS_TIME', 'no time');
    expectRefusal(await run({ requestId: r.id, scheduledAt: null }), 'LOBBY_BIRTHDAY_NEEDS_TIME', 'null time');
    expectRefusal(await run({ requestId: r.id, scheduledAt: new Date('nope') }), 'LOBBY_BAD_INPUT', 'invalid date');
    const row = await rowOf(r.id);
    expect(row).toMatchObject({ status: 'requested', scheduled_at: null, accepted_at: null, acted_by_person_id: null });
    expect(await auditFor(f.A)).toHaveLength(0);
  });

  it('A3 DECLINE SETS THE REASON: status declined, the trimmed reason stored, no time, who acted, one lobby.birthday_decline audit row [kills: reason dropped or untrimmed, acted_by missing, no audit]', async () => {
    const f = await fx('a3');
    const r = await request(f, f.A);
    const out = await asOrg(f.orgId, (tx) => declineBirthday(tx, f.cashierA, { requestId: r.id, reason: '  Not tonight, the shop is full  ' }));
    expect(out).toMatchObject({ requestId: r.id, status: 'declined' });
    expect(await rowOf(r.id)).toMatchObject({ status: 'declined', decline_reason: 'Not tonight, the shop is full', scheduled_at: null, acted_by_person_id: f.cashierA.personId });
    const audit = await auditFor(f.A);
    expect(audit.map((a) => a.action)).toEqual(['lobby.birthday_decline']);
  });

  it('A4 decline needs a reason: missing, blank, a number and 81 characters are LOBBY_BAD_INPUT, 80 is kept; nothing changes on a refusal [kills: decline with no reason, no length limit, off by one]', async () => {
    const f = await fx('a4');
    const r = await request(f, f.A);
    for (const bad of [undefined, '', '   ', 7, 'z'.repeat(81)] as unknown[]) {
      expectRefusal(await refusedIn(f.orgId, (tx) => declineBirthday(tx, f.cashierA, { requestId: r.id, reason: bad as string })), 'LOBBY_BAD_INPUT', `reason ${JSON.stringify(bad)}`);
    }
    expect(await rowOf(r.id)).toMatchObject({ status: 'requested', decline_reason: null });
    expect(await auditFor(f.A)).toHaveLength(0);
    const ok = await request(f, f.A);
    await asOrg(f.orgId, (tx) => declineBirthday(tx, f.cashierA, { requestId: ok.id, reason: 'z'.repeat(80) }));
    expect((await rowOf(ok.id)).decline_reason).toBe('z'.repeat(80));
  });

  it('A5 PLAY: accepted -> played with played_at set, the time kept, one lobby.birthday_play audit row; playing twice is refused [kills: played_at missing, time wiped, no audit, double play]', async () => {
    const f = await fx('a5');
    const r = await request(f, f.A, 'accepted');
    const before = await rowOf(r.id);
    const out = await asOrg(f.orgId, (tx) => markBirthdayPlayed(tx, f.cashierA, r.id));
    expect(out).toMatchObject({ requestId: r.id, status: 'played' });
    const row = await rowOf(r.id);
    expect(row.status).toBe('played');
    expect(row.played_at).not.toBeNull();
    expect(row.scheduled_at).toEqual(before.scheduled_at);
    expect((await auditFor(f.A)).map((a) => a.action)).toEqual(['lobby.birthday_play']);
    expectRefusal(await refusedIn(f.orgId, (tx) => markBirthdayPlayed(tx, f.cashierA, r.id)), 'LOBBY_BIRTHDAY_CLOSED', 'play twice');
    expect(await auditFor(f.A)).toHaveLength(1);
  });

  it('A6 a move the state does not allow is LOBBY_BIRTHDAY_CLOSED and changes nothing: accept or decline anything but requested, play anything but accepted (incl. cancelled by the diner and expired) [kills: accept after the diner cancelled, play from requested, decline after accept, DB trigger as the only guard]', async () => {
    const f = await fx('a6');
    const acceptable: State[] = ['accepted', 'declined', 'played', 'expired', 'cancelled'];
    for (const st of acceptable) {
      const r = await request(f, f.A, st);
      const before = await rowOf(r.id);
      expectRefusal(await refusedIn(f.orgId, (tx) => acceptBirthday(tx, f.cashierA, { requestId: r.id, scheduledAt: inMin(10) })), 'LOBBY_BIRTHDAY_CLOSED', `accept ${st}`);
      expectRefusal(await refusedIn(f.orgId, (tx) => declineBirthday(tx, f.cashierA, { requestId: r.id, reason: 'No' })), 'LOBBY_BIRTHDAY_CLOSED', `decline ${st}`);
      expect(await rowOf(r.id), st).toEqual(before);
    }
    for (const st of ['requested', 'declined', 'expired', 'cancelled'] as State[]) {
      const r = await request(f, f.A, st);
      const before = await rowOf(r.id);
      expectRefusal(await refusedIn(f.orgId, (tx) => markBirthdayPlayed(tx, f.cashierA, r.id)), 'LOBBY_BIRTHDAY_CLOSED', `play ${st}`);
      expect(await rowOf(r.id), st).toEqual(before);
    }
    expect(await auditFor(f.A)).toHaveLength(0);
  });

  it('A7 a request id that does not exist is LOBBY_NOT_FOUND on every move [kills: a raw error, a silent success]', async () => {
    const f = await fx('a7');
    const ghost = '019f0000-0000-7000-8000-000000000000';
    expectRefusal(await refusedIn(f.orgId, (tx) => acceptBirthday(tx, f.cashierA, { requestId: ghost, scheduledAt: inMin(10) })), 'LOBBY_NOT_FOUND', 'accept ghost');
    expectRefusal(await refusedIn(f.orgId, (tx) => declineBirthday(tx, f.cashierA, { requestId: ghost, reason: 'No' })), 'LOBBY_NOT_FOUND', 'decline ghost');
    expectRefusal(await refusedIn(f.orgId, (tx) => markBirthdayPlayed(tx, f.cashierA, ghost)), 'LOBBY_NOT_FOUND', 'play ghost');
  });
});

// ================================================================================================ B. permissions, staff door
describe('B. staff permissions: record_sale at the request\'s own store; every allowed move has a refusing twin', () => {
  type Call = [string, (tx: Tx, who: Actor, s: S, id: string) => Promise<unknown>, State];
  const calls: Call[] = [
    ['listBirthdayRequests', (tx, who, s) => listBirthdayRequests(tx, who, s.storeId), 'requested'],
    ['acceptBirthday', (tx, who, _s, id) => acceptBirthday(tx, who, { requestId: id, scheduledAt: inMin(15) }), 'requested'],
    ['declineBirthday', (tx, who, _s, id) => declineBirthday(tx, who, { requestId: id, reason: 'Not tonight' }), 'requested'],
    ['markBirthdayPlayed', (tx, who, _s, id) => markBirthdayPlayed(tx, who, id), 'accepted'],
  ];

  it.each(calls)('B1 %s: a cashier of store A at store B is refused with AuthorizationError and nothing changes or is audited [kills: authorize missing, wrong capability, store taken from the caller, no storeId]', async (name, call, state) => {
    const f = await fx('b1');
    const r = await request(f, f.B, state);
    const before = await rowOf(r.id);
    expectAuthRefusal(await refusedIn(f.orgId, (tx) => call(tx, f.cashierA, f.B, r.id)), `${name} at store B`);
    expect(await rowOf(r.id), `${name}: the refused call changed the request`).toEqual(before);
    expect(await auditFor(f.B)).toHaveLength(0);
  });

  it.each(calls)('B2 %s: a role WITHOUT record_sale is refused at its own store and a denial row is written [kills: any signed-in person may act]', async (name, call, state) => {
    const f = await fx('b2');
    const r = await request(f, f.A, state);
    const before = await rowOf(r.id);
    expect((await denials(f, f.floorA)).length).toBe(0);
    expectAuthRefusal(await refusedIn(f.orgId, (tx) => call(tx, f.floorA, f.A, r.id)), `${name} by floor staff`);
    expect(await rowOf(r.id)).toEqual(before);
    expect((await denials(f, f.floorA)).length, `${name}: no denial row written`).toBeGreaterThanOrEqual(1);
  });

  it('B3 positive control: the same cashier succeeds at her own store with all four calls [kills: a blanket refusal]', async () => {
    const f = await fx('b3');
    const a = await request(f, f.A, 'requested');
    const d = await request(f, f.A, 'requested');
    const p = await request(f, f.A, 'accepted');
    await asOrg(f.orgId, async (tx) => {
      expect((await listBirthdayRequests(tx, f.cashierA, f.A.storeId)).length).toBeGreaterThanOrEqual(3);
      expect((await acceptBirthday(tx, f.cashierA, { requestId: a.id, scheduledAt: inMin(15) })).status).toBe('accepted');
      expect((await declineBirthday(tx, f.cashierA, { requestId: d.id, reason: 'Not tonight' })).status).toBe('declined');
      expect((await markBirthdayPlayed(tx, f.cashierA, p.id)).status).toBe('played');
    });
  });
});

// ================================================================================================ C. the tablet door
describe('C. the POS tablet (terminal actor, no capability): own store only, another store answers like a ghost', () => {
  it('C1 the tablet accepts, declines and plays at its OWN store: the terminal person is the actor, source pos, after.cashier = the cashier\'s name [kills: authorize() demanded of a person with no role, actor not the terminal, cashier missing]', async () => {
    const f = await fx('c1');
    const a = await request(f, f.A, 'requested');
    const d = await request(f, f.A, 'requested');
    const p = await request(f, f.A, 'accepted');
    await asOrg(f.orgId, async (tx) => {
      await acceptBirthdayForTerminal(tx, f.tabletFor(f.A), { requestId: a.id, scheduledAt: inMin(15) });
      await declineBirthdayForTerminal(tx, f.tabletFor(f.A), { requestId: d.id, reason: 'Not tonight' });
      await markBirthdayPlayedForTerminal(tx, f.tabletFor(f.A), p.id);
    });
    expect((await rowOf(a.id)).status).toBe('accepted');
    expect((await rowOf(a.id)).acted_by_person_id).toBe(f.terminal.personId);
    expect(await rowOf(d.id)).toMatchObject({ status: 'declined', decline_reason: 'Not tonight', acted_by_person_id: f.terminal.personId });
    expect((await rowOf(p.id)).status).toBe('played');
    const audit = await auditFor(f.A);
    expect(audit.map((x) => x.action).sort()).toEqual(['lobby.birthday_accept', 'lobby.birthday_decline', 'lobby.birthday_play']);
    for (const row of audit) {
      expect(row.actor_person_id, row.action).toBe(f.terminal.personId);
      expect(row.source).toBe('pos');
      expect((row.after as Record<string, unknown>).cashier, `${row.action} after.cashier`).toBe(CASHIER);
    }
  });

  it('C2 ANOTHER STORE\'S request: accept, decline, play all answer LOBBY_NOT_FOUND - byte-for-byte what a ghost id answers - and change nothing [kills: store check missing, a distinguishable refusal that lets a tablet probe other stores]', async () => {
    const f = await fx('c2');
    const other = await request(f, f.B, 'requested');
    const otherAccepted = await request(f, f.B, 'accepted');
    const ghost = '019f0000-0000-7000-8000-000000000001';
    const tablet = f.tabletFor(f.A);
    const run = (name: 'accept' | 'decline' | 'play', id: string) =>
      refusedIn(f.orgId, (tx) =>
        name === 'accept'
          ? acceptBirthdayForTerminal(tx, tablet, { requestId: id, scheduledAt: inMin(10) })
          : name === 'decline'
            ? declineBirthdayForTerminal(tx, tablet, { requestId: id, reason: 'No' })
            : markBirthdayPlayedForTerminal(tx, tablet, id),
      );
    const beforeA = await rowOf(other.id);
    const beforeB = await rowOf(otherAccepted.id);
    for (const [name, id] of [['accept', other.id], ['decline', other.id], ['play', otherAccepted.id]] as const) {
      const real = expectRefusal(await run(name, id), 'LOBBY_NOT_FOUND', `${name} other store`);
      const ghosted = expectRefusal(await run(name, ghost), 'LOBBY_NOT_FOUND', `${name} ghost`);
      expect(real.userMessage).toBe(ghosted.userMessage);
    }
    expect(await rowOf(other.id)).toEqual(beforeA);
    expect(await rowOf(otherAccepted.id)).toEqual(beforeB);
    expect(await auditFor(f.B)).toHaveLength(0);
  });

  it('C3 the tablet rules are the staff rules: accept without a time, decline without a reason, a wrong-state move all refuse the same way [kills: a second, looser copy of the state logic in the terminal door]', async () => {
    const f = await fx('c3');
    const r = await request(f, f.A, 'requested');
    const tablet = f.tabletFor(f.A);
    expectRefusal(await refusedIn(f.orgId, (tx) => acceptBirthdayForTerminal(tx, tablet, { requestId: r.id } as never)), 'LOBBY_BIRTHDAY_NEEDS_TIME', 'terminal accept, no time');
    expectRefusal(await refusedIn(f.orgId, (tx) => declineBirthdayForTerminal(tx, tablet, { requestId: r.id, reason: ' ' })), 'LOBBY_BAD_INPUT', 'terminal decline, blank reason');
    expectRefusal(await refusedIn(f.orgId, (tx) => markBirthdayPlayedForTerminal(tx, tablet, r.id)), 'LOBBY_BIRTHDAY_CLOSED', 'terminal play from requested');
    const done = await request(f, f.A, 'played');
    expectRefusal(await refusedIn(f.orgId, (tx) => acceptBirthdayForTerminal(tx, tablet, { requestId: done.id, scheduledAt: inMin(5) })), 'LOBBY_BIRTHDAY_CLOSED', 'terminal accept after play');
    expect(await rowOf(r.id)).toMatchObject({ status: 'requested', scheduled_at: null });
    expect(await auditFor(f.A)).toHaveLength(0);
  });
});

// ================================================================================================ D. the list the tablet and the screen read
describe('D. the birthday list', () => {
  it('D1 the tablet list holds only OWN-store requested + accepted requests, oldest first, with code, stand, celebrant, party name and time - and no hash, hand-off link or phone [kills: other store\'s rows, closed requests, secrets in the list, wrong order]', async () => {
    const f = await fx('d1');
    const first = await request(f, f.A, 'requested', { seated: true });
    await new Promise((r) => setTimeout(r, 15));
    const second = await request(f, f.A, 'accepted');
    await request(f, f.A, 'declined');
    await request(f, f.A, 'played');
    await request(f, f.A, 'expired');
    await request(f, f.A, 'cancelled');
    const foreign = await request(f, f.B, 'requested');
    const list = await asOrg(f.orgId, (tx) => listBirthdayForTerminal(tx, f.tabletFor(f.A)));
    const rows = Array.isArray(list) ? list : (list as { requests: unknown[] }).requests;
    expect((rows as { requestId: string }[]).map((r) => r.requestId)).toEqual([first.id, second.id]);
    expect((rows as { requestId: string }[]).some((r) => r.requestId === foreign.id)).toBe(false);
    const head = (rows as Record<string, unknown>[])[0]!;
    expect(head).toMatchObject({ requestId: first.id, entryId: first.entryId, celebrantName: CELEBRANT, displayName: DINER, status: 'requested', standLabel: '7', scheduledAt: null });
    expect(head.code).toMatch(/^[1-9][0-9]{3}$/);
    expect((rows as Record<string, unknown>[])[1]!.scheduledAt).toBeInstanceOf(Date);
    const dump = JSON.stringify(rows);
    for (const key of ['deviceHash', 'device_hash', 'ipHash', 'ip_hash', 'handoffUrl', 'handoff_url', 'phone']) expect(dump.includes(key), key).toBe(false);
  });

  it('D2 the staff list is the same list for the store asked (store A\'s cashier sees A\'s requests, not B\'s) [kills: store filter missing]', async () => {
    const f = await fx('d2');
    const mine = await request(f, f.A, 'requested');
    const foreign = await request(f, f.B, 'requested');
    const rows = await asOrg(f.orgId, (tx) => listBirthdayRequests(tx, f.cashierA, f.A.storeId));
    const ids = rows.map((r: { requestId: string }) => r.requestId);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(foreign.id);
  });
});

// ================================================================================================ E. audit payloads carry no personal data
describe('E. audit payloads: no celebrant, no diner name, no phone, no hash', () => {
  it('E1 accept, decline and play by staff AND by the tablet leave audit payloads with none of the names or the hashes [kills: personal data in audit_log]', async () => {
    const f = await fx('e1');
    const a = await request(f, f.A, 'requested');
    const d = await request(f, f.A, 'requested');
    const p = await request(f, f.A, 'accepted');
    const a2 = await request(f, f.A, 'requested');
    await asOrg(f.orgId, async (tx) => {
      await acceptBirthday(tx, f.cashierA, { requestId: a.id, scheduledAt: inMin(15) });
      await declineBirthday(tx, f.cashierA, { requestId: d.id, reason: 'Not tonight' });
      await markBirthdayPlayed(tx, f.cashierA, p.id);
      await acceptBirthdayForTerminal(tx, f.tabletFor(f.A), { requestId: a2.id, scheduledAt: inMin(20) });
    });
    const audit = await auditFor(f.A);
    expect(audit).toHaveLength(4);
    const dump = JSON.stringify(audit);
    for (const secret of [CELEBRANT, DINER, 'Benedict', 'Zanzibar', 'dev-', 'ip-']) expect(dump.includes(secret), `the audit payload leaks ${secret}`).toBe(false);
  });
});

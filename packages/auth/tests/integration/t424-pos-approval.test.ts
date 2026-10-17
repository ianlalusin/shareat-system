import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-424 (TESTER) - the POS v2 manager-PIN approval and the terminal link. docs/tasks/424-pos-v2-server-approvals.md
 * Ruling 5 (+ B1 fix), S5, Acceptance 4, 10 (auth half), 11. Runs on its own lane database (shareat_test_t424, a copy of shareat_test_t416).
 *
 * CONTRACT PINNED HERE (the builder matches; every name below is exported from `@shareat/auth` unless stated):
 *   verifyPosManagerApproval(tx: Tx | null, { orgId, erpStoreId, pin, terminalPersonId }) => Promise<{ approverPersonId }>
 *     modelled line for line on verifyAdminApproval; allowed iff the PIN is right AND its owner may sign in to the org AND is not a
 *     terminal AND (is an active admin OR holds the NEW capability `approve_pos_correction` AT `erpStoreId`) AND `terminalPersonId`
 *     is a terminal person credentialed to `erpStoreId`. EVERY refusal reads POS_APPROVAL_REFUSED (one sentence, no oracle).
 *     A wrong PIN is a miss on `{ actor: terminalPersonId }` (T-416: 5 per person per rolling 24 h); the store's sign-in budget is
 *     never charged. A capped terminal reads the T-416 capped sentence for EVERY attempt (correct PIN included) - for a terminal it
 *     must name the STORE MANAGER as who can clear it (a terminal person has no user page).
 *   POS_APPROVAL_REFUSED: string; POS_TERMINAL_NOT_REGISTERED = 'This tablet is not registered for approvals yet. Ask an administrator to register it.'
 *   resolvePosTerminalLink(tx, { orgId, posStoreId, deviceId }) => Promise<{ erpStoreId, terminalPersonId, terminalNo, linkId }>
 *     posStoreId = the Firestore store id (pos_v1_store_links.pos_store_id), which must have a LIVE (not unlinked) link row; it picks the
 *     single ACTIVE (revoked_at is null) pos_terminal_links row of that store whose device_id = deviceId; none => AuthenticationError
 *     POS_TERMINAL_NOT_REGISTERED. A deviceId that is not a uuid is refused with an error that is NOT a Postgres syntax error
 *     (message must not contain "invalid input syntax"; it must mention the device id).
 *   provisionPosTerminalLink(tx, actor, { storeId (ERP), terminalNo: number, deviceId: uuid, terminalPersonId }) => Promise<{ linkId }>
 *     exported from `@shareat/domain`; gated by the EXISTING `provision_clock_terminal` capability at the store (admin yes, manager no);
 *     refuses a person who is not a terminal; revokes the store's previous active link in the same transaction (ADR A3: one tablet per store);
 *     writes one audit_log row (action contains "terminal_link", entity_id = the link id). Table `pos_terminal_links` columns used here
 *     (fixed by the spec): org_id, store_id, pos_v1_store_link_id, terminal_no, device_id, terminal_person_id, revoked_at.
 *   Capability `approve_pos_correction` (store scope). A hand grant is person_grants(grant_name, grant_source 'grant', store_id).
 *
 * RED FOR THE RIGHT REASON BEFORE THE BUILD: `@shareat/auth` has none of these exports and `pos_terminal_links` does not exist; every case
 * goes through `need()` / the table, so each fails with "MISSING EXPORT ..." or "relation pos_terminal_links does not exist", never vacuously.
 *
 * MUTANTS (one-line edits, run, red, reverted):
 *   M1 charge the sign-in store bucket / the manager's bucket instead of the terminal person   -> A4-cap-isolation red
 *   M2 drop the store-scope term (capability checked without storeId)                           -> A4-refused (manager at B) red
 *   M3 drop `!isTerminal`                                                                       -> A4-refused (terminal's own PIN) red
 *   M4 drop `maySignIn`                                                                         -> A4-refused (diner with grant) red
 *   M5 a second sentence for a wrong PIN vs a right PIN of the wrong person                    -> A4-one-sentence red
 *   M6 resolve ignores revoked_at                                                               -> A11-reprovision red
 *   M7 resolve takes the store from the deviceId's link instead of the live pos store link      -> A10-forged-device red
 *   M8 skip the uuid check                                                                      -> A10-non-uuid red
 *   M9 provision without authorize()                                                            -> A11-capability red
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - name must contain "_test".`);
}

import { APP_ROLE, closeDb, transaction, type Tx } from '@shareat/db';
import * as auth from '@shareat/auth';
import * as domain from '@shareat/domain';
import { AuthorizationError, flushSecurityEvents, hashPin, pinLookupHash } from '@shareat/auth';

const sql = postgres(url, { max: 8 });

const TERMINAL_NOT_REGISTERED = 'This tablet is not registered for approvals yet. Ask an administrator to register it.';
const WRONG = '000000';

function need<T = (...a: any[]) => any>(mod: Record<string, unknown>, name: string, pkg: string): T {
  const v = mod[name];
  if (v === undefined) throw new Error(`MISSING EXPORT: ${pkg} does not export ${name} (T-424 not built).`);
  return v as T;
}
type Approve = (
  tx: null,
  input: { orgId: string; erpStoreId: string; pin: string; terminalPersonId: string },
) => Promise<{ approverPersonId: string }>;
const verify = (...a: Parameters<Approve>) => need<Approve>(auth as any, 'verifyPosManagerApproval', '@shareat/auth')(...a);
const refusedSentence = () => need<string>(auth as any, 'POS_APPROVAL_REFUSED', '@shareat/auth');
type Resolve = (
  tx: Tx,
  input: { orgId: string; posStoreId: string; deviceId: string },
) => Promise<{ erpStoreId: string; terminalPersonId: string; terminalNo: number; linkId: string }>;
type Provision = (
  tx: Tx,
  actor: { personId: string; orgId: string },
  input: { storeId: string; terminalNo: number; deviceId: string; terminalPersonId: string },
) => Promise<{ linkId: string }>;

let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
let pinSeq = 0;
const nextPin = () => String(500000 + ++pinSeq * 19);
const uuid = (): string => (globalThis.crypto as Crypto).randomUUID();

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

interface Who {
  personId: string;
  pin: string;
}
interface Fixture {
  orgId: string;
  storeA: string;
  storeB: string;
  posStoreA: string;
  posStoreB: string;
  admin: Who;
  managerA: Who; // role manager, scope A, grant approve_pos_correction at A
  managerB: Who; // role manager, scope B, grant at B
  cashier: Who; // staff, employed at A, live PIN, NO capability
  diner: Who; // no role, no employment; holds the grant at A (row 350: a PIN alone, or a grant alone, is not a manager)
  termA1: Who; // terminal person of A, with a PIN of its own
  termA2: Who;
  termB: Who;
}

async function org(hint: string): Promise<Fixture> {
  const code = uid(`t424-${hint}`);
  const [o] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = o!.id;
  const mkStore = async (h: string) =>
    (await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(h)}, ${h}) returning id`)[0]!.id;
  const storeA = await mkStore('A');
  const storeB = await mkStore('B');
  const mk = async (name: string, role: string | null, scope: string[], employedAt: string | null = null): Promise<Who> => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    const personId = p!.id;
    if (role) await sql`insert into person_roles (person_id, org_id, role) values (${personId}, ${orgId}, ${role})`;
    for (const s of scope) await sql`insert into person_store_scope (person_id, store_id, source) values (${personId}, ${s}, 'manual')`;
    if (employedAt) {
      await sql`
        insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
        values (${orgId}, ${employedAt}, ${personId}, ${uid('SE')}, 'regular', '2025-01-01')`;
    }
    const pin = nextPin();
    await sql`
      insert into person_credentials (person_id, kind, store_id, secret_hash, lookup_hash)
      values (${personId}, 'pin', ${scope[0] ?? storeA}, ${await hashPin(pin)}, ${pinLookupHash(orgId, pin)})`;
    return { personId, pin };
  };
  const admin = await mk('Alice Admin', 'admin', [storeA, storeB]);
  const grant = async (w: Who, store: string) =>
    sql`insert into person_grants (person_id, grant_name, granted_by, grant_source, store_id)
        values (${w.personId}, 'approve_pos_correction', ${admin.personId}, 'grant', ${store})`;
  const managerA = await mk('Manny Manager', 'manager', [storeA]);
  const managerB = await mk('Mona Manager', 'manager', [storeB]);
  await grant(managerA, storeA);
  await grant(managerB, storeB);
  const cashier = await mk('Cara Cashier', 'staff', [storeA], storeA);
  const diner = await mk('Dina Diner', null, [storeA]);
  await grant(diner, storeA);
  const mkTerminal = async (name: string, store: string): Promise<Who> => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name, kind) values (${orgId}, ${name}, 'terminal') returning id`;
    await sql`insert into person_credentials (person_id, kind, store_id, external_id) values (${p!.id}, 'firebase', ${store}, ${uid('fbuid')})`;
    const pin = nextPin();
    await sql`
      insert into person_credentials (person_id, kind, store_id, secret_hash, lookup_hash)
      values (${p!.id}, 'pin', ${store}, ${await hashPin(pin)}, ${pinLookupHash(orgId, pin)})`;
    return { personId: p!.id, pin };
  };
  const posStoreA = uid('pos-store-a');
  const posStoreB = uid('pos-store-b');
  for (const [store, pos] of [[storeA, posStoreA], [storeB, posStoreB]] as const) {
    const [ch] = await sql<{ id: string }[]>`
      insert into sales_channels (org_id, store_id, name, is_remitted_daily) values (${orgId}, ${store}, 'Walk-in', true) returning id`;
    await sql`
      insert into pos_v1_store_links (org_id, store_id, pos_store_id, pos_store_name, sales_channel_id, pos_tax_type, created_by)
      values (${orgId}, ${store}, ${pos}, 'POS store', ${ch!.id}, 'vat_inclusive', ${admin.personId})`;
  }
  return {
    orgId, storeA, storeB, posStoreA, posStoreB, admin, managerA, managerB, cashier, diner,
    termA1: await mkTerminal('Terminal A1', storeA),
    termA2: await mkTerminal('Terminal A2', storeA),
    termB: await mkTerminal('Terminal B', storeB),
  };
}

const adminActor = (f: Fixture) => ({ personId: f.admin.personId, orgId: f.orgId });
const link = (f: Fixture, actor: { personId: string; orgId: string }, storeId: string, term: Who, deviceId: string, terminalNo = 1) =>
  asOrg(f.orgId, (tx) =>
    need<Provision>(domain as any, 'provisionPosTerminalLink', '@shareat/domain')(tx, actor, { storeId, terminalNo, deviceId, terminalPersonId: term.personId }),
  );
const resolveLink = (f: Fixture, posStoreId: string, deviceId: string) =>
  asOrg(f.orgId, (tx) => need<Resolve>(auth as any, 'resolvePosTerminalLink', '@shareat/auth')(tx, { orgId: f.orgId, posStoreId, deviceId }));
const approve = (f: Fixture, term: Who, pin: string, erpStoreId = f.storeA) =>
  verify(null, { orgId: f.orgId, erpStoreId, pin, terminalPersonId: term.personId });
const msg = (p: Promise<unknown>): Promise<string> => p.then(() => 'OK', (e: Error) => e.message);
const missesOf = async (f: Fixture, who: Who) =>
  (await sql<{ n: number }[]>`select count(*)::int as n from sign_in_attempts where org_id = ${f.orgId} and actor_person_id = ${who.personId} and kind = 'miss'`)[0]!.n;
const storeBucketRows = async (f: Fixture) =>
  (await sql<{ n: number }[]>`select count(*)::int as n from sign_in_attempts where org_id = ${f.orgId} and store_id in (${f.storeA}, ${f.storeB})`)[0]!.n;

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});
beforeEach(async () => {
  await flushSecurityEvents();
});

describe('Acceptance 4 - the approval', () => {
  it('A4-pass: a manager holding approve_pos_correction at the store, and an administrator, both approve', async () => {
    const f = await org('a4pass');
    expect(await approve(f, f.termA1, f.managerA.pin)).toEqual({ approverPersonId: f.managerA.personId });
    expect(await approve(f, f.termA1, f.admin.pin)).toEqual({ approverPersonId: f.admin.personId });
  });

  it('A4-refused: the same manager at another store, a cashier, a diner-only person with the grant, a terminal PIN, a wrong PIN, a bad format - all the ONE sentence (M2, M3, M4)', async () => {
    const f = await org('a4ref');
    const one = refusedSentence();
    expect(one.length).toBeGreaterThan(10);
    const outcomes: Record<string, string> = {
      'manager A at store B': await msg(approve(f, f.termB, f.managerA.pin, f.storeB)),
      'cashier at A': await msg(approve(f, f.termA1, f.cashier.pin)),
      'diner with the grant at A': await msg(approve(f, f.termA1, f.diner.pin)),
      "the terminal's own PIN": await msg(approve(f, f.termA2, f.termA1.pin)),
      'wrong PIN': await msg(approve(f, f.termA1, WRONG)),
      'bad format': await msg(approve(f, f.termA2, '12')),
      'terminal of store B used at store A': await msg(approve(f, f.termB, f.managerA.pin, f.storeA)),
    };
    for (const [who, m] of Object.entries(outcomes)) expect(m, who).toBe(one);
  });

  it('A4-one-sentence: a right PIN of the wrong person reads exactly like a wrong PIN (no oracle) (M5)', async () => {
    const f = await org('a4one');
    const right = await msg(approve(f, f.termA1, f.cashier.pin));
    const wrong = await msg(approve(f, f.termA2, WRONG));
    expect(right).toBe(wrong);
  });

  it("A4-cap-isolation: the 6th wrong PIN from one terminal is refused even when correct; another terminal at the same store is unaffected; the store sign-in budget and the manager's bucket are never charged (M1)", async () => {
    const f = await org('a4cap');
    const one = refusedSentence();
    for (let i = 0; i < 5; i++) expect(await msg(approve(f, f.termA1, WRONG)), `miss ${i + 1}`).toBe(one);
    const capped = await msg(approve(f, f.termA1, f.managerA.pin));
    expect(capped, 'the sixth attempt, correct PIN').not.toBe('OK');
    expect(capped).not.toBe(one);
    expect(capped, 'a terminal has no user page: the sentence names the store manager').toMatch(/store manager/i);
    expect(capped).not.toMatch(/user page/i);
    expect(await msg(approve(f, f.termA1, f.managerA.pin)), 'still capped, same sentence').toBe(capped);
    expect(await approve(f, f.termA2, f.managerA.pin), 'another terminal of the same store is unaffected').toEqual({ approverPersonId: f.managerA.personId });
    expect(await missesOf(f, f.termA1)).toBe(5);
    expect(await missesOf(f, f.managerA), "the manager's own bucket is untouched").toBe(0);
    expect(await missesOf(f, f.termA2)).toBe(0);
    expect(await storeBucketRows(f), "the store's sign-in budget has no rows").toBe(0);
    const rows = await sql<{ store_id: string | null }[]>`select store_id from sign_in_attempts where org_id = ${f.orgId} and actor_person_id = ${f.termA1.personId}`;
    for (const r of rows) expect(r.store_id).toBeNull();
  });

  it('A4-refund: a correct approval refunds its charge (ten in a row leave no miss rows)', async () => {
    const f = await org('a4refund');
    for (let i = 0; i < 10; i++) expect(await approve(f, f.termA1, f.managerA.pin)).toEqual({ approverPersonId: f.managerA.personId });
    expect(await missesOf(f, f.termA1)).toBe(0);
  });
});

describe('Acceptance 10 (auth half) - the terminal link, not Firestore, decides the store and the bucket', () => {
  it('A10-resolve: a provisioned device resolves to its store, terminal person and number', async () => {
    const f = await org('a10res');
    const dev = uuid();
    const { linkId } = await link(f, adminActor(f), f.storeA, f.termA1, dev, 3);
    const r = await resolveLink(f, f.posStoreA, dev);
    expect(r).toMatchObject({ erpStoreId: f.storeA, terminalPersonId: f.termA1.personId, terminalNo: 3, linkId });
  });

  it("A10-forged-device: the device id registered at store B is refused at store A's POS store (M7)", async () => {
    const f = await org('a10forge');
    const devA = uuid();
    const devB = uuid();
    await link(f, adminActor(f), f.storeA, f.termA1, devA);
    await link(f, adminActor(f), f.storeB, f.termB, devB);
    expect(await msg(resolveLink(f, f.posStoreA, devB)), "B's device at A's store").toBe(TERMINAL_NOT_REGISTERED);
    expect(await msg(resolveLink(f, f.posStoreB, devA)), "A's device at B's store").toBe(TERMINAL_NOT_REGISTERED);
    expect(await msg(resolveLink(f, f.posStoreA, uuid())), 'an unknown device').toBe(TERMINAL_NOT_REGISTERED);
    expect((await resolveLink(f, f.posStoreB, devB)).erpStoreId).toBe(f.storeB);
  });

  it('A10-unlinked: a store whose POS link was unlinked has no registered tablet', async () => {
    const f = await org('a10unl');
    const dev = uuid();
    await link(f, adminActor(f), f.storeA, f.termA1, dev);
    await sql`update pos_v1_store_links set unlinked_at = now(), unlinked_by = ${f.admin.personId}, unlink_reason = 'test' where store_id = ${f.storeA}`;
    expect(await msg(resolveLink(f, f.posStoreA, dev))).toBe(TERMINAL_NOT_REGISTERED);
  });

  it('A10-non-uuid: a device id that is not a uuid is refused before any query - not a Postgres syntax error (M8)', async () => {
    const f = await org('a10uuid');
    const m = await msg(resolveLink(f, f.posStoreA, 'not-a-uuid'));
    expect(m).not.toBe('OK');
    expect(m).not.toMatch(/invalid input syntax/i);
    expect(m).toMatch(/device/i);
  });
});

describe('Acceptance 11 - provisioning and re-provisioning', () => {
  it('A11-write: the link row has the spec columns, the audit row exists, a non-terminal person is refused', async () => {
    const f = await org('a11write');
    const dev = uuid();
    const { linkId } = await link(f, adminActor(f), f.storeA, f.termA1, dev, 2);
    const rows = await sql<any[]>`select * from pos_terminal_links where id = ${linkId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ org_id: f.orgId, store_id: f.storeA, terminal_no: 2, device_id: dev, terminal_person_id: f.termA1.personId });
    expect(rows[0].revoked_at).toBeNull();
    const live = await sql<{ id: string }[]>`select id from pos_v1_store_links where store_id = ${f.storeA} and unlinked_at is null`;
    expect(rows[0].pos_v1_store_link_id).toBe(live[0]!.id);
    await flushSecurityEvents();
    const audit = await sql<{ action: string }[]>`select action from audit_log where org_id = ${f.orgId} and entity_id = ${linkId}`;
    expect(audit.length).toBeGreaterThanOrEqual(1);
    expect(audit.some((a) => /terminal_link/i.test(a.action))).toBe(true);
    const notTerminal = await msg(link(f, adminActor(f), f.storeA, f.cashier, uuid(), 4));
    expect(notTerminal, 'a cashier cannot be a tablet').not.toBe('OK');
  });

  it("A11-capability: only the provisioning capability writes a link - a manager and a cashier are refused, nothing is written (M9)", async () => {
    const f = await org('a11cap');
    for (const who of [f.managerA, f.cashier]) {
      const err = await link(f, { personId: who.personId, orgId: f.orgId }, f.storeA, f.termA1, uuid()).then(() => null, (e: unknown) => e);
      expect(err, 'refused').toBeInstanceOf(AuthorizationError);
    }
    expect((await sql<{ n: number }[]>`select count(*)::int as n from pos_terminal_links where org_id = ${f.orgId}`)[0]!.n).toBe(0);
  });

  it('A11-reprovision: a new device id on the same tablet is refused until the writer re-links it; the old link is revoked; one active link per store (M6)', async () => {
    const f = await org('a11re');
    const oldDev = uuid();
    const newDev = uuid();
    const first = await link(f, adminActor(f), f.storeA, f.termA1, oldDev);
    expect((await resolveLink(f, f.posStoreA, oldDev)).erpStoreId).toBe(f.storeA);
    expect(await msg(resolveLink(f, f.posStoreA, newDev)), 'reinstalled tablet, not registered yet').toBe(TERMINAL_NOT_REGISTERED);

    const second = await link(f, adminActor(f), f.storeA, f.termA1, newDev);
    expect(second.linkId).not.toBe(first.linkId);
    expect((await resolveLink(f, f.posStoreA, newDev)).linkId).toBe(second.linkId);
    expect(await msg(resolveLink(f, f.posStoreA, oldDev)), 'the old device id is revoked').toBe(TERMINAL_NOT_REGISTERED);

    const all = await sql<{ id: string; revoked_at: Date | null }[]>`select id, revoked_at from pos_terminal_links where store_id = ${f.storeA}`;
    expect(all).toHaveLength(2);
    expect(all.find((r) => r.id === first.linkId)!.revoked_at).not.toBeNull();
    expect(all.filter((r) => r.revoked_at === null)).toHaveLength(1);
  });
});

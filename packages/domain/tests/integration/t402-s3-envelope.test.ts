import { config } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';

/**
 * T-402 S3 - recordClientEvents, the R10 offline envelope (docs/tasks/402-activity-log.md R10, Invariants 20, 21, 22,
 * 22a, 22b, and the "S3 contract" C1-C3). TESTER, not BUILDER.
 *
 * Contract under test: `recordClientEvents(tx, { terminal, uploader, source: 'pos', events, verifiedActorByEventKey })`
 * from packages/domain/src/activity/client-events.ts -> one result per event, in input order:
 * `{ eventKey, status: 'accepted' | 'replayed', id } | { eventKey, status: 'refused', code }`. `terminal` is
 * resolveTerminalIdentity's result, `uploader` is resolveActor's. Throws (whole batch) only for an uploader of another
 * org or another store than the terminal's, and a source other than 'pos'. Failure events go through the S2 outbox:
 * every assertion about them calls `flushSecurityEvents()` first.
 *
 * No catalogue entry is both live and client-sendable yet, so `pos.receipt_voided` is presented as live by mocking
 * `catalogueEntry` (the S1b way); `pos.receipt_edited` stays reserved.
 *
 * ## State at HEAD
 * packages/domain/src/activity/client-events.ts does not exist: every case is red with "Failed to load url
 * ../../src/activity/client-events" until the builder writes it.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

vi.mock('../../../db/src/audit/catalogue', async (orig) => {
  const m = await orig<typeof import('../../../db/src/audit/catalogue')>();
  return {
    ...m,
    catalogueEntry: (a: string) => {
      const e = m.catalogueEntry(a);
      return a === 'pos.receipt_voided' && e ? { ...e, reserved: false } : e;
    },
  };
});

import { closeDb } from '@shareat/db';
import { flushSecurityEvents } from '@shareat/auth';
import { asOrgOn } from './_fixtures/pos-s6';
import { auditRows, uid, type AuditRow } from './_fixtures/t402-s3-money';

const sql = postgres(url, { max: 5 });
afterAll(async () => {
  await sql.end({ timeout: 5 });
  await closeDb();
});
class Rollback extends Error {}

type Env = {
  eventKey: string;
  action: string;
  entityId: string;
  storeId: string | null;
  occurredAt: string;
  before: unknown;
  after: unknown;
  actorClaim: string | null;
};
type Result = { eventKey: string; status: 'accepted' | 'replayed' | 'refused'; id?: string; code?: string };

async function fixture(hint: string) {
  const code = uid(`t402s3env-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const store = async (n: string) =>
    (await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(n)}, ${n}) returning id`)[0]!.id;
  const storeId = await store('A');
  const otherStoreId = await store('B');
  const person = async (name: string) =>
    (await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`)[0]!.id;
  const uploaderId = await person('Uploader');
  const cashierId = await person('Cashier');
  const deviceId = await person('Terminal');
  const [foreignOrg] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Foreign ${code}`}, ${`f-${code}`}) returning id`;
  const [foreignStore] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${foreignOrg!.id}, ${uid('F')}, 'F') returning id`;
  return {
    orgId, storeId, otherStoreId, uploaderId, cashierId, deviceId, foreignStoreId: foreignStore!.id,
    terminal: { orgId, storeId, deviceId },
    uploader: {
      actor: { personId: uploaderId, orgId }, sessionId: randomUUID(), credentialKind: 'pin' as const,
      storeId, expiresAt: new Date(Date.now() + 3_600_000),
    },
  };
}
type Fx = Awaited<ReturnType<typeof fixture>>;

const env = (f: Fx, over: Partial<Env> = {}): Env => ({
  eventKey: randomUUID(),
  action: 'pos.receipt_voided',
  entityId: randomUUID(),
  storeId: f.storeId,
  occurredAt: new Date(Date.now() - 60_000).toISOString(),
  before: { status: 'paid' },
  after: { status: 'voided', note: 'ok' },
  actorClaim: null,
  ...over,
});

type RecordFn = (tx: unknown, input: Record<string, unknown>) => Promise<Result[]>;
async function load(): Promise<RecordFn> {
  const m = (await import('../../src/activity/client-events')) as unknown as { recordClientEvents: RecordFn };
  return m.recordClientEvents;
}
async function send(
  f: Fx,
  events: Env[],
  o: { verified?: Map<string, string>; source?: string; terminal?: unknown; uploader?: unknown } = {},
): Promise<Result[]> {
  const record = await load();
  return asOrgOn(f.orgId, (tx) =>
    record(tx, {
      terminal: o.terminal ?? f.terminal, uploader: o.uploader ?? f.uploader, source: o.source ?? 'pos',
      events, verifiedActorByEventKey: o.verified ?? new Map(),
    }),
  );
}
const keyRows = (orgId: string, key: string) =>
  sql<{ audit_log_id: string; payload_sha256: string }[]>`select audit_log_id, payload_sha256 from audit_log_event_keys where org_id = ${orgId} and event_key = ${key}`;
const rowsFor = (orgId: string, entityId: string) => sql<AuditRow[]>`select * from audit_log where org_id = ${orgId} and entity_id = ${entityId}`;

describe('accepted events: the server supplies every attested value (R10a, d; Invariant 21)', () => {
  it('one event is accepted in input order; the row has the catalogue labels, the TERMINAL\'s store and device, source pos, the uploader as uploader and (no verified actor yet) as actor', async () => {
    const f = await fixture('ok');
    const e = env(f);
    const res = await send(f, [e]);
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({ eventKey: e.eventKey, status: 'accepted' });
    const [row] = await rowsFor(f.orgId, e.entityId);
    expect(row!.id).toBe(res[0]!.id);
    expect(row!.action).toBe('pos.receipt_voided');
    expect([row!.category, row!.sensitivity, row!.retention_class, row!.entity]).toEqual(['order', 'high', 'r10y', 'pos_orders']);
    expect(row!.store_id).toBe(f.storeId);
    expect(row!.device_id).toBe(f.deviceId);
    expect(row!.source).toBe('pos');
    expect(row!.uploaded_by_person_id).toBe(f.uploaderId);
    expect(row!.actor_person_id, 'no verified offline session on file: the uploader is the actor of record').toBe(f.uploaderId);
    expect(row!.clock_suspect).toBe(false);
    expect((await keyRows(f.orgId, e.eventKey)).length).toBe(1);
  });

  it('the verified actor (from the sale\'s offline session) is the actor; the uploader is kept apart; a matching actorClaim sets no flag', async () => {
    const f = await fixture('verified');
    const e = env(f, { actorClaim: f.cashierId });
    await send(f, [e], { verified: new Map([[e.eventKey, f.cashierId]]) });
    const [row] = await rowsFor(f.orgId, e.entityId);
    expect(row!.actor_person_id).toBe(f.cashierId);
    expect(row!.uploaded_by_person_id).toBe(f.uploaderId);
    expect(JSON.stringify(row!.after)).not.toContain('__actorClaimMismatch');
  });

  it('a DIFFERENT actorClaim stores the verified actor, never the claimed one, and sets after.__actorClaimMismatch (mutant: claimed actor trusted)', async () => {
    const f = await fixture('claim');
    const e = env(f, { actorClaim: f.uploaderId });
    await send(f, [e], { verified: new Map([[e.eventKey, f.cashierId]]) });
    const [row] = await rowsFor(f.orgId, e.entityId);
    expect(row!.actor_person_id).toBe(f.cashierId);
    expect(row!.actor_person_id).not.toBe(f.uploaderId);
    expect(row!.after).toMatchObject({ status: 'voided', note: 'ok', __actorClaimMismatch: true });
  });

  it('a mismatch on a non-object `after` is stored as { value, __actorClaimMismatch: true }, not lost', async () => {
    const f = await fixture('claim-scalar');
    const e = env(f, { after: 7, actorClaim: f.uploaderId });
    await send(f, [e], { verified: new Map([[e.eventKey, f.cashierId]]) });
    const [row] = await rowsFor(f.orgId, e.entityId);
    expect(row!.after).toEqual({ value: 7, __actorClaimMismatch: true });
  });

  it('extra fields the device sends (actorPersonId, orgId, source, category, sensitivity, retention, deviceId, uploadedByPersonId) are IGNORED: the server\'s values are stored (type and runtime)', async () => {
    const f = await fixture('attest');
    const e = { ...env(f), actorPersonId: f.cashierId, orgId: randomUUID(), source: 'web', category: 'security', sensitivity: 'low', severity: 6, retentionClass: 'r2y', deviceId: randomUUID(), uploadedByPersonId: f.cashierId };
    const res = await send(f, [e as unknown as Env]);
    expect(res[0]!.status).toBe('accepted');
    const [row] = await rowsFor(f.orgId, e.entityId);
    expect(row!.actor_person_id).toBe(f.uploaderId);
    expect(row!.uploaded_by_person_id).toBe(f.uploaderId);
    expect(row!.source).toBe('pos');
    expect([row!.category, row!.sensitivity, row!.retention_class]).toEqual(['order', 'high', 'r10y']);
    expect(row!.device_id).toBe(f.deviceId);
    expect(await sql`select 1 from audit_log where entity_id = ${e.entityId} and org_id <> ${f.orgId}`).toHaveLength(0);
  });

  it('secrets inside a client payload are redacted before storage (R5), and the event is still accepted', async () => {
    const f = await fixture('redact');
    const e = env(f, { after: { status: 'voided', pin: '1234', nested: { passwordHash: 'scrypt$abc' } } });
    await send(f, [e]);
    const [row] = await rowsFor(f.orgId, e.entityId);
    expect(JSON.stringify(row!.after)).not.toMatch(/1234|scrypt\$/);
    expect(row!.redacted_keys.length).toBeGreaterThanOrEqual(2);
  });
});

describe('idempotency: replay, conflict, canonical hash (R10; Invariants 20, 22b)', () => {
  it('the same eventKey and payload twice (two calls) gives ONE row and ONE key; the second says replayed with the first id', async () => {
    const f = await fixture('replay');
    const e = env(f);
    const [a] = await send(f, [e]);
    const [b] = await send(f, [e]);
    expect(a!.status).toBe('accepted');
    expect(b).toMatchObject({ status: 'replayed', id: a!.id });
    expect(await rowsFor(f.orgId, e.entityId)).toHaveLength(1);
    expect(await keyRows(f.orgId, e.eventKey)).toHaveLength(1);
  });

  it('the same event with its keys in a DIFFERENT ORDER is a replay, not a conflict (canonical JSON; mutant: hash over raw JSON)', async () => {
    const f = await fixture('canon');
    const e = env(f, { before: { a: 1, b: 2 }, after: { x: 'y', z: { p: 1, q: 2 } } });
    const reordered = { ...e, before: { b: 2, a: 1 }, after: { z: { q: 2, p: 1 }, x: 'y' } };
    const [a] = await send(f, [e]);
    const [b] = await send(f, [reordered]);
    expect(b).toMatchObject({ status: 'replayed', id: a!.id });
    await flushSecurityEvents();
    expect(await auditRows(sql, f.orgId, 'security.event_replay_conflict')).toHaveLength(0);
  });

  it('the same key with ANOTHER payload is refused AUDIT_EVENT_KEY_CONFLICT, inserts nothing, and writes security.event_replay_conflict (high, org-scoped, entity = the key, by the uploader)', async () => {
    const f = await fixture('conflict');
    const e = env(f);
    const [a] = await send(f, [e]);
    const [b] = await send(f, [{ ...e, after: { status: 'voided', note: 'TAMPERED' } }]);
    expect(b).toMatchObject({ status: 'refused', code: 'AUDIT_EVENT_KEY_CONFLICT' });
    expect(await rowsFor(f.orgId, e.entityId), 'the first row only').toHaveLength(1);
    expect((await keyRows(f.orgId, e.eventKey))[0]!.audit_log_id).toBe(a!.id);
    await flushSecurityEvents();
    const conflicts = await auditRows(sql, f.orgId, 'security.event_replay_conflict');
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.sensitivity).toBe('high');
    expect(conflicts[0]!.store_id).toBeNull();
    expect(conflicts[0]!.entity_id).toBe(e.eventKey);
    expect(conflicts[0]!.actor_person_id).toBe(f.uploaderId);
    expect(JSON.stringify(conflicts[0]!.after), 'the tampered payload is not copied into the security row').not.toContain('TAMPERED');
  });

  it('two DIFFERENT keys with the same payload are two events (mutant: dedupe on payload only)', async () => {
    const f = await fixture('twokeys');
    const entityId = randomUUID();
    const r = await send(f, [env(f, { entityId }), env(f, { entityId })]);
    expect(r.map((x) => x.status)).toEqual(['accepted', 'accepted']);
    expect(await rowsFor(f.orgId, entityId)).toHaveLength(2);
  });

  it('a duplicate inside ONE batch is accepted once and replayed once', async () => {
    const f = await fixture('dupbatch');
    const e = env(f);
    const r = await send(f, [e, e]);
    expect(r.map((x) => x.status)).toEqual(['accepted', 'replayed']);
    expect(r[1]!.id).toBe(r[0]!.id);
    expect(await rowsFor(f.orgId, e.entityId)).toHaveLength(1);
  });

  it('a replay whose only difference is the actorClaim is still a replay (the claim is not part of the hash)', async () => {
    const f = await fixture('claimreplay');
    const e = env(f);
    const [a] = await send(f, [e]);
    const [b] = await send(f, [{ ...e, actorClaim: f.cashierId }]);
    expect(b).toMatchObject({ status: 'replayed', id: a!.id });
  });
});

describe('store check (R10b), allowlist (R10c), bad input', () => {
  it('a storeId other than the terminal\'s is refused AUDIT_STORE_MISMATCH, writes no log row and no key, and security.event_store_mismatch is written at the TERMINAL\'s store (high) by the uploader', async () => {
    const f = await fixture('mismatch');
    const e = env(f, { storeId: f.otherStoreId });
    const [res] = await send(f, [e]);
    expect(res).toMatchObject({ eventKey: e.eventKey, status: 'refused', code: 'AUDIT_STORE_MISMATCH' });
    expect(await rowsFor(f.orgId, e.entityId)).toHaveLength(0);
    expect(await keyRows(f.orgId, e.eventKey)).toHaveLength(0);
    await flushSecurityEvents();
    const rows = await auditRows(sql, f.orgId, 'security.event_store_mismatch');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sensitivity).toBe('high');
    expect(rows[0]!.store_id, 'the terminal\'s store, never the claimed one').toBe(f.storeId);
    expect(rows[0]!.actor_person_id).toBe(f.uploaderId);
    expect(rows[0]!.device_id).toBe(f.deviceId);
    expect(JSON.stringify(rows[0]!.after)).toContain(f.otherStoreId); // a store of this org: kept as claimedStoreId
  });

  it('a null storeId is also a mismatch; a store of ANOTHER org or a non-uuid string is recorded as "unknown" and the raw value appears nowhere (A3)', async () => {
    const f = await fixture('mismatch2');
    const sentinel = 'rm -rf SENTINEL_9f3';
    const r = await send(f, [env(f, { storeId: null }), env(f, { storeId: f.foreignStoreId }), env(f, { storeId: sentinel })]);
    expect(r.map((x) => (x as { code?: string }).code)).toEqual(['AUDIT_STORE_MISMATCH', 'AUDIT_STORE_MISMATCH', 'AUDIT_STORE_MISMATCH']);
    await flushSecurityEvents();
    const rows = await auditRows(sql, f.orgId, 'security.event_store_mismatch');
    expect(rows.length).toBeGreaterThanOrEqual(3);
    const text = JSON.stringify(rows.map((x) => [x.before, x.after, x.entity_id]));
    expect(text).not.toContain(sentinel);
    expect(text).not.toContain(f.foreignStoreId);
    expect(text).toContain('unknown');
  });

  it('an action the POS may not send is refused AUDIT_SOURCE_NOT_ALLOWED and writes nothing: role.assigned, cutover.purge, data.export_downloaded, capability.granted', async () => {
    const f = await fixture('allow');
    const evs = ['role.assigned', 'cutover.purge', 'data.export_downloaded', 'capability.granted'].map((action) => env(f, { action, storeId: null }));
    const r = await send(f, evs);
    for (const x of r) expect(x.status).toBe('refused');
    // role.assigned and capability.granted are live and server-only: the allowlist is what refuses them
    expect(r[0]).toMatchObject({ code: 'AUDIT_SOURCE_NOT_ALLOWED' });
    expect(r[3]).toMatchObject({ code: 'AUDIT_SOURCE_NOT_ALLOWED' });
    for (const e of evs) {
      expect(await rowsFor(f.orgId, e.entityId), `${e.action} wrote nothing`).toHaveLength(0);
      expect(await keyRows(f.orgId, e.eventKey)).toHaveLength(0);
    }
  });

  it('cutover.purge from the POS is refused by the allowlist once S3 makes it live (never AUDIT_ACTION_RESERVED)', async () => {
    const f = await fixture('allow2');
    const [r] = await send(f, [env(f, { action: 'cutover.purge', storeId: null })]);
    expect(r).toMatchObject({ status: 'refused', code: 'AUDIT_SOURCE_NOT_ALLOWED' });
  });

  it('an unknown action is refused UNKNOWN_AUDIT_ACTION and a still-reserved POS action AUDIT_ACTION_RESERVED; neither writes', async () => {
    const f = await fixture('unknown');
    const a = env(f, { action: 'made.up_action' });
    const b = env(f, { action: 'pos.receipt_edited' });
    const r = await send(f, [a, b]);
    expect(r[0]).toMatchObject({ status: 'refused', code: 'UNKNOWN_AUDIT_ACTION' });
    expect(r[1]).toMatchObject({ status: 'refused', code: 'AUDIT_ACTION_RESERVED' });
    expect(await rowsFor(f.orgId, a.entityId)).toHaveLength(0);
    expect(await rowsFor(f.orgId, b.entityId)).toHaveLength(0);
  });

  it('a malformed eventKey or entityId is refused AUDIT_BAD_ENVELOPE (not a database error), the transaction stays usable and the rest of the batch is recorded in order', async () => {
    const f = await fixture('bad');
    const bad1 = env(f, { eventKey: 'not-a-uuid' });
    const bad2 = env(f, { entityId: 'also-not-a-uuid' });
    const good = env(f);
    const r = await send(f, [bad1, good, bad2]);
    expect(r.map((x) => x.status)).toEqual(['refused', 'accepted', 'refused']);
    expect([r[0], r[2]].map((x) => (x as { code?: string }).code)).toEqual(['AUDIT_BAD_ENVELOPE', 'AUDIT_BAD_ENVELOPE']);
    expect(r[1]!.eventKey).toBe(good.eventKey);
    expect(await rowsFor(f.orgId, good.entityId)).toHaveLength(1);
  });
});

describe('the whole batch is refused (throws) only for a wrong uploader or source (C1)', () => {
  it('source other than pos (the customer app is ADR-015 P3), an uploader of another org, and an uploader bound to another store all throw and write nothing', async () => {
    const f = await fixture('throws');
    await load(); // the module must exist: a missing module would make every rejects.toThrow below pass vacuously
    const e = env(f);
    await expect(send(f, [e], { source: 'customer' })).rejects.toThrow();
    await expect(send(f, [e], { source: 'web' })).rejects.toThrow();
    const otherOrgUploader = { ...f.uploader, actor: { personId: f.uploaderId, orgId: randomUUID() } };
    await expect(send(f, [e], { uploader: otherOrgUploader })).rejects.toThrow();
    await expect(send(f, [e], { uploader: { ...f.uploader, storeId: f.otherStoreId } })).rejects.toThrow();
    expect(await rowsFor(f.orgId, e.entityId)).toHaveLength(0);
  });
});

describe('clock suspect (R10; Invariant 22): accepted, flagged, never refused', () => {
  it('40 days old and 10 minutes in the future are stored with clock_suspect = true and their own occurred_at; 1 minute old is not suspect', async () => {
    const f = await fixture('clock');
    const old = env(f, { occurredAt: new Date(Date.now() - 40 * 86_400_000).toISOString() });
    const future = env(f, { occurredAt: new Date(Date.now() + 10 * 60_000).toISOString() });
    const fresh = env(f);
    const r = await send(f, [old, future, fresh]);
    expect(r.map((x) => x.status)).toEqual(['accepted', 'accepted', 'accepted']);
    const [o] = await rowsFor(f.orgId, old.entityId);
    const [fu] = await rowsFor(f.orgId, future.entityId);
    const [fr] = await rowsFor(f.orgId, fresh.entityId);
    expect(o!.clock_suspect).toBe(true);
    expect(fu!.clock_suspect).toBe(true);
    expect(fr!.clock_suspect).toBe(false);
    expect(new Date(o!.occurred_at).toISOString()).toBe(old.occurredAt);
    expect(o!.recorded_at.getTime(), 'recorded_at is the server clock').toBeGreaterThan(Date.now() - 60_000);
  });
});

describe('the events ride the sale\'s transaction (C1, R9)', () => {
  it('a rolled-back caller leaves no log row and no event key, but the store-mismatch security event survives (outbox, own transaction)', async () => {
    const f = await fixture('rollback');
    const record = await load();
    const ok = env(f);
    const bad = env(f, { storeId: f.otherStoreId });
    try {
      await asOrgOn(f.orgId, async (tx) => {
        await record(tx, { terminal: f.terminal, uploader: f.uploader, source: 'pos', events: [ok, bad], verifiedActorByEventKey: new Map() });
        throw new Rollback();
      });
    } catch (e) {
      if (!(e instanceof Rollback)) throw e;
    }
    expect(await rowsFor(f.orgId, ok.entityId), 'the accepted event rolled back with the sale').toHaveLength(0);
    expect(await keyRows(f.orgId, ok.eventKey)).toHaveLength(0);
    await flushSecurityEvents();
    expect(await auditRows(sql, f.orgId, 'security.event_store_mismatch'), 'the refusal is recorded even though the sale rolled back').toHaveLength(1);
  });

  it('events of org A never appear under org B (RLS), and the same eventKey in two orgs is two independent events', async () => {
    const a = await fixture('orgA');
    const b = await fixture('orgB');
    const key = randomUUID();
    const ea = env(a, { eventKey: key });
    const eb = env(b, { eventKey: key });
    const [ra] = await send(a, [ea]);
    const [rb] = await send(b, [eb]);
    expect(ra!.status).toBe('accepted');
    expect(rb!.status).toBe('accepted');
    expect(await rowsFor(a.orgId, eb.entityId)).toHaveLength(0);
  });
});

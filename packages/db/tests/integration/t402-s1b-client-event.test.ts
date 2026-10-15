import { config } from 'dotenv';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-402 S1b audit - appendClientEvent (R10 storage half). TESTER, not BUILDER.
 *  1. RACE: two concurrent uploads of one event key (two connections) leave exactly ONE audit_log row and ONE key row;
 *     the loser returns the winner's id and leaves no row of its own.
 *  3. A RESERVED entry is refused (AUDIT_ACTION_RESERVED) even when its clientSources allows the source.
 *  5. payload_sha256 is over the REDACTED canonical envelope: a stored hash cannot be matched against a raw-PIN payload,
 *     and the same redacted payload hashes the same (so a replay whose only difference is a secret is a replay).
 *
 * No catalogue entry is both live and client-sendable at S1b (all POS entries are reserved), so legs 1 and 5 mock
 * `catalogueEntry` to present ONE entry (pos.receipt_voided) as live. Leg 3 uses a different, unmocked entry
 * (pos.receipt_edited), which stays reserved.
 *
 * Red today: appendClientEvent does not check `reserved` (leg 3 writes a row); the loser of the race has already inserted
 * its own audit row in its own transaction, which commits (leg 1: 2 rows); the hash is over the raw envelope (leg 5).
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

vi.mock('../../src/audit/catalogue', async (orig) => {
  const m = await orig<typeof import('../../src/audit/catalogue')>();
  return {
    ...m,
    catalogueEntry: (a: string) => {
      const e = m.catalogueEntry(a);
      return a === 'pos.receipt_voided' && e ? { ...e, reserved: false } : e;
    },
  };
});

import { APP_ROLE, closeDb, transaction, type Tx } from '../../src';
import * as repo from '../../src/repo/audit-log';
import { canonicalJson } from '../../src/audit/canonical-json';
import { redactPayload } from '../../src/audit/redact';

const sql = postgres(url, { max: 6 });
afterAll(async () => {
  await sql.end({ timeout: 5 });
  await closeDb();
});
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

async function fixture(hint: string) {
  const code = uid(`t402ce-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, 'S') returning id`;
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Cashier') returning id`;
  const [d] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Terminal') returning id`;
  return { orgId, storeId: store!.id, actor: p!.id, device: d!.id };
}
type Fx = Awaited<ReturnType<typeof fixture>>;

type Envelope = { eventKey: string; action: string; entityId: string; storeId: string | null; occurredAt: string; before: unknown; after: unknown };
const send = (f: Fx, env: Envelope, action = env.action) =>
  asOrg(f.orgId, (tx) =>
    (repo as unknown as { appendClientEvent: (tx: Tx, o: string, e: Envelope, a: Record<string, unknown>) => Promise<{ id: string; replayed: boolean }> }).appendClientEvent(
      tx,
      f.orgId,
      { ...env, action },
      { actorPersonId: f.actor, deviceId: f.device, source: 'pos' },
    ),
  );
const envelope = (f: Fx, over: Partial<Envelope> = {}): Envelope => ({
  eventKey: randomUUID(),
  action: 'pos.receipt_voided',
  entityId: randomUUID(),
  storeId: f.storeId,
  occurredAt: new Date(Date.now() - 60_000).toISOString(),
  before: null,
  after: { n: 1 },
  ...over,
});
const logRows = (entityId: string) => sql<{ id: string }[]>`select id from audit_log where entity_id = ${entityId}`;
const keyRows = (orgId: string, key: string) =>
  sql<{ audit_log_id: string; payload_sha256: string }[]>`select audit_log_id, payload_sha256 from audit_log_event_keys where org_id = ${orgId} and event_key = ${key}`;

describe('1 - concurrent uploads of the same event key (two connections)', () => {
  it('10 races: exactly one audit_log row and one key row each; both callers get the same id; one replayed=true; the loser leaves no row', async () => {
    const f = await fixture('race');
    for (let i = 0; i < 10; i++) {
      const env = envelope(f);
      const [a, b] = await Promise.all([send(f, env), send(f, env)]);
      expect(a.id, `race ${i}: both callers get the winner's id`).toBe(b.id);
      expect([a.replayed, b.replayed].sort(), `race ${i}: one first, one replay`).toEqual([false, true]);
      const rows = await logRows(env.entityId);
      expect(rows, `race ${i}: the loser's own audit row must not survive`).toHaveLength(1);
      expect(rows[0]!.id).toBe(a.id);
      const keys = await keyRows(f.orgId, env.eventKey);
      expect(keys).toHaveLength(1);
      expect(keys[0]!.audit_log_id).toBe(a.id);
    }
  });
});

describe('3 - a reserved entry is refused on the client path even though clientSources allows pos', () => {
  it('pos.receipt_edited from source pos: AUDIT_ACTION_RESERVED, no audit row, no key row', async () => {
    const f = await fixture('reserved');
    const env = envelope(f, { action: 'pos.receipt_edited' });
    let err: Error | undefined;
    try {
      await send(f, env);
    } catch (e) {
      err = e as Error;
    }
    expect(err?.message ?? 'did not throw').toMatch(/AUDIT_ACTION_RESERVED/);
    expect(await logRows(env.entityId)).toHaveLength(0);
    expect(await keyRows(f.orgId, env.eventKey)).toHaveLength(0);
  });
});

describe('5 - payload_sha256 is over the redacted canonical envelope', () => {
  const expectedHash = (env: Envelope) =>
    createHash('sha256')
      .update(
        canonicalJson({
          action: env.action,
          entityId: env.entityId,
          storeId: env.storeId,
          occurredAt: env.occurredAt,
          before: redactPayload(env.before).value,
          after: redactPayload(env.after).value,
        }),
      )
      .digest('hex');
  const rawHash = (env: Envelope) =>
    createHash('sha256')
      .update(canonicalJson({ action: env.action, entityId: env.entityId, storeId: env.storeId, occurredAt: env.occurredAt, before: env.before, after: env.after }))
      .digest('hex');

  it('the stored hash equals sha256(canonicalJson(redacted envelope)) and does NOT equal the raw-payload hash', async () => {
    const f = await fixture('hash');
    const env = envelope(f, { after: { pin: '123456', note: 'x' }, before: { sessionId: 'abc' } });
    await send(f, env);
    const [k] = await keyRows(f.orgId, env.eventKey);
    expect(k!.payload_sha256).toBe(expectedHash(env));
    expect(k!.payload_sha256, 'a stored hash must not let anyone test guesses of the raw PIN').not.toBe(rawHash(env));
  });

  it('two events that differ only in a redacted secret hash identically; a replay of the same key with another secret is a replay, not a conflict', async () => {
    const f = await fixture('hash2');
    const base = envelope(f, { after: { pin: '111111', note: 'x' } });
    // the hash covers entityId, so the pair that must hash alike shares ONE entityId (and differs only in the secret);
    // base keeps its own entityId so its replay can be counted on its own.
    const twinA = { ...base, eventKey: randomUUID(), entityId: randomUUID(), after: { pin: '111111', note: 'x' } };
    const twinB = { ...twinA, eventKey: randomUUID(), after: { pin: '999999', note: 'x' } };
    await send(f, base);
    await send(f, twinA);
    await send(f, twinB);
    const [ka] = await keyRows(f.orgId, twinA.eventKey);
    const [kb] = await keyRows(f.orgId, twinB.eventKey);
    expect(ka!.payload_sha256).toBe(kb!.payload_sha256);
    const again = await send(f, { ...base, after: { pin: '555555', note: 'x' } });
    expect(again.replayed).toBe(true);
    expect(await logRows(base.entityId)).toHaveLength(1);
  });
});

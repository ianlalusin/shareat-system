import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-505 - the ERP "POS tablets" screen's data layer (docs/tasks/505-erp-pos-tablet-links.md, tests P1-P7).
 * The three WRITES already exist (provisionPosTerminalLink, revokePosTerminalLink, resetApprovalPinCap); this file proves the two new READS
 * (`posTerminalLinksRepo.listForStore`, `accessRepo.terminalPersonsForStore`) and that the writes behave the way the screen relies on.
 * Runs on any `_test` database (TEST_DATABASE_URL); every case builds its own organisation, so no database name is pinned.
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');

import { APP_ROLE, accessRepo, closeDb, pinAttemptsRepo, posTerminalLinksRepo, transaction, type Tx } from '@shareat/db';
import { AuthorizationError, flushSecurityEvents, resetApprovalPinCap } from '@shareat/auth';
import { provisionPosTerminalLink, revokePosTerminalLink } from '@shareat/domain';

const sql = postgres(url, { max: 4 });
afterAll(async () => { await closeDb(); await sql.end({ timeout: 5 }); });

const uid = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

async function fixture() {
  const code = uid('t505');
  const [o] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = o!.id;
  const store = async (name: string) => {
    const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('S')}, ${name}) returning id`;
    const [ch] = await sql<{ id: string }[]>`insert into sales_channels (org_id, store_id, name, is_remitted_daily) values (${orgId}, ${s!.id}, 'Walk-in', true) returning id`;
    return { id: s!.id, channel: ch!.id };
  };
  const a = await store('Store A');
  const b = await store('Store B');
  const person = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    for (const s of [a, b]) await sql`insert into person_store_scope (person_id, store_id, source) values (${p!.id}, ${s.id}, 'manual')`;
    return p!.id;
  };
  const admin = await person('Admin', 'admin');
  const admin2 = await person('Admin Two', 'admin');
  const manager = await person('Manager', 'manager');
  for (const s of [a, b]) {
    await sql`insert into pos_v1_store_links (org_id, store_id, pos_store_id, pos_store_name, sales_channel_id, pos_tax_type, created_by)
              values (${orgId}, ${s.id}, ${uid('pos')}, 'POS', ${s.channel}, 'vat_inclusive', ${admin})`;
  }
  const terminal = async (storeId: string, name: string, live = true) => {
    const [t] = await sql<{ id: string }[]>`insert into persons (org_id, display_name, kind) values (${orgId}, ${name}, 'terminal') returning id`;
    await sql`insert into person_credentials (person_id, kind, store_id, external_id, revoked_at, revoke_reason)
              values (${t!.id}, 'firebase', ${storeId}, ${uid('fb')}, ${live ? null : new Date()}, ${live ? null : 'retired tablet'})`;
    return t!.id;
  };
  const tA = await terminal(a.id, 'Terminal A');
  const tB = await terminal(b.id, 'Terminal B');
  await terminal(a.id, 'Terminal A dead', false);
  return { orgId, a: a.id, b: b.id, admin, admin2, manager, tA, tB };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const actor = (orgId: string, personId: string) => ({ orgId, personId });
const link = (f: Fixture, who: string, storeId: string, deviceId: string, terminalPersonId: string, terminalNo = 1) =>
  asOrg(f.orgId, (tx) => provisionPosTerminalLink(tx, actor(f.orgId, who), { storeId, terminalNo, deviceId, terminalPersonId }));

describe('T-505 register / replace / revoke (P1-P5)', () => {
  it('P1: an admin registers a device: one active link, one audit row, nothing revoked', async () => {
    const f = await fixture();
    const dev = crypto.randomUUID();
    const r = await link(f, f.admin, f.a, dev.toUpperCase(), f.tA);
    expect(r.revokedLinkId).toBeNull();
    const rows = await sql<{ id: string; device_id: string }[]>`select id, device_id from pos_terminal_links where org_id = ${f.orgId} and revoked_at is null`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.device_id).toBe(dev);
    await flushSecurityEvents();
    expect(await sql`select 1 from audit_log where org_id = ${f.orgId} and entity_id = ${r.linkId} and action = 'pos_terminal_link.provision'`).toHaveLength(1);
  });

  it('P2: a second device at the same store replaces the first in the same transaction (one active link per store)', async () => {
    const f = await fixture();
    const first = await link(f, f.admin, f.a, crypto.randomUUID(), f.tA);
    const second = await link(f, f.admin, f.a, crypto.randomUUID(), f.tA, 2);
    expect(second.revokedLinkId).toBe(first.linkId);
    const active = await sql<{ id: string }[]>`select id from pos_terminal_links where org_id = ${f.orgId} and store_id = ${f.a} and revoked_at is null`;
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe(second.linkId);
    const old = await sql<{ revoked_by: string | null }[]>`select revoked_by from pos_terminal_links where id = ${first.linkId}`;
    expect(old[0]!.revoked_by).toBe(f.admin);
  });

  it('P3: a manager is refused both the register and the revoke, and nothing is written', async () => {
    const f = await fixture();
    const ok = await link(f, f.admin, f.a, crypto.randomUUID(), f.tA);
    const reg = await link(f, f.manager, f.a, crypto.randomUUID(), f.tA).then(() => null, (e: unknown) => e);
    const rev = await asOrg(f.orgId, (tx) => revokePosTerminalLink(tx, actor(f.orgId, f.manager), { linkId: ok.linkId })).then(() => null, (e: unknown) => e);
    expect(reg).toBeInstanceOf(AuthorizationError);
    expect(rev).toBeInstanceOf(AuthorizationError);
    expect(await sql`select 1 from pos_terminal_links where org_id = ${f.orgId}`).toHaveLength(1);
    expect(await sql`select 1 from pos_terminal_links where id = ${ok.linkId} and revoked_at is null`).toHaveLength(1);
  });

  it('P4: a non-uuid device id is refused; a device active at another store is refused; nothing is written either time', async () => {
    const f = await fixture();
    const bad = await link(f, f.admin, f.a, 'not-a-uuid', f.tA).then(() => 'OK', (e: { userMessage?: string; message: string }) => e.userMessage ?? e.message);
    expect(bad).toMatch(/device id is not valid/i);
    const dev = crypto.randomUUID();
    await link(f, f.admin, f.b, dev, f.tB);
    const taken = await link(f, f.admin, f.a, dev, f.tA).then(() => 'OK', (e: { userMessage?: string; message: string }) => e.userMessage ?? e.message);
    expect(taken).toMatch(/already registered to a store/i);
    expect(await sql`select 1 from pos_terminal_links where org_id = ${f.orgId} and store_id = ${f.a}`).toHaveLength(0);
  });

  it('P5: revoke sets revoked_at and revoked_by and writes one audit row; revoking twice is refused', async () => {
    const f = await fixture();
    const { linkId } = await link(f, f.admin, f.a, crypto.randomUUID(), f.tA);
    await asOrg(f.orgId, (tx) => revokePosTerminalLink(tx, actor(f.orgId, f.admin), { linkId }));
    const [row] = await sql<{ revoked_at: Date | null; revoked_by: string | null }[]>`select revoked_at, revoked_by from pos_terminal_links where id = ${linkId}`;
    expect(row!.revoked_at).not.toBeNull();
    expect(row!.revoked_by).toBe(f.admin);
    const again = await asOrg(f.orgId, (tx) => revokePosTerminalLink(tx, actor(f.orgId, f.admin), { linkId })).then(() => 'OK', (e: Error) => e.message);
    expect(again).toMatch(/already revoked/i);
    await flushSecurityEvents();
    expect(await sql`select 1 from audit_log where org_id = ${f.orgId} and entity_id = ${linkId} and action = 'pos_terminal_link.revoke'`).toHaveLength(1);
  });
});

describe('T-505 approval lock (P6)', () => {
  it('P6: clearing a capped terminal lifts it and writes one audit row; clearing a not-capped one writes nothing', async () => {
    const f = await fixture();
    await sql`insert into pin_attempt_throttle (org_id, actor_person_id, fail_count, stopped_at) values (${f.orgId}, ${f.tA}, 5, now())`;
    expect((await asOrg(f.orgId, (tx) => pinAttemptsRepo.statusForActor(tx, f.orgId, f.tA))).capped).toBe(true);
    const done = await asOrg(f.orgId, (tx) => resetApprovalPinCap(tx, actor(f.orgId, f.admin), f.tA));
    expect(done).toEqual({ cleared: true });
    expect((await asOrg(f.orgId, (tx) => pinAttemptsRepo.statusForActor(tx, f.orgId, f.tA))).capped).toBe(false);
    const again = await asOrg(f.orgId, (tx) => resetApprovalPinCap(tx, actor(f.orgId, f.admin2), f.tA));
    expect(again).toEqual({ cleared: false });
    await flushSecurityEvents();
    expect(await sql`select 1 from audit_log where org_id = ${f.orgId} and entity_id = ${f.tA} and action = 'auth.approval_pin_cap_reset'`).toHaveLength(1);
  });
});

describe('T-505 the two new reads (P7)', () => {
  it('P7a: listForStore returns the active link with names, and only the last N revoked links, newest first', async () => {
    const f = await fixture();
    const devs: string[] = [];
    for (let i = 0; i < 4; i++) {
      devs.push(crypto.randomUUID());
      await link(f, f.admin, f.a, devs[i]!, f.tA, i + 1);
    }
    await link(f, f.admin, f.b, crypto.randomUUID(), f.tB);
    const out = await asOrg(f.orgId, (tx) => posTerminalLinksRepo.listForStore(tx, f.orgId, f.a, { revokedLimit: 2 }));
    expect(out.active?.deviceId).toBe(devs[3]);
    expect(out.active?.terminalNo).toBe(4);
    expect(out.active?.terminalPersonName).toBe('Terminal A');
    expect(out.active?.createdByName).toBe('Admin');
    expect(out.revoked.map((r) => r.deviceId)).toEqual([devs[2], devs[1]]);
    expect(out.revoked[0]!.revokedByName).toBe('Admin');
    const other = await asOrg(f.orgId, (tx) => posTerminalLinksRepo.listForStore(tx, f.orgId, f.b, { revokedLimit: 10 }));
    expect(other.revoked).toHaveLength(0);
    expect(other.active?.terminalPersonName).toBe('Terminal B');
  });

  it("P7b: terminalPersonsForStore lists only this store's terminals with a live credential", async () => {
    const f = await fixture();
    expect(await asOrg(f.orgId, (tx) => accessRepo.terminalPersonsForStore(tx, f.orgId, f.a))).toEqual([{ personId: f.tA, displayName: 'Terminal A' }]);
    expect((await asOrg(f.orgId, (tx) => accessRepo.terminalPersonsForStore(tx, f.orgId, f.b))).map((p) => p.personId)).toEqual([f.tB]);
  });

  it('P7c: another organisation sees nothing (RLS)', async () => {
    const f = await fixture();
    const other = await fixture();
    await link(f, f.admin, f.a, crypto.randomUUID(), f.tA);
    const seen = await asOrg(other.orgId, (tx) => posTerminalLinksRepo.listForStore(tx, other.orgId, f.a, { revokedLimit: 10 }));
    expect(seen.active).toBeNull();
    expect(seen.revoked).toHaveLength(0);
    expect(await asOrg(other.orgId, (tx) => accessRepo.terminalPersonsForStore(tx, other.orgId, f.a))).toEqual([]);
  });
});

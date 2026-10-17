import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/** T-424 audit - revokePosTerminalLink: admin only (provision_clock_terminal), audited, the tablet is "not registered" afterwards, a second revoke is refused. Lane DB shareat_test_t424 only. */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');

import { APP_ROLE, closeDb, transaction, type Tx } from '@shareat/db';
import { AuthorizationError, flushSecurityEvents, hashPin, resolvePosTerminalLink } from '@shareat/auth';
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
  const code = uid('t424rev');
  const [o] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = o!.id;
  const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('S')}, 'S') returning id`;
  const storeId = s!.id;
  const person = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id, source) values (${p!.id}, ${storeId}, 'manual')`;
    return p!.id;
  };
  const admin = await person('Admin', 'admin');
  const manager = await person('Manager', 'manager');
  const [t] = await sql<{ id: string }[]>`insert into persons (org_id, display_name, kind) values (${orgId}, 'Tablet', 'terminal') returning id`;
  await sql`insert into person_credentials (person_id, kind, store_id, external_id) values (${t!.id}, 'firebase', ${storeId}, ${uid('fb')})`;
  void hashPin;
  const posStoreId = uid('pos');
  const [ch] = await sql<{ id: string }[]>`insert into sales_channels (org_id, store_id, name, is_remitted_daily) values (${orgId}, ${storeId}, 'Walk-in', true) returning id`;
  await sql`insert into pos_v1_store_links (org_id, store_id, pos_store_id, pos_store_name, sales_channel_id, pos_tax_type, created_by)
            values (${orgId}, ${storeId}, ${posStoreId}, 'POS', ${ch!.id}, 'vat_inclusive', ${admin})`;
  return { orgId, storeId, admin, manager, terminal: t!.id, posStoreId };
}

describe('revokePosTerminalLink', () => {
  it('a manager is refused; an admin revokes; the tablet is then not registered; a second revoke is refused; one audit row', async () => {
    const f = await fixture();
    const dev = crypto.randomUUID();
    const { linkId } = await asOrg(f.orgId, (tx) => provisionPosTerminalLink(tx, { personId: f.admin, orgId: f.orgId }, { storeId: f.storeId, terminalNo: 1, deviceId: dev, terminalPersonId: f.terminal }));

    const refused = await asOrg(f.orgId, (tx) => revokePosTerminalLink(tx, { personId: f.manager, orgId: f.orgId }, { linkId })).then(() => null, (e: unknown) => e);
    expect(refused).toBeInstanceOf(AuthorizationError);
    expect((await asOrg(f.orgId, (tx) => resolvePosTerminalLink(tx, { orgId: f.orgId, posStoreId: f.posStoreId, deviceId: dev }))).linkId).toBe(linkId);

    await asOrg(f.orgId, (tx) => revokePosTerminalLink(tx, { personId: f.admin, orgId: f.orgId }, { linkId }));
    const after = await asOrg(f.orgId, (tx) => resolvePosTerminalLink(tx, { orgId: f.orgId, posStoreId: f.posStoreId, deviceId: dev })).then(() => 'OK', (e: Error) => e.message);
    expect(after).toMatch(/not registered/);

    const again = await asOrg(f.orgId, (tx) => revokePosTerminalLink(tx, { personId: f.admin, orgId: f.orgId }, { linkId })).then(() => 'OK', (e: Error) => e.message);
    expect(again).not.toBe('OK');

    await flushSecurityEvents();
    const audit = await sql<{ action: string }[]>`select action from audit_log where org_id = ${f.orgId} and entity_id = ${linkId} and action = 'pos_terminal_link.revoke'`;
    expect(audit).toHaveLength(1);
  });
});

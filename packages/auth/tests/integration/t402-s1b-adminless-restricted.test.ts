import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-402 S1b audit, Ian's ruling: in an org with NO admin the manager serves as admin, so `view_activity_log_restricted`
 * IS lent to them (elevateManager, bible row 116). A manager in an org that HAS an admin does not get it.
 * Control: the elevated manager also holds manage_users, proving elevation ran; the plain manager does not.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { APP_ROLE, closeDb, transaction, type Tx } from '@shareat/db';
import { authorize, AuthorizationError, elevateManager, type Capability } from '@shareat/auth';

const sql = postgres(url, { max: 3 });
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

async function org(hint: string, withAdmin: boolean) {
  const code = uid(`t402${hint}`);
  const [o] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = o!.id;
  const [st] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('s')}, 'S') returning id`;
  const mk = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id, source) values (${p!.id}, ${st!.id}, 'manual')`;
    return { personId: p!.id, orgId };
  };
  const manager = await mk('Manager', 'manager');
  if (withAdmin) await mk('Admin', 'admin');
  return { orgId, storeId: st!.id, manager };
}

async function tryIt(orgId: string, who: { personId: string; orgId: string }, cap: string, storeId?: string) {
  try {
    await asOrg(orgId, (tx) => authorize(tx, who, cap as Capability, storeId ? { storeId } : {}));
    return null;
  } catch (e) {
    return e;
  }
}

describe('view_activity_log_restricted and the admin-less org', () => {
  it('a manager in an admin-less org, once elevated, CAN read restricted rows (and holds manage_users, the control)', async () => {
    const f = await org('noadmin', false);
    await asOrg(f.orgId, (tx) => elevateManager(tx, { personId: f.manager.personId, grantedBy: null }));
    expect(await tryIt(f.orgId, f.manager, 'manage_users'), 'control: elevation ran').toBeNull();
    expect(await tryIt(f.orgId, f.manager, 'view_activity_log_restricted'), 'lent to the stand-in admin').toBeNull();
    expect(await tryIt(f.orgId, f.manager, 'view_activity_log', f.storeId)).toBeNull();
  });

  it('a manager in an org that HAS an admin cannot (AuthorizationError), though they read their own store', async () => {
    const f = await org('hasadmin', true);
    expect(await tryIt(f.orgId, f.manager, 'view_activity_log_restricted')).toBeInstanceOf(AuthorizationError);
    expect(await tryIt(f.orgId, f.manager, 'manage_users'), 'control').toBeInstanceOf(AuthorizationError);
    expect(await tryIt(f.orgId, f.manager, 'view_activity_log', f.storeId)).toBeNull();
  });
});

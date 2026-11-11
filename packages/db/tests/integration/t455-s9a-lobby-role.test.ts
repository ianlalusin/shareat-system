/**
 * T-455 S9a item 1 -- the lobby DB role (the S3 hard gate), migration 0225. docs/tasks/455-customer-lobby.md "S9 rulings" item 1, "S3 rulings".
 * TESTER file. Real Postgres via TEST_DATABASE_URL (`_test` name guard). Nothing here names a lane database.
 *
 * The diner routes used to run as `shareat_app`, which can read and write every table of the org. They now run as `shareat_lobby`:
 * NOLOGIN (no password), granted only the lobby_* tables, the store name/code and the menu variant/option ids. RLS applies to it as to `shareat_app`
 * (the 0215 policies have no TO clause, so they cover every role).
 *
 * RED TODAY, for one reason: 0225 and `withLobbyPrincipal` do not exist.
 *
 * MUTANT INDEX (each test title ends with "[kills: ...]"):
 *  role created LOGIN / with a password / superuser / BYPASSRLS / a member of shareat_app; grants on ALL TABLES; a grant on sales/persons/journal;
 *  DELETE or TRUNCATE granted; UPDATE on stores; withLobbyPrincipal still switching to shareat_app (or to no role); role/org not transaction-scoped;
 *  the role bypassing org isolation; migration without lock_timeout first or without a journal entry on the grid.
 */
import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { config } from 'dotenv';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}
process.env.DATABASE_URL = url;

import { closeDb, transaction, withLobbyPrincipal, withOrgPrincipal } from '../../src';
import { MIGRATIONS_FOLDER } from './t398-s3-fixture';

const sql = postgres(url, { max: 4 });
const LOBBY_ROLE = 'shareat_lobby';
type Err = Error & { code?: string };

let seq = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${++seq}`;
const codeOf = () => String(1000 + Math.floor(Math.random() * 9000));

const refusal = async (fn: () => PromiseLike<unknown>): Promise<Err | undefined> => {
  try {
    await fn();
    return undefined;
  } catch (e) {
    return e as Err;
  }
};
/** Runs the statement in its own savepoint (drizzle nested transaction) so a refused statement does not poison the outer one; resolves with the Postgres error or undefined. */
async function probe(tx: Parameters<Parameters<typeof withLobbyPrincipal>[1]>[0], q: ReturnType<typeof dsql>): Promise<Err | undefined> {
  try {
    await tx.transaction(async (sp) => {
      await sp.execute(q);
    });
    return undefined;
  } catch (e) {
    const err = e as Err & { cause?: Err };
    return err.code ? err : (err.cause ?? err);
  }
}

type Fx = { orgId: string; otherOrgId: string; storeId: string; storeCode: string; otherStoreId: string; variantId: string; valueId: string; personId: string };
let fx: Fx;

beforeAll(async () => {
  const mk = async (tag: string) => {
    const c = uid(tag);
    const [o] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${c}`}, ${c}) returning id`;
    return o!.id;
  };
  const orgId = await mk('s9a');
  const otherOrgId = await mk('s9b');
  const sc = uid('ST');
  const [st] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${sc}, 'Lipa') returning id`;
  const [st2] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${otherOrgId}, ${uid('ST')}, 'Elsewhere') returning id`;
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${uid('Person')}) returning id`;
  await sql`insert into lobby_stores (org_id, store_id, enabled) values (${orgId}, ${st!.id}, true)`;
  await sql`insert into lobby_stores (org_id, store_id, enabled) values (${otherOrgId}, ${st2!.id}, true)`;
  const [cat] = await sql<{ id: string }[]>`insert into menu_categories (org_id, name, sort_order, status, created_by) values (${orgId}, ${uid('Cat')}, 0, 'active', ${p!.id}) returning id`;
  const [item] = await sql<{ id: string }[]>`
    insert into menu_items (org_id, category_id, name, item_type, sold_a_la_carte, sold_in_package_session, diner_orderable, sort_order, status, created_by)
    values (${orgId}, ${cat!.id}, ${uid('Pork')}, 'a_la_carte', true, false, true, 0, 'active', ${p!.id}) returning id`;
  const [variant] = await sql<{ id: string }[]>`
    insert into menu_item_variants (org_id, menu_item_id, label, is_default, sort_order, status, created_by) values (${orgId}, ${item!.id}, null, true, 0, 'active', ${p!.id}) returning id`;
  const [grp] = await sql<{ id: string }[]>`
    insert into menu_option_groups (org_id, name, selection_mode, min_selections, max_selections, status, created_by) values (${orgId}, ${uid('Grp')}, 'single', 1, 1, 'active', ${p!.id}) returning id`;
  const [val] = await sql<{ id: string }[]>`
    insert into menu_option_values (org_id, option_group_id, name, sort_order, status, created_by) values (${orgId}, ${grp!.id}, ${uid('Val')}, 0, 'active', ${p!.id}) returning id`;
  fx = { orgId, otherOrgId, storeId: st!.id, storeCode: sc, otherStoreId: st2!.id, variantId: variant!.id, valueId: val!.id, personId: p!.id };
});
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('S9a-1 the role itself', () => {
  it('R1 shareat_lobby exists, cannot log in, is not a superuser, does not bypass RLS, and is a member of nothing [kills: LOGIN role / a password / superuser / BYPASSRLS / member of shareat_app]', async () => {
    const [r] = await sql<{ rolcanlogin: boolean; rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean; rolcreatedb: boolean; rolreplication: boolean; pw: string | null }[]>`
      select r.rolcanlogin, r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb, r.rolreplication, a.rolpassword as pw
        from pg_roles r left join pg_authid a on a.oid = r.oid where r.rolname = ${LOBBY_ROLE}`.catch(async () => {
      // pg_authid is superuser-only on some hosts: fall back to the public view (no password column)
      return sql<{ rolcanlogin: boolean; rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean; rolcreatedb: boolean; rolreplication: boolean; pw: string | null }[]>`
        select rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication, null::text as pw from pg_roles where rolname = ${LOBBY_ROLE}`;
    });
    expect(r, 'role shareat_lobby exists').toBeDefined();
    expect(r).toMatchObject({ rolcanlogin: false, rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false });
    expect(r!.pw).toBeNull();
    const memberOf = await sql<{ role: string }[]>`
      select g.rolname as role from pg_auth_members m join pg_roles g on g.oid = m.roleid join pg_roles u on u.oid = m.member where u.rolname = ${LOBBY_ROLE}`;
    expect(memberOf).toEqual([]);
  });

  it('R2 the grant list is pinned: exactly these table and column privileges, nothing on any other table, no DELETE / TRUNCATE / REFERENCES / TRIGGER anywhere [kills: GRANT ... ON ALL TABLES; a grant on sales or persons; DELETE granted; UPDATE on stores]', async () => {
    const privs = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
    const tables = await sql<{ t: string; p: string }[]>`
      select c.relname as t, p.priv as p
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        cross join unnest(${privs}::text[]) as p(priv)
       where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm')
         and has_table_privilege(${LOBBY_ROLE}, c.oid, p.priv)
       order by 1, 2`;
    const got: Record<string, string[]> = {};
    for (const r of tables) (got[r.t] ??= []).push(r.p);
    expect(got).toEqual({
      lobby_birthday_requests: ['INSERT', 'SELECT', 'UPDATE'],
      lobby_discount_claims: ['INSERT', 'SELECT', 'UPDATE'],
      lobby_entries: ['INSERT', 'SELECT', 'UPDATE'],
      lobby_entry_line_options: ['INSERT', 'SELECT'],
      lobby_entry_lines: ['INSERT', 'SELECT'],
      lobby_stores: ['SELECT'],
      menu_item_variants: ['SELECT'],
      menu_option_values: ['SELECT'],
      stores: ['SELECT'],
    });
    // column-only privileges (a table that is not above must not appear here either; lobby_stores may have UPDATE(updated_at) for FOR UPDATE)
    const cols = await sql<{ t: string; c: string; p: string }[]>`
      select c.relname as t, a.attname as c, p.priv as p
        from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
        cross join unnest(array['SELECT','INSERT','UPDATE','REFERENCES']) as p(priv)
       where n.nspname = 'public' and c.relkind in ('r', 'p') and a.attnum > 0 and not a.attisdropped
         and has_column_privilege(${LOBBY_ROLE}, c.oid, a.attnum, p.priv)
         and not has_table_privilege(${LOBBY_ROLE}, c.oid, p.priv)
       order by 1, 2, 3`;
    expect(cols).toEqual([{ t: 'lobby_stores', c: 'updated_at', p: 'UPDATE' }]);
    const schemaUsage = await sql<{ ok: boolean }[]>`select has_schema_privilege(${LOBBY_ROLE}, 'public', 'USAGE') as ok`;
    expect(schemaUsage[0]!.ok).toBe(true);
    const create = await sql<{ ok: boolean }[]>`select has_schema_privilege(${LOBBY_ROLE}, 'public', 'CREATE') as ok`;
    expect(create[0]!.ok).toBe(false);
  });

  it('R3 no function, sequence or default privilege widens the role later: shareat_lobby owns nothing and has no default ACL entry [kills: ALTER DEFAULT PRIVILEGES ... TO shareat_lobby; an object owned by the role]', async () => {
    const owned = await sql<{ n: string }[]>`
      select c.relname as n from pg_class c join pg_roles r on r.oid = c.relowner where r.rolname = ${LOBBY_ROLE}`;
    expect(owned).toEqual([]);
    const dflt = await sql<{ n: number }[]>`
      select count(*)::int as n from pg_default_acl d where d.defaclacl::text like ${'%' + LOBBY_ROLE + '=%'}`;
    expect(dflt[0]!.n).toBe(0);
  });
});

describe('S9a-1 withLobbyPrincipal', () => {
  it('P1 runs as shareat_lobby with the org set, and both revert at commit [kills: still switching to shareat_app; no role switch; a session-scoped SET]', async () => {
    const seen = await withLobbyPrincipal(fx.orgId, async (tx) => {
      const rows = (await tx.execute(dsql`select current_user as u, app_current_org()::text as org, current_setting('app.principal_kind', true) as kind`)) as unknown as Array<{ u: string; org: string; kind: string }>;
      return rows[0]!;
    });
    expect(seen.u).toBe(LOBBY_ROLE);
    expect(seen.org).toBe(fx.orgId);
    // the very next transaction on the pool sees neither the role nor the org
    const after = await transaction(async (tx) => {
      const rows = (await tx.execute(dsql`select current_user as u, app_current_org()::text as org`)) as unknown as Array<{ u: string; org: string | null }>;
      return rows[0]!;
    });
    expect(after.u).not.toBe(LOBBY_ROLE);
    expect(after.org).toBeNull();
  });

  it('P2 a diner transaction cannot read sales, persons, journal entries or the audit log, and cannot write them: permission denied (42501) [kills: running as shareat_app or the owner; a grant on a money or people table]', async () => {
    await withLobbyPrincipal(fx.orgId, async (tx) => {
      for (const t of ['sales_days', 'persons', 'journal_entries', 'audit_log', 'organizations', 'accounts', 'person_roles']) {
        const e = await probe(tx, dsql.raw(`select 1 from ${t} limit 1`));
        expect(e?.code, `select from ${t}`).toBe('42501');
      }
      const w = await probe(tx, dsql`insert into persons (org_id, display_name) values (${fx.orgId}, 'x')`);
      expect(w?.code).toBe('42501');
    });
  });

  it('P3 it reads the store (name, code) and cannot change it; it cannot delete or truncate a lobby table [kills: UPDATE on stores; DELETE / TRUNCATE granted]', async () => {
    await withLobbyPrincipal(fx.orgId, async (tx) => {
      const rows = (await tx.execute(dsql`select name from stores where id = ${fx.storeId}`)) as unknown as Array<{ name: string }>;
      expect(rows.map((r) => r.name)).toEqual(['Lipa']);
      expect((await probe(tx, dsql`update stores set name = 'Hacked' where id = ${fx.storeId}`))?.code).toBe('42501');
      expect((await probe(tx, dsql`delete from lobby_entries`))?.code).toBe('42501');
      expect((await probe(tx, dsql`truncate lobby_entries`))?.code).toBe('42501');
      expect((await probe(tx, dsql`update lobby_stores set enabled = false where store_id = ${fx.storeId}`))?.code).toBe('42501');
    });
  });

  it('P4 org isolation still applies to the role: another org\'s lobby rows are invisible and an insert carrying another org\'s id is refused [kills: BYPASSRLS; a policy limited TO shareat_app]', async () => {
    await withLobbyPrincipal(fx.orgId, async (tx) => {
      const seen = (await tx.execute(dsql`select count(*)::int as n from lobby_stores`)) as unknown as Array<{ n: number }>;
      expect(seen[0]!.n).toBe(1); // only this org's row, though the table holds two orgs' rows
      const e = await probe(
        tx,
        dsql`insert into lobby_entries (org_id, store_id, source, display_name, party_size, code, device_hash, ip_hash, client_request_id)
             values (${fx.otherOrgId}, ${fx.otherStoreId}, 'lobby', 'Intruder', 2, ${codeOf()}, 'd', 'i', ${uid('c')})`,
      );
      expect(e?.code).toBe('42501'); // WITH CHECK
    });
  });

  it('P5 the lobby role is narrower than the staff role: the same statements as withOrgPrincipal succeed for lobby tables, and the staff role still reads sales [kills: breaking the staff paths]', async () => {
    const staffReads = await withOrgPrincipal(fx.orgId, async (tx) => {
      const r = (await tx.execute(dsql`select count(*)::int as n from persons`)) as unknown as Array<{ n: number }>;
      return r[0]!.n;
    });
    expect(staffReads).toBeGreaterThanOrEqual(1);
    await withLobbyPrincipal(fx.orgId, async (tx) => {
      const r = (await tx.execute(dsql`select count(*)::int as n from lobby_entries`)) as unknown as Array<{ n: number }>;
      expect(r[0]!.n).toBeGreaterThanOrEqual(0);
    });
  });

  it('P6 an entry can be created, read, cancelled and its line written under the role, FOR UPDATE on lobby_stores works, and the menu ids are readable [kills: a missing grant the diner routes need]', async () => {
    const created = await withLobbyPrincipal(fx.orgId, async (tx) => {
      const lock = (await tx.execute(dsql`select store_id from lobby_stores where org_id = ${fx.orgId} and store_id = ${fx.storeId} for update`)) as unknown as unknown[];
      expect(lock.length).toBe(1);
      const ins = (await tx.execute(
        dsql`insert into lobby_entries (org_id, store_id, source, display_name, party_size, code, device_hash, ip_hash, client_request_id)
             values (${fx.orgId}, ${fx.storeId}, 'lobby', 'Pat', 2, ${codeOf()}, ${uid('dev')}, 'ip', ${crypto.randomUUID()}) returning id`,
      )) as unknown as Array<{ id: string }>;
      const id = ins[0]!.id;
      await tx.execute(dsql`update lobby_entries set status = 'cancelled', closed_at = now() where id = ${id}`);
      // the pre-order lines: INSERT on both line tables is proven here, not assumed (the check-in writes them)
      const variants = (await tx.execute(dsql`select id from menu_item_variants where org_id = ${fx.orgId} limit 1`)) as unknown as Array<{ id: string }>;
      expect(variants.length, 'fixture variant visible to the role').toBe(1);
      const line = (await tx.execute(
        dsql`insert into lobby_entry_lines (org_id, entry_id, variant_id, qty, line_kind) values (${fx.orgId}, ${id}, ${variants[0]!.id}, 2, 'package') returning id`,
      )) as unknown as Array<{ id: string }>;
      const values = (await tx.execute(dsql`select id from menu_option_values where org_id = ${fx.orgId} limit 1`)) as unknown as Array<{ id: string }>;
      expect(values.length, 'fixture option value visible to the role').toBe(1);
      await tx.execute(dsql`insert into lobby_entry_line_options (org_id, line_id, option_value_id) values (${fx.orgId}, ${line[0]!.id}, ${values[0]!.id})`);
      const back = (await tx.execute(dsql`select count(*)::int as n from lobby_entry_line_options where line_id = ${line[0]!.id}`)) as unknown as Array<{ n: number }>;
      expect(back[0]!.n).toBe(1);
      await tx.execute(dsql`select count(*) from menu_item_variants where org_id = ${fx.orgId}`);
      await tx.execute(dsql`select count(*) from menu_option_values where org_id = ${fx.orgId}`);
      return id;
    });
    expect(created).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('S9a-1 a production-shaped login can become the lobby role', () => {
  // docs/ops/README.md: production's login (`shareat_app_prod`) is a member of `shareat_app` ONLY. SET ROLE needs membership of the target role, so
  // 0225 must GRANT shareat_lobby TO shareat_app, or every diner route answers "permission denied to set role". Nothing here names a database or a login
  // that exists outside this test: the login is created, used and dropped here.
  const login = `s9a_probe_${randomBytes(4).toString('hex')}`;
  const password = randomBytes(16).toString('hex');
  let loginUrl = '';

  beforeAll(async () => {
    await sql.unsafe(`create role "${login}" login password '${password}' nosuperuser nocreaterole nocreatedb nobypassrls`);
    await sql.unsafe(`grant "shareat_app" to "${login}"`);
    const u = new URL(url);
    u.username = login;
    u.password = password;
    loginUrl = u.toString();
  });
  afterAll(async () => {
    await sql.unsafe(`drop role if exists "${login}"`);
  });

  it('R4 a LOGIN that is a member of shareat_app only (not a superuser) runs withLobbyPrincipal and reads a lobby row; shareat_lobby is still a member of nothing [kills: no GRANT shareat_lobby TO shareat_app (production 500s on every diner route)]', async () => {
    const [who] = await sql<{ rolsuper: boolean; rolbypassrls: boolean }[]>`select rolsuper, rolbypassrls from pg_roles where rolname = ${login}`;
    expect(who).toMatchObject({ rolsuper: false, rolbypassrls: false });
    const memberOf = await sql<{ role: string }[]>`
      select g.rolname as role from pg_auth_members m join pg_roles g on g.oid = m.roleid join pg_roles u on u.oid = m.member where u.rolname = ${login} order by 1`;
    expect(memberOf.map((r) => r.role)).toEqual(['shareat_app']);

    // A fresh copy of the db package bound to the probe login (env() caches the URL per module instance); the shared pool is closed first so it is rebuilt.
    await closeDb();
    const prev = process.env.DATABASE_URL;
    process.env.DATABASE_URL = loginUrl;
    vi.resetModules();
    try {
      const fresh = await import('../../src');
      const seen = await fresh.withLobbyPrincipal(fx.orgId, async (tx) => {
        const who2 = (await tx.execute(dsql`select session_user as s, current_user as u`)) as unknown as Array<{ s: string; u: string }>;
        const rows = (await tx.execute(dsql`select count(*)::int as n from lobby_stores`)) as unknown as Array<{ n: number }>;
        return { session: who2[0]!.s, role: who2[0]!.u, lobbyRows: rows[0]!.n };
      });
      expect(seen).toEqual({ session: login, role: LOBBY_ROLE, lobbyRows: 1 });
      await fresh.closeDb();
    } finally {
      if (prev === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prev;
      vi.resetModules();
    }
    // the grant went to shareat_app, not to the lobby role: shareat_lobby is a member of nothing (R1 pins this too)
    const lobbyMemberOf = await sql<{ role: string }[]>`
      select g.rolname as role from pg_auth_members m join pg_roles g on g.oid = m.roleid join pg_roles u on u.oid = m.member where u.rolname = ${LOBBY_ROLE}`;
    expect(lobbyMemberOf).toEqual([]);
  });

  it('R5 the membership is SET-only: inherit_option=false, set_option=true [kills: plain GRANT, which makes shareat_app inherit the lobby role]', async () => {
    const rows = await sql<{ inherit_option: boolean; set_option: boolean }[]>`
      select m.inherit_option, m.set_option from pg_auth_members m join pg_roles g on g.oid = m.roleid join pg_roles u on u.oid = m.member
      where g.rolname = ${LOBBY_ROLE} and u.rolname = 'shareat_app'`;
    expect(rows).toEqual([{ inherit_option: false, set_option: true }]);
  });

  it('R6 shareat_app gains NO table privilege from the lobby role: stores.name stays unreadable, the lobby role still reads it [kills: inherited lobby SELECT defeating the column revokes]', async () => {
    const asLogin = postgres(loginUrl, { max: 1 });
    try {
      // Superuser transaction (rolled back): narrow shareat_app to column grants on stores, exactly the authorize.test.ts store-detail mechanism,
      // then probe as shareat_app. If shareat_app inherited shareat_lobby (table-level SELECT on stores) the name read would succeed.
      await sql.begin(async (t) => {
        await t.unsafe('revoke select on stores from shareat_app');
        await t.unsafe('grant select (id, org_id) on stores to shareat_app');
        await t.unsafe('set local role shareat_app');
        await expect(t.unsafe('select id, org_id from stores limit 1')).resolves.toBeDefined();
        await expect(t.unsafe('select name from stores limit 1')).rejects.toMatchObject({ code: '42501' });
        throw new Error('r6-rollback');
      }).catch((e: unknown) => {
        if (!(e instanceof Error) || e.message !== 'r6-rollback') throw e;
      });
      // R4 half: the production-shaped login can still SET ROLE shareat_lobby, and that role does hold SELECT on stores
      await asLogin.begin(async (t) => {
        await t.unsafe(`set local role ${LOBBY_ROLE}`);
        await expect(t.unsafe('select name from stores limit 1')).resolves.toBeDefined();
      });
    } finally {
      await asLogin.end();
    }
  });
});

describe('S9a-1 the migration file', () => {
  const file = '0225_t455_s9a_lobby_role.sql';
  const path = join(MIGRATIONS_FOLDER, file);

  it('M1 0225 exists, opens with SET LOCAL lock_timeout, creates the role NOLOGIN, and never names a password, LOGIN, BYPASSRLS or ALL TABLES [kills: a LOGIN role; a password in git; a blanket grant]', () => {
    expect(existsSync(path), file).toBe(true);
    const text = readFileSync(path, 'utf8');
    const code = text.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    expect(code.trimStart().startsWith('SET LOCAL lock_timeout')).toBe(true);
    expect(code).toMatch(/CREATE ROLE "?shareat_lobby"? NOLOGIN/i);
    expect(code).not.toMatch(/\bPASSWORD\b|\bBYPASSRLS\b|\bSUPERUSER\b|\bON ALL TABLES\b|\bALTER DEFAULT PRIVILEGES\b/i);
    expect(code.replace(/NOLOGIN/gi, '')).not.toMatch(/\bLOGIN\b/i);
    expect(text.includes('\r')).toBe(false);
  });

  it('M2 the journal has the entry on the one-day grid after 0224 [kills: a wall-clock or off-grid when]', () => {
    const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')) as { entries: Array<{ idx: number; when: number; tag: string }> };
    const e225 = journal.entries.find((e) => e.tag === file.replace('.sql', ''));
    const e224 = journal.entries.find((e) => e.idx === 224)!;
    expect(e225, 'journal entry for 0225').toBeDefined();
    expect(e225!.idx).toBe(225);
    expect(e225!.when).toBe(e224.when + 86_400_000);
  });
});

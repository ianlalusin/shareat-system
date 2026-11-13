/**
 * T-524 (BOSS, 6 Nov 2026) - the position defaults for the three POS floor capabilities, seeded by the B0240 block of migration 0240 through the
 * existing position access-defaults rows (bible row 211). The block runs as the migration role in a transaction that is ALWAYS rolled back, then the
 * REAL authorize() answers as the app role (the same pattern as t510-s2-pair-backfill):
 *   Server  holds request_pos_refill and confirm_pos_heads, NOT serve_pos_ticket;
 *   Kitchen Staff holds serve_pos_ticket, NOT refill or heads;
 *   Cashier holds all three;
 *   a position with no default (Dishwasher) is still refused each of the three (the x cases still fire).
 * A manager holds all three BY ROLE (matrix), so "Store manager" needs no position row.
 */
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import { sql as dsql } from 'drizzle-orm';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '@shareat/db/schema';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}

import { APP_ROLE, type Tx } from '@shareat/db';
import { authorize, AuthorizationError, can, type Actor, type Capability } from '@shareat/auth';

// The migration role's own connection (as t510-s2-pair-backfill uses): the block needs row_security off, which the app pool cannot do.
const owner_sql = postgres(url, { max: 2, onnotice: () => {} });
const ownerDb = drizzle(owner_sql, { schema });
afterAll(async () => {
  await owner_sql.end({ timeout: 5 });
});

class Rollback extends Error {}
const MIGRATION = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', 'db', 'migrations', '0240_t524_receipt_append_guard.sql');
const THREE = ['request_pos_refill', 'serve_pos_ticket', 'confirm_pos_heads'] as const satisfies readonly Capability[];

function blockStatements(): string[] {
  const text = readFileSync(MIGRATION, 'utf8');
  const begin = text.indexOf('-- B0240:begin');
  const end = text.indexOf('-- B0240:end');
  expect(begin).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(begin);
  return text
    .slice(begin, end)
    .split(/-->\s*statement-breakpoint/)
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}
const runBlock = async (tx: Tx) => {
  for (const stmt of blockStatements()) await tx.execute(dsql.raw(stmt));
};

let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
/** The setup and the checks of the block's own writes read every organisation, as a migration does (the block itself ends with row_security back on). */
const owner = (tx: Tx) => tx.execute(dsql.raw('set local row_security = off'));
const rows = async <T>(tx: Tx, q: ReturnType<typeof dsql>) => (await tx.execute(q)) as unknown as T[];

async function rolledBack(fn: (tx: Tx) => Promise<void>): Promise<void> {
  try {
    await ownerDb.transaction(async (tx) => {
      await fn(tx as unknown as Tx);
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
}

/** One org with exactly one admin (the attribution person), one store, the canonical positions, and one open employment per position. */
async function world(tx: Tx, o: { adminCount?: number } = {}) {
  await owner(tx);
  const code = uid('t524pd');
  const [org] = await rows<{ id: string }>(tx, dsql`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`);
  const orgId = org!.id;
  const person = async (name: string, role: 'admin' | 'staff') => {
    const [p] = await rows<{ id: string }>(tx, dsql`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`);
    await tx.execute(dsql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`);
    return p!.id;
  };
  const adminId = await person('Admin', 'admin');
  for (let i = 1; i < (o.adminCount ?? 1); i++) await person(`Admin ${i + 1}`, 'admin');
  const [store] = await rows<{ id: string }>(tx, dsql`insert into stores (org_id, code, name) values (${orgId}, ${uid('ST')}, 'Lipa') returning id`);
  const storeId = store!.id;
  const staff: Record<string, { personId: string; actor: Actor }> = {};
  const positionIds: Record<string, string> = {};
  for (const name of ['Server', 'Kitchen Staff', 'Cashier', 'Dishwasher']) {
    const [pos] = await rows<{ id: string }>(tx, dsql`insert into positions (org_id, store_id, name, is_canonical, is_active) values (${orgId}, null, ${name}, true, true) returning id`);
    positionIds[name] = pos!.id;
    const personId = await person(`${name} person`, 'staff');
    await tx.execute(dsql`insert into person_store_scope (person_id, store_id) values (${personId}, ${storeId})`);
    const [emp] = await rows<{ id: string }>(tx, dsql`
      insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
      values (${orgId}, ${storeId}, ${personId}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e6)}${Math.floor(Math.random() * 1e6)}`}, 'regular', '2025-01-01') returning id`);
    await tx.execute(dsql`insert into employment_positions (employment_id, position_id, is_primary) values (${emp!.id}, ${pos!.id}, true)`);
    staff[name] = { personId, actor: { personId, orgId } };
  }
  return { orgId, adminId, storeId, staff, positionIds };
}

/** After the block: switch to the app role (as production requests run) and ask the real authorize(). */
async function asApp<T>(tx: Tx, orgId: string, fn: () => Promise<T>): Promise<T> {
  await tx.execute(dsql.raw('set local row_security = on'));
  await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
  await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
  await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
  return fn();
}

const holds = async (tx: Tx, who: Actor, storeId: string) => {
  const out: Record<string, boolean> = {};
  for (const c of THREE) out[c] = await can(tx, who, c, { storeId });
  return out;
};

describe('B0240 - the position defaults for request_pos_refill, serve_pos_ticket, confirm_pos_heads', () => {
  it('Server: refill and heads, not serve; Kitchen Staff: serve only; Cashier: all three; Dishwasher: none - by the real authorize()', async () => {
    await rolledBack(async (tx) => {
      const w = await world(tx);
      await runBlock(tx);
      await asApp(tx, w.orgId, async () => {
        expect(await holds(tx, w.staff['Server']!.actor, w.storeId)).toEqual({ request_pos_refill: true, serve_pos_ticket: false, confirm_pos_heads: true });
        expect(await holds(tx, w.staff['Kitchen Staff']!.actor, w.storeId)).toEqual({ request_pos_refill: false, serve_pos_ticket: true, confirm_pos_heads: false });
        expect(await holds(tx, w.staff['Cashier']!.actor, w.storeId)).toEqual({ request_pos_refill: true, serve_pos_ticket: true, confirm_pos_heads: true });
        expect(await holds(tx, w.staff['Dishwasher']!.actor, w.storeId)).toEqual({ request_pos_refill: false, serve_pos_ticket: false, confirm_pos_heads: false });
      });
    });
  });

  it('the x cases still fire: a Server is refused serve_pos_ticket, a Kitchen holder refill and heads, a Dishwasher all three (AuthorizationError), and a Server of ANOTHER store is refused at this one', async () => {
    await rolledBack(async (tx) => {
      const w = await world(tx);
      const other = await world(tx);
      await runBlock(tx);
      await asApp(tx, w.orgId, async () => {
        const refused = async (who: Actor, cap: Capability, storeId = w.storeId) => {
          const err = await authorize(tx, who, cap, { storeId }).then(() => null, (e: unknown) => e);
          expect(err, `${cap} should be refused`).toBeInstanceOf(AuthorizationError);
        };
        await refused(w.staff['Server']!.actor, 'serve_pos_ticket');
        await refused(w.staff['Kitchen Staff']!.actor, 'request_pos_refill');
        await refused(w.staff['Kitchen Staff']!.actor, 'confirm_pos_heads');
        for (const c of THREE) await refused(w.staff['Dishwasher']!.actor, c);
        // a grant is pinned to its own store: the other store's Server (same org shape, different store and person) holds nothing here
        await refused(other.staff['Server']!.actor, 'confirm_pos_heads');
        await authorize(tx, w.staff['Server']!.actor, 'confirm_pos_heads', { storeId: w.storeId }); // and the grant itself passes
      });
    });
  });

  it('writes one default row per (canonical position x store) and capability, pinned grants for the open holders, and a second run adds nothing', async () => {
    await rolledBack(async (tx) => {
      const w = await world(tx);
      await runBlock(tx);
      const defaults = () =>
        rows<{ name: string; capability: string }>(tx, dsql`
          select p.name, d.capability from position_capability_defaults d join positions p on p.id = d.position_id
           where d.org_id = ${w.orgId} and d.store_id = ${w.storeId} and d.revoked_at is null order by p.name, d.capability`);
      await owner(tx);
      const first = await defaults();
      expect(first.map((r) => `${r.name}:${r.capability}`)).toEqual([
        'Cashier:confirm_pos_heads', 'Cashier:request_pos_refill', 'Cashier:serve_pos_ticket',
        'Kitchen Staff:serve_pos_ticket',
        'Server:confirm_pos_heads', 'Server:request_pos_refill',
      ]);
      const grants = () =>
        rows<{ n: number }>(tx, dsql`
          select count(*)::int n from person_grants g where g.revoked_at is null and g.grant_source = 'position' and g.store_id = ${w.storeId}
             and g.grant_name in ('request_pos_refill', 'serve_pos_ticket', 'confirm_pos_heads')`);
      expect((await grants())[0]!.n).toBe(6);
      await runBlock(tx);
      await owner(tx);
      expect(await defaults()).toEqual(first);
      expect((await grants())[0]!.n).toBe(6);
    });
  });

  it('an organisation whose attribution person is ambiguous (two admins, no super_admin) gets no rows, and the block does not refuse', async () => {
    await rolledBack(async (tx) => {
      const w = await world(tx, { adminCount: 2 });
      await runBlock(tx);
      await owner(tx);
      const [n] = await rows<{ n: number }>(tx, dsql`select count(*)::int n from position_capability_defaults where org_id = ${w.orgId}`);
      expect(n!.n).toBe(0);
    });
  });
});

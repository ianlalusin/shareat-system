import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * T-455 S9a item 4 -- the nightly lobby job over every org: docs/tasks/455-customer-lobby.md "S9 rulings" item 4 and "S2 audit notes" ("runLobbyNightly has
 * no org loop yet; S9 adds the scheduler entry and the systemTransaction org list (DEF-742)"). Real Postgres via TEST_DATABASE_URL (`_test` name guard).
 *
 * CONTRACT (the builder may change a name only together with this file):
 *   runLobbyNightlyJob(opts?: { orgIds?: readonly string[]; run?: (tx, orgId) => Promise<unknown> })
 *     -> { outcomes: Array<{ orgId: string; ok: boolean; entriesExpired?: number; claimsExpired?: number; entriesPurged?: number; birthdayNamesPurged?: number; error?: string }>; hadFailures: boolean }
 *   exported from packages/domain/src/scheduler/lobby-nightly.ts (and the domain index): the lobby modules may not open a transaction (t455-s2-tx-signature), so the job lives with the scheduler glue. `orgIds` narrows the list (tests share one database with other orgs).
 *   The org list = every org with a lobby_stores row, in ascending org id, read under systemTransaction; each org's work runs under withSystemOrgPrincipal
 *   (role shareat_app, RLS on), inside its own transaction; `run` defaults to runLobbyNightly. One org failing never stops the others.
 *
 * RED TODAY, for one reason: packages/domain/src/scheduler/lobby-nightly.ts does not exist.
 *
 * MUTANT INDEX: loop stops at the first org / at the first failure; an org without a lobby_stores row visited; per-org work on the owner connection (RLS bypassed);
 * a failure leaving the other org's work half-done in the same transaction; the error text echoing a name; hadFailures false after a failure; a second run
 * re-counting.
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}
process.env.DATABASE_URL = url;

import { closeDb } from '@shareat/db';
import { runLobbyNightlyJob } from '../../src/scheduler/lobby-nightly';

const sql = postgres(url, { max: 4 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

let seq = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${++seq}`;
let codeSeq = Math.floor(Math.random() * 4000);
const nextCode = () => String(1000 + (codeSeq++ % 9000));

async function mkOrg(o: { lobbyRow?: boolean } = {}) {
  const code = uid('s9n');
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [st] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('ST')}, 'Lipa') returning id`;
  if (o.lobbyRow !== false) await sql`insert into lobby_stores (org_id, store_id, enabled) values (${orgId}, ${st!.id}, true)`;
  return { orgId, storeId: st!.id };
}
/** A cancelled entry closed 26 h ago: the nightly purge NULLs its personal columns. */
async function oldClosedEntry(f: { orgId: string; storeId: string }): Promise<string> {
  const [e] = await sql<{ id: string }[]>`
    insert into lobby_entries (org_id, store_id, source, code, display_name, party_size, status, device_hash, ip_hash, client_request_id, created_at, closed_at)
    values (${f.orgId}, ${f.storeId}, 'lobby', ${nextCode()}, 'Ana Reyes', 2, 'cancelled', ${uid('dev')}, 'iph', ${uid('crid')},
            now() - interval '30 hours', now() - interval '26 hours') returning id`;
  return e!.id;
}
const nameOf = async (id: string) => (await sql<{ display_name: string | null }[]>`select display_name from lobby_entries where id = ${id}`)[0]!.display_name;

describe('S9a-4 runLobbyNightlyJob', () => {
  it('J1 visits every org that has a lobby_stores row and purges each: both old closed entries are purged, every outcome ok [kills: loop stops after the first org; only one org\'s data purged]', async () => {
    const a = await mkOrg();
    const b = await mkOrg();
    const ea = await oldClosedEntry(a);
    const eb = await oldClosedEntry(b);
    const out = await runLobbyNightlyJob({ orgIds: [a.orgId, b.orgId] });
    expect(out.hadFailures).toBe(false);
    expect(out.outcomes.map((o) => o.orgId).sort()).toEqual([a.orgId, b.orgId].sort());
    for (const o of out.outcomes) {
      expect(o.ok).toBe(true);
      expect(o).toMatchObject({ entriesPurged: 1 });
    }
    expect(await nameOf(ea)).toBeNull();
    expect(await nameOf(eb)).toBeNull();
  });

  it('J2 an org with no lobby_stores row is not visited, and its entries (there can be none live) are untouched [kills: looping every organization]', async () => {
    const a = await mkOrg();
    const none = await mkOrg({ lobbyRow: false });
    const out = await runLobbyNightlyJob({ orgIds: [a.orgId, none.orgId] });
    expect(out.outcomes.map((o) => o.orgId)).toEqual([a.orgId]);
  });

  it('J3 one org failing does not stop the other: the failing org reports ok:false with a plain error, the other is purged, hadFailures is true, and no personal data is in the error [kills: loop aborts on the first failure; hadFailures false; error text echoing data]', async () => {
    const a = await mkOrg();
    const b = await mkOrg();
    const ea = await oldClosedEntry(a);
    const eb = await oldClosedEntry(b);
    const order = [a.orgId, b.orgId].sort(); // the job visits ascending org id: make the FIRST one fail
    const failing = order[0]!;
    const { runLobbyNightly } = await import('../../src/lobby/purge');
    const out = await runLobbyNightlyJob({
      orgIds: [a.orgId, b.orgId],
      run: async (tx, orgId) => {
        if (orgId === failing) throw new Error('boom: display_name Ana Reyes violates something');
        return runLobbyNightly(tx, orgId);
      },
    });
    expect(out.hadFailures).toBe(true);
    const bad = out.outcomes.find((o) => o.orgId === failing)!;
    const good = out.outcomes.find((o) => o.orgId !== failing)!;
    expect(bad.ok).toBe(false);
    expect(typeof bad.error).toBe('string');
    expect(bad.error).not.toMatch(/Ana|Reyes|display_name/);
    expect(good.ok).toBe(true);
    // the surviving org's entry is purged; the failing org's entry is not
    expect(await nameOf(failing === a.orgId ? eb : ea)).toBeNull();
    expect(await nameOf(failing === a.orgId ? ea : eb)).toBe('Ana Reyes');
  });

  it('J4 each org\'s work runs as shareat_app with that org set (RLS on), never on the owner connection [kills: the purge running under systemTransaction, which sees every org]', async () => {
    const a = await mkOrg();
    const seen: Array<{ orgId: string; user: string; org: string | null }> = [];
    await runLobbyNightlyJob({
      orgIds: [a.orgId],
      run: async (tx, orgId) => {
        const rows = (await tx.execute(dsql`select current_user as u, app_current_org()::text as o`)) as unknown as Array<{ u: string; o: string | null }>;
        seen.push({ orgId, user: rows[0]!.u, org: rows[0]!.o });
        return { entriesExpired: 0, claimsExpired: 0, entriesPurged: 0, birthdayNamesPurged: 0 };
      },
    });
    expect(seen).toEqual([{ orgId: a.orgId, user: 'shareat_app', org: a.orgId }]);
  });

  it('J5 a second run purges nothing, and an empty list is a clean no-op [kills: re-counting purged rows; a throw on zero orgs]', async () => {
    const a = await mkOrg();
    await oldClosedEntry(a);
    const first = await runLobbyNightlyJob({ orgIds: [a.orgId] });
    expect(first.outcomes[0]).toMatchObject({ ok: true, entriesPurged: 1 });
    const second = await runLobbyNightlyJob({ orgIds: [a.orgId] });
    expect(second.outcomes[0]).toMatchObject({ ok: true, entriesPurged: 0, entriesExpired: 0 });
    const none = await runLobbyNightlyJob({ orgIds: [] });
    expect(none).toEqual({ outcomes: [], hadFailures: false });
  });
});

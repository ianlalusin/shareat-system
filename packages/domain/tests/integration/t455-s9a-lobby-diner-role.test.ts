import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * T-455 S9a audit item 2 - every DINER branch of the domain runs on the real `shareat_lobby` role (withLobbyPrincipal), not on the owner or shareat_app.
 * The audit asked whether a diner path calls auditLogRepo.append (the lobby role has NO grant on audit_log). Finding: none does - the append calls are in the
 * staff/cashier cores only (core.ts, claims.ts openClaimCore / approve / reject, birthday.ts accept / decline / played, terminal.ts). This file proves it by
 * running check-in (with lines and options), my-entry, birthday request / read / cancel, claim submit / list / cancel and entry cancel, under the role,
 * and by asserting the org's audit_log did not move.
 * Real Postgres via TEST_DATABASE_URL (`_test` guard); nothing here names a lane database.
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}

import { closeDb, withLobbyPrincipal } from '@shareat/db';
import { sql as dsql } from 'drizzle-orm';
import { cancelMyBirthday, readMyBirthday, requestBirthday } from '../../src/lobby/birthday';
import { cancelMyEntry, checkIn, getMyEntry } from '../../src/lobby/checkin';
import { cancelMyClaim, listMyClaims, submitClaim } from '../../src/lobby/claims';

const sql = postgres(url, { max: 4 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

let seq = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${++seq}`;
let orgId = '';
let storeId = '';
let variantId = '';
let valueId = '';

beforeAll(async () => {
  const c = uid('s9ad');
  const [o] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${c}`}, ${c}) returning id`;
  orgId = o!.id;
  const [st] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('ST')}, 'Lipa') returning id`;
  storeId = st!.id;
  await sql`insert into lobby_stores (org_id, store_id, enabled, paused, max_live_entries, claims_enabled, birthday_enabled, pos_seen_at)
            values (${orgId}, ${storeId}, true, false, 60, true, true, now())`;
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${uid('Person')}) returning id`;
  const [cat] = await sql<{ id: string }[]>`insert into menu_categories (org_id, name, sort_order, status, created_by) values (${orgId}, ${uid('Cat')}, 0, 'active', ${p!.id}) returning id`;
  const [item] = await sql<{ id: string }[]>`
    insert into menu_items (org_id, category_id, name, item_type, sold_a_la_carte, sold_in_package_session, diner_orderable, sort_order, status, created_by)
    values (${orgId}, ${cat!.id}, ${uid('Pork')}, 'a_la_carte', true, false, true, 0, 'active', ${p!.id}) returning id`;
  const [v] = await sql<{ id: string }[]>`insert into menu_item_variants (org_id, menu_item_id, label, is_default, sort_order, status, created_by) values (${orgId}, ${item!.id}, null, true, 0, 'active', ${p!.id}) returning id`;
  const [g] = await sql<{ id: string }[]>`insert into menu_option_groups (org_id, name, selection_mode, min_selections, max_selections, status, created_by) values (${orgId}, ${uid('Grp')}, 'single', 1, 1, 'active', ${p!.id}) returning id`;
  const [val] = await sql<{ id: string }[]>`insert into menu_option_values (org_id, option_group_id, name, sort_order, status, created_by) values (${orgId}, ${g!.id}, ${uid('Val')}, 0, 'active', ${p!.id}) returning id`;
  variantId = v!.id;
  valueId = val!.id;
});

describe('S9a audit item 2: the diner branches need no audit_log grant', () => {
  it('D1 check-in with lines, my-entry, birthday request/read/cancel, claim submit/list/cancel and entry cancel all succeed as shareat_lobby, and write no audit row [kills: a diner path that appends to audit_log (42501 on the real role); the role widened to audit_log]', async () => {
    const auditBefore = (await sql<{ n: number }[]>`select count(*)::int as n from audit_log where org_id = ${orgId}`)[0]!.n;
    const deviceHash = uid('dev');
    const key = { orgId, storeId, deviceHash };

    const made = await withLobbyPrincipal(orgId, async (tx) => {
      const who = (await tx.execute(dsql`select current_user as u`)) as unknown as Array<{ u: string }>;
      expect(who[0]!.u).toBe('shareat_lobby');
      return checkIn(tx, {
        orgId, storeId, deviceHash, ipHash: uid('ip'), displayName: 'Pat', partySize: 3, clientRequestId: crypto.randomUUID(),
        lines: [{ variantId, qty: 2, lineKind: 'package', optionValueIds: [valueId] }, { variantId, qty: 1, lineKind: 'a_la_carte' }],
      });
    });
    expect(made.created).toBe(true);

    await withLobbyPrincipal(orgId, async (tx) => {
      expect((await getMyEntry(tx, key))?.entryId).toBe(made.entryId);
      await requestBirthday(tx, key, { celebrantName: 'Lola' });
      expect((await readMyBirthday(tx, key))?.status).toBe('requested');
      expect((await cancelMyBirthday(tx, key)).status).toBe('cancelled');
      const claim = await submitClaim(tx, key, { kind: 'senior', holderName: 'Zanzibar Quillfeather', idNumber: '0042-5566-1187' });
      expect((await listMyClaims(tx, key)).map((c) => c.claimId)).toEqual([claim.claimId]);
      expect((await cancelMyClaim(tx, key, claim.claimId)).status).toBe('expired');
    });
    const cancelled = await withLobbyPrincipal(orgId, (tx) => cancelMyEntry(tx, key));
    expect(cancelled.status).toBe('cancelled');

    const lines = await sql<{ n: number }[]>`select count(*)::int as n from lobby_entry_lines where entry_id = ${made.entryId}`;
    expect(lines[0]!.n).toBe(2);
    const auditAfter = (await sql<{ n: number }[]>`select count(*)::int as n from audit_log where org_id = ${orgId}`)[0]!.n;
    expect(auditAfter).toBe(auditBefore);
  });
});

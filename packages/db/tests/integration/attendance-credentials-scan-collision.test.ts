import { config } from 'dotenv';
import { beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-321/DEF-363 Contract 1 — the constraint's own cases, at the database, with no domain layer
 * in between. `attendance_credentials_card_live_unique` and `attendance_credentials_token_live_unique`
 * are independent today, so nothing prevents one employment's card id from equalling a different
 * employment's match token. Contract 1 replaces both with ONE partial unique index on
 * `(org_id, coalesce(card_id, match_token)) where revoked_at is null`.
 *
 * ⛔ Written and watched RED (test 3) against the schema as it stands today, BEFORE `0153` exists
 * (RULES §3.2). Tests 4 and 5 currently pass for the uninteresting reason that NO constraint exists
 * yet to violate either way — they are regression guards for after the fix lands, not red controls,
 * and are reported as such rather than claimed as red.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(
    `Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`,
  );
}

const sql = postgres(url, { max: 5 });

let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

beforeAll(async () => {
  await sql`
    truncate table
      attendance_credentials, person_store_scope, person_roles,
      employments, person_identities, persons, stores, organizations
    restart identity cascade
  `;
});

async function insertOrg(hint: string): Promise<string> {
  const code = uid(`scan-${hint}`);
  const [row] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  return row!.id;
}

async function insertStore(orgId: string, hint: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  return row!.id;
}

async function insertPerson(orgId: string, name: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
  return row!.id;
}

async function insertEmployment(orgId: string, storeId: string, personId: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
    values (${orgId}, ${storeId}, ${personId}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e6)}${Math.floor(Math.random() * 1e6)}`}, 'regular', '2025-01-01')
    returning id`;
  return row!.id;
}

/** One org, one store, one admin person to attribute enrolments to, and a `mk` to add employments. */
async function fixture(hint: string) {
  const orgId = await insertOrg(hint);
  const storeId = await insertStore(orgId, hint);
  const adminId = await insertPerson(orgId, 'Admin');
  const mk = async (name: string) => {
    const personId = await insertPerson(orgId, name);
    return insertEmployment(orgId, storeId, personId);
  };
  return { orgId, storeId, adminId, mk };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function liveCard(f: Fixture, employmentId: string, cardId: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into attendance_credentials (org_id, store_id, employment_id, kind, card_id, enrolled_by)
    values (${f.orgId}, ${f.storeId}, ${employmentId}, 'card', ${cardId}, ${f.adminId})
    returning id`;
  return row!.id;
}

async function liveFingerprint(f: Fixture, employmentId: string, matchToken: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into attendance_credentials
      (org_id, store_id, employment_id, kind, match_token, templates, enrolled_by)
    values (${f.orgId}, ${f.storeId}, ${employmentId}, 'fingerprint', ${matchToken}, ${['t1']}, ${f.adminId})
    returning id`;
  return row!.id;
}

async function revoke(f: Fixture, credentialId: string): Promise<void> {
  await sql`
    update attendance_credentials
    set revoked_at = now(), revoked_by = ${f.adminId}, revoke_reason = 'test revoke'
    where id = ${credentialId}
  `;
}

describe('T-321 Contract 1 — a live card_id and a live match_token cannot share a value in one org', () => {
  it('⛔ RED: the database refuses a live match_token equal to a live card_id in the same organisation', async () => {
    const f = await fixture('collide');
    const shared = uid('shared');
    const cardEmployment = await f.mk('Card Holder');
    const fingerEmployment = await f.mk('Finger Holder');

    await liveCard(f, cardEmployment, shared);

    await expect(liveFingerprint(f, fingerEmployment, shared)).rejects.toThrow();
  });

  it('⭐ two ORGANISATIONS may hold the same value — the index must be org-scoped, not global', async () => {
    const a = await fixture('org-a');
    const b = await fixture('org-b');
    const shared = uid('shared');
    const empA = await a.mk('Holder A');
    const empB = await b.mk('Holder B');

    // Both must succeed. If a future index is accidentally GLOBAL, the second insert here throws
    // and this test fails loudly — that is the whole point of asserting both rather than one.
    await expect(liveCard(a, empA, shared)).resolves.toBeTruthy();
    await expect(liveCard(b, empB, shared)).resolves.toBeTruthy();
  });

  it('⭐ a REVOKED row does not collide — enrol, revoke, then a different kind may reuse the value', async () => {
    const f = await fixture('reissue');
    const shared = uid('shared');
    const cardEmployment = await f.mk('Card Holder');
    const fingerEmployment = await f.mk('Finger Holder');

    const cardCredentialId = await liveCard(f, cardEmployment, shared);
    await revoke(f, cardCredentialId);

    // The card id is no longer LIVE — the partial index (`where revoked_at is null`) must let a
    // different employment's fingerprint token reuse the exact same string.
    await expect(liveFingerprint(f, fingerEmployment, shared)).resolves.toBeTruthy();
  });

  // ⭐⭐ Found by the auditor's read: `enrolCard`'s existing catch matches the LITERAL string
  // `attendance_credentials_card_live_unique` — an index Contract 1 deletes. If the constant this
  // task adds ever drifts from what the migration actually names, the catch stops firing and a raw
  // Postgres violation escapes the domain again — the exact DEF-362 shape, reintroduced on the one
  // path that currently does it right. This does not import a guessed export name (there is
  // nothing to import yet — the constant does not exist until the builder adds it): it scans the
  // schema module's own exports for a string equal to the literal the spec has fixed
  // (`attendance_credentials_scan_value_live_unique`) and checks it against what `pg_indexes` says
  // is really on the table, so it cannot pass by coincidence and cannot be written by guessing a
  // property name that happens to be wrong.
  it('⚠️ the exported index-name constant matches the index the database really has', async () => {
    const EXPECTED = 'attendance_credentials_scan_value_live_unique';
    const schema = (await import('@shareat/db/schema')) as Record<string, unknown>;
    const matchingExport = Object.entries(schema).find(([, v]) => v === EXPECTED);

    const [dbIndex] = await sql<{ indexname: string }[]>`
      select indexname from pg_indexes
      where tablename = 'attendance_credentials' and indexname = ${EXPECTED}
    `;

    // Both must be true together: a real exported constant carrying this exact value, AND a real
    // index in the database with this exact name. Today, before 0153, neither exists — that is
    // reported as what it is, not claimed as a drift-catching red yet.
    expect(matchingExport, `no export in @shareat/db/schema equals "${EXPECTED}"`).toBeDefined();
    expect(dbIndex?.indexname, `pg_indexes has no "${EXPECTED}" on attendance_credentials`).toBe(EXPECTED);
  });

  // ⛔⛔ Turns the auditor's own checklist item 2 ("did the index count actually go DOWN") into a
  // control instead of a one-time human read. The test above only proves the ONE new index
  // exists — a migration that added it WITHOUT dropping the two old ones would pass that test
  // while going net +1, the precise inversion of Contract 1. Asserted here directly against
  // `pg_indexes`, never against a count alone, so it names which of the two survivors is the
  // problem rather than just disagreeing with a number.
  it('⛔ the two old per-column indexes are GONE — Contract 1 replaces them, it does not join them', async () => {
    const OLD_CARD = 'attendance_credentials_card_live_unique';
    const OLD_TOKEN = 'attendance_credentials_token_live_unique';

    const rows = await sql<{ indexname: string }[]>`
      select indexname from pg_indexes
      where tablename = 'attendance_credentials' and indexname in (${OLD_CARD}, ${OLD_TOKEN})
    `;
    const survivors = rows.map((r) => r.indexname);

    expect(survivors, `expected both old indexes gone; still present: ${survivors.join(', ') || 'none'}`).toEqual([]);
  });
});

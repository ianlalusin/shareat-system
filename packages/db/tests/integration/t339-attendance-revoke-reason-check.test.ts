/**
 * T-339 slice 5 / DEF-236 — `docs/tasks/339-small-defects-batch-1.md` "Slice 5", "Tests".
 * `attendance_credentials_revoke_check` (0100) requires only `revoke_reason IS NOT NULL`; a blank
 * or whitespace-only reason passes it today, unlike its sibling `person_credentials_revoke_check`
 * (0138). Migration `0158` re-adds the SAME-NAMED constraint with a `btrim(...) <> ''` clause.
 *
 * ⛔ RED until 0158 lands: today both `''` and `'   '` are accepted (no rejection at all), so the
 * `.rejects.toThrow(/attendance_credentials_revoke_check/)` assertions below fail because nothing
 * throws.
 *
 * Fixture copied from `attendance-credentials-scan-collision.test.ts:41-96` (`fixture`, `liveCard`)
 * — this file's own header explains the shape (one org/store/admin, `mk` to add employments).
 */
import { config } from 'dotenv';
import { beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
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
  const code = uid(`revoke-${hint}`);
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

/** Attempts to revoke a live credential with the given (possibly-invalid) revoke fields, all in
 *  ONE UPDATE — the same shape `packages/domain/src/attendance/credentials.ts`'s revoke path uses. */
async function tryRevoke(
  credentialId: string,
  fields: { revokedAt?: Date | null; revokedBy?: string | null; revokeReason?: string | null },
): Promise<void> {
  await sql`
    update attendance_credentials
    set revoked_at = ${fields.revokedAt === undefined ? sql`now()` : fields.revokedAt},
        revoked_by = ${fields.revokedBy === undefined ? null : fields.revokedBy},
        revoke_reason = ${fields.revokeReason === undefined ? null : fields.revokeReason}
    where id = ${credentialId}
  `;
}

describe('T-339 slice 5 — attendance_credentials_revoke_check refuses a blank or whitespace reason', () => {
  it('⛔ RED: empty string reason is rejected', async () => {
    const f = await fixture('empty');
    const employmentId = await f.mk('Empty Reason');
    const credId = await liveCard(f, employmentId, uid('CARD'));
    await expect(tryRevoke(credId, { revokedBy: f.adminId, revokeReason: '' })).rejects.toThrow(
      /attendance_credentials_revoke_check/,
    );
  });

  it('⛔ RED: whitespace-only reason is rejected', async () => {
    const f = await fixture('blank');
    const employmentId = await f.mk('Blank Reason');
    const credId = await liveCard(f, employmentId, uid('CARD'));
    await expect(tryRevoke(credId, { revokedBy: f.adminId, revokeReason: '   ' })).rejects.toThrow(
      /attendance_credentials_revoke_check/,
    );
  });

  it('NEGATIVE: a real reason ("Lost badge") is accepted', async () => {
    const f = await fixture('lost');
    const employmentId = await f.mk('Lost Badge');
    const credId = await liveCard(f, employmentId, uid('CARD'));
    await expect(tryRevoke(credId, { revokedBy: f.adminId, revokeReason: 'Lost badge' })).resolves.toBeUndefined();
    const [row] = await sql<{ revoke_reason: string }[]>`select revoke_reason from attendance_credentials where id = ${credId}`;
    expect(row!.revoke_reason).toBe('Lost badge');
  });

  it('NEGATIVE (NULL-blind trap): revoke_reason NULL with revoked_at set is still rejected', async () => {
    const f = await fixture('null-reason');
    const employmentId = await f.mk('Null Reason');
    const credId = await liveCard(f, employmentId, uid('CARD'));
    await expect(tryRevoke(credId, { revokedBy: f.adminId, revokeReason: null })).rejects.toThrow(
      /attendance_credentials_revoke_check/,
    );
  });

  it('NEGATIVE: revoked_by NULL (revoked_at + reason set) is still rejected', async () => {
    const f = await fixture('null-by');
    const employmentId = await f.mk('Null By');
    const credId = await liveCard(f, employmentId, uid('CARD'));
    await expect(tryRevoke(credId, { revokedBy: null, revokeReason: 'Lost badge' })).rejects.toThrow(
      /attendance_credentials_revoke_check/,
    );
  });

  it('NEGATIVE: a never-revoked, all-NULL row inserts and stays that way', async () => {
    const f = await fixture('never-revoked');
    const employmentId = await f.mk('Never Revoked');
    const credId = await liveCard(f, employmentId, uid('CARD'));
    const [row] = await sql<{ revoked_at: Date | null; revoked_by: string | null; revoke_reason: string | null }[]>`
      select revoked_at, revoked_by, revoke_reason from attendance_credentials where id = ${credId}`;
    expect(row).toEqual({ revoked_at: null, revoked_by: null, revoke_reason: null });
  });
});

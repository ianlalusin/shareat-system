import { config } from 'dotenv';
import { describe, it, expect, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-321/DEF-362 — the OWN-COLUMN case, and the one this exists to close on its own merits.
 * `enrolFingerprint` has NO catch at all in production today: a match-token collision escapes the
 * domain as a raw Postgres violation. This proves the fix on `attendance_credentials_token_live_unique`,
 * the index that already exists, with NO dependency on migration 0153 — auditor's finding,
 * 2026-09-17: the only other `enrolFingerprint` collision test needs the CROSS-KIND case (a
 * fingerprint colliding with a live CARD id), which needs 0153 to exist before it violates
 * anything, so closing DEF-362 was otherwise unproven in a release that ships the catch without
 * the migration.
 *
 * ⭐ Release-portable by construction: two fingerprints minted in ONE organisation, same value (the
 * crypto mock below), so the SECOND violates whichever index currently guards `match_token` —
 * `attendance_credentials_token_live_unique` before 0153, `attendance_credentials_scan_value_live_unique`
 * after it (0153 drops the former and replaces it with the latter). ⛔ The constraint name is
 * therefore NOT asserted — it legitimately differs between releases, and hard-coding either one
 * makes this pass in one release and fail in the other for a reason that has nothing to do with
 * whether the catch still works.
 *
 * ⛔⛔ NOT asserting `rejects.toBeInstanceOf(CredentialError)` alone — orchestrator + auditor,
 * 2026-09-17. `enrolFingerprint` also throws `CredentialError` for empty/oversized `templates` and
 * `requireOpenEmployment`/`authorize` can throw before the insert is ever attempted, so an
 * instance-of check alone would still go green if a fixture drift accidentally exercised one of
 * those branches instead of the collision. Pinned instead on the AUDIT TRAIL: a
 * `prerequisite_refusals` row with `reason_code = 'attendance.credential.already_enrolled_elsewhere'`
 * can only be written by the collision branch (T-245, `recordPrerequisiteRefusal`), and it is
 * read in a brand-new transaction opened AFTER the rejection — proving it is durable, not merely
 * unrolled-back-yet — the same pattern `attendance-credentials.test.ts`'s own T-245 DURABILITY
 * test already uses. ⭐ This also covers the failure-open half nobody else tests: if the tolerant
 * catch ever stops matching, the missing symptom is not just "no CredentialError" but "no audit
 * row either" — this assertion is the only thing that would notice the second half.
 */
const FIXED_TOKEN = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'; // 32 hex chars = 16 bytes, a valid match token shape

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomBytes: (size: number) =>
      size === 16 ? Buffer.from(FIXED_TOKEN, 'hex') : actual.randomBytes(size),
  };
});

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(
    `Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`,
  );
}

import { APP_ROLE, transaction, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { CredentialError, enrolFingerprint } from '@shareat/domain';

const sql = postgres(url, { max: 5 });
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

const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

async function fixture(hint: string) {
  const code = uid(`fptok-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const storeId = store!.id;

  const [adminP] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${adminP!.id}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${adminP!.id}, ${storeId})`;
  const admin = actor(orgId, adminP!.id);

  const mkEmployment = async (name: string) => {
    const [p] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    const [emp] = await sql<{ id: string }[]>`
      insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
      values (${orgId}, ${storeId}, ${p!.id}, ${uid('SE')}, 'regular', '2025-01-01')
      returning id`;
    return emp!.id;
  };

  return { orgId, storeId, admin, mkEmployment };
}

describe('T-321/DEF-362 own-column — two fingerprints minting the same token in one org', () => {
  it('⛔ the second raises CredentialError AND records a durable prerequisite_refusals row', async () => {
    const f = await fixture('collide');
    const empA = await f.mkEmployment('First Enrolled');
    const empB = await f.mkEmployment('Second Enrolled');

    // First mint succeeds outright — nothing live yet to collide with.
    await asOrg(f.orgId, (tx) =>
      enrolFingerprint(tx, f.admin, { employmentId: empA, templates: ['dGVtcA=='] }),
    );

    // Second mint is IDENTICAL (the crypto mock is fixed), so it collides on match_token alone —
    // no card involved, no dependency on migration 0153 existing.
    await expect(
      asOrg(f.orgId, (tx) =>
        enrolFingerprint(tx, f.admin, { employmentId: empB, templates: ['dGVtcA=='] }),
      ),
    ).rejects.toBeInstanceOf(CredentialError);

    // Read in a BRAND NEW transaction, opened after the throwing one has fully rejected — proves
    // the row is durable, not merely not-yet-rolled-back (T-245's own DURABILITY pattern).
    const rows = await sql`
      select reason_code, actor_person_id from prerequisite_refusals
      where org_id = ${f.orgId} and reason_code = 'attendance.credential.already_enrolled_elsewhere'
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]!.actor_person_id).toBe(f.admin.personId);
  });
});

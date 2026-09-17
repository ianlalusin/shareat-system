import { config } from 'dotenv';
import { describe, it, expect, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-321/DEF-363 Contract 4 / DEF-362 — `enrolFingerprint` must translate a uniqueness violation
 * into a `CredentialError`, exactly as `enrolCard` already does for its own column.
 *
 * ⛔ **Why this file is isolated, and why it mocks `node:crypto`.** `enrolFingerprint` mints its
 * own 128-bit random match token internally (`newMatchToken`, unexported — no injectable seam),
 * so a real collision cannot be forced through its public signature, and 2^128 rules out brute
 * force. The only honest way to prove the catch fires is to control the randomness: `randomBytes`
 * is mocked to return a FIXED value for a 16-byte request, so `enrolFingerprint`'s freshly minted
 * token is a value this test chose and already made live as a card id. Isolated in its own file,
 * never the shared `attendance-credentials.test.ts`, so this mock cannot leak into any test that
 * wants real randomness (approved by the orchestrator on that condition).
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
import { CredentialError, enrolCard, enrolFingerprint } from '@shareat/domain';

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
  const code = uid(`fpcol-${hint}`);
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

describe('T-321/DEF-362 — enrolFingerprint raises CredentialError, not a raw constraint violation, on a collision', () => {
  it('⛔ a fingerprint whose minted token collides with a live card id raises CredentialError', async () => {
    const f = await fixture('collide');
    const cardEmployment = await f.mkEmployment('Card Holder');
    const fingerEmployment = await f.mkEmployment('Finger Holder');

    // The card lives at exactly the value the mocked randomBytes will hand enrolFingerprint below.
    await asOrg(f.orgId, (tx) =>
      enrolCard(tx, f.admin, { employmentId: cardEmployment, cardId: FIXED_TOKEN }),
    );

    await expect(
      asOrg(f.orgId, (tx) =>
        enrolFingerprint(tx, f.admin, { employmentId: fingerEmployment, templates: ['dGVtcA=='] }),
      ),
    ).rejects.toBeInstanceOf(CredentialError);
  });

  // T-321/DEF-363 Contract 5 — same wording requirement as enrolCard's own catch: the message
  // must not read as though the ONLY possible collision partner is a card. Pinned on substance
  // (both kinds named as possible), not the exact sentence, for the same reason as the sibling
  // assertion in attendance-credentials.test.ts.
  it('⛔ the refusal does not assume the collision partner is a card', async () => {
    const f = await fixture('wording');
    const cardEmployment = await f.mkEmployment('Card Holder');
    const fingerEmployment = await f.mkEmployment('Finger Holder');

    await asOrg(f.orgId, (tx) =>
      enrolCard(tx, f.admin, { employmentId: cardEmployment, cardId: FIXED_TOKEN }),
    );

    const error = await asOrg(f.orgId, (tx) =>
      enrolFingerprint(tx, f.admin, { employmentId: fingerEmployment, templates: ['dGVtcA=='] }),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CredentialError);
    const message = (error as Error).message;
    expect(message, message).toMatch(/card/i);
    expect(message, message).toMatch(/fingerprint/i);
  });
});

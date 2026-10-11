import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-387 S7 - `employmentRepo.photoFileIds(tx, employmentIds)`: reads `employments.photo_file_id` for a batch.
 * PINNED SHAPE: `Map<string, string | null>`. An employment visible to the caller with no photo maps to null; an
 * employment the caller cannot see (another org, under RLS) is ABSENT from the map (`has()` false), never an error
 * and never a leaked file id. An empty id list returns an empty map.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - name must contain "_test".`);
}

import { APP_ROLE, employmentRepo, transaction, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { createEmployment, seedCanonicalPositions } from '@shareat/domain';

const sql = postgres(url, { max: 5 });
afterAll(async () => {
  await sql.end({ timeout: 5 });
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

async function world(hint: string) {
  const code = uid(`ph-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, 'S') returning id`;
  const [admin] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${admin!.id}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id, source) values (${admin!.id}, ${store!.id}, 'manual')`;
  await asOrg(orgId, (tx) => seedCanonicalPositions(tx, orgId));
  const a: Actor = { personId: admin!.id, orgId };
  const hire = async (name: string) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    return asOrg(orgId, (tx) =>
      createEmployment(tx, a, { storeId: store!.id, personId: p!.id, employmentStatus: 'regular', startedOn: '2026-01-05' }),
    );
  };
  const withPhoto = await hire('With Photo');
  const noPhoto = await hire('No Photo');
  const [file] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
    values (${orgId}, ${store!.id}, 'onboarding_document', ${`orgs/${orgId}/p/${uid('f')}.jpg`}, 'image/jpeg', 1024, ${uid('sum')}, ${admin!.id})
    returning id`;
  await sql`update employments set photo_file_id = ${file!.id} where id = ${withPhoto.id}`;
  return { orgId, withPhoto, noPhoto, fileId: file!.id };
}

describe('T-387 S7 - employmentRepo.photoFileIds', () => {
  it('maps employmentId to photo_file_id, null when none', async () => {
    const w = await world('basic');
    const m = await asOrg(w.orgId, (tx) => employmentRepo.photoFileIds(tx, [w.withPhoto.id, w.noPhoto.id]));
    expect(m).toBeInstanceOf(Map);
    expect(m.get(w.withPhoto.id)).toBe(w.fileId);
    expect(m.has(w.noPhoto.id)).toBe(true);
    expect(m.get(w.noPhoto.id)).toBeNull();
  });

  it('an empty list gives an empty map', async () => {
    const w = await world('empty');
    const m = await asOrg(w.orgId, (tx) => employmentRepo.photoFileIds(tx, []));
    expect(m.size).toBe(0);
  });

  it('RLS: another org employment is invisible (absent, and its file id never leaks)', async () => {
    const mine = await world('rlsa');
    const theirs = await world('rlsb');
    const m = await asOrg(mine.orgId, (tx) =>
      employmentRepo.photoFileIds(tx, [mine.withPhoto.id, theirs.withPhoto.id, theirs.noPhoto.id]),
    );
    expect(m.get(mine.withPhoto.id)).toBe(mine.fileId);
    expect(m.has(theirs.withPhoto.id)).toBe(false);
    expect(m.has(theirs.noPhoto.id)).toBe(false);
    expect([...m.values()]).not.toContain(theirs.fileId);
  });
});

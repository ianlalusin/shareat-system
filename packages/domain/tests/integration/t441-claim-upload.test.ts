import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-441 S1 TESTER - `claimUpload` (upload first, then claim). docs/tasks/441-photo-upload-control.md section 3,
 * audit A1/A2, mutants M8-M13 and M24-M26, plus the orphan sweep never touching a claimed or a young file.
 *
 * ASSUMED CONTRACT:
 *   claimUpload(tx, actor, { fileId, purpose, storeId, linkTo }) exported from '@shareat/domain' -> Promise<unknown>.
 *   It links ATOMICALLY (one conditional UPDATE ... WHERE linked_to IS NULL ... RETURNING) and, when zero rows match, throws a
 *   RefusalError whose `userMessage` is ONE sentence ("That photo is no longer available - pick it again") for EVERY cause
 *   (missing / not mine / wrong purpose / wrong store / taken / expired / other org / malformed id), so a probe learns nothing.
 *
 * RED reason before the build: `claimUpload` is not exported from @shareat/domain.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { closeDb, transaction, APP_ROLE, RefusalError, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import * as domain from '@shareat/domain';
import { inMemoryDriver, setStorageDriver, sweepOrphanedFiles } from '@shareat/domain';

const sql = postgres(url, { max: 8 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
let driver = inMemoryDriver();
beforeEach(() => {
  driver = inMemoryDriver();
  setStorageDriver(driver);
});
afterAll(async () => {
  setStorageDriver(null);
  await closeDb();
  await sql.end({ timeout: 5 });
});

type ClaimInput = { fileId: string; purpose: string; storeId: string | null; linkTo: string };
function claimFn(): (tx: Tx, actor: Actor, input: ClaimInput) => Promise<unknown> {
  const fn = (domain as unknown as Record<string, unknown>)['claimUpload'];
  if (typeof fn !== 'function') throw new Error('claimUpload is not exported from @shareat/domain yet (packages/domain/src/files/index.ts)');
  return fn as never;
}

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}
const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

async function newOrg(hint: string) {
  const code = uid(`t441c-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const mkStore = async (n: string) => {
    const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(n)}, ${n}) returning id`;
    return s!.id;
  };
  const mkPerson = async (name: string, storeIds: string[]) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, 'manager')`;
    for (const s of storeIds) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s})`;
    return p!.id;
  };
  return { orgId, mkStore, mkPerson };
}

async function fixture(hint: string) {
  const o = await newOrg(hint);
  const storeA = await o.mkStore('A');
  const storeB = await o.mkStore('B');
  const meId = await o.mkPerson('Me', [storeA, storeB]);
  const otherId = await o.mkPerson('Other', [storeA, storeB]);
  return { ...o, storeA, storeB, me: actor(o.orgId, meId), other: actor(o.orgId, otherId) };
}
type F = Awaited<ReturnType<typeof fixture>>;

/** An unlinked upload row whose bytes really are in the driver; `ageHours` back-dates uploaded_at on the DB clock. */
async function upload(
  f: { orgId: string },
  o: { by: string; purpose?: string; storeId?: string | null; ageHours?: number; linkedTo?: string | null },
): Promise<{ id: string; path: string }> {
  const purpose = o.purpose ?? 'receipt_photo';
  const storeId = o.storeId === undefined ? null : o.storeId;
  const path = `orgs/${f.orgId}/${storeId ? `stores/${storeId}/` : ''}${purpose}/${crypto.randomUUID()}.jpg`;
  await driver.put({ path, bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), contentType: 'image/jpeg' } as never);
  const [row] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by, linked_to, uploaded_at)
    values (${f.orgId}, ${storeId}, ${purpose}, ${path}, 'image/jpeg', 4, ${uid('sum')}, ${o.by}, ${o.linkedTo ?? null},
            now() - make_interval(hours => ${o.ageHours ?? 0}))
    returning id`;
  return { id: row!.id, path };
}
const linkedTo = async (id: string) => (await sql<{ linked_to: string | null }[]>`select linked_to from stored_files where id = ${id}`)[0]?.linked_to ?? null;
const exists = async (id: string) => (await sql`select 1 from stored_files where id = ${id}`).length === 1;
const claim = (f: { orgId: string }, who: Actor, input: ClaimInput) => asOrg(f.orgId, (tx) => claimFn()(tx, who, input));
const refusal = async (p: Promise<unknown>): Promise<RefusalError> => {
  try {
    await p;
  } catch (err) {
    if (err instanceof RefusalError) return err;
    throw new Error(`expected a RefusalError but got ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
  }
  throw new Error('expected the claim to be refused, but it succeeded');
};

describe('a valid claim', () => {
  it('M25 links the file to the record in the same step and leaves it claimed', async () => {
    const f = await fixture('ok');
    const recordId = crypto.randomUUID();
    const u = await upload(f, { by: f.me.personId, storeId: f.storeA });
    await claim(f, f.me, { fileId: u.id, purpose: 'receipt_photo', storeId: f.storeA, linkTo: recordId });
    expect(await linkedTo(u.id)).toBe(recordId);
    expect(await exists(u.id)).toBe(true);
  });

  it('a store-less upload claims with storeId null (store compared NULL-safely)', async () => {
    const f = await fixture('nullstore');
    const u = await upload(f, { by: f.me.personId, purpose: 'staff_photo', storeId: null });
    const rec = crypto.randomUUID();
    await claim(f, f.me, { fileId: u.id, purpose: 'staff_photo', storeId: null, linkTo: rec });
    expect(await linkedTo(u.id)).toBe(rec);
  });

  it('boundary: an upload 23 h old is still claimable', async () => {
    const f = await fixture('23h');
    const u = await upload(f, { by: f.me.personId, storeId: f.storeA, ageHours: 23 });
    const rec = crypto.randomUUID();
    await claim(f, f.me, { fileId: u.id, purpose: 'receipt_photo', storeId: f.storeA, linkTo: rec });
    expect(await linkedTo(u.id)).toBe(rec);
  });
});

describe('every refusal is ONE identical sentence, and links nothing', () => {
  it('M8-M13, M26: another person, wrong purpose, wrong store (both ways), taken, expired, other org, deleted, unknown, malformed', async () => {
    const f = await fixture('refuse');
    const rec = crypto.randomUUID();
    const mine = (o: Partial<Parameters<typeof upload>[1]> = {}) => upload(f, { by: f.me.personId, storeId: f.storeA, ...o });
    const ok = { purpose: 'receipt_photo', storeId: f.storeA as string | null, linkTo: rec };

    const foreign = await newOrg('foreign');
    const foreignStore = await foreign.mkStore('FS');
    const foreignPerson = await foreign.mkPerson('Foreign', [foreignStore]);
    const inOtherOrg = await upload(foreign, { by: foreignPerson, storeId: foreignStore });
    const gone = await mine();
    await sql`delete from stored_files where id = ${gone.id}`;

    const cases: { name: string; fileId: string; input?: Partial<ClaimInput>; who?: Actor }[] = [
      { name: "M8 another person's file", fileId: (await upload(f, { by: f.other.personId, storeId: f.storeA })).id },
      { name: 'M9 wrong purpose', fileId: (await mine()).id, input: { purpose: 'leave_document' } },
      { name: 'M10 wrong store', fileId: (await mine()).id, input: { storeId: f.storeB } },
      { name: 'M10 store given, file has none', fileId: (await upload(f, { by: f.me.personId, storeId: null })).id },
      { name: 'M10 no store given, file has one', fileId: (await mine()).id, input: { storeId: null } },
      { name: 'M11 already linked', fileId: (await mine({ linkedTo: crypto.randomUUID() })).id },
      { name: 'M12 older than 24 h', fileId: (await mine({ ageHours: 25 })).id },
      { name: "M13 another org's id", fileId: inOtherOrg.id },
      { name: 'M26 swept / deleted', fileId: gone.id },
      { name: 'never existed', fileId: crypto.randomUUID() },
      { name: 'not a uuid', fileId: 'not-a-uuid' },
    ];
    const messages: string[] = [];
    for (const c of cases) {
      const err = await refusal(claim(f, c.who ?? f.me, { fileId: c.fileId, ...ok, ...(c.input ?? {}) } as ClaimInput));
      expect(err.userMessage, c.name).toMatch(/no longer available/i);
      messages.push(err.userMessage);
    }
    expect(new Set(messages).size, `refusals differ: ${JSON.stringify([...new Set(messages)])}`).toBe(1);

    // nothing was linked by any refusal (the other-org and foreign rows included)
    for (const c of cases) if (c.fileId !== gone.id && /^[0-9a-f-]{36}$/.test(c.fileId) && c.name !== 'M11 already linked') {
      expect(await linkedTo(c.fileId), c.name).toBeNull();
    }
    expect(await linkedTo(inOtherOrg.id)).toBeNull();
  });

  it('a refused claim leaves the file claimable by its owner afterwards', async () => {
    const f = await fixture('retry');
    const u = await upload(f, { by: f.me.personId, storeId: f.storeA });
    await refusal(claim(f, f.other, { fileId: u.id, purpose: 'receipt_photo', storeId: f.storeA, linkTo: crypto.randomUUID() }));
    const rec = crypto.randomUUID();
    await claim(f, f.me, { fileId: u.id, purpose: 'receipt_photo', storeId: f.storeA, linkTo: rec });
    expect(await linkedTo(u.id)).toBe(rec);
  });
});

describe('M24 - two concurrent claims of one upload: exactly one wins', () => {
  it('the second transaction is refused once the first commits, and the file stays linked to the winner', async () => {
    const f = await fixture('race');
    const u = await upload(f, { by: f.me.personId, storeId: f.storeA });
    const recA = crypto.randomUUID();
    const recB = crypto.randomUUID();
    const input = (linkTo: string): ClaimInput => ({ fileId: u.id, purpose: 'receipt_photo', storeId: f.storeA, linkTo });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    // Tx 1 claims and then HOLDS its transaction open; tx 2 starts while tx 1's claim is uncommitted.
    const p1 = asOrg(f.orgId, async (tx) => {
      await claimFn()(tx, f.me, input(recA));
      await gate;
    });
    await sleep(150);
    const p2 = asOrg(f.orgId, (tx) => claimFn()(tx, f.me, input(recB)));
    await sleep(250);
    release();
    const [r1, r2] = await Promise.allSettled([p1, p2]);
    expect(r1.status, 'the first claim must win').toBe('fulfilled');
    expect(r2.status, 'the second claim must be refused, not also succeed').toBe('rejected');
    expect((r2 as PromiseRejectedResult).reason).toBeInstanceOf(RefusalError);
    expect(((r2 as PromiseRejectedResult).reason as RefusalError).userMessage).toMatch(/no longer available/i);
    expect(await linkedTo(u.id)).toBe(recA);
  });

  it('two truly simultaneous claims: one fulfilled, one refused', async () => {
    const f = await fixture('race2');
    const u = await upload(f, { by: f.me.personId, storeId: f.storeA });
    const mk = (linkTo: string) => claim(f, f.me, { fileId: u.id, purpose: 'receipt_photo', storeId: f.storeA, linkTo });
    const results = await Promise.allSettled([mk(crypto.randomUUID()), mk(crypto.randomUUID())]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });
});

describe('the orphan sweep and a claim never trample each other', () => {
  it('never deletes a claimed file, however old; never deletes an unclaimed one under 24 h; deletes one over 24 h', async () => {
    const f = await fixture('sweep');
    const claimed = await upload(f, { by: f.me.personId, storeId: f.storeA, ageHours: 23 });
    await claim(f, f.me, { fileId: claimed.id, purpose: 'receipt_photo', storeId: f.storeA, linkTo: crypto.randomUUID() });
    await sql`update stored_files set uploaded_at = now() - interval '72 hours' where id = ${claimed.id}`;
    const young = await upload(f, { by: f.me.personId, storeId: f.storeA, ageHours: 23 });
    const old = await upload(f, { by: f.me.personId, storeId: f.storeA, ageHours: 25 });

    const r = await sweepOrphanedFiles(f.orgId, 24);
    expect(r.failed).toEqual([]);
    expect(await exists(claimed.id), 'a claimed file was swept').toBe(true);
    expect(driver.files.has(claimed.path), 'a claimed file lost its bytes').toBe(true);
    expect(await exists(young.id), 'an unclaimed file under 24 h was swept').toBe(true);
    expect(driver.files.has(young.path)).toBe(true);
    expect(await exists(old.id), 'an unclaimed file over 24 h should be swept').toBe(false);
    expect(driver.files.has(old.path)).toBe(false);
  });

  it('M26 a claim after the sweep deleted the row is refused (no record pointing at deleted bytes)', async () => {
    const f = await fixture('sweep2');
    const old = await upload(f, { by: f.me.personId, storeId: f.storeA, ageHours: 25 });
    await sweepOrphanedFiles(f.orgId, 24);
    const err = await refusal(claim(f, f.me, { fileId: old.id, purpose: 'receipt_photo', storeId: f.storeA, linkTo: crypto.randomUUID() }));
    expect(err.userMessage).toMatch(/no longer available/i);
  });
});

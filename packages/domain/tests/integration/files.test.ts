import { config } from 'dotenv';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-141 — upload brokering. ADR-002 §3, bible row 155, **DEF-070**.
 *
 * ⭐ The test that matters most is the cross-org read. v1's bucket lets any signed-in user read
 * every file in it — every store, every org — and this is the control that replaces it.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(
    `Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`,
  );
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, filesRepo, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import {
  inMemoryDriver,
  readFileUrl,
  runOrphanFileSweep,
  setStorageDriver,
  sweepOrphanedFiles,
  uploadFile,
} from '@shareat/domain';

const sql = postgres(url, { max: 5 });
let driver = inMemoryDriver();

let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

async function newOrg(hint: string) {
  const code = uid(`f-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id
  `;
  await seedChartOfAccounts(sql, org!.id);
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${org!.id}, ${uid(hint)}, ${`Store ${hint}`}) returning id
  `;
  return { orgId: org!.id, storeId: store!.id };
}

async function person(orgId: string, storeId: string, name: string, role: string) {
  const [p] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id
  `;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
  await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
  return p!.id;
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

async function fixture(hint: string) {
  const o = await newOrg(hint);
  const staffId = await person(o.orgId, o.storeId, 'Staff', 'staff');
  return { ...o, staffId, staff: actor(o.orgId, staffId) };
}

/** A structurally real JPEG carrying GPS in an EXIF segment. */
function photoWithGps(): Uint8Array {
  const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
  const payload = [...ascii('Exif\0'), 0, ...ascii('GPS 14.0865 121.1553')];
  const len = payload.length + 2;
  return Uint8Array.from([
    0xff, 0xd8,
    0xff, 0xe1, (len >> 8) & 0xff, len & 0xff, ...payload,
    0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 0, 0,
    0x11, 0x22, 0x33,
    0xff, 0xd9,
  ]);
}

beforeAll(async () => {
  await sql`
    truncate table
      stored_files, remittance_variances, remittance_allocations, remittance_lines, remittances,
      scheduler_runs, prepaid_items, money_transfers, money_accounts, expense_payments, expenses,
      expense_categories, person_grants, person_store_scope, person_roles,
      journal_lines, journal_entries, audit_log, fiscal_periods, accounts,
      person_identities, persons, stores, organizations
    restart identity cascade
  `;
});

beforeEach(() => {
  driver = inMemoryDriver();
  setStorageDriver(driver);
});

afterAll(async () => {
  setStorageDriver(null);
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('⭐ the path is DERIVED, never accepted', () => {
  it('is built from the session, and the client has no say in it', async () => {
    const f = await fixture('path');
    const r = await asOrg(f.orgId, (tx) =>
      uploadFile(tx, f.staff, {
        purpose: 'receipt_photo',
        storeId: f.storeId,
        contentType: 'image/jpeg',
        bytes: photoWithGps(),
      }),
    );
    // ⛔ Every segment comes from the server. There is no input this test could pass to change it,
    // which is the property — "any signed-in user can write into any store's folder" is not
    // expressible.
    expect(r.storagePath).toBe(
      `orgs/${f.orgId}/stores/${f.storeId}/receipt_photo/${r.fileId}.jpg`,
    );
    expect(driver.files.has(r.storagePath)).toBe(true);
  });

  it('⭐ strips the GPS before the bytes ever reach storage', async () => {
    const f = await fixture('exif');
    const r = await asOrg(f.orgId, (tx) =>
      uploadFile(tx, f.staff, {
        purpose: 'receipt_photo',
        storeId: f.storeId,
        contentType: 'image/jpeg',
        bytes: photoWithGps(),
      }),
    );
    expect(r.metadataRemoved).toBe(1);
    // ⚠️ Read back out of the bucket, not out of the return value: the claim is about what was
    // STORED. The photo is evidence of a purchase, not of where an employee was.
    const stored = driver.files.get(r.storagePath)!;
    expect(String.fromCharCode(...stored)).not.toContain('GPS');
    // And the image data survived.
    expect(Array.from(stored.slice(-5))).toEqual([0x11, 0x22, 0x33, 0xff, 0xd9]);
  });
});

describe('⛔ DEF-070 — one org cannot read another org’s file', () => {
  it('refuses, even with the exact file id', async () => {
    const mine = await fixture('mine');
    const theirs = await fixture('theirs');

    const r = await asOrg(theirs.orgId, (tx) =>
      uploadFile(tx, theirs.staff, {
        purpose: 'receipt_photo',
        storeId: theirs.storeId,
        contentType: 'image/jpeg',
        bytes: photoWithGps(),
      }),
    );

    // ⭐ THE CONTROL THAT REPLACES `allow read: if request.auth != null`. In v1's bucket this read
    // succeeds for anyone signed in, across every org. Here the row is unreachable, so the URL
    // cannot be minted.
    await expect(
      asOrg(mine.orgId, (tx) =>
        readFileUrl(tx, mine.staff, { fileId: r.fileId }),
      ),
    ).rejects.toThrow(/does not exist in this org/);
  });

  it('and the owner gets a url that EXPIRES', async () => {
    const f = await fixture('signed');
    const r = await asOrg(f.orgId, (tx) =>
      uploadFile(tx, f.staff, {
        purpose: 'receipt_photo',
        storeId: f.storeId,
        contentType: 'image/jpeg',
        bytes: photoWithGps(),
      }),
    );
    const { url } = await asOrg(f.orgId, (tx) => readFileUrl(tx, f.staff, { fileId: r.fileId }));
    // ⛔ Never stored, never logged — a stored URL is a permanent unauthenticated grant, which is
    // exactly what getDownloadURL() hands out.
    expect(url).toMatch(/expires=\d+/);
  });
});

describe('the refusals', () => {
  it('⛔ refuses a content type the purpose does not allow', async () => {
    const f = await fixture('type');
    await expect(
      asOrg(f.orgId, (tx) =>
        uploadFile(tx, f.staff, {
          purpose: 'receipt_photo',
          storeId: f.storeId,
          contentType: 'application/x-msdownload',
          bytes: Uint8Array.from([1, 2, 3]),
        }),
      ),
    ).rejects.toThrow(/is not accepted for a receipt photo/);
  });

  it('⛔ refuses an oversized file, naming the limit', async () => {
    const f = await fixture('size');
    await expect(
      asOrg(f.orgId, (tx) =>
        uploadFile(tx, f.staff, {
          purpose: 'receipt_photo',
          storeId: f.storeId,
          contentType: 'image/png',
          bytes: new Uint8Array(9 * 1024 * 1024),
        }),
      ),
    ).rejects.toThrow(/the limit for a receipt photo is 8 MB/);
  });

  it('⛔ refuses an empty file', async () => {
    const f = await fixture('empty');
    await expect(
      asOrg(f.orgId, (tx) =>
        uploadFile(tx, f.staff, {
          purpose: 'receipt_photo',
          storeId: f.storeId,
          contentType: 'image/jpeg',
          bytes: new Uint8Array(0),
        }),
      ),
    ).rejects.toThrow(/is empty/);
  });

  it('⛔ the capability is the one that governs the THING', async () => {
    const f = await fixture('cap');
    // Staff may create an expense, so they may attach a receipt. They may NOT enrol anyone, so an
    // onboarding document is refused — one generic "upload" permission would have allowed both.
    await expect(
      asOrg(f.orgId, (tx) =>
        uploadFile(tx, f.staff, {
          purpose: 'onboarding_document',
          storeId: f.storeId,
          contentType: 'application/pdf',
          bytes: Uint8Array.from([37, 80, 68, 70]),
        }),
      ),
    ).rejects.toThrow(AuthorizationError);
  });
});

describe('⭐ the orphan sweep — bytes nobody can reach', () => {
  it('collects an unclaimed upload and leaves a claimed one', async () => {
    const f = await fixture('sweep');
    const orphan = await asOrg(f.orgId, (tx) =>
      uploadFile(tx, f.staff, {
        purpose: 'receipt_photo',
        storeId: f.storeId,
        contentType: 'image/jpeg',
        bytes: photoWithGps(),
      }),
    );
    const claimed = await asOrg(f.orgId, (tx) =>
      uploadFile(tx, f.staff, {
        purpose: 'receipt_photo',
        storeId: f.storeId,
        contentType: 'image/jpeg',
        bytes: photoWithGps(),
      }),
    );
    await asOrg(f.orgId, (tx) => filesRepo.linkFile(tx, f.orgId, claimed.fileId, 'expense:123'));

    // Age the orphan past the window.
    await sql`update stored_files set uploaded_at = now() - interval '2 days' where id = ${orphan.fileId}`;
    await sql`update stored_files set uploaded_at = now() - interval '2 days' where id = ${claimed.fileId}`;

    const result = await sweepOrphanedFiles(f.orgId, 24);
    expect(result.removed).toBe(1);
    expect(result.claimed).toBe(0);
    expect(result.failed).toEqual([]);

    // ⭐ The claimed file survives — it is the evidence behind something.
    expect(driver.files.has(claimed.storagePath)).toBe(true);
    expect(driver.files.has(orphan.storagePath)).toBe(false);
  });

  it('⚠️ a fresh unclaimed upload is left alone — a draft in progress is not an orphan', async () => {
    const f = await fixture('fresh');
    await asOrg(f.orgId, (tx) =>
      uploadFile(tx, f.staff, {
        purpose: 'receipt_photo',
        storeId: f.storeId,
        contentType: 'image/jpeg',
        bytes: photoWithGps(),
      }),
    );
    const result = await sweepOrphanedFiles(f.orgId, 24);
    expect(result.removed).toBe(0);
    expect(result.claimed).toBe(0);
  });

  describe('⛔ DEF-298 — the row is the authority; a file claimed mid-sweep keeps BOTH row and bytes', () => {
    it('a file claimed in the window between an earlier file\'s bytes-removal and its own delete is not swept', async () => {
      const f = await fixture('race');
      const early = await asOrg(f.orgId, (tx) =>
        uploadFile(tx, f.staff, {
          purpose: 'receipt_photo',
          storeId: f.storeId,
          contentType: 'image/jpeg',
          bytes: photoWithGps(),
        }),
      );
      const late = await asOrg(f.orgId, (tx) =>
        uploadFile(tx, f.staff, {
          purpose: 'receipt_photo',
          storeId: f.storeId,
          contentType: 'image/jpeg',
          bytes: photoWithGps(),
        }),
      );
      // `listOrphans` orders by uploaded_at ASC, so `early` is processed first — that ordering is
      // what makes the injection below land strictly between the batch READ and `late`'s DELETE.
      await sql`update stored_files set uploaded_at = now() - interval '2 days' where id = ${early.fileId}`;
      await sql`update stored_files set uploaded_at = now() - interval '2 days' + interval '1 second' where id = ${late.fileId}`;

      // ⭐ The injection: the instant the sweep removes `early`'s bytes (which, under the FIXED
      // order, only happens after `early`'s row is already gone), something else claims `late` —
      // simulating another request's `linkFile` landing in the exact window this task closes.
      // Against the OLD order (remove-then-delete) this same hook fires BEFORE `late`'s own delete
      // too, which is exactly how this test fails against the current-at-spec-time code (see the
      // task's own instruction to prove that before trusting the fix).
      const real = driver;
      setStorageDriver({
        ...real,
        async remove(path: string) {
          if (path === early.storagePath) {
            await asOrg(f.orgId, (tx) => filesRepo.linkFile(tx, f.orgId, late.fileId, 'expense:raced-in'));
          }
          return real.remove(path);
        },
      });

      const result = await sweepOrphanedFiles(f.orgId, 24);

      // `early` had nothing claim it — swept clean, row and bytes.
      expect(driver.files.has(early.storagePath)).toBe(false);
      // `late` was claimed before ITS delete ran — BOTH the row and the bytes survive.
      expect(driver.files.has(late.storagePath)).toBe(true);
      const [lateRow] = await sql<{ linked_to: string | null }[]>`
        select linked_to from stored_files where id = ${late.fileId}
      `;
      expect(lateRow?.linked_to).toBe('expense:raced-in');

      // DEF-297: `removed` counts only what was actually deleted — `late` is not in it.
      expect(result.removed).toBe(1);
      expect(result.claimed).toBe(1);
      expect(result.failed).toEqual([]);
    });
  });

  describe('a storage failure lands in failed[] without stopping the sweep or losing the row', () => {
    it('one unreachable object does not block another, and its already-deleted row is not silently hidden', async () => {
      const f = await fixture('storage-fail');
      const unreachable = await asOrg(f.orgId, (tx) =>
        uploadFile(tx, f.staff, {
          purpose: 'receipt_photo',
          storeId: f.storeId,
          contentType: 'image/jpeg',
          bytes: photoWithGps(),
        }),
      );
      const fine = await asOrg(f.orgId, (tx) =>
        uploadFile(tx, f.staff, {
          purpose: 'receipt_photo',
          storeId: f.storeId,
          contentType: 'image/jpeg',
          bytes: photoWithGps(),
        }),
      );
      await sql`update stored_files set uploaded_at = now() - interval '2 days' where id = ${unreachable.fileId}`;
      await sql`update stored_files set uploaded_at = now() - interval '2 days' where id = ${fine.fileId}`;

      const real = driver;
      setStorageDriver({
        ...real,
        async remove(path: string) {
          if (path === unreachable.storagePath) throw new Error('bucket: object locked');
          return real.remove(path);
        },
      });

      const result = await sweepOrphanedFiles(f.orgId, 24);

      // The other candidate still got swept — one failure does not stop the loop.
      expect(driver.files.has(fine.storagePath)).toBe(false);
      expect(result.removed).toBe(1);
      expect(result.claimed).toBe(0);
      expect(result.failed).toEqual([{ path: unreachable.storagePath, error: 'bucket: object locked' }]);

      // ⚠️ The accepted residual, proven rather than asserted in prose: the row-delete runs BEFORE
      // driver.remove, so it already committed when the remove above threw. The row is gone; only
      // the bytes are stranded, findable via `failed[].path` — never a live row over dead bytes.
      const [row] = await sql<{ id: string }[]>`select id from stored_files where id = ${unreachable.fileId}`;
      expect(row).toBeUndefined();
      expect(driver.files.has(unreachable.storagePath)).toBe(true);
    });
  });

  describe('⭐ T-272/DEF-299 — the sweep is scoped per org, not global', () => {
    it('sweeping one org never touches another org\'s orphan', async () => {
      const a = await fixture('org-a');
      const b = await fixture('org-b');

      const orphanA = await asOrg(a.orgId, (tx) =>
        uploadFile(tx, a.staff, {
          purpose: 'receipt_photo',
          storeId: a.storeId,
          contentType: 'image/jpeg',
          bytes: photoWithGps(),
        }),
      );
      const orphanB = await asOrg(b.orgId, (tx) =>
        uploadFile(tx, b.staff, {
          purpose: 'receipt_photo',
          storeId: b.storeId,
          contentType: 'image/jpeg',
          bytes: photoWithGps(),
        }),
      );
      await sql`update stored_files set uploaded_at = now() - interval '2 days' where id = ${orphanA.fileId}`;
      await sql`update stored_files set uploaded_at = now() - interval '2 days' where id = ${orphanB.fileId}`;

      const result = await sweepOrphanedFiles(a.orgId, 24);

      // Org A's orphan is gone — row and bytes.
      expect(result.removed).toBe(1);
      expect(driver.files.has(orphanA.storagePath)).toBe(false);
      const [rowA] = await sql<{ id: string }[]>`select id from stored_files where id = ${orphanA.fileId}`;
      expect(rowA).toBeUndefined();

      // ⭐ Org B's orphan is untouched — the sweep never crossed the org boundary, in either
      // direction. It is also old enough and unclaimed, so the ONLY reason it should survive is
      // that it belongs to a different org than the one just swept.
      expect(driver.files.has(orphanB.storagePath)).toBe(true);
      const [rowB] = await sql<{ id: string }[]>`select id from stored_files where id = ${orphanB.fileId}`;
      expect(rowB).toBeDefined();
    });

    it('runOrphanFileSweep writes one scheduler_runs row for the org it ran, even when nothing was found', async () => {
      const f = await fixture('wiring');
      const before = await sql<{ n: string }[]>`
        select count(*)::text as n from scheduler_runs where org_id = ${f.orgId} and job = 'orphan_file_sweep'`;
      expect(before[0]!.n).toBe('0');

      const run = await runOrphanFileSweep({ orgId: f.orgId, trigger: 'manual' });
      expect(run.hadFailures).toBe(false);
      expect(run.outcomes[0]!.posted).toBe(0);

      const after = await sql<{ n: string; outcome: string; posted: number }[]>`
        select count(*)::text as n, min(outcome) as outcome, min(posted_count) as posted
        from scheduler_runs where org_id = ${f.orgId} and job = 'orphan_file_sweep'`;
      expect(after[0]!.n).toBe('1');
      expect(after[0]!.outcome).toBe('ok');
      expect(after[0]!.posted).toBe(0);
    });

    it('runOrphanFileSweep records the real count it removed', async () => {
      const f = await fixture('wiring-real');
      const orphan = await asOrg(f.orgId, (tx) =>
        uploadFile(tx, f.staff, {
          purpose: 'receipt_photo',
          storeId: f.storeId,
          contentType: 'image/jpeg',
          bytes: photoWithGps(),
        }),
      );
      await sql`update stored_files set uploaded_at = now() - interval '2 days' where id = ${orphan.fileId}`;

      const run = await runOrphanFileSweep({ orgId: f.orgId, trigger: 'manual' });
      expect(run.hadFailures).toBe(false);
      expect(run.outcomes[0]!.posted).toBe(1);
      expect(driver.files.has(orphan.storagePath)).toBe(false);

      const [row] = await sql<{ outcome: string; posted_count: number }[]>`
        select outcome, posted_count from scheduler_runs
        where org_id = ${f.orgId} and job = 'orphan_file_sweep'`;
      expect(row?.outcome).toBe('ok');
      expect(row?.posted_count).toBe(1);
    });
  });
});

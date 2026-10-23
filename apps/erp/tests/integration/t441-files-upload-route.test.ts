import { config } from 'dotenv';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-441 S1 TESTER - `POST /files/upload` (the upload-on-pick route) + `resolveUploadedFile` + the guarded
 * lightbox audit contract on `GET /files/[fileId]?open=n`. docs/tasks/441-photo-upload-control.md section 3, audit A3/A5/A6,
 * orchestrator rulings (30-unclaimed cap, magic-byte check). Mutants M14-M19, M21, M27-M31.
 *
 * ASSUMED CONTRACT (the builder must match, or say so):
 *   Route file  apps/erp/src/app/files/upload/route.ts exports `POST(request: Request)`; it reads headers from `request.headers`
 *     (NOT next/headers) and the session from `currentSession()` in lib/session (NOT requireActor: its redirect is a 200 to an XHR).
 *   Request     POST /files/upload?purpose=<purpose>&storeId=<uuid>   body = the raw file bytes, Content-Type = the file's type.
 *   Success     200 JSON { fileId, contentType, byteSize } - exactly those keys; `Cache-Control: private, no-store` on EVERY answer.
 *   Refusals    JSON { error: "<sentence>" } (any key with one sentence; the tests only require JSON + no path/URL/uuid leak):
 *               401 no session | 403 bad/missing Origin, or not allowed | 400 unknown purpose / purpose outside
 *               {receipt_photo, staff_photo, leave_document} / non-uuid store / empty body | 411 no Content-Length |
 *               413 over the cap (header OR real length) | 415 type not allowed for the purpose, or magic bytes do not match |
 *               429 actor already holds 30 unclaimed uploads younger than 24 h | 500 generic on a fault (kind-only log).
 *   Order       401 first; type (415), Content-Length (411) and size (413) are decided BEFORE the body is read.
 *   Origin      must be present and its host must equal (x-forwarded-host ?? host).
 *   resolveUploadedFile(tx, actor, formData, name, { purpose, storeId }) in apps/erp/src/lib/uploaded-file.ts
 *     -> Promise<string | null>: the file id to claim after the record insert. A posted `<name>FileId` wins; else a posted non-empty
 *     File is uploaded through uploadFile (no-JS path); else null. It does NOT link - the action calls claimUpload after the insert.
 *
 * RED reasons before the build: the route and uploaded-file modules do not exist; claimUpload is not exported.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

const SESSION: { actor: { orgId: string; personId: string } | null } = { actor: null };
const resolved = () => ({
  actor: SESSION.actor!, sessionId: 'session-1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01'),
});
vi.mock('../../src/lib/session', () => ({
  currentSession: vi.fn(async () => (SESSION.actor ? resolved() : null)),
  requireSession: vi.fn(async () => {
    if (!SESSION.actor) throw new Error('redirect:/sign-in');
    return resolved();
  }),
  requireActor: vi.fn(async () => {
    if (!SESSION.actor) throw new Error('redirect:/sign-in');
    return SESSION.actor;
  }),
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
  notFound: () => {
    throw new Error('notFound() called - the routes must return their own responses');
  },
}));

import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import * as domain from '@shareat/domain';
import { attachLeaveDocument, inMemoryDriver, requestLeave, setStorageDriver, type StorageDriver } from '@shareat/domain';
import { logger } from '@shareat/core/logger';

const sql = postgres(url, { max: 8 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
let driver = inMemoryDriver();
beforeEach(() => {
  driver = inMemoryDriver();
  setStorageDriver(driver);
  SESSION.actor = null;
});
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(async () => {
  setStorageDriver(null);
  await closeDb();
  await sql.end({ timeout: 5 });
});

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
  const code = uid(`t441r-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const mkStore = async (n: string) => {
    const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(n)}, ${n}) returning id`;
    return s!.id;
  };
  const storeA = await mkStore('A');
  const storeB = await mkStore('B');
  const mk = async (name: string, role: string, stores: string[]) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    for (const s of stores) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s})`;
    return p!.id;
  };
  const managerId = await mk('Manager', 'manager', [storeA]);
  const otherManagerId = await mk('Other Manager', 'manager', [storeA]);
  const staffId = await mk('Staff', 'staff', [storeA]); // NO position grant: no record_supplier_invoice
  const superId = await mk('Super', 'super_admin', [storeA, storeB]);
  return {
    orgId, storeA, storeB, managerId,
    manager: actor(orgId, managerId), otherManager: actor(orgId, otherManagerId), staff: actor(orgId, staffId), superAdmin: actor(orgId, superId),
  };
}
type F = Awaited<ReturnType<typeof fixture>>;

// ---------- bytes ----------
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
/** A structurally real JPEG carrying GPS in an EXIF segment (same shape as files.test.ts). */
function jpeg(extra = 0): Uint8Array {
  const payload = [...ascii('Exif\0'), 0, ...ascii('GPS 14.0865 121.1553')];
  const len = payload.length + 2;
  const head = [0xff, 0xd8, 0xff, 0xe1, (len >> 8) & 0xff, len & 0xff, ...payload, 0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 0, 0];
  const out = new Uint8Array(head.length + 3 + extra + 2);
  out.set(head, 0);
  out.set([0x11, 0x22, 0x33], head.length);
  out.set([0xff, 0xd9], out.length - 2);
  return out;
}
const png = () => Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
const webp = () => Uint8Array.from([...ascii('RIFF'), 12, 0, 0, 0, ...ascii('WEBP'), ...ascii('VP8 '), 0, 0, 0, 0]);
const riffWave = () => Uint8Array.from([...ascii('RIFF'), 12, 0, 0, 0, ...ascii('WAVE'), ...ascii('fmt '), 0, 0, 0, 0]);
const pdf = (size = 64) => {
  const b = new Uint8Array(Math.max(size, 16));
  b.set(ascii('%PDF-1.4\n'), 0);
  b.set(ascii('\n%%EOF'), b.length - 6);
  return b;
};
const text = () => Uint8Array.from(ascii('hello, this is not a picture at all'));
const bigJpeg = (total: number) => jpeg(Math.max(0, total - jpeg().length));

// ---------- requests ----------
interface Opts {
  purpose?: string | null;
  storeId?: string | null;
  type?: string | null;
  body?: Uint8Array | ReadableStream<Uint8Array>;
  length?: number | null; // null = no Content-Length header
  origin?: string | null;
  host?: string;
  forwardedHost?: string | null;
}
function spyStream(bytes: Uint8Array) {
  const state = { pulled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      state.pulled = true;
      c.enqueue(bytes);
      c.close();
    },
  }, { highWaterMark: 0 }); // 0: nothing is pulled until something actually READS the body
  return { stream, state };
}
function build(f: F, o: Opts) {
  const params = new URLSearchParams();
  if (o.purpose !== null) params.set('purpose', o.purpose ?? 'receipt_photo');
  if (o.storeId !== null) params.set('storeId', o.storeId ?? f.storeA);
  const headers: Record<string, string> = {};
  if (o.type !== null) headers['content-type'] = o.type ?? 'image/jpeg';
  const body = o.body ?? jpeg();
  const len = o.length === undefined ? (body instanceof Uint8Array ? body.length : null) : o.length;
  if (len !== null) headers['content-length'] = String(len);
  if (o.origin !== null) headers['origin'] = o.origin ?? 'http://localhost:9008';
  headers['host'] = o.host ?? 'localhost:9008';
  if (o.forwardedHost) headers['x-forwarded-host'] = o.forwardedHost;
  return new Request(`http://localhost:9008/files/upload?${params}`, {
    method: 'POST', headers, body: body as never, ...(body instanceof Uint8Array ? {} : { duplex: 'half' }),
  } as never);
}
async function loadUploadRoute() {
  try {
    return await import('../../src/app/files/upload/route');
  } catch (err) {
    throw new Error(`apps/erp/src/app/files/upload/route.ts does not exist yet (or fails to import): ${String((err as Error).message).split('\n')[0]}`);
  }
}
async function post(f: F, who: Actor | null, o: Opts = {}): Promise<Response> {
  SESSION.actor = who;
  const { POST } = await loadUploadRoute();
  return POST(build(f, o));
}
const rowsFor = async (orgId: string, by?: string) =>
  (await sql<{ id: string }[]>`select id from stored_files where org_id = ${orgId} ${by ? sql`and uploaded_by = ${by}` : sql``}`).length;
const json = async (res: Response) => JSON.parse(await res.clone().text()) as Record<string, unknown>;
const NO_LEAK = (body: string) => {
  expect(body).not.toMatch(/orgs\//);
  expect(body).not.toMatch(/memory:\/\//);
  expect(body).not.toMatch(/https?:\/\//);
  expect(body).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
};

// =====================================================================================
describe('the happy path', () => {
  it('stores through uploadFile (EXIF stripped, row unlinked) and answers {fileId, contentType, byteSize} - and nothing else', async () => {
    const f = await fixture('ok');
    const input = jpeg();
    const res = await post(f, f.manager);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(Object.keys(body).sort()).toEqual(['byteSize', 'contentType', 'fileId']); // M18: no path, no url
    expect(body['contentType']).toBe('image/jpeg');
    expect(typeof body['fileId']).toBe('string');
    const [row] = await sql<{ id: string; purpose: string; store_id: string; uploaded_by: string; linked_to: string | null; storage_path: string; byte_size: string }[]>`
      select id, purpose, store_id, uploaded_by, linked_to, storage_path, byte_size from stored_files where id = ${body['fileId'] as string}`;
    expect(row).toMatchObject({ purpose: 'receipt_photo', store_id: f.storeA, uploaded_by: f.managerId, linked_to: null });
    expect(Number(row!.byte_size)).toBe(body['byteSize']);
    expect(Number(row!.byte_size)).toBeLessThan(input.length); // EXIF segment stripped by the real uploadFile
    const text = await res.clone().text();
    expect(text).not.toContain(row!.storage_path);
    NO_LEAK(text.replace(row!.id, ''));
    expect(driver.files.has(row!.storage_path)).toBe(true);
  });

  it('M19 every answer carries Cache-Control private, no-store - success, refusal and unauthenticated alike', async () => {
    const f = await fixture('nostore');
    for (const res of [
      await post(f, f.manager),
      await post(f, f.manager, { purpose: 'bogus' }),
      await post(f, f.staff),
      await post(f, null),
      await post(f, f.manager, { origin: null }),
    ]) {
      const cc = res.headers.get('cache-control') ?? '';
      expect(cc, `status ${res.status}`).toMatch(/no-store/);
      expect(cc).toMatch(/private/);
    }
  });

  it('accepts a receipt PDF over 1 MB (the 1 MB ceiling is for images only) and a webp, and a staff photo png', async () => {
    const f = await fixture('types');
    expect((await post(f, f.manager, { type: 'application/pdf', body: pdf(2 * 1024 * 1024) })).status).toBe(200);
    expect((await post(f, f.manager, { type: 'image/webp', body: webp() })).status).toBe(200);
    expect((await post(f, f.superAdmin, { purpose: 'staff_photo', type: 'image/png', body: png() })).status).toBe(200);
  });
});

describe('M27 - no session answers 401 JSON, never a redirect or a 200', () => {
  it('is 401 JSON with no Location, and stores nothing', async () => {
    const f = await fixture('anon');
    const res = await post(f, null);
    expect(res.status).toBe(401);
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('content-type') ?? '').toMatch(/application\/json/);
    expect(typeof (await json(res))['error']).toBe('string');
    expect(await rowsFor(f.orgId)).toBe(0);
  });

  it('still 401 when the request is also cross-origin or malformed (identity first)', async () => {
    const f = await fixture('anon2');
    expect((await post(f, null, { origin: 'https://evil.example', purpose: 'bogus' })).status).toBe(401);
  });
});

describe('M14 - the Origin check (Origin present, host equals x-forwarded-host ?? host)', () => {
  it.each([
    ['no Origin header', { origin: null }],
    ['a foreign site', { origin: 'https://evil.example' }],
    ['the literal "null" origin', { origin: 'null' }],
    ['the same host on another port', { origin: 'http://localhost:3000' }],
    ['a look-alike host', { origin: 'http://localhost:9008.evil.example' }],
    ['the proxy host differs from the Origin (x-forwarded-host wins over host)', { host: 'localhost:9008', origin: 'http://localhost:9008', forwardedHost: 'erp2.shareat.net' }],
  ] as [string, Opts][])('refuses %s with 403 and stores nothing', async (_n, o) => {
    const f = await fixture('origin');
    const res = await post(f, f.manager, o);
    expect(res.status).toBe(403);
    expect(await rowsFor(f.orgId)).toBe(0);
  });

  it('accepts a same-host Origin, and a proxied request whose Origin equals x-forwarded-host (not request.url)', async () => {
    const f = await fixture('origin-ok');
    expect((await post(f, f.manager, { origin: 'http://localhost:9008' })).status).toBe(200);
    const proxied = await post(f, f.manager, { host: '127.0.0.1:3000', origin: 'https://erp2.shareat.net', forwardedHost: 'erp2.shareat.net' });
    expect(proxied.status).toBe(200);
  });
});

describe('purpose and store', () => {
  it('unknown, missing or non-uuid-store requests are 400 and store nothing', async () => {
    const f = await fixture('badparams');
    for (const o of [{ purpose: 'bogus' }, { purpose: null }, { storeId: 'not-a-uuid' }] as Opts[]) {
      expect((await post(f, f.manager, o)).status, JSON.stringify(o)).toBe(400);
    }
    expect(await rowsFor(f.orgId)).toBe(0);
  });

  it('M15 staff_signature is never accepted here, even for a super_admin who holds enrol_staff (positive control: staff_photo is)', async () => {
    const f = await fixture('sig');
    expect((await post(f, f.superAdmin, { purpose: 'staff_photo', type: 'image/png', body: png() })).status).toBe(200);
    const res = await post(f, f.superAdmin, { purpose: 'staff_signature', type: 'image/png', body: png() });
    expect(res.status).toBe(400);
    expect(await rowsFor(f.orgId)).toBe(1); // only the control's staff_photo
  });

  it.each(['memo_document', 'onboarding_document', 'ar_collection_proof', 'wastage_dispute'])(
    'M28 the dormant purpose %s is refused (it has no claiming screen yet), though a super_admin could upload it elsewhere',
    async (purpose) => {
      const f = await fixture('dormant');
      const res = await post(f, f.superAdmin, { purpose, type: 'image/jpeg', body: jpeg() });
      expect([400, 403]).toContain(res.status);
      expect(await rowsFor(f.orgId)).toBe(0);
    },
  );
});

describe('M16 - the capability that governs the purpose, at the store', () => {
  it('a staff member without record_supplier_invoice gets 403 (JSON), nothing stored, and no capability name in the answer', async () => {
    const f = await fixture('cap');
    const res = await post(f, f.staff);
    expect(res.status).toBe(403);
    expect(await rowsFor(f.orgId)).toBe(0);
    const t = await res.clone().text();
    expect(t).not.toMatch(/record_supplier_invoice|uploadFile/);
    expect(res.headers.get('content-type') ?? '').toMatch(/json/);
  });

  it('M16b the capability is checked BEFORE the body is read: a person without it gets 403 and the stream is never pulled', async () => {
    const f = await fixture('capnobody');
    const { stream, state } = spyStream(jpeg());
    const res = await post(f, f.staff, { body: stream, length: jpeg().length });
    expect(res.status).toBe(403);
    expect(state.pulled).toBe(false);
    expect(await rowsFor(f.orgId)).toBe(0);
  });

  it("a manager scoped to store A cannot upload into store B, or into a store that is not in the org's", async () => {
    const f = await fixture('capstore');
    expect((await post(f, f.manager, { storeId: f.storeB })).status).toBe(403);
    expect([400, 403]).toContain((await post(f, f.manager, { storeId: crypto.randomUUID() })).status);
    expect(await rowsFor(f.orgId)).toBe(0);
  });
});

describe('A5/M17/M29 - type and size are decided BEFORE the body is read', () => {
  it.each([
    ['text/plain', 'a type not in PURPOSE_LIMITS'],
    ['image/gif', 'gif'],
    ['application/x-msdownload', 'an executable'],
  ])('%s (%s) is 415 and the body is never pulled', async (type) => {
    const f = await fixture('type');
    const { stream, state } = spyStream(jpeg());
    const res = await post(f, f.manager, { type, body: stream, length: 200 });
    expect(res.status).toBe(415);
    expect(state.pulled).toBe(false);
    expect(await rowsFor(f.orgId)).toBe(0);
  });

  it('a PDF for a leave certificate (images only) and a missing Content-Type are 415', async () => {
    const f = await fixture('type2');
    // super_admin: holds manage_attendance too, so a refusal here is the TYPE, not the capability
    expect((await post(f, f.superAdmin, { purpose: 'leave_document', type: 'application/pdf', body: pdf() })).status).toBe(415);
    expect((await post(f, f.manager, { type: null })).status).toBe(415);
  });

  it('M17 an image one byte over 1 MB is 413 from the header alone (body never pulled); exactly 1 MB is accepted', async () => {
    const f = await fixture('size');
    const over = spyStream(jpeg());
    const r1 = await post(f, f.manager, { body: over.stream, length: 1024 * 1024 + 1 });
    expect(r1.status).toBe(413);
    expect(over.state.pulled).toBe(false);
    expect(await rowsFor(f.orgId)).toBe(0);
    const exact = bigJpeg(1024 * 1024);
    expect(exact.length).toBe(1024 * 1024);
    expect((await post(f, f.manager, { body: exact })).status).toBe(200);
  });

  it('a PDF over the purpose cap (8 MB) is 413 without reading the body', async () => {
    const f = await fixture('size2');
    const { stream, state } = spyStream(pdf());
    const res = await post(f, f.manager, { type: 'application/pdf', body: stream, length: 9 * 1024 * 1024 });
    expect(res.status).toBe(413);
    expect(state.pulled).toBe(false);
  });

  it('M29 no Content-Length is 411 (never "read it and see"), body never pulled', async () => {
    const f = await fixture('nolen');
    const { stream, state } = spyStream(jpeg());
    const res = await post(f, f.manager, { body: stream, length: null });
    expect(res.status).toBe(411);
    expect(state.pulled).toBe(false);
    expect(await rowsFor(f.orgId)).toBe(0);
  });

  it('a header that understates the body is caught by the real byte length (413, nothing stored)', async () => {
    const f = await fixture('lying');
    const res = await post(f, f.manager, { body: bigJpeg(1024 * 1024 + 50_000), length: 100 });
    expect(res.status).toBe(413);
    expect(await rowsFor(f.orgId)).toBe(0);
  });

  it('an empty body is a 4xx, not a 500', async () => {
    const f = await fixture('empty');
    const res = await post(f, f.manager, { body: new Uint8Array(0), length: 0 });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(await rowsFor(f.orgId)).toBe(0);
  });
});

describe('the declared type must match the file\'s magic bytes (ruling: declared type is not trusted)', () => {
  it.each([
    ['image/jpeg', 'png bytes', png],
    ['image/jpeg', 'plain text', text],
    ['image/jpeg', 'pdf bytes', () => pdf()],
    ['image/png', 'jpeg bytes', jpeg],
    ['image/webp', 'plain text', text],
    ['image/webp', 'a RIFF file that is not WEBP', riffWave],
    ['application/pdf', 'jpeg bytes', jpeg],
  ])('declared %s but %s is 415 and nothing is stored', async (type, _what, bytes) => {
    const f = await fixture('magic');
    const res = await post(f, f.manager, { type, body: bytes() });
    expect(res.status).toBe(415);
    expect(await rowsFor(f.orgId)).toBe(0);
  });

  it.each([
    ['image/jpeg', jpeg],
    ['image/png', png],
    ['image/webp', webp],
    ['application/pdf', () => pdf()],
  ])('positive control: genuine %s bytes are accepted', async (type, bytes) => {
    const f = await fixture('magic-ok');
    expect((await post(f, f.manager, { type, body: bytes() })).status).toBe(200);
  });
});

describe('ruling - at most 30 unclaimed uploads per person (younger than 24 h)', () => {
  async function park(f: F, by: string, n: number, o: { ageHours?: number; linked?: boolean; storeId?: string } = {}) {
    for (let i = 0; i < n; i++) {
      const path = `orgs/${f.orgId}/stores/${o.storeId ?? f.storeA}/receipt_photo/${crypto.randomUUID()}.jpg`;
      await sql`
        insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by, linked_to, uploaded_at)
        values (${f.orgId}, ${o.storeId ?? f.storeA}, 'receipt_photo', ${path}, 'image/jpeg', 4, ${uid('sum')}, ${by},
                ${o.linked ? crypto.randomUUID() : null}, now() - make_interval(hours => ${o.ageHours ?? 1}))`;
    }
  }

  it('the 30th is accepted, the 31st is refused 429 (JSON, nothing stored), and the cap is removed-proof', async () => {
    const f = await fixture('cap30');
    await park(f, f.managerId, 29);
    expect((await post(f, f.manager)).status).toBe(200); // now holds 30
    const before = await rowsFor(f.orgId, f.managerId);
    const res = await post(f, f.manager);
    expect(res.status).toBe(429);
    expect(res.headers.get('content-type') ?? '').toMatch(/json/);
    expect(res.headers.get('cache-control') ?? '').toMatch(/no-store/);
    expect(await rowsFor(f.orgId, f.managerId)).toBe(before);
  });

  it('M32 five parallel uploads at 29 held: exactly ONE succeeds and the rest are 429 (the count is serialised per person)', async () => {
    const f = await fixture('cap30race');
    await park(f, f.managerId, 29);
    const results = await Promise.all([0, 1, 2, 3, 4].map(() => post(f, f.manager)));
    const codes = results.map((r) => r.status).sort();
    expect(codes).toEqual([200, 429, 429, 429, 429]);
    expect(await rowsFor(f.orgId, f.managerId)).toBe(30);
  });

  it('claimed uploads and uploads older than 24 h do not count; another person\'s do not count', async () => {
    const f = await fixture('cap30b');
    await park(f, f.managerId, 20, { linked: true });
    await park(f, f.managerId, 20, { ageHours: 30 });
    await park(f, f.otherManager.personId, 40);
    expect((await post(f, f.manager)).status).toBe(200);
  });

  it('the cap is per person across stores', async () => {
    const f = await fixture('cap30c');
    await park(f, f.superAdmin.personId, 30, { storeId: f.storeB });
    expect((await post(f, f.superAdmin, { storeId: f.storeA })).status).toBe(429);
  });
});

describe('M18 - faults say nothing: generic 500, kind-only log', () => {
  it('a storage fault whose message names a path and a URL reaches neither the answer nor the log', async () => {
    const f = await fixture('fault');
    const secret = 'orgs/SECRET-PATH-123/x.jpg https://signed.example/leak?sig=abc';
    const broken: StorageDriver = {
      name: 'broken',
      put: async () => { throw new Error(`boom ${secret}`); },
      signedUrl: async () => 'x',
      get: async () => new Uint8Array(),
      remove: async () => undefined,
    };
    setStorageDriver(broken);
    const spies = (['error', 'warn', 'info', 'debug', 'fatal'] as const).map((l) => vi.spyOn(logger, l as 'error'));
    const res = await post(f, f.manager);
    expect(res.status).toBe(500);
    const t = await res.clone().text();
    expect(t).not.toMatch(/SECRET-PATH|signed\.example|boom|orgs\//);
    const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls), (_k, v) => (v instanceof Error ? { name: v.name, message: v.message } : v));
    expect(logged).not.toMatch(/SECRET-PATH|signed\.example|orgs\//);
  });

  it('a successful upload logs no path or signed URL', async () => {
    const f = await fixture('quiet');
    const spies = (['error', 'warn', 'info', 'debug'] as const).map((l) => vi.spyOn(logger, l as 'error'));
    const res = await post(f, f.manager);
    expect(res.status).toBe(200);
    const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
    expect(logged).not.toMatch(/orgs\/|memory:\/\//);
  });
});

// =====================================================================================
describe('resolveUploadedFile + claimUpload - both paths end linked (M21, M31)', () => {
  async function loadResolve() {
    try {
      return (await import('../../src/lib/uploaded-file')) as unknown as {
        resolveUploadedFile: (tx: Tx, a: Actor, fd: FormData, name: string, o: { purpose: string; storeId: string | null }) => Promise<string | null>;
      };
    } catch (err) {
      throw new Error(`apps/erp/src/lib/uploaded-file.ts does not exist yet (or fails to import): ${String((err as Error).message).split('\n')[0]}`);
    }
  }
  const claimFn = () => {
    const fn = (domain as unknown as Record<string, unknown>)['claimUpload'];
    if (typeof fn !== 'function') throw new Error('claimUpload is not exported from @shareat/domain yet');
    return fn as (tx: Tx, a: Actor, i: { fileId: string; purpose: string; storeId: string | null; linkTo: string }) => Promise<unknown>;
  };
  const opts = (f: F) => ({ purpose: 'receipt_photo', storeId: f.storeA });
  const linked = async (id: string) => (await sql<{ linked_to: string | null }[]>`select linked_to from stored_files where id = ${id}`)[0]!.linked_to;

  it('JS path: a posted receiptPhotoFileId is returned as is (bytes are not sent twice), and the claim then links it', async () => {
    const f = await fixture('resolve-js');
    const res = await post(f, f.manager);
    const fileId = (await json(res))['fileId'] as string;
    const { resolveUploadedFile } = await loadResolve();
    const fd = new FormData();
    fd.set('receiptPhotoFileId', fileId);
    const rec = crypto.randomUUID();
    const got = await asOrg(f.orgId, async (tx) => {
      const id = await resolveUploadedFile(tx, f.manager, fd, 'receiptPhoto', opts(f));
      await claimFn()(tx, f.manager, { fileId: id!, ...opts(f), linkTo: rec });
      return id;
    });
    expect(got).toBe(fileId);
    expect(await rowsFor(f.orgId)).toBe(1);
    expect(await linked(fileId)).toBe(rec);
  });

  it('M21/M31 no-JS path: a posted File is uploaded by the same actor, returned, and the SAME claim step links it', async () => {
    const f = await fixture('resolve-nojs');
    const { resolveUploadedFile } = await loadResolve();
    const fd = new FormData();
    fd.set('receiptPhoto', new File([jpeg() as BlobPart], 'r.jpg', { type: 'image/jpeg' }));
    const rec = crypto.randomUUID();
    const id = await asOrg(f.orgId, async (tx) => {
      const fileId = await resolveUploadedFile(tx, f.manager, fd, 'receiptPhoto', opts(f));
      expect(typeof fileId).toBe('string');
      await claimFn()(tx, f.manager, { fileId: fileId!, ...opts(f), linkTo: rec });
      return fileId!;
    });
    const [row] = await sql<{ uploaded_by: string; purpose: string; store_id: string; linked_to: string | null }[]>`
      select uploaded_by, purpose, store_id, linked_to from stored_files where id = ${id}`;
    expect(row).toEqual({ uploaded_by: f.managerId, purpose: 'receipt_photo', store_id: f.storeA, linked_to: rec });
    expect(await rowsFor(f.orgId)).toBe(1);
  });

  it('M33 no-JS path: a posted File whose bytes are not the declared type is refused by uploadFile itself, nothing stored', async () => {
    const f = await fixture('resolve-magic');
    const { resolveUploadedFile } = await loadResolve();
    const fd = new FormData();
    fd.set('receiptPhoto', new File([text() as BlobPart], 'r.jpg', { type: 'image/jpeg' }));
    await expect(asOrg(f.orgId, (tx) => resolveUploadedFile(tx, f.manager, fd, 'receiptPhoto', opts(f)))).rejects.toThrow();
    expect(await rowsFor(f.orgId)).toBe(0);
  });

  it('nothing posted, or an empty File, resolves to null; a posted FileId beats a posted File (no second upload)', async () => {
    const f = await fixture('resolve-null');
    const { resolveUploadedFile } = await loadResolve();
    const none = new FormData();
    const emptyFile = new FormData();
    emptyFile.set('receiptPhoto', new File([], '', { type: 'application/octet-stream' }));
    const both = new FormData();
    both.set('receiptPhotoFileId', crypto.randomUUID());
    both.set('receiptPhoto', new File([jpeg() as BlobPart], 'r.jpg', { type: 'image/jpeg' }));
    await asOrg(f.orgId, async (tx) => {
      expect(await resolveUploadedFile(tx, f.manager, none, 'receiptPhoto', opts(f))).toBeNull();
      expect(await resolveUploadedFile(tx, f.manager, emptyFile, 'receiptPhoto', opts(f))).toBeNull();
      expect(await resolveUploadedFile(tx, f.manager, both, 'receiptPhoto', opts(f))).toBe(both.get('receiptPhotoFileId'));
    });
    expect(await rowsFor(f.orgId)).toBe(0);
  });
});

// =====================================================================================
describe('A6/M30 - a guarded lightbox open is ONE audited view each, whatever ?open= says', () => {
  const NOTE = 'DOCNOTE-t441';
  async function leaveFixture() {
    const code = uid('t441-leave');
    const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
    const orgId = org!.id;
    const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('L')}, 'L') returning id`;
    const mk = async (name: string, role: string) => {
      const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
      await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
      await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${store!.id})`;
      return p!.id;
    };
    const adminId = await mk('Admin', 'admin');
    const workerId = await mk('Worker', 'staff');
    const colleagueId = await mk('Colleague', 'staff');
    const [e] = await sql<{ id: string }[]>`
      insert into employments (org_id, person_id, store_id, staff_code, started_on, employment_status, created_by)
      values (${orgId}, ${workerId}, ${store!.id}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e6)}${Math.floor(Math.random() * 1e6)}`}, '2025-01-01', 'regular', ${adminId}) returning id`;
    const worker = actor(orgId, workerId);
    const r = await asOrg(orgId, (tx) =>
      requestLeave(tx, worker, { employmentId: e!.id, leaveType: 'sick', note: NOTE, days: [{ date: '2026-03-02', kind: 'leave' }] } as never));
    const admin = actor(orgId, adminId);
    const att = (await asOrg(orgId, (tx) =>
      attachLeaveDocument(tx, admin, { requestId: (r as { requestId: string }).requestId, contentType: 'image/jpeg', bytes: jpeg() } as never))) as { fileId: string };
    return { orgId, admin, colleague: actor(orgId, colleagueId), fileId: att.fileId };
  }
  const audit = async (orgId: string, action: string, by?: string) =>
    (await sql`select 1 from audit_log where org_id = ${orgId} and action = ${action} ${by ? sql`and actor_person_id = ${by}` : sql``}`).length;
  async function get(who: Actor, fileId: string, query: string): Promise<Response> {
    SESSION.actor = who;
    const { GET } = await import('../../src/app/files/[fileId]/route');
    return GET(new Request(`http://localhost:9008/files/${fileId}${query}`), { params: Promise.resolve({ fileId }) } as never);
  }

  it('each open (fresh ?open=n) and even a repeated identical URL writes its own leave_document.viewed row; the answer is a no-store redirect', async () => {
    const lf = await leaveFixture();
    const seen: string[] = [];
    for (const q of ['?open=1', '?open=2', '?open=2', '']) {
      const res = await get(lf.admin, lf.fileId, q);
      expect(res.status, q).toBe(302);
      expect(res.headers.get('cache-control') ?? '').toMatch(/no-store/);
      seen.push(res.headers.get('location') ?? '');
    }
    expect(await audit(lf.orgId, 'leave_document.viewed', lf.admin.personId)).toBe(4);
    expect(seen.every((u) => u.length > 0)).toBe(true);
  });

  it('a viewer without the right gets the uniform 404 on every open and each attempt is a view_refused row, never a viewed one', async () => {
    const lf = await leaveFixture();
    for (const q of ['?open=1', '?open=2']) {
      const res = await get(lf.colleague, lf.fileId, q);
      expect(res.status).toBe(404);
      expect(res.headers.get('location')).toBeNull();
    }
    expect(await audit(lf.orgId, 'leave_document.view_refused', lf.colleague.personId)).toBe(2);
    expect(await audit(lf.orgId, 'leave_document.viewed', lf.colleague.personId)).toBe(0);
  });
});

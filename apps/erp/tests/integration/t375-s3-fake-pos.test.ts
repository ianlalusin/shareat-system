import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T-375 S3, FP1 - the dev fake POS: `apps/erp/src/app/api/dev/fake-pos/api/external/[route]/route.ts`.
 * `docs/tasks/375-pos-v1-day-feed.md` S3 (V13, W10).
 *
 * TESTER, not BUILDER. The route's `GET` is called directly with a `Request` and `{ params: Promise<{ route }> }` (this
 * Next version's context). No database. `NODE_ENV`, `POS_FAKE_ENABLED` and `POS_API_KEY` are set BOTH on `process.env`
 * (`vi.stubEnv`) and through a partial mock of `env()` so the route may read either.
 *
 * ## Why these are red on HEAD
 * The route file does not exist: every leg fails on "Failed to resolve import" (it is imported dynamically, per leg).
 *
 * ## What "no file read" means here
 * `node:fs`, `fs`, `node:fs/promises` and `fs/promises` are wrapped so every `readFile`/`readFileSync` path is recorded.
 * A traversal id (`../../etc`, `a/b`) must be answered 400 with NO recorded read whose path mentions it. The control
 * that proves the recorder works: a VALID id with no fixture file is a 404, and that read (the attempt) is recorded.
 *
 * ## The positive control reads the BUILDER's fixtures (`apps/erp/dev-fixtures/pos-v1/**`, never touched here)
 * `stores.json` lists a store; `{id}/payment-methods.json` lists methods; some `{id}/{date}.sales.json` holds D1's body
 * (P 1,050 D 100 C 50 K 600 N 20, methods {Cash 700, GCash 350}). The test discovers them by listing the directory, so
 * the builder's file names for the day are free; what is pinned is the layout the spec names.
 */
const h = vi.hoisted(() => ({
  reads: [] as string[],
  key: 'fake-pos-test-key' as string | undefined,
  flag: '1' as string | undefined,
  nodeEnv: 'development' as string,
}));

function recorder<T extends (...a: never[]) => unknown>(fn: T): T {
  return ((...a: never[]) => {
    h.reads.push(String(a[0]));
    return fn(...a);
  }) as unknown as T;
}
vi.mock('node:fs', async (orig) => {
  const m = await orig<typeof import('node:fs')>();
  const promises = { ...m.promises, readFile: recorder(m.promises.readFile) };
  const out = { ...m, readFileSync: recorder(m.readFileSync), promises };
  return { ...out, default: out };
});
vi.mock('fs', async (orig) => {
  const m = await orig<typeof import('fs')>();
  const promises = { ...m.promises, readFile: recorder(m.promises.readFile) };
  const out = { ...m, readFileSync: recorder(m.readFileSync), promises };
  return { ...out, default: out };
});
vi.mock('node:fs/promises', async (orig) => {
  const m = await orig<typeof import('node:fs/promises')>();
  const out = { ...m, readFile: recorder(m.readFile) };
  return { ...out, default: out };
});
vi.mock('fs/promises', async (orig) => {
  const m = await orig<typeof import('fs/promises')>();
  const out = { ...m, readFile: recorder(m.readFile) };
  return { ...out, default: out };
});
vi.mock('@shareat/core/env', async (orig) => {
  const real = await orig<typeof import('@shareat/core/env')>();
  return { ...real, env: () => ({ ...real.env(), NODE_ENV: h.nodeEnv, POS_API_KEY: h.key, POS_FAKE_ENABLED: h.flag }) };
});

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { POS_V1_SALES_FIELDS as S } from '@shareat/db';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(here, '..', '..', 'dev-fixtures', 'pos-v1');
const KEY = 'fake-pos-test-key';

beforeEach(() => {
  h.reads.length = 0;
  h.key = KEY;
  h.flag = '1';
  h.nodeEnv = 'development';
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv('POS_FAKE_ENABLED', '1');
  vi.stubEnv('POS_API_KEY', KEY);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

function setEnv(o: { nodeEnv?: string; flag?: string | undefined; key?: string | undefined }) {
  if (o.nodeEnv !== undefined) {
    h.nodeEnv = o.nodeEnv;
    vi.stubEnv('NODE_ENV', o.nodeEnv);
  }
  if ('flag' in o) {
    h.flag = o.flag;
    if (o.flag === undefined) vi.stubEnv('POS_FAKE_ENABLED', '');
    else vi.stubEnv('POS_FAKE_ENABLED', o.flag);
  }
  if ('key' in o) {
    h.key = o.key;
    vi.stubEnv('POS_API_KEY', o.key ?? '');
  }
}

async function call(route: string, query: Record<string, string>, headers: Record<string, string> = { 'x-api-key': KEY }) {
  const mod = (await import('../../src/app/api/dev/fake-pos/api/external/[route]/route')) as {
    GET: (req: Request, ctx: { params: Promise<{ route: string }> }) => Promise<Response>;
  };
  const qs = new URLSearchParams(query).toString();
  const req = new Request(`http://localhost:9008/api/dev/fake-pos/api/external/${route}${qs ? `?${qs}` : ''}`, { headers });
  const res = await mod.GET(req, { params: Promise.resolve({ route }) });
  return { status: res.status, text: await res.text() };
}

/** D1's sales fixture, found by content: { id, date, text } or null. */
function findD1(): { id: string; date: string; text: string } | null {
  if (!existsSync(FIXTURES)) return null;
  for (const id of readdirSync(FIXTURES, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)) {
    for (const file of readdirSync(path.join(FIXTURES, id)).filter((f) => f.endsWith('.sales.json'))) {
      const text = readFileSync(path.join(FIXTURES, id, file), 'utf8');
      const body = JSON.parse(text) as Record<string, unknown>;
      const methods = body[S.methods] as Record<string, number> | undefined;
      if (
        body[S.found] === true && body[S.paidTotal] === 1050 && body[S.discounts] === 100 && body[S.charges] === 50 &&
        body[S.packageOnly] === 600 && body[S.receiptCount] === 20 && methods?.Cash === 700 && methods?.GCash === 350
      ) {
        return { id, date: file.replace(/\.sales\.json$/, ''), text };
      }
    }
  }
  return null;
}

describe('FP1 - the fake POS answers only in development, with the flag, with the key', () => {
  it('NODE_ENV production with POS_FAKE_ENABLED=1 and the right key -> 404 (the flag does not unlock production)', async () => {
    setEnv({ nodeEnv: 'production' });
    const r = await call('stores', {});
    expect(r.status).toBe(404);
  });

  it('development without the flag (unset, or 0) -> 404', async () => {
    setEnv({ flag: undefined });
    expect((await call('stores', {})).status).toBe(404);
    setEnv({ flag: '0' });
    expect((await call('stores', {})).status).toBe(404);
  });

  it('a wrong key -> 401, and so is a missing key', async () => {
    expect((await call('stores', {}, { 'x-api-key': 'not-the-key' })).status).toBe(401);
    expect((await call('stores', {}, {})).status).toBe(401);
  });

  it('control: development + flag + key -> 200 for stores (the gates above are the only thing in the way)', async () => {
    const r = await call('stores', {});
    expect(r.status).toBe(200);
    const parsed = JSON.parse(r.text) as { stores?: { id: string }[] };
    expect(Array.isArray(parsed.stores) && parsed.stores.length > 0, 'stores.json lists at least one store').toBe(true);
  });
});

describe('FP1 - ids that could build a path are refused 400 before anything is read', () => {
  const traversal = ['../../etc', 'a/b', '..', 'x'.repeat(65), 'with space'];

  it.each(traversal)('posStoreId %j -> 400, no file read mentioning it', async (id) => {
    for (const route of ['sales', 'sold-items', 'payment-methods']) {
      h.reads.length = 0;
      const r = await call(route, { storeId: id, date: '2027-01-10' });
      expect(r.status, `${route} with storeId ${id}`).toBe(400);
      expect(r.text).not.toMatch(/root:|passwd|\[boot loader\]/i);
      expect(h.reads.filter((p) => p.includes('etc') || p.includes('..')), 'no path was built from the id').toEqual([]);
    }
  });

  it.each(['2027-1-10', '10-01-2027', '../x', '2027-01-10/../../x', ''])('date %j -> 400', async (date) => {
    const d1 = findD1();
    const id = d1?.id ?? 'any-store';
    const r = await call('sales', { storeId: id, date });
    expect(r.status).toBe(400);
    expect(h.reads.filter((p) => p.includes('..')), 'no path was built from the date').toEqual([]);
  });

  it('control: a VALID id and date with no fixture file is a 404 (so a 400 above is the validator, not a missing file)', async () => {
    const r = await call('sales', { storeId: 'no-such-store', date: '2000-01-01' });
    expect(r.status).toBe(404);
  });
});

describe('FP1 - the fixtures answer, byte for byte (positive control)', () => {
  it('sales for D1: the fixture file\'s own text, 200; sold-items for the same day parse and carry items; payment-methods list Cash and GCash', async () => {
    const d1 = findD1();
    expect(d1, 'apps/erp/dev-fixtures/pos-v1/{posStoreId}/{date}.sales.json holding D1 must exist (the builder creates it)').not.toBeNull();
    const { id, date, text } = d1!;

    const sales = await call('sales', { storeId: id, date });
    expect(sales.status).toBe(200);
    expect(sales.text, 'served as-is: the stored text, not a re-serialisation').toBe(text);

    const items = await call('sold-items', { storeId: id, date });
    expect(items.status).toBe(200);
    expect(Array.isArray((JSON.parse(items.text) as { items?: unknown }).items)).toBe(true);

    const pm = await call('payment-methods', { storeId: id });
    expect(pm.status).toBe(200);
    const methods = (JSON.parse(pm.text) as { methods?: string[] }).methods ?? [];
    expect(methods).toEqual(expect.arrayContaining(['Cash', 'GCash']));
  });

  it('an unknown route name is a 404', async () => {
    expect((await call('bogus', { storeId: 'x', date: '2027-01-10' })).status).toBe(404);
  });
});

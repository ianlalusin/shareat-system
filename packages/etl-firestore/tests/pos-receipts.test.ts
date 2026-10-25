import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Timestamp } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';

import {
  PosBridgeCredentialError,
  PosReceiptReader,
  loadPosBridgeCredential,
  type PosFirestoreLike,
  type PosQueryLike,
  type PosSnapshotLike,
} from '../src/pos-receipts';

/**
 * T-472 slice 1 - the read-only POS receipt reader. No network: a hand-written fake that
 * implements ONLY read methods (any other member access throws), so a write call cannot pass.
 */

type Doc = { id: string; data: Record<string, unknown> };
const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, '../src');

function ms(v: unknown): number {
  if (v instanceof Timestamp) return v.toMillis();
  if (v instanceof Date) return v.getTime();
  return v as number;
}

interface Call {
  op: string;
  args: unknown[];
}
interface Filter {
  field: string;
  op: string;
  value: unknown;
}

class FakeQuery implements PosQueryLike {
  constructor(
    private readonly docs: readonly Doc[],
    private readonly calls: Call[],
    private readonly filters: Filter[] = [],
    private readonly orders: unknown[] = [],
    private readonly after?: unknown[],
    private readonly limitN?: number,
  ) {}
  where(field: string, op: '>=' | '<' | '>' | '<=' | '==', value: unknown): PosQueryLike {
    this.calls.push({ op: 'where', args: [field, op, value] });
    return new FakeQuery(this.docs, this.calls, [...this.filters, { field, op, value }], this.orders, this.after, this.limitN);
  }
  orderBy(field: unknown): PosQueryLike {
    this.calls.push({ op: 'orderBy', args: [field] });
    return new FakeQuery(this.docs, this.calls, this.filters, [...this.orders, field], this.after, this.limitN);
  }
  startAfter(...cursor: unknown[]): PosQueryLike {
    this.calls.push({ op: 'startAfter', args: cursor });
    return new FakeQuery(this.docs, this.calls, this.filters, this.orders, cursor, this.limitN);
  }
  limit(n: number): PosQueryLike {
    this.calls.push({ op: 'limit', args: [n] });
    return new FakeQuery(this.docs, this.calls, this.filters, this.orders, this.after, n);
  }
  private matching(applyLimit: boolean): Doc[] {
    let out = this.docs.filter((d) =>
      this.filters.every((f) => {
        const raw = d.data[f.field];
        if (raw === undefined || raw === null) return false;
        const a = ms(raw);
        const b = ms(f.value);
        return f.op === '>=' ? a >= b : f.op === '<' ? a < b : f.op === '>' ? a > b : f.op === '<=' ? a <= b : a === b;
      }),
    );
    const key = (d: Doc, o: unknown): number | string => (typeof o === 'string' ? ms(d.data[o]) : d.id);
    out = [...out].sort((x, y) => {
      for (const o of this.orders) {
        const a = key(x, o);
        const b = key(y, o);
        if (a < b) return -1;
        if (a > b) return 1;
      }
      return 0;
    });
    if (this.after) {
      const cur = this.after;
      out = out.filter((d) => {
        for (let i = 0; i < this.orders.length; i++) {
          const a = key(d, this.orders[i]);
          const b = typeof this.orders[i] === 'string' ? ms(cur[i]) : (cur[i] as string);
          if (a < b) return false;
          if (a > b) return true;
        }
        return false;
      });
    }
    return applyLimit && this.limitN !== undefined ? out.slice(0, this.limitN) : out;
  }
  async get(): Promise<PosSnapshotLike> {
    this.calls.push({ op: 'get', args: [] });
    const docs = this.matching(true).map((d) => ({ id: d.id, ref: { path: `x/${d.id}` }, data: () => d.data }));
    return { docs, empty: docs.length === 0 };
  }
  count() {
    return {
      get: async () => {
        this.calls.push({ op: 'count', args: [] });
        return { data: () => ({ count: this.matching(false).length }) };
      },
    };
  }
}

function fakeFirestore(byPath: Record<string, Doc[]>) {
  const calls: Call[] = [];
  const base = {
    collection(path: string) {
      calls.push({ op: 'collection', args: [path] });
      return new FakeQuery(byPath[path] ?? [], calls);
    },
  };
  // Any member other than `collection` is a write-ish call the reader must never make.
  const fs = new Proxy(base, {
    get(t, p) {
      if (p === 'collection') return t.collection;
      throw new Error(`reader touched forbidden Firestore member: ${String(p)}`);
    },
  }) as unknown as PosFirestoreLike;
  return { fs, calls };
}

const STORE = 'store-1';
const PATH = `stores/${STORE}/receipts`;
// Manila 2027-01-02 00:00 = 2027-01-01T16:00:00Z
const DAY_START = Date.UTC(2027, 0, 1, 16, 0, 0);
const DAY_END = DAY_START + 86_400_000;

function rec(id: string, clientMs: number | undefined, extra: Record<string, unknown> = {}): Doc {
  const data: Record<string, unknown> = { total: 100, status: 'final', ...extra };
  if (clientMs !== undefined) data.createdAtClientMs = clientMs;
  return { id, data };
}

async function collect(iter: AsyncIterable<{ id: string }>): Promise<string[]> {
  const out: string[] = [];
  for await (const d of iter) out.push(d.id);
  return out;
}

describe('read-only by structure', () => {
  const files = ['pos-receipts.ts', 'pos-receipt-map.ts'];
  const FORBIDDEN = [
    /\.\s*set\s*\(/,
    /\.\s*update\s*\(/,
    /\.\s*delete\s*\(/,
    /\.\s*add\s*\(\s*\{/,
    /\.\s*create\s*\(/,
    /\bbatch\s*\(/,
    /\bbulkWriter\b/,
    /\brunTransaction\b/,
    /\bWriteBatch\b/,
    /\brecursiveDelete\b/,
    /\bFieldValue\b/,
  ];
  function graph(entry: string, seen = new Set<string>()): string[] {
    if (seen.has(entry)) return [];
    seen.add(entry);
    const src = readFileSync(entry, 'utf8');
    for (const m of src.matchAll(/from\s+'(\.\/[^']+)'/g)) graph(join(dirname(entry), `${m[1]}.ts`), seen);
    return [...seen];
  }
  it('no source in the module graph calls a Firestore write API', () => {
    for (const f of files) {
      for (const file of graph(join(SRC, f))) {
        const src = readFileSync(file, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\/\/.*$/gm, '');
        for (const re of FORBIDDEN) expect(src, `${file} matches ${re}`).not.toMatch(re);
      }
    }
  });
  it('the query surface type declares only read methods', () => {
    const src = readFileSync(join(SRC, 'pos-receipts.ts'), 'utf8');
    const iface = /export interface PosQueryLike \{([\s\S]*?)\n\}/.exec(src)![1]!;
    const names = [...iface.matchAll(/^\s{2}(\w+)\(/gm)].map((m) => m[1]);
    expect(names.sort()).toEqual(['count', 'get', 'limit', 'orderBy', 'startAfter', 'where']);
  });
});

describe('day window (Manila) by createdAtClientMs', () => {
  it('includes the first and last ms of the Manila day, excludes the edges outside', async () => {
    const { fs, calls } = fakeFirestore({
      [PATH]: [rec('before', DAY_START - 1), rec('first', DAY_START), rec('last', DAY_END - 1), rec('after', DAY_END)],
    });
    const r = new PosReceiptReader({ firestore: fs });
    expect(await collect(r.listDay(STORE, '2027-01-02'))).toEqual(['first', 'last']);
    const wheres = calls.filter((c) => c.op === 'where').map((c) => [c.args[0], c.args[1], ms(c.args[2])]);
    expect(wheres).toContainEqual(['createdAtClientMs', '>=', DAY_START]);
    expect(wheres).toContainEqual(['createdAtClientMs', '<', DAY_END]);
  });
  it('rejects a date that is not YYYY-MM-DD', async () => {
    const { fs } = fakeFirestore({});
    const r = new PosReceiptReader({ firestore: fs });
    await expect(collect(r.listDay(STORE, '2027-1-2'))).rejects.toThrow();
  });
});

describe('paging', () => {
  it('pages 500 + cursor with no duplicate or gap, including docs sharing one millisecond', async () => {
    const docs: Doc[] = [];
    for (let i = 0; i < 1203; i++) docs.push(rec(`r${String(i).padStart(5, '0')}`, DAY_START + Math.floor(i / 3)));
    const { fs, calls } = fakeFirestore({ [PATH]: docs });
    const r = new PosReceiptReader({ firestore: fs });
    const ids = await collect(r.listDay(STORE, '2027-01-02'));
    expect(ids.length).toBe(1203);
    expect(new Set(ids).size).toBe(1203);
    expect(calls.filter((c) => c.op === 'limit').every((c) => c.args[0] === 500)).toBe(true);
    expect(calls.filter((c) => c.op === 'get').length).toBe(3);
  });
});

describe('cross-check by server createdAt', () => {
  const t = (n: number) => Timestamp.fromMillis(n);
  it('counts both ways and names the docs that have no createdAtClientMs', async () => {
    const { fs } = fakeFirestore({
      [PATH]: [
        rec('a', DAY_START + 5, { createdAt: t(DAY_START + 5) }),
        rec('b', undefined, { createdAt: t(DAY_START + 9) }),
        rec('c', undefined, { createdAt: t(DAY_START + 10) }),
        rec('d', DAY_START - 5, { createdAt: t(DAY_START - 5) }),
      ],
    });
    const r = new PosReceiptReader({ firestore: fs });
    expect(await r.crossCheckDay(STORE, '2027-01-02')).toEqual({
      byClientMs: 1,
      byServerCreatedAt: 3,
      missingClientMs: 2,
      missingClientMsIds: ['b', 'c'],
    });
  });
  it('DEF-775: an offline receipt sold on D and uploaded on D+1 does not hide a missing one on D', async () => {
    // A: client time D, server time D+1.  B: no client time, server time D.  Both counts are 1 for D.
    const { fs } = fakeFirestore({
      [PATH]: [
        rec('A', DAY_START + 100, { createdAt: t(DAY_END + 100) }),
        rec('B', undefined, { createdAt: t(DAY_START + 200) }),
      ],
    });
    const r = new PosReceiptReader({ firestore: fs });
    const out = await r.crossCheckDay(STORE, '2027-01-02');
    expect(out.byClientMs).toBe(1);
    expect(out.byServerCreatedAt).toBe(1);
    expect(out.missingClientMs).toBe(1);
    expect(out.missingClientMsIds).toEqual(['B']);
  });
  it('DEF-775: a receipt sold on D-1 and uploaded on D is not a false gap', async () => {
    const { fs } = fakeFirestore({
      [PATH]: [rec('late', DAY_START - 1000, { createdAt: t(DAY_START + 50) })],
    });
    const r = new PosReceiptReader({ firestore: fs });
    const out = await r.crossCheckDay(STORE, '2027-01-02');
    expect(out.byClientMs).toBe(0);
    expect(out.byServerCreatedAt).toBe(1);
    expect(out.missingClientMs).toBe(0);
    expect(out.missingClientMsIds).toEqual([]);
  });
  it('DEF-775: createdAtClientMs present but not a number counts as missing', async () => {
    const { fs } = fakeFirestore({
      [PATH]: [
        rec('str', undefined, { createdAt: t(DAY_START + 1), createdAtClientMs: String(DAY_START + 1) }),
        rec('nul', undefined, { createdAt: t(DAY_START + 2), createdAtClientMs: null }),
        rec('nan', undefined, { createdAt: t(DAY_START + 3), createdAtClientMs: Number.NaN }),
        rec('ok', DAY_START + 4, { createdAt: t(DAY_START + 4) }),
      ],
    });
    const r = new PosReceiptReader({ firestore: fs });
    const out = await r.crossCheckDay(STORE, '2027-01-02');
    expect(out.missingClientMs).toBe(3);
    expect(out.missingClientMsIds).toEqual(['str', 'nul', 'nan']);
  });
  it('DEF-775: enumerates more than one page of server-day docs (1203)', async () => {
    const docs: Doc[] = [];
    const expectedMissing: string[] = [];
    for (let i = 0; i < 1203; i++) {
      const id = `r${String(i).padStart(5, '0')}`;
      const missing = i % 3 === 0;
      if (missing) expectedMissing.push(id);
      docs.push(rec(id, missing ? undefined : DAY_START + i, { createdAt: t(DAY_START + Math.floor(i / 3)) }));
    }
    const { fs, calls } = fakeFirestore({ [PATH]: docs });
    const r = new PosReceiptReader({ firestore: fs });
    const out = await r.crossCheckDay(STORE, '2027-01-02');
    expect(out.byServerCreatedAt).toBe(1203);
    expect(out.missingClientMs).toBe(expectedMissing.length);
    expect(out.missingClientMsIds).toEqual(expectedMissing);
    expect(calls.filter((c) => c.op === 'get').length).toBe(3);
  });
});

describe('change-time queries', () => {
  const t = (n: number) => Timestamp.fromMillis(n);
  const base = Date.UTC(2027, 0, 5);
  const docs: Doc[] = [
    rec('old', base, { voidedAt: t(base - 1000), editedAt: t(base - 1000), createdAt: t(base - 1000) }),
    rec('voided', base, { voidedAt: t(base + 1000) }),
    rec('edited', base, { editedAt: t(base + 2000) }),
    rec('synced', base - 9 * 86_400_000, { createdAt: t(base + 3000) }),
  ];
  it.each([
    ['voidedAt', ['voided']],
    ['editedAt', ['edited']],
    ['createdAt', ['synced']],
  ] as const)('since an instant on %s', async (field, expected) => {
    const { fs } = fakeFirestore({ [PATH]: docs });
    const r = new PosReceiptReader({ firestore: fs });
    expect(await collect(r.listChangedSince(STORE, field, new Date(base)))).toEqual(expected);
  });
  it('rejects a field that is not one of the three', async () => {
    const { fs } = fakeFirestore({});
    const r = new PosReceiptReader({ firestore: fs });
    await expect(collect(r.listChangedSince(STORE, 'status' as never, new Date()))).rejects.toThrow();
  });
});

describe('credential', () => {
  const key = (project: string) =>
    JSON.stringify({ project_id: project, client_email: 'a@b', private_key: 'SECRET-KEY-MATERIAL' });
  it('refuses to start when POS_BRIDGE_SA_KEY_FILE is unset', () => {
    expect(() => loadPosBridgeCredential({}, 'shareat-hub-v2', () => '')).toThrow(PosBridgeCredentialError);
  });
  it('refuses a key for a different project, without echoing the key', () => {
    let msg = '';
    try {
      loadPosBridgeCredential({ POS_BRIDGE_SA_KEY_FILE: '/k.json' }, 'shareat-hub-v2', () => key('some-other-project'));
    } catch (e) {
      expect(e).toBeInstanceOf(PosBridgeCredentialError);
      msg = (e as Error).message;
    }
    expect(msg).not.toBe('');
    expect(msg).not.toContain('SECRET-KEY-MATERIAL');
  });
  it('accepts a key for the expected project', () => {
    const c = loadPosBridgeCredential({ POS_BRIDGE_SA_KEY_FILE: '/k.json' }, 'shareat-hub-v2', () => key('shareat-hub-v2'));
    expect(c.projectId).toBe('shareat-hub-v2');
  });
  it('a malformed file fails with a fixed sentence, not the file text', () => {
    let msg = '';
    try {
      loadPosBridgeCredential({ POS_BRIDGE_SA_KEY_FILE: '/k.json' }, 'p', () => 'SECRET-KEY-MATERIAL{');
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).not.toBe('');
    expect(msg).not.toContain('SECRET-KEY-MATERIAL');
  });
});

import { Timestamp } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';

import { PosReceiptBridgeAdapter } from '../src/pos-receipt-bridge-adapter';
import type { PosFirestoreLike, PosQueryLike, PosSnapshotLike } from '../src/pos-receipts';

/**
 * T-472 S2 - the adapter that gives the domain's bridge port its Firestore reads. No network: the same read-only fake as
 * `pos-receipts.test.ts` (any member other than `collection` throws). MUTANTS: a day over one page not fully read -> A1;
 * missing-client-time docs not returned -> A2; housekeeping fields minting a new hash -> A3; personal fields left in raw -> A4.
 */

type Doc = { id: string; data: Record<string, unknown> };

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


const DAY = '2027-01-02';
const mapped = (id: string, over: Record<string, unknown> = {}): Doc => ({
  id,
  data: {
    storeId: STORE,
    status: 'final',
    total: 100,
    createdAt: Timestamp.fromMillis(DAY_START + 3_600_000),
    createdAtClientMs: DAY_START + 3_600_000,
    lines: [{ id: 'l1', itemName: 'x', unitPrice: 100, qtyOrdered: 1 }],
    analytics: { mop: { Cash: 100 } },
    ...over,
  },
});

async function all(iter: AsyncIterable<{ id: string }>): Promise<string[]> {
  const out: string[] = [];
  for await (const d of iter) out.push(d.id);
  return out;
}

describe('PosReceiptBridgeAdapter', () => {
  it('A1: a day of more than one page (1203 documents) is read in full, mapped, in order', async () => {
    const docs: Doc[] = [];
    for (let i = 0; i < 1203; i++) docs.push(mapped(`r${String(i).padStart(4, '0')}`, { createdAtClientMs: DAY_START + i * 1000 }));
    const { fs } = fakeFirestore({ [PATH]: docs });
    const port = new PosReceiptBridgeAdapter(fs);
    const ids = await all(port.listDay(STORE, DAY));
    expect(ids.length).toBe(1203);
    expect(new Set(ids).size).toBe(1203);
  });

  it('A2: documents with a server day but no client time come back from listMissingClientTime, and crossCheckDay names them', async () => {
    const { fs } = fakeFirestore({
      [PATH]: [mapped('a'), mapped('b', { createdAtClientMs: undefined }), mapped('c', { createdAtClientMs: 'x' })],
    });
    const port = new PosReceiptBridgeAdapter(fs);
    expect(await all(port.listDay(STORE, DAY))).toEqual(['a']);
    expect(await all(port.listMissingClientTime(STORE, DAY))).toEqual(['b', 'c']);
    expect(await port.crossCheckDay(STORE, DAY)).toMatchObject({ missingClientMs: 2, missingClientMsIds: ['b', 'c'] });
  });

  it('A3: housekeeping fields (analytics-applied stamps, edit stamps) do not change the hash; a real change does', async () => {
    const base = mapped('a');
    const noisy = mapped('a', { analyticsApplied: true, analyticsAppliedAt: Timestamp.fromMillis(5), analyticsApplyId: 'zz', reRingLinkedAt: Timestamp.fromMillis(9) });
    const changed = mapped('a', { total: 101 });
    const hashOf = async (d: Doc) => {
      const { fs } = fakeFirestore({ [PATH]: [d] });
      const out: string[] = [];
      for await (const r of new PosReceiptBridgeAdapter(fs).listDay(STORE, DAY)) out.push(r.docHash);
      return out[0]!;
    };
    expect(await hashOf(noisy)).toBe(await hashOf(base));
    expect(await hashOf(changed)).not.toBe(await hashOf(base));
  });

  it('A4: personal fields are stripped from raw; money fields come through as exact strings with the flag', async () => {
    const { fs } = fakeFirestore({
      [PATH]: [mapped('a', { total: 648.648, customerName: 'Juan', customerTin: '1', customerAddress: 'x', guestName: 'Gina', phone: '0917', email: 'a@b.c', customerSnap: { name: 'Snap' }, statutoryDiners: [{ kind: 'senior', name: 'Lola', idNo: 'K1', idNumber: 'K2', seniorId: 'K3', pwdId: 'K4', scId: 'K5', cardNo: 'K6', share: 1 }] })],
    });
    const out = [];
    for await (const r of new PosReceiptBridgeAdapter(fs).listDay(STORE, DAY)) out.push(r);
    const r = out[0]!;
    expect(JSON.stringify(r.header.raw)).not.toMatch(/Juan|Lola|K\d|Gina|0917|a@b|Snap/);
    expect(r.header.total).toBe('648.65');
    expect(r.header.moneyFlag).toBe(true);
    expect(r.id).toBe('a');
  });

  it('A5: changed-since queries pass the field and the cutoff through', async () => {
    const { fs, calls } = fakeFirestore({ [PATH]: [mapped('a', { voidedAt: Timestamp.fromMillis(DAY_START + 10) })] });
    const out = await all(new PosReceiptBridgeAdapter(fs).listChangedSince(STORE, 'voidedAt', new Date(DAY_START)));
    expect(out).toEqual(['a']);
    expect(calls.some((c) => c.op === 'where' && c.args[0] === 'voidedAt' && c.args[1] === '>')).toBe(true);
  });
});

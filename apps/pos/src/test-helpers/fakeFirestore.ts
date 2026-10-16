/**
 * T-423 slice T - an in-memory stand-in for the parts of `firebase/firestore` the POS payment, void and
 * terminal-claim code uses. No network, no emulator. It is faithful where a fake could hide a live failure:
 *  - a query that would need a COMPOSITE INDEX that was not declared THROWS (Acceptance 12). Rule used: let F be
 *    the fields that carry a range filter or an orderBy (the document id `__name__` does not count); more than one
 *    distinct field in F needs a composite index, and so does one field in F combined with an equality/`in` filter
 *    on a different field. Declare an index with `fake.declareIndex(['a', 'b'])`.
 *  - a Transaction has get / set / update / delete only (the web SDK has NO `create`), and a `get` after a write
 *    throws, as the real SDK does. Reads are version-checked at commit and the callback re-runs on contention.
 *  - `update` of a document that does not exist fails the whole transaction or batch.
 * Test hooks (all one-shot): `retryNextTransaction()` (forces the callback to run twice, as contention would),
 * `beforeNextTransaction(fn)` (mutate state after a caller's pre-read but before the transaction), `onCommit(fn)`
 * (runs just before a transaction/batch applies; throw to make the commit fail), `failNextCommit(err)`.
 */

export class FakeTimestamp {
  constructor(public seconds: number, public nanoseconds = 0) {}
  static now() { return FakeTimestamp.fromMillis(Date.now()); }
  static fromMillis(ms: number) { return new FakeTimestamp(Math.floor(ms / 1000), (ms % 1000) * 1e6); }
  toMillis() { return this.seconds * 1000 + Math.floor(this.nanoseconds / 1e6); }
  toDate() { return new Date(this.toMillis()); }
}

type Sentinel =
  | { __s: 'serverTimestamp' }
  | { __s: 'deleteField' }
  | { __s: 'increment'; n: number }
  | { __s: 'arrayUnion'; v: unknown[] }
  | { __s: 'arrayRemove'; v: unknown[] };
const isSentinel = (v: any): v is Sentinel => !!v && typeof v === 'object' && typeof v.__s === 'string';
const DOC_ID = { __docId: true } as const;
const isDocId = (v: any) => v === DOC_ID;

export interface DocRef { __kind: 'doc'; path: string; id: string; parentPath: string; firestore: FakeFirestore }
export interface CollRef { __kind: 'collection'; path: string; id: string; firestore: FakeFirestore }
interface Constraint { type: 'where' | 'orderBy' | 'limit'; field?: any; op?: string; value?: any; dir?: 'asc' | 'desc'; n?: number }
export interface QueryRef { __kind: 'query'; coll: CollRef; constraints: Constraint[]; firestore: FakeFirestore }

export class DocSnap {
  constructor(readonly ref: DocRef, private d: any | undefined) {}
  get id() { return this.ref.id; }
  exists() { return this.d !== undefined; }
  data() { return this.d === undefined ? undefined : structuredCloneDeep(this.d); }
  get(field: string) { return getPath(this.d, field); }
}
export class QuerySnap {
  constructor(readonly docs: DocSnap[]) {}
  get size() { return this.docs.length; }
  get empty() { return this.docs.length === 0; }
  forEach(fn: (d: DocSnap) => void) { this.docs.forEach(fn); }
}

function structuredCloneDeep<T>(v: T): T {
  if (v === null || typeof v !== 'object') return v;
  if (v instanceof FakeTimestamp) return new FakeTimestamp(v.seconds, v.nanoseconds) as any;
  if (Array.isArray(v)) return v.map(structuredCloneDeep) as any;
  const o: any = {};
  for (const [kk, vv] of Object.entries(v)) o[kk] = structuredCloneDeep(vv);
  return o;
}
function getPath(obj: any, path: string): any {
  let cur = obj;
  for (const p of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}
function setPath(obj: any, path: string, value: any) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]!;
    if (cur[p] === null || typeof cur[p] !== 'object') cur[p] = {};
    cur = cur[p];
  }
  const last = parts[parts.length - 1]!;
  if (value === undefined) delete cur[last]; else cur[last] = value;
}

let autoId = 0;
const nowTs = () => FakeTimestamp.now();

function resolveValue(existing: any, v: any): any {
  if (isSentinel(v)) {
    switch (v.__s) {
      case 'serverTimestamp': return nowTs();
      case 'deleteField': return undefined;
      case 'increment': return (typeof existing === 'number' ? existing : 0) + v.n;
      case 'arrayUnion': {
        const a = Array.isArray(existing) ? [...existing] : [];
        for (const x of v.v) if (!a.some((y) => JSON.stringify(y) === JSON.stringify(x))) a.push(x);
        return a;
      }
      case 'arrayRemove':
        return (Array.isArray(existing) ? existing : []).filter((y) => !v.v.some((x) => JSON.stringify(x) === JSON.stringify(y)));
    }
  }
  if (v === null || typeof v !== 'object' || v instanceof FakeTimestamp || v instanceof Date) return v;
  if (Array.isArray(v)) return v.map((x) => resolveValue(undefined, x)).filter((x) => x !== undefined);
  const o: any = {};
  for (const [kk, vv] of Object.entries(v)) {
    const r = resolveValue(existing?.[kk], vv);
    if (r !== undefined) o[kk] = r;
  }
  return o;
}
function applySet(existing: any | undefined, data: any, merge: boolean): any {
  const resolved = resolveValue(merge ? existing : undefined, data);
  return merge ? { ...(existing ?? {}), ...resolved } : resolved;
}
/** Admin-SDK `set(data, {merge:true})`: maps merge RECURSIVELY (the web fake above merges one level). T-424 slice T. */
function deepApply(existing: any, data: any): any {
  const plain = (x: any) => x !== null && typeof x === 'object' && !Array.isArray(x) && !(x instanceof FakeTimestamp) && !(x instanceof Date) && !isSentinel(x);
  if (!plain(data)) return resolveValue(existing, data);
  const base: any = plain(existing) ? structuredCloneDeep(existing) : {};
  for (const [k, v] of Object.entries(data)) {
    const r = deepApply(base[k], v);
    if (r === undefined) delete base[k]; else base[k] = r;
  }
  return base;
}
function applyUpdate(existing: any, data: Record<string, any>): any {
  const out = structuredCloneDeep(existing);
  for (const [path, v] of Object.entries(data)) {
    const cur = getPath(out, path);
    setPath(out, path, resolveValue(cur, v));
  }
  return out;
}

type Write =
  | { op: 'set'; path: string; data: any; merge: boolean; deep?: boolean }
  | { op: 'create'; path: string; data: any }
  | { op: 'update'; path: string; data: Record<string, any> }
  | { op: 'delete'; path: string };
export interface CommitRecord { kind: 'transaction' | 'batch'; writes: Write[]; attempts: number }

export class FakeFirestore {
  docs = new Map<string, any>();
  versions = new Map<string, number>();
  commits: CommitRecord[] = [];
  private indexes: string[][] = [];
  private retries = 0;
  private beforeTx: (() => void) | null = null;
  private commitHooks: ((rec: CommitRecord) => void)[] = [];
  private commitFailure: Error | null = null;
  readonly db: any = { __fake: true };

  // ---- seeding / inspection -------------------------------------------------------------------
  seed(path: string, data: any) { this.docs.set(path, structuredCloneDeep(data)); this.bump(path); }
  get(path: string) { const d = this.docs.get(path); return d === undefined ? undefined : structuredCloneDeep(d); }
  has(path: string) { return this.docs.has(path); }
  list(collectionPath: string) {
    return [...this.docs.keys()].filter((p) => parentOf(p) === collectionPath).map((p) => ({ id: idOf(p), data: this.get(p) }));
  }
  declareIndex(fields: string[]) { this.indexes.push(fields); }
  private bump(path: string) { this.versions.set(path, (this.versions.get(path) ?? 0) + 1); }

  // ---- hooks ----------------------------------------------------------------------------------
  retryNextTransaction(times = 1) { this.retries += times; }
  beforeNextTransaction(fn: () => void) { this.beforeTx = fn; }
  onCommit(fn: (rec: CommitRecord) => void) { this.commitHooks.push(fn); }
  failNextCommit(err: Error = new Error('injected commit failure')) { this.commitFailure = err; }
  consumeBeforeTx() { const f = this.beforeTx; this.beforeTx = null; f?.(); }
  consumeRetry() { if (this.retries > 0) { this.retries--; return true; } return false; }

  // ---- refs -----------------------------------------------------------------------------------
  private segs(parts: string[]): string[] { return parts.flatMap((p) => p.split('/')).filter(Boolean); }
  collection = (parent: any, ...rest: string[]): CollRef => {
    const base = parent?.__kind === 'doc' ? parent.path : parent?.__kind === 'collection' ? parent.path : '';
    const path = [base, ...this.segs(rest)].filter(Boolean).join('/');
    return { __kind: 'collection', path, id: idOf(path), firestore: this };
  };
  doc = (parent: any, ...rest: string[]): DocRef => {
    let path: string;
    if (parent?.__kind === 'collection' && rest.length === 0) path = `${parent.path}/auto${++autoId}`;
    else {
      const base = parent?.__kind === 'doc' || parent?.__kind === 'collection' ? parent.path : '';
      path = [base, ...this.segs(rest)].filter(Boolean).join('/');
    }
    return { __kind: 'doc', path, id: idOf(path), parentPath: parentOf(path), firestore: this };
  };
  documentId = () => DOC_ID;
  where = (field: any, op: string, value: any): Constraint => ({ type: 'where', field, op, value });
  orderBy = (field: any, dir: 'asc' | 'desc' = 'asc'): Constraint => ({ type: 'orderBy', field, dir });
  limit = (n: number): Constraint => ({ type: 'limit', n });
  query = (coll: CollRef, ...constraints: Constraint[]): QueryRef => ({ __kind: 'query', coll, constraints, firestore: this });
  serverTimestamp = (): Sentinel => ({ __s: 'serverTimestamp' });
  deleteField = (): Sentinel => ({ __s: 'deleteField' });
  increment = (n: number): Sentinel => ({ __s: 'increment', n });
  arrayUnion = (...v: unknown[]): Sentinel => ({ __s: 'arrayUnion', v });
  arrayRemove = (...v: unknown[]): Sentinel => ({ __s: 'arrayRemove', v });

  // ---- reads ----------------------------------------------------------------------------------
  getDoc = async (ref: DocRef) => new DocSnap(ref, this.docs.get(ref.path));
  getDocs = async (q: QueryRef | CollRef) => {
    const query: QueryRef = q.__kind === 'query' ? q : { __kind: 'query', coll: q, constraints: [], firestore: this };
    this.assertIndexed(query);
    return new QuerySnap(this.runQuery(query));
  };

  private fieldKey(f: any): string { return isDocId(f) ? '__name__' : String(f); }
  assertIndexed(q: QueryRef) {
    const range = new Set<string>();
    const equality = new Set<string>();
    for (const c of q.constraints) {
      if (c.type === 'where') {
        const f = this.fieldKey(c.field);
        if (f === '__name__') continue;
        if (['<', '<=', '>', '>=', '!=', 'not-in'].includes(c.op!)) range.add(f);
        else equality.add(f);
      } else if (c.type === 'orderBy') {
        const f = this.fieldKey(c.field);
        if (f !== '__name__') range.add(f);
      }
    }
    const rangeFields = [...range];
    const otherEq = [...equality].filter((f) => !range.has(f));
    const needs = rangeFields.length > 1 || (rangeFields.length === 1 && otherEq.length > 0);
    if (!needs) return;
    const wanted = new Set([...rangeFields, ...equality]);
    const declared = this.indexes.some((ix) => ix.length === wanted.size && ix.every((f) => wanted.has(f)));
    if (!declared) {
      throw new Error(
        `FAILED_PRECONDITION: The query requires an index (composite) on [${[...wanted].join(', ')}] for ${q.coll.path}, which was not declared.`,
      );
    }
  }

  private cmp(a: any, b: any): number {
    const av = a instanceof FakeTimestamp ? a.toMillis() : a;
    const bv = b instanceof FakeTimestamp ? b.toMillis() : b;
    return av < bv ? -1 : av > bv ? 1 : 0;
  }
  private runQuery(q: QueryRef): DocSnap[] {
    let rows = [...this.docs.entries()]
      .filter(([p]) => parentOf(p) === q.coll.path)
      .map(([p, d]) => ({ id: idOf(p), ref: this.doc(this.db, p), d }));
    const valueOf = (r: { id: string; d: any }, f: any) => (isDocId(f) ? r.id : getPath(r.d, String(f)));
    for (const c of q.constraints) {
      if (c.type !== 'where') continue;
      rows = rows.filter((r) => {
        const v = valueOf(r, c.field);
        if (v === undefined) return false;
        switch (c.op) {
          case '==': return this.cmp(v, c.value) === 0;
          case '!=': return this.cmp(v, c.value) !== 0;
          case '<': return this.cmp(v, c.value) < 0;
          case '<=': return this.cmp(v, c.value) <= 0;
          case '>': return this.cmp(v, c.value) > 0;
          case '>=': return this.cmp(v, c.value) >= 0;
          case 'in': return (c.value as any[]).some((x) => this.cmp(v, x) === 0);
          case 'not-in': return !(c.value as any[]).some((x) => this.cmp(v, x) === 0);
          case 'array-contains': return Array.isArray(v) && v.some((x) => this.cmp(x, c.value) === 0);
          default: throw new Error(`fake firestore: operator ${c.op} not supported`);
        }
      });
    }
    const orders = q.constraints.filter((c) => c.type === 'orderBy');
    for (const o of orders) rows = rows.filter((r) => valueOf(r, o.field) !== undefined);
    rows.sort((a, b) => {
      for (const o of orders) {
        const c = this.cmp(valueOf(a, o.field), valueOf(b, o.field));
        if (c !== 0) return o.dir === 'desc' ? -c : c;
      }
      return this.cmp(a.id, b.id);
    });
    const lim = q.constraints.find((c) => c.type === 'limit');
    if (lim) rows = rows.slice(0, lim.n);
    return rows.map((r) => new DocSnap(r.ref, r.d));
  }

  // ---- writes ---------------------------------------------------------------------------------
  setDoc = async (ref: DocRef, data: any, opts?: { merge?: boolean }) => this.commit('batch', [{ op: 'set', path: ref.path, data, merge: !!opts?.merge }], 1);
  updateDoc = async (ref: DocRef, data: any) => this.commit('batch', [{ op: 'update', path: ref.path, data }], 1);
  deleteDoc = async (ref: DocRef) => this.commit('batch', [{ op: 'delete', path: ref.path }], 1);

  writeBatch = (_db?: unknown) => {
    const writes: Write[] = [];
    const b = {
      set: (ref: DocRef, data: any, opts?: { merge?: boolean }) => { writes.push({ op: 'set', path: ref.path, data, merge: !!opts?.merge }); return b; },
      update: (ref: DocRef, data: any) => { writes.push({ op: 'update', path: ref.path, data }); return b; },
      delete: (ref: DocRef) => { writes.push({ op: 'delete', path: ref.path }); return b; },
      commit: async () => this.commit('batch', writes, 1),
    };
    return b;
  };

  /** Applies all writes or none. */
  commit(kind: 'transaction' | 'batch', writes: Write[], attempts: number) {
    const rec: CommitRecord = { kind, writes: structuredCloneDeep(writes), attempts };
    if (this.commitFailure) { const e = this.commitFailure; this.commitFailure = null; throw e; }
    for (const h of this.commitHooks.splice(0)) h(rec);
    const next = new Map(this.docs);
    for (const w of writes) {
      if (w.op === 'create') {
        if (next.has(w.path)) throw new Error(`ALREADY_EXISTS: Document already exists: ${w.path}`);
        next.set(w.path, applySet(undefined, w.data, false));
      } else if (w.op === 'set' && w.deep && w.merge) next.set(w.path, deepApply(next.get(w.path), w.data));
      else if (w.op === 'set') next.set(w.path, applySet(next.get(w.path), w.data, w.merge));
      else if (w.op === 'update') {
        const cur = next.get(w.path);
        if (cur === undefined) throw new Error(`NOT_FOUND: No document to update: ${w.path}`);
        next.set(w.path, applyUpdate(cur, w.data));
      } else next.delete(w.path);
    }
    for (const w of writes) this.bump(w.path);
    this.docs = next;
    this.commits.push(rec);
  }

  runTransaction = async <T>(_db: unknown, fn: (tx: any) => Promise<T>): Promise<T> => {
    this.consumeBeforeTx();
    for (let attempt = 1; attempt <= 5; attempt++) {
      const readVersions = new Map<string, number>();
      const writes: Write[] = [];
      const tx = {
        get: async (ref: DocRef) => {
          if (writes.length) throw new Error('Firestore transactions require all reads to be executed before all writes.');
          readVersions.set(ref.path, this.versions.get(ref.path) ?? 0);
          return new DocSnap(ref, this.docs.get(ref.path));
        },
        set: (ref: DocRef, data: any, opts?: { merge?: boolean }) => { writes.push({ op: 'set', path: ref.path, data, merge: !!opts?.merge }); return tx; },
        update: (ref: DocRef, data: any) => { writes.push({ op: 'update', path: ref.path, data }); return tx; },
        delete: (ref: DocRef) => { writes.push({ op: 'delete', path: ref.path }); return tx; },
      };
      const result = await fn(tx);
      if (this.consumeRetry()) continue; // simulated contention: discard this attempt, run the callback again
      let stale = false;
      for (const [p, v] of readVersions) if ((this.versions.get(p) ?? 0) !== v) stale = true;
      if (stale) continue;
      this.commit('transaction', writes, attempt);
      return result;
    }
    throw new Error('ABORTED: too much contention');
  };

  /**
   * T-424 slice T - the firebase-ADMIN shaped view of the same in-memory store (what the POS v2 server's injected Firestore port is):
   * `doc(path)`, `collection(path)` with chainable `where/orderBy/limit` and `get()`, `runTransaction(fn)` whose `tx.get` takes a doc OR a
   * query, `tx.create` (ALREADY_EXISTS on a second create, also across attempts), `tx.set(ref, data, {merge:true})` that merges maps
   * RECURSIVELY, `snap.exists` as a PROPERTY, and `FieldValue` / `FieldPath`. Same composite-index refusal and the same read-before-write
   * rule as the web view. The hooks (`retryNextTransaction`, `beforeNextTransaction`, `onCommit`, `failNextCommit`) apply to both views.
   */
  get admin() {
    const self = this;
    const wrapSnap = (s: DocSnap) => ({
      id: s.id, ref: s.ref, exists: s.exists(), data: () => s.data(), get: (f: string) => s.get(f),
    });
    const wrapQs = (qs: QuerySnap) => {
      const docs = qs.docs.map(wrapSnap);
      return { docs, size: qs.size, empty: qs.empty, forEach: (fn: (d: any) => void) => docs.forEach(fn) };
    };
    const mkQuery = (coll: CollRef, constraints: Constraint[]): any => ({
      __kind: 'query', coll, constraints, firestore: self,
      where: (f: any, op: string, v: any) => mkQuery(coll, [...constraints, self.where(f, op, v)]),
      orderBy: (f: any, d?: 'asc' | 'desc') => mkQuery(coll, [...constraints, self.orderBy(f, d)]),
      limit: (n: number) => mkQuery(coll, [...constraints, self.limit(n)]),
      get: async () => wrapQs(await self.getDocs({ __kind: 'query', coll, constraints, firestore: self } as QueryRef)),
    });
    const mkDoc = (path: string): any => {
      const ref = self.doc(self.db, path);
      return Object.assign(ref, {
        get: async () => wrapSnap(await self.getDoc(ref)),
        collection: (name: string) => mkColl(`${path}/${name}`),
      });
    };
    const mkColl = (path: string): any => {
      const coll = self.collection(self.db, path);
      return Object.assign(coll, {
        doc: (id?: string) => mkDoc(id ? `${path}/${id}` : `${path}/auto${++autoId}`),
        where: (f: any, op: string, v: any) => mkQuery(coll, [self.where(f, op, v)]),
        orderBy: (f: any, d?: 'asc' | 'desc') => mkQuery(coll, [self.orderBy(f, d)]),
        limit: (n: number) => mkQuery(coll, [self.limit(n)]),
        get: async () => mkQuery(coll, []).get(),
      });
    };
    const runTransaction = async <T>(fn: (tx: any) => Promise<T>): Promise<T> => {
      self.consumeBeforeTx();
      for (let attempt = 1; attempt <= 5; attempt++) {
        const readVersions = new Map<string, number>();
        const queryReads: { q: QueryRef; size: number }[] = [];
        const writes: Write[] = [];
        const created = new Set<string>();
        const tx = {
          get: async (target: any) => {
            if (writes.length) throw new Error('Firestore transactions require all reads to be executed before all writes.');
            if (target.__kind === 'query') {
              const q = { __kind: 'query', coll: target.coll, constraints: target.constraints, firestore: self } as QueryRef;
              const qs = await self.getDocs(q);
              for (const d of qs.docs) readVersions.set(d.ref.path, self.versions.get(d.ref.path) ?? 0);
              queryReads.push({ q, size: qs.size }); // a NEW matching document also makes this read stale
              return wrapQs(qs);
            }
            readVersions.set(target.path, self.versions.get(target.path) ?? 0);
            return wrapSnap(new DocSnap(target, self.docs.get(target.path)));
          },
          create: (ref: DocRef, data: any) => {
            if (self.docs.has(ref.path) || created.has(ref.path)) throw new Error(`ALREADY_EXISTS: Document already exists: ${ref.path}`);
            created.add(ref.path);
            writes.push({ op: 'create', path: ref.path, data });
            return tx;
          },
          set: (ref: DocRef, data: any, opts?: { merge?: boolean }) => { writes.push({ op: 'set', path: ref.path, data, merge: !!opts?.merge, deep: true }); return tx; },
          update: (ref: DocRef, data: any) => { writes.push({ op: 'update', path: ref.path, data }); return tx; },
          delete: (ref: DocRef) => { writes.push({ op: 'delete', path: ref.path }); return tx; },
        };
        const result = await fn(tx);
        if (self.consumeRetry()) continue;
        let stale = false;
        for (const [p, v] of readVersions) if ((self.versions.get(p) ?? 0) !== v) stale = true;
        for (const r of queryReads) if ((await self.getDocs(r.q)).size !== r.size) stale = true;
        if (stale) continue;
        self.commit('transaction', writes, attempt);
        return result;
      }
      throw new Error('ABORTED: too much contention');
    };
    return {
      doc: (path: string) => mkDoc(path),
      collection: (path: string) => mkColl(path),
      runTransaction,
      FieldValue: {
        serverTimestamp: () => self.serverTimestamp(), increment: (n: number) => self.increment(n), delete: () => self.deleteField(),
        arrayUnion: (...v: unknown[]) => self.arrayUnion(...v), arrayRemove: (...v: unknown[]) => self.arrayRemove(...v),
      },
      FieldPath: { documentId: () => self.documentId() },
    };
  }


  /** What a caller of the claim code receives: the subset of the modular API plus `db`. */
  get port() {
    return {
      db: this.db, doc: this.doc, collection: this.collection, getDoc: this.getDoc, getDocs: this.getDocs,
      query: this.query, where: this.where, orderBy: this.orderBy, limit: this.limit, documentId: this.documentId,
      runTransaction: this.runTransaction, serverTimestamp: this.serverTimestamp,
    };
  }
}

function idOf(path: string) { return path.slice(path.lastIndexOf('/') + 1); }
function parentOf(path: string) { return path.slice(0, Math.max(0, path.lastIndexOf('/'))); }

export const createFakeFirestore = () => new FakeFirestore();

// ---------------------------------------------------------------------------------------------
// vi.mock('firebase/firestore') support: functions that delegate to whichever fake is active.
// ---------------------------------------------------------------------------------------------
let active: FakeFirestore = new FakeFirestore();
export const setActiveFake = (f: FakeFirestore) => { active = f; };
export const getActiveFake = () => active;

/** The module object to return from a `vi.mock('firebase/firestore', ...)` factory. */
export function firebaseFirestoreModule() {
  const d = <K extends keyof FakeFirestore>(name: K) => (...args: any[]) => (active[name] as any)(...args);
  return {
    collection: d('collection'), doc: d('doc'), getDoc: d('getDoc'), getDocs: d('getDocs'), setDoc: d('setDoc'),
    updateDoc: d('updateDoc'), deleteDoc: d('deleteDoc'), query: d('query'), where: d('where'), orderBy: d('orderBy'),
    limit: d('limit'), documentId: d('documentId'), serverTimestamp: d('serverTimestamp'), deleteField: d('deleteField'),
    increment: d('increment'), arrayUnion: d('arrayUnion'), arrayRemove: d('arrayRemove'), writeBatch: d('writeBatch'),
    runTransaction: d('runTransaction'), Timestamp: FakeTimestamp,
  };
}

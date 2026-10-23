/**
 * T-423 slice T - a tiny in-memory IndexedDB for tests (fake-indexeddb is NOT in the lockfile, and the
 * task forbids new dependencies). It is deliberately strict where the real thing is strict:
 *  - requests complete asynchronously, in order, on a macrotask;
 *  - a transaction auto-commits only after its request queue has been idle for `commitDelayMs`, and its writes
 *    become visible to OTHER transactions only at the `complete` event (so code that resolves on
 *    `request.onsuccess` instead of `tx.oncomplete` is observable: see `rows()` right after the await);
 *  - readwrite transactions are serialised (a second readwrite waits for the first to finish);
 *  - an aborted transaction applies nothing.
 * Supported surface (the builder may rely on exactly this): indexedDB.open / deleteDatabase; db.createObjectStore
 * (keyPath, optional autoIncrement), db.transaction(names, mode), db.close, db.objectStoreNames.contains;
 * store.get / put / add / delete / clear / getAll / count; request.onsuccess / onerror / addEventListener;
 * tx.oncomplete / onerror / onabort / abort / addEventListener. No cursors, no indexes.
 *
 * Test hooks: `rows(store)` (committed rows only), `failNextTransaction()`, `commitCount()`.
 */

type Listener = (ev: any) => void;

class Evt {
  defaultPrevented = false;
  constructor(public type: string, public target: any, extra: object = {}) {
    Object.assign(this, extra);
  }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { /* no bubbling here */ }
}

class Target {
  private listeners = new Map<string, Listener[]>();
  addEventListener(type: string, l: Listener) {
    const a = this.listeners.get(type) ?? [];
    a.push(l);
    this.listeners.set(type, a);
  }
  removeEventListener(type: string, l: Listener) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((x) => x !== l));
  }
  protected dispatch(type: string, extra: object = {}): Evt {
    const ev = new Evt(type, this, extra);
    const h = (this as any)['on' + type] as Listener | null | undefined;
    if (typeof h === 'function') h.call(this, ev);
    for (const l of this.listeners.get(type) ?? []) l.call(this, ev);
    return ev;
  }
}

class Req extends Target {
  result: any = undefined;
  error: Error | null = null;
  readyState: 'pending' | 'done' = 'pending';
  transaction: Tx | null = null;
  onsuccess: Listener | null = null;
  onerror: Listener | null = null;
  onupgradeneeded: Listener | null = null;
  onblocked: Listener | null = null;
  succeed(result: any) {
    this.result = result;
    this.readyState = 'done';
    this.dispatch('success');
  }
  fail(error: Error): boolean {
    this.error = error;
    this.readyState = 'done';
    return !this.dispatch('error').defaultPrevented; // true => the transaction must abort
  }
  upgrade(extra: object = {}) { this.dispatch('upgradeneeded', extra); }
  blocked() { this.dispatch('blocked'); }
}

interface StoreMeta { keyPath: string | string[] | null; autoIncrement: boolean; rows: Map<string, any>; nextKey: number }
interface DbData { version: number; stores: Map<string, StoreMeta>; lock: { active: Tx | null; waiting: Tx[] } }

const k = (key: unknown) => JSON.stringify(key);
const clone = <T>(v: T): T => (v === undefined ? v : structuredClone(v));

class ObjStore {
  constructor(private tx: Tx, public name: string, private meta: () => StoreMeta) {}
  get keyPath() { return this.meta().keyPath; }
  get transaction() { return this.tx; }
  private run<T>(write: boolean, op: (m: StoreMeta) => T): Req {
    const r = new Req();
    r.transaction = this.tx;
    this.tx.enqueue(write, () => {
      try {
        r.succeed(op(this.meta()));
      } catch (e: any) {
        if (r.fail(e)) this.tx.abortWith(e);
      }
    });
    return r;
  }
  private keyFor(m: StoreMeta, value: any, key: unknown): unknown {
    if (Array.isArray(m.keyPath)) {
      const parts = m.keyPath.map((p) => value?.[p]);
      if (parts.some((x) => x === undefined)) throw domErr('DataError', 'compound key path yielded no key');
      return parts;
    }
    if (m.keyPath) {
      const kk = value?.[m.keyPath];
      if (kk === undefined) {
        if (m.autoIncrement) return ++m.nextKey;
        throw domErr('DataError', 'key path yielded no key');
      }
      return kk;
    }
    if (key === undefined) {
      if (m.autoIncrement) return ++m.nextKey;
      throw domErr('DataError', 'no key');
    }
    return key;
  }
  get(key: unknown) { return this.run(false, (m) => clone(m.rows.get(k(key))?.v)); }
  getAll() { return this.run(false, (m) => [...m.rows.values()].map((r) => clone(r.v))); }
  count() { return this.run(false, (m) => m.rows.size); }
  put(value: any, key?: unknown) {
    this.tx.requireWrite();
    return this.run(true, (m) => {
      const kk = this.keyFor(m, value, key);
      m.rows.set(k(kk), { key: kk, v: clone(value) });
      return kk;
    });
  }
  add(value: any, key?: unknown) {
    this.tx.requireWrite();
    return this.run(true, (m) => {
      const kk = this.keyFor(m, value, key);
      if (m.rows.has(k(kk))) throw domErr('ConstraintError', 'key already exists');
      m.rows.set(k(kk), { key: kk, v: clone(value) });
      return kk;
    });
  }
  delete(key: unknown) {
    this.tx.requireWrite();
    return this.run(true, (m) => { m.rows.delete(k(key)); return undefined; });
  }
  clear() {
    this.tx.requireWrite();
    return this.run(true, (m) => { m.rows.clear(); return undefined; });
  }
}

function domErr(name: string, message: string): Error {
  const e = new Error(message);
  e.name = name;
  return e;
}

class Tx extends Target {
  oncomplete: Listener | null = null;
  onerror: Listener | null = null;
  onabort: Listener | null = null;
  error: Error | null = null;
  private queue: (() => void)[] = [];
  private started = false;
  private finished = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private working = new Map<string, StoreMeta>();
  constructor(readonly db: Db, readonly names: string[], readonly mode: 'readonly' | 'readwrite' | 'versionchange') {
    super();
  }
  requireWrite() {
    if (this.mode === 'readonly') throw domErr('ReadOnlyError', 'transaction is read-only');
  }
  objectStore(name: string): ObjStore {
    const inScope = this.names.includes(name) || (this.mode === 'versionchange' && this.db.data.stores.has(name));
    if (!inScope) throw domErr('NotFoundError', `store ${name} not in transaction scope`);
    return new ObjStore(this, name, () => this.working.get(name) ?? this.db.data.stores.get(name)!);
  }
  begin() {
    this.started = true;
    for (const n of this.names) {
      const src = this.db.data.stores.get(n);
      if (!src) continue;
      this.working.set(n, {
        keyPath: src.keyPath, autoIncrement: src.autoIncrement, nextKey: src.nextKey,
        rows: new Map([...src.rows].map(([kk, r]) => [kk, { key: r.key, v: clone(r.v) }])),
      });
    }
    this.kick();
  }
  enqueue(_write: boolean, job: () => void) {
    if (this.finished) throw domErr('TransactionInactiveError', 'transaction has finished');
    this.queue.push(job);
    this.kick();
  }
  private kick() {
    if (this.timer || !this.started || this.finished) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.step(); }, 0);
  }
  private step() {
    if (this.finished) return;
    const job = this.queue.shift();
    if (job) { job(); this.kick(); return; }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.queue.length) { this.kick(); return; }
      this.complete();
    }, this.db.factory.commitDelayMs);
  }
  private complete() {
    if (this.finished) return;
    if (this.db.factory.consumeFailure() && this.mode !== 'readonly') {
      this.abortWith(domErr('AbortError', 'injected transaction failure'));
      return;
    }
    if (this.mode !== 'readonly') {
      for (const [n, w] of this.working) {
        const target = this.db.data.stores.get(n)!;
        target.rows = w.rows;
        target.nextKey = w.nextKey;
      }
      this.db.factory.commits++;
    }
    this.finish();
    this.dispatch('complete');
  }
  abortWith(err: Error | null) {
    if (this.finished) return;
    this.error = err;
    this.finish();
    this.dispatch('abort');
  }
  abort() { this.abortWith(domErr('AbortError', 'aborted')); }
  private finish() {
    this.finished = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.db.released(this);
  }
}

class Db extends Target {
  onversionchange: Listener | null = null;
  onclose: Listener | null = null;
  /** readwrite serialisation is per DATABASE, not per connection (every open() returns a new Db object). */
  private get lock() { return this.data.lock; }
  constructor(readonly factory: FakeIdbFactory, readonly name: string, readonly data: DbData) { super(); }
  get version() { return this.data.version; }
  get objectStoreNames() {
    const names = [...this.data.stores.keys()];
    return Object.assign(names, { contains: (n: string) => names.includes(n) });
  }
  createObjectStore(name: string, opts: { keyPath?: string | string[] | null; autoIncrement?: boolean } = {}) {
    if (this.data.stores.has(name)) throw domErr('ConstraintError', 'store exists');
    this.data.stores.set(name, { keyPath: opts.keyPath ?? null, autoIncrement: !!opts.autoIncrement, rows: new Map(), nextKey: 0 });
  }
  deleteObjectStore(name: string) { this.data.stores.delete(name); }
  transaction(names: string | string[], mode: 'readonly' | 'readwrite' = 'readonly') {
    const list = Array.isArray(names) ? names : [names];
    for (const n of list) if (!this.data.stores.has(n)) throw domErr('NotFoundError', `no store ${n}`);
    const tx = new Tx(this, list, mode);
    if (mode === 'readonly') setTimeout(() => tx.begin(), 0);
    else { this.lock.waiting.push(tx); setTimeout(() => this.pump(), 0); }
    return tx;
  }
  /** versionchange transactions start at once and are not serialised. */
  upgradeTx(): Tx {
    const tx = new Tx(this, [...this.data.stores.keys()], 'versionchange');
    tx.begin();
    return tx;
  }
  private pump() {
    if (this.lock.active || !this.lock.waiting.length) return;
    this.lock.active = this.lock.waiting.shift()!;
    this.lock.active.begin();
  }
  released(tx: Tx) {
    if (this.lock.active === tx) { this.lock.active = null; setTimeout(() => this.pump(), 0); }
  }
  /** T-425: a closed connection no longer blocks a version upgrade (and no longer receives versionchange). */
  closed = false;
  close() { this.closed = true; this.factory.forget(this); }
}

export class FakeIdbFactory {
  commitDelayMs: number;
  commits = 0;
  private dbs = new Map<string, DbData>();
  private conns = new Map<string, Set<Db>>();
  private failures = 0;
  constructor(opts: { commitDelayMs?: number } = {}) { this.commitDelayMs = opts.commitDelayMs ?? 15; }

  forget(db: Db) { this.conns.get(db.name)?.delete(db); }
  /** T-425 test hook: connections to `name` that were opened and not closed. */
  openConnections(name: string): number { return this.conns.get(name)?.size ?? 0; }
  private track(db: Db) {
    const set = this.conns.get(db.name) ?? new Set<Db>();
    set.add(db);
    this.conns.set(db.name, set);
    return db;
  }

  /**
   * T-425: versioned open. A higher version than stored fires `versionchange` ({oldVersion, newVersion}) on every OTHER open connection,
   * waits (firing `blocked` once on the request) until they are all closed, then runs `upgradeneeded` ({oldVersion, newVersion}) with
   * `request.transaction` usable for the existing stores. A lower version fails with VersionError.
   */
  open(name: string, version?: number): Req {
    const req = new Req();
    setTimeout(() => {
      const data = this.dbs.get(name);
      const want = version ?? data?.version ?? 1;
      if (data && want < data.version) {
        req.fail(domErr('VersionError', 'requested version is lower than the existing one'));
        return;
      }
      if (!data || want > data.version) {
        const oldVersion = data?.version ?? 0;
        const others = [...(this.conns.get(name) ?? [])];
        for (const o of others) {
          (o as any).dispatch('versionchange', { oldVersion, newVersion: want });
        }
        let warned = false;
        const go = () => {
          if ([...(this.conns.get(name) ?? [])].some((c) => !c.closed)) {
            if (!warned) { warned = true; req.blocked(); }
            setTimeout(go, 1);
            return;
          }
          const d = data ?? { version: 0, stores: new Map(), lock: { active: null, waiting: [] } };
          d.version = want;
          this.dbs.set(name, d);
          const db = this.track(new Db(this, name, d));
          req.result = db;
          const tx = db.upgradeTx();
          req.transaction = tx;
          tx.addEventListener('complete', () => req.succeed(db));
          tx.addEventListener('abort', () => req.fail(domErr('AbortError', 'upgrade aborted')));
          req.upgrade({ oldVersion, newVersion: want });
        };
        go();
        return;
      }
      req.succeed(this.track(new Db(this, name, data)));
    }, 0);
    return req;
  }
  deleteDatabase(name: string): Req {
    const req = new Req();
    setTimeout(() => { this.dbs.delete(name); req.succeed(undefined); }, 0);
    return req;
  }
  databases() { return Promise.resolve([...this.dbs.entries()].map(([name, d]) => ({ name, version: d.version }))); }
  cmp(a: any, b: any) { return a < b ? -1 : a > b ? 1 : 0; }

  // ---- test hooks ----
  /** Committed rows of every object store with this name, across databases. */
  rows(store: string): any[] {
    const out: any[] = [];
    for (const d of this.dbs.values()) {
      const s = d.stores.get(store);
      if (s) for (const r of s.rows.values()) out.push(clone(r.v));
    }
    return out;
  }
  commitCount() { return this.commits; }
  /** The next readwrite transaction aborts at commit time (nothing is applied). */
  failNextTransaction(n = 1) { this.failures += n; }
  consumeFailure() { if (this.failures > 0) { this.failures--; return true; } return false; }
  /** Simulates reinstall/clear-site-data. */
  wipe() { this.dbs.clear(); this.conns.clear(); }
  /** Stored version of a database (0 when absent). */
  versionOf(name: string): number { return this.dbs.get(name)?.version ?? 0; }
  /**
   * T-425: seeds a database exactly as an OLDER build left it (version + stores + rows), so an upgrade is a real test.
   * `stores`: name -> { keyPath?, rows: [[key, value]] } (out-of-line keys when no keyPath).
   */
  seedDatabase(name: string, version: number, stores: Record<string, { keyPath?: string | string[]; rows?: [unknown, unknown][] }>) {
    const m = new Map<string, StoreMeta>();
    for (const [sn, def] of Object.entries(stores)) {
      const rows = new Map<string, any>();
      for (const [key, v] of def.rows ?? []) rows.set(k(key), { key, v: clone(v) });
      m.set(sn, { keyPath: def.keyPath ?? null, autoIncrement: false, rows, nextKey: 0 });
    }
    this.dbs.set(name, { version, stores: m, lock: { active: null, waiting: [] } });
  }
}

export const createFakeIdb = (opts?: { commitDelayMs?: number }) => new FakeIdbFactory(opts);

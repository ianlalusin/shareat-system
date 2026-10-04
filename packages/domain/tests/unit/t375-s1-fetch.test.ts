import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T-375 S1 - `fetchPosV1Day` (`packages/domain/src/pos/v1-feed.ts`), tests F1 and F2.
 * `docs/tasks/375-pos-v1-day-feed.md` section S1.
 *
 * TESTER, not BUILDER. `fetch` is injected by stubbing the global, and `env()` is mocked so the POS_API_URL /
 * POS_API_KEY pair is controlled per test (env() caches on first read, so a process.env edit would not take).
 *
 * ## Why these are red on HEAD
 * `v1-feed.ts` does not exist. Each test imports it dynamically inside the test, so every leg fails on
 * "Failed to resolve import ../../src/pos/v1-feed" (a missing module is the honest red for a new file). Once
 * it exists, the legs assert the URL, the header, the returned shape and the two named errors.
 *
 * ## Where the spec is silent (read, not invented)
 *  - the module exports `fetchPosV1Day`, `PosNotConfiguredError`, `PosUnreachableError` (spec names all three);
 *  - "POS's `error` text in the raw half only" is read as: it is in `err.message` and NOT in `err.userMessage`
 *    (a RefusalError's two halves, `packages/db/src/refusal.ts`); if the builder's error carries no userMessage the
 *    second assertion is vacuous-safe (undefined does not contain it);
 *  - `body` is the exact response text; `payload` is `JSON.parse(body)`.
 */
const state: { url?: string; key?: string } = {};
vi.mock('@shareat/core/env', () => ({
  env: () => ({ POS_API_URL: state.url, POS_API_KEY: state.key }),
}));

type Call = { url: string; apiKey: string | null };
let calls: Call[] = [];

function stubFetch(respond: () => Response | Promise<Response>) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: { headers?: HeadersInit }) => {
      calls.push({ url: String(input), apiKey: new Headers(init?.headers).get('x-api-key') });
      return respond();
    }),
  );
}

beforeAll(async () => {
  await import('../../src/pos/v1-feed'); // the cold @shareat/db barrel import takes seconds; keep it out of each leg's 5 s budget
}, 60_000);

beforeEach(() => {
  state.url = 'https://pos.example.test';
  state.key = 'secret-key';
});
afterEach(() => {
  vi.unstubAllGlobals();
  calls = [];
});

const SALES_BODY = '{"found":true,"totalSales":1050,"totalSessions":20}';

async function load() {
  return import('../../src/pos/v1-feed');
}

describe('F1 - fetchPosV1Day calls POS with POS\'s own store id', () => {
  it('sales: GET {url}/api/external/sales?storeId=abc&date=2027-01-05 with x-api-key; returns the exact body and its parsed payload', async () => {
    stubFetch(() => new Response(SALES_BODY, { status: 200 }));
    const { fetchPosV1Day } = await load();
    const out = await fetchPosV1Day({ posStoreId: 'abc', businessDate: '2027-01-05', kind: 'sales' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://pos.example.test/api/external/sales?storeId=abc&date=2027-01-05');
    expect(calls[0]!.apiKey).toBe('secret-key');
    expect(out.body).toBe(SALES_BODY);
    expect(out.payload).toEqual({ found: true, totalSales: 1050, totalSessions: 20 });
  });

  it('sold_items: the SAME call shape against /api/external/sold-items (control: the kind picks the path)', async () => {
    stubFetch(() => new Response('{"found":true,"items":[]}', { status: 200 }));
    const { fetchPosV1Day } = await load();
    const out = await fetchPosV1Day({ posStoreId: 'abc', businessDate: '2027-01-05', kind: 'sold_items' });
    expect(calls[0]!.url).toBe('https://pos.example.test/api/external/sold-items?storeId=abc&date=2027-01-05');
    expect(calls[0]!.apiKey).toBe('secret-key');
    expect(out.payload).toEqual({ found: true, items: [] });
  });

  it('the store id is URL-encoded (a POS id with a space or slash cannot add a parameter)', async () => {
    stubFetch(() => new Response(SALES_BODY, { status: 200 }));
    const { fetchPosV1Day } = await load();
    await fetchPosV1Day({ posStoreId: 'a b&c=d', businessDate: '2027-01-05', kind: 'sales' });
    expect(calls[0]!.url).toBe('https://pos.example.test/api/external/sales?storeId=a%20b%26c%3Dd&date=2027-01-05');
  });

  it('a found:false answer is returned as a normal result, not an error (the derivation refuses it, S3)', async () => {
    stubFetch(() => new Response('{"found":false}', { status: 200 }));
    const { fetchPosV1Day } = await load();
    const out = await fetchPosV1Day({ posStoreId: 'abc', businessDate: '2027-01-05', kind: 'sales' });
    expect(out.payload).toEqual({ found: false });
  });
});

describe('F2 - unconfigured and unreachable', () => {
  it('env unset (URL and key) -> PosNotConfiguredError, and POS is never called', async () => {
    state.url = undefined;
    state.key = undefined;
    stubFetch(() => new Response(SALES_BODY, { status: 200 }));
    const { fetchPosV1Day, PosNotConfiguredError } = await load();
    await expect(fetchPosV1Day({ posStoreId: 'abc', businessDate: '2027-01-05', kind: 'sales' })).rejects.toBeInstanceOf(PosNotConfiguredError);
    expect(calls).toHaveLength(0);
  });

  it('only the key unset -> PosNotConfiguredError (either half missing is "not configured")', async () => {
    state.key = undefined;
    stubFetch(() => new Response(SALES_BODY, { status: 200 }));
    const { fetchPosV1Day, PosNotConfiguredError } = await load();
    await expect(fetchPosV1Day({ posStoreId: 'abc', businessDate: '2027-01-05', kind: 'sales' })).rejects.toBeInstanceOf(PosNotConfiguredError);
    expect(calls).toHaveLength(0);
  });

  it("403 {error:'Forbidden for this store.'} -> PosUnreachableError; POS's text is in the raw message only", async () => {
    stubFetch(() => new Response('{"error":"Forbidden for this store."}', { status: 403 }));
    const { fetchPosV1Day, PosUnreachableError } = await load();
    const err = await fetchPosV1Day({ posStoreId: 'abc', businessDate: '2027-01-05', kind: 'sales' }).catch((e) => e);
    expect(err).toBeInstanceOf(PosUnreachableError);
    expect((err as Error).message).toContain('Forbidden for this store.');
    expect(String((err as { userMessage?: string }).userMessage ?? '')).not.toContain('Forbidden for this store.');
  });

  it('a 500 with no JSON body -> PosUnreachableError (non-2xx of any shape)', async () => {
    stubFetch(() => new Response('upstream exploded', { status: 500 }));
    const { fetchPosV1Day, PosUnreachableError } = await load();
    await expect(fetchPosV1Day({ posStoreId: 'abc', businessDate: '2027-01-05', kind: 'sales' })).rejects.toBeInstanceOf(PosUnreachableError);
  });

  it('a network failure (fetch rejects) -> PosUnreachableError', async () => {
    stubFetch(() => Promise.reject(new TypeError('fetch failed')));
    const { fetchPosV1Day, PosUnreachableError } = await load();
    await expect(fetchPosV1Day({ posStoreId: 'abc', businessDate: '2027-01-05', kind: 'sales' })).rejects.toBeInstanceOf(PosUnreachableError);
  });

  it('the two errors are distinct types (control: a configured, reachable POS throws neither)', async () => {
    stubFetch(() => new Response(SALES_BODY, { status: 200 }));
    const { fetchPosV1Day, PosUnreachableError, PosNotConfiguredError } = await load();
    expect(PosUnreachableError).not.toBe(PosNotConfiguredError);
    await expect(fetchPosV1Day({ posStoreId: 'abc', businessDate: '2027-01-05', kind: 'sales' })).resolves.toMatchObject({ body: SALES_BODY });
  });
});

describe('F1 (audit) - a POS that accepts the connection and never answers is "unreachable", not a hang', () => {
  /**
   * The stub never resolves; it rejects only if the signal it was handed aborts. The timeout is driven two ways so the
   * test does not depend on HOW the builder arms it: fake timers cover `setTimeout` + `AbortController`, and a spy on
   * `AbortSignal.timeout` hands back a signal this test can fire. If no signal is passed at all the promise simply
   * never settles and the `settled` assertion is the red.
   */
  async function hang(run: (f: typeof import('../../src/pos/v1-feed')) => Promise<unknown>) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const ctl = new AbortController();
    let timeoutMs: number | null = null;
    const spy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      timeoutMs = ms;
      return ctl.signal;
    });
    let seenSignal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: unknown, init?: { signal?: AbortSignal }) => {
        seenSignal = init?.signal;
        return new Promise<Response>((_res, rej) => {
          init?.signal?.addEventListener('abort', () => rej(init.signal!.reason ?? new DOMException('aborted', 'AbortError')));
        });
      }),
    );
    try {
      const f = await load();
      let outcome: { err: unknown } | null = null;
      const p = run(f).then(
        () => (outcome = { err: null }),
        (err) => (outcome = { err }),
      );
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      if (timeoutMs !== null) ctl.abort(new DOMException('timed out', 'TimeoutError'));
      await vi.advanceTimersByTimeAsync(0);
      const settled = outcome !== null;
      const result = { settled, err: (outcome as { err: unknown } | null)?.err, seenSignal, timeoutMs };
      if (settled) await p;
      return { ...result, f };
    } finally {
      spy.mockRestore();
      vi.useRealTimers();
    }
  }

  it('fetchPosV1Day: a signal is passed and the call rejects with PosUnreachableError within the timeout (<= 2 min if AbortSignal.timeout is used)', async () => {
    const r = await hang((f) => f.fetchPosV1Day({ posStoreId: 'abc', businessDate: '2027-01-05', kind: 'sales' }));
    expect(r.seenSignal, 'fetch must be given an AbortSignal').toBeInstanceOf(AbortSignal);
    expect(r.settled, 'the call must settle after the timeout instead of hanging').toBe(true);
    expect(r.err).toBeInstanceOf(r.f.PosUnreachableError);
    if (r.timeoutMs !== null) expect(r.timeoutMs).toBeLessThanOrEqual(120_000);
  });

  it('fetchPosV1Stores: the same', async () => {
    const r = await hang((f) => f.fetchPosV1Stores());
    expect(r.seenSignal, 'fetch must be given an AbortSignal').toBeInstanceOf(AbortSignal);
    expect(r.settled, 'the call must settle after the timeout instead of hanging').toBe(true);
    expect(r.err).toBeInstanceOf(r.f.PosUnreachableError);
  });

  it('control: a prompt answer still resolves (the timeout does not fire early)', async () => {
    stubFetch(() => new Response('{"stores":[{"id":"a","name":"A"}]}', { status: 200 }));
    const { fetchPosV1Stores } = await load();
    await expect(fetchPosV1Stores()).resolves.toEqual([{ id: 'a', name: 'A' }]);
  });
});

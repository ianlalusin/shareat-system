import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { posV1SalesBody } from '../../db/src/pos-v1/fixtures';

/** T-375 S0: the whole script against a local stand-in POS (the fake-pos route needs a running Next server). */
const KEY = 'census-secret-key-123';
let server: Server;
let base = '';
let hits = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    hits++;
    const u = new URL(req.url ?? '/', 'http://x');
    res.setHeader('content-type', 'application/json');
    if (req.headers['x-api-key'] !== KEY) { res.statusCode = 401; res.end('{"error":"nope"}'); return; }
    if (u.pathname === '/api/external/payment-methods') { res.end('{"methods":["Cash","GCash"]}'); return; }
    const store = u.searchParams.get('storeId');
    const date = u.searchParams.get('date') ?? '';
    if (store === 'BAD') { res.statusCode = 500; res.end('{"error":"boom SECRETBODY"}'); return; }
    if (store === 'SHORT' && date.endsWith('-02')) { res.end(JSON.stringify(posV1SalesBody({ paidTotal: 100, receiptCount: 2, methods: { Cash: 90 } }))); return; }
    if (date.endsWith('-03')) { res.end(JSON.stringify(posV1SalesBody({ found: false }))); return; }
    res.end(JSON.stringify(posV1SalesBody({ paidTotal: 1000, discounts: 0, charges: 20, packageOnly: 1500, receiptCount: 10, methods: { Cash: 1000 } })));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.close(); });

function run(args: string[], env: Record<string, string | undefined> = { POS_API_URL: base, POS_API_KEY: KEY }) {
  // Async: the stand-in POS lives in this process, so a blocking spawn would starve it.
  return new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    const p = spawn(process.execPath, ['--import', 'tsx', 'scripts/pos-v1-feed-census.ts', ...args], {
      env: { ...process.env, POS_API_URL: undefined, POS_API_KEY: undefined, ...env } as NodeJS.ProcessEnv,
    });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += String(d)));
    p.stderr.on('data', (d) => (err += String(d)));
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

describe('pos-v1-feed-census script', { timeout: 60_000 }, () => {
  it('passes on a clean store, prints counts only, never the key', async () => {
    const r = await run(['--pos-store', 'OK', '--days', '10', '--to', '2026-09-10']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('GATE PASS');
    expect(r.out).toContain('(a) days found: 9'); // the 3rd is not found
    expect(r.out).toContain('(c) days K > P + D - C + refunds (W1 cap fires): 9; largest excess: 520.00');
    expect(r.out).toContain('(g) days with charges > 0: 9');
    expect(r.out + r.err).not.toContain(KEY);
    expect(r.out + r.err).not.toContain('127.0.0.1');
  });

  it('fails the gate (exit 1) when a day has methods short of the total', async () => {
    const r = await run(['--pos-store', 'SHORT', '--days', '10', '--to', '2026-09-10']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('GATE FAIL: (e1)');
    expect(r.out + r.err).not.toContain(KEY);
  });

  it('exit 2 when POS answers non-2xx for every day, printing the status and date but not the body', async () => {
    const r = await run(['--pos-store', 'BAD', '--days', '2', '--to', '2026-09-10']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('2026-09-10 answered 500');
    expect(r.out + r.err).not.toContain('SECRETBODY');
    expect(r.out + r.err).not.toContain(KEY);
  });

  it('exit 2 on a wrong key (401) and on missing config or arguments, before any call', async () => {
    const wrong = await run(['--pos-store', 'OK', '--days', '2', '--to', '2026-09-10'], { POS_API_URL: base, POS_API_KEY: 'wrong-key-456' });
    expect(wrong.code).toBe(2);
    expect(wrong.err).toContain('answered 401');
    expect(wrong.out + wrong.err).not.toContain('wrong-key-456');
    expect(wrong.out + wrong.err).not.toContain(KEY);
    const before = hits;
    expect((await run(['--pos-store', 'OK'], {})).code).toBe(2);
    expect((await run([], { POS_API_URL: base, POS_API_KEY: KEY })).code).toBe(2);
    expect(hits).toBe(before);
  });
});

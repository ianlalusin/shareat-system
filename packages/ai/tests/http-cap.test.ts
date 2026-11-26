import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { AiProviderError } from '../src/errors';
import { MAX_REPLY_BYTES, readCappedBody } from '../src/http';

/**
 * T-640 (security audit): a provider reply is read with a hard size cap, and the real client never follows a redirect. The cap is tested on real `Response` objects, never on the network.
 */
const bad = { kind: 'bad_response' } as const;

describe('T-640 reply size cap', () => {
  it('a body within the cap is read whole; the cap is 2 MB [kills: a client that cannot read a normal answer]', async () => {
    expect(MAX_REPLY_BYTES).toBe(2 * 1024 * 1024);
    expect(await readCappedBody(new Response('{"ok":true}'), 100)).toBe('{"ok":true}');
    expect(await readCappedBody(new Response(null), 100)).toBe('');
  });

  it('a body over the cap is refused as a bad response, not parsed [kills: reading an unbounded reply into memory]', async () => {
    await expect(readCappedBody(new Response('x'.repeat(101)), 100)).rejects.toMatchObject(bad);
    await expect(readCappedBody(new Response('x'.repeat(100)), 100)).resolves.toHaveLength(100);
  });

  it('a declared length over the cap is refused before any byte is read [kills: trusting the body to be small]', async () => {
    const res = new Response('tiny', { headers: { 'content-length': '999999999' } });
    await expect(readCappedBody(res, 1000)).rejects.toBeInstanceOf(AiProviderError);
    expect(res.bodyUsed).toBe(false);
  });

  it('an endless stream is stopped at the cap and cancelled [kills: a reply that never ends filling memory]', async () => {
    const cancel = vi.fn();
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(ctl) {
        pulls += 1;
        ctl.enqueue(new Uint8Array(40));
      },
      cancel,
    });
    await expect(readCappedBody(new Response(stream), 100)).rejects.toMatchObject(bad);
    expect(cancel).toHaveBeenCalled();
    expect(pulls).toBeLessThan(10);
  });

  it('the real client refuses redirects and reads through the capped reader [kills: sending the key header to wherever a redirect points]', () => {
    const src = readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src', 'http.ts'), 'utf8');
    expect(src).toContain("redirect: 'error'");
    expect(src).toContain('await readCappedBody(res)');
    expect(src).not.toMatch(/res\.text\(\)|res\.json\(\)/);
  });
});

import { describe, expect, it } from 'vitest';
import { uuidv5 as serverUuidv5 } from '../../../packages/domain/src/pos/shared';
import { extraHeadsId, uuidv5 } from '@/app/pos/_payment/uuidv5';

/** T-528 (BUILDER) - the device's WebCrypto uuidv5 must give the SERVER's ids (extra-heads line, T-524 ruling 3), so a bundle sold offline matches without a mismatch row. */
const DNS = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

describe('device uuidv5 (T-528)', () => {
  it('RFC 4122 vector: uuidv5 of www.example.com in the DNS namespace', async () => {
    expect(await uuidv5('www.example.com', DNS)).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2');
  });

  it('equals the server function for the same inputs, across many lines and names', async () => {
    for (let i = 0; i < 50; i++) {
      const ns = globalThis.crypto.randomUUID();
      for (const name of ['extra-heads', 'x', `line-${i}`]) expect(await uuidv5(name, ns), `${name} in ${ns}`).toBe(serverUuidv5(name, ns));
    }
  });

  it("extraHeadsId is uuidv5('extra-heads', the bundle line id), as order.ts writes it", async () => {
    const line = globalThis.crypto.randomUUID();
    expect(await extraHeadsId(line)).toBe(serverUuidv5('extra-heads', line));
  });
});

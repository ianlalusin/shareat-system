import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RefusalError } from '@shareat/db';

/**
 * T-531 R5 "Credentials" (TESTER) - the real v1 bridge writer. docs/tasks/531-pos-day-close.md R5.
 * ASSUMED API (apps/erp/src/lib/v1-bridge.ts, server-only): createV1BridgeWriter(env?: { POS_FIREBASE_SA_KEY_FILE?: string }) -> { set(path, data, { merge }) }.
 * With no key file the writer REFUSES with the sentence "The v1 bridge is not configured." (a RefusalError); the close it follows still succeeds (domain test).
 * `.env.example` gets the NAME only: `POS_FIREBASE_SA_KEY_FILE=` with no value.
 * RED NOW FOR THE RIGHT REASON: v1-bridge.ts does not exist; .env.example does not name the variable.
 */
describe('the real writer without a key', () => {
  it('set() rejects with "The v1 bridge is not configured." and writes nothing (no firebase-admin call is reached)', async () => {
    type Writer = { set: (p: string, d: object, o: { merge: boolean }) => Promise<void> };
    const m = (await import(/* @vite-ignore */ './v1-bridge').catch(() => null)) as { createV1BridgeWriter?: (env?: Record<string, string | undefined>) => Writer } | null;
    if (!m || typeof m.createV1BridgeWriter !== 'function') throw new Error('MISSING EXPORT: apps/erp/src/lib/v1-bridge.ts does not export createV1BridgeWriter (T-531 not built).');
    for (const env of [{}, { POS_FIREBASE_SA_KEY_FILE: undefined }, { POS_FIREBASE_SA_KEY_FILE: '' }]) {
      const err = await m.createV1BridgeWriter(env).set('stores/x/analytics/20261102', { payments: {} }, { merge: false }).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(RefusalError);
      expect((err as RefusalError).userMessage).toBe('The v1 bridge is not configured.');
    }
  });
});

describe('.env.example', () => {
  it('names POS_FIREBASE_SA_KEY_FILE with an empty value (name only, never a path or a key)', () => {
    const text = readFileSync(join(process.cwd(), '.env.example'), 'utf8');
    expect(text).toMatch(/^POS_FIREBASE_SA_KEY_FILE=\s*$/m);
  });
});

/**
 * T-598 S9 / DEF-372: the clock terminal connects to the Firebase emulator only outside a production build,
 * even when NEXT_PUBLIC_FIREBASE_EMULATOR_HOST has leaked into one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const BASE_ENV = {
  NEXT_PUBLIC_FIREBASE_API_KEY: 'test-api-key',
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: 'test.firebaseapp.com',
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: 'test-project',
  NEXT_PUBLIC_FIREBASE_EMULATOR_HOST: 'localhost:8182',
};

let saved: NodeJS.ProcessEnv;
beforeEach(() => {
  saved = process.env;
});
afterEach(() => {
  process.env = saved;
});

async function connectCalls(nodeEnv: string) {
  process.env = { ...BASE_ENV, NODE_ENV: nodeEnv } as unknown as NodeJS.ProcessEnv;
  const connectFirestoreEmulator = vi.fn();
  const connectAuthEmulator = vi.fn();
  vi.resetModules();
  vi.doMock('firebase/app', () => ({
    initializeApp: vi.fn((_c: unknown, name: string) => ({ name })),
    getApp: vi.fn(),
    getApps: vi.fn(() => []),
  }));
  vi.doMock('firebase/auth', () => ({ getAuth: vi.fn(() => ({})), connectAuthEmulator }));
  vi.doMock('firebase/firestore', () => ({
    initializeFirestore: vi.fn(() => ({})),
    persistentLocalCache: vi.fn(),
    connectFirestoreEmulator,
  }));
  const mod = await import('../src/lib/terminal/firebase');
  mod.terminalFirebase();
  return { connectFirestoreEmulator, connectAuthEmulator };
}

describe('DEF-372: terminalFirebase() and the emulator host', () => {
  it('connects to the emulator in development', async () => {
    const c = await connectCalls('development');
    expect(c.connectFirestoreEmulator).toHaveBeenCalledTimes(1);
    expect(c.connectAuthEmulator).toHaveBeenCalledTimes(1);
  });

  it('never connects in a production build, whatever the variable says', async () => {
    const c = await connectCalls('production');
    expect(c.connectFirestoreEmulator).not.toHaveBeenCalled();
    expect(c.connectAuthEmulator).not.toHaveBeenCalled();
  });
});

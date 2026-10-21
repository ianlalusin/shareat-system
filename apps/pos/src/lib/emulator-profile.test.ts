import { readFileSync } from 'node:fs';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { emulatorProfile } from '../../config/emulator-profile.mjs';

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
describe('T-455 isolated emulator profile', () => {
  it('is disabled unless explicitly selected', () => {
    expect(emulatorProfile(undefined)).toBeNull();
    expect(emulatorProfile('0')).toBeNull();
    expect(() => emulatorProfile('yes')).toThrow();
  });
  it('fixes a demo project and local API/services, never accepting a cloud project', () => {
    expect(emulatorProfile('1')).toEqual({ projectId: 'demo-shareat-pos2', host: '10.0.2.2', apiBase: 'http://10.0.2.2:9009', authPort: 9099, firestorePort: 8080, storagePort: 9199 });
    expect(emulatorProfile('1', '127.0.0.1')?.apiBase).toBe('http://127.0.0.1:9009');
    for (const host of ['shareat-hub-v2.firebaseapp.com', '192.168.1.2', 'localhost.evil.test', '127.0.0.1@evil.test', '']) {
      expect(() => emulatorProfile('1', host)).toThrow();
    }
  });
  it('selects synthetic Firebase config in an emulator build', async () => {
    vi.stubEnv('NEXT_PUBLIC_POS_EMULATOR_MODE', '1');
    vi.stubEnv('NEXT_PUBLIC_POS_EMULATOR_HOST', '10.0.2.2');
    const { firebaseConfig } = await import('@/firebase/config');
    expect(firebaseConfig.projectId).toBe('demo-shareat-pos2');
    expect(firebaseConfig.apiKey).toBe('emulator-only-not-a-real-key');
    expect(firebaseConfig.storageBucket).not.toContain('shareat-hub-v2');
  });
  it('overrides both API destinations in emulator builds even if live URLs were inherited', async () => {
    vi.stubEnv('NEXT_PUBLIC_POS_EMULATOR_MODE', '1');
    vi.stubEnv('NEXT_PUBLIC_API_BASE', 'https://app.shareat.net');
    vi.stubEnv('NEXT_PUBLIC_POS2_API_BASE', 'https://pos2.shareat.net');
    const api = await import('./api-base');
    expect(api.apiUrl('/api/legacy')).toBe('http://10.0.2.2:9009/api/legacy');
    expect(api.apiUrl('/api/pos2/refunds')).toBe('http://10.0.2.2:9009/api/pos2/refunds');
  });
  it('connects all Firebase SDKs explicitly and keeps cleartext confined to the emulator native variant', () => {
    const sdk = readFileSync(new URL('./firebase/client.ts', import.meta.url), 'utf8');
    for (const name of ['connectAuthEmulator', 'connectFirestoreEmulator', 'connectStorageEmulator']) expect(sdk).toContain(name + '(');
    const manifest = readFileSync(new URL('../../android/app/src/main/AndroidManifest.xml', import.meta.url), 'utf8');
    expect(manifest).not.toContain('usesCleartextTraffic="true"');
    const emulatorManifest = readFileSync(new URL('../../android/app/src/emulator/AndroidManifest.xml', import.meta.url), 'utf8');
    expect(emulatorManifest).toContain('networkSecurityConfig');
  });
  it('seeds the singleton configuration used by the cashier and blocks demo assets in a release APK', () => {
    const seed = readFileSync(new URL('../../scripts/seed-emulator.mjs', import.meta.url), 'utf8');
    expect(seed).toContain('/storeConfig/current`');
    const gradle = readFileSync(new URL('../../android/app/build.gradle', import.meta.url), 'utf8');
    expect(gradle).toContain("it.name == 'preReleaseBuild'");
    expect(gradle).toContain('Refusing to package emulator assets in a release APK');
  });
});

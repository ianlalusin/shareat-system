import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';

const configPath = '../../next.config.mjs';
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
it('injects only the package version at build time, preserving the configured version override', async () => {
  vi.stubEnv('NEXT_PUBLIC_APP_VERSION', '');
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  const config = (await import(configPath)).default;
  expect(config.env?.NEXT_PUBLIC_APP_VERSION).toBe(pkg.version);
  vi.resetModules(); vi.stubEnv('NEXT_PUBLIC_APP_VERSION', '7.8.9-test');
  expect((await import(configPath)).default.env?.NEXT_PUBLIC_APP_VERSION).toBe('7.8.9-test');
  expect((await import('./appVersion')).APP_VERSION).toBe('7.8.9-test');
});
it('keeps the package manifest out of the client version module', () => {
  const source = readFileSync(new URL('./appVersion.ts', import.meta.url), 'utf8');
  expect(source).not.toMatch(/(?:from|import|require)[^\n]*package\.json/);
});

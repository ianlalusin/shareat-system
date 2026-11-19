/** T-532 S2 — the shell's identity and server URL (no Android toolchain needed). */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const shell = path.resolve(__dirname, '..', '..', 'apps', 'pos-shell');
const read = (p: string) => readFileSync(path.join(shell, p), 'utf8').replace(/\r\n/g, '\n');

async function config(mode?: string) {
  vi.resetModules();
  if (mode) vi.stubEnv('POS_SHELL_MODE', mode);
  return (await import('../../apps/pos-shell/capacitor.config')).default;
}
afterEach(() => vi.unstubAllEnvs());

describe('pos-shell (T-532 S2)', () => {
  it('release: its own app id, the ERP /pos URL, navigation limited to erp2.shareat.net', async () => {
    const c = await config();
    expect(c.appId).toBe('net.shareat.erppos');
    expect(c.server?.url).toBe('https://erp2.shareat.net/pos');
    expect(c.server?.allowNavigation).toEqual(['erp2.shareat.net']);
    expect(c.server?.cleartext).toBeUndefined();
  });
  it('emulator mode: http://10.0.2.2:9008/pos, cleartext for 10.0.2.2 only', async () => {
    const c = await config('emulator');
    expect(c.server).toMatchObject({ url: 'http://10.0.2.2:9008/pos', cleartext: true, allowNavigation: ['10.0.2.2'] });
  });
  it('Android project: erppos package, printer plugin registered, no v1 plugin, no camera', () => {
    const java = 'android/app/src/main/java/net/shareat/erppos/';
    expect(read(`${java}MainActivity.java`)).toContain('registerPlugin(ThermalPrinterPlugin.class)');
    expect(read(`${java}MainActivity.java`)).not.toContain('Birthday');
    expect(read(`${java}ThermalPrinterPlugin.java`)).toMatch(/^package net\.shareat\.erppos;/);
    expect(read('android/app/build.gradle')).toContain('applicationId "net.shareat.erppos"');
    const manifest = read('android/app/src/main/AndroidManifest.xml');
    expect(manifest).toContain('BLUETOOTH_CONNECT');
    expect(manifest).not.toContain('permission.CAMERA');
  });
  it('the emulator flavour allows cleartext for 10.0.2.2/localhost only; the release guard blocks a 10.0.2.2 config', () => {
    expect(read('android/app/src/emulator/res/xml/emulator_network_security.xml')).toContain('<base-config cleartextTrafficPermitted="false" />');
    expect(read('android/app/build.gradle')).toMatch(/preReleaseBuild[\s\S]*10\.0\.2\.2/);
  });
});

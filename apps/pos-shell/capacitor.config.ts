import type { CapacitorConfig } from '@capacitor/cli';

// T-532 S2: a remote-URL shell. The ERP serves /pos; the APK is rebuilt only when native code changes.
// POS_SHELL_MODE=emulator (set at `cap sync` time) points the TEST build at the dev server on the host PC.
const emulator = process.env.POS_SHELL_MODE === 'emulator';

const config: CapacitorConfig = {
  appId: 'net.shareat.erppos',
  appName: 'SharEat POS',
  webDir: 'www',
  server: emulator
    ? { url: 'http://10.0.2.2:9008/pos', cleartext: true, allowNavigation: ['10.0.2.2'] }
    : { url: 'https://erp2.shareat.net/pos', allowNavigation: ['erp2.shareat.net'] },
};

export default config;

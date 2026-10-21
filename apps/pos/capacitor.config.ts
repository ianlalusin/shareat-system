import type { CapacitorConfig } from '@capacitor/cli';
import { emulatorProfile } from './config/emulator-profile.mjs';
const emulator = emulatorProfile(process.env.POS_EMULATOR_MODE, process.env.POS_EMULATOR_HOST);

const config: CapacitorConfig = {
  appId: 'net.shareat.pos2',
  appName: 'Shareat POS v2',
  webDir: 'out',
  server: {
    androidScheme: 'https',
  },
  android: {
    allowMixedContent: !!emulator,
  },
};

export default config;

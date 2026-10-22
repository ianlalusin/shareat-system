import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emulatorProfile } from '../config/emulator-profile.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const profile = emulatorProfile('1');
const env = { ...process.env, NODE_ENV: 'production', POS_EMULATOR_MODE: '1', POS_EMULATOR_HOST: profile.host,
  NEXT_PUBLIC_API_BASE: profile.apiBase, NEXT_PUBLIC_POS2_API_BASE: profile.apiBase };
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) throw new Error(`Emulator build stopped: ${command} (${result.status ?? 'could not start'}).`);
}
run('node', ['scripts/build-cap.mjs']);
writeFileSync(join(root, 'out/pos-emulator-profile.json'), JSON.stringify(profile));
run('npx', ['cap', 'sync', 'android']);
run(process.platform === 'win32' ? 'gradlew.bat' : './gradlew', ['--no-daemon', 'assembleEmulator'], join(root, 'android'));
console.log('Emulator-only APK: android/app/build/outputs/apk/emulator/app-emulator.apk (net.shareat.pos2.emulator).');

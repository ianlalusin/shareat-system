/** Shared build/runtime contract. A demo profile has no selectable cloud project or remote host. */
// A practice copy on a PC where the default ports are busy may move the LOCAL ports (never the project or host).
// Literal `process.env.NAME` reads so next.config's `env` block can inline them into the browser bundle.
function port(raw, fallback) {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1024 || n > 65535) throw new Error('POS emulator ports must be whole numbers from 1024 to 65535.');
  return n;
}
export function emulatorProfile(enabled, host = '10.0.2.2') {
  if (enabled === undefined || enabled === '' || enabled === '0') return null;
  if (enabled !== '1') throw new Error('POS emulator mode must be 1 or disabled.');
  if (!['10.0.2.2', '127.0.0.1', 'localhost'].includes(host)) throw new Error('POS emulator services must use a local host.');
  const apiPort = port(process.env.POS_EMULATOR_API_PORT, 9009);
  return Object.freeze({ projectId: 'demo-shareat-pos2', host, apiBase: `http://${host}:${apiPort}`,
    authPort: port(process.env.POS_EMULATOR_AUTH_PORT, 9099),
    firestorePort: port(process.env.POS_EMULATOR_FIRESTORE_PORT, 8080),
    storagePort: port(process.env.POS_EMULATOR_STORAGE_PORT, 9199) });
}

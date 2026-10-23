/** Shared build/runtime contract. A demo profile has no selectable cloud project or remote host. */
export function emulatorProfile(enabled, host = '10.0.2.2') {
  if (enabled === undefined || enabled === '' || enabled === '0') return null;
  if (enabled !== '1') throw new Error('POS emulator mode must be 1 or disabled.');
  if (!['10.0.2.2', '127.0.0.1', 'localhost'].includes(host)) throw new Error('POS emulator services must use a local host.');
  return Object.freeze({ projectId: 'demo-shareat-pos2', host, apiBase: `http://${host}:9009`,
    authPort: 9099, firestorePort: 8080, storagePort: 9199 });
}

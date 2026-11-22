import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * T-625 S1 - the checked-in Firebase deploy config points at v2's OWN project and the bucket stays deny-all.
 * Mutants: .firebaserc default -> the old hub project; storage.rules gains `allow read: if request.auth != null`;
 * firebase.json loses its "storage" entry (then `firebase deploy --only storage` would deploy nothing).
 */
const root = path.resolve(__dirname, '..', '..');
const read = (rel: string): string => readFileSync(path.join(root, rel), 'utf8');

describe('T-625 firebase/ deploy config', () => {
  it('.firebaserc default is shareat-system (never the shared v1 projects)', () => {
    const rc = JSON.parse(read('firebase/.firebaserc')) as { projects: Record<string, string> };
    expect(rc.projects.default).toBe('shareat-system');
    expect(Object.values(rc.projects).join(' ')).not.toMatch(/hub-v2|studio-7300228488/);
  });

  it('firebase.json deploys storage.rules next to the Firestore rules', () => {
    const cfg = JSON.parse(read('firebase/firebase.json')) as { storage?: { rules?: string }; firestore?: { rules?: string } };
    expect(cfg.storage?.rules).toBe('storage.rules');
    expect(cfg.firestore?.rules).toBe('firestore.rules');
  });

  it('storage.rules is deny-all: exactly one allow statement and it is `if false`', () => {
    const code = read('firebase/storage.rules').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    const allows = code.match(/allow\s[^;]*;/g) ?? [];
    expect(allows).toEqual(['allow read, write: if false;']);
  });
});

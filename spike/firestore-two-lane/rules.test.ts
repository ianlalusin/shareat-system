/**
 * T-153 Contract §3 — the four refusals the two-lane contract depends on.
 *
 * Landmine #4 is "rules deploy green then silently deny at runtime". The inverse is just as
 * dangerous and is what these assert: rules that deploy green and silently ALLOW. Every one of
 * these was watched failing against a permissive ruleset before the real one was written.
 */
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing';
import type { RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import { deleteDoc, doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';

let env: RulesTestEnvironment;

const DEVICE = 'terminal-lipa-01';

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'shareat-spike',
    firestore: {
      rules: readFileSync('firestore.rules', 'utf8'),
      host: '127.0.0.1',
      port: 8181,
    },
  });
});

afterAll(async () => env?.cleanup());
beforeEach(async () => env.clearFirestore());

/** A provisioned terminal: authenticated, carrying a deviceId claim (plan §3, row 5). */
const terminal = () => env.authenticatedContext('device:terminal-lipa-01', { deviceId: DEVICE }).firestore();
/** An ordinary signed-in human, with no device claim. */
const human = () => env.authenticatedContext('person:alice').firestore();

describe('Lane A — mirror is read-only to every client, always', () => {
  it('1. an authenticated client CANNOT write a mirror doc', async () => {
    await assertFails(setDoc(doc(terminal(), 'mirror/roster-lipa'), { name: 'Lipa' }));
    await assertFails(setDoc(doc(human(), 'mirror/roster-lipa'), { name: 'Lipa' }));
  });

  it('1b. ...and cannot update or delete one the publisher wrote', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'mirror/roster-lipa'), { name: 'Lipa', srcVersion: 1 });
    });
    await assertFails(updateDoc(doc(terminal(), 'mirror/roster-lipa'), { name: 'hacked' }));
    await assertFails(deleteDoc(doc(terminal(), 'mirror/roster-lipa')));
  });

  it('1c. but CAN read it — a mirror is for reading', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'mirror/roster-lipa'), { name: 'Lipa', srcVersion: 1 });
    });
    await assertSucceeds(getDoc(doc(terminal(), 'mirror/roster-lipa')));
  });
});

describe('Lane B — inbox is create-only, and the id is the idempotency key', () => {
  const wellFormed = (id: string) => ({ clientPunchId: id, occurredAt: Date.now(), deviceId: DEVICE });

  it('2. a well-formed create SUCCEEDS', async () => {
    const id = 'punch-0001';
    await assertSucceeds(setDoc(doc(terminal(), `inbox/${id}`), wellFormed(id)));
  });

  it('3. update and delete are REFUSED once created', async () => {
    const id = 'punch-0002';
    await assertSucceeds(setDoc(doc(terminal(), `inbox/${id}`), wellFormed(id)));
    await assertFails(updateDoc(doc(terminal(), `inbox/${id}`), { occurredAt: 0 }));
    await assertFails(deleteDoc(doc(terminal(), `inbox/${id}`)));
  });

  it('4. a create whose clientPunchId disagrees with the document id is REFUSED', async () => {
    await assertFails(setDoc(doc(terminal(), 'inbox/punch-0003'), wellFormed('punch-9999')));
  });

  it('4b. a create missing a required field is REFUSED', async () => {
    await assertFails(setDoc(doc(terminal(), 'inbox/punch-0004'), { clientPunchId: 'punch-0004' }));
  });

  it('4c. a device reads its own events, not another device\'s', async () => {
    const id = 'punch-0005';
    await assertSucceeds(setDoc(doc(terminal(), `inbox/${id}`), wellFormed(id)));
    await assertSucceeds(getDoc(doc(terminal(), `inbox/${id}`)));
    // A human with no deviceId claim: request.auth.token.deviceId is undefined, so the
    // comparison cannot hold and the read is refused.
    await assertFails(getDoc(doc(human(), `inbox/${id}`)));
  });
});

describe('everything else is denied', () => {
  it('an undeclared collection is unreachable in both directions', async () => {
    await assertFails(setDoc(doc(terminal(), 'payroll/secret'), { net: 1 }));
    await assertFails(getDoc(doc(terminal(), 'payroll/secret')));
  });
});

/**
 * T-159 — the ruleset's suite. `docs/tasks/159-firestore-rules-and-device-identity.md`.
 *
 * ⚠️ **Every refusal here was watched failing against a permissive ruleset before it was written.**
 * That is the only evidence the rules are what refuse, and it is what T-153 established as the
 * discipline: landmine #4 is rules that deploy green and silently deny; its mirror image is rules
 * that deploy green and silently ALLOW, which no amount of passing tests would reveal on its own.
 */
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing';
import type { RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';

let env: RulesTestEnvironment;

const LIPA = 'store-lipa';
const MALVAR = 'store-malvar';
const DEVICE = 'terminal-lipa-01';

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'shareat-rules',
    firestore: { rules: readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8182 },
  });
});
afterAll(async () => env?.cleanup());
beforeEach(async () => env.clearFirestore());

/** A provisioned terminal: the claims T-159's provisioning mints. */
const terminal = (deviceId = DEVICE, storeId = LIPA) =>
  env.authenticatedContext(`terminal:${deviceId}`, { deviceId, storeId }).firestore();
/** An ordinary signed-in human — a manager or an admin. No `deviceId` claim, ever. */
const person = () => env.authenticatedContext('person:alice').firestore();
const anonymous = () => env.unauthenticatedContext().firestore();

const seed = (path: string, data: Record<string, unknown>) =>
  env.withSecurityRulesDisabled(async (ctx) => setDoc(doc(ctx.firestore(), path), data));

const event = (id: string, over: Record<string, unknown> = {}) => ({
  clientPunchId: id,
  occurredAt: Date.now(),
  deviceId: DEVICE,
  storeId: LIPA,
  method: 'qr',
  assertedIntent: 'in',
  ...over,
});

// -------------------------------------------------------------------------------------

describe('T-159 invariants 1 & 3 — the roster mirror', () => {
  it('1. a terminal reads its OWN store, and not another', async () => {
    await seed(`mirror/${LIPA}/roster/emp-1`, { staffId: 'SE-001' });
    await seed(`mirror/${MALVAR}/roster/emp-2`, { staffId: 'SE-002' });
    await assertSucceeds(getDoc(doc(terminal(), `mirror/${LIPA}/roster/emp-1`)));
    await assertFails(getDoc(doc(terminal(), `mirror/${MALVAR}/roster/emp-2`)));
  });

  it('3. an ordinary person may read the roster mirror', async () => {
    await seed(`mirror/${LIPA}/roster/emp-1`, { staffId: 'SE-001' });
    await assertSucceeds(getDoc(doc(person(), `mirror/${LIPA}/roster/emp-1`)));
  });

  it('an anonymous caller may read nothing at all', async () => {
    await seed(`mirror/${LIPA}/roster/emp-1`, { staffId: 'SE-001' });
    await assertFails(getDoc(doc(anonymous(), `mirror/${LIPA}/roster/emp-1`)));
  });
});

describe('T-159 invariant 2 — ⛔ the biometric mirror is TERMINAL ONLY', () => {
  it('a terminal of that store can read it', async () => {
    await seed(`biometricMirror/${LIPA}/credentials/emp-1`, { matchToken: 'abc', templates: ['t'] });
    await assertSucceeds(getDoc(doc(terminal(), `biometricMirror/${LIPA}/credentials/emp-1`)));
  });

  it('⭐ a signed-in PERSON cannot — not a manager, not an admin, nobody', async () => {
    // Bible §5.3: "readable only by a provisioned device identity ... never by an ordinary staff or
    // manager account". This is the single most important assertion in the file: it is the fix for
    // the exfiltration class the 2026-07-04 face review found.
    await seed(`biometricMirror/${LIPA}/credentials/emp-1`, { matchToken: 'abc', templates: ['t'] });
    await assertFails(getDoc(doc(person(), `biometricMirror/${LIPA}/credentials/emp-1`)));
  });

  it('a terminal of ANOTHER store cannot', async () => {
    await seed(`biometricMirror/${MALVAR}/credentials/emp-2`, { matchToken: 'def', templates: ['t'] });
    await assertFails(getDoc(doc(terminal(), `biometricMirror/${MALVAR}/credentials/emp-2`)));
  });
});

describe('T-159 invariant 4 — no client writes any mirror path', () => {
  it('neither a terminal nor a person can write the roster or the biometric mirror', async () => {
    await assertFails(setDoc(doc(terminal(), `mirror/${LIPA}/roster/emp-9`), { staffId: 'x' }));
    await assertFails(setDoc(doc(person(), `mirror/${LIPA}/roster/emp-9`), { staffId: 'x' }));
    await assertFails(setDoc(doc(terminal(), `biometricMirror/${LIPA}/credentials/emp-9`), { matchToken: 'x' }));
  });

  it('and cannot update or delete one the publisher wrote', async () => {
    await seed(`mirror/${LIPA}/roster/emp-1`, { staffId: 'SE-001' });
    await assertFails(updateDoc(doc(terminal(), `mirror/${LIPA}/roster/emp-1`), { staffId: 'hacked' }));
    await assertFails(deleteDoc(doc(terminal(), `mirror/${LIPA}/roster/emp-1`)));
  });
});

describe('T-159 invariants 5 & 6 — the inbox is create-only, and speaks only for itself', () => {
  it('a well-formed create succeeds', async () => {
    await assertSucceeds(setDoc(doc(terminal(), 'inbox/p-1'), event('p-1')));
  });

  it('5. a clientPunchId that is not the document id is refused', async () => {
    await assertFails(setDoc(doc(terminal(), 'inbox/p-2'), event('p-9999')));
  });

  it('5. a deviceId that is not the caller is refused', async () => {
    await assertFails(setDoc(doc(terminal(), 'inbox/p-3'), event('p-3', { deviceId: 'someone-else' })));
  });

  it('5. a storeId that is not the caller’s store is refused', async () => {
    await assertFails(setDoc(doc(terminal(), 'inbox/p-4'), event('p-4', { storeId: MALVAR })));
  });

  it('5. a missing required field is refused', async () => {
    await assertFails(setDoc(doc(terminal(), 'inbox/p-5'), { clientPunchId: 'p-5' }));
  });

  it('6. update and delete are refused once created', async () => {
    await assertSucceeds(setDoc(doc(terminal(), 'inbox/p-6'), event('p-6')));
    await assertFails(updateDoc(doc(terminal(), 'inbox/p-6'), { assertedIntent: 'out' }));
    await assertFails(deleteDoc(doc(terminal(), 'inbox/p-6')));
  });

  it('a PERSON cannot write an inbox event at all — punches come from terminals', async () => {
    await assertFails(setDoc(doc(person(), 'inbox/p-7'), event('p-7')));
  });
});

describe('T-159 invariant 7 — ⚠️ rules are not filters', () => {
  it('an UNCONSTRAINED list over the inbox is refused', async () => {
    // T-153 finding 1. The rule cannot be proven to hold for every document the query might
    // return, so Firestore refuses the query rather than filtering it.
    await assertSucceeds(setDoc(doc(terminal(), 'inbox/p-8'), event('p-8')));
    await assertFails(getDocs(query(collection(terminal(), 'inbox'), orderBy('occurredAt'))));
  });

  it('...and the CONSTRAINED one succeeds — the rule and the query are a matched pair', async () => {
    await assertSucceeds(setDoc(doc(terminal(), 'inbox/p-9'), event('p-9')));
    await assertSucceeds(
      getDocs(query(collection(terminal(), 'inbox'), where('deviceId', '==', DEVICE), orderBy('occurredAt'))),
    );
  });

  it('a terminal cannot list ANOTHER device’s events even when it constrains the query', async () => {
    await assertFails(
      getDocs(query(collection(terminal(), 'inbox'), where('deviceId', '==', 'other-device'), orderBy('occurredAt'))),
    );
  });
});

describe('T-159 — everything else is denied', () => {
  it('an undeclared collection is unreachable in both directions', async () => {
    await assertFails(setDoc(doc(terminal(), 'payroll/secret'), { net: 1 }));
    await assertFails(getDoc(doc(person(), 'payroll/secret')));
    await assertFails(getDoc(doc(terminal(), 'clock_terminals/anything')));
  });
});

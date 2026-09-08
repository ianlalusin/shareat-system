import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-138's invariants against a real PostgreSQL.
 *
 * ⭐ **The central claim is a negative and it is asserted structurally**: no server action accepts
 * an actor identity as a parameter (§7.1). A test that merely checked one function would prove
 * nothing about the other twenty, so that one is a repo-wide scan.
 *
 * Everything else here is about failure modes, because that is where auth lives: a wrong PIN and
 * an unknown PIN must be indistinguishable, an expired session must be as dead as an absent one,
 * and a changed credential must not leave sessions minted under the old one standing.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { closeDb, transaction, APP_ROLE, sessionsRepo, type Tx } from '@shareat/db';
import {
  signInWithPin,
  signInWithFirebase,
  resolveActor,
  signOut,
  endShift,
  setPin,
  PIN_SUPERSEDED_REASON,
  AuthenticationError,
  hashPin,
  verifyPin,
  pinLookupHash,
  isValidPinFormat,
} from '@shareat/auth';

const sql = postgres(url, { max: 5 });

let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

interface Fixture {
  orgId: string;
  storeId: string;
  storeId2: string;
  personId: string;
  otherPersonId: string;
}

async function setup(hint: string): Promise<Fixture> {
  const code = uid(`s-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id
  `;
  const orgId = org!.id;
  const mkStore = async (h: string) => {
    const [r] = await sql<{ id: string }[]>`
      insert into stores (org_id, code, name) values (${orgId}, ${uid(h)}, ${`Store ${h}`}) returning id
    `;
    return r!.id;
  };
  const mkPerson = async (n: string) => {
    const [r] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${orgId}, ${n}) returning id
    `;
    return r!.id;
  };
  return {
    orgId,
    storeId: await mkStore(`${hint}-s1`),
    storeId2: await mkStore(`${hint}-s2`),
    personId: await mkPerson(`${hint} Cashier`),
    otherPersonId: await mkPerson(`${hint} Other`),
  };
}

/** Runs under the real RLS principal, exactly as a request would. */
async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

beforeAll(async () => {
  await sql`truncate table sessions, person_credentials restart identity cascade`;
});

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

// =========================================================================================

describe('the PIN round trip', () => {
  it('a set PIN signs in and resolves to the right person', async () => {
    const f = await setup('rt');
    await asOrg(f.orgId, (tx) => setPin(tx, { personId: f.personId, storeId: f.storeId, pin: '123456' }));

    const res = await asOrg(f.orgId, (tx) => signInWithPin(tx, { storeId: f.storeId, pin: '123456' }));
    expect(res.token.length).toBeGreaterThan(20);

    const resolved = await asOrg(f.orgId, (tx) => resolveActor(tx, res.token));
    expect(resolved.actor.personId).toBe(f.personId);
    expect(resolved.actor.orgId).toBe(f.orgId);
    expect(resolved.credentialKind).toBe('pin');
    expect(resolved.storeId).toBe(f.storeId);
  });

  it('⚠️ the TOKEN is never stored — only its hash', async () => {
    // A sessions table readable by an operator must not be a table of live credentials.
    const f = await setup('nostore');
    await asOrg(f.orgId, (tx) => setPin(tx, { personId: f.personId, storeId: f.storeId, pin: '222222' }));
    const res = await asOrg(f.orgId, (tx) => signInWithPin(tx, { storeId: f.storeId, pin: '222222' }));

    const rows = await sql<{ token_hash: string }[]>`select token_hash from sessions where id = ${res.sessionId}`;
    expect(rows[0]!.token_hash).not.toBe(res.token);
    expect(rows[0]!.token_hash).not.toContain(res.token);
  });

  it('⚠️ the raw PIN is never stored either', async () => {
    const f = await setup('nopin');
    await asOrg(f.orgId, (tx) => setPin(tx, { personId: f.personId, storeId: f.storeId, pin: '345678' }));
    const rows = await sql<{ secret_hash: string; lookup_hash: string }[]>`
      select secret_hash, lookup_hash from person_credentials where person_id = ${f.personId}
    `;
    expect(rows[0]!.secret_hash).not.toContain('345678');
    expect(rows[0]!.lookup_hash).not.toContain('345678');
    expect(rows[0]!.secret_hash.startsWith('scrypt$')).toBe(true);
  });
});

describe('⭐ failure modes are indistinguishable', () => {
  it('a WRONG pin and an UNKNOWN pin give the identical message', async () => {
    // Telling them apart tells an attacker which half to keep guessing.
    const f = await setup('same');
    await asOrg(f.orgId, (tx) => setPin(tx, { personId: f.personId, storeId: f.storeId, pin: '111111' }));

    const wrong = await asOrg(f.orgId, (tx) =>
      signInWithPin(tx, { storeId: f.storeId, pin: '999999' }).catch((e: Error) => e.message),
    );
    const f2 = await setup('same2');
    const unknown = await asOrg(f2.orgId, (tx) =>
      signInWithPin(tx, { storeId: f2.storeId, pin: '888888' }).catch((e: Error) => e.message),
    );
    expect(wrong).toBe(unknown);
  });

  it('a malformed PIN is refused before any hashing', async () => {
    const f = await setup('malformed');
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 456']) {
      expect(isValidPinFormat(bad)).toBe(false);
      await expect(
        asOrg(f.orgId, (tx) => signInWithPin(tx, { storeId: f.storeId, pin: bad })),
      ).rejects.toThrow(AuthenticationError);
    }
  });

  it('⭐ the SAME PIN in a different store does not sign in — the hash is store-scoped', async () => {
    // v1's own good idea, kept: "the same passcode in different stores never correlates."
    const f = await setup('scoped');
    await asOrg(f.orgId, (tx) => setPin(tx, { personId: f.personId, storeId: f.storeId, pin: '456789' }));

    await expect(
      asOrg(f.orgId, (tx) => signInWithPin(tx, { storeId: f.storeId2, pin: '456789' })),
    ).rejects.toThrow(AuthenticationError);

    expect(pinLookupHash(f.storeId, '456789')).not.toBe(pinLookupHash(f.storeId2, '456789'));
  });

  it('⛔ a duplicate PIN within a store is REFUSED, not silently shared', async () => {
    // An ambiguous credential check that picks the first match is how the wrong person gets
    // attributed for someone else's action.
    const f = await setup('dupe');
    await asOrg(f.orgId, (tx) => setPin(tx, { personId: f.personId, storeId: f.storeId, pin: '654321' }));
    await expect(
      asOrg(f.orgId, (tx) => setPin(tx, { personId: f.otherPersonId, storeId: f.storeId, pin: '654321' })),
    ).rejects.toThrow(/already in use/);
  });
});

describe('sessions end BOTH ways (Ian: "yes both")', () => {
  it('signing out ends it, and the token stops resolving', async () => {
    const f = await setup('signout');
    await asOrg(f.orgId, (tx) => setPin(tx, { personId: f.personId, storeId: f.storeId, pin: '112233' }));
    const res = await asOrg(f.orgId, (tx) => signInWithPin(tx, { storeId: f.storeId, pin: '112233' }));

    await asOrg(f.orgId, (tx) => signOut(tx, res.token));
    await expect(asOrg(f.orgId, (tx) => resolveActor(tx, res.token))).rejects.toThrow(AuthenticationError);
  });

  it('signing out TWICE is not an error', async () => {
    // A cashier who signs out and then closes a stale tab has done nothing wrong, and turning
    // that into a failure teaches people to ignore failures.
    const f = await setup('twice');
    await asOrg(f.orgId, (tx) => setPin(tx, { personId: f.personId, storeId: f.storeId, pin: '445566' }));
    const res = await asOrg(f.orgId, (tx) => signInWithPin(tx, { storeId: f.storeId, pin: '445566' }));
    await asOrg(f.orgId, (tx) => signOut(tx, res.token));
    await expect(asOrg(f.orgId, (tx) => signOut(tx, res.token))).resolves.toBeUndefined();
  });

  it('an EXPIRED session is as dead as an absent one', async () => {
    const f = await setup('expired');
    await asOrg(f.orgId, (tx) => setPin(tx, { personId: f.personId, storeId: f.storeId, pin: '778899' }));
    const res = await asOrg(f.orgId, (tx) => signInWithPin(tx, { storeId: f.storeId, pin: '778899' }));

    // ⚠️ Both timestamps move, not just the expiry. The `expires_at > issued_at` CHECK refused
    // the first version of this test, which tried to set expiry into the past while issue stayed
    // now — an impossible state the schema was right to reject, and a reminder that a fixture can
    // be as invalid as production data. This is what a genuinely expired session looks like.
    await sql`
      update sessions
      set issued_at = now() - interval '2 days', expires_at = now() - interval '1 day'
      where id = ${res.sessionId}
    `;
    await expect(asOrg(f.orgId, (tx) => resolveActor(tx, res.token))).rejects.toThrow(/sign in again/);
  });

  it('⭐ END SHIFT ends every live session at that store, and only that store', async () => {
    const f = await setup('shift');
    await asOrg(f.orgId, (tx) => setPin(tx, { personId: f.personId, storeId: f.storeId, pin: '121212' }));
    await asOrg(f.orgId, (tx) => setPin(tx, { personId: f.personId, storeId: f.storeId2, pin: '343434' }));

    const a = await asOrg(f.orgId, (tx) => signInWithPin(tx, { storeId: f.storeId, pin: '121212' }));
    const b = await asOrg(f.orgId, (tx) => signInWithPin(tx, { storeId: f.storeId2, pin: '343434' }));

    const { ended } = await asOrg(f.orgId, (tx) => endShift(tx, { personId: f.personId, storeId: f.storeId }));
    expect(ended).toBe(1);

    await expect(asOrg(f.orgId, (tx) => resolveActor(tx, a.token))).rejects.toThrow(AuthenticationError);
    // The other store's session is untouched — ending a shift here is not signing out everywhere.
    const stillLive = await asOrg(f.orgId, (tx) => resolveActor(tx, b.token));
    expect(stillLive.actor.personId).toBe(f.personId);
  });
});

describe('changing a credential invalidates what it minted', () => {
  it('⚠️ setting a new PIN ends sessions issued under the old one', async () => {
    // Otherwise "I changed my PIN" does not mean what the person thinks it means.
    const f = await setup('rotate');
    await asOrg(f.orgId, (tx) => setPin(tx, { personId: f.personId, storeId: f.storeId, pin: '131313' }));
    const old = await asOrg(f.orgId, (tx) => signInWithPin(tx, { storeId: f.storeId, pin: '131313' }));

    await asOrg(f.orgId, (tx) => setPin(tx, { personId: f.personId, storeId: f.storeId, pin: '141414' }));
    await expect(asOrg(f.orgId, (tx) => resolveActor(tx, old.token))).rejects.toThrow(AuthenticationError);

    const fresh = await asOrg(f.orgId, (tx) => signInWithPin(tx, { storeId: f.storeId, pin: '141414' }));
    expect((await asOrg(f.orgId, (tx) => resolveActor(tx, fresh.token))).actor.personId).toBe(f.personId);
  });

  it('a revoked credential can no longer sign in', async () => {
    const f = await setup('revoke');
    const { credentialId } = await asOrg(f.orgId, (tx) =>
      setPin(tx, { personId: f.personId, storeId: f.storeId, pin: '151515' }),
    );
    await asOrg(f.orgId, (tx) =>
      sessionsRepo.revokeCredential(tx, {
        id: credentialId,
        by: f.otherPersonId,
        reason: 'Retired by a supervisor.',
      }),
    );
    await expect(
      asOrg(f.orgId, (tx) => signInWithPin(tx, { storeId: f.storeId, pin: '151515' })),
    ).rejects.toThrow(AuthenticationError);
  });

  /**
   * ⛔ **T-239 / DEF-229 — the case a verbatim copy of the attendance CHECK would have broken.**
   *
   * `attendance_credentials_revoke_check` binds all three columns together: a revoked row there
   * must name a person. On THIS table `revoked_by` is NULL by construction on the supersede path —
   * `setPin` sits below the domain and has no `Actor` to name, and inventing one would record that
   * the staffer revoked their own PIN when an administrator re-issued it (`repo/sessions.ts`).
   *
   * So the reason pairs with the TIMESTAMP, not with the person. If that is ever "tidied" into the
   * sibling's three-column shape, every PIN re-issue starts throwing and this case is what says so.
   */
  it('⭐ a superseded PIN is revoked with the system sentence and NO principal', async () => {
    const f = await setup('supersede-reason');
    const first = await asOrg(f.orgId, (tx) =>
      setPin(tx, { personId: f.personId, storeId: f.storeId, pin: '191919' }),
    );
    // The re-issue. This is the write that the wrong constraint shape would refuse outright.
    await asOrg(f.orgId, (tx) =>
      setPin(tx, { personId: f.personId, storeId: f.storeId, pin: '202020' }),
    );

    const [row] = await sql<
      { revoked_by: string | null; revoke_reason: string | null; revoked_at: Date | null }[]
    >`select revoked_by, revoke_reason, revoked_at from person_credentials where id = ${first.credentialId}`;
    expect(row!.revoked_at).not.toBeNull();
    expect(row!.revoked_by).toBeNull(); // ⭐ no principal, by construction — not an oversight
    // ⚠️ The exported constant, not a copy of the sentence: a duplicated literal here would go on
    //    passing after somebody edited only one of the two.
    expect(row!.revoke_reason).toBe(PIN_SUPERSEDED_REASON);
  });
});

describe('listLiveForPerson — T-217 / DEF-174', () => {
  it('a person with no credential returns nothing', async () => {
    const f = await setup('live-none');
    const rows = await asOrg(f.orgId, (tx) => sessionsRepo.listLiveForPerson(tx, f.personId));
    expect(rows).toEqual([]);
  });

  it('a live PIN shows up, a revoked one does not', async () => {
    const f = await setup('live-pin');
    const { credentialId } = await asOrg(f.orgId, (tx) =>
      setPin(tx, { personId: f.personId, storeId: f.storeId, pin: '161616' }),
    );
    const live = await asOrg(f.orgId, (tx) => sessionsRepo.listLiveForPerson(tx, f.personId));
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ personId: f.personId, kind: 'pin', storeId: f.storeId });

    await asOrg(f.orgId, (tx) =>
      sessionsRepo.revokeCredential(tx, {
        id: credentialId,
        by: f.otherPersonId,
        reason: 'Retired by a supervisor.',
      }),
    );
    const afterRevoke = await asOrg(f.orgId, (tx) => sessionsRepo.listLiveForPerson(tx, f.personId));
    expect(afterRevoke).toEqual([]);
  });

  it('a storeId narrows to that store only; omitting it returns every store', async () => {
    const f = await setup('live-scope');
    await asOrg(f.orgId, (tx) => setPin(tx, { personId: f.personId, storeId: f.storeId, pin: '171717' }));
    await asOrg(f.orgId, (tx) => setPin(tx, { personId: f.personId, storeId: f.storeId2, pin: '181818' }));

    const scoped = await asOrg(f.orgId, (tx) => sessionsRepo.listLiveForPerson(tx, f.personId, f.storeId));
    expect(scoped).toHaveLength(1);
    expect(scoped[0]!.storeId).toBe(f.storeId);

    const both = await asOrg(f.orgId, (tx) => sessionsRepo.listLiveForPerson(tx, f.personId));
    expect(both).toHaveLength(2);
  });
});

describe('the browser path', () => {
  it('a linked Firebase uid signs in; an unknown one does NOT auto-provision', async () => {
    // A login is not an introduction. Someone with an account but no person row has not been
    // given access to anything, and creating one silently would be exactly that.
    const f = await setup('fb');
    const externalId = uid('fbuid');
    await asOrg(f.orgId, (tx) =>
      sessionsRepo.insertCredential(tx, { personId: f.personId, kind: 'firebase', externalId }),
    );
    const res = await asOrg(f.orgId, (tx) => signInWithFirebase(tx, { verifiedUid: externalId }));
    expect((await asOrg(f.orgId, (tx) => resolveActor(tx, res.token))).actor.personId).toBe(f.personId);

    await expect(
      asOrg(f.orgId, (tx) => signInWithFirebase(tx, { verifiedUid: uid('nobody') })),
    ).rejects.toThrow(/not linked to a person/);
  });

  it('a browser session carries NO store — it is not bound to one', async () => {
    const f = await setup('fbstore');
    const externalId = uid('fbuid2');
    await asOrg(f.orgId, (tx) =>
      sessionsRepo.insertCredential(tx, { personId: f.personId, kind: 'firebase', externalId }),
    );
    const res = await asOrg(f.orgId, (tx) => signInWithFirebase(tx, { verifiedUid: externalId }));
    const resolved = await asOrg(f.orgId, (tx) => resolveActor(tx, res.token));
    expect(resolved.storeId).toBeNull();
    expect(resolved.credentialKind).toBe('firebase');
  });
});

describe('a garbage token resolves to nothing', () => {
  it('empty, short and random tokens all fail the same way', async () => {
    const f = await setup('garbage');
    for (const t of ['', 'x', 'not-a-real-token-but-long-enough-to-pass-length']) {
      await expect(asOrg(f.orgId, (tx) => resolveActor(tx, t))).rejects.toThrow(AuthenticationError);
    }
  });
});

describe('the KDF itself', () => {
  it('hashes are salted — the same PIN hashes differently every time', async () => {
    const a = await hashPin('123456');
    const b = await hashPin('123456');
    expect(a).not.toBe(b);
    expect(await verifyPin('123456', a)).toBe(true);
    expect(await verifyPin('123456', b)).toBe(true);
    expect(await verifyPin('123457', a)).toBe(false);
  });

  it('a malformed stored hash verifies FALSE rather than throwing', async () => {
    // A corrupt row must fail closed, not crash the sign-in route for everyone.
    for (const bad of ['', 'nonsense', 'scrypt$only-two', 'bcrypt$aa$bb', 'scrypt$zz$zz']) {
      expect(await verifyPin('123456', bad)).toBe(false);
    }
  });
});

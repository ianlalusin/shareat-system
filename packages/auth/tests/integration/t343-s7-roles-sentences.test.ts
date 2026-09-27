import { config } from 'dotenv';
import { describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-343 S7 — change 3 (`roles.ts`'s three better admin sentences). `docs/tasks/343-def-417-human-
 * readable-refusals.md` §S7. Same fixture idiom as `roles.test.ts` (`insertOrg`/`insertPerson`/
 * `insertRoleRaw`/`giveCredential`/`actorOf`/`asPerson`) — a fresh, uid-suffixed org per case, no
 * shared truncate: `roles.test.ts`'s own module-scope `beforeAll` truncate is that file's, not
 * repeated here (this file never runs in the same process as a truncate that could race it).
 *
 * ⛔ TESTER, not BUILDER. All three throw sites still carry the S5a `userMessage` ("An actor may
 * not…", "Refusing to demote…") — Ian's internal vocabulary Option A (2026-09-27) replaces the
 * third argument of exactly these three `AuthorizationError` throws with the sentences below. R1
 * is red until then. R1n (`.message` and `capability`, both untouched by change 3) is already true.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
}
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

import { transaction, APP_ROLE, type Tx } from '@shareat/db';
import { assignRoleAsActor, AuthorizationError, grantCapabilityAsActor, type Actor, type Role } from '@shareat/auth';

const sql = postgres(url, { max: 5 });

async function asPerson<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

let seq = 0;
const uid = (prefix: string) => `${prefix}-${Date.now()}-${++seq}`;

async function insertOrg(hint: string): Promise<string> {
  const code = uid(`s7-roles-${hint}`);
  const [row] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  return row!.id;
}

async function insertPerson(orgId: string, name: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
  return row!.id;
}

async function insertRoleRaw(personId: string, orgId: string, role: Role): Promise<void> {
  await sql`insert into person_roles (person_id, org_id, role) values (${personId}, ${orgId}, ${role})`;
}

async function giveCredential(personId: string): Promise<void> {
  await sql`insert into person_credentials (person_id, kind, external_id) values (${personId}, 'firebase', ${uid('cred')})`;
}

const actorOf = (personId: string, orgId: string): Actor => ({ personId, orgId });

// The literal contract (S7 change 3) — typed in here because it IS the contract, not derived from
// the source under test.
const SELF_ROLE_SENTENCE = 'You cannot change your own role. Ask another admin — this is what stops one mis-click locking the org out.';
const SELF_GRANT_SENTENCE =
  'You cannot give yourself a capability. Ask another admin, so nobody can widen their own authority without someone else approving it.';
const LAST_ADMIN_SENTENCE =
  "This is the org's only active admin who can sign in. Appoint another admin or super admin and give them a PIN or an email account first — otherwise nobody is left who can manage users.";

function userMessageOf(err: unknown): string | undefined {
  return (err as { userMessage?: string } | null)?.userMessage;
}

describe('R1 — the three admin sentences from change 3', () => {
  it(
    'self role: assignRoleAsActor on self → SELF_ROLE_SENTENCE',
    async () => {
      const org = await insertOrg('self-role');
      const admin = await insertPerson(org, 'Admin');
      await insertRoleRaw(admin, org, 'admin');

      const caught = await asPerson(org, (tx) => assignRoleAsActor(tx, actorOf(admin, org), { personId: admin, role: 'staff' })).then(
        () => null,
        (e: unknown) => e as AuthorizationError,
      );

      expect(caught, 'self role-change was not refused at all').not.toBeNull();
      expect(caught).toBeInstanceOf(AuthorizationError);
      expect(userMessageOf(caught)).toBe(SELF_ROLE_SENTENCE);
    },
    30000,
  );

  it(
    'self grant: grantCapabilityAsActor on self → SELF_GRANT_SENTENCE',
    async () => {
      const org = await insertOrg('self-grant');
      const admin = await insertPerson(org, 'Admin');
      await insertRoleRaw(admin, org, 'admin');

      const caught = await asPerson(org, (tx) =>
        grantCapabilityAsActor(tx, actorOf(admin, org), { personId: admin, capability: 'post_journal_entry' }),
      ).then(
        () => null,
        (e: unknown) => e as AuthorizationError,
      );

      expect(caught, 'self-grant was not refused at all').not.toBeNull();
      expect(caught).toBeInstanceOf(AuthorizationError);
      expect(userMessageOf(caught)).toBe(SELF_GRANT_SENTENCE);
    },
    30000,
  );

  it(
    'last admin: demoting the org\'s only credentialed admin → LAST_ADMIN_SENTENCE',
    async () => {
      // Same fixture shape as `roles.test.ts`'s "REFUSES demoting a SUPER_ADMIN when nobody able to
      // sign in is left" case: the actor is a peer (super_admin) with NO credential of their own,
      // so DEF-234's rank check passes and the lockout guard is the thing that fires.
      const org = await insertOrg('last-admin');
      const actorAdmin = await insertPerson(org, 'Super Admin With No Way In');
      await insertRoleRaw(actorAdmin, org, 'super_admin');
      const onlySuper = await insertPerson(org, 'Only Super');
      await insertRoleRaw(onlySuper, org, 'super_admin');
      await giveCredential(onlySuper);

      const caught = await asPerson(org, (tx) =>
        assignRoleAsActor(tx, actorOf(actorAdmin, org), { personId: onlySuper, role: 'staff' }),
      ).then(
        () => null,
        (e: unknown) => e as AuthorizationError,
      );

      expect(caught, 'the demotion was not refused at all').not.toBeNull();
      expect(caught).toBeInstanceOf(AuthorizationError);
      expect(userMessageOf(caught)).toBe(LAST_ADMIN_SENTENCE);
    },
    30000,
  );
});

describe('R1n (⛔ green now) — .message and .capability, untouched by change 3', () => {
  it(
    'self role: .message and .capability are unchanged',
    async () => {
      const org = await insertOrg('self-role-n');
      const admin = await insertPerson(org, 'Admin');
      await insertRoleRaw(admin, org, 'admin');

      const caught = await asPerson(org, (tx) => assignRoleAsActor(tx, actorOf(admin, org), { personId: admin, role: 'staff' })).then(
        () => null,
        (e: unknown) => e as AuthorizationError,
      );

      expect(caught).not.toBeNull();
      expect(caught!.message).toBe(
        'assignRoleAsActor: an actor may not change their own role — ask another admin, so a mistake here cannot lock the org out',
      );
      expect(caught!.capability).toBe('manage_users');
    },
    30000,
  );

  it(
    'self grant: .message and .capability are unchanged',
    async () => {
      const org = await insertOrg('self-grant-n');
      const admin = await insertPerson(org, 'Admin');
      await insertRoleRaw(admin, org, 'admin');

      const caught = await asPerson(org, (tx) =>
        grantCapabilityAsActor(tx, actorOf(admin, org), { personId: admin, capability: 'post_journal_entry' }),
      ).then(
        () => null,
        (e: unknown) => e as AuthorizationError,
      );

      expect(caught).not.toBeNull();
      expect(caught!.message).toBe(
        'grantCapabilityAsActor: an actor may not grant themselves a capability — ask another admin, so nobody can widen their own authority',
      );
      expect(caught!.capability).toBe('grant_capability');
    },
    30000,
  );

  it(
    'last admin: .message and .capability are unchanged',
    async () => {
      const org = await insertOrg('last-admin-n');
      const actorAdmin = await insertPerson(org, 'Super Admin With No Way In');
      await insertRoleRaw(actorAdmin, org, 'super_admin');
      const onlySuper = await insertPerson(org, 'Only Super');
      await insertRoleRaw(onlySuper, org, 'super_admin');
      await giveCredential(onlySuper);

      const caught = await asPerson(org, (tx) =>
        assignRoleAsActor(tx, actorOf(actorAdmin, org), { personId: onlySuper, role: 'staff' }),
      ).then(
        () => null,
        (e: unknown) => e as AuthorizationError,
      );

      expect(caught).not.toBeNull();
      expect(caught!.message).toBe(
        "assignRoleAsActor: refusing to demote this org's only active admin who can sign in — appoint another admin or super_admin who holds a credential first, or the org is left with nobody able to manage users",
      );
      expect(caught!.capability).toBe('manage_users');
    },
    30000,
  );
});

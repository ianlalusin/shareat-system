import { config } from 'dotenv';
import { describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-159 — provisioning, activation and revocation.
 * `docs/tasks/159-firestore-rules-and-device-identity.md`.
 *
 * The RULES half is proved in `firebase/rules.test.ts` against the emulator. What is tested here is
 * the half Postgres owns: who may provision, what "ready" means, and that revocation is a
 * server-side act rather than a hope.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { APP_ROLE, transaction, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import {
  activateTerminal,
  isReady,
  listTerminals,
  mintTerminalToken,
  provisionTerminal,
  revokeTerminal,
  type TerminalIdentityDriver,
} from '@shareat/domain';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

/** Records what the real Firebase driver would have been asked to do. */
function fakeDriver() {
  const minted: { firebaseUid: string; claims: Record<string, unknown> }[] = [];
  const disabled: string[] = [];
  const driver: TerminalIdentityDriver = {
    async mintCustomToken(input) {
      minted.push(input);
      return `custom-token-for-${input.firebaseUid}`;
    },
    async disable(firebaseUid) {
      disabled.push(firebaseUid);
    },
  };
  return { driver, minted, disabled };
}

async function fixture(hint: string) {
  const code = uid(`ct-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const [admin] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${admin!.id}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${admin!.id}, ${store!.id})`;
  return { orgId, storeId: store!.id, admin: actor(orgId, admin!.id), adminPersonId: admin!.id };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const provision = (f: Fixture, d: TerminalIdentityDriver, label = 'Counter tablet') =>
  asOrg(f.orgId, (tx) => provisionTerminal(tx, f.admin, d, { storeId: f.storeId, label }));

// -------------------------------------------------------------------------------------

describe('T-159 invariants 9 & 10 — provisioning, and what "ready" means', () => {
  it('⭐ a provisioned terminal is NOT ready until it has signed in once', async () => {
    // T-180 finding 3: a device cannot begin authenticating offline. Carrying a freshly provisioned
    // tablet out of signal before its first sign-in leaves it unable to write a single punch, so
    // "provisioned" and "ready" have to be different states or the screen will lie.
    const f = await fixture('ready');
    const { driver } = fakeDriver();
    const { terminal } = await provision(f, driver);

    expect(terminal.activatedAt).toBeNull();
    expect(isReady(terminal)).toBe(false);

    const activated = await asOrg(f.orgId, (tx) => activateTerminal(tx, { terminalId: terminal.id }));
    expect(activated.activatedAt).not.toBeNull();
    expect(isReady(activated)).toBe(true);
  });

  it('activating twice is idempotent and does not move the timestamp', async () => {
    const f = await fixture('idem');
    const { driver } = fakeDriver();
    const { terminal } = await provision(f, driver);
    const first = await asOrg(f.orgId, (tx) => activateTerminal(tx, { terminalId: terminal.id }));
    const second = await asOrg(f.orgId, (tx) => activateTerminal(tx, { terminalId: terminal.id }));
    expect(second.activatedAt?.getTime()).toBe(first.activatedAt?.getTime());
  });

  it('⛔ 10. the custom token is returned, and stored NOWHERE', async () => {
    const f = await fixture('no-store');
    const { driver } = fakeDriver();
    const { terminal, customToken } = await provision(f, driver);
    expect(customToken).toContain(terminal.firebaseUid);

    // Nothing on the row, and no column anywhere that could hold it.
    const cols = await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns where table_name = 'clock_terminals'`;
    const names = cols.map((c) => c.column_name);
    expect(names).not.toContain('secret');
    expect(names).not.toContain('token');
    expect(names).not.toContain('custom_token');

    const row = await sql`select * from clock_terminals where id = ${terminal.id}`;
    expect(JSON.stringify(row)).not.toContain(customToken);
  });

  it('the deviceId claim IS the terminal id — one identifier end to end', async () => {
    const f = await fixture('claims');
    const { driver, minted } = fakeDriver();
    const { terminal } = await provision(f, driver);
    expect(minted).toHaveLength(1);
    expect(minted[0]!.claims).toEqual({
      deviceId: terminal.id,
      storeId: f.storeId,
      orgId: f.orgId,
    });
    expect(terminal.firebaseUid).toBe(`terminal:${terminal.id}`);
  });

  it('a blank label is refused — it is how a manager finds the device again', async () => {
    const f = await fixture('label');
    const { driver } = fakeDriver();
    await expect(provision(f, driver, '   ')).rejects.toThrow(/label/i);
  });
});

describe('T-159 invariant 8 — revocation is a server-side act', () => {
  it('⭐ revoking DISABLES the Firebase user, so the next token refresh fails', async () => {
    const f = await fixture('revoke');
    const { driver, disabled } = fakeDriver();
    const { terminal } = await provision(f, driver);
    await asOrg(f.orgId, (tx) => activateTerminal(tx, { terminalId: terminal.id }));

    const revoked = await asOrg(f.orgId, (tx) =>
      revokeTerminal(tx, f.admin, driver, { terminalId: terminal.id, reason: 'Tablet lost in transit' }),
    );

    // ⚠️ The point: the device is not asked to cooperate. Nothing is sent to it.
    expect(disabled).toEqual([terminal.firebaseUid]);
    expect(revoked.revokedAt).not.toBeNull();
    expect(revoked.revokedBy).toBe(f.adminPersonId);
    expect(revoked.revokeReason).toMatch(/lost in transit/);
    expect(isReady(revoked)).toBe(false);
  });

  it('revoking without a reason is refused', async () => {
    const f = await fixture('reason');
    const { driver } = fakeDriver();
    const { terminal } = await provision(f, driver);
    await expect(
      asOrg(f.orgId, (tx) => revokeTerminal(tx, f.admin, driver, { terminalId: terminal.id, reason: ' ' })),
    ).rejects.toThrow(/reason/i);
  });

  it('a revoked terminal cannot be re-minted or re-activated', async () => {
    const f = await fixture('dead');
    const { driver } = fakeDriver();
    const { terminal } = await provision(f, driver);
    await asOrg(f.orgId, (tx) =>
      revokeTerminal(tx, f.admin, driver, { terminalId: terminal.id, reason: 'Retired' }),
    );
    await expect(
      asOrg(f.orgId, (tx) => mintTerminalToken(tx, f.admin, driver, { terminalId: terminal.id })),
    ).rejects.toThrow(/revoked/i);
    await expect(
      asOrg(f.orgId, (tx) => activateTerminal(tx, { terminalId: terminal.id })),
    ).rejects.toThrow(/revoked/i);
  });

  it('the revoked row survives, with who and why — it is the audit trail', async () => {
    const f = await fixture('audit');
    const { driver } = fakeDriver();
    const { terminal } = await provision(f, driver);
    await asOrg(f.orgId, (tx) =>
      revokeTerminal(tx, f.admin, driver, { terminalId: terminal.id, reason: 'Stolen' }),
    );
    const rows = await sql`select id from clock_terminals where id = ${terminal.id}`;
    expect(rows).toHaveLength(1);
  });

  it('a partial revocation is unrepresentable', async () => {
    const f = await fixture('triple');
    const { driver } = fakeDriver();
    const { terminal } = await provision(f, driver);
    await expect(sql`update clock_terminals set revoked_at = now() where id = ${terminal.id}`)
      .rejects.toThrow(/revoked_triple|check/i);
  });
});

describe('T-159 — re-pairing keeps the identity', () => {
  it('⭐ a wiped device is re-minted with the SAME deviceId, so its history stays attached', async () => {
    const f = await fixture('repair');
    const { driver, minted } = fakeDriver();
    const { terminal } = await provision(f, driver);
    await asOrg(f.orgId, (tx) => mintTerminalToken(tx, f.admin, driver, { terminalId: terminal.id }));
    expect(minted).toHaveLength(2);
    expect(minted[1]!.claims.deviceId).toBe(terminal.id);
    expect(minted[1]!.firebaseUid).toBe(minted[0]!.firebaseUid);
  });
});

describe('T-159 §7 — the capability, and the ✗ that must fire', () => {
  it('⛔ a staff-role person cannot provision a terminal', async () => {
    const f = await fixture('authz');
    const { driver } = fakeDriver();
    const [s] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${f.orgId}, 'Floor') returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${s!.id}, ${f.orgId}, 'staff')`;
    await sql`insert into person_store_scope (person_id, store_id) values (${s!.id}, ${f.storeId})`;

    await expect(
      asOrg(f.orgId, (tx) =>
        provisionTerminal(tx, actor(f.orgId, s!.id), driver, { storeId: f.storeId, label: 'Sneaky' }),
      ),
    ).rejects.toThrow();
  });

  it('⭐ and manage_attendance alone does NOT grant it — the capabilities are separate', async () => {
    // Landmine #9: in v1, widening one operation on a route granted ALL of them. The whole reason
    // provision_clock_terminal is its own capability is that it creates an identity able to read
    // biometric templates, so holding the attendance capability must not imply it.
    const f = await fixture('separate');
    const { driver } = fakeDriver();
    const [p] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${f.orgId}, 'Deputy') returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${f.orgId}, 'staff')`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${f.storeId})`;
    await sql`insert into person_grants (person_id, grant_name) values (${p!.id}, 'manage_attendance')`;

    await expect(
      asOrg(f.orgId, (tx) =>
        provisionTerminal(tx, actor(f.orgId, p!.id), driver, { storeId: f.storeId, label: 'Nope' }),
      ),
    ).rejects.toThrow();

    // ...and the same person CAN list terminals, which is manage_attendance.
    await expect(
      asOrg(f.orgId, (tx) => listTerminals(tx, actor(f.orgId, p!.id), { storeId: f.storeId })),
    ).resolves.toBeInstanceOf(Array);
  });
});

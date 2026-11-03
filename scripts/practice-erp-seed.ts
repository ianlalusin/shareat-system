/**
 * PRACTICE ERP seed - a FAKE company ("Practice Co") in the throwaway database, for the practice POS (apps/pos/emulator/PRACTICE.md).
 * Run through `node scripts/practice-erp-start.mjs seed` (never directly): that starter forces DATABASE_URL to the practice database and refuses
 * anything that is not a local `_test` database. This file re-checks the name itself.
 *
 * It uses the real domain functions (bootstrapOrganization, createSalesChannel, createPerson, assignRoleAsActor, grantCapabilityAsActor,
 * linkStoreToPos, provisionPosTerminalLink). Re-running is safe: every step skips what already exists. `--device=<uuid>` re-links the tablet.
 * Every login and PIN below is made up and exists only in this database.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { closeDb, systemTransaction, type Tx } from '../packages/db/src/client';
import { withOrgPrincipal } from '../packages/db/src/rls/principal';
import * as personsRepo from '../packages/db/src/repo/persons';
import * as sessionsRepo from '../packages/db/src/repo/sessions';
import * as accessRepo from '../packages/db/src/repo/access';
import * as salesDaysRepo from '../packages/db/src/repo/sales-days';
import { setPin } from '../packages/auth/src/sessions';
import { assignRoleAsActor, grantCapabilityAsActor } from '../packages/auth/src/roles';
import { bootstrapOrganization } from '../packages/domain/src/organizations';
import { createPerson } from '../packages/domain/src/people';
import { createSalesChannel } from '../packages/domain/src/sales-channels';
import { linkStoreToPos } from '../packages/domain/src/pos/store-link';
import { provisionPosTerminalLink } from '../packages/domain/src/pos/terminal-link';

const PIN = { admin: '135790', manager: '246801', cashier: '112358' } as const;
const POS_STORE_ID = 'practice-store'; // the Firestore store id in apps/pos/scripts/seed-practice.mjs
const DEFAULT_DEVICE = '00000000-0000-4000-8000-000000000c71';
const TERMINAL_EMAIL = 'terminal@erp.test';
const TERMINAL_PASSWORD = 'Practice-2026!';
const AUTH_PORT = process.env.POS_EMULATOR_AUTH_PORT || '9189';
const OUT_DIR = join(process.cwd(), 'apps', 'pos', 'emulator', '.practice');

const dbName = (process.env.DATABASE_URL ?? '').split('?')[0]!.split('/').pop() ?? '';
if (!/_test/.test(dbName)) throw new Error(`practice-erp-seed: refusing, "${dbName}" is not a _test database.`);

const device =
  (process.argv.find((a) => a.startsWith('--device=')) ?? '').slice('--device='.length).trim().toLowerCase() || DEFAULT_DEVICE;

async function emulatorUid(): Promise<string | null> {
  const base = `http://127.0.0.1:${AUTH_PORT}/identitytoolkit.googleapis.com/v1/accounts:`;
  const key = '?key=emulator-only-not-a-real-key';
  const body = JSON.stringify({ email: TERMINAL_EMAIL, password: TERMINAL_PASSWORD, returnSecureToken: true });
  try {
    for (const op of ['signUp', 'signInWithPassword']) {
      const r = await fetch(base + op + key, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      if (r.ok) return ((await r.json()) as { localId: string }).localId;
    }
  } catch {
    /* emulator not running: the terminal gets a placeholder uid until the seed is run again */
  }
  return null;
}

type Rows<T> = T[];

async function main() {
  // 1. Company, admin, store (one transaction, the same function /setup calls).
  const firstOrg = async () =>
    (await systemTransaction((tx) => tx.execute(sql`select id from organizations order by created_at limit 1`))) as unknown as Rows<{ id: string }>;
  let org = await firstOrg();
  if (org.length === 0) {
    await systemTransaction((tx) =>
      bootstrapOrganization(tx, {
        code: 'PRACTICE',
        name: 'Practice Co',
        adminDisplayName: 'Ian Practice',
        storeCode: 'PRAC',
        storeName: 'Practice Branch',
        pin: PIN.admin,
      }),
    );
    org = await firstOrg();
  }
  const orgId = org[0]!.id;
  const ids = await systemTransaction(async (tx) => {
    const [store] = (await tx.execute(sql`select id from stores where org_id = ${orgId} and code = 'PRAC'`)) as unknown as Rows<{ id: string }>;
    const [admin] = (await tx.execute(sql`select id from persons where org_id = ${orgId} and display_name = 'Ian Practice'`)) as unknown as Rows<{ id: string }>;
    if (!store || !admin) throw new Error('practice-erp-seed: this database holds another company (no store PRAC / person "Ian Practice"). Use a fresh practice database.');
    return { storeId: store.id, adminId: admin.id };
  });
  const adminActor = { personId: ids.adminId, orgId };
  const as = <T>(fn: (tx: Tx) => Promise<T>) => withOrgPrincipal(orgId, fn);

  // 2. Sales channels: Cash (money reaches the till) + three that settle to the bank later (receivable 1220).
  const channelIds: Record<string, string> = {};
  for (const ch of [
    { name: 'Cash', remitted: true },
    { name: 'GCash', remitted: false },
    { name: 'GrabFood', remitted: false },
    { name: 'Foodpanda', remitted: false },
  ]) {
    channelIds[ch.name] = await as(async (tx) => {
      const existing = await salesDaysRepo.channelByNormalisedName(tx, orgId, ids.storeId, ch.name);
      if (existing) return existing.id;
      const made = await createSalesChannel(tx, adminActor, {
        storeId: ids.storeId,
        name: ch.name,
        isRemittedDaily: ch.remitted,
        receivableAccountCode: ch.remitted ? null : '1220',
      });
      return made.channelId;
    });
  }

  // 3. Manager (PIN + approve_pos_correction at the store) and cashier.
  async function ensurePerson(displayName: string, role: 'manager' | 'staff', pin: string): Promise<string> {
    return as(async (tx) => {
      const [found] = (await tx.execute(sql`select id from persons where org_id = ${orgId} and display_name = ${displayName}`)) as unknown as Rows<{ id: string }>;
      if (found) return found.id;
      const person = await createPerson(tx, adminActor, { storeId: ids.storeId, displayName });
      await assignRoleAsActor(tx, adminActor, { personId: person.id, role });
      await accessRepo.grantStoreScope(tx, { personId: person.id, storeId: ids.storeId, grantedBy: ids.adminId, source: 'manual' });
      await setPin(tx, { orgId, personId: person.id, storeId: ids.storeId, pin, actorPersonId: ids.adminId });
      return person.id;
    });
  }
  const managerId = await ensurePerson('Practice Manager', 'manager', PIN.manager);
  const cashierId = await ensurePerson('Practice Cashier', 'staff', PIN.cashier);
  await as(async (tx) => {
    const held = (await tx.execute(
      sql`select 1 from person_grants where person_id = ${managerId} and grant_name = 'approve_pos_correction' and revoked_at is null`,
    )) as unknown as Rows<unknown>;
    if (held.length === 0) await grantCapabilityAsActor(tx, adminActor, { personId: managerId, capability: 'approve_pos_correction' });
  });

  // 4. The tablet as a terminal person credentialed to the store (its Firebase login is a local emulator account).
  const uid = (await emulatorUid()) ?? `practice-terminal-${randomUUID()}`;
  const terminalId = await as(async (tx) => {
    const [found] = (await tx.execute(
      sql`select id from persons where org_id = ${orgId} and kind = 'terminal' limit 1`,
    )) as unknown as Rows<{ id: string }>;
    if (found) {
      await tx.execute(sql`update person_credentials set external_id = ${uid} where person_id = ${found.id} and kind = 'firebase' and revoked_at is null`);
      return found.id;
    }
    const person = await personsRepo.insertPerson(tx, { orgId, displayName: 'Terminal - Practice Branch', kind: 'terminal' });
    await sessionsRepo.insertCredential(tx, { personId: person.id, kind: 'firebase', storeId: ids.storeId, externalId: uid });
    return person.id;
  });

  // 5. Link the ERP store to the POS store id, then register the tablet's device id.
  await as(async (tx) => {
    const live = (await tx.execute(
      sql`select 1 from pos_v1_store_links where org_id = ${orgId} and store_id = ${ids.storeId} and unlinked_at is null`,
    )) as unknown as Rows<unknown>;
    if (live.length === 0) {
      await linkStoreToPos(tx, adminActor, {
        storeId: ids.storeId,
        posStoreId: POS_STORE_ID,
        posStoreName: 'Practice Branch',
        salesChannelId: channelIds.Cash!,
        posTaxType: 'vat_inclusive',
      });
    }
  });
  const linkedNow = await as(async (tx) => {
    const cur = (await tx.execute(
      sql`select device_id from pos_terminal_links where org_id = ${orgId} and store_id = ${ids.storeId} and revoked_at is null`,
    )) as unknown as Rows<{ device_id: string }>;
    if (cur[0]?.device_id === device) return false;
    await provisionPosTerminalLink(tx, adminActor, { storeId: ids.storeId, terminalNo: 1, deviceId: device, terminalPersonId: terminalId });
    return true;
  });

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'org-id.txt'), orgId + '\n');
  writeFileSync(
    join(OUT_DIR, 'practice-erp.json'),
    JSON.stringify({ orgId, ...ids, managerId, cashierId, terminalId, channelIds, terminalUid: uid, deviceId: device }, null, 2),
  );
  console.log(`practice ERP seeded in ${dbName}: org ${orgId}, store ${ids.storeId}, admin ${ids.adminId}, manager ${managerId}, tablet device ${device} (${linkedNow ? 'linked now' : 'already linked'})`);
  console.log('ids written to apps/pos/emulator/.practice/ (org-id.txt, practice-erp.json). Restart the practice POS once if org-id.txt changed.');
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => closeDb());

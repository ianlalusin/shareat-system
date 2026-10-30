/**
 * T-500 shared fixture: a franchisor org plus a "Padre Garcia" company created by the REAL onboardFranchiseOrganization from the MOCK file.
 * PG's admin = Ian's PG person (org admin, scoped to the PG store). PG's owner = the store-scoped manager with no employment row.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type postgres from 'postgres';

import { systemTransaction, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { sql as dsql } from 'drizzle-orm';
import type { Actor } from '@shareat/auth';
import { createFirstAdmin, createOrganization, onboardFranchiseOrganization } from '../../../src/organizations';
import { parseOnboardingFile, type OnboardingFile } from '../../../src/organizations/onboarding-file';

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..', '..');
const MOCK = JSON.parse(readFileSync(join(repoRoot, 'scripts', 'fixtures', 'onboarding', 'MOCK-padre-garcia.onboarding.json'), 'utf8'));
let seq = 0;
export const tag = () => `${Date.now().toString(36)}${++seq}${Math.floor(Math.random() * 1e4)}`.toUpperCase();
export const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

export async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

/** Ian's company (the franchisor), onboard PG under it, return every id a test needs. */
export async function mkPg(sql: postgres.Sql) {
  const t = tag();
  const code = `T500L${t}`;
  const fr = await systemTransaction(async (tx) => {
    const org = await createOrganization(tx, { code, name: `T500 Franchisor ${t}` });
    const admin = await createFirstAdmin(tx, { orgId: org.orgId, displayName: `T500 Ian ${t}` });
    return { orgId: org.orgId, adminId: admin.personId };
  });
  const raw = {
    ...MOCK,
    franchisorOrgCode: code,
    org: { code: `T500PG${t}`, name: `T500 Padre Garcia Foods ${t}` },
    store: { ...MOCK.store, code: `T5G${t}`, name: `T500 SharEat Padre Garcia ${t}`, posStoreId: `T500-POS-${t}` },
    franchisorPerson: { ...MOCK.franchisorPerson, email: `franchisor.${t.toLowerCase()}@example.test` },
    owner: { ...MOCK.owner, email: `owner.${t.toLowerCase()}@example.test` },
    staff: [{ last: 'Mock', first: `Cook${t}`, middle: 'Q', position: 'Kitchen Staff' }],
  };
  const file = parseOnboardingFile(raw) as OnboardingFile;
  await onboardFranchiseOrganization({ file, byPersonId: fr.adminId }, { dryRun: false });
  const [org] = await sql<{ id: string }[]>`select id from organizations where code = ${file.org.code}`;
  const pgOrgId = org!.id;
  const [store] = await sql<{ id: string }[]>`select id from stores where org_id = ${pgOrgId}`;
  const [adm] = await sql<{ id: string }[]>`
    select p.id from persons p join person_roles r on r.person_id = p.id and r.org_id = ${pgOrgId} and r.role = 'admin' where p.org_id = ${pgOrgId}`;
  const [own] = await sql<{ id: string }[]>`
    select p.id from persons p join person_roles r on r.person_id = p.id and r.org_id = ${pgOrgId} and r.role = 'manager' where p.org_id = ${pgOrgId}`;
  const [emp] = await sql<{ id: string; person_id: string }[]>`select id, person_id from employments where org_id = ${pgOrgId} limit 1`;
  return {
    franchisor: fr, franchisorCode: code, file, pgOrgId, storeId: store!.id,
    pgAdminId: adm!.id, ownerId: own!.id, employmentId: emp!.id, workerId: emp!.person_id,
    pgAdmin: actor(pgOrgId, adm!.id), owner: actor(pgOrgId, own!.id), worker: actor(pgOrgId, emp!.person_id),
    ian: actor(fr.orgId, fr.adminId),
  };
}
export type Pg = Awaited<ReturnType<typeof mkPg>>;

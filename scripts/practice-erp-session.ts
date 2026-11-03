/**
 * Practice ERP only: mints a one-hour ERP session token for a practice person and prints it (for curl / smoke checks:
 * `curl -b "shareat_session=<token>" http://127.0.0.1:9008/`). Same bypass as the orchestrator's forge-session-for-person tool, same guard:
 * it refuses unless DATABASE_URL names a `_test` database. Run it through `node scripts/practice-erp-start.mjs session <personId>`.
 */
import { sql } from 'drizzle-orm';
import { closeDb, systemTransaction } from '../packages/db/src/client';
import * as sessionsRepo from '../packages/db/src/repo/sessions';
import { newSessionToken, sessionTokenHash } from '../packages/auth/src/credentials';

const dbName = (process.env.DATABASE_URL ?? '').split('?')[0]!.split('/').pop() ?? '';
if (!/_test/.test(dbName)) throw new Error(`practice-erp-session: refusing, "${dbName}" is not a _test database.`);
const personId: string = process.argv[2] ?? '';
if (!personId) throw new Error('usage: node scripts/practice-erp-start.mjs session <personId>');

async function main() {
  const token = await systemTransaction(async (tx) => {
    const rows = (await tx.execute(sql`
      select c.id as credential_id, c.kind as credential_kind from person_credentials c
      where c.person_id = ${personId} and c.revoked_at is null order by c.created_at desc limit 1
    `)) as unknown as { credential_id: string; credential_kind: 'pin' | 'firebase' | 'biometric' }[];
    const row = rows[0];
    if (!row) throw new Error('that person has no live credential');
    const t = newSessionToken();
    await sessionsRepo.insertSession(tx, {
      tokenHash: sessionTokenHash(t),
      personId,
      credentialId: row.credential_id,
      credentialKind: row.credential_kind,
      storeId: null,
      deviceId: null,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    return t;
  });
  console.log(token);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => closeDb());

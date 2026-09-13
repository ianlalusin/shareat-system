/**
 * `npm run provision-terminal` — creates the store-terminal credential T-304's layer 1 needs.
 *
 * docs/tasks/304-two-layer-terminal-sign-in.md §"SCOPE CORRECTION". Without this script there is
 * no way to create a terminal credential after T-304 deploys, and PIN sign-in stays dead —
 * shipped, green, and unusable. Shaped like `scripts/bootstrap-org.ts`: a one-shot that writes to
 * the live database, run by a person, not by an agent, dry-run by default.
 *
 *   npm run provision-terminal -- --store=LIPA --uid=<firebase-uid> --confirm
 *
 * ⛔ **Ian creates the email/password account in the Firebase console first** — that part is not
 * ours and cannot be scripted here (no service account, `firebase-auth-admin.ts`'s own header).
 * This script only links the uid it produces to a store, as a terminal-kind `persons` row plus a
 * `kind='firebase'` credential (option (a), T-304 §Q1).
 *
 * ⛔ **No defaults, `--confirm` required, one transaction** — the same three guards
 * `bootstrap-org.ts` states and for the same reasons: a default is how the wrong store gets a
 * shared password quietly, and a half-written credential is worse than none.
 */
import { config } from 'dotenv';

config({ path: '.env.local' });

import { sql } from 'drizzle-orm';
import { closeDb, systemTransaction, type Tx } from '../packages/db/src/client';
import * as personsRepo from '../packages/db/src/repo/persons';
import * as sessionsRepo from '../packages/db/src/repo/sessions';

interface Args {
  storeCode: string;
  uid: string;
  confirm: boolean;
}

const USAGE = `
Usage:
  npm run provision-terminal -- --store=LIPA --uid=<firebase-uid> [--confirm]

Both --store and --uid are REQUIRED and have no default.
Without --confirm the script prints the plan and writes nothing.
`;

function parseArgs(argv: readonly string[]): Args {
  const raw = new Map<string, string>();
  let confirm = false;
  for (const arg of argv) {
    if (arg === '--confirm') {
      confirm = true;
      continue;
    }
    const match = /^--([a-z-]+)=([\s\S]*)$/.exec(arg);
    if (!match) throw new Error(`provision-terminal: unrecognised argument "${arg}".\n${USAGE}`);
    raw.set(match[1]!, match[2]!);
  }
  const required = (key: string): string => {
    const value = raw.get(key)?.trim();
    if (!value) throw new Error(`provision-terminal: --${key} is required and has no default.\n${USAGE}`);
    return value;
  };
  return { storeCode: required('store'), uid: required('uid'), confirm };
}

interface StoreLookup {
  id: string;
  orgId: string;
  name: string;
}

/** ⚠️ Not `stores.getById` — that needs the org already, and this script's only input is a code.
 *  Fine only because `systemTransaction` bypasses RLS (a script run by a person, not a request)
 *  and because this project is one organisation today (T-304's own text). A second organisation
 *  would need `--org=` added here — flagged rather than pre-built for a case that does not exist. */
async function findStoreByCode(tx: Tx, code: string): Promise<StoreLookup | undefined> {
  const [row] = (await tx.execute(sql`
    select id, org_id, name from stores where code = ${code} limit 1
  `)) as unknown as { id: string; org_id: string; name: string }[];
  return row ? { id: row.id, orgId: row.org_id, name: row.name } : undefined;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('provision-terminal: DATABASE_URL is not set. Expected it in .env.local.');
  const args = parseArgs(process.argv.slice(2));

  const store = await systemTransaction((tx) => findStoreByCode(tx, args.storeCode));
  if (!store) {
    console.error(`REFUSED: no store with code "${args.storeCode}". Nothing was written.`);
    process.exitCode = 1;
    return;
  }

  const alreadyHasOne = await systemTransaction((tx) =>
    sessionsRepo.hasLiveTerminalCredentialForStore(tx, store.id),
  );

  console.log('');
  console.log('provision-terminal — the plan');
  console.log('─────────────────────────────────────────────────────────────');
  console.log(`  store               : ${store.name}  (code ${args.storeCode})`);
  console.log(`  firebase uid        : ${args.uid}`);
  console.log(`  terminal person     : NEW persons row, kind = 'terminal'`);
  console.log(`  credential          : NEW person_credentials row, kind = 'firebase'`);
  console.log('─────────────────────────────────────────────────────────────');

  if (alreadyHasOne) {
    console.error('');
    console.error(`REFUSED: ${args.storeCode} already has a live terminal credential.`);
    console.error('Revoke it first (an admin action, T-304 §"the lost-tablet runbook") before');
    console.error('provisioning a new one for the same store. Nothing was written.');
    process.exitCode = 1;
    return;
  }

  if (!args.confirm) {
    console.log('');
    console.log('DRY RUN — nothing was written. Re-run with --confirm to do it.');
    return;
  }

  const result = await systemTransaction(async (tx) => {
    const person = await personsRepo.insertPerson(tx, {
      orgId: store.orgId,
      displayName: `Terminal — ${store.name}`,
      kind: 'terminal',
    });
    const { id: credentialId } = await sessionsRepo.insertCredential(tx, {
      personId: person.id,
      kind: 'firebase',
      storeId: store.id,
      externalId: args.uid,
    });
    return { personId: person.id, credentialId };
  });

  console.log('');
  console.log('DONE — committed.');
  console.log(`  terminal person id  : ${result.personId}`);
  console.log(`  credential id       : ${result.credentialId}`);
  console.log('The tablet can now sign in at layer 1 with the Firebase account you created.');
}

main()
  .catch((err) => {
    console.error('');
    console.error('provision-terminal FAILED:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });

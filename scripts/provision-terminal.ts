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
 * ## T-424: registering a POS v2 TABLET for manager approvals (`--link-pos-device`)
 *
 * A POS v2 tablet approves refunds with a store manager's ERP PIN. A wrong PIN is charged to the TABLET's own bucket, so the tablet must be an
 * ERP terminal person (this script's normal mode creates one) AND be linked to its device id (the line on POS v2 > Settings). Link it with:
 *
 *   npm run provision-terminal -- --store=LIPA --link-pos-device=<device uuid> --terminal-no=1 --terminal-person=<person id> --admin=<admin person id> --confirm
 *
 * It calls `provisionPosTerminalLink` (capability `provision_clock_terminal`, so the --admin person must be an administrator; audited). A
 * re-install makes a new device id: run it again with the new id and the store's old link is revoked in the same transaction.
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
import { withOrgPrincipal } from '../packages/db/src/rls/principal';
import * as posTerminalLinksRepo from '../packages/db/src/repo/pos-terminal-links';
import { provisionPosTerminalLink, revokePosTerminalLink } from '../packages/domain/src/pos/terminal-link';

interface Args {
  storeCode: string;
  /** T-398 S7e: the company the store belongs to. REQUIRED when the same code exists in more than one company (K8). */
  orgId?: string;
  uid: string;
  confirm: boolean;
  /** T-424: set when linking a POS v2 tablet instead of creating a terminal person. */
  link: { deviceId: string; terminalNo: number; terminalPersonId: string; adminPersonId: string } | null;
  /** T-424 audit: revoke a tablet's link by device id. */
  revoke?: { deviceId: string; adminPersonId: string };
}

const USAGE = `
Usage:
  npm run provision-terminal -- --store=LIPA --uid=<firebase-uid> [--confirm]
  npm run provision-terminal -- --store=LIPA --link-pos-device=<uuid> --terminal-no=1 --terminal-person=<id> --admin=<id> [--confirm]
  npm run provision-terminal -- --store=LIPA --revoke-pos-device=<uuid> --admin=<id> [--confirm]

--store is REQUIRED, and so is --uid (or the four --link-pos-device options); nothing has a default.
--org=<company uuid> is needed only when the same store code exists in more than one company; the script refuses and says so rather than guess.
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
  const org = raw.get('org')?.trim();
  if (raw.has('org') && !(org && UUID_RE.test(org))) {
    throw new Error(`provision-terminal: --org must be a company id (a uuid).
${USAGE}`);
  }
  const withOrg = <T extends object>(a: T): T & { orgId?: string } => (org ? { ...a, orgId: org.toLowerCase() } : a);
  const required = (key: string): string => {
    const value = raw.get(key)?.trim();
    if (!value) throw new Error(`provision-terminal: --${key} is required and has no default.\n${USAGE}`);
    return value;
  };
  if (raw.has('revoke-pos-device')) {
    return withOrg({ storeCode: required('store'), uid: '', confirm, link: null, revoke: { deviceId: required('revoke-pos-device').toLowerCase(), adminPersonId: required('admin') } });
  }
  if (raw.has('link-pos-device')) {
    const terminalNo = Number(required('terminal-no'));
    if (!Number.isInteger(terminalNo) || terminalNo < 1 || terminalNo > 99) throw new Error(`provision-terminal: --terminal-no must be a whole number from 1 to 99.
${USAGE}`);
    return withOrg({
      storeCode: required('store'),
      uid: '',
      confirm,
      link: { deviceId: required('link-pos-device'), terminalNo, terminalPersonId: required('terminal-person'), adminPersonId: required('admin') },
    });
  }
  return withOrg({ storeCode: required('store'), uid: required('uid'), confirm, link: null });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface StoreLookup {
  id: string;
  orgId: string;
  name: string;
}

/** ⚠️ Not `stores.getById` — that needs the org already, and this script's input is a code (plus, since T-398 S7e, an optional company).
 *  `systemTransaction` bypasses RLS (a script run by a person, not a request), so every company's stores are visible: with two companies a code
 *  can match twice. Without `--org` that is `ambiguous` (never `limit 1`: it silently picked one); with `--org` only that company's store counts. */
async function findStoreByCode(tx: Tx, code: string, orgId?: string): Promise<StoreLookup | 'ambiguous' | undefined> {
  const rows = (await (orgId
    ? tx.execute(sql`select id, org_id, name from stores where code = ${code} and org_id = ${orgId} limit 2`)
    : tx.execute(sql`select id, org_id, name from stores where code = ${code} limit 2`))) as unknown as { id: string; org_id: string; name: string }[];
  if (rows.length > 1) return 'ambiguous';
  const row = rows[0];
  return row ? { id: row.id, orgId: row.org_id, name: row.name } : undefined;
}

/**
 * /code-review finding — a non-blank `SYSTEM_DATABASE_URL` is not enough: it can still connect
 * under a role without the bypass-RLS privilege, under which every store looks missing (silently,
 * via RLS) rather than loudly refusing. Mirrors `scripts/backfill-canonical-positions.ts`'s
 * `currentRole()`, which already queries this for the same reason — but only informs. DEF-337's
 * disposition is "refuse, never warn" (RULES §1 rule 7 / bible §13 row 201), so this REFUSES
 * instead, and does so BEFORE the first store lookup: a lookup that already ran under the wrong
 * role has already produced its silent, misleading "not found".
 */
async function assertSystemRoleBypassesRls(): Promise<void> {
  const [row] = (await systemTransaction((tx) =>
    tx.execute(sql`select rolbypassrls from pg_roles where rolname = current_user`),
  )) as unknown as { rolbypassrls: boolean }[];
  if (!row?.rolbypassrls) {
    throw new Error(
      'provision-terminal: SYSTEM_DATABASE_URL connects, but its role does not have rolbypassrls. Without it the store lookup runs under the RLS-enforcing role and every store looks missing. Nothing was written.',
    );
  }
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('provision-terminal: DATABASE_URL is not set. Expected it in .env.local.');
  const systemUrl = process.env.SYSTEM_DATABASE_URL;
  if (systemUrl === undefined || systemUrl.trim() === '') {
    throw new Error(
      'provision-terminal: SYSTEM_DATABASE_URL is not set (or blank). Without it the store lookup runs under the RLS-enforcing role and every store looks missing. Locally, set it to the same value as DATABASE_URL. Nothing was written.',
    );
  }
  const args = parseArgs(process.argv.slice(2));

  await assertSystemRoleBypassesRls();

  const found0 = await systemTransaction((tx) => findStoreByCode(tx, args.storeCode, args.orgId));
  if (found0 === 'ambiguous') {
    console.error(`REFUSED: the store code "${args.storeCode}" is used by more than one company, so it is ambiguous. Re-run with --org=<company id>. Nothing was written.`);
    process.exitCode = 1;
    return;
  }
  const store = found0;
  if (!store) {
    console.error(`REFUSED: no store with code "${args.storeCode}". Nothing was written.`);
    process.exitCode = 1;
    return;
  }

  if (args.revoke) {
    const rev = args.revoke;
    const found = await withOrgPrincipal(store.orgId, (tx) => posTerminalLinksRepo.getActiveLinkByDevice(tx, store.orgId, rev.deviceId));
    if (!found || found.storeId !== store.id) {
      console.error(`REFUSED: no active POS v2 link for device ${rev.deviceId} at ${store.name}. Nothing was written.`);
      process.exitCode = 1;
      return;
    }
    console.log(`provision-terminal - REVOKE the POS v2 link of device ${rev.deviceId} at ${store.name} (approvals on that tablet stop until it is registered again)`);
    if (!args.confirm) {
      console.log('DRY RUN - nothing was written. Re-run with --confirm to do it.');
      return;
    }
    const done = await withOrgPrincipal(store.orgId, (tx) => revokePosTerminalLink(tx, { personId: rev.adminPersonId, orgId: store.orgId }, { linkId: found.id }));
    console.log(`DONE - committed. Revoked link id ${done.linkId}`);
    return;
  }

  if (args.link) {
    const link = args.link;
    console.log('');
    console.log('provision-terminal - link a POS v2 tablet (T-424)');
    console.log('─────────────────────────────────────────────────────────────');
    console.log(`  store               : ${store.name}  (code ${args.storeCode})`);
    console.log(`  device id           : ${link.deviceId}`);
    console.log(`  terminal no         : ${link.terminalNo}`);
    console.log(`  terminal person     : ${link.terminalPersonId}`);
    console.log(`  approved by (admin) : ${link.adminPersonId}`);
    console.log("  effect              : the store's previous POS v2 tablet link, if any, is revoked");
    console.log('─────────────────────────────────────────────────────────────');
    if (!args.confirm) {
      console.log('');
      console.log('DRY RUN - nothing was written. Re-run with --confirm to do it.');
      return;
    }
    const done = await withOrgPrincipal(store.orgId, (tx) =>
      provisionPosTerminalLink(tx, { personId: link.adminPersonId, orgId: store.orgId }, {
        storeId: store.id,
        terminalNo: link.terminalNo,
        deviceId: link.deviceId,
        terminalPersonId: link.terminalPersonId,
      }),
    );
    console.log('');
    console.log('DONE - committed.');
    console.log(`  link id             : ${done.linkId}`);
    if (done.revokedLinkId) console.log(`  revoked link id     : ${done.revokedLinkId}`);
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

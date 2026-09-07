/**
 * `npm run bootstrap-org` — turns an empty database into an organization somebody can sign into.
 *
 * T-228, `docs/tasks/228-organization-bootstrap.md`, closing DEF-195. Until this script existed
 * nothing in the codebase had ever created an organization: production held zero, and
 * `shareat-finding-observation.service` exited 1 nightly with *"no orgs were processed"* against a
 * live, migrated database. The four dev orgs and stores were put there by a person typing SQL.
 *
 *   npm run bootstrap-org -- --code=SHAREAT_OPC --name="SHAREAT OPC" \
 *                            --admin="<the person's real name>" \
 *                            --store-code=LIPA --store-name="SharEat Lipa" \
 *                            [--pin=NNNNNN] --confirm
 *
 * ## ⛔ Its guards are the INVERSE of `dev-seed.ts`'s, and that is deliberate
 *
 * `dev-seed.ts` refuses to run against anything but a `*_dev` database, because a seed script that
 * can reach production is a liability. **This script is *designed* to reach production**, so the
 * same guard would be exactly backwards. What replaces it:
 *
 *   - **No defaults for any argument.** Every value is typed by the person running it. There is no
 *     `SHAREAT_OPC` fallback anywhere in this file — a default is how the wrong organization gets
 *     created quietly.
 *   - **`--confirm` is required**, and without it the script prints the plan and exits 0. The dry
 *     run is the default: seeing the plan is free, committing to it is deliberate.
 *   - **A duplicate code is refused**, so a double-run is a no-op rather than a second org.
 *   - **All five steps run in ONE transaction.** A bootstrap that half-succeeds leaves an
 *     organization nobody can sign into *and* no way to re-run, because `createFirstAdmin` would
 *     then refuse the retry.
 *
 * ## ⛔ The PIN is printed once, to stdout, and this script must never be given a systemd unit
 *
 * `docs/ops/*.service` units redirect stdout to `/var/log/shareat/*.log`. This script prints a live
 * credential exactly once and is run **by hand**; under a unit that credential would be written to
 * a log file and would stay there. It is not scheduled, it is not idempotent in a useful way for a
 * timer, and there is nothing for one to do. **Do not write a unit for it.**
 */
import { randomInt } from 'node:crypto';
import { config } from 'dotenv';

config({ path: '.env.local' });

import { isValidPinFormat } from '../packages/auth/src/credentials';
import { setPin } from '../packages/auth/src/sessions';
import { closeDb, transaction } from '../packages/db/src/client';
import * as organizationsRepo from '../packages/db/src/repo/organizations';
import { createFirstAdmin, createOrganization } from '../packages/domain/src/organizations';
import { createStore } from '../packages/domain/src/stores/service';

/**
 * ⚠️ Copied from `scripts/dev-seed.ts:43`, not imported: that function is not exported and
 * `dev-seed.ts` is out of T-228's scope. Its comment is the part that matters and is reproduced
 * here — **deliberately not a URL parse.** A connection string whose password contains an `@` can
 * defeat `new URL()`, and this project's production password does contain one. The only part being
 * read is the path segment. ⛔ Never hand-split the URL with `replace()` either; that has already
 * produced a confidently wrong claim in a pushed document.
 */
function databaseNameOf(url: string): string {
  const withoutQuery = url.split('?')[0]!;
  const lastSlash = withoutQuery.lastIndexOf('/');
  return lastSlash === -1 ? '' : withoutQuery.slice(lastSlash + 1);
}

interface Args {
  code: string;
  name: string;
  admin: string;
  storeCode: string;
  storeName: string;
  pin: string;
  /** True when the PIN was generated here rather than supplied. Changes only what the plan says. */
  pinGenerated: boolean;
  confirm: boolean;
}

const USAGE = `
Usage:
  npm run bootstrap-org -- --code=SHAREAT_OPC --name="SHAREAT OPC" \\
                           --admin="Full Name" \\
                           --store-code=LIPA --store-name="SharEat Lipa" \\
                           [--pin=NNNNNN] [--confirm]

Every argument except --pin and --confirm is REQUIRED and has no default.
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
    if (!match) throw new Error(`bootstrap-org: unrecognised argument "${arg}".\n${USAGE}`);
    raw.set(match[1]!, match[2]!);
  }

  const required = (key: string): string => {
    const value = raw.get(key)?.trim();
    if (!value) {
      throw new Error(`bootstrap-org: --${key} is required and has no default.\n${USAGE}`);
    }
    return value;
  };

  const supplied = raw.get('pin')?.trim();
  // ⛔ Validated BEFORE anything else runs. `setPin` refuses a malformed PIN, and finding that out
  // *after* creating an organization is a bad time to learn it.
  if (supplied !== undefined && !isValidPinFormat(supplied)) {
    throw new Error('bootstrap-org: --pin must be exactly 6 digits.');
  }
  // ⛔ `crypto.randomInt`, never `Math.random` — this is a credential, not a sample.
  const pin = supplied ?? String(randomInt(0, 1_000_000)).padStart(6, '0');
  if (!isValidPinFormat(pin)) {
    throw new Error('bootstrap-org: generated PIN failed validation — refusing to continue.');
  }

  return {
    code: required('code'),
    name: required('name'),
    admin: required('admin'),
    storeCode: required('store-code'),
    storeName: required('store-name'),
    pin,
    pinGenerated: supplied === undefined,
    confirm,
  };
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('bootstrap-org: DATABASE_URL is not set. Expected it in .env.local.');
  }
  const args = parseArgs(process.argv.slice(2));
  const dbName = databaseNameOf(url);

  // ⚠️ A read, on every path, including the dry run — so the plan can say "this will be refused"
  // before anyone types --confirm. The UNIQUE constraint remains the actual guarantee.
  const existing = await transaction((tx) => organizationsRepo.getOrgByCode(tx, args.code));

  console.log('');
  console.log('bootstrap-org — the plan');
  console.log('─────────────────────────────────────────────────────────────');
  console.log(`  database            : ${dbName}`);
  console.log(`  organization        : ${args.name}  (code ${args.code})`);
  console.log(`  chart of accounts   : seeded for this org`);
  console.log(`  expense categories  : seeded for this org`);
  console.log(`  first admin         : ${args.admin}  (role admin, granted_by NULL)`);
  console.log(`  first store         : ${args.storeName}  (code ${args.storeCode})`);
  console.log(`                        + its default room, + store scope for that admin`);
  console.log(`  terminal PIN        : ${args.pinGenerated ? 'generated, shown once below' : 'the one you supplied'}`);
  console.log('  all of it in ONE transaction — it all lands or none of it does');
  console.log('─────────────────────────────────────────────────────────────');

  if (existing) {
    console.error('');
    console.error(
      `REFUSED: an organization with code "${args.code}" already exists ("${existing.name}").`,
    );
    console.error('Organization codes are unique and permanent. Nothing was written.');
    process.exitCode = 1;
    return;
  }

  if (!args.confirm) {
    console.log('');
    console.log('DRY RUN — nothing was written. Re-run with --confirm to do it.');
    if (args.pinGenerated) {
      console.log('The PIN is generated at the moment of the real run, and printed once, there.');
    }
    return;
  }

  const result = await transaction(async (tx) => {
    // 1-3. The org, its chart, its categories.
    const org = await createOrganization(tx, { code: args.code, name: args.name });
    // 4. The first admin — the base case of the authority chain, granted_by NULL.
    const admin = await createFirstAdmin(tx, { orgId: org.orgId, displayName: args.admin });
    // 5. The first store, through T-222's tested path. ⭐ Its §C.2 fan-out writes the
    //    person_store_scope row, so this script never touches an access table beyond the role.
    const store = await createStore(
      tx,
      { personId: admin.personId, orgId: org.orgId },
      { code: args.storeCode, name: args.storeName },
    );
    // 6. The PIN — possible only now, because the store exists.
    await setPin(tx, { personId: admin.personId, storeId: store.storeId, pin: args.pin });
    return { ...org, ...admin, ...store };
  });

  console.log('');
  console.log('DONE — committed.');
  console.log(`  organization id     : ${result.orgId}`);
  console.log(`  accounts seeded     : ${result.accountsSeeded}`);
  console.log(`  categories seeded   : ${result.categoriesSeeded}`);
  console.log(`  admin person id     : ${result.personId}`);
  console.log(`  store id            : ${result.storeId}`);
  console.log(`  default room id     : ${result.locationId}`);
  console.log(`  admins scoped       : ${result.scopedAdminIds.length}`);
  console.log('');
  console.log('Sign in with:');
  console.log(`  store               : ${args.storeName}  (${args.storeCode})`);
  console.log(`  person              : ${args.admin}`);
  console.log(`  PIN                 : ${args.pin}`);
  console.log('');
  console.log('⛔ That PIN is shown ONCE and is not recoverable — only its hash is stored.');
  console.log('   Change it from the app once you are in.');
  console.log('');
  console.log('Next: create the remaining stores through /admin/stores, which is the supported');
  console.log('path and a real production smoketest of T-222 on its first day.');
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(() => closeDb());

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
 *   - **Any existing organization is refused**, so a double-run is a no-op rather than a second
 *     org. ⚠️ Since T-232 this is stricter than it was: the rule is *first run happens once*, not
 *     *codes are unique*, so a second organisation under a NEW code is refused too.
 *   - **Every step runs in ONE transaction.** A bootstrap that half-succeeds leaves an
 *     organization nobody can sign into *and* no way to re-run, because `createFirstAdmin` would
 *     then refuse the retry.
 *
 * ## ⭐ Since T-232, this script is a FALLBACK — `/setup` is the primary path
 *
 * The supported way to stand an organisation up is to sign in with an email and password on
 * `/setup`, in a browser. This script exists for the case that cannot: no Firebase identity yet, no
 * browser reachable, or a recovery. **Both call the one `bootstrapOrganization` function**, so the
 * two paths cannot drift — a step added to first-run setup is added to both, or to neither.
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
import { SUPER_ADMIN_ONLY_CAPABILITIES } from '../packages/auth/src/capabilities';
import { closeDb, systemTransaction, transaction } from '../packages/db/src/client';
import * as organizationsRepo from '../packages/db/src/repo/organizations';
// ⭐ T-232 slice 2 — ONE function, two callers. `/setup` calls exactly this, so the screen and the
// CLI cannot drift: adding a step to first-run setup is adding it to both, or to neither.
import { bootstrapOrganization } from '../packages/domain/src/organizations';

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
  // before anyone types --confirm.
  //
  // ⭐ It asks the question `bootstrapOrganization` will actually ask (**any** organization?),
  // not the narrower one this script used to ask (**this code**?). Since T-232 the binding rule is
  // first-run-happens-once, so a dry run checking only the code would have reported a clean plan
  // and then been refused on --confirm. `getOrgByCode` is still read, but only to name the
  // existing organisation in the message.
  const alreadySetUp = await transaction((tx) => organizationsRepo.anyOrganizationExists(tx));
  const sameCode = alreadySetUp
    ? await transaction((tx) => organizationsRepo.getOrgByCode(tx, args.code))
    : undefined;

  console.log('');
  console.log('bootstrap-org — the plan');
  console.log('─────────────────────────────────────────────────────────────');
  console.log(`  database            : ${dbName}`);
  console.log(`  organization        : ${args.name}  (code ${args.code})`);
  console.log(`  chart of accounts   : seeded for this org`);
  console.log(`  expense categories  : seeded for this org`);
  console.log(`  first admin         : ${args.admin}  (role admin, granted_by NULL)`);
  // ⛔ Printed from the DERIVED set, never a hand-typed count — the plan has to describe what will
  // actually be written, and "four" is true only until the matrix changes.
  console.log(`  owner capabilities  : ${SUPER_ADMIN_ONLY_CAPABILITIES.join(', ')}`);
  console.log(`                        (what super_admin has and admin does not, as grant rows)`);
  console.log(`  first store         : ${args.storeName}  (code ${args.storeCode})`);
  console.log(`                        + its default room, + store scope for that admin`);
  console.log(`  terminal PIN        : ${args.pinGenerated ? 'generated, shown once below' : 'the one you supplied'}`);
  console.log('  all of it in ONE transaction — it all lands or none of it does');
  console.log('─────────────────────────────────────────────────────────────');

  if (alreadySetUp) {
    console.error('');
    console.error('REFUSED: this system already has an organization, so first-run setup is closed.');
    if (sameCode) {
      console.error(`         The code "${args.code}" is taken too ("${sameCode.name}").`);
    }
    console.error('Add people through /admin/users and stores through /admin/stores.');
    console.error('Nothing was written.');
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

  // ⭐ ONE call. The ordering, the advisory lock, the zero-organization refusal, the PIN-format
  // check, the org, the chart, the categories, the first admin's role and grants, the store, its
  // room, the store scope and the PIN all live in `bootstrapOrganization` — which is also exactly
  // what `/setup` calls. ⛔ Nothing may be added here that is not added there too; a step this
  // script performed on its own would be a step the screen silently skipped.
  //
  // ⚠️ No `firebaseUid`: the CLI has no verified browser identity to link, and inventing one is
  // the thing `signInWithFirebase` refuses — *"a login is not an introduction."* The person signs
  // in with the PIN below; linking an email account later is `/admin/users`' job.
  const result = await systemTransaction((tx) =>
    bootstrapOrganization(tx, {
      code: args.code,
      name: args.name,
      adminDisplayName: args.admin,
      storeCode: args.storeCode,
      storeName: args.storeName,
      pin: args.pin,
    }),
  );

  console.log('');
  console.log('DONE — committed.');
  console.log(`  organization id     : ${result.orgId}`);
  console.log(`  accounts seeded     : ${result.accountsSeeded}`);
  console.log(`  categories seeded   : ${result.categoriesSeeded}`);
  console.log(`  admin person id     : ${result.personId}`);
  // ⭐ Reported, never silent — these are real authority rows, and a power granted invisibly is
  // indistinguishable from one granted by accident.
  console.log(`  owner capabilities  : ${result.grantedCapabilities.join(', ') || 'none'}`);
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

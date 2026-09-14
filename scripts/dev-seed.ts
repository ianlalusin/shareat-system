/**
 * `npm run dev:seed` — the minimum a LOCAL database needs before any screen is usable.
 *
 * Migrations create 93 accounts and (via whatever put them there) an org and its stores,
 * but nothing creates a PERSON. Every mutating screen from T-122 onward runs through
 * `authorize()`, which needs a person, a role, and a store scope — so a freshly migrated
 * `shareat_dev` renders "No person with an active role exists in this org yet" and nothing
 * can be created, approved or voided. That is not a bug in the screens; it is an empty
 * database. This script fills exactly that gap and nothing else.
 *
 * ## It refuses to run against anything but a *_dev database
 *
 * A seed script is a write path, and a write path that can reach production is a liability
 * regardless of intent (the same argument that dates the ETL service-account keys). The
 * guard is on the DATABASE NAME, checked before a single statement runs, because the name
 * is the one thing a misconfigured `.env.local` cannot make ambiguous.
 *
 * Idempotent: re-running adds nothing. Every insert is guarded on what already exists.
 */
import { config } from 'dotenv';
import postgres from 'postgres';

config({ path: '.env.local' });

import { setPin } from '../packages/auth/src/sessions';
import { transaction } from '../packages/db/src/client';
import { seedChartOfAccounts } from '../packages/db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../packages/db/seed/expense-categories';

/** Roles seeded, in the order a real org acquires them, each with a memorable dev PIN.
 *  ⚠️ These PINs are printed on the sign-in page in development ONLY — see that page's
 *  NODE_ENV guard. A convenience that reaches production is not a convenience. */
const SEED_PEOPLE = [
  // ⭐ DEF-130 (2026-09-03). Adding an item directly, approving a request and merging are ALL
  // super-admin only (T-148, `approve_item`), and the seed had no super-admin — so the item
  // screen's own create path could never be exercised against a seeded database.
  { displayName: 'Dev Super Admin', role: 'super_admin' as const, pin: '000000' },
  { displayName: 'Dev Admin', role: 'admin' as const, pin: '111111' },
  { displayName: 'Dev Manager', role: 'manager' as const, pin: '222222' },
  { displayName: 'Dev Cashier', role: 'staff' as const, pin: '333333' },
];

function databaseNameOf(url: string): string {
  // Deliberately not a URL parse — a connection string with an odd password can defeat
  // `new URL()`, and the only part being read here is the path segment.
  const withoutQuery = url.split('?')[0]!;
  const lastSlash = withoutQuery.lastIndexOf('/');
  return lastSlash === -1 ? '' : withoutQuery.slice(lastSlash + 1);
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('dev-seed: DATABASE_URL is not set. Expected it in .env.local.');
  }

  const dbName = databaseNameOf(url);
  if (!dbName.endsWith('_dev')) {
    throw new Error(
      `dev-seed: REFUSING to run — the database is "${dbName}", which does not end in "_dev". ` +
        'This script only ever seeds a local development database.',
    );
  }

  const sql = postgres(url, { max: 1 });
  try {
    const [org] = await sql<{ id: string; name: string }[]>`
      select id, name from organizations where is_active = true order by created_at limit 1
    `;
    if (!org) {
      throw new Error('dev-seed: no active organization exists — nothing to seed against.');
    }

    const stores = await sql<{ id: string; code: string }[]>`
      select id, code from stores where org_id = ${org.id} order by code
    `;
    if (stores.length === 0) {
      throw new Error(`dev-seed: org "${org.name}" has no stores — nothing to scope a person to.`);
    }

    // ⚠️ Re-seed the CHART too, not just categories. The chart grows as the project does — T-123
    // added 2160 and 4500 — and an org seeded before an account existed simply does not have it.
    // The symptom is a posting refused with "unknown account code", which is postEntry doing its
    // job but is baffling if you assume the chart is static. `ON CONFLICT DO NOTHING` makes this
    // additive and safe to re-run: existing accounts are untouched, missing ones appear.
    const chart = await seedChartOfAccounts(sql, org.id);
    console.log(`chart of accounts  : ${chart.headersInserted + chart.leavesInserted} inserted (missing ones only)`);

    const categories = await seedExpenseCategories(sql, org.id);
    console.log(`expense categories : ${categories.categoriesInserted} inserted`);

    let peopleAdded = 0;
    let scopesAdded = 0;
    for (const person of SEED_PEOPLE) {
      const [existing] = await sql<{ id: string }[]>`
        select id from persons where org_id = ${org.id} and display_name = ${person.displayName}
      `;
      let personId = existing?.id;

      if (!personId) {
        const [inserted] = await sql<{ id: string }[]>`
          insert into persons (org_id, display_name) values (${org.id}, ${person.displayName}) returning id
        `;
        personId = inserted!.id;
        peopleAdded++;
        // `granted_by` is null only for seeded rows — bible row 116's authority chain is
        // enforced by the service layer, and there is no grantor before the first admin.
        await sql`
          insert into person_roles (person_id, org_id, role) values (${personId}, ${org.id}, ${person.role})
        `;
      }

      // Every seeded person is scoped to EVERY store. This mirrors row 120 for the admin
      // (assigning admin materialises a scope row per store) and is simply convenient for
      // the other two — a local database has no reason to hide a store from a developer.
      for (const store of stores) {
        const [scoped] = await sql<{ id: string }[]>`
          select id from person_store_scope where person_id = ${personId} and store_id = ${store.id}
        `;
        if (!scoped) {
          await sql`insert into person_store_scope (person_id, store_id) values (${personId}, ${store.id})`;
          scopesAdded++;
        }
      }
    }

    // Sales channels, per store. Two shapes on purpose: one REMITTED (its money reaches the
    // till) and one NOT (a platform that settles to a bank days later). The non-remitted one
    // must name where its receivable lands — the schema refuses it otherwise, which is DEF-059
    // made impossible rather than merely documented.
    let channelsAdded = 0;
    for (const store of stores) {
      for (const ch of [
        { name: 'Walk-in', remitted: true, receivable: null as string | null },
        { name: 'Foodpanda', remitted: false, receivable: '1220' },
        { name: 'GrabFood', remitted: false, receivable: '1220' },
      ]) {
        const [existing] = await sql<{ id: string }[]>`
          select id from sales_channels where store_id = ${store.id} and name = ${ch.name}
        `;
        if (!existing) {
          await sql`
            insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code)
            values (${org.id}, ${store.id}, ${ch.name}, ${ch.remitted}, ${ch.receivable})
          `;
          channelsAdded++;
        }
      }
    }

    // ⭐ **ONE PIN PER PERSON, not one per (person, store) — T-302.** Without a PIN there is no way
    // into the app at all now that the "acting as" picker is gone, which is why this is part of the
    // minimum.
    //
    // ⛔ **This loop used to run per store, and under org-scoped hashing that stopped meaning
    // anything.** Both halves broke, not just the signature:
    //  - The **existence guard** asked `store_id = <this store>`. A person seeded at store 1 has a
    //    row stamped store 1, so store 2's guard found nothing and re-issued — and `setPin` now
    //    retires the person's PIN org-wide before inserting. Net effect: the same PIN re-hashed
    //    once per store on every run, each pass revoking the last, `pinsAdded` counting every one
    //    of them, and a growing pile of revoked rows. Green, and wrong.
    //  - The **inner loop** itself. One credential per person is the whole point of T-302; issuing
    //    it once per store contradicts the thing being seeded.
    //
    // ⚠️ `stores[0]` is where the row is STAMPED (a `pin` credential must carry a `store_id`), not
    // where it works — the seeded people are scoped across the dev org's stores and sign in at any
    // of them. Ordered by code below so a re-seed picks the same store rather than a random one.
    let pinsAdded = 0;
    const stampStore = [...stores].sort((a, b) => a.code.localeCompare(b.code))[0];
    for (const person of SEED_PEOPLE) {
      if (!stampStore) break;
      const [row] = await sql<{ id: string }[]>`
        select id from persons where org_id = ${org.id} and display_name = ${person.displayName}
      `;
      if (!row) continue;
      const [existing] = await sql<{ id: string }[]>`
        select id from person_credentials
        where person_id = ${row.id} and kind = 'pin' and revoked_at is null
      `;
      if (existing) continue;
      await transaction((tx) =>
        setPin(tx, { orgId: org.id, personId: row.id, storeId: stampStore.id, pin: person.pin }),
      );
      pinsAdded++;
    }

    console.log(`sales channels     : ${channelsAdded} inserted across ${stores.length} store(s)`);
    console.log(`terminal PINs      : ${pinsAdded} set`);
    console.log(`people             : ${peopleAdded} inserted (${SEED_PEOPLE.length} expected in total)`);
    console.log(`store scopes       : ${scopesAdded} inserted across ${stores.length} store(s)`);
    console.log(`\nSeeded "${org.name}" in ${dbName}. Reload http://localhost:9008/expenses`);
  } finally {
    await sql.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

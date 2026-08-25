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

import { seedExpenseCategories } from '../packages/db/seed/expense-categories';

/** Roles seeded, in the order a real org acquires them. */
const SEED_PEOPLE = [
  { displayName: 'Dev Admin', role: 'admin' as const },
  { displayName: 'Dev Manager', role: 'manager' as const },
  { displayName: 'Dev Cashier', role: 'staff' as const },
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

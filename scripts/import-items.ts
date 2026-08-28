/**
 * Import the item master from v1 (ERP-rebuild's Firestore) into `items`. T-145 / T-147.
 *
 * ⭐ **Why this exists.** T-145 built the item table and nothing to fill it. v1 holds 842 item
 * records across six stores that collapse to ~385 real names — nobody is typing those by hand.
 *
 * ⚠️ **Sample by default** (`--limit`), because Ian asked for real test items rather than the
 * whole set: *"import some real test item not the whole."* The full run is the same script with a
 * bigger limit, once the conflicts below have been ruled on.
 *
 * ## ⛔ This does NOT decide the hard cases — it reports them
 *
 * Five conflicts are real in v1's data and a machine must not resolve them silently:
 *
 *  1. **The same product measured differently per store.** `white onion` is kg at Lipa and Malvar
 *     but PCS at Padre Garcia. Averaging or first-wins would invent a fact.
 *  2. **A container as the base unit** — 33 items whose `baseUnit` is `box`/`pack`. T-145 forbids
 *     it: a box is a quantity of something, not a way of measuring it.
 *  3. **A conversion between identical units** — 7 items with `pack→pack` at a factor ≠ 1, which
 *     is meaningless.
 *  4. **Names that differ only by punctuation or spacing** — `3D W/LID` and `3D W/LID.` are one
 *     product typed twice. ⚠️ Found by running this script: a plain lower-case key let both
 *     through and minted TWO identities, which is the exact defect an item master exists to
 *     prevent. They are NOT auto-merged either — "Coke 1.5" and "Coke 15" differ by punctuation
 *     too, and a machine cannot tell those apart. Reported, like the rest.
 *  5. **Junk names** — v1 contains an item literally called `2`. A name under two characters, or
 *     made only of digits and punctuation, is not a product.
 *
 * Anything in those five groups is SKIPPED and printed for a human. Everything unambiguous is
 * imported. That keeps the import honest: it moves facts, and it hands back decisions.
 *
 * Usage:
 *   npx tsx scripts/import-items.ts --org <orgId> [--limit 25] [--apply]
 *
 * Without `--apply` it is a DRY RUN and writes nothing.
 */
import { config } from 'dotenv';
import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import admin from 'firebase-admin';

config({ path: '.env.local' });

const V1 = 'C:/Users/ianla/webapps/ERP-rebuild';
/** Units that are genuinely units of measure. Containers are purchase units, never base units. */
const REAL_UNITS = new Set(['pcs', 'kg', 'g', 'ltr', 'ml', 'roll']);
const KINDS = new Set(['raw_material', 'supply', 'retail', 'meat_slab', 'meat_sliced']);

interface V1Item {
  name: string;
  kind?: string;
  baseUnit?: string;
  purchaseUnit?: string;
  conversionFactor?: number;
  storeName: string;
}

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function readV1(): Promise<V1Item[]> {
  const raw = readFileSync(`${V1}/.env.local`, 'utf8')
    .match(/FIREBASE_SERVICE_ACCOUNT_KEY=(.*)/)![1]!
    .trim()
    .replace(/^['"]|['"]$/g, '');
  let sa: admin.ServiceAccount;
  try {
    sa = JSON.parse(raw);
  } catch {
    sa = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  }
  admin.initializeApp({ credential: admin.credential.cert(sa) });
  const db = admin.firestore();

  const out: V1Item[] = [];
  for (const store of (await db.collection('stores').get()).docs) {
    const storeName = (store.data().name as string) ?? store.id;
    for (const d of (await db.collection(`stores/${store.id}/items`).get()).docs) {
      const x = d.data();
      if (!x.name || typeof x.name !== 'string' || !x.name.trim()) continue;
      out.push({
        name: String(x.name).trim(),
        kind: x.kind,
        baseUnit: x.baseUnit,
        purchaseUnit: x.purchaseUnit,
        conversionFactor: x.conversionFactor,
        storeName,
      });
    }
  }
  return out;
}

/** `Pork Belly` and `pork belly` are one item — T-145's own unique index says so. */
const key = (name: string) => name.trim().toLowerCase();

/** ⚠️ A LOOSER key, used only to DETECT near-duplicates — never to merge them. Strips punctuation
 *  and collapses spacing, so `3D W/LID` and `3D W/LID.` collide and get reported together. */
const loose = (name: string) => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');

/** v1 contains an item named `2`. A name that is one character, or only digits/punctuation, is
 *  not a product name. */
const isJunkName = (name: string) => {
  const t = name.trim();
  return t.length < 2 || !/[a-z]/i.test(t);
};

/** PORK-BELLY from "Pork belly". Collisions get a numeric suffix. */
function codeFor(name: string, taken: Set<string>): string {
  const base =
    name
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 28) || 'ITEM';
  let code = base;
  let n = 2;
  while (taken.has(code)) code = `${base}-${n++}`;
  taken.add(code);
  return code;
}

async function main() {
  const orgId = arg('--org');
  const limit = Number(arg('--limit') ?? 25);
  const apply = process.argv.includes('--apply');
  if (!orgId) throw new Error('Pass --org <orgId>. Find one with: select id, name from organizations;');

  console.log(`Reading v1 item master…`);
  const v1 = await readV1();
  console.log(`  ${v1.length} item records across v1's stores\n`);

  // Group every store's copy of the same name together — this is where the conflicts surface.
  const byName = new Map<string, V1Item[]>();
  for (const it of v1) {
    if (!byName.has(key(it.name))) byName.set(key(it.name), []);
    byName.get(key(it.name))!.push(it);
  }
  console.log(`  ${byName.size} distinct names\n`);

  const clean: { name: string; kind: string; baseUnit: string }[] = [];
  const conflicts: { name: string; why: string; detail: string }[] = [];

  // Names colliding once punctuation is stripped — one product typed two ways, or two products
  // that merely look alike. Either way a human decides, so both sides are held back.
  const looseGroups = new Map<string, string[]>();
  for (const [, copies] of byName) {
    const n = copies[0]!.name;
    const l = loose(n);
    if (!looseGroups.has(l)) looseGroups.set(l, []);
    if (!looseGroups.get(l)!.includes(n)) looseGroups.get(l)!.push(n);
  }
  const nearDuplicate = new Set<string>();
  for (const [, names] of looseGroups) {
    if (names.length > 1) for (const n of names) nearDuplicate.add(n);
  }

  for (const [, copies] of byName) {
    const name = copies[0]!.name;

    if (isJunkName(name)) {
      conflicts.push({ name, why: 'not a product name', detail: copies[0]!.storeName });
      continue;
    }
    if (nearDuplicate.has(name)) {
      const siblings = looseGroups.get(loose(name))!.filter((n) => n !== name);
      conflicts.push({
        name,
        why: 'differs from another item only by punctuation or spacing',
        detail: `vs ${siblings.map((s) => `"${s}"`).join(', ')}`,
      });
      continue;
    }
    const units = new Set(copies.map((c) => c.baseUnit).filter(Boolean));
    const kinds = new Set(copies.map((c) => c.kind).filter(Boolean));

    if (units.size > 1) {
      conflicts.push({
        name,
        why: 'measured differently per store',
        detail: copies.map((c) => `${c.storeName}:${c.baseUnit}`).join(' · '),
      });
      continue;
    }
    const unit = [...units][0];
    if (!unit || !REAL_UNITS.has(unit)) {
      conflicts.push({
        name,
        why: unit ? `base unit "${unit}" is a container, not a unit of measure` : 'no base unit',
        detail: copies.map((c) => `${c.storeName}:${c.baseUnit ?? '—'}`).join(' · '),
      });
      continue;
    }
    const badConversion = copies.find(
      (c) => c.purchaseUnit && c.purchaseUnit === c.baseUnit && c.conversionFactor && c.conversionFactor !== 1,
    );
    if (badConversion) {
      conflicts.push({
        name,
        why: `conversion ${badConversion.conversionFactor} between identical units (${badConversion.purchaseUnit})`,
        detail: badConversion.storeName,
      });
      continue;
    }
    const kind = [...kinds][0];
    if (!kind || !KINDS.has(kind)) {
      conflicts.push({ name, why: `unknown kind "${kind ?? '—'}"`, detail: copies[0]!.storeName });
      continue;
    }
    clean.push({ name, kind, baseUnit: unit });
  }

  clean.sort((a, b) => a.name.localeCompare(b.name));
  const take = clean.slice(0, limit);

  console.log(`READY TO IMPORT: ${clean.length} unambiguous items (importing ${take.length})`);
  console.log(`NEEDS A HUMAN  : ${conflicts.length} names\n`);

  console.log('--- conflicts, first 15 (NOT imported) ---');
  for (const c of conflicts.slice(0, 15)) {
    console.log(`  ${c.name.padEnd(26)} ${c.why}`);
    console.log(`  ${''.padEnd(26)} ${c.detail}`);
  }

  if (!apply) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply to import.');
    process.exit(0);
  }

  const url = process.env.DATABASE_URL!;
  const sql = postgres(url, { max: 1 });
  const [person] = await sql<{ id: string }[]>`
    select id from persons where org_id = ${orgId} order by created_at limit 1`;
  if (!person) throw new Error(`Org ${orgId} has no persons row to attribute the items to.`);

  const [existing] = await sql<{ codes: string[] }[]>`
    select coalesce(array_agg(code), '{}') as codes from items where org_id = ${orgId}`;
  const taken = new Set(existing!.codes);

  let inserted = 0;
  let skipped = 0;
  for (const it of take) {
    const code = codeFor(it.name, taken);
    // ⚠️ ON CONFLICT DO NOTHING on the case-insensitive name index — re-running must be safe.
    const res = await sql`
      insert into items (org_id, code, name, kind, base_unit, notes, created_by)
      values (${orgId}, ${code}, ${it.name}, ${it.kind}, ${it.baseUnit},
              ${'Imported from v1 item master by scripts/import-items.ts'}, ${person.id})
      on conflict do nothing
      returning id`;
    if (res.length > 0) inserted++;
    else skipped++;
  }

  const [total] = await sql<{ n: number }[]>`select count(*)::int n from items where org_id = ${orgId}`;
  console.log(`\nInserted ${inserted}, already present ${skipped}. Org now has ${total!.n} items.`);
  await sql.end();
  process.exit(0);
}

main().catch((e) => {
  console.error('Import FAILED:', e);
  process.exit(1);
});

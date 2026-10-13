/**
 * T-392 S5 (TESTER) - shared synthetic fixture for the three S5 test files. Not a test itself.
 * Reports and lines are seeded through dualRunRepo.insertReport / insertLines (no snapshot, no ledger), then created_at is set
 * by the owner connection so "newest version" and "disposition newer than the version" are exact, never a race on now().
 * Synthetic data only: invented org, stores ("Lipa", "Malvar"), people and supplier keys.
 */
import type postgres from 'postgres';
import { dualRunRepo, withOrgPrincipal } from '@shareat/db';
import type { Actor } from '@shareat/auth';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

export interface Person extends Actor {
  personId: string;
  orgId: string;
}

export interface S5Fixture {
  orgId: string;
  lipa: { id: string; code: string; name: string };
  malvar: { id: string; code: string; name: string };
  /** admin, scoped to both stores */
  admin: Person;
  /** super_admin, scoped to both stores */
  superAdmin: Person;
  /** DEFAULT manager, both stores: holds run_cutover AND view_financial_reports by the matrix (capabilities.ts:912, :932). */
  manager: Person;
  /** staff, both stores: holds neither capability. */
  staff: Person;
  /** staff + explicit person_grants rows for run_cutover and view_financial_reports: holds BOTH capabilities, is not an admin. */
  staffWithGrants: Person;
  /** admin scoped to Lipa only */
  adminLipaOnly: Person;
  /** admin of ANOTHER org (with a store of its own) */
  foreignAdmin: Person;
}

let seq = 0;
export const uid = (p: string): string => `${p}${Date.now().toString(36)}${++seq}`.toUpperCase();

export async function makeFixture(sql: postgres.Sql, hint: string): Promise<S5Fixture> {
  const code = uid(`T392S5${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const mkStore = async (name: string) => {
    const c = uid(name.slice(0, 2));
    const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${c}, ${name}) returning id`;
    return { id: s!.id, code: c, name };
  };
  const lipa = await mkStore('Lipa');
  const malvar = await mkStore('Malvar');
  const mk = async (org: string, name: string, role: string, stores: string[]): Promise<Person> => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${org}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${org}, ${role})`;
    for (const s of stores) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s})`;
    return { orgId: org, personId: p!.id };
  };
  const both = [lipa.id, malvar.id];
  const admin = await mk(orgId, 'Admin', 'admin', both);
  const superAdmin = await mk(orgId, 'Super', 'super_admin', both);
  const manager = await mk(orgId, 'Manager', 'manager', both);
  const staff = await mk(orgId, 'Staff', 'staff', both);
  const staffWithGrants = await mk(orgId, 'Granted staff', 'staff', both);
  for (const g of ['run_cutover', 'view_financial_reports']) {
    await sql`insert into person_grants (person_id, grant_name, granted_by, grant_source) values (${staffWithGrants.personId}, ${g}, null, null)`;
  }
  const adminLipaOnly = await mk(orgId, 'Admin Lipa only', 'admin', [lipa.id]);
  const [org2] = await sql<{ id: string }[]>`insert into organizations (name, code) values ('Other org', ${uid('T392S5X')}) returning id`;
  const [os] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${org2!.id}, ${uid('XS')}, 'Elsewhere') returning id`;
  const foreignAdmin = await mk(org2!.id, 'Foreign admin', 'admin', [os!.id]);
  return { orgId, lipa, malvar, admin, superAdmin, manager, staff, staffWithGrants, adminLipaOnly, foreignAdmin };
}

export interface SeedLine {
  kind: string;
  key: string;
  v1: string;
  v2: string;
  class: string;
  label?: string;
}

/** delta = v2 - v1 in 2dp, computed in centavos. */
export const delta2 = (v1: string, v2: string): string => ((Math.round(Number(v2) * 100) - Math.round(Number(v1) * 100)) / 100).toFixed(2);

export const line = (kind: string, key: string, v1: string, v2: string, cls: string): SeedLine => ({ kind, key, v1, v2, class: cls });

export interface SeedReport {
  storeId: string;
  weekStart: string;
  verdict: 'no_data' | 'ties' | 'explained' | 'open';
  days: number;
  /** distinct values make distinct versions of one store-week (the R8 identity) */
  v1fp?: string;
  v2fp?: string;
  keysSha?: string;
  lines?: SeedLine[];
  /** ISO instant; the version's created_at. Default: a fixed past instant so a disposition recorded NOW is newer. */
  createdAt?: string;
  createdBy: string;
}

export async function seedReport(sql: postgres.Sql, orgId: string, r: SeedReport): Promise<string> {
  const id = await withOrgPrincipal(orgId, async (tx) => {
    const rep = await dualRunRepo.insertReport(tx, {
      orgId,
      storeId: r.storeId,
      weekStart: r.weekStart,
      through: addDays(r.weekStart, 6),
      v1Fingerprint: r.v1fp ?? 'v1-a',
      v2Fingerprint: r.v2fp ?? 'v2-a',
      keysSha: r.keysSha ?? 'keys-a',
      v1SnapshotSha: 'snap-a',
      v1ExtractedAt: new Date('2026-10-26T01:00:00Z'),
      verdict: r.verdict,
      comparedDays: r.days,
      createdBy: r.createdBy,
    } as Any);
    await dualRunRepo.insertLines(
      tx,
      rep.id,
      (r.lines ?? []).map((l) => ({
        kind: l.kind,
        lineKey: l.key,
        label: l.label ?? l.key,
        v1Amount: l.v1,
        v2Amount: l.v2,
        delta: delta2(l.v1, l.v2),
        class: l.class,
        paired: false,
        autoReason: null,
        perDay: [],
        v1Counter: null,
        openingGap: null,
      })) as Any,
    );
    return rep.id;
  });
  await sql`update dual_run_reports set created_at = ${r.createdAt ?? '2026-10-27T00:00:00Z'}::timestamptz where id = ${id}`;
  return id;
}

export function addDays(d: string, n: number): string {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

/** A disposition row written by the owner connection (as a past run of the action would have), at an exact created_at. */
export async function seedDisposition(
  sql: postgres.Sql,
  f: S5Fixture,
  d: { storeId: string; weekStart: string; kind: string; lineKey: string; deltaAt: string; class: 'V1_DEFECT' | 'V2_DEFECT'; ref: string; createdAt?: string },
): Promise<void> {
  await sql`insert into dual_run_dispositions (org_id, store_id, week_start, kind, line_key, delta_at, class, ref, note, created_by, created_at)
            values (${f.orgId}, ${d.storeId}, ${d.weekStart}, ${d.kind}, ${d.lineKey}, ${d.deltaAt}, ${d.class}, ${d.ref}, 'seeded', ${f.admin.personId},
                    ${d.createdAt ?? new Date().toISOString()}::timestamptz)`;
}

/**
 * T-410 S1 (schema half, R1-R3, R5) - one person, one id (bible row 322).
 *
 * The build goes red the day someone adds a second "users" / "accounts" table, or a credential
 * table that does not lead back to `persons.id`. Pure unit: reads the Drizzle table config only.
 * The live-database half is `packages/db/tests/integration/t410-single-identity-db.test.ts`.
 *
 * Mutants (applied by temporary edit to this file, reverted at once, shown red in the lane log):
 *   inv1  R3 accepts any FK target                  -> the "keyed to stores.id" fixture passes -> red
 *   inv2  a throwaway pgTable('app_users') is added to the real-schema run -> red with the R5 sentence
 *   inv4  R3 ignores NOT NULL on the FK             -> the nullable person_id fixture passes -> red
 */
import { describe, expect, it } from 'vitest';
import { is } from 'drizzle-orm';
import { getTableConfig, PgTable, pgTable, uuid } from 'drizzle-orm/pg-core';
import * as schema from '../../schema';
import { employments } from '../../schema/employment';
import { persons } from '../../schema/persons';
import { stores } from '../../schema/stores';

interface ShapeColumn {
  name: string;
  notNull: boolean;
}
interface ShapeFk {
  columns: string[];
  foreignTable: string;
  foreignColumns: string[];
}
interface TableShape {
  name: string;
  columns: ShapeColumn[];
  fks: ShapeFk[];
}

/** R1 - the allowlist. Each entry says why it is an identity table and what it is keyed to. */
const IDENTITY_ALLOWLIST: ReadonlyMap<string, string> = new Map([
  ['persons', 'the spine: one row per human (and per device, kind = terminal)'],
  ['person_identities', "a human's sign-in handles (firebase uid, phone, email, staff no., device hash), keyed to persons.id"],
  ['person_credentials', 'how a person proves who they are at sign-in (PIN, firebase, biometric), keyed to persons.id'],
  ['sessions', 'a signed-in session, keyed to persons.id and to the credential it came from'],
  ['attendance_credentials', 'a clock card or fingerprint, keyed to an employment, which leads to persons.id'],
  ['clock_terminals', 'a DEVICE principal: its firebase_uid is a device, not a human; provisioned_by is a person'],
]);

/** R2 - a table that matches the identity pattern but is NOT an identity table. Empty today; each entry needs a reason. */
const NOT_IDENTITY: ReadonlyMap<string, string> = new Map();

/** R3 exemptions: `persons` is the target itself; `clock_terminals` is a device, not a human. */
const R3_EXEMPT: ReadonlyMap<string, string> = new Map([
  ['persons', 'the target of the rule'],
  ['clock_terminals', 'a device principal; its provisioned_by is the person who answers for it'],
]);

const NAME_PATTERN = /(^|_)(users?|logins?|identit(y|ies)|credentials?|principals?|members?|auth)(_|$)/;
const IDENTITY_COLUMNS: ReadonlySet<string> = new Set([
  'external_id', 'firebase_uid', 'uid', 'password', 'password_hash', 'pin_hash', 'secret_hash',
  'lookup_hash', 'token_hash', 'match_token', 'verifier',
]);

const r5 = (table: string): string =>
  `${table} looks like a second identity table. Bible row 322: one person, one id. ` +
  'Key it to persons.id and add it to the allowlist with a reason, or add it to NOT_IDENTITY with a reason.';

function shapeOf(t: PgTable): TableShape {
  const cfg = getTableConfig(t);
  return {
    name: cfg.name,
    columns: cfg.columns.map((c) => ({ name: c.name, notNull: c.notNull })),
    fks: cfg.foreignKeys.map((fk) => {
      const ref = fk.reference();
      return {
        columns: ref.columns.map((c) => c.name),
        foreignTable: getTableConfig(ref.foreignTable).name,
        foreignColumns: ref.foreignColumns.map((c) => c.name),
      };
    }),
  };
}

function schemaShapes(): TableShape[] {
  const out: TableShape[] = [];
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue;
    out.push(shapeOf(value));
  }
  return out;
}

const identityLike = (t: TableShape): boolean =>
  NAME_PATTERN.test(t.name) || t.columns.some((c) => IDENTITY_COLUMNS.has(c.name));

/**
 * R3 SUBJECT map - for each credential table, the column that says WHOSE credential it is. Only this
 * column can satisfy R3. Audit columns (enrolled_by, revoked_by, created_by) never do: a card that
 * names who enrolled it is not a card that names who holds it.
 */
const SUBJECT_COLUMN: ReadonlyMap<string, string> = new Map([
  ['person_identities', 'person_id'],
  ['person_credentials', 'person_id'],
  ['sessions', 'person_id'],
  // the employment the card or fingerprint identifies; employments.person_id -> persons.id (one hop)
  ['attendance_credentials', 'employment_id'],
]);

/** The column is NOT NULL and a single-column foreign key to `target.id`. */
function colNotNullFkTo(t: TableShape, col: string, target: string): boolean {
  const notNull = t.columns.find((c) => c.name === col)?.notNull === true;
  return (
    notNull &&
    t.fks.some((fk) => fk.columns.length === 1 && fk.columns[0] === col && fk.foreignTable === target && fk.foreignColumns.includes('id'))
  );
}

/** R3 - resolves to persons.id through the table's SUBJECT column: directly, or via employments.person_id. */
function resolvesToPerson(t: TableShape, universe: TableShape[]): boolean {
  const subject = SUBJECT_COLUMN.get(t.name);
  if (subject === undefined) return false;
  if (colNotNullFkTo(t, subject, 'persons')) return true;
  const employments = universe.find((x) => x.name === 'employments');
  if (!employments) return false;
  return colNotNullFkTo(t, subject, 'employments') && colNotNullFkTo(employments, 'person_id', 'persons');
}

/** R1 + R3: every allowlisted table exists and (except the exempt ones) resolves to persons.id. */
export function allowlistViolations(universe: TableShape[]): string[] {
  const out: string[] = [];
  const byName = new Map(universe.map((t) => [t.name, t] as const));
  for (const name of IDENTITY_ALLOWLIST.keys()) {
    const t = byName.get(name);
    if (!t) {
      out.push(`${name} is on the identity allowlist but does not exist in the schema`);
      continue;
    }
    if (R3_EXEMPT.has(name)) continue;
    if (!resolvesToPerson(t, universe)) {
      out.push(`${name} does not resolve to persons.id through a NOT NULL foreign key (R3)`);
    }
  }
  return out;
}

/** R2 + R5: a table outside the allowlist and NOT_IDENTITY that matches the identity pattern. */
export function unlistedIdentityViolations(universe: TableShape[]): string[] {
  return universe
    .filter((t) => !IDENTITY_ALLOWLIST.has(t.name) && !NOT_IDENTITY.has(t.name))
    .filter(identityLike)
    .map((t) => r5(t.name));
}

/** The checker: pure, takes any set of table shapes (the real schema, or fixtures). */
export function identityViolations(universe: TableShape[]): string[] {
  return [...unlistedIdentityViolations(universe), ...allowlistViolations(universe)];
}

/** Replace tables in the real schema with fixtures, keeping every other real table. */
function withReplaced(replacements: Record<string, TableShape>): TableShape[] {
  return schemaShapes().map((t) => replacements[t.name] ?? t);
}

describe('T-410 S1 - one person, one id (schema half)', () => {
  it('the enumeration finds the real schema at all (floor, so the checks below cannot pass vacuously)', () => {
    const names = schemaShapes().map((t) => t.name);
    expect(names.length).toBeGreaterThanOrEqual(100);
    expect(names).toEqual(expect.arrayContaining([...IDENTITY_ALLOWLIST.keys()]));
  });

  it('R2: NOT_IDENTITY is empty today (a new entry needs a decision, so it is never silent)', () => {
    expect([...NOT_IDENTITY.keys()]).toEqual([]);
  });

  // Invariant 1 - every R1 table exists and resolves per R3. Mutant: R3 accepts any FK target.
  it('inv1: every allowlisted table exists and resolves to persons.id (real schema)', () => {
    expect(allowlistViolations(schemaShapes())).toEqual([]);
  });

  it('inv1: a credential table keyed to stores.id (not persons.id) is refused', () => {
    const fixture = shapeOf(
      pgTable('person_credentials', {
        id: uuid('id').primaryKey(),
        personId: uuid('person_id').notNull().references(() => stores.id),
      }),
    );
    expect(allowlistViolations(withReplaced({ person_credentials: fixture })), 'a credential keyed to stores.id must not pass R3').toEqual([
      'person_credentials does not resolve to persons.id through a NOT NULL foreign key (R3)',
    ]);
  });

  // Invariant 2 - no table outside R1 and NOT_IDENTITY matches R2. Mutant: throwaway app_users joins the real run.
  it('inv2: no unlisted identity-like table exists in the schema', () => {
    expect(unlistedIdentityViolations(schemaShapes())).toEqual([]);
  });

  it('inv2: a throwaway app_users table is reported with the R5 sentence', () => {
    const appUsers = shapeOf(pgTable('app_users', { id: uuid('id').primaryKey() }));
    expect(unlistedIdentityViolations([...schemaShapes(), appUsers])).toEqual([r5('app_users')]);
  });

  // Invariant 4 - an allowlisted credential table whose FK is nullable fails R3. Mutant: R3 ignores NOT NULL.
  it('inv4: a credential table whose person_id is nullable fails R3', () => {
    const fixture = shapeOf(
      pgTable('person_credentials', {
        id: uuid('id').primaryKey(),
        personId: uuid('person_id').references(() => persons.id),
      }),
    );
    expect(allowlistViolations(withReplaced({ person_credentials: fixture }))).toEqual([
      'person_credentials does not resolve to persons.id through a NOT NULL foreign key (R3)',
    ]);
  });

  it('inv4 control: the same credential table with NOT NULL person_id passes', () => {
    const fixture = shapeOf(
      pgTable('person_credentials', {
        id: uuid('id').primaryKey(),
        personId: uuid('person_id').notNull().references(() => persons.id),
      }),
    );
    expect(allowlistViolations(withReplaced({ person_credentials: fixture }))).toEqual([]);
  });

  // The one-hop branch of R3, on a fixture carrying only its subject link (the real attendance_credentials
  // also has enrolled_by -> persons.id, an audit column that must never satisfy R3).
  it('R3 one-hop: a credential reaching persons.id only through employments passes; a nullable employments.person_id fails', () => {
    const credential = shapeOf(
      pgTable('attendance_credentials', {
        id: uuid('id').primaryKey(),
        employmentId: uuid('employment_id').notNull().references(() => employments.id),
      }),
    );
    expect(allowlistViolations(withReplaced({ attendance_credentials: credential }))).toEqual([]);

    const employmentsShape = shapeOf(employments);
    const nullableEmployments: TableShape = {
      ...employmentsShape,
      columns: employmentsShape.columns.map((c) => (c.name === 'person_id' ? { ...c, notNull: false } : c)),
    };
    expect(
      allowlistViolations(withReplaced({ attendance_credentials: credential, employments: nullableEmployments })),
    ).toEqual(['attendance_credentials does not resolve to persons.id through a NOT NULL foreign key (R3)']);
  });

  // Ruling (binding): audit columns never satisfy R3. This attendance_credentials keeps enrolled_by NOT NULL
  // -> persons.id, but has no subject link (employment_id nullable), so it must fail.
  // Mutant: SUBJECT_COLUMN points attendance_credentials at enrolled_by -> passes -> red.
  it('R3 subject: a credential kept alive only by an audit column (enrolled_by) fails', () => {
    const auditOnly = shapeOf(
      pgTable('attendance_credentials', {
        id: uuid('id').primaryKey(),
        enrolledBy: uuid('enrolled_by').notNull().references(() => persons.id),
        employmentId: uuid('employment_id').references(() => employments.id),
      }),
    );
    expect(allowlistViolations(withReplaced({ attendance_credentials: auditOnly }))).toEqual([
      'attendance_credentials does not resolve to persons.id through a NOT NULL foreign key (R3)',
    ]);
  });
});

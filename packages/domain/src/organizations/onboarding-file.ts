/**
 * T-398 S7a - the franchise onboarding data file: allow-list parser, environment guards, store-map check.
 * docs/tasks/398-s7/S7-REFRESH.md s4 (file + guards).
 *
 * ## Allow-list, not deny-list
 *
 * Every object in the file has a fixed set of keys. Any other key is refused BY NAME (never by value), so a PIN, password, bank number,
 * TIN, SSS/PhilHealth/Pag-IBIG number or pay rate can never ride in, whatever it is called. PINs are set through the enrolment flow.
 *
 * ## Pure
 *
 * Nothing here reads a file, a database or the environment: callers pass the parsed JSON, the path and the env. No refusal carries
 * a field value, a password or a connection string.
 */
import { isAbsolute, relative, resolve } from 'node:path';
import { PINNED_PRODUCTION_HOSTS } from '@shareat/core/production-hosts';
import type { CANONICAL_POSITIONS } from '@shareat/db/schema';

/**
 * Type-only import above keeps this module light (no database client in a pure parser). The list is pinned to the schema's
 * canonical positions both ways: a name the schema lacks, or a schema name missing here, stops the typecheck.
 */
type CanonicalPosition = (typeof CANONICAL_POSITIONS)[number];
const POSITIONS = ['Cashier', 'Kitchen Staff', 'Server', 'Dishwasher', 'Slicer', 'Inventory Staff'] as const satisfies readonly CanonicalPosition[];
const _positionsAreExhaustive: CanonicalPosition extends (typeof POSITIONS)[number] ? true : never = true;
void _positionsAreExhaustive;

/** A refusal of the onboarding file. Names fields, never values. */
export class OnboardingFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OnboardingFileError';
  }
}

export interface OnboardingPerson {
  readonly last: string;
  readonly first: string;
  readonly middle: string | null;
}
export interface OnboardingContact extends OnboardingPerson {
  readonly email: string;
}
export interface OnboardingStaff extends OnboardingPerson {
  readonly position: CanonicalPosition;
}
export interface OnboardingFile {
  readonly mock: boolean;
  readonly franchisorOrgCode: string;
  readonly org: { readonly code: string; readonly name: string };
  readonly store: { readonly code: string; readonly name: string; readonly v1StoreId: string; readonly posStoreId: string };
  readonly franchisorPerson: OnboardingContact;
  readonly owner: OnboardingContact;
  readonly staff: readonly OnboardingStaff[];
  readonly agreement: { readonly salesVisibleFrom: string };
  readonly commissary: {
    readonly customerName: string;
    readonly supplierName: string;
    readonly creditLimit: string | null;
    readonly creditTermsDays: number | null;
    readonly priceListName: string;
  };
}

/** The rows of the T-391 store map this module needs (structural: domain does not import the ETL package). */
export interface OnboardingStoreMapRow {
  readonly v1StoreId: string;
  readonly role: string;
  readonly orgCode: string;
  readonly storeCode: string;
}

type Obj = Record<string, unknown>;

function fail(sentence: string): never {
  throw new OnboardingFileError(`The onboarding file was refused: ${sentence}`);
}

function obj(v: unknown, where: string, allowed: readonly string[]): Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(`"${where}" must be an object.`);
  const o = v as Obj;
  for (const k of Object.keys(o)) {
    if (!allowed.includes(k)) fail(`"${where}" has a field "${k}" that is not allowed.`);
  }
  for (const k of allowed) {
    if (!(k in o)) fail(`"${where}" is missing "${k}".`);
  }
  return o;
}

function text(v: unknown, where: string): string {
  if (typeof v !== 'string' || v.trim() === '') fail(`"${where}" must be a non-blank text.`);
  return v.trim();
}

function person(v: unknown, where: string, extra: readonly string[]): Obj {
  const o = obj(v, where, ['last', 'first', 'middle', ...extra]);
  text(o.last, `${where}.last`);
  text(o.first, `${where}.first`);
  if (o.middle !== null) text(o.middle, `${where}.middle`);
  return o;
}

function personOut(o: Obj): OnboardingPerson {
  return { last: (o.last as string).trim(), first: (o.first as string).trim(), middle: o.middle === null ? null : (o.middle as string).trim() };
}

function contact(v: unknown, where: string): OnboardingContact {
  const o = person(v, where, ['email']);
  const email = text(o.email, `${where}.email`);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(`"${where}.email" is not an email address.`);
  return { ...personOut(o), email };
}

export function parseOnboardingFile(raw: unknown): OnboardingFile {
  const top = obj(raw, 'file', ['mock', 'franchisorOrgCode', 'org', 'store', 'franchisorPerson', 'owner', 'staff', 'agreement', 'commissary']);
  if (typeof top.mock !== 'boolean') fail('"mock" must be true or false.');
  const franchisorOrgCode = text(top.franchisorOrgCode, 'franchisorOrgCode');

  const org = obj(top.org, 'org', ['code', 'name']);
  const store = obj(top.store, 'store', ['code', 'name', 'v1StoreId', 'posStoreId']);
  const franchisorPerson = contact(top.franchisorPerson, 'franchisorPerson');
  const owner = contact(top.owner, 'owner');

  if (!Array.isArray(top.staff)) fail('"staff" must be a list.');
  const staff = (top.staff as unknown[]).map((s, i): OnboardingStaff => {
    const o = person(s, `staff[${i}]`, ['position']);
    const position = text(o.position, `staff[${i}].position`);
    if (!(POSITIONS as readonly string[]).includes(position)) {
      fail(`"staff[${i}].position" must be one of: ${POSITIONS.join(', ')}.`);
    }
    return { ...personOut(o), position: position as OnboardingStaff['position'] };
  });

  const agreement = obj(top.agreement, 'agreement', ['salesVisibleFrom']);
  const from = text(agreement.salesVisibleFrom, 'agreement.salesVisibleFrom');
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(from);
  const real = d ? new Date(Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]))) : null;
  if (!d || !real || real.getUTCFullYear() !== Number(d[1]) || real.getUTCMonth() !== Number(d[2]) - 1 || real.getUTCDate() !== Number(d[3])) {
    fail('"agreement.salesVisibleFrom" must be a real date written YYYY-MM-DD.');
  }

  const c = obj(top.commissary, 'commissary', ['customerName', 'supplierName', 'creditLimit', 'creditTermsDays', 'priceListName']);
  const creditLimit = c.creditLimit === null ? null : text(c.creditLimit, 'commissary.creditLimit');
  if (creditLimit !== null && !/^\d+(\.\d{1,2})?$/.test(creditLimit)) fail('"commissary.creditLimit" must be a decimal amount written as text.');
  if (c.creditTermsDays !== null && !(Number.isInteger(c.creditTermsDays) && (c.creditTermsDays as number) >= 0)) {
    fail('"commissary.creditTermsDays" must be a whole number of days or null.');
  }

  return {
    mock: top.mock,
    franchisorOrgCode,
    org: { code: text(org.code, 'org.code'), name: text(org.name, 'org.name') },
    store: {
      code: text(store.code, 'store.code'),
      name: text(store.name, 'store.name'),
      v1StoreId: text(store.v1StoreId, 'store.v1StoreId'),
      posStoreId: text(store.posStoreId, 'store.posStoreId'),
    },
    franchisorPerson,
    owner,
    staff,
    agreement: { salesVisibleFrom: from },
    commissary: {
      customerName: text(c.customerName, 'commissary.customerName'),
      supplierName: text(c.supplierName, 'commissary.supplierName'),
      creditLimit,
      creditTermsDays: c.creditTermsDays as number | null,
      priceListName: text(c.priceListName, 'commissary.priceListName'),
    },
  };
}

type Env = Record<string, string | undefined>;

function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (!u.hostname || u.hostname.includes(',') || u.searchParams.has('host') || u.searchParams.has('hostaddr')) return null;
    return u.hostname.toLowerCase().replace(/\.+$/, '');
  } catch {
    return null;
  }
}

function productionHosts(env: Env): string[] {
  const added = (env.PRODUCTION_DB_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase().replace(/\.+$/, ''))
    .filter(Boolean);
  return [...new Set([...PINNED_PRODUCTION_HOSTS.map((h) => h.toLowerCase().replace(/\.+$/, '')), ...added])];
}

/**
 * Guard 1: a mock file never runs against production (NODE_ENV=production OR the database host is a production host).
 * Guard 2: a real (non-mock) file must not sit inside the repository.
 */
export function assertOnboardingFileAllowed(file: OnboardingFile, ctx: { path: string; repoRoot: string; env: Env }): void {
  const { env } = ctx;
  if (file.mock) {
    if (env.NODE_ENV === 'production') fail('a mock file cannot be used when NODE_ENV is production.');
    // The connection the scripts really use is SYSTEM_DATABASE_URL, else DATABASE_URL (a blank counts as unset). Judge that one.
    const system = env.SYSTEM_DATABASE_URL?.trim();
    const plain = env.DATABASE_URL?.trim();
    const url = system ? system : plain;
    if (!url) fail('a mock file cannot be used when no database URL is set, because the target host cannot be checked.');
    const host = hostOf(url);
    if (host === null) fail('a mock file cannot be used when the database host cannot be read from the database URL.');
    if (productionHosts(env).includes(host)) fail('a mock file cannot be used against a production database host.');
    return;
  }
  const rel = relative(resolve(ctx.repoRoot), resolve(ctx.path));
  const inside = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  if (inside) fail('a real (non-mock) file must be kept outside the repository.');
}

/** Guard 3 (K11): the file must agree with the store map row for its v1 store: same org_code, store_code and v1 store id. */
export function assertFileMatchesStoreMap(file: OnboardingFile, rows: readonly OnboardingStoreMapRow[]): void {
  const row = rows.find((r) => r.v1StoreId === file.store.v1StoreId);
  if (!row) fail('the store map has no row for the v1 store named in the file.');
  if (row.orgCode !== file.org.code) fail('"org.code" in the file differs from the store map org_code for that store.');
  if (row.storeCode !== file.store.code) fail('"store.code" in the file differs from the store map store_code for that store.');
}

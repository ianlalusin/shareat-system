/**
 * T-391 S2 - the store map (R6): the org boundary. `stores.csv` pairs each v1 store id with a role, an org code and a
 * store code. Padre Garcia's v1 id (docs/STORE-ROSTER.md) is hard-coded and can only be `franchise`.
 */
import { parseCsv } from './sheets';

export const PADRE_GARCIA_V1_STORE_ID = 'y1DMgfisuTHBF57cNL6i';

export type StoreRole = 'own' | 'franchise' | 'exclude';

export interface StoreMapRow {
  v1StoreId: string;
  name: string;
  role: StoreRole;
  orgCode: string;
  storeCode: string;
}

const ROLES: ReadonlySet<string> = new Set(['own', 'franchise', 'exclude']);

export function parseStoreMap(csvText: string): StoreMapRow[] {
  const rows: StoreMapRow[] = parseCsv(csvText).map((r, i) => {
    const role = (r.role ?? '').trim().toLowerCase();
    if (!ROLES.has(role)) throw new Error(`stores.csv row ${i + 2}: role "${r.role ?? ''}" must be own, franchise or exclude.`);
    const v1StoreId = (r.v1_store_id ?? '').trim();
    if (!v1StoreId) throw new Error(`stores.csv row ${i + 2}: v1_store_id is blank.`);
    return {
      v1StoreId,
      name: (r.name ?? '').trim(),
      role: role as StoreRole,
      orgCode: (r.org_code ?? '').trim(),
      storeCode: (r.store_code ?? '').trim(),
    };
  });

  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.v1StoreId)) throw new Error(`stores.csv lists v1 store ${r.v1StoreId} twice.`);
    seen.add(r.v1StoreId);
    if (r.v1StoreId === PADRE_GARCIA_V1_STORE_ID && r.role !== 'franchise') {
      throw new Error(`Padre Garcia (${PADRE_GARCIA_V1_STORE_ID}) is a franchise; stores.csv gives it role "${r.role}". Refused (R6).`);
    }
    if (r.role !== 'exclude' && !r.orgCode) {
      throw new Error(`stores.csv: ${r.name || r.v1StoreId} has role ${r.role} but no org_code.`);
    }
  }
  const own = new Set(rows.filter((r) => r.role === 'own').map((r) => r.orgCode));
  for (const r of rows) {
    if (r.role === 'franchise' && own.has(r.orgCode)) {
      throw new Error(`stores.csv: franchise ${r.name || r.v1StoreId} shares org_code ${r.orgCode} with an own store. Refused (R6).`);
    }
  }
  const codes = new Set<string>();
  for (const r of rows) {
    if (r.role === 'exclude' || !r.storeCode) continue;
    const k = `${r.orgCode}/${r.storeCode}`;
    if (codes.has(k)) throw new Error(`stores.csv: store_code ${r.storeCode} is used twice in org ${r.orgCode}.`);
    codes.add(k);
  }
  return rows;
}

/**
 * The non-exclude rows of one org. Every store of the org must carry a store_code (a blank one is refused whether or
 * not it is in scope: the org-wide decisions count it). With `storeCodes`, only those stores are returned, and an
 * unknown code is refused.
 */
export function selectTargetStores(
  rows: readonly StoreMapRow[],
  opts: { orgCode: string; storeCodes?: readonly string[] },
): StoreMapRow[] {
  const org = rows.filter((r) => r.role !== 'exclude' && r.orgCode === opts.orgCode);
  if (org.length === 0) throw new Error(`stores.csv has no store for org ${opts.orgCode}.`);
  const blank = org.find((r) => !r.storeCode);
  if (blank) throw new Error(`stores.csv: ${blank.name || blank.v1StoreId} (org ${opts.orgCode}) has a blank store_code.`);
  if (!opts.storeCodes || opts.storeCodes.length === 0) return org;
  const wanted = new Set(opts.storeCodes.map((c) => c.trim()));
  const known = new Set(org.map((r) => r.storeCode));
  for (const c of wanted) if (!known.has(c)) throw new Error(`Store ${c} is not a store of org ${opts.orgCode} in stores.csv.`);
  return org.filter((r) => wanted.has(r.storeCode));
}

/**
 * `run` targets one org. The --org row's code (read from the database) must equal --org-code, and the code must be one
 * the map knows; a franchise org is therefore only ever run against its own org row (R6).
 */
export function assertRunTarget(rows: readonly StoreMapRow[], opts: { orgCode: string; orgRowCode: string }): void {
  if (opts.orgRowCode !== opts.orgCode) {
    throw new Error(`--org is org "${opts.orgRowCode}" but --org-code says "${opts.orgCode}". Refused (R6).`);
  }
  if (!rows.some((r) => r.role !== 'exclude' && r.orgCode === opts.orgCode)) {
    throw new Error(`stores.csv has no store for org "${opts.orgCode}". Refused (R6).`);
  }
}

/**
 * T-391 S4 - the PARTIES planner (suppliers and customers): a PURE function from (v1 snapshot, store map, what v2
 * already holds, links, Ian's answers) to the writes the load will make and the sheets Ian answers. No database.
 * docs/tasks/391-production-master-data-load.md, rulings P1-P12, R4, R5, R11, R12, R13, invariants I1, I7, I8.
 *
 *   - exact name (`lower(trim)`) across the org's stores is ONE party, every store's record linked (P1);
 *   - look-alike names, existing v2 names included, wait on the twins sheet (P2);
 *   - merged copies take each field from the newest copy that has it; vat_status and tin are never merged: two
 *     different non-blank values hold the party on suppliers-tax, a blank on one copy is not a disagreement (P3, P10);
 *   - a name already in v2 (or a record already linked) is LINKED, the v2 row is never changed (R4, I7);
 *   - a record pointing at a franchise store is listed on parties-held (reason franchise), never written, never
 *     counted as held (P5, P9); a party with any active copy is active (P11);
 *   - a bank account number travels MASKED only; the planner never reads a full number (P8, I8).
 * There is no write but `create` and `link`. A linked record that drifted is reported, never written (R13).
 */
import { key, loose } from './keys';
import { rowKey } from './sheets';
import { selectTargetStores, type StoreMapRow } from './store-map';

type Row = Record<string, string>;

export const PARTY_SHEETS = ['suppliers-twins', 'suppliers-tax', 'customers-twins', 'parties-held'] as const;
export type PartySheet = (typeof PARTY_SHEETS)[number];

export const PARTY_SHEET_COLUMNS: Record<PartySheet, readonly string[]> = {
  'suppliers-twins': ['row_key', 'group', 'name', 'stores', 'same_or_different', 'keep_name', 'note'],
  'suppliers-tax': ['row_key', 'supplier', 'stores', 'vat_status', 'tin', 'note'],
  'customers-twins': ['row_key', 'group', 'name', 'stores', 'same_or_different', 'keep_name', 'note'],
  'parties-held': ['row_key', 'entity', 'name', 'stores', 'reason', 'note'],
};
const ANSWER_COLUMNS: Record<PartySheet, readonly string[]> = {
  'suppliers-twins': ['same_or_different', 'keep_name'],
  'suppliers-tax': ['vat_status', 'tin'],
  'customers-twins': ['same_or_different', 'keep_name'],
  'parties-held': [],
};
const STALE_TRIGGER: Record<PartySheet, readonly string[]> = {
  'suppliers-twins': ['same_or_different'],
  'suppliers-tax': ['vat_status', 'tin'],
  'customers-twins': ['same_or_different'],
  'parties-held': [],
};

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface PartiesSnapshot {
  suppliers?: any[];
  arCustomers?: any[];
}
export interface ExistingParty {
  id: string;
  name: string;
  status?: string;
  [column: string]: unknown;
}
export interface PartyLink {
  entity: string;
  v1StoreId: string;
  v1Id: string;
  v2Id: string;
}
export type PartyEntity = 'supplier' | 'customer';
export interface PlannedPartyLink {
  v1StoreId: string;
  v1Id: string;
}
export interface SupplierCreate {
  op: 'create';
  entity: 'supplier';
  name: string;
  address: string | null;
  contactNo: string | null;
  email: string | null;
  representativeName: string | null;
  tin: string | null;
  vatStatus: 'vat_registered' | 'non_vat' | null;
  classification: 'corporate' | 'individual' | 'other' | null;
  issuesOfficialReceipt: boolean;
  creditTermsDays: number | null;
  bankName: string | null;
  bankAccountName: string | null;
  bankAccountNumber: string | null;
  status: 'active' | 'inactive';
  counterpartyV1StoreId: string | null;
  links: PlannedPartyLink[];
}
export interface CustomerCreate {
  op: 'create';
  entity: 'customer';
  name: string;
  address: string | null;
  contactNo: string | null;
  group: 'wholesale' | 'internal' | 'staff' | 'other';
  status: 'active' | 'inactive';
  counterpartyV1StoreId: string | null;
  links: PlannedPartyLink[];
}
export interface PartyLinkWrite {
  op: 'link';
  entity: PartyEntity;
  v2Id: string;
  links: PlannedPartyLink[];
}
export type PartyWrite = SupplierCreate | CustomerCreate | PartyLinkWrite;
export interface PartyDrift {
  entity: PartyEntity;
  v1Id: string;
  v1StoreId: string;
  v2Id: string;
  field: string;
  v1: string;
  v2: string;
}
export interface StalePartyAnswer {
  sheet: string;
  row_key: string;
  item: string;
  answer: Row;
}
export interface PartiesPlan {
  writes: PartyWrite[];
  sheets: Record<PartySheet, Row[]>;
  stale: StalePartyAnswer[];
  drift: PartyDrift[];
  /** Reported in the run report, nothing to answer (masked bank number, a credit term v1 cannot give). */
  listed: Array<{ entity: PartyEntity; name: string; note: string }>;
  /** Rows Ian still has to answer (twins and tax). Franchise rows are information and never count. */
  held: number;
}
export interface PlanPartiesInput {
  snapshot: PartiesSnapshot;
  map: readonly StoreMapRow[];
  orgCode: string;
  storeCodes?: readonly string[];
  existingSuppliers: readonly ExistingParty[];
  existingCustomers: readonly ExistingParty[];
  links: readonly PartyLink[];
  answers: Record<string, Row[]>;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
const norm = (v: unknown): string => str(v).toLowerCase();

const mapVat = (v: unknown): 'vat_registered' | 'non_vat' | '' => {
  const t = norm(v).replace(/[\s_.-]+/g, '');
  if (t === 'vatreg' || t === 'vatregistered' || t === 'vat') return 'vat_registered';
  if (t === 'nonvatreg' || t === 'nonvat' || t === 'nonvatregistered') return 'non_vat';
  return '';
};
const mapSupplierClass = (v: unknown): 'corporate' | 'individual' | 'other' | '' => {
  const t = norm(v);
  if (t === 'corporate' || t === 'individual' || t === 'other') return t;
  return '';
};
const mapCustomerGroup = (v: unknown): 'wholesale' | 'staff' | 'other' => {
  const t = norm(v);
  if (t === 'staff') return 'staff';
  if (t === '' || t === 'individual' || t === 'corporate') return 'wholesale';
  return 'other';
};

interface Rec {
  id: string;
  store: string;
  code: string;
  name: string;
  updatedAt: string;
  active: boolean;
  /** own-store link (this org's store) or null */
  own: string | null;
  src: any;
}
interface Candidate {
  k: string;
  name: string;
  recs: Rec[];
  v2?: ExistingParty;
}
interface Entity {
  name: string;
  recs: Rec[];
  v2Hint?: ExistingParty;
}

export function planParties(input: PlanPartiesInput): PartiesPlan {
  const orgRows = selectTargetStores(input.map, { orgCode: input.orgCode });
  const scopeRows = selectTargetStores(input.map, { orgCode: input.orgCode, storeCodes: input.storeCodes });
  const codeOf = new Map(orgRows.map((r) => [r.v1StoreId, r.storeCode]));
  const order = new Map(orgRows.map((r, i) => [r.v1StoreId, i]));
  const scope = new Set(scopeRows.map((r) => r.v1StoreId));
  const mapById = new Map(input.map.map((r) => [r.v1StoreId, r]));

  const sheets = Object.fromEntries(PARTY_SHEETS.map((s) => [s, [] as Row[]])) as Record<PartySheet, Row[]>;
  const emitted = Object.fromEntries(PARTY_SHEETS.map((s) => [s, new Set<string>()])) as Record<PartySheet, Set<string>>;
  const answerByKey = Object.fromEntries(
    PARTY_SHEETS.map((s) => [s, new Map((input.answers[s] ?? []).map((r) => [(r.row_key ?? '').trim(), r] as const))]),
  ) as Record<PartySheet, Map<string, Row>>;
  const emit = (sheet: PartySheet, row: Row): Row => {
    const a = answerByKey[sheet].get(row.row_key!);
    if (a) for (const c of ANSWER_COLUMNS[sheet]) row[c] = (a[c] ?? '').trim();
    emitted[sheet].add(row.row_key!);
    sheets[sheet].push(row);
    return row;
  };

  const writes: PartyWrite[] = [];
  const drift: PartyDrift[] = [];
  const listed: PartiesPlan['listed'] = [];
  let held = 0;

  const planEntity = (entity: PartyEntity): void => {
    const source: any[] = (entity === 'supplier' ? input.snapshot.suppliers : input.snapshot.arCustomers) ?? [];
    const existing = entity === 'supplier' ? input.existingSuppliers : input.existingCustomers;
    const twinSheet: PartySheet = entity === 'supplier' ? 'suppliers-twins' : 'customers-twins';
    const nameOf = (r: any): string => str(entity === 'supplier' ? r.businessName : r.name);

    const linked = new Map<string, string>();
    for (const l of input.links) if (l.entity === entity) linked.set(`${l.v1StoreId}|${l.v1Id}`, l.v2Id);
    const isLinked = (r: Rec): boolean => linked.has(`${r.store}|${r.id}`);
    const existingById = new Map(existing.map((e) => [e.id, e]));
    const existingByKey = new Map(existing.map((e) => [key(e.name), e]));

    // ---- the org's records, in store order; franchise-pointing and nameless ones set aside
    const recs: Rec[] = [];
    for (const s of source) {
      if (!order.has(s.store)) continue;
      const name = nameOf(s);
      const code = codeOf.get(s.store)!;
      const id = String(s.id);
      const lk = str(s.linkedStoreId);
      const target = lk ? mapById.get(lk) : undefined;
      const toFranchise = !!target && target.role === 'franchise' && target.orgCode !== input.orgCode;
      const rec: Rec = {
        id,
        store: s.store,
        code,
        name,
        updatedAt: str(s.updatedAt),
        active: entity === 'supplier' ? s.isActive !== false : norm(s.status) !== 'inactive',
        own: target && target.role === 'own' && target.orgCode === input.orgCode ? lk : null,
        src: s,
      };
      if (linked.has(`${s.store}|${id}`)) {
        recs.push(rec);
        continue;
      }
      if (toFranchise) {
        emit('parties-held', {
          row_key: rowKey('parties-held', entity, s.store, id, 'franchise'),
          entity,
          name: name || `(no name) ${id}`,
          stores: code,
          reason: 'franchise',
          note: `points at the franchise store ${target!.storeCode || target!.name}; waits for the franchise org (information only, not written here)`,
        });
        continue;
      }
      if (!name) {
        emit('parties-held', {
          row_key: rowKey('parties-held', entity, s.store, id, 'nameless'),
          entity,
          name: `(no name) ${id}`,
          stores: code,
          reason: 'no name',
          note: 'v1 record with no name: never imported',
        });
        continue;
      }
      recs.push(rec);
    }
    recs.sort((a, b) => order.get(a.store)! - order.get(b.store)! || a.id.localeCompare(b.id));

    const byKey = new Map<string, Rec[]>();
    for (const r of recs) {
      if (!r.name) continue;
      const k = key(r.name);
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k)!.push(r);
    }
    const spelling = (rs: Rec[]): string => {
      const n = new Map<string, number>();
      for (const r of rs) n.set(r.name, (n.get(r.name) ?? 0) + 1);
      let best = rs[0]!.name;
      for (const [name, c] of n) if (c > n.get(best)!) best = name;
      return best;
    };
    const storesOf = (rs: Rec[]): string => [...new Set(rs.map((r) => r.code))].join(' ');
    const unlinkedInScope = (rs: Rec[]): boolean => rs.some((r) => !isLinked(r) && scope.has(r.store));

    const candidates: Candidate[] = [...byKey].map(([k, rs]) => ({ k, recs: rs, name: spelling(rs), v2: existingByKey.get(k) }));
    const open = candidates.filter((c) => c.recs.some((r) => !isLinked(r)));

    const entities: Entity[] = [];
    const groups = new Map<string, Candidate[]>();
    const openLoose = new Set(open.map((c) => loose(c.name)));
    for (const c of open) {
      const l = loose(c.name);
      if (!groups.has(l)) groups.set(l, []);
      groups.get(l)!.push(c);
    }
    for (const e of existing) {
      const l = loose(e.name);
      if (!openLoose.has(l)) continue;
      const g = groups.get(l)!;
      if (!g.some((m) => m.k === key(e.name))) g.push({ k: key(e.name), recs: [], name: e.name, v2: e });
    }

    for (const [l, members] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (members.length < 2) {
        for (const m of members) if (m.recs.length) entities.push({ name: m.name, recs: m.recs, v2Hint: m.v2 });
        continue;
      }
      const counts = unlinkedInScope(members.flatMap((m) => m.recs));
      const v2Names = members.filter((m) => m.v2).map((m) => m.v2!);
      v2Names.sort((a, b) => (a.status === 'active' ? 0 : 1) - (b.status === 'active' ? 0 : 1) || a.name.localeCompare(b.name));
      const prefill = v2Names.length
        ? v2Names[0]!.name
        : [...members].sort((a, b) => b.recs.length - a.recs.length || a.name.localeCompare(b.name))[0]!.name;
      const rows = members
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((m) => ({
          m,
          row: emit(twinSheet, {
            row_key: rowKey(twinSheet, l, m.k, m.recs.map((r) => r.store).sort().join(','), m.v2?.id ?? ''),
            group: l,
            name: m.v2 ? m.v2.name : m.name,
            stores: [storesOf(m.recs), m.v2 ? `in v2 (${m.v2.status ?? ''})` : ''].filter(Boolean).join(' '),
            same_or_different: '',
            keep_name: prefill,
            note: 'the same party typed two ways, or two parties that only look alike? same / different',
          }),
        }));
      const hold = (): void => {
        if (counts) held += rows.length;
      };
      const answers = rows.map((x) => norm(x.row.same_or_different));
      if (answers.some((a) => a !== 'same' && a !== 'different') || answers.some((a) => a !== answers[0])) {
        hold();
        continue;
      }
      if (answers[0] === 'different') {
        for (const d of rows) if (d.m.recs.length) entities.push({ name: d.m.name, recs: d.m.recs, v2Hint: d.m.v2 });
        continue;
      }
      const typed = [...new Set(rows.map((x) => (x.row.keep_name ?? '').trim()).filter((n) => n !== ''))];
      const edited = typed.filter((n) => key(n) !== key(prefill));
      if (edited.length > 1) {
        hold();
        continue;
      }
      const keep = edited[0] ?? typed[0] ?? prefill;
      const names = new Set(members.flatMap((m) => [key(m.name), ...(m.v2 ? [key(m.v2.name)] : [])]));
      if (!names.has(key(keep))) {
        hold();
        continue;
      }
      const v2s = rows.map((x) => x.m.v2).filter((v): v is ExistingParty => !!v);
      const hint = v2s.find((v) => key(v.name) === key(keep)) ?? v2s[0];
      const merged = rows.flatMap((x) => x.m.recs).sort((x, y) => order.get(x.store)! - order.get(y.store)! || x.id.localeCompare(y.id));
      if (merged.length) entities.push({ name: keep, recs: merged, v2Hint: hint });
    }
    entities.sort((a, b) => key(a.name).localeCompare(key(b.name)));

    // ---- decide each entity
    const newest = (rs: Rec[]): Rec[] =>
      rs.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || order.get(a.store)! - order.get(b.store)! || a.id.localeCompare(b.id));
    const pick = (rs: Rec[], get: (r: Rec) => string): string => {
      for (const r of newest(rs)) {
        const v = get(r);
        if (v !== '') return v;
      }
      return '';
    };
    const phoneOf = (s: any): string => {
      for (const c of Array.isArray(s.contacts) ? s.contacts : []) {
        const p = str(c?.phone);
        if (p) return p;
      }
      return '';
    };
    const orNull = (v: string): string | null => (v === '' ? null : v);
    const fieldsOf = (r: Rec): Record<string, string> =>
      entity === 'supplier'
        ? { contactNo: phoneOf(r.src), address: str(r.src.address), email: str(r.src.email), representativeName: str(r.src.representative) }
        : { contactNo: str(r.src.contactNo), address: str(r.src.address) };

    for (const e of entities) {
      const unlinked = e.recs.filter((r) => !isLinked(r));
      const target =
        e.v2Hint ??
        existingByKey.get(key(e.name)) ??
        (() => {
          for (const r of e.recs) {
            const id = linked.get(`${r.store}|${r.id}`);
            if (id) return existingById.get(id) ?? ({ id, name: e.name } as ExistingParty);
          }
          return undefined;
        })();

      if (target) {
        const toLink = unlinked.filter((r) => scope.has(r.store));
        if (toLink.length) writes.push({ op: 'link', entity, v2Id: target.id, links: toLink.map((r) => ({ v1StoreId: r.store, v1Id: r.id })) });
        continue;
      }
      if (unlinked.length === 0) continue;

      const inScope = unlinkedInScope(e.recs);
      const links = unlinked.filter((r) => scope.has(r.store)).map((r) => ({ v1StoreId: r.store, v1Id: r.id }));
      const status: 'active' | 'inactive' = e.recs.some((r) => r.active) ? 'active' : 'inactive';
      const own = pick(e.recs, (r) => r.own ?? '') || null;
      const base = {
        name: e.name,
        address: orNull(pick(e.recs, (r) => fieldsOf(r).address!)),
        contactNo: orNull(pick(e.recs, (r) => fieldsOf(r).contactNo!)),
        status,
        counterpartyV1StoreId: own,
        links,
      };

      if (entity === 'customer') {
        const group = own ? 'internal' : mapCustomerGroup(pick(e.recs, (r) => norm(r.src.classification)));
        if (inScope) writes.push({ op: 'create', entity: 'customer', ...base, group });
        continue;
      }

      // ---- supplier tax: two different non-blank values hold the party (P3, P10)
      // P13: a non-blank value the map does not know is a DISTINCT value, never silently null
      const vatOf = (r: Rec): string => mapVat(r.src.vatStatus) || (norm(r.src.vatStatus) ? `unmapped:${norm(r.src.vatStatus)}` : '');
      const vats = [...new Set(e.recs.map(vatOf).filter(Boolean))];
      const vatDisputed = vats.length > 1 || vats.some((v) => v.startsWith('unmapped:'));
      const tins = [...new Set(e.recs.map((r) => str(r.src.tin)).filter(Boolean))];
      let vatStatus: 'vat_registered' | 'non_vat' | '' = (vatDisputed ? '' : (vats[0] ?? '')) as 'vat_registered' | 'non_vat' | '';
      let tin = tins[0] ?? '';
      if (vatDisputed || tins.length > 1) {
        const row = emit('suppliers-tax', {
          row_key: rowKey('suppliers-tax', key(e.name), ...e.recs.map((r) => `${r.store}:${vatOf(r)}:${str(r.src.tin)}`).sort()),
          supplier: e.name,
          stores: storesOf(e.recs),
          vat_status: vatDisputed ? '' : (vats[0] ?? ''),
          tin: tins.length > 1 ? '' : (tins[0] ?? ''),
          note: `copies disagree on ${[vatDisputed ? 'vat_status' : '', tins.length > 1 ? 'tin' : ''].filter(Boolean).join(' and ')}: ${[
            ...vats,
            ...tins,
          ].join(' / ')}; vat_status is vat_registered or non_vat`,
        });
        const answeredVat = mapVat(row.vat_status) || (row.vat_status === 'vat_registered' || row.vat_status === 'non_vat' ? row.vat_status : '');
        const vatOk = vatDisputed ? answeredVat !== '' : true;
        const tinOk = tins.length > 1 ? (row.tin ?? '').trim() !== '' : true;
        if (!vatOk || !tinOk) {
          if (inScope) held++;
          continue;
        }
        vatStatus = (vatDisputed ? answeredVat : vats[0] ?? '') as typeof vatStatus;
        tin = tins.length > 1 ? row.tin!.trim() : tins[0] ?? '';
      }

      const bankRec = newest(e.recs).find((r) => r.src.bankAccount && (str(r.src.bankAccount.bankName) || str(r.src.bankAccount.accountNumberMasked)));
      const bank = bankRec?.src.bankAccount;
      const terms = newest(e.recs).find((r) => r.src.lastCreditDueDays !== undefined && r.src.lastCreditDueDays !== null);
      const rawTerms: unknown = terms?.src.lastCreditDueDays;
      const termsN =
        typeof rawTerms === 'number' ? rawTerms : typeof rawTerms === 'string' && /^\d+$/.test(rawTerms.trim()) ? Number(rawTerms.trim()) : NaN;
      const termsOk = Number.isInteger(termsN) && termsN >= 0 && termsN <= 365;
      if (inScope && terms && !termsOk) {
        listed.push({ entity, name: e.name, note: `${e.name}: v1 credit term "${String(terms.src.lastCreditDueDays)}" is not a whole number of days from 0 to 365; left as cash on delivery (blank)` });
      }
      if (inScope && bank && str(bank.accountNumberMasked)) {
        listed.push({ entity, name: e.name, note: `${e.name}: the bank account number is masked in the snapshot and was not imported in full; re-enter it on the supplier screen` });
      }
      const receipt = newest(e.recs).find((r) => typeof r.src.issuesOfficialReceipt === 'boolean');
      const classification = pick(e.recs, (r) => mapSupplierClass(r.src.classification));
      if (inScope) {
        writes.push({
          op: 'create',
          entity: 'supplier',
          ...base,
          email: orNull(pick(e.recs, (r) => fieldsOf(r).email!)),
          representativeName: orNull(pick(e.recs, (r) => fieldsOf(r).representativeName!)),
          tin: orNull(tin),
          vatStatus: vatStatus || null,
          classification: (classification || null) as SupplierCreate['classification'],
          issuesOfficialReceipt: receipt ? receipt.src.issuesOfficialReceipt : true,
          creditTermsDays: termsOk ? termsN : null,
          bankName: orNull(str(bank?.bankName)),
          bankAccountName: orNull(str(bank?.accountName)),
          // the masked form only: the planner never reads a full account number (P8, I8)
          bankAccountNumber: orNull(str(bank?.accountNumberMasked)),
        });
      }
    }

    // ---- R13: a linked record whose v1 value differs from the linked v2 row is reported, never written
    for (const r of recs) {
      const v2Id = linked.get(`${r.store}|${r.id}`);
      const row = v2Id ? existingById.get(v2Id) : undefined;
      if (!v2Id || !row) continue;
      for (const [field, v1] of Object.entries(fieldsOf(r))) {
        if (v1 === '' || !(field in row)) continue;
        const v2 = str(row[field]);
        if (v1.toLowerCase() !== v2.toLowerCase()) drift.push({ entity, v1Id: r.id, v1StoreId: r.store, v2Id, field, v1, v2 });
      }
    }
  };

  planEntity('supplier');
  planEntity('customer');

  // ---- R11: an answer whose row_key was not emitted is ignored and listed stale
  const stale: StalePartyAnswer[] = [];
  for (const s of PARTY_SHEETS) {
    for (const a of input.answers[s] ?? []) {
      const k = (a.row_key ?? '').trim();
      if (!k || emitted[s].has(k)) continue;
      if (!STALE_TRIGGER[s].some((c) => (a[c] ?? '').trim() !== '')) continue;
      stale.push({ sheet: s, row_key: k, item: a.supplier ?? a.name ?? '', answer: a });
    }
  }
  return { writes, sheets, stale, drift, listed, held };
}

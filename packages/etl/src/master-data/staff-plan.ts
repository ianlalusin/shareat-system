/**
 * T-391 S5 - the POSITIONS + STAFF planner. PURE: no database. docs/tasks/391-production-master-data-load.md,
 * rulings S1-S13, R4, R5, R7, R11-R13, R15, invariants I1, I7, I8, I9.
 *
 *   - a v1 position equal to a canonical v2 name (case and spacing ignored) is that position; any other name waits on
 *     `positions.csv` per store: a canonical name, `new:<name>` (a store position) or `none` (S1);
 *   - nothing here grants access: a write carries a person, an employment, a position and a staff code, never a role, a
 *     grant, a PIN or a credential. Management-looking positions answered `none` are listed on `access-to-grant` (S2);
 *   - only active staff are hired (S3); one person per human within the target org (S4);
 *   - `started_on` is a Manila date (S5, S12); the first RESOLVED position is primary (S6); v1 staff codes are the
 *     override, with blank, malformed, taken and duplicated codes falling back to allocation, listed (S9, S11);
 *   - a linked record is never written again (R4); a linked person whose name changed is drift, never written (R13);
 *   - the HR sheet skeleton carries empty statutory and pay columns: nothing of them is read here (R15).
 */
import { toBusinessDate } from '@shareat/core/datetime';
import { rowKey } from './sheets';
import { selectTargetStores, type StoreMapRow } from './store-map';

type Row = Record<string, string>;

export const STAFF_SHEETS = ['positions', 'staff-same-person', 'access-to-grant', 'staff-roster'] as const;
export type StaffSheet = (typeof STAFF_SHEETS)[number];

export const STAFF_SHEET_COLUMNS: Record<StaffSheet, readonly string[]> = {
  positions: ['row_key', 'store_code', 'v1_position', 'v2_position', 'note'],
  'staff-same-person': ['row_key', 'full_name', 'stores', 'same_or_different', 'note'],
  'access-to-grant': ['row_key', 'full_name', 'store_code', 'v1_position', 'note'],
  'staff-roster': [
    'row_key', 'person_ref', 'full_name', 'store_code', 'positions', 'primary_position', 'employment_status', 'started_on',
    'staff_code', 'sss_no', 'philhealth_no', 'pagibig_no', 'tin', 'pay_basis', 'rate', 'rate_effective_from', 'hr_note',
  ],
};

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface StaffSnapshot {
  staff?: any[];
  staffIdentities?: any[];
}
export interface ExistingPosition {
  id: string;
  name: string;
  storeCode: string | null;
}
export interface ExistingPerson {
  id: string;
  displayName: string;
}
export interface StaffLink {
  entity: string;
  v1StoreId: string;
  v1Id: string;
  v2Id: string;
}
export interface PlannedEmployment {
  storeCode: string;
  v1StoreId: string;
  v1StaffId: string;
  startedOn: string;
  employmentStatus: string;
  positions: string[];
  primaryPosition: string | null;
  staffCode: string | null;
}
export interface PlannedPersonLink {
  v1StoreId: string;
  v1Id: string;
}
export interface PositionCreate {
  op: 'create';
  entity: 'position';
  storeCode: string;
  name: string;
}
export interface PersonCreate {
  op: 'create';
  entity: 'person';
  personRef: string;
  fullName: string;
  employments: PlannedEmployment[];
  personLinks: PlannedPersonLink[];
}
export interface PersonEmploy {
  op: 'employ';
  entity: 'person';
  personId: string;
  personRef: string;
  employments: PlannedEmployment[];
  personLinks: PlannedPersonLink[];
}
export type StaffWrite = PositionCreate | PersonCreate | PersonEmploy;
export interface StaffDrift {
  entity: 'person';
  v1Id: string;
  v1StoreId: string;
  v2Id: string;
  field: string;
  v1: string;
  v2: string;
}
export interface StaleStaffAnswer {
  sheet: string;
  row_key: string;
  item: string;
  answer: Row;
}
export interface StaffPlan {
  writes: StaffWrite[];
  sheets: Record<StaffSheet, Row[]>;
  stale: StaleStaffAnswer[];
  drift: StaffDrift[];
  /** Notes that need no answer. */
  listed: Array<{ entity: 'staff'; name: string; note: string }>;
  /** Rows Ian still has to answer. */
  held: number;
}
export interface PlanStaffInput {
  snapshot: StaffSnapshot;
  map: readonly StoreMapRow[];
  orgCode: string;
  storeCodes?: readonly string[];
  existingPositions: readonly ExistingPosition[];
  existingPersons: readonly ExistingPerson[];
  links: readonly StaffLink[];
  answers: Record<string, Row[]>;
  /** Staff codes v2 already holds, so a v1 code that is taken falls back to allocation. Optional. */
  existingStaffCodes?: ReadonlyArray<{ storeCode: string; staffCode: string }>;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
const collapse = (s: string): string => s.trim().replace(/\s+/g, ' ');
const ck = (s: string): string => collapse(s).toLowerCase();

const ENDED = new Set(['resigned', 'terminated', 'inactive']);
const HIRABLE_STATUSES = new Set(['regular', 'probationary', 'contractual', 'part-time']);
const MANAGEMENT = /manager|supervisor|\boic\b|in.?charge|admin|owner|\bhead\b|\blead/i;
const CODE = /^SE-\d{3}$/i;

/** A real calendar date in YYYY-MM-DD, or ''. */
const realDate = (s: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return '';
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]) ? s : '';
};
/** S12: an ISO timestamp or a date-only value, read as a Manila date; anything else ''. */
function manilaDate(v: unknown): string {
  const s = str(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return realDate(s);
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    const t = new Date(s);
    return Number.isNaN(t.getTime()) ? '' : toBusinessDate(t);
  }
  return '';
}

interface Rec {
  id: string;
  store: string;
  code: string;
  name: string;
  status: string;
  date: string;
  hiredAt: number;
  v1Code: string;
  positions: string[];
  group: string | null;
}
interface Human {
  ref: string;
  group: string | null;
  name: string;
  recs: Rec[];
  existingId?: string;
}
interface PosRow {
  row: Row;
  code: string;
}
interface PosResult {
  resolved: string[];
  open: string[];
  none: string[];
}

/**
 * S14e: the access-to-grant list across runs. Rows of an earlier run are kept whether or not the new list is empty, a row of
 * the new list wins on the same row_key. Nobody Ian has to grant by hand drops off the sheet because a later run had less.
 */
export function mergeAccessToGrant(prev: readonly Row[], next: readonly Row[]): Row[] {
  const out = new Map<string, Row>();
  for (const r of prev) out.set(r.row_key ?? '', r);
  for (const r of next) out.set(r.row_key ?? '', r);
  return [...out.values()];
}

export function planStaff(input: PlanStaffInput): StaffPlan {
  const orgRows = selectTargetStores(input.map, { orgCode: input.orgCode });
  const scopeRows = selectTargetStores(input.map, { orgCode: input.orgCode, storeCodes: input.storeCodes });
  const codeOf = new Map(orgRows.map((r) => [r.v1StoreId, r.storeCode]));
  const order = new Map(orgRows.map((r, i) => [r.v1StoreId, i]));
  const scope = new Set(scopeRows.map((r) => r.v1StoreId));

  const sheets = Object.fromEntries(STAFF_SHEETS.map((s) => [s, [] as Row[]])) as Record<StaffSheet, Row[]>;
  const answerByKey = Object.fromEntries(
    STAFF_SHEETS.map((s) => [s, new Map((input.answers[s] ?? []).map((r) => [(r.row_key ?? '').trim(), r] as const))]),
  ) as Record<StaffSheet, Map<string, Row>>;
  const emitted = Object.fromEntries(STAFF_SHEETS.map((s) => [s, new Set<string>()])) as Record<StaffSheet, Set<string>>;
  const writes: StaffWrite[] = [];
  const drift: StaffDrift[] = [];
  const listed: StaffPlan['listed'] = [];
  let held = 0;
  const list = (name: string, note: string): void => {
    listed.push({ entity: 'staff', name, note });
  };

  // ---- links
  const empLinked = new Set<string>();
  const personLink = new Map<string, string>();
  for (const l of input.links) {
    if (l.entity === 'employment') empLinked.add(`${l.v1StoreId}|${l.v1Id}`);
    else if (l.entity === 'person') personLink.set(`${l.v1StoreId}|${l.v1Id}`, l.v2Id);
  }
  const linkedPersonIds = new Set(personLink.values());
  const existingById = new Map(input.existingPersons.map((p) => [p.id, p]));

  // ---- identity groups
  const groupOf = new Map<string, string>();
  for (const g of input.snapshot.staffIdentities ?? []) {
    for (const r of Array.isArray(g?.staffRefs) ? g.staffRefs : []) {
      const k = `${str(r?.storeId)}|${str(r?.staffId)}`;
      if (!groupOf.has(k)) groupOf.set(k, str(g.id));
    }
  }

  // ---- the org's active records (S3, I1)
  const recs: Rec[] = [];
  for (const s of input.snapshot.staff ?? []) {
    if (!order.has(s.store)) continue;
    const status = str(s.employmentStatus).toLowerCase();
    if (s.isActive === false || ENDED.has(status)) continue;
    const name = collapse(str(s.fullName));
    if (!name) continue;
    const date = manilaDate(s.dateHired);
    const id = String(s.id);
    recs.push({
      id,
      store: s.store,
      code: codeOf.get(s.store)!,
      name,
      status,
      date,
      hiredAt: date ? Date.parse(`${date}T00:00:00Z`) : Number.POSITIVE_INFINITY,
      v1Code: str(s.staffCode),
      positions: (Array.isArray(s.positions) ? s.positions : []).map(str).filter(Boolean),
      group: groupOf.get(`${s.store}|${id}`) ?? null,
    });
  }
  recs.sort((a, b) => order.get(a.store)! - order.get(b.store)! || a.id.localeCompare(b.id));

  const hasEmp = (r: Rec): boolean => empLinked.has(`${r.store}|${r.id}`);
  const spelling = (rs: Rec[]): string => {
    const n = new Map<string, number>();
    for (const r of rs) n.set(r.name, (n.get(r.name) ?? 0) + 1);
    let best = rs[0]!.name;
    for (const [name, c] of n) if (c > n.get(best)!) best = name;
    return best;
  };

  // ---- one person per human (S4)
  const humans: Human[] = [];
  const individual = (r: Rec): Human => ({ ref: r.id, group: null, name: r.name, recs: [r] });
  const groups = new Map<string, Rec[]>();
  const loose: Rec[] = [];
  for (const r of recs) {
    if (r.group) {
      if (!groups.has(r.group)) groups.set(r.group, []);
      groups.get(r.group)!.push(r);
    } else loose.push(r);
  }
  for (const [gid, rs] of groups) humans.push({ ref: gid, group: gid, name: spelling(rs), recs: rs });

  const buckets = new Map<string, Rec[]>();
  for (const r of loose) {
    const k = ck(r.name);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k)!.push(r);
  }
  for (const [k, rs] of buckets) {
    const unresolved = rs.filter((r) => !hasEmp(r) && !personLink.has(`${r.store}|${r.id}`));
    const matches = input.existingPersons.filter((p) => ck(p.displayName) === k && !linkedPersonIds.has(p.id));
    const stores = new Set(rs.map((r) => r.store));
    if (unresolved.length === 0 || (stores.size < 2 && matches.length === 0)) {
      for (const r of rs) humans.push(individual(r));
      continue;
    }
    const row: Row = {
      row_key: rowKey('staff-same-person', k, ...rs.map((r) => `${r.store}:${r.id}`).sort(), ...matches.map((m) => m.id).sort()),
      full_name: spelling(rs),
      stores: [...new Set(rs.map((r) => r.code))].join(' ') + (matches.length ? ' + already in v2' : ''),
      same_or_different: '',
      note: 'the same human, or two people with one name? same / different',
    };
    const a = answerByKey['staff-same-person'].get(row.row_key!);
    if (a) row.same_or_different = (a.same_or_different ?? '').trim();
    emitted['staff-same-person'].add(row.row_key!);
    sheets['staff-same-person'].push(row);
    const ans = row.same_or_different!.toLowerCase();
    if (ans === 'different') {
      for (const r of rs) humans.push(individual(r));
    } else if (ans === 'same' && matches.length <= 1) {
      const seen = new Set<string>();
      const merged = rs.filter((r) => (seen.has(r.store) ? false : (seen.add(r.store), true)));
      for (const r of rs) if (!merged.includes(r)) list(r.name, `${r.name}: a second v1 record at ${r.code} for the same person is not hired twice.`);
      humans.push({ ref: merged[0]!.id, group: null, name: spelling(rs), recs: merged, existingId: matches[0]?.id });
    } else {
      if (ans === 'same') row.note = `${matches.length} people already in v2 carry this name; rename one first, then answer`;
      if (unresolved.some((r) => scope.has(r.store))) held++;
    }
  }
  humans.sort(
    (a, b) => order.get(a.recs[0]!.store)! - order.get(b.recs[0]!.store)! || ck(a.name).localeCompare(ck(b.name)) || a.ref.localeCompare(b.ref),
  );

  // ---- positions
  const canon = new Map<string, string>();
  const storePos = new Map<string, string>();
  for (const p of input.existingPositions) {
    if (p.storeCode === null) canon.set(ck(p.name), p.name);
    else storePos.set(`${p.storeCode}|${ck(p.name)}`, p.name);
  }
  const posRows = new Map<string, PosRow>();
  const creates = new Map<string, PositionCreate>();
  const usedCreates = new Set<string>();

  const posRowFor = (r: Rec, v1Name: string): PosRow => {
    const k = rowKey('positions', r.store, ck(v1Name));
    let pr = posRows.get(k);
    if (!pr) {
      const row: Row = {
        row_key: k,
        store_code: r.code,
        v1_position: collapse(v1Name),
        v2_position: '',
        note: 'a canonical position name, new:<name> for a store position, or none',
      };
      const a = answerByKey.positions.get(k);
      if (a) row.v2_position = (a.v2_position ?? '').trim();
      pr = { row, code: r.code };
      posRows.set(k, pr);
    }
    return pr;
  };

  const resolvePositions = (r: Rec): PosResult => {
    const out: PosResult = { resolved: [], open: [], none: [] };
    const add = (n: string): void => {
      if (!out.resolved.includes(n)) out.resolved.push(n);
    };
    const named = (n: string): string | undefined => canon.get(ck(n)) ?? storePos.get(`${r.code}|${ck(n)}`);
    const seen = new Set<string>();
    for (const v1 of r.positions) {
      const k = ck(v1);
      if (seen.has(k)) continue;
      seen.add(k);
      const c = canon.get(k);
      if (c) {
        add(c);
        continue;
      }
      const pr = posRowFor(r, v1);
      const ans = pr.row.v2_position!;
      if (ans.toLowerCase() === 'none') {
        out.none.push(collapse(v1));
      } else if (/^new:/i.test(ans) && collapse(ans.slice(4)) !== '') {
        const name = collapse(ans.slice(4));
        const have = named(name);
        if (have) add(have);
        else {
          const ckey = `${r.code}|${ck(name)}`;
          if (!creates.has(ckey)) creates.set(ckey, { op: 'create', entity: 'position', storeCode: r.code, name });
          usedCreates.add(ckey);
          add(creates.get(ckey)!.name);
        }
      } else if (ans !== '' && named(ans)) {
        add(named(ans)!);
      } else {
        if (ans !== '') pr.row.note = `"${ans}" is not a position of this organisation; write a canonical name, new:<name> or none`;
        out.open.push(collapse(v1));
      }
    }
    return out;
  };

  // ---- staff codes (S9, S11): decided per store over the records still to be hired
  const taken = new Set((input.existingStaffCodes ?? []).map((c) => `${c.storeCode}|${c.staffCode.toUpperCase()}`));
  const hirable = (r: Rec): boolean => !hasEmp(r) && scope.has(r.store);
  const codeFor = new Map<string, string | null>();
  const byStoreCode = new Map<string, Rec[]>();
  for (const r of recs.filter(hirable)) {
    if (!CODE.test(r.v1Code)) {
      codeFor.set(r.id, null);
      list(
        r.name,
        r.v1Code === ''
          ? `${r.name}: v1 has no staff code; v2 allocates one at ${r.code}.`
          : `${r.name}: v1 staff code "${r.v1Code}" is not SE-NNN; v2 allocates one at ${r.code}.`,
      );
      continue;
    }
    const k = `${r.code}|${r.v1Code.toUpperCase()}`;
    if (!byStoreCode.has(k)) byStoreCode.set(k, []);
    byStoreCode.get(k)!.push(r);
  }
  for (const [k, rs] of byStoreCode) {
    const code = k.split('|')[1]!;
    const sorted = rs.slice().sort((a, b) => a.hiredAt - b.hiredAt || a.id.localeCompare(b.id));
    const takenAlready = taken.has(k);
    sorted.forEach((r, i) => {
      if (i === 0 && !takenAlready) {
        codeFor.set(r.id, code);
        return;
      }
      codeFor.set(r.id, null);
      list(
        r.name,
        takenAlready
          ? `${r.name}: v1 staff code ${code} is already used at ${r.code} in v2; v2 allocates a new one.`
          : `${r.name}: v1 staff code ${code} is also held by an earlier hire at ${r.code}; v2 allocates a new one.`,
      );
    });
  }

  // ---- each human: roster row, drift, and the writes
  const rosterAnswers = answerByKey['staff-roster'];
  const accessSeen = new Set<string>();
  const personWrites: StaffWrite[] = [];
  const staffHeldRows = new Set<string>();

  for (const h of humans) {
    const toHire: Rec[] = [];
    const seenStore = new Set<string>();
    for (const r of h.recs) {
      if (!hirable(r) || seenStore.has(r.store)) continue;
      seenStore.add(r.store);
      toHire.push(r);
    }
    const personId =
      (h.group ? personLink.get(`|${h.group}`) : undefined) ??
      h.recs.map((r) => personLink.get(`${r.store}|${r.id}`)).find((v): v is string => !!v) ??
      h.existingId;

    const ref = h.group ?? h.recs[0]!.id;
    const rKey = rowKey('staff-roster', ...h.recs.map((r) => `${r.store}:${r.id}`).sort());
    const ra = rosterAnswers.get(rKey);
    const ansDate = ra ? manilaDate((ra.started_on ?? '').trim()) : '';
    const ansStatus = ra ? (ra.employment_status ?? '').trim().toLowerCase() : '';

    // R13: drift on an already linked person
    const linkedRec = h.recs.find((r) => hasEmp(r));
    if (linkedRec && personId && existingById.has(personId)) {
      const v2 = existingById.get(personId)!.displayName;
      if (ck(v2) !== ck(h.name)) {
        drift.push({ entity: 'person', v1Id: linkedRec.id, v1StoreId: linkedRec.store, v2Id: personId, field: 'displayName', v1: h.name, v2 });
      }
    }

    let blocked = false;
    let needsDate = false;
    let needsStatus = false;
    const emps: PlannedEmployment[] = [];
    const resultOf = new Map<Rec, PosResult>();
    for (const r of toHire) {
      const date = r.date || ansDate;
      const status = HIRABLE_STATUSES.has(r.status) ? r.status : HIRABLE_STATUSES.has(ansStatus) ? ansStatus : '';
      if (!date) needsDate = true;
      if (!status) needsStatus = true;
      const pr = resolvePositions(r);
      resultOf.set(r, pr);
      if (r.positions.length > 0 && pr.resolved.length === 0 && pr.open.length > 0) blocked = true;
      emps.push({
        storeCode: r.code,
        v1StoreId: r.store,
        v1StaffId: r.id,
        startedOn: date,
        employmentStatus: status,
        positions: pr.resolved,
        primaryPosition: pr.resolved[0] ?? null,
        staffCode: codeFor.get(r.id) ?? null,
      });
    }
    if (needsDate || needsStatus) {
      blocked = true;
      staffHeldRows.add(rKey);
    }

    // the roster row: one per human; the statutory and pay columns stay blank here (R15)
    const starts = h.recs.map((r) => r.date).filter(Boolean).sort();
    const dated = toHire.length > 0 ? !needsDate : starts.length > 0;
    sheets['staff-roster'].push({
      row_key: rKey,
      person_ref: ref,
      full_name: h.name,
      store_code: [...new Set(h.recs.map((r) => r.code))].join(' '),
      positions: [...new Set(emps.flatMap((e) => e.positions))].join('; '),
      primary_position: emps[0]?.primaryPosition ?? '',
      employment_status: emps[0]?.employmentStatus || h.recs[0]!.status,
      started_on: dated ? (toHire.length > 0 ? emps.map((e) => e.startedOn).sort()[0]! : starts[0]!) : '',
      staff_code: emps[0]?.staffCode ?? '',
      sss_no: '',
      philhealth_no: '',
      pagibig_no: '',
      tin: '',
      pay_basis: '',
      rate: '',
      rate_effective_from: '',
      hr_note: '',
    });
    emitted['staff-roster'].add(rKey);

    if (toHire.length === 0 || blocked) continue;

    // nothing blocks: note what was left out, and who needs access granted by hand (S2, S10)
    for (const r of toHire) {
      const pr = resultOf.get(r)!;
      for (const n of pr.open) {
        list(r.name, `${r.name}: v1 position "${n}" at ${r.code} is unanswered on positions.csv and was left out.`);
        if (!MANAGEMENT.test(n)) continue;
        // S14d: a management-looking position still unanswered is on the access list too, marked pending
        const k = rowKey('access-to-grant', h.name, r.store, ck(n));
        if (accessSeen.has(k)) continue;
        accessSeen.add(k);
        sheets['access-to-grant'].push({
          row_key: k,
          full_name: h.name,
          store_code: r.code,
          v1_position: n,
          note: 'pending: unanswered on positions.csv; hired without it. Answer the position, and grant access on the screen if they should have it',
        });
      }
      for (const n of pr.none) {
        if (!MANAGEMENT.test(n)) {
          list(r.name, `${r.name}: v1 position "${n}" at ${r.code} was answered none and left out.`);
          continue;
        }
        const k = rowKey('access-to-grant', h.name, r.store, ck(n));
        if (accessSeen.has(k)) continue;
        accessSeen.add(k);
        sheets['access-to-grant'].push({
          row_key: k,
          full_name: h.name,
          store_code: r.code,
          v1_position: n,
          note: 'hired without this position; grant access on the screen if they should have it',
        });
      }
    }

    const personLinks: PlannedPersonLink[] = h.group
      ? personLink.has(`|${h.group}`)
        ? []
        : [{ v1StoreId: '', v1Id: h.group }]
      : toHire.filter((r) => !personLink.has(`${r.store}|${r.id}`)).map((r) => ({ v1StoreId: r.store, v1Id: r.id }));
    if (personId) personWrites.push({ op: 'employ', entity: 'person', personId, personRef: ref, employments: emps, personLinks });
    else personWrites.push({ op: 'create', entity: 'person', personRef: ref, fullName: h.name, employments: emps, personLinks });
  }

  // ---- position rows and creates
  const sortedRows = [...posRows.values()].sort((a, b) => a.code.localeCompare(b.code) || a.row.v1_position!.localeCompare(b.row.v1_position!));
  for (const pr of sortedRows) {
    sheets.positions.push(pr.row);
    emitted.positions.add(pr.row.row_key!);
    const ans = pr.row.v2_position!;
    const rest = collapse(ans.slice(4));
    const answered =
      ans.toLowerCase() === 'none' ||
      (/^new:/i.test(ans) && rest !== '') ||
      (ans !== '' && !/not a position of this organisation/.test(pr.row.note!));
    if (!answered) held++;
  }
  // a store position is created only when a hire that is going ahead uses it
  const usedNames = new Set(personWrites.flatMap((w) => (w.entity === 'person' ? w.employments.flatMap((e) => e.positions.map((p) => `${e.storeCode}|${ck(p)}`)) : [])));
  for (const [k, c] of [...creates].sort((a, b) => a[0].localeCompare(b[0]))) if (usedCreates.has(k) && usedNames.has(k)) writes.push(c);
  held += staffHeldRows.size;
  writes.push(...personWrites);

  // ---- R11: an answer whose row_key was not emitted is ignored and listed stale
  const stale: StaleStaffAnswer[] = [];
  const TRIGGER: Partial<Record<StaffSheet, string>> = { positions: 'v2_position', 'staff-same-person': 'same_or_different' };
  for (const s of STAFF_SHEETS) {
    const col = TRIGGER[s];
    if (!col) continue;
    for (const a of input.answers[s] ?? []) {
      const k = (a.row_key ?? '').trim();
      if (!k || emitted[s].has(k) || (a[col] ?? '').trim() === '') continue;
      stale.push({ sheet: s, row_key: k, item: a.full_name ?? a.v1_position ?? '', answer: a });
    }
  }
  return { writes, sheets, stale, drift, listed, held };
}

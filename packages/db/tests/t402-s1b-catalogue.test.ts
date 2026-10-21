import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
// The catalogue is a PURE module (no db import): this file must run before any migration (unit project).
import {
  AUDIT_CATALOGUE,
  catalogueEntry,
  catalogueProblems,
  retentionFor,
  severityFor,
  type CatalogueEntry,
} from '../src/audit/catalogue';

/**
 * T-402 S1b - the event catalogue (docs/tasks/402-activity-log.md R2, R3, R4, R7, R8, R13, Invariants 4, 9, 10, 13).
 * TESTER, not BUILDER. Red today: packages/db/src/audit/catalogue.ts does not exist (module not found), so every
 * case here is red for that one reason until the builder writes it.
 *
 * NAMES THE BUILDER MUST MATCH (packages/db/src/audit/catalogue.ts):
 *   AUDIT_CATALOGUE: readonly CatalogueEntry[]   { action, category, sensitivity, retention, scope: 'store'|'org',
 *       actor: 'person'|'system'|'either', viewers: 'store'|'admin', entity, owner, reserved, clientSources: readonly string[] }
 *   catalogueEntry(action): CatalogueEntry | undefined
 *   retentionFor(category, sensitivity): 'r10y' | 'r2y'     (R7)
 *   severityFor(sensitivity): 2 | 4 | 5 | 6                 (R4)
 *   catalogueProblems(entries, writtenActions: ReadonlySet<string>): string[]   (the build guard, Invariant 9; [] = clean)
 */
const ROOT = join(__dirname, '..', '..', '..');
const SKIP = new Set(['node_modules', '.next', 'dist', 'tests', 'migrations', '.git']);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** Same scan as tests/unit/t402-s1a-action-coverage.test.ts: every action string a writer passes. */
function writtenActions(): { actions: Map<string, string[]>; dynamic: string[] } {
  const files = [join(ROOT, 'packages'), join(ROOT, 'apps'), join(ROOT, 'scripts')].flatMap((d) => walk(d));
  const actions = new Map<string, string[]>();
  const dynamic: string[] = [];
  const add = (a: string, f: string) => actions.set(a, [...(actions.get(a) ?? []), relative(ROOT, f)]);
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    if (/auditLogRepo\.append(System)?\(/.test(text)) {
      for (const m of text.matchAll(/^\s*action:\s*([^\n]*)$/gm)) {
        const expr = m[1]!.includes('?') ? m[1]!.slice(m[1]!.indexOf('?')) : m[1]!;
        const quoted = [...expr.matchAll(/'([a-z][a-z0-9_.]*)'/g)].map((q) => q[1]!);
        if (quoted.length === 0 && !/^string[,\s]/.test(m[1]!.trim())) dynamic.push(`${relative(ROOT, f)}: action: ${m[1]}`);
        for (const q of quoted) add(q, f);
      }
    }
    for (const m of text.matchAll(/\baudit\(\s*\w+\s*,\s*\w+\s*,\s*'([a-z][a-z0-9_.]*)'/g)) add(m[1]!, f);
  }
  return { actions, dynamic };
}

/** The 48 actions written today, with the labels migration 0197 copied them under (S1a audit, byte-identical, Invariants 10 and 13). */
const LEGACY: Readonly<Record<string, string>> = {
  reopen_pin_sign_in: 'security/high', set_supplier_credit_terms: 'money/normal', set_supplier_status: 'money/normal',
  set_supplier_bank_account: 'money/high', set_supplier_counterparty_store: 'money/normal', set_channel_payout: 'money/high',
  set_customer_status: 'customer/normal', change_item_base_unit: 'stock/normal', set_item_purchase_unit: 'stock/normal',
  rename_item: 'stock/normal', retire_item: 'stock/normal', restore_item: 'stock/normal', set_staff_code: 'security/high',
  link_store_to_pos: 'settings/normal', unlink_store_from_pos: 'settings/normal', create_tender: 'money/normal',
  update_tender: 'money/normal', reactivate_tender: 'money/normal', retire_tender: 'money/normal', edit_sales_day: 'money/high',
  reimport_sales_day: 'money/high', set_platform_sales: 'money/normal', 'dual_run.compare': 'money/normal',
  master_data_load: 'data/high', menu_category_create: 'menu_price/normal', menu_category_edit: 'menu_price/normal',
  menu_item_create: 'menu_price/normal', menu_item_edit: 'menu_price/normal', menu_variant_create: 'menu_price/normal',
  menu_variant_edit: 'menu_price/normal', menu_offer_set: 'menu_price/high', menu_offer_cancel: 'menu_price/high',
  menu_offer_withdraw: 'menu_price/high', menu_option_offer_cancel: 'menu_price/high', menu_depletion_rule_set: 'stock/high',
  menu_depletion_rule_cancel: 'stock/high', menu_item_request: 'menu_price/normal', menu_item_request_approve: 'menu_price/normal',
  menu_item_request_duplicate: 'menu_price/normal', menu_item_request_reject: 'menu_price/normal',
  menu_item_request_withdraw: 'menu_price/normal', menu_option_group_create: 'menu_price/normal',
  menu_option_group_edit: 'menu_price/normal', menu_option_group_link: 'menu_price/normal', menu_option_group_unlink: 'menu_price/normal',
  recode_item: 'stock/normal', // one-time T-386 S5 recode script rows live in production; reserved (no caller)
  menu_option_value_create: 'menu_price/normal', menu_option_value_edit: 'menu_price/normal', menu_package_refills_set: 'menu_price/normal',
};

const CATEGORIES = ['security', 'order', 'money', 'menu_price', 'stock', 'staff', 'settings', 'data', 'customer'];
const SENSITIVITIES = ['critical', 'high', 'normal', 'low'];

/** Independent restatement of R7 (so the catalogue's own function is not checked against itself). */
function expectedRetention(category: string, sensitivity: string): 'r10y' | 'r2y' {
  if (['money', 'order', 'menu_price', 'customer'].includes(category)) return 'r10y';
  if (sensitivity === 'critical' || sensitivity === 'high') return 'r10y';
  return sensitivity === 'low' ? 'r2y' : 'r10y';
}

describe('T-402 S1b - the catalogue is closed, typed and in one file (R2, R3, R4)', () => {
  it('has roughly the specified size (~95 entries; the 22 existing + ~33 S2/S3 + ~40 reserved) and every entry has every field', () => {
    expect(AUDIT_CATALOGUE.length).toBeGreaterThanOrEqual(90);
    expect(AUDIT_CATALOGUE.length).toBeLessThanOrEqual(190); // 170 -> 190, T-436: 11 leave.*/leave_cap/leave_type/sil/leave_document audit actions; 160 -> 170, T-434: staff_photo.*/staff_signature.* audit actions (set/replaced/removed/viewed/view_refused); raise deliberately
    for (const e of AUDIT_CATALOGUE) {
      expect(typeof e.action, 'action').toBe('string');
      expect(CATEGORIES, `${e.action} category`).toContain(e.category);
      expect(SENSITIVITIES, `${e.action} sensitivity`).toContain(e.sensitivity);
      expect(['r10y', 'r2y'], `${e.action} retention`).toContain(e.retention);
      // T-412: 'either' (destructive.approved) - a store-scoped record carries its store, an organisation-level one carries none.
      expect(['store', 'org', 'either'], `${e.action} scope`).toContain(e.scope);
      expect(['person', 'system', 'either'], `${e.action} actor`).toContain(e.actor);
      expect(['store', 'admin'], `${e.action} viewers`).toContain(e.viewers);
      expect(e.entity.length, `${e.action} entity`).toBeGreaterThan(0);
      expect(e.owner, `${e.action} owner (task id)`).toMatch(/^T-\d+/);
      expect(typeof e.reserved, `${e.action} reserved`).toBe('boolean');
      expect(Array.isArray(e.clientSources), `${e.action} clientSources`).toBe(true);
    }
  });

  it('one entry per action (no duplicates) and catalogueEntry finds exactly that entry; an unknown action finds nothing', () => {
    const names = AUDIT_CATALOGUE.map((e) => e.action);
    expect(new Set(names).size).toBe(names.length);
    for (const e of AUDIT_CATALOGUE) expect(catalogueEntry(e.action)).toBe(e);
    expect(catalogueEntry('definitely.not_an_action')).toBeUndefined();
    expect(catalogueEntry('')).toBeUndefined();
  });

  it('new actions are dotted <area>.<verb>; only the 48 legacy actions are snake_case without a dot (R2, R1 byte-identical)', () => {
    for (const e of AUDIT_CATALOGUE) {
      if (e.action in LEGACY) continue;
      expect(e.action, `${e.action} must be <area>.<verb>`).toMatch(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/);
    }
  });

  it('Invariant 10/13: all 49 legacy actions are present, NOT reserved (except the split master_data_load and the retired recode_item), with exactly the labels migration 0197 copied them under', () => {
    for (const [action, label] of Object.entries(LEGACY)) {
      const e = catalogueEntry(action);
      expect(e, `${action} missing from the catalogue`).toBeDefined();
      expect(`${e!.category}/${e!.sensitivity}`, `${action} label`).toBe(label);
      // orchestrator ruling: master_data_load is split into master_data.*_load; the legacy string stays catalogued but reserved
      expect(e!.reserved, `${action} reserved?`).toBe(action === 'master_data_load' || action === 'recode_item');
      expect(e!.clientSources, `${action} is server-only`).toEqual([]);
    }
  });

  it('R4: severityFor maps critical 2, high 4, normal 5, low 6', () => {
    expect([severityFor('critical'), severityFor('high'), severityFor('normal'), severityFor('low')]).toEqual([2, 4, 5, 6]);
  });

  it('Invariant 4 / R7: retentionFor - money+low is r10y, security+low is r2y, any critical is r10y; entries carry the derived value', () => {
    expect(retentionFor('money', 'low')).toBe('r10y');
    expect(retentionFor('order', 'low')).toBe('r10y');
    expect(retentionFor('menu_price', 'low')).toBe('r10y');
    expect(retentionFor('customer', 'low')).toBe('r10y');
    expect(retentionFor('security', 'low')).toBe('r2y');
    expect(retentionFor('data', 'low')).toBe('r2y');
    expect(retentionFor('security', 'critical')).toBe('r10y');
    expect(retentionFor('settings', 'critical')).toBe('r10y');
    expect(retentionFor('security', 'high')).toBe('r10y');
    expect(retentionFor('security', 'normal')).toBe('r10y'); // Q2: no middle class
    for (const c of CATEGORIES) {
      for (const s of SENSITIVITIES) expect(retentionFor(c as never, s as never), `${c}/${s}`).toBe(expectedRetention(c, s));
    }
    for (const e of AUDIT_CATALOGUE) {
      expect(e.retention, `${e.action} retention is derived, never hand-written`).toBe(expectedRetention(e.category, e.sensitivity));
    }
  });

  it('R7 database CHECK shape: no entry could be filed r2y unless it is low and outside money/order/menu_price/customer', () => {
    for (const e of AUDIT_CATALOGUE.filter((x) => x.retention === 'r2y')) {
      expect(e.sensitivity).toBe('low');
      expect(['money', 'order', 'menu_price', 'customer']).not.toContain(e.category);
    }
  });
});

/** Entries the spec names with a fixed label. [action, category, sensitivity, extra]. S2/S3/POS/customer entries ship `reserved` at S1b. */
const SPEC: ReadonlyArray<readonly [string, string, string, Partial<CatalogueEntry>?]> = [
  ['auth.signin_succeeded', 'security', 'low'],
  ['auth.signin_refused', 'security', 'normal'],
  ['auth.pin_signin_succeeded', 'security', 'low'],
  ['auth.pin_paused', 'security', 'high'],
  ['auth.pin_stopped_for_day', 'security', 'critical'],
  ['session.ended', 'security', 'low'],
  ['session.ended_all', 'security', 'high'],
  ['credential.linked', 'security', 'high', { viewers: 'admin' }],
  ['credential.unlinked', 'security', 'high', { viewers: 'admin' }],
  ['credential.pin_set', 'security', 'high'],
  ['role.assigned', 'security', 'high', { viewers: 'admin' }],
  ['capability.granted', 'security', 'high', { viewers: 'admin' }],
  ['manager.elevated', 'security', 'critical', { viewers: 'admin' }],
  ['security.authorize_denied', 'security', 'normal', { viewers: 'admin' }],
  ['security.authorize_denied_summary', 'security', 'normal', { viewers: 'admin' }],
  ['security.event_replay_conflict', 'security', 'high'],
  ['security.event_store_mismatch', 'security', 'high'],
  ['employment.created', 'staff', 'normal'],
  ['employment.ended', 'staff', 'normal'],
  ['employment.positions_set', 'staff', 'normal'],
  ['data.export_downloaded', 'data', 'high', { viewers: 'admin' }],
  ['data.bulk_import_applied', 'data', 'high'],
  ['data.activity_log_exported', 'data', 'high', { viewers: 'admin' }],
  ['expense.drafted', 'money', 'normal'],
  ['expense.submitted', 'money', 'normal'],
  ['expense.approved', 'money', 'normal'],
  ['expense.rejected', 'money', 'normal'],
  ['expense.voided', 'money', 'normal'],
  ['sales_day.submitted', 'money', 'normal'],
  ['sales_day.verified', 'money', 'normal'],
  ['sales_day.reopened', 'money', 'normal'],
  ['remittance.recorded', 'money', 'normal'],
  ['remittance.confirmed', 'money', 'normal'],
  ['cash_request.approved', 'money', 'normal'],
  ['cash_request.rejected', 'money', 'normal'],
  ['ap_invoice.approved', 'money', 'normal'],
  ['ap_payment.recorded', 'money', 'normal'],
  // reserved for POS v2 / customer v2
  ['pos.drawer_opened_no_sale', 'money', 'high'],
  ['pos.tender_changed_after_payment', 'money', 'high'],
  ['pos.session_voided', 'order', 'high'],
  ['pos.item_unvoided', 'order', 'high'],
  ['pos.statutory_discount_voided', 'order', 'high'],
  ['pos.item_marked_free', 'order', 'high'],
  ['pos.price_overridden', 'order', 'high'],
  ['pos.package_qty_overridden', 'order', 'high'],
  ['pos.receipt_edited', 'order', 'high'],
  ['pos.receipt_voided', 'order', 'high'],
  ['pos.receipt_refunded', 'order', 'high'],
  ['pos.receipt_deleted', 'order', 'critical'],
  ['pos.manager_override', 'order', 'high'],
  ['pos.payment_completed', 'order', 'low'],
  ['loyalty.points_transferred', 'customer', 'high'],
  ['loyalty.points_adjusted', 'customer', 'high'],
  ['customer.password_reset_by_manager', 'security', 'high', { scope: 'store', viewers: 'store', actor: 'person' }],
  ['customer.password_reset_refused', 'security', 'high'],
];

/** T-402 S2 + S3: the entries those slices make live. Not here: authorize_denied_summary (S5), expense.submitted/rejected, sales_day.reopened, remittance.confirmed, data.* (reserved, no verb: S3 C4/C5). */
const S2_LIVE: ReadonlySet<string> = new Set([
  'auth.signin_succeeded', 'auth.signin_refused', 'auth.pin_signin_succeeded', 'auth.pin_paused', 'auth.pin_stopped_for_day',
  'session.ended', 'session.ended_all', 'credential.linked', 'credential.unlinked', 'credential.pin_set',
  'role.assigned', 'capability.granted', 'manager.elevated', 'security.authorize_denied',
  'employment.created', 'employment.ended', 'employment.positions_set',
  // T-402 S3 (C7): the money steps before posting, the two envelope failure events and the cutover trio
  'expense.drafted', 'expense.approved', 'expense.voided', 'sales_day.submitted', 'sales_day.verified', 'remittance.recorded',
  'cash_request.approved', 'cash_request.rejected', 'ap_invoice.approved', 'ap_payment.recorded',
  'security.event_replay_conflict', 'security.event_store_mismatch', 'cutover.purge', 'cutover.opening_entry', 'cutover.step_completed',
]);

describe('T-402 S1b - the entries the spec names are in, graded as written (R3, R4, R13, seed table)', () => {
  for (const [action, category, sensitivity, extra] of SPEC) {
    it(`${action}: ${category}/${sensitivity}${extra ? ' ' + JSON.stringify(extra) : ''}, shipped reserved until its slice/app exists`, () => {
      const e = catalogueEntry(action);
      expect(e, `${action} missing`).toBeDefined();
      expect(e!.category).toBe(category);
      expect(e!.sensitivity).toBe(sensitivity);
      // T-402 S2 flips its 17 entries live (they gain a caller); every other entry stays reserved until its slice/app exists.
      expect(e!.reserved, `${action} reserved?`).toBe(!S2_LIVE.has(action));
      for (const [k, v] of Object.entries(extra ?? {})) expect((e as unknown as Record<string, unknown>)[k], `${action}.${k}`).toEqual(v);
    });
  }

  it('orchestrator ruling (S1b audit): set_staff_code is admin-viewed (a manager cannot see staff codes); reopen_pin_sign_in stays store-viewable', () => {
    expect(catalogueEntry('set_staff_code')!.viewers).toBe('admin');
    expect(catalogueEntry('reopen_pin_sign_in')!.viewers).toBe('store');
  });

  it('R13: there is no self-service diner password reset event', () => {
    expect(AUDIT_CATALOGUE.filter((e) => /password_reset/.test(e.action)).map((e) => e.action).sort()).toEqual([
      'customer.password_reset_by_manager',
      'customer.password_reset_refused',
    ]);
  });

  it('Q3/R8: grants, credential changes, denials and cutover are admin-viewed; ordinary legacy changes are store-viewed', () => {
    for (const e of AUDIT_CATALOGUE) {
      if (/^(credential|role|capability|manager|cutover)\./.test(e.action) || /^security\.authorize_denied/.test(e.action)) {
        expect(e.viewers, `${e.action} must be admin-only`).toBe('admin');
      }
    }
    for (const a of ['rename_item', 'create_tender', 'link_store_to_pos', 'set_customer_status']) {
      expect(catalogueEntry(a)!.viewers, a).toBe('store');
    }
  });
});

describe('T-402 S1b - client sources (R2, R10c): what the POS and the customer app may send', () => {
  it('POS may send only pos.* and order-category entries; the customer app only customer.* / loyalty.*; never the server-only families', () => {
    const FORBIDDEN = /^(security|auth|role|capability|credential|manager|cutover|data|session)\./;
    for (const e of AUDIT_CATALOGUE) {
      for (const src of e.clientSources) {
        expect(['pos', 'customer'], `${e.action} source ${src}`).toContain(src);
        expect(FORBIDDEN.test(e.action), `${e.action} is server-only and must list no client source`).toBe(false);
        if (src === 'pos') expect(e.action.startsWith('pos.') || e.category === 'order', `${e.action} pos`).toBe(true);
        if (src === 'customer') expect(/^(customer|loyalty)\./.test(e.action), `${e.action} customer`).toBe(true);
      }
    }
    expect(catalogueEntry('pos.receipt_voided')!.clientSources).toContain('pos');
    expect(catalogueEntry('role.assigned')!.clientSources).toEqual([]);
    expect(catalogueEntry('capability.granted')!.clientSources).toEqual([]);
  });

  it('a system-actor entry can never be sent by a client', () => {
    for (const e of AUDIT_CATALOGUE) {
      if (e.actor === 'system') expect(e.clientSources, `${e.action}: a client cannot send a system entry`).toEqual([]);
    }
  });
});

describe('T-402 S1b - the build guard (Invariant 9)', () => {
  const { actions, dynamic } = writtenActions();
  const written = new Set(actions.keys());

  it('the scan is not vacuous: it sees the live writers (incl. ternary retire/restore, menu audit(), dual_run.compare)', () => {
    expect(written.size).toBeGreaterThanOrEqual(48);
    for (const a of ['retire_item', 'restore_item', 'menu_item_create', 'dual_run.compare', 'master_data.items_load', 'master_data.staff_load', 'menu.option_offer_set', 'reopen_pin_sign_in']) {
      expect(written.has(a), a).toBe(true);
    }
    expect(dynamic, 'no writer passes an action the scan cannot read').toEqual([]);
  });

  it('REAL TREE: the catalogue and the code agree - every written action is catalogued and not reserved; every non-reserved entry has a caller; no reserved entry has one; no duplicates', () => {
    expect(catalogueProblems(AUDIT_CATALOGUE, written)).toEqual([]);
  });

  it('guard detects a duplicate action (mutant: duplicates allowed)', () => {
    const dup = [...AUDIT_CATALOGUE, AUDIT_CATALOGUE[0]!];
    expect(catalogueProblems(dup, written).length).toBeGreaterThan(0);
  });

  it('guard detects a RESERVED entry that has a caller (mutant: reserved unchecked)', () => {
    const reserved = AUDIT_CATALOGUE.find((e) => e.reserved)!;
    expect(reserved).toBeDefined();
    expect(catalogueProblems(AUDIT_CATALOGUE, new Set([...written, reserved.action])).length).toBeGreaterThan(0);
  });

  it('guard detects a NON-reserved entry with no caller (mutant: dead entry tolerated)', () => {
    const live = AUDIT_CATALOGUE.find((e) => !e.reserved)!;
    const without = new Set([...written].filter((a) => a !== live.action));
    expect(catalogueProblems(AUDIT_CATALOGUE, without).length).toBeGreaterThan(0);
  });

  it('guard detects a written action that is not in the catalogue at all (the writer would throw UNKNOWN_AUDIT_ACTION in production)', () => {
    expect(catalogueProblems(AUDIT_CATALOGUE, new Set([...written, 'made.up_action'])).length).toBeGreaterThan(0);
  });

  it('Static callers (R1, R14): every auditLogRepo.append call passes storeId and no longer passes entity or any label', () => {
    const files = [join(ROOT, 'packages'), join(ROOT, 'apps'), join(ROOT, 'scripts')]
      .flatMap((d) => walk(d))
      .filter((f) => !f.endsWith(join('repo', 'audit-log.ts')));
    const bad: string[] = [];
    let calls = 0;
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      let idx = text.indexOf('auditLogRepo.append(');
      while (idx !== -1) {
        let depth = 0;
        let i = text.indexOf('(', idx);
        const start = i;
        for (; i < text.length; i++) {
          if (text[i] === '(') depth++;
          else if (text[i] === ')' && --depth === 0) break;
        }
        const body = text.slice(start, i);
        calls++;
        const where = `${relative(ROOT, f)}@${text.slice(0, idx).split('\n').length}`;
        if (!/\bstoreId\b/.test(body)) bad.push(`${where}: no storeId`);
        if (/^\s*entity:/m.test(body)) bad.push(`${where}: still passes entity (the catalogue owns it)`);
        if (/^\s*(category|sensitivity|severity|retention\w*):/m.test(body)) bad.push(`${where}: passes a label`);
        const acts = [...body.matchAll(/'([a-z][a-z0-9_.]*)'/g)].map((m) => m[1]!).filter((a) => catalogueEntry(a));
        for (const a of acts) {
          if (catalogueEntry(a)!.scope === 'org' && /storeId:\s*(?!null\b)\S[^,\n]*/.test(body)) bad.push(`${where}: ${a} is org-scoped but passes a store`);
        }
        idx = text.indexOf('auditLogRepo.append(', idx + 1);
      }
    }
    expect(calls, 'sanity: the scan found the callers').toBeGreaterThanOrEqual(20);
    expect(bad).toEqual([]);
  });
});

describe('T-402 S3 (C7) - the cutover trio is live, admin-viewed, written by a person or the system', () => {
  for (const a of ['cutover.purge', 'cutover.opening_entry', 'cutover.step_completed']) {
    it(`${a}: live, admin viewers, actor either, data/org-scoped, server-only`, () => {
      const e = catalogueEntry(a)!;
      expect(e.reserved).toBe(false);
      expect(e.viewers).toBe('admin');
      expect(e.actor).toBe('either');
      expect(e.category).toBe('data');
      expect(e.scope).toBe('org');
      expect(e.clientSources).toEqual([]);
    });
  }
  it('S3 leaves the verb-less entries reserved: expense.submitted/rejected, sales_day.reopened, remittance.confirmed, data.export_downloaded, data.bulk_import_applied, data.activity_log_exported', () => {
    for (const a of ['expense.submitted', 'expense.rejected', 'sales_day.reopened', 'remittance.confirmed', 'data.export_downloaded', 'data.bulk_import_applied', 'data.activity_log_exported']) {
      expect(catalogueEntry(a)!.reserved, a).toBe(true);
    }
  });
});

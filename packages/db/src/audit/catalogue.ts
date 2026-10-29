/**
 * T-402 S1b (R2, R3, R4, R7, R8, R10, R13) - the event catalogue: closed, typed, in ONE file.
 *
 * Every action the activity log can hold has exactly one entry here, and the entry - never the call site - decides
 * its category, sensitivity (and so severity), retention, scope, who may write it, who may read it and the entity
 * it is about. The writer (`repo/audit-log.ts`) refuses an unknown action, a reserved one, an actor or a scope
 * that does not match. `catalogueProblems` is the build guard (Invariant 9).
 *
 * `reserved: true` means no caller exists yet: the S2/S3 entries until their slice flips them, and every POS v2 /
 * customer v2 entry until those apps exist. A reserved entry cannot be written by `append` / `appendSystem`.
 *
 * PURE: no imports, so the unit tests run before any migration. The 48 snake_case legacy actions keep their
 * strings byte-identical and carry exactly the labels migration 0197 copied them under (Invariants 10, 13); new
 * actions are dotted `<area>.<verb>`.
 */
export type AuditCategory = 'security' | 'order' | 'money' | 'menu_price' | 'stock' | 'staff' | 'settings' | 'data' | 'customer';
export type AuditSensitivity = 'critical' | 'high' | 'normal' | 'low';
export type AuditRetention = 'r10y' | 'r2y';

export interface CatalogueEntry {
  readonly action: string;
  readonly category: AuditCategory;
  readonly sensitivity: AuditSensitivity;
  /** Derived from category + sensitivity (R7), never written by hand. */
  readonly retention: AuditRetention;
  /** `store`: store_id is required. `org`: store_id must be null (R14). */
  /** 'either' (T-412): the record may or may not have a store (an organisation-level approval carries none). */
  readonly scope: 'store' | 'org' | 'either';
  readonly actor: 'person' | 'system' | 'either';
  /** Who may read it (R8): `store` = view_activity_log, `admin` = view_activity_log_restricted. */
  readonly viewers: 'store' | 'admin';
  readonly entity: string;
  /** The task that owns (writes) this entry. */
  readonly owner: string;
  readonly reserved: boolean;
  /** Sources allowed to send it through the R10 envelope. `[]` for every server-only entry. */
  readonly clientSources: readonly ('pos' | 'customer')[];
}

const SEVERITY: Readonly<Record<AuditSensitivity, 2 | 4 | 5 | 6>> = { critical: 2, high: 4, normal: 5, low: 6 };

/** R4: critical 2, high 4, normal 5, low 6 (RFC 5424). */
export function severityFor(sensitivity: AuditSensitivity): 2 | 4 | 5 | 6 {
  return SEVERITY[sensitivity];
}

/** R7: money, order, menu_price and customer are always 10 years; otherwise only `low` is the 2-year class. */
export function retentionFor(category: AuditCategory, sensitivity: AuditSensitivity): AuditRetention {
  if (category === 'money' || category === 'order' || category === 'menu_price' || category === 'customer') return 'r10y';
  return sensitivity === 'low' ? 'r2y' : 'r10y';
}

interface Opts {
  actor?: CatalogueEntry['actor'];
  viewers?: CatalogueEntry['viewers'];
  reserved?: boolean;
  clientSources?: CatalogueEntry['clientSources'];
}

function def(
  action: string,
  category: AuditCategory,
  sensitivity: AuditSensitivity,
  scope: 'store' | 'org' | 'either',
  entity: string,
  owner: string,
  o: Opts = {},
): CatalogueEntry {
  return {
    action,
    category,
    sensitivity,
    retention: retentionFor(category, sensitivity),
    scope,
    actor: o.actor ?? 'person',
    viewers: o.viewers ?? 'store',
    entity,
    owner,
    reserved: o.reserved ?? false,
    clientSources: o.clientSources ?? [],
  };
}

const RES: Opts = { reserved: true };
const ADMIN: Opts = { viewers: 'admin' };
const ADMIN_RES: Opts = { reserved: true, viewers: 'admin' };
const POS: Opts = { reserved: true, clientSources: ['pos'] };
const LOYALTY: Opts = { reserved: true, clientSources: ['customer'] };

export const AUDIT_CATALOGUE: readonly CatalogueEntry[] = Object.freeze([
  // ---- LIVE: the 48 actions written today (labels identical to migration 0197's copy list) ----
  def('reopen_pin_sign_in', 'security', 'high', 'store', 'store', 'T-395'),
  // T-412: an administrator's PIN approved a destructive action. Store-scoped when the record has a store, org-level when it has none.
  def('destructive.approved', 'security', 'high', 'either', 'persons', 'T-412', { actor: 'either' }),
  def('set_supplier_credit_terms', 'money', 'normal', 'org', 'suppliers', 'T-362'),
  def('set_supplier_status', 'money', 'normal', 'org', 'suppliers', 'T-391'),
  def('set_supplier_bank_account', 'money', 'high', 'org', 'suppliers', 'T-365'),
  def('set_supplier_counterparty_store', 'money', 'normal', 'org', 'suppliers', 'T-391'),
  def('set_channel_payout', 'money', 'high', 'store', 'sales_channels', 'T-350'),
  def('set_customer_status', 'customer', 'normal', 'org', 'customers', 'T-391'),
  def('change_item_base_unit', 'stock', 'normal', 'org', 'items', 'T-391'),
  def('set_item_purchase_unit', 'stock', 'normal', 'org', 'items', 'T-391'),
  def('rename_item', 'stock', 'normal', 'org', 'items', 'T-391'),
  // T-453 (DEF-728): the three T-443 catalogue writes that were unaudited.
  def('item.variant_set', 'stock', 'normal', 'org', 'items', 'T-453'),
  def('item_duplicate.dismissed', 'stock', 'normal', 'org', 'item_duplicate_dismissals', 'T-453'),
  def('item_duplicate.dismissal_undone', 'stock', 'normal', 'org', 'item_duplicate_dismissals', 'T-453'),
  def('retire_item', 'stock', 'normal', 'org', 'items', 'T-383'),
  def('restore_item', 'stock', 'normal', 'org', 'items', 'T-383'),
  // One-time T-386 S5 recode script (removed): old rows carry it (0197's list); reserved so nothing new writes it.
  def('recode_item', 'stock', 'normal', 'org', 'items', 'T-386', { reserved: true }),
  // T-464: retired writer - every staff code is allocated now, none is typed - so it is reserved (no caller); rows already logged keep their labels.
  def('set_staff_code', 'security', 'high', 'store', 'employments', 'T-391', { viewers: 'admin', reserved: true }),
  def('link_store_to_pos', 'settings', 'normal', 'store', 'pos_v1_store_links', 'T-375'),
  def('unlink_store_from_pos', 'settings', 'normal', 'store', 'pos_v1_store_links', 'T-382'),
  // T-424 S5: registering a POS v2 tablet as an ERP terminal person (dotted: new, never in 0197's copy list).
  def('pos_terminal_link.provision', 'settings', 'high', 'store', 'pos_terminal_links', 'T-424'),
  def('pos_terminal_link.revoke', 'settings', 'high', 'store', 'pos_terminal_links', 'T-424'),
  // T-464: pairing a store's POS tablet and un-pairing it (dotted: new).
  def('pos_tablet.paired', 'security', 'high', 'store', 'pos_tablet_pairings', 'T-464'),
  def('pos_tablet.unpaired', 'security', 'high', 'store', 'pos_tablet_pairings', 'T-464'),
  // T-455 S2: a cashier's moves on the customer lobby line (park a walk-in, call, seat, remove). Payloads carry code, size, stand and session id - never a name or phone.
  def('lobby.park', 'order', 'normal', 'store', 'lobby_entry', 'T-455'),
  def('lobby.call', 'order', 'low', 'store', 'lobby_entry', 'T-455'),
  def('lobby.seat', 'order', 'normal', 'store', 'lobby_entry', 'T-455'),
  def('lobby.remove', 'order', 'normal', 'store', 'lobby_entry', 'T-455'),
  // T-190: a change to the statutory tables (rate row, withholding table, minimum wage): add, confirm or discard. ONE entry (the catalogue
  // size is capped); `after.table` / `after.event` say which. Dotted: new. Org-scoped, admin-readable; rows are immutable once confirmed.
  // T-190: a person's government numbers were set or cleared. Records FIELD NAMES only, never a number.
  def('staff_gov_ids.changed', 'security', 'high', 'store', 'persons', 'T-190', { viewers: 'admin' }),
  def('payroll_rate.change', 'money', 'high', 'org', 'statutory_rates', 'T-190', ADMIN),
  // T-193 S3: recording (and, S4, voiding) a payment to SSS / PhilHealth / Pag-IBIG / BIR. Org-scoped, admin-readable; payloads carry agency, month, receipt no. and amounts, never a government number.
  def('statutory_payment.record', 'money', 'high', 'org', 'statutory_payments', 'T-193', ADMIN),
  def('statutory_payment.void', 'money', 'high', 'org', 'statutory_payments', 'T-193', ADMIN),
  // T-193 S6: one row per month-detail CSV download (personal data leaves the system). Payload: agency, month, row count - never a government number.
  def('statutory_payment.export', 'security', 'normal', 'org', 'statutory_payments', 'T-193', ADMIN),
  // T-193 S6: an employer number or due day was set or changed on /payroll/rates. Org-scoped, admin-readable; before/after carry the old and new number and due day.
  def('statutory_employer.change', 'money', 'high', 'org', 'statutory_employers', 'T-193', ADMIN),
  def('create_tender', 'money', 'normal', 'store', 'tenders', 'T-375'),
  def('update_tender', 'money', 'normal', 'store', 'tenders', 'T-375'),
  def('reactivate_tender', 'money', 'normal', 'store', 'tenders', 'T-375'),
  def('retire_tender', 'money', 'normal', 'store', 'tenders', 'T-375'),
  def('edit_sales_day', 'money', 'high', 'store', 'sales_days', 'T-375'),
  def('reimport_sales_day', 'money', 'high', 'store', 'sales_days', 'T-375'),
  // T-396: the 06:00 Manila timer (or `--manual`) drafted a sales day from POS; the actor is the person who vouched for the store's link. Dotted: the catalogue only, never 0197's list.
  def('sales_day.auto_imported', 'money', 'normal', 'store', 'sales_days', 'T-396'),
  def('set_platform_sales', 'money', 'normal', 'store', 'sales_days', 'T-375'),
  def('dual_run.compare', 'money', 'normal', 'org', 'dual_run', 'T-392', { viewers: 'admin' }),
  def('dual_run.disposition', 'money', 'normal', 'store', 'dual_run_dispositions', 'T-392', { viewers: 'admin' }),
  // Legacy undotted action: old rows carry it (0197's list); reserved so nothing new writes it.
  def('master_data_load', 'data', 'high', 'org', 'organizations', 'T-391', { viewers: 'admin', reserved: true }),
  def('master_data.items_load', 'data', 'high', 'org', 'items', 'T-391', { viewers: 'admin' }),
  def('master_data.suppliers_load', 'data', 'high', 'org', 'suppliers', 'T-391', { viewers: 'admin' }),
  def('master_data.customers_load', 'data', 'high', 'org', 'customers', 'T-391', { viewers: 'admin' }),
  def('master_data.positions_load', 'data', 'high', 'org', 'positions', 'T-391', { viewers: 'admin' }),
  def('master_data.staff_load', 'data', 'high', 'org', 'staff', 'T-391', { viewers: 'admin' }),
  def('menu_category_create', 'menu_price', 'normal', 'org', 'menu_categories', 'T-401'),
  def('menu_category_edit', 'menu_price', 'normal', 'org', 'menu_categories', 'T-401'),
  def('menu_item_create', 'menu_price', 'normal', 'org', 'menu_items', 'T-401'),
  def('menu_item_edit', 'menu_price', 'normal', 'org', 'menu_items', 'T-401'),
  def('menu_variant_create', 'menu_price', 'normal', 'org', 'menu_item_variants', 'T-401'),
  def('menu_variant_edit', 'menu_price', 'normal', 'org', 'menu_item_variants', 'T-401'),
  def('menu_offer_set', 'menu_price', 'high', 'store', 'menu_offers', 'T-401'),
  def('menu_offer_cancel', 'menu_price', 'high', 'store', 'menu_offers', 'T-401'),
  def('menu_offer_withdraw', 'menu_price', 'high', 'store', 'menu_offers', 'T-401'),
  def('menu_option_offer_cancel', 'menu_price', 'high', 'store', 'menu_option_offers', 'T-401'),
  def('production.recipe_create', 'stock', 'normal', 'org', 'production_recipes', 'T-413'),
  def('production.recipe_edit', 'stock', 'normal', 'org', 'production_recipes', 'T-413'),
  def('production.recipe_retire', 'stock', 'normal', 'org', 'production_recipes', 'T-413'),
  def('production.recipe_restore', 'stock', 'normal', 'org', 'production_recipes', 'T-413'),
  def('menu_depletion_rule_set', 'stock', 'high', 'org', 'menu_depletion_rules', 'T-401'),
  def('menu_depletion_rule_cancel', 'stock', 'high', 'org', 'menu_depletion_rules', 'T-401'),
  def('menu_item_request', 'menu_price', 'normal', 'store', 'menu_item_requests', 'T-401'),
  def('menu_item_request_approve', 'menu_price', 'normal', 'store', 'menu_item_requests', 'T-401'),
  def('menu_item_request_duplicate', 'menu_price', 'normal', 'store', 'menu_item_requests', 'T-401'),
  def('menu_item_request_reject', 'menu_price', 'normal', 'store', 'menu_item_requests', 'T-401'),
  def('menu_item_request_withdraw', 'menu_price', 'normal', 'store', 'menu_item_requests', 'T-401'),
  def('menu_option_group_create', 'menu_price', 'normal', 'org', 'menu_option_groups', 'T-401'),
  def('menu_option_group_edit', 'menu_price', 'normal', 'org', 'menu_option_groups', 'T-401'),
  def('menu_option_group_link', 'menu_price', 'normal', 'org', 'menu_option_group_links', 'T-401'),
  def('menu_option_group_unlink', 'menu_price', 'normal', 'org', 'menu_option_group_links', 'T-401'),
  def('menu_option_value_create', 'menu_price', 'normal', 'org', 'menu_option_values', 'T-401'),
  def('menu_option_value_edit', 'menu_price', 'normal', 'org', 'menu_option_values', 'T-401'),
  def('menu_package_refills_set', 'menu_price', 'normal', 'org', 'menu_package_refills', 'T-401'),
  // S5 (Q3): the v1 usage seam. A link, an unlink, and a store's switch of usage source. Dotted: new, never in 0197's copy list.
  def('menu.pos_v1_link', 'stock', 'normal', 'store', 'menu_pos_v1_links', 'T-401'),
  def('menu.pos_v1_unlink', 'stock', 'normal', 'store', 'menu_pos_v1_links', 'T-401'),
  def('menu.usage_source_switch', 'stock', 'high', 'store', 'menu_usage_source_switches', 'T-401'),
  // S6: the usage tolerance band. The org setting and an item's override are admin-set; an out-of-band post a manager verified with a reason.
  def('menu.usage_tolerance_set', 'stock', 'normal', 'org', 'organizations', 'T-401'),
  def('menu.item_usage_tolerance_set', 'stock', 'normal', 'org', 'items', 'T-401'),
  def('stock.usage_tolerance_verified', 'stock', 'high', 'store', 'stock_usage_records', 'T-401'),
  // The system posted a pull-made usage draft itself (14:00 Manila the day after its business date); written by the usage auto-post job, never by a person.
  // The org's usage system person (the author of every POS-pull usage draft) was created, once, on first use (audit ruling A9).
  def('stock.usage_system_author_created', 'stock', 'normal', 'org', 'persons', 'T-401', { actor: 'system' }),
  def('stock.usage_auto_posted', 'stock', 'normal', 'store', 'stock_usage_records', 'T-401', { actor: 'system' }),
  // T-430: a recurring template was created (carries starts_on), resumed, or had its interval/anchor changed (the last two record dropped_due_dates).
  def('recurring.template_created', 'money', 'normal', 'store', 'recurring_expenses', 'T-430'),
  def('recurring.template_resumed', 'money', 'normal', 'store', 'recurring_expenses', 'T-430'),
  def('recurring.template_rescheduled', 'money', 'normal', 'store', 'recurring_expenses', 'T-430'),
  // Written by T-401's setOptionOffer (price / withdraw) but absent from 0197's copy list (a ternary the S1a scan missed). Dotted on purpose: never in 0197's list, so no row can carry the underscore form.
  def('menu.option_offer_set', 'menu_price', 'high', 'store', 'menu_option_offers', 'T-401'),
  def('menu.option_offer_withdraw', 'menu_price', 'high', 'store', 'menu_option_offers', 'T-401'),

  // ---- S2 (security events): live (T-402 S2 flipped them); the S3/S5 ones stay reserved ----
  def('auth.signin_succeeded', 'security', 'low', 'org', 'persons', 'T-402'),
  // Written reasons: `terminal_credential`, `not_a_firebase_credential`, `employment_ended`, `credential_revoked` (T-407: a KNOWN account that may not sign in). A bad token or an unknown identifier has no trustworthy org: one logger line, no row.
  def('auth.signin_refused', 'security', 'normal', 'org', 'persons', 'T-402', { actor: 'either' }),
  def('auth.pin_signin_succeeded', 'security', 'low', 'store', 'persons', 'T-402'),
  def('auth.pin_paused', 'security', 'high', 'store', 'stores', 'T-402', { actor: 'either' }),
  // T-416: the attempt that tripped a person's administrator-PIN cap (system-written; the person is the entity).
  def('auth.approval_pin_capped', 'security', 'high', 'org', 'persons', 'T-416', { actor: 'system' }),
  // T-416: an administrator cleared a person's cap.
  def('auth.approval_pin_cap_reset', 'security', 'high', 'org', 'persons', 'T-416'),
  // T-433: a charge let through over the customer's credit limit, with who and why.
  def('credit_limit.overridden', 'money', 'high', 'store', 'ar_charges', 'T-433'),
  // T-433: the pre-printed BIR booklet number set, changed or cleared on a trade order.
  def('trade_order.bir_invoice_set', 'money', 'normal', 'store', 'trade_orders', 'T-433'),
  def('auth.pin_stopped_for_day', 'security', 'critical', 'store', 'stores', 'T-402', { actor: 'either' }),
  def('session.ended', 'security', 'low', 'org', 'sessions', 'T-402'),
  def('session.ended_all', 'security', 'high', 'org', 'sessions', 'T-402', { actor: 'either' }),
  def('credential.linked', 'security', 'high', 'org', 'persons', 'T-402', ADMIN),
  def('credential.unlinked', 'security', 'high', 'org', 'persons', 'T-402', ADMIN),
  def('credential.pin_set', 'security', 'high', 'org', 'persons', 'T-402', ADMIN),
  def('role.assigned', 'security', 'high', 'org', 'persons', 'T-402', ADMIN),
  def('capability.granted', 'security', 'high', 'org', 'persons', 'T-402', ADMIN),
  def('manager.elevated', 'security', 'critical', 'org', 'persons', 'T-402', { ...ADMIN, actor: 'either' }),
  def('security.authorize_denied', 'security', 'normal', 'org', 'persons', 'T-402', ADMIN),
  def('security.authorize_denied_summary', 'security', 'normal', 'org', 'persons', 'T-402', { ...ADMIN_RES, actor: 'system' }),
  def('security.event_replay_conflict', 'security', 'high', 'org', 'audit_log_event_keys', 'T-402', { actor: 'either' }),
  def('security.event_store_mismatch', 'security', 'high', 'store', 'stores', 'T-402', { actor: 'either' }),
  def('employment.created', 'staff', 'normal', 'store', 'employments', 'T-402'),
  def('employment.ended', 'staff', 'normal', 'store', 'employments', 'T-402'),
  // T-434: a staff photo is changed on an EMPLOYMENT (the store's ID card). Photo VIEWS are deliberately not logged (every card load would flood it).
  def('staff_photo.set', 'staff', 'normal', 'store', 'employments', 'T-434'),
  def('staff_photo.replaced', 'staff', 'normal', 'store', 'employments', 'T-434'),
  def('staff_photo.removed', 'staff', 'normal', 'store', 'employments', 'T-434'),
  // T-434 / bible row 353: a signature belongs to the PERSON (entity_id = person id). Payloads carry NO file id, path or URL.
  // `viewed` / `view_refused` are every attempt to open it (DEF-668, signatures only); admin-read because who looked at a signature is itself sensitive.
  def('staff_signature.set', 'security', 'high', 'either', 'persons', 'T-434', { viewers: 'admin' }),
  def('staff_signature.replaced', 'security', 'high', 'either', 'persons', 'T-434', { viewers: 'admin' }),
  def('staff_signature.removed', 'security', 'high', 'either', 'persons', 'T-434', { viewers: 'admin' }),
  def('staff_signature.viewed', 'security', 'high', 'either', 'persons', 'T-434', { viewers: 'admin' }),
  def('staff_signature.view_refused', 'security', 'high', 'either', 'persons', 'T-434', { viewers: 'admin' }),
  // T-438 (bible row 360): a person renamed on the staff page (before/after displayName ONLY), and a hire that overrode the same-name guard.
  def('person.renamed', 'staff', 'normal', 'store', 'persons', 'T-438'),
  def('person.same_name_confirmed', 'staff', 'normal', 'store', 'persons', 'T-438'),
  def('employment.positions_set', 'staff', 'normal', 'store', 'employments', 'T-402'),
  def('position.reactivated', 'staff', 'normal', 'store', 'positions', 'T-402'),

  // ---- T-436: leave and absence tracking. Payloads carry person, dates and kind - NEVER the note (bible row 353) or a file id. ----
  def('leave.requested', 'staff', 'normal', 'store', 'leave_requests', 'T-436'),
  def('leave.approved', 'staff', 'normal', 'store', 'leave_requests', 'T-436'),
  // A super_admin approved their own leave: the one allowed exception to "nobody approves their own".
  def('leave.self_approved', 'staff', 'high', 'store', 'leave_requests', 'T-436'),
  def('leave.rejected', 'staff', 'normal', 'store', 'leave_requests', 'T-436'),
  def('leave.cancelled', 'staff', 'normal', 'store', 'leave_requests', 'T-436'),
  def('leave.recorded', 'staff', 'normal', 'store', 'leave_requests', 'T-436'),
  def('leave.voided', 'staff', 'normal', 'store', 'leave_requests', 'T-436'),
  // Approved or recorded with a pay mode other than the kind's default (a sixth SIL day as unpaid, a sick day as paid).
  def('leave.paid_override', 'staff', 'normal', 'store', 'leave_requests', 'T-436'),
  // Punches arrived on an approved, not-yet-paid leave date: the day is worked, not leave (written by the attendance recompute).
  def('leave.superseded_by_work', 'staff', 'normal', 'store', 'leave_requests', 'T-436', { actor: 'system' }),
  // A cap row set or changed. Org-wide defaults carry no store.
  def('leave_cap.changed', 'settings', 'normal', 'either', 'leave_caps', 'T-436'),
  def('leave_type.changed', 'settings', 'normal', 'org', 'leave_types', 'T-436'),
  // The year-end / final-pay cash payout of unused Service Incentive Leave was taken by a pay run or a separation.
  def('sil.commuted', 'money', 'normal', 'store', 'leave_commutations', 'T-436'),
  // A medical certificate was opened, or somebody tried and was refused. Admin-viewed: who looks at a certificate is itself sensitive.
  def('leave_document.viewed', 'security', 'normal', 'store', 'leave_requests', 'T-436', ADMIN),
  def('leave_document.view_refused', 'security', 'high', 'store', 'leave_requests', 'T-436', ADMIN),

  // ---- S3 (money / data steps before posting): the 15 S3_LIVE entries are live; expense.submitted/rejected, sales_day.reopened, remittance.confirmed and data.* stay reserved (no verb, C4/C5) ----
  def('expense.drafted', 'money', 'normal', 'store', 'expenses', 'T-402'),
  def('expense.submitted', 'money', 'normal', 'store', 'expenses', 'T-402', RES),
  def('expense.approved', 'money', 'normal', 'store', 'expenses', 'T-402'),
  def('expense.rejected', 'money', 'normal', 'store', 'expenses', 'T-402', RES),
  def('expense.voided', 'money', 'normal', 'store', 'expenses', 'T-402'),
  def('sales_day.submitted', 'money', 'normal', 'store', 'sales_days', 'T-402'),
  def('sales_day.verified', 'money', 'normal', 'store', 'sales_days', 'T-402'),
  def('sales_day.reopened', 'money', 'normal', 'store', 'sales_days', 'T-402', RES),
  def('remittance.recorded', 'money', 'normal', 'store', 'remittances', 'T-402'),
  def('remittance.confirmed', 'money', 'normal', 'store', 'remittances', 'T-402', RES),
  def('cash_request.approved', 'money', 'normal', 'store', 'cash_requests', 'T-402'),
  def('cash_request.rejected', 'money', 'normal', 'store', 'cash_requests', 'T-402'),
  // T-414 R-AUTO: releasing a cash request at a store with no staff cash account creates one (actor = the releaser).
  def('money_account.created', 'money', 'normal', 'store', 'money_accounts', 'T-414'),
  def('ap_invoice.approved', 'money', 'normal', 'store', 'ap_invoices', 'T-402'),
  // T-475 S3: an admin verified the supplier invoice they logged themselves (written beside ap_invoice.approved).
  def('ap_invoice.self_verified', 'money', 'high', 'store', 'ap_invoices', 'T-475'),
  def('ap_payment.recorded', 'money', 'normal', 'store', 'ap_payments', 'T-402'),
  def('data.export_downloaded', 'data', 'high', 'org', 'exports', 'T-402', ADMIN_RES),
  def('data.bulk_import_applied', 'data', 'high', 'org', 'imports', 'T-402', RES),
  def('data.activity_log_exported', 'data', 'high', 'org', 'audit_log', 'T-402', ADMIN_RES),
  def('cutover.purge', 'data', 'critical', 'org', 'organizations', 'T-402', { ...ADMIN, actor: 'either' }),
  def('cutover.opening_entry', 'data', 'critical', 'org', 'organizations', 'T-402', { ...ADMIN, actor: 'either' }),
  def('cutover.step_completed', 'data', 'high', 'org', 'organizations', 'T-402', { ...ADMIN, actor: 'either' }),

  // ---- POS v2 (R3, v1 POS's 44 actions merged and graded; exceptions and control points only) ----
  def('pos.drawer_opened_no_sale', 'money', 'high', 'store', 'cash_drawers', 'T-402', POS),
  def('pos.drawer_counted', 'money', 'normal', 'store', 'cash_drawers', 'T-402', POS),
  def('pos.shift_closed', 'money', 'normal', 'store', 'pos_shifts', 'T-402', POS),
  def('pos.tender_changed_after_payment', 'money', 'high', 'store', 'pos_orders', 'T-402', POS),
  def('pos.session_voided', 'order', 'high', 'store', 'pos_orders', 'T-402', POS),
  def('pos.tickets_voided', 'order', 'normal', 'store', 'pos_orders', 'T-402', POS),
  def('pos.item_unvoided', 'order', 'high', 'store', 'pos_orders', 'T-402', POS),
  def('pos.discount_applied', 'order', 'normal', 'store', 'pos_orders', 'T-402', POS),
  def('pos.discount_edited', 'order', 'normal', 'store', 'pos_orders', 'T-402', POS),
  def('pos.discount_removed', 'order', 'normal', 'store', 'pos_orders', 'T-402', POS),
  def('pos.bill_discount_applied', 'order', 'normal', 'store', 'pos_orders', 'T-402', POS),
  def('pos.bill_discount_removed', 'order', 'normal', 'store', 'pos_orders', 'T-402', POS),
  def('pos.statutory_discount_applied', 'order', 'normal', 'store', 'pos_orders', 'T-402', POS),
  def('pos.statutory_discount_voided', 'order', 'high', 'store', 'pos_orders', 'T-402', POS),
  def('pos.item_marked_free', 'order', 'high', 'store', 'pos_orders', 'T-402', POS),
  def('pos.custom_charge_added', 'order', 'normal', 'store', 'pos_orders', 'T-402', POS),
  def('pos.custom_charge_removed', 'order', 'normal', 'store', 'pos_orders', 'T-402', POS),
  def('pos.price_overridden', 'order', 'high', 'store', 'pos_orders', 'T-402', POS),
  def('pos.package_qty_overridden', 'order', 'high', 'store', 'pos_orders', 'T-402', POS),
  def('pos.receipt_edited', 'order', 'high', 'store', 'pos_orders', 'T-402', POS),
  def('pos.receipt_voided', 'order', 'high', 'store', 'pos_orders', 'T-402', POS),
  def('pos.receipt_refunded', 'order', 'high', 'store', 'pos_orders', 'T-402', POS),
  def('pos.receipt_deleted', 'order', 'critical', 'store', 'pos_orders', 'T-402', POS),
  def('pos.guest_count_approved', 'order', 'normal', 'store', 'pos_orders', 'T-402', POS),
  def('pos.package_change_approved', 'order', 'normal', 'store', 'pos_orders', 'T-402', POS),
  def('pos.payment_completed', 'order', 'low', 'store', 'pos_orders', 'T-402', POS),
  def('pos.manager_override', 'order', 'high', 'store', 'pos_orders', 'T-402', POS),

  // ---- customer app v2 (R13: the diner password reset is in person, by a manager only; no self-service event) ----
  def('customer.password_reset_by_manager', 'security', 'high', 'store', 'diner_accounts', 'T-402', RES),
  def('customer.password_reset_refused', 'security', 'high', 'store', 'diner_accounts', 'T-402', RES),
  def('customer.signin_failed', 'security', 'normal', 'store', 'diner_accounts', 'T-402', { ...RES, actor: 'either' }),
  def('customer.account_created', 'security', 'normal', 'store', 'diner_accounts', 'T-402', { ...RES, actor: 'either' }),
  def('customer.account_locked', 'security', 'high', 'store', 'diner_accounts', 'T-402', { ...RES, actor: 'either' }),
  def('loyalty.points_earned', 'customer', 'normal', 'store', 'loyalty_points', 'T-402', LOYALTY),
  def('loyalty.points_redeemed', 'customer', 'normal', 'store', 'loyalty_points', 'T-402', LOYALTY),
  def('loyalty.points_transferred', 'customer', 'high', 'store', 'loyalty_points', 'T-402', LOYALTY),
  def('loyalty.points_adjusted', 'customer', 'high', 'store', 'loyalty_points', 'T-402', LOYALTY),
  def('loyalty.points_expired', 'customer', 'normal', 'store', 'loyalty_points', 'T-402', { reserved: true, actor: 'system' }),
  def('loyalty.session_linked', 'customer', 'low', 'store', 'loyalty_points', 'T-402', LOYALTY),
]);

const BY_ACTION: ReadonlyMap<string, CatalogueEntry> = new Map(AUDIT_CATALOGUE.map((e) => [e.action, e]));

export function catalogueEntry(action: string): CatalogueEntry | undefined {
  return BY_ACTION.get(action);
}

/**
 * The build guard (Invariant 9). `written` = every action string a writer in the source tree passes. Returns the
 * problems found; `[]` is clean: no duplicate action, every written action catalogued and not reserved, every
 * non-reserved entry written somewhere, no reserved entry written.
 */
export function catalogueProblems(entries: readonly CatalogueEntry[], written: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.action)) problems.push(`duplicate catalogue entry: ${e.action}`);
    seen.add(e.action);
  }
  const byAction = new Map(entries.map((e) => [e.action, e]));
  for (const a of written) {
    const e = byAction.get(a);
    if (!e) problems.push(`written action is not in the catalogue: ${a}`);
    else if (e.reserved) problems.push(`reserved entry has a caller: ${a}`);
  }
  for (const e of entries) {
    if (!e.reserved && !written.has(e.action)) problems.push(`non-reserved entry has no caller: ${e.action}`);
  }
  return problems;
}

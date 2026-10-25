/**
 * Trigger firing-mode registry — T-354 / DEF-487, bible §13 row 241,
 * `docs/tasks/354-def-487-immutability-triggers-always.md`.
 *
 * Same mechanism as `rls/registry.ts` and `cutover/classification.ts`: one file is the source of
 * truth for every non-internal trigger in `public`, and a live guard (the T-legs in
 * `packages/db/tests/integration/t354-immutability-triggers-always.test.ts`) fails the build when a
 * trigger exists that is not classified here, or when its live `tgenabled` disagrees with its
 * class. The next trigger a lane adds must be classified the day it lands.
 *
 * **The classification test (R1), verbatim:** does the trigger's only job refuse a REWRITE or
 * ERASE of a row that is already history (posted, frozen, committed, resolved, voided, or
 * append-only)? And does it decide only from that row's OLD/NEW (plus, for `journal_lines`, its
 * parent entry's status) — never a GUC, never another row's CURRENT (mutable) state? If both are
 * yes, it is a `history_guard` and its mode is `'always'` (`ALTER TABLE ... ENABLE ALWAYS TRIGGER
 * ...`, migration 0168) — it must keep firing under `session_replication_role = 'replica'`, the
 * mode logical-replication apply workers use and the usual hand-rolled-bulk-load trick ("turn off
 * triggers"). Every other trigger stays `origin` (`'O'`, plain — Postgres's default), split into:
 *   - `derivation` — computes a value FROM the row itself or enqueues a side effect (a Firestore
 *     mirror write, a foundation-account seed, an opening-date propagation). A replay or restore
 *     must NOT re-run these: the restored row already carries the derived value, and recomputing it
 *     later could differ, or a side effect could fire a second time.
 *   - `validator` — checks new data against ANOTHER row's CURRENT (mutable) state or the clock (a
 *     period's open/closed status, an account's archived flag, a balance, a single-active-session
 *     invariant). Reloading a genuine historic row after its period closed, or after an account was
 *     archived, would fail these — so they must stay silent on replay, and stay origin.
 *
 * `mode === 'always'` if and only if `kind === 'history_guard'` — enforced by the T1 leg, not
 * merely documented here.
 */

export type TriggerMode = 'always' | 'origin';

export interface TriggerEntry {
  readonly table: string;
  readonly mode: TriggerMode;
  readonly kind: 'history_guard' | 'derivation' | 'validator';
  readonly reason: string;
}

export const TRIGGER_REGISTRY: Readonly<Record<string, TriggerEntry>> = {
  // ---------------------------------------------------------------------------------------------
  // ALWAYS (19) — history guards. R1's own table, in R1's own order, plus later additions.
  // ---------------------------------------------------------------------------------------------
  journal_entries_posted_immutable: {
    table: 'journal_entries',
    mode: 'always',
    kind: 'history_guard',
    reason: 'A posted entry cannot be rewritten or erased (0003). Decides only from OLD.status.',
  },
  journal_lines_posted_immutable: {
    table: 'journal_lines',
    mode: 'always',
    kind: 'history_guard',
    reason:
      'A line on a posted entry cannot be inserted, updated or deleted (0003, INSERT leg added ' +
      '0004/DEF-031). Decides only from its parent entry\'s status.',
  },
  stock_movements_append_only_trg: {
    table: 'stock_movements',
    mode: 'always',
    kind: 'history_guard',
    reason: 'The stock ledger is append-only (0063). Decides only from TG_OP.',
  },
  stock_usage_posted_immutable_trg: {
    table: 'stock_usage_records',
    mode: 'always',
    kind: 'history_guard',
    reason: 'A posted usage record cannot be rewritten (0067). Decides only from OLD.status.',
  },
  stock_usage_void_terminal_trg: {
    table: 'stock_usage_records',
    mode: 'always',
    kind: 'history_guard',
    reason: 'A voided usage record is terminal (0067). Decides only from OLD.status.',
  },
  count_sessions_commit_once_trg: {
    table: 'count_sessions',
    mode: 'always',
    kind: 'history_guard',
    reason: 'A committed count session cannot be recommitted or rewritten (0068). Decides only from OLD.status.',
  },
  trade_discrepancies_defer_once_trg: {
    table: 'trade_discrepancies',
    mode: 'always',
    kind: 'history_guard',
    reason: 'A discrepancy can be deferred only once (0071). Decides only from OLD/NEW on the same row.',
  },
  trade_discrepancies_resolution_terminal_trg: {
    table: 'trade_discrepancies',
    mode: 'always',
    kind: 'history_guard',
    reason: 'A resolved discrepancy is terminal (0071). Decides only from OLD.status.',
  },
  trade_discrepancies_direction_fixed_trg: {
    table: 'trade_discrepancies',
    mode: 'always',
    kind: 'history_guard',
    reason: "A discrepancy's direction (short/over) is fixed once the receipt raises it (0179, T-372 S6b). Decides only from OLD/NEW on the same row.",
  },
  trade_order_messages_append_only_trg: {
    table: 'trade_order_messages',
    mode: 'always',
    kind: 'history_guard',
    reason: 'The order message thread is append-only (0072). Decides only from TG_OP.',
  },
  store_attendance_config_immutable: {
    table: 'store_attendance_config',
    mode: 'always',
    kind: 'history_guard',
    reason:
      'A superseded config row cannot be rewritten — a new row supersedes it instead (0081). ' +
      'Decides only from OLD.superseded_at.',
  },
  attendance_punches_append_only: {
    table: 'attendance_punches',
    mode: 'always',
    kind: 'history_guard',
    reason: 'A punch is append-only; a correction is a new punch (0082). Decides only from TG_OP.',
  },
  attendance_days_frozen_immutable: {
    table: 'attendance_days',
    mode: 'always',
    kind: 'history_guard',
    reason:
      'A frozen attendance day cannot be rewritten (0083). Decides only from OLD.frozen_at — the ' +
      'payroll unfreeze path (0106) clears that same column at the origin, so a legitimate replay ' +
      'sees the unfrozen row already and passes.',
  },
  attendance_adjustments_append_only: {
    table: 'attendance_adjustments',
    mode: 'always',
    kind: 'history_guard',
    reason: 'An adjustment is append-only (0084). Decides only from TG_OP.',
  },
  etl_source_documents_immutable: {
    table: 'etl_source_documents',
    mode: 'always',
    kind: 'history_guard',
    reason: 'A captured source document cannot be rewritten or erased (0009). Decides only from TG_OP.',
  },
  fiscal_periods_fill_immutable_trg: {
    table: 'fiscal_periods',
    mode: 'always',
    kind: 'history_guard',
    reason:
      'A closed period\'s fill-audit columns cannot be rewritten (0160). Decides only from OLD/NEW ' +
      'on the same row.',
  },
  // T-375 S1 (0183): immutability triggers, ENABLE ALWAYS so replica mode cannot switch them off.
  pos_v1_day_feeds_append_only: {
    table: 'pos_v1_day_feeds',
    mode: 'always',
    kind: 'history_guard',
    reason: 'A stored POS response is never updated or deleted (0183). Decides only from TG_OP.',
  },
  sales_day_pos_corrections_append_only: {
    table: 'sales_day_pos_corrections',
    mode: 'always',
    kind: 'history_guard',
    reason: 'A POS correction row is never updated or deleted (0183). Decides only from TG_OP.',
  },
  missed_month_adjustments_no_update_trg: {
    table: 'missed_month_adjustments',
    mode: 'always',
    kind: 'history_guard',
    reason: 'A booked catch-up adjustment cannot be updated (0161). Decides only from TG_OP.',
  },
  missed_month_adjustments_no_direct_delete_trg: {
    table: 'missed_month_adjustments',
    mode: 'always',
    kind: 'history_guard',
    reason:
      'A catch-up adjustment cannot be deleted directly — only the FK cascade from its journal ' +
      'entry may remove it (0161). Decides only from `pg_trigger_depth() > 1`, which is unaffected ' +
      'by firing mode: the cascade fires inside the same trigger-nesting the check reads.',
  },
  audit_log_append_only: {
    table: 'audit_log',
    mode: 'always',
    kind: 'history_guard',
    reason: 'The audit log is append-only (0167). Decides only from TG_OP. The auditor\'s own repro (DEF-487). ' +
      'T-402 (0197): the table is partitioned; the trigger is on the parent AND on every partition, ENABLE ALWAYS on each (R6).',
  },
  trade_orders_ready_is_final_trg: {
    table: 'trade_orders',
    mode: 'always',
    kind: 'history_guard',
    reason: 'A ready order\'s ready_at/ready_by are write-once (0175, DEF-511). Decides only from OLD/NEW on the same row.',
  },

  // ---------------------------------------------------------------------------------------------
  // origin (41) — deliberately NOT always. R2.
  // ---------------------------------------------------------------------------------------------

  // Derivation (11) — a replay or restore must not re-run these.
  employments_mirror_enqueue: {
    table: 'employments',
    mode: 'origin',
    kind: 'derivation',
    reason: 'Enqueues a Firestore mirror write (0088). A replica must not re-enqueue it.',
  },
  employment_positions_mirror_enqueue: {
    table: 'employment_positions',
    mode: 'origin',
    kind: 'derivation',
    reason: 'Enqueues a Firestore mirror write (0088). A replica must not re-enqueue it.',
  },
  persons_mirror_enqueue: {
    table: 'persons',
    mode: 'origin',
    kind: 'derivation',
    reason: 'Enqueues a Firestore mirror write (0088). A replica must not re-enqueue it.',
  },
  store_attendance_config_mirror_enqueue: {
    table: 'store_attendance_config',
    mode: 'origin',
    kind: 'derivation',
    reason: 'Enqueues a Firestore mirror write (0088). A replica must not re-enqueue it.',
  },
  attendance_days_mirror_enqueue: {
    table: 'attendance_days',
    mode: 'origin',
    kind: 'derivation',
    reason:
      'Enqueues a Firestore mirror write, windowed to the current/previous business day (0088, ' +
      'narrowed 0112/DEF-118). A replica must not re-enqueue it.',
  },
  attendance_credentials_mirror_enqueue: {
    table: 'attendance_credentials',
    mode: 'origin',
    kind: 'derivation',
    reason: 'Enqueues a Firestore mirror write (0100). A replica must not re-enqueue it.',
  },
  stores_seed_foundation_money_accounts: {
    table: 'stores',
    mode: 'origin',
    kind: 'derivation',
    reason: 'Seeds the five foundation money accounts for a new store (0029). A replay must not seed a second set over restored ones.',
  },
  stores_opening_date_propagate_trg: {
    table: 'stores',
    mode: 'origin',
    kind: 'derivation',
    reason: 'Propagates the opening date onto dependent rows (0163). The restored rows already carry the derived value.',
  },
  fixed_assets_in_service_a_fill_ins_trg: {
    table: 'fixed_assets',
    mode: 'origin',
    kind: 'derivation',
    reason: 'Fills an in-service derived column on INSERT (0163). The restored row already carries it.',
  },
  fixed_assets_in_service_a_fill_upd_trg: {
    table: 'fixed_assets',
    mode: 'origin',
    kind: 'derivation',
    reason: 'Fills an in-service derived column on UPDATE (0163). The restored row already carries it.',
  },
  person_grants_fill_store_id_trg: {
    table: 'person_grants',
    mode: 'origin',
    kind: 'derivation',
    reason: 'Fills store_id from the position default it was granted from (0159). The restored row already carries it.',
  },

  // Validators (30) — check new data against ANOTHER row's current state or the clock.
  accounts_postable_no_children: {
    table: 'accounts',
    mode: 'origin',
    kind: 'validator',
    reason: 'A parent account with children cannot be posted to (0000) — reads the CURRENT chart, not this row alone.',
  },
  journal_lines_account_eligible: {
    table: 'journal_lines',
    mode: 'origin',
    kind: 'validator',
    reason: 'A line\'s account must be postable and active right now (0003) — reads the account\'s CURRENT state.',
  },
  journal_entries_period_open: {
    table: 'journal_entries',
    mode: 'origin',
    kind: 'validator',
    reason: 'An entry may post only into an OPEN period (0003) — reads the period\'s CURRENT status.',
  },
  journal_lines_period_open: {
    table: 'journal_lines',
    mode: 'origin',
    kind: 'validator',
    reason: 'A line\'s entry must be in an OPEN period (0003) — reads the period\'s CURRENT status.',
  },
  journal_lines_party_requirement: {
    table: 'journal_lines',
    mode: 'origin',
    kind: 'validator',
    reason: 'A subledger account line needs a party (0007) — a shape rule re-checked at replay time, deliberately.',
  },
  journal_entries_balance_check: {
    table: 'journal_entries',
    mode: 'origin',
    kind: 'validator',
    reason: 'Deferred: an entry\'s lines must balance by commit (0003) — recomputes from the CURRENT line set.',
  },
  journal_lines_balance_check: {
    table: 'journal_lines',
    mode: 'origin',
    kind: 'validator',
    reason: 'Deferred: an entry\'s lines must balance by commit (0003) — recomputes from the CURRENT line set.',
  },
  stock_movements_check_period_open_trg: {
    table: 'stock_movements',
    mode: 'origin',
    kind: 'validator',
    reason: 'A movement may post only into an OPEN period (0063; Manila business day since 0180) — reads the period\'s CURRENT status.',
  },
  stock_movements_check_not_frozen_trg: {
    table: 'stock_movements',
    mode: 'origin',
    kind: 'validator',
    reason: 'A movement may not post against a frozen count session (0068) — reads the session\'s CURRENT status.',
  },
  stock_movements_reversal_matches_trg: {
    table: 'stock_movements',
    mode: 'origin',
    kind: 'validator',
    reason: 'A reversal must match the movement it reverses (0063) — reads the CURRENT original row.',
  },
  stock_movements_no_negative_on_hand_trg: {
    table: 'stock_movements',
    mode: 'origin',
    kind: 'validator',
    reason: 'Deferred: on-hand quantity may not go negative (0063, function replaced 0142) — recomputes from the CURRENT ledger.',
  },
  stock_layer_consumptions_ties_trg: {
    table: 'stock_layer_consumptions',
    mode: 'origin',
    kind: 'validator',
    reason: 'Deferred: consumption must tie to its layers (0064) — recomputes from the CURRENT layer set.',
  },
  stock_locations_single_room_guard_trg: {
    table: 'stock_locations',
    mode: 'origin',
    kind: 'validator',
    reason: 'A store may have only one ROOM-kind location (0062) — reads the store\'s CURRENT location set.',
  },
  stock_locations_deactivation_guard_trg: {
    table: 'stock_locations',
    mode: 'origin',
    kind: 'validator',
    reason: 'A location with an on-hand balance cannot be deactivated (0122) — reads the CURRENT ledger.',
  },
  opening_counts_room_in_store: {
    table: 'opening_counts',
    mode: 'origin',
    kind: 'validator',
    reason: 'An opening count\'s room must belong to its store (0191, T-390 R1) — reads the CURRENT stock_locations row.',
  },
  stock_usage_operating_location_trg: {
    table: 'stock_usage_records',
    mode: 'origin',
    kind: 'validator',
    reason: 'A usage record\'s location must be an operating (non-ROOM) location right now (0067) — reads the CURRENT location.',
  },
  count_session_locations_one_active_trg: {
    table: 'count_session_locations',
    mode: 'origin',
    kind: 'validator',
    reason: 'A location may have only one active count session (0068) — reads the CURRENT session set.',
  },
  delivery_lines_shortage_explained_trg: {
    table: 'delivery_lines',
    mode: 'origin',
    kind: 'validator',
    reason: 'A shortage on a delivery line needs an explanation (0066) — a shape rule re-checked at replay time, deliberately.',
  },
  items_block_slab_recategorise_trg: {
    table: 'items',
    mode: 'origin',
    kind: 'validator',
    reason: 'A slab item cannot be recategorised while slices reference it (0125) — reads the CURRENT slice set.',
  },
  items_base_unit_fixed: {
    table: 'items',
    mode: 'origin',
    kind: 'validator',
    reason: "An item's unit cannot change once it has history (0186, T-378) - reads other tables' CURRENT rows, so it must stay silent on a replica-mode restore.",
  },
  items_variant_guard: {
    table: 'items',
    mode: 'origin',
    kind: 'validator',
    reason: 'A variation is one level, the same kind as its parent, and its parent is not merged (0210/0211, T-443; serialized per org) - reads the parent row and the child rows as they are NOW, so it must stay silent on a replica-mode restore.',
  },
  items_check_parent_slab_unit_trg: {
    table: 'items',
    mode: 'origin',
    kind: 'validator',
    reason: 'A slice\'s parent must currently be a slab (0125) — reads the parent\'s CURRENT kind.',
  },
  trade_orders_submit_hardening_trg: {
    table: 'trade_orders',
    mode: 'origin',
    kind: 'validator',
    reason: 'A submitted order\'s lines must be well-formed against the CURRENT catalogue (0070).',
  },
  expenses_require_verified_invoice: {
    table: 'expenses',
    mode: 'origin',
    kind: 'validator',
    reason:
      'A credit expense needs a verified supplier invoice (0043) — reads the invoice\'s CURRENT status. ' +
      'Also locks the invoice row FOR NO KEY UPDATE (serialises recording and voiding) and refuses an ' +
      'expense at a different store from its invoice (T-367, migration 0176).',
  },
  order_wastage_allocations_sum_100_trg: {
    table: 'order_wastage_allocations',
    mode: 'origin',
    kind: 'validator',
    reason: 'Deferred: an order\'s wastage allocations must sum to 100% (0126) — recomputes from the CURRENT allocation set.',
  },
  fiscal_periods_order_guard_ins_trg: {
    table: 'fiscal_periods',
    mode: 'origin',
    kind: 'validator',
    reason: 'A new period must close in order (0160) — reads the CURRENT period set.',
  },
  fiscal_periods_order_guard_upd_trg: {
    table: 'fiscal_periods',
    mode: 'origin',
    kind: 'validator',
    reason: 'A period cannot reopen out of order (0160) — reads the CURRENT period set.',
  },
  fixed_assets_in_service_b_guard_trg: {
    table: 'fixed_assets',
    mode: 'origin',
    kind: 'validator',
    reason: 'An in-service date cannot precede the asset\'s CURRENT acquisition state (0163).',
  },
  attendance_punches_validate: {
    table: 'attendance_punches',
    mode: 'origin',
    kind: 'validator',
    reason: 'A punch/correction must reference a live employment and shape (0082) — reads CURRENT employment state.',
  },
  attendance_adjustments_validate: {
    table: 'attendance_adjustments',
    mode: 'origin',
    kind: 'validator',
    reason: 'An adjustment must reference a live employment and day (0084) — reads CURRENT employment/day state.',
  },
  missed_month_adjustments_guard_trg: {
    table: 'missed_month_adjustments',
    mode: 'origin',
    kind: 'validator',
    reason: 'BEFORE INSERT (0161): the named month must genuinely be missed right now — reads the CURRENT schedule.',
  },
  fiscal_periods_gap_guard_trg: {
    table: 'fiscal_periods',
    mode: 'origin',
    kind: 'validator',
    reason: 'A month may not close or lock over a missing earlier month (0174, DEF-424) — reads the CURRENT period set.',
  },
  fixed_assets_terms_freeze_trg: {
    table: 'fixed_assets',
    mode: 'origin',
    kind: 'validator',
    reason: 'Useful life, interval, salvage value and cost freeze once depreciation posts (0174, DEF-436) — reads the CURRENT journal.',
  },
  // T-375 S4 (0185): the link-aware lock. Origin validators: they read ANOTHER row's CURRENT state (the store's link,
  // the day's status) and the transaction-local flag, so a replay of historic rows must not re-run them.
  sales_days_figure_lock: {
    table: 'sales_days',
    mode: 'origin',
    kind: 'validator',
    reason: "A linked store's day figures change only inside the derivation (0185, T-375 R6) - reads the store's CURRENT link and the flag.",
  },
  // T-385 (0188): the order submitted -> verified. Origin: a replay or restore must load historic days verified straight from open.
  sales_days_verify_requires_submitted: {
    table: 'sales_days',
    mode: 'origin',
    kind: 'validator',
    reason: 'A day reaches verified only from submitted (T-385, 0188). Origin: a replay or restore must load historic days verified straight from open.',
  },
  // T-386 (0189): item codes are never issued twice. Origin validator: reads another row's CURRENT state (the counters).
  items_code_never_reused: {
    table: 'items',
    mode: 'origin',
    kind: 'validator',
    reason:
      "A shaped item code must be above its stem's high-water mark (T-386, 0189) - reads another row's CURRENT state " +
      '(item_code_counters); a restore loads the counters with the items, so it stays silent on replay.',
  },
  item_code_counters_forward_only: {
    table: 'item_code_counters',
    mode: 'always',
    kind: 'history_guard',
    reason:
      'The mark records numbers already issued; lowering it would re-issue them. Decides from OLD/NEW only (T-386, 0189).',
  },
  sales_day_tenders_lock: {
    table: 'sales_day_tenders',
    mode: 'origin',
    kind: 'validator',
    reason: "A linked store's tender rows change only inside the derivation (0185) - reads the day's source, status and the store's link.",
  },
  sales_day_channels_lock: {
    table: 'sales_day_channels',
    mode: 'origin',
    kind: 'validator',
    reason: "A feed day's remitted channel rows change only inside the derivation; platform rows only while the day is unverified (0185).",
  },
  pos_v1_store_links_store_fixed: {
    table: 'pos_v1_store_links',
    mode: 'origin',
    kind: 'validator',
    reason: "A POS link's store never changes (0185, T-375 R6).",
  },
  // T-401 S1 (0196): the menu catalog guards. Origin validators: each reads the clock or another row’s current state.
  menu_categories_parent_guard: {
    table: 'menu_categories',
    mode: 'origin',
    kind: 'validator',
    reason: "A category has at most one level of parent (0196). Reads another category row.",
  },
  menu_categories_retire_guard: {
    table: 'menu_categories',
    mode: 'origin',
    kind: 'validator',
    reason: "A category holding an active item cannot be retired (0196). Reads the items’ current status.",
  },
  menu_items_category_guard: {
    table: 'menu_items',
    mode: 'origin',
    kind: 'validator',
    reason: "An active item cannot sit in a retired category (0196). Reads the category’s current status.",
  },
  menu_items_type_guard: {
    table: 'menu_items',
    mode: 'origin',
    kind: 'validator',
    reason: "item_type is fixed once any variant has an offer (0196). Reads the offers table.",
  },
  menu_items_retire_guard: {
    table: 'menu_items',
    mode: 'origin',
    kind: 'validator',
    reason: "An item with an offer in force or scheduled cannot be retired (0196). Reads offers and the clock.",
  },
  menu_item_variants_retire_guard: {
    table: 'menu_item_variants',
    mode: 'origin',
    kind: 'validator',
    reason: "A variant with an offer in force or scheduled cannot be retired (0196). Reads offers and the clock.",
  },
  menu_item_variants_default_guard: {
    table: 'menu_item_variants',
    mode: 'origin',
    kind: 'validator',
    reason: "An active item keeps exactly one active default variant (0196, deferred constraint trigger). Reads sibling variants.",
  },
  menu_package_refills_pair_guard: {
    table: 'menu_package_refills',
    mode: 'origin',
    kind: 'validator',
    reason: "Package variant to refill item only (0196). Reads the two items’ types.",
  },
  menu_depletion_rules_insert_guard: {
    table: 'menu_depletion_rules',
    mode: 'origin',
    kind: 'validator',
    reason: "No back-dating (0196): decides from the clock. Origin: a restore loads historic rows.",
  },
  menu_depletion_rules_update_guard: {
    table: 'menu_depletion_rules',
    mode: 'always',
    kind: 'history_guard',
    reason: 'A price or depletion history row is never updated (0196, ENABLE ALWAYS). Decides only from TG_OP, so replica mode must not rewrite history.',
  },
  menu_depletion_rules_delete_guard: {
    table: 'menu_depletion_rules',
    mode: 'origin',
    kind: 'validator',
    reason: "Only a future rule may go, and only if no live offer is left uncovered (0196). Reads the clock and the offers.",
  },
  menu_offers_insert_guard: {
    table: 'menu_offers',
    mode: 'origin',
    kind: 'validator',
    reason: "No back-dating; refill/amount/bundle shape; a live offer needs a depletion rule in force (0196). Reads the clock and other rows.",
  },
  menu_offers_update_guard: {
    table: 'menu_offers',
    mode: 'always',
    kind: 'history_guard',
    reason: 'A price or depletion history row is never updated (0196, ENABLE ALWAYS). Decides only from TG_OP, so replica mode must not rewrite history.',
  },
  menu_offers_delete_guard: {
    table: 'menu_offers',
    mode: 'origin',
    kind: 'validator',
    reason: "Only a future offer may be deleted, a cancelled scheduled change (0196). Decides from the clock.",
  },
  menu_option_offers_insert_guard: {
    table: 'menu_option_offers',
    mode: 'origin',
    kind: 'validator',
    reason: "No back-dating (0196): decides from the clock.",
  },
  menu_option_offers_update_guard: {
    table: 'menu_option_offers',
    mode: 'always',
    kind: 'history_guard',
    reason: 'A price or depletion history row is never updated (0196, ENABLE ALWAYS). Decides only from TG_OP, so replica mode must not rewrite history.',
  },
  menu_option_offers_delete_guard: {
    table: 'menu_option_offers',
    mode: 'origin',
    kind: 'validator',
    reason: "Only a future option offer may be deleted (0196). Decides from the clock.",
  },
  menu_item_variants_parent_guard: {
    table: 'menu_item_variants',
    mode: 'origin',
    kind: 'validator',
    reason: 'A variant\u2019s parent item is fixed once it has an offer or package refill (0196). Reads other rows.',
  },
  menu_item_requests_guard: {
    table: 'menu_item_requests',
    mode: 'origin',
    kind: 'validator',
    reason: "A request resolves once and its identity columns are frozen (0196). Decides from OLD/NEW status.",
  },
  menu_pos_v1_links_guard: {
    table: 'menu_pos_v1_links',
    mode: 'origin',
    kind: 'validator',
    reason: "A link needs an active variant with a depletion rule in force now, a location in its store, immutable identity (0196). Reads other rows and the clock.",
  },
  menu_usage_source_switches_insert_guard: {
    table: 'menu_usage_source_switches',
    mode: 'origin',
    kind: 'derivation',
    reason: "A switch is immediate: created_at is set to now() (0196). Derives a value from the clock.",
  },
  menu_usage_source_switches_update_guard: {
    table: 'menu_usage_source_switches',
    mode: 'always',
    kind: 'history_guard',
    reason: "A usage-source switch is never updated (0196, ENABLE ALWAYS). Decides only from TG_OP.",
  },
  menu_usage_source_switches_delete_guard: {
    table: 'menu_usage_source_switches',
    mode: 'always',
    kind: 'history_guard',
    reason: 'A usage-source switch is never deleted (0196, ENABLE ALWAYS). Decides only from TG_OP.',
  },
  statutory_rates_immutable: {
    table: 'statutory_rates',
    mode: 'always',
    kind: 'history_guard',
    reason: 'A confirmed statutory rate is never edited or deleted (0206, T-190). Decides only from OLD/NEW.',
  },
  withholding_brackets_immutable: {
    table: 'withholding_brackets',
    mode: 'always',
    kind: 'history_guard',
    reason: 'A confirmed withholding bracket is never edited or deleted (0206, T-190). Decides only from OLD/NEW.',
  },
  minimum_wages_immutable: {
    table: 'minimum_wages',
    mode: 'always',
    kind: 'history_guard',
    reason: 'A confirmed minimum wage is never edited or deleted (0206, T-190). Decides only from OLD/NEW.',
  },
  withholding_brackets_set_closed: {
    table: 'withholding_brackets',
    mode: 'origin',
    kind: 'validator',
    reason: 'No row may join a bracket set that already holds a confirmed row (0206, T-190). Reads other rows of the set.',
  },
  // ---------------------------------------------------------------------------------------------
  // ORIGIN / VALIDATOR (55) - T-398 S4 / DEF-491 same-org guards on the derived-scope FKs (0214).
  // ---------------------------------------------------------------------------------------------
  ap_payment_allocations_expense_id_same_org_trg: {
    table: 'ap_payment_allocations',
    mode: 'origin',
    kind: 'validator',
    reason:
      'Same-org guard (0214, T-398 S4, DEF-491): expense_id must point at a expenses row of the organisation of the header ap_payments. Decides from another row organisation.',
  },
  ar_collection_allocations_ar_charge_id_same_org_trg: {
    table: 'ar_collection_allocations',
    mode: 'origin',
    kind: 'validator',
    reason:
      'Same-org guard (0214, T-398 S4, DEF-491): ar_charge_id must point at a ar_charges row of the organisation of the header ar_collections. Decides from another row organisation.',
  },
  attendance_adjustments_decided_by_session_id_same_org_trg: {
    table: 'attendance_adjustments',
    mode: 'origin',
    kind: 'validator',
    reason:
      'Same-org guard (0214, T-398 S4, DEF-491): decided_by_session_id must point at a sessions row of the organisation of this row. Decides from another row organisation.',
  },
  attendance_punches_captured_by_session_id_same_org_trg: {
    table: 'attendance_punches',
    mode: 'origin',
    kind: 'validator',
    reason:
      'Same-org guard (0214, T-398 S4, DEF-491): captured_by_session_id must point at a sessions row of the organisation of this row. Decides from another row organisation.',
  },
  count_lines_counted_by_same_org_trg: {
    table: 'count_lines',
    mode: 'origin',
    kind: 'validator',
    reason:
      'Same-org guard (0214, T-398 S4, DEF-491): counted_by must point at a persons row of the organisation of the header count_sessions. Decides from another row organisation.',
  },
  count_lines_item_id_same_org_trg: {
    table: 'count_lines',
    mode: 'origin',
    kind: 'validator',
    reason:
      'Same-org guard (0214, T-398 S4, DEF-491): item_id must point at a items row of the organisation of the header count_sessions. Decides from another row organisation.',
  },
  count_lines_location_id_same_org_trg: {
    table: 'count_lines',
    mode: 'origin',
    kind: 'validator',
    reason:
      'Same-org guard (0214, T-398 S4, DEF-491): location_id must point at a stock_locations row of the organisation of the header count_sessions. Decides from another row organisation.',
  },
  count_lines_movement_id_same_org_trg: {
    table: 'count_lines',
    mode: 'origin',
    kind: 'validator',
    reason:
      'Same-org guard (0214, T-398 S4, DEF-491): movement_id must point at a stock_movements row of the organisation of the header count_sessions. Decides from another row organisation.',
  },
  count_session_locations_location_id_same_org_trg: {
    table: 'count_session_locations',
    mode: 'origin',
    kind: 'validator',
    reason:
      'Same-org guard (0214, T-398 S4, DEF-491): location_id must point at a stock_locations row of the organisation of the header count_sessions. Decides from another row organisation.',
  },
  customer_return_lines_item_id_same_org_trg: {
    table: 'customer_return_lines',
    mode: 'origin',
    kind: 'validator',
    reason:
      'Same-org guard (0214, T-398 S4, DEF-491): item_id must point at a items row of the organisation of the header customer_returns. Decides from another row organisation.',
  },
  customer_return_lines_movement_id_same_org_trg: {
    table: 'customer_return_lines',
    mode: 'origin',
    kind: 'validator',
    reason:
      'Same-org guard (0214, T-398 S4, DEF-491): movement_id must point at a stock_movements row of the organisation of the header customer_returns. Decides from another row organisation.',
  },
  customer_return_lines_trade_order_line_id_same_org_trg: {
    table: 'customer_return_lines',
    mode: 'origin',
    kind: 'validator',
    reason:
      'Same-org guard (0214, T-398 S4, DEF-491): trade_order_line_id must point at a trade_order_lines row of the organisation of the header customer_returns. Decides from another row organisation.',
  },
  delivery_lines_item_id_same_org_trg: {
    table: 'delivery_lines',
    mode: 'origin',
    kind: 'validator',
    reason:
      'Same-org guard (0214, T-398 S4, DEF-491): item_id must point at a items row of the organisation of the header deliveries. Decides from another row organisation.',
  },
  delivery_lines_location_id_same_org_trg: {
    table: 'delivery_lines',
    mode: 'origin',
    kind: 'validator',
    reason:
      'Same-org guard (0214, T-398 S4, DEF-491): location_id must point at a stock_locations row of the organisation of the header deliveries. Decides from another row organisation.',
  },
  employment_positions_position_id_same_org_trg: {
    table: 'employment_positions',
    mode: 'origin',
    kind: 'validator',
    reason:
      'Same-org guard (0214, T-398 S4, DEF-491): position_id must point at a positions row of the organisation of the header employments. Decides from another row organisation.',
  },
  expense_payments_cash_request_id_same_org_trg: {
    table: 'expense_payments',
    mode: 'origin',
    kind: 'validator',
    reason:
      'Same-org guard (0214, T-398 S4, DEF-491): cash_request_id must point at a cash_requests row of the organisation of the header expenses. Decides from another row organisation.',
  },
  expense_payments_money_account_id_same_org_trg: {
    table: 'expense_payments',
    mode: 'origin',
    kind: 'validator',
    reason:
      'Same-org guard (0214, T-398 S4, DEF-491): money_account_id must point at a money_accounts row of the organisation of the header expenses. Decides from another row organisation.',
  },
  expense_payments_staff_id_same_org_trg: {
    table: 'expense_payments',
    mode: 'origin',
    kind: 'validator',
    reason:
      'Same-org guard (0214, T-398 S4, DEF-491): staff_id must point at a persons row of the organisation of the header expenses. Decides from another row organisation.',
  },
  journal_lines_account_id_same_org_trg: {
    table: 'journal_lines',
    mode: 'origin',
    kind: 'validator',
    reason:
      'Same-org guard (0214, T-398 S4, DEF-491): account_id must point at a accounts row of the organisation of the header journal_entries. Decides from another row organisation.',
  },
  journal_lines_store_id_same_org_trg: {
    table: 'journal_lines',
    mode: 'origin',
    kind: 'validator',
    reason:
      'Same-org guard (0214, T-398 S4, DEF-491): store_id must point at a stores row of the organisation of the header journal_entries. Decides from another row organisation.',
  },
  order_wastage_allocations_person_id_same_org_trg: {
    table: 'order_wastage_allocations',
    mode: 'origin',
    kind: 'validator',
    reason:
      'Same-org guard (0214, T-398 S4, DEF-491): person_id must point at a persons row of the organisation of the header order_wastages. Decides from another row organisation.',
  },
  person_credentials_revoked_by_same_org_trg: {
    table: 'person_credentials',
    mode: 'origin',
    kind: 'validator',
    reason:
      'Same-org guard (0214, T-398 S4, DEF-491): revoked_by must point at a persons row of the organisation of the header persons. Decides from another row organisation.',
  },
  person_credentials_store_id_same_org_trg: {
    table: 'person_credentials',
    mode: 'origin',
    kind: 'validator',
    reason:
      'Same-org guard (0214, T-398 S4, DEF-491): store_id must point at a stores row of the organisation of the header persons. Decides from another row organisation.',
  },
  person_grants_granted_by_same_org_trg: {
    table: 'person_grants',
    mode: 'origin',
    kind: 'validator',
    reason:
      'Same-org guard (0214, T-398 S4, DEF-491): granted_by must point at a persons row of the organisation of the header persons. Decides from another row organisation.',
  },
  person_grants_source_ref_same_org_trg: {
    table: 'person_grants',
    mode: 'origin',
    kind: 'validator',
    reason:
      'Same-org guard (0214, T-398 S4, DEF-491): source_ref must point at a position_capability_defaults row of the organisation of the header persons. Decides from another row organisation.',
  },
  person_grants_store_id_same_org_trg: {
    table: 'person_grants',
    mode: 'origin',
    kind: 'validator',
    reason:
      'Same-org guard (0214, T-398 S4, DEF-491): store_id must point at a stores row of the organisation of the header persons. Decides from another row organisation.',
  },
  person_store_scope_granted_by_same_org_trg: {
    table: 'person_store_scope',
    mode: 'origin',
    kind: 'validator',
    reason:
      'Same-org guard (0214, T-398 S4, DEF-491): granted_by must point at a persons row of the organisation of the header persons. Decides from another row organisation.',
  },
  person_store_scope_store_id_same_org_trg: {
    table: 'person_store_scope',
    mode: 'origin',
    kind: 'validator',
    reason:
      'Same-org guard (0214, T-398 S4, DEF-491): store_id must point at a stores row of the organisation of the header persons. Decides from another row organisation.',
  },
  pos_usage_pull_lines_item_id_same_org_trg: {
    table: 'pos_usage_pull_lines',
    mode: 'origin',
    kind: 'validator',
    reason:
      'Same-org guard (0214, T-398 S4, DEF-491): item_id must point at a items row of the organisation of the header pos_usage_pulls. Decides from another row organisation.',
  },
  pos_usage_pull_lines_location_id_same_org_trg: {
    table: 'pos_usage_pull_lines',
    mode: 'origin',
    kind: 'validator',
    reason:
      'Same-org guard (0214, T-398 S4, DEF-491): location_id must point at a stock_locations row of the organisation of the header pos_usage_pulls. Decides from another row organisation.',
  },
  pos_usage_pull_lines_usage_record_id_same_org_trg: {
    table: 'pos_usage_pull_lines',
    mode: 'origin',
    kind: 'validator',
    reason:
      'Same-org guard (0214, T-398 S4, DEF-491): usage_record_id must point at a stock_usage_records row of the organisation of the header pos_usage_pulls. Decides from another row organisation.',
  },
  production_recipe_lines_item_id_same_org_trg: {
    table: 'production_recipe_lines',
    mode: 'origin',
    kind: 'validator',
    reason:
      'Same-org guard (0214, T-398 S4, DEF-491): item_id must point at a items row of the organisation of the header production_recipes. Decides from another row organisation.',
  },
  production_record_lines_item_id_same_org_trg: {
    table: 'production_record_lines',
    mode: 'origin',
    kind: 'validator',
    reason:
      'Same-org guard (0214, T-398 S4, DEF-491): item_id must point at a items row of the organisation of the header production_records. Decides from another row organisation.',
  },
  production_record_lines_movement_id_same_org_trg: {
    table: 'production_record_lines',
    mode: 'origin',
    kind: 'validator',
    reason:
      'Same-org guard (0214, T-398 S4, DEF-491): movement_id must point at a stock_movements row of the organisation of the header production_records. Decides from another row organisation.',
  },
  remittance_allocations_sales_day_id_same_org_trg: {
    table: 'remittance_allocations',
    mode: 'origin',
    kind: 'validator',
    reason:
      'Same-org guard (0214, T-398 S4, DEF-491): sales_day_id must point at a sales_days row of the organisation of the header remittances. Decides from another row organisation.',
  },
  remittance_lines_from_money_account_id_same_org_trg: {
    table: 'remittance_lines',
    mode: 'origin',
    kind: 'validator',
    reason:
      'Same-org guard (0214, T-398 S4, DEF-491): from_money_account_id must point at a money_accounts row of the organisation of the header remittances. Decides from another row organisation.',
  },
  remittance_lines_money_transfer_id_same_org_trg: {
    table: 'remittance_lines',
    mode: 'origin',
    kind: 'validator',
    reason:
      'Same-org guard (0214, T-398 S4, DEF-491): money_transfer_id must point at a money_transfers row of the organisation of the header remittances. Decides from another row organisation.',
  },
  remittance_lines_to_money_account_id_same_org_trg: {
    table: 'remittance_lines',
    mode: 'origin',
    kind: 'validator',
    reason:
      'Same-org guard (0214, T-398 S4, DEF-491): to_money_account_id must point at a money_accounts row of the organisation of the header remittances. Decides from another row organisation.',
  },
  sales_day_channels_channel_id_same_org_trg: {
    table: 'sales_day_channels',
    mode: 'origin',
    kind: 'validator',
    reason:
      'Same-org guard (0214, T-398 S4, DEF-491): channel_id must point at a sales_channels row of the organisation of the header sales_days. Decides from another row organisation.',
  },
  sales_day_tenders_money_account_id_same_org_trg: {
    table: 'sales_day_tenders',
    mode: 'origin',
    kind: 'validator',
    reason:
      'Same-org guard (0214, T-398 S4, DEF-491): money_account_id must point at a money_accounts row of the organisation of the header sales_days. Decides from another row organisation.',
  },
  sessions_credential_id_same_org_trg: {
    table: 'sessions',
    mode: 'origin',
    kind: 'validator',
    reason:
      'Same-org guard (0214, T-398 S4, DEF-491): credential_id must point at a person_credentials row of the organisation of the header persons. Decides from another row organisation.',
  },
  sessions_store_id_same_org_trg: {
    table: 'sessions',
    mode: 'origin',
    kind: 'validator',
    reason:
      'Same-org guard (0214, T-398 S4, DEF-491): store_id must point at a stores row of the organisation of the header persons. Decides from another row organisation.',
  },
  stock_layers_invoice_line_id_same_org_trg: {
    table: 'stock_layers',
    mode: 'origin',
    kind: 'validator',
    reason:
      'Same-org guard (0214, T-398 S4, DEF-491): invoice_line_id must point at a supplier_invoice_lines row of the organisation of this row. Decides from another row organisation.',
  },
  stock_transfer_lines_in_movement_id_same_org_trg: {
    table: 'stock_transfer_lines',
    mode: 'origin',
    kind: 'validator',
    reason:
      'Same-org guard (0214, T-398 S4, DEF-491): in_movement_id must point at a stock_movements row of the organisation of the header stock_transfers. Decides from another row organisation.',
  },
  stock_transfer_lines_item_id_same_org_trg: {
    table: 'stock_transfer_lines',
    mode: 'origin',
    kind: 'validator',
    reason:
      'Same-org guard (0214, T-398 S4, DEF-491): item_id must point at a items row of the organisation of the header stock_transfers. Decides from another row organisation.',
  },
  stock_transfer_lines_out_movement_id_same_org_trg: {
    table: 'stock_transfer_lines',
    mode: 'origin',
    kind: 'validator',
    reason:
      'Same-org guard (0214, T-398 S4, DEF-491): out_movement_id must point at a stock_movements row of the organisation of the header stock_transfers. Decides from another row organisation.',
  },
  stock_usage_lines_item_id_same_org_trg: {
    table: 'stock_usage_lines',
    mode: 'origin',
    kind: 'validator',
    reason:
      'Same-org guard (0214, T-398 S4, DEF-491): item_id must point at a items row of the organisation of the header stock_usage_records. Decides from another row organisation.',
  },
  stock_usage_lines_movement_id_same_org_trg: {
    table: 'stock_usage_lines',
    mode: 'origin',
    kind: 'validator',
    reason:
      'Same-org guard (0214, T-398 S4, DEF-491): movement_id must point at a stock_movements row of the organisation of the header stock_usage_records. Decides from another row organisation.',
  },
  supplier_invoice_lines_item_id_same_org_trg: {
    table: 'supplier_invoice_lines',
    mode: 'origin',
    kind: 'validator',
    reason:
      'Same-org guard (0214, T-398 S4, DEF-491): item_id must point at a items row of the organisation of the header supplier_invoices. Decides from another row organisation.',
  },
  supplier_return_lines_delivery_line_id_same_org_trg: {
    table: 'supplier_return_lines',
    mode: 'origin',
    kind: 'validator',
    reason:
      'Same-org guard (0214, T-398 S4, DEF-491): delivery_line_id must point at a delivery_lines row of the organisation of the header supplier_returns. Decides from another row organisation.',
  },
  supplier_return_lines_item_id_same_org_trg: {
    table: 'supplier_return_lines',
    mode: 'origin',
    kind: 'validator',
    reason:
      'Same-org guard (0214, T-398 S4, DEF-491): item_id must point at a items row of the organisation of the header supplier_returns. Decides from another row organisation.',
  },
  supplier_return_lines_location_id_same_org_trg: {
    table: 'supplier_return_lines',
    mode: 'origin',
    kind: 'validator',
    reason:
      'Same-org guard (0214, T-398 S4, DEF-491): location_id must point at a stock_locations row of the organisation of the header supplier_returns. Decides from another row organisation.',
  },
  supplier_return_lines_movement_id_same_org_trg: {
    table: 'supplier_return_lines',
    mode: 'origin',
    kind: 'validator',
    reason:
      'Same-org guard (0214, T-398 S4, DEF-491): movement_id must point at a stock_movements row of the organisation of the header supplier_returns. Decides from another row organisation.',
  },
  till_count_lines_counted_by_same_org_trg: {
    table: 'till_count_lines',
    mode: 'origin',
    kind: 'validator',
    reason:
      'Same-org guard (0214, T-398 S4, DEF-491): counted_by must point at a persons row of the organisation of the header till_custody_shifts. Decides from another row organisation.',
  },
  till_count_lines_money_account_id_same_org_trg: {
    table: 'till_count_lines',
    mode: 'origin',
    kind: 'validator',
    reason:
      'Same-org guard (0214, T-398 S4, DEF-491): money_account_id must point at a money_accounts row of the organisation of the header till_custody_shifts. Decides from another row organisation.',
  },
} as const;

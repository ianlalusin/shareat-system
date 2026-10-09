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
    reason: 'The audit log is append-only (0167). Decides only from TG_OP. The auditor\'s own repro (DEF-487).',
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
} as const;

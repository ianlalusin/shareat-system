/**
 * Cutover data classification — docs/tasks/119-data-classification-and-purge.md,
 * ADR-007, bible row 108.
 *
 * v2 runs for real Oct–Dec 2026, then every operational table is emptied on 1 January 2027
 * and the books open with one balance-sheet entry of counted, present-day facts (row 106).
 *
 * **THE TABLE IS THE MARK.** There is deliberately no per-row `is_pilot_data` flag. Such a
 * flag would have to be set correctly by every insert path that will ever exist, and one
 * miss — a cron, a backfill, a Phase 5 module written in November — leaves a row that
 * SILENTLY survives the purge and contaminates the opening books. That is DEF-036's lesson
 * exactly: a guard written against the code that exists today stops guarding when new code
 * appears. Whether data is configuration or operational is a property of the TABLE.
 *
 * **There is no default class.** An unlisted table is a build failure, never an assumption —
 * a default would be a decision made by whoever wrote the default, for data they have never
 * seen. `tests/unit/cutover-classification.test.ts` enforces it, and the measure of this
 * module's success is that build failure, not its own green tests.
 */

export type CutoverClass = 'keep' | 'purge' | 'keep_shell' | 'date_scoped';

interface BaseEntry {
  /** Prose, always. A classification without a reason is unreviewable in December, when the
   *  person reading it is not the person who wrote it. */
  readonly reason: string;
}

export interface KeepEntry extends BaseEntry {
  readonly class: 'keep';
}

export interface PurgeEntry extends BaseEntry {
  readonly class: 'purge';
  /** ADR-007 §6 — the ETL tables are evidence behind the opening balance and must survive the
   *  1 January purge, then go once it is signed off. The purge REFUSES them before this date. */
  readonly notBefore?: string;
}

export interface KeepShellEntry extends BaseEntry {
  readonly class: 'keep_shell';
  /** The row survives; these columns are set NULL and re-entered at cutover. */
  readonly clearColumns: readonly string[];
}

export interface DateScopedEntry extends BaseEntry {
  readonly class: 'date_scoped';
  readonly dateColumn: string;
  /** Rows on or after this date survive; earlier rows are purged. */
  readonly keepFrom: string;
}

export type CutoverEntry = KeepEntry | PurgeEntry | KeepShellEntry | DateScopedEntry;

/**
 * Every table in the schema, in exactly one class. Adding a table to the schema without
 * adding it here FAILS THE BUILD — which is the point, and the cheapest possible moment to
 * ask "does this survive the cutover?": while the person who designed it still has the
 * context to answer.
 */
export const CUTOVER_CLASSIFICATION: Readonly<Record<string, CutoverEntry>> = {
  // ---- Configuration and base data ----------------------------------------------------
  organizations: {
    class: 'keep',
    reason:
      'Configuration. With ADR-008 this is a real tenancy boundary, not a placeholder — a ' +
      'franchise is an organization.',
  },
  stores: { class: 'keep', reason: 'Configuration — the branch list.' },
  persons: {
    class: 'keep',
    reason:
      'The staff roster, named explicitly by Ian as data that stays. Pilot users keep their ' +
      'logins (ADR-007 open 2, answered): only what they DID is purged.',
  },
  person_identities: {
    class: 'keep',
    reason: 'Login identities for the roster above. Purging them would lock every user out.',
  },
  person_roles: {
    class: 'keep',
    reason:
      'Access configuration for the staff roster above, not a transactional fact. Purging it ' +
      'at cutover would leave every pilot user with no role at all on 1 January — the opposite ' +
      'of the "pilot users keep their logins" decision this mirrors (ADR-007 open 2).',
  },
  person_store_scope: {
    class: 'keep',
    reason: 'Which stores a person may see — configuration, like the role it accompanies. Same reasoning as person_roles.',
  },
  person_grants: {
    class: 'keep',
    reason:
      'Per-person capability overrides, including the grant-time-fallback rows for managers in ' +
      'admin-less orgs (bible row 115). These are access configuration, not pilot activity — ' +
      'purging them would silently strip capability from staff who need it on day one.',
  },
  accounts: {
    class: 'keep',
    reason:
      'The chart of accounts is configuration. Re-seeding it would risk changing the ids the ' +
      'opening entry references — a catastrophic and silent failure, so it is never rebuilt.',
  },

  // ---- Date-scoped --------------------------------------------------------------------
  fiscal_periods: {
    class: 'date_scoped',
    reason:
      'Splits by date rather than by kind: 2026 pilot periods go, 2027 stays. The only table ' +
      'in the schema that needs this class.',
    dateColumn: 'starts_on',
    keepFrom: '2027-01-01',
  },

  // ---- The books ----------------------------------------------------------------------
  journal_entries: {
    class: 'purge',
    reason: 'The books. Replaced wholesale by the 2027-01-01 opening entry (row 106).',
  },
  journal_lines: {
    class: 'purge',
    reason: 'As journal_entries. Purged first — children before parents.',
  },
  audit_log: {
    class: 'purge',
    reason:
      'It records pilot actions against rows that will not exist. An audit trail pointing at ' +
      'deleted ids is worse than no audit trail: it looks authoritative and resolves to nothing.',
  },

  // ---- T-122: expenses ------------------------------------------------------------------
  expense_categories: {
    class: 'keep',
    reason:
      'The seeded category -> account crosswalk (docs/tasks/122-expenses.md), configuration ' +
      'exactly like accounts itself — re-seeding it at cutover risks changing the ids real ' +
      'pilot expenses reference. Same reasoning as the accounts entry above.',
  },
  expenses: {
    class: 'purge',
    reason:
      'Operational financial activity — a non-inventory spend document, same class as ' +
      'journal_entries. Replaced wholesale by the 2027-01-01 opening entry (row 106); no ' +
      'pilot expense survives the cutover.',
  },
  expense_payments: {
    class: 'purge',
    reason: 'As expenses — its child rows. Purged first — children before parents (see PURGE_ORDER_HINT).',
  },

  // ---- T-123: sales day -----------------------------------------------------------------
  sales_channels: {
    class: 'keep',
    reason:
      'Per-store configuration — the channel list and, critically, the per-channel ' +
      '`is_remitted_daily` flag (v1 Store.salesChannels[]). Same class as expense_categories: ' +
      're-seeding at cutover would change ids that pilot sales days reference, and the ' +
      'remittable flag is a business decision about each channel, not pilot data.',
  },
  sales_days: {
    class: 'purge',
    reason:
      'Operational revenue recognition — the same class as journal_entries and expenses. ' +
      'Replaced wholesale by the 2027-01-01 opening entry (row 106); no pilot sales day ' +
      'survives, and one that did would double-count January revenue.',
  },
  sales_day_channels: {
    class: 'purge',
    reason: 'As sales_days — its child rows. Purged first: children before parents (PURGE_ORDER_HINT).',
  },

  // ---- ETL: purged, but LATER ---------------------------------------------------------
  etl_source_documents: {
    class: 'purge',
    notBefore: '2027-01-31',
    reason:
      'Holds 19,358 captured v1 documents including real PII, AND is the evidence behind every ' +
      'opening figure. Purging on 1 January destroys the ability to answer "where did this ' +
      'number come from?" in the exact month it is asked. Goes once the opening balance is ' +
      'signed off — PII with no remaining purpose is a liability (ADR-007 §6).',
  },
  etl_runs: { class: 'purge', notBefore: '2027-01-31', reason: 'As etl_source_documents — the run history that dates the evidence.' },
  etl_quarantine: { class: 'purge', notBefore: '2027-01-31', reason: 'As etl_source_documents — what could not be converted, and why.' },
  etl_reconciliation: { class: 'purge', notBefore: '2027-01-31', reason: 'As etl_source_documents — the proof nothing landed went missing.' },
};

/** Tables the purge must never touch even if classified — belt and braces around views. */
export const NON_TABLE_RELATIONS: readonly string[] = ['v_account_balance', 'v_trial_balance', 'v_income_statement'];

export function classify(table: string): CutoverEntry | undefined {
  return CUTOVER_CLASSIFICATION[table];
}

export function tablesInClass(cls: CutoverClass): string[] {
  return Object.entries(CUTOVER_CLASSIFICATION)
    .filter(([, e]) => e.class === cls)
    .map(([t]) => t)
    .sort();
}

/**
 * Purge order: children before parents, so a DELETE never trips a foreign key. Derived from
 * the real FK graph at runtime by the purge script; this is the fallback ordering used only
 * when the graph is unavailable, and it is deliberately explicit rather than clever.
 */
export const PURGE_ORDER_HINT: readonly string[] = [
  'sales_day_channels',
  'sales_days',
  'expense_payments',
  'expenses',
  'journal_lines',
  'journal_entries',
  'audit_log',
  'etl_reconciliation',
  'etl_quarantine',
  'etl_source_documents',
  'etl_runs',
];

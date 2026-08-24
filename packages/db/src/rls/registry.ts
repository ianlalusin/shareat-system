/**
 * RLS coverage registry — docs/tasks/120-row-level-security.md, ADR-008 §9–§10, bible row 112.
 *
 * Org isolation is enforced by PostgreSQL, not by remembering to write `WHERE org_id = …`.
 * That filter works until the ONE query that forgets, and that query will exist — written
 * months from now, by someone who did not know the rule, in a report or a script or a fix at
 * 11pm. Application discipline is not a control.
 *
 * A franchise with a separate owner is already live (Padre Garcia, ADR-008 §7), so the failure
 * mode is not a broken page: it is showing one business owner another business owner's books.
 *
 * **Every table declares its scoping here, and an unlisted table fails the build**
 * (`tests/unit/rls-registry.test.ts`). Same rule as the cutover classification: no default,
 * because a default is a decision made by whoever wrote it for data they have never seen.
 */

export type RlsScope =
  /** `org_id` on the table itself. */
  | 'org_column'
  /** No `org_id`; reachable only through a parent that has one. */
  | 'derived'
  /** The organizations table itself — scoped by its own `id`. */
  | 'self'
  /** RLS enabled with NO staff or customer policy. Only the system principal can read it. */
  | 'system_only';

export interface RlsEntry {
  readonly scope: RlsScope;
  /** Prose. A scoping decision without a reason cannot be reviewed by anyone but its author. */
  readonly reason: string;
  /** `derived` only — the SQL predicate linking this table to an org-bearing parent. */
  readonly via?: string;
}

export const RLS_REGISTRY: Readonly<Record<string, RlsEntry>> = {
  organizations: {
    scope: 'self',
    reason: 'The tenancy boundary itself. A principal sees its own organization row and no other.',
  },
  stores: { scope: 'org_column', reason: 'Branches belong to one org. A franchise never sees another org’s stores.' },
  persons: { scope: 'org_column', reason: 'The staff roster is per-org. A franchise owner must not see Ian’s staff.' },
  accounts: {
    scope: 'org_column',
    reason:
      'The chart of accounts is seeded per org. Shared-versus-per-org is ADR-008 open 1; until that ' +
      'is decided, per-org scoping is the safe default — it can be widened later without a leak, ' +
      'whereas starting shared and narrowing means having already exposed it.',
  },
  fiscal_periods: { scope: 'org_column', reason: 'Each org closes its own books on its own calendar.' },
  journal_entries: { scope: 'org_column', reason: 'The books. The single most consequential table to scope correctly.' },

  journal_lines: {
    scope: 'derived',
    via: 'exists (select 1 from journal_entries e where e.id = journal_lines.entry_id and e.org_id = app_current_org())',
    reason:
      'Has NO org_id of its own — it is reachable only through its entry. Scoping it via the parent ' +
      'rather than denormalising an org_id keeps ONE source of truth for which org an entry belongs ' +
      'to; a copied column could drift from its parent, and a line whose org disagreed with its ' +
      'entry would be invisible or visible to the wrong tenant.',
  },
  person_identities: {
    scope: 'derived',
    via: 'exists (select 1 from persons p where p.id = person_identities.person_id and p.org_id = app_current_org())',
    reason: 'Login identities hang off persons, which carries the org.',
  },

  audit_log: {
    scope: 'system_only',
    reason:
      'Has no org column today, so it CANNOT be org-scoped yet — stated plainly rather than given a ' +
      'policy that looks like scoping and is not. RLS is enabled with no staff policy, so it is ' +
      'invisible to every tenant until Phase 2 adds the column. **Failing closed is the correct ' +
      'direction**: a missing policy breaks a feature loudly instead of leaking quietly.',
  },

  etl_runs: { scope: 'system_only', reason: 'ETL machinery. Never reachable by a tenant or a customer — only the migrator, crons and the audit.' },
  etl_source_documents: {
    scope: 'system_only',
    reason:
      'Holds captured v1 production documents including real PII. No tenant has any business reading ' +
      'it; the system principal alone can, which is what the audit and the ETL run as.',
  },
  etl_quarantine: { scope: 'system_only', reason: 'As etl_source_documents — ETL machinery.' },
  etl_reconciliation: { scope: 'system_only', reason: 'As etl_source_documents — ETL machinery.' },
};

export function rlsScopeOf(table: string): RlsEntry | undefined {
  return RLS_REGISTRY[table];
}

export function tablesWithScope(scope: RlsScope): string[] {
  return Object.entries(RLS_REGISTRY)
    .filter(([, e]) => e.scope === scope)
    .map(([t]) => t)
    .sort();
}

/** The database role the application connects as. NOT a superuser — superusers bypass RLS. */
export const APP_ROLE = 'shareat_app';

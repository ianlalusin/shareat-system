/**
 * T-455 S9a item 4 - the nightly lobby job over EVERY org that runs the lobby: expire stale entries, sweep stale pending discount claims, purge personal data
 * (`runLobbyNightly`, S2), once per org. docs/tasks/455-customer-lobby.md "S9 rulings" item 4 and "S2 audit notes".
 *
 * ## The rules that are easy to break
 *  - The org LIST is read under `systemTransaction` (DEF-742, via `listLobbyOrgIds` in ./index): it must see every org, which no single org's principal can. It is the only thing that runs there.
 *  - Each org's WORK runs under `withSystemOrgPrincipal` (role `shareat_app`, RLS on, the org set), in its own transaction: a purge can never see another org, and
 *    one org failing rolls back only itself.
 *  - One org failing never stops the others. The failure is said as the error CLASS and the Postgres code at most: a database error can echo a row value, and a
 *    lobby row holds a name, so no message text is ever kept (the same rule as the route log).
 *  - It is not a `SCHEDULER_JOBS` entry: `scheduler_runs.job` is a closed CHECK, and widening it needs a migration this slice does not need. The run record is the
 *    exit code, the per-org counts the script prints, and the systemd journal. (tests/unit/scheduler-job-hosting.test.ts names it a platform job.)
 */
import { withSystemOrgPrincipal, type Tx } from '@shareat/db';
import { runLobbyNightly } from '../lobby/purge';
import { listLobbyOrgIds, listOrgsToRun } from './index';

export interface LobbyNightlyCounts {
  readonly entriesExpired: number;
  readonly claimsExpired: number;
  readonly entriesPurged: number;
  readonly birthdayNamesPurged: number;
}

export interface LobbyNightlyOrgOutcome extends Partial<LobbyNightlyCounts> {
  readonly orgId: string;
  readonly ok: boolean;
  /** Plain words, never a database message: the error class and, for a database error, its SQLSTATE. */
  readonly error?: string;
}

export interface LobbyNightlyJobResult {
  readonly outcomes: LobbyNightlyOrgOutcome[];
  readonly hadFailures: boolean;
}

/** What went wrong, without any text that could carry a row value. */
function describeFailure(err: unknown): string {
  if (!(err instanceof Error)) return 'failed (not an Error)';
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? `${err.name} (SQLSTATE ${code})` : err.name;
}

export async function runLobbyNightlyJob(
  opts: {
    /** Narrow the list (tests share one database with other orgs). Absent = every org with a lobby_stores row; empty = none. */
    orgIds?: readonly string[];
    /** The per-org work. Defaults to `runLobbyNightly`. */
    run?: (tx: Tx, orgId: string) => Promise<LobbyNightlyCounts>;
  } = {},
): Promise<LobbyNightlyJobResult> {
  const run = opts.run ?? runLobbyNightly;
  // Every company goes through the scheduler's one org list (tests/unit/t398-s7-multi-org-jobs.test.ts: every unit runs per company); the ones with a lobby_stores row are kept.
  const lobbyOrgs = new Set(await listLobbyOrgIds());
  const wanted = opts.orgIds ? new Set(opts.orgIds) : null;
  const orgIds = (await listOrgsToRun()).map((o) => o.id).filter((id) => lobbyOrgs.has(id) && (wanted === null || wanted.has(id))).sort();

  const outcomes: LobbyNightlyOrgOutcome[] = [];
  for (const orgId of orgIds) {
    try {
      const counts = await withSystemOrgPrincipal(orgId, (tx) => run(tx, orgId));
      outcomes.push({ orgId, ok: true, ...counts });
    } catch (err) {
      outcomes.push({ orgId, ok: false, error: describeFailure(err) });
    }
  }
  return { outcomes, hadFailures: outcomes.some((o) => !o.ok) };
}

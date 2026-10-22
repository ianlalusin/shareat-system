/**
 * T-442 S1 - link the files rows already point at (DEF-672 backfill). `docs/tasks/442-receipt-photo-link-backfill.md`.
 *
 * Touches no bytes: this module never imports the storage driver and never deletes a row. It only sets `linked_to`
 * on a file that is still unlinked and is referenced by exactly the kind of row its purpose allows. Problems
 * (mismatched, cross-org, wrong purpose) are reported, never written. A shared file links once to its lowest owner id.
 *
 * The domain owns the transaction. A dry run runs the same writes in the same transaction and rolls it back, so its
 * counts are the real would-link counts.
 */
import { filesRepo, refuse, withSystemOrgPrincipal, type FilePurpose, type Tx } from '@shareat/db';

export interface FileLinkProblem {
  fileId: string;
  ownerId: string;
  source: string;
  purpose: FilePurpose | null;
  /** The file (or, for a cross-org reference, its source) is read through a guarded rule: print counts only. */
  guarded: boolean;
}

export interface BackfillFileLinksResult {
  /** Files linked (or, in a dry run, that would be), per file purpose. */
  linked: Record<string, number>;
  /** The same files, per source `table.column`. */
  bySource: Record<string, number>;
  shared: FileLinkProblem[];
  mismatched: FileLinkProblem[];
  crossOrg: FileLinkProblem[];
  wrongPurpose: FileLinkProblem[];
  /** Unlinked, unreferenced files per `purpose:bucket` (fresh = under 24 h). The sweep removes the old ones. */
  unreferenced: Record<string, number>;
}

const GUARDED_PURPOSES: readonly string[] = filesRepo.GUARDED_PURPOSES;
/** Rows whose files are personal (staff photo, signature): their ids are never printed, whatever the file's purpose. */
const GUARDED_SOURCE_TABLES = ['employments.', 'persons.'];
const DRY_RUN_ROLLBACK = Symbol('backfill-file-links dry run');

function allowedFor(source: string): readonly string[] {
  return filesRepo.FILE_REFERENCES.find((r) => r.label === source)?.allowedPurposes ?? [];
}

function toProblem(p: { fileId: string; ownerId: string; source: string; purpose: FilePurpose | null }): FileLinkProblem {
  const guarded =
    GUARDED_SOURCE_TABLES.some((t) => p.source.startsWith(t)) ||
    (p.purpose !== null
      ? GUARDED_PURPOSES.includes(p.purpose)
      : allowedFor(p.source).every((x) => GUARDED_PURPOSES.includes(x))); // unknown purpose: judge by what the source may hold
  return { fileId: p.fileId, ownerId: p.ownerId, source: p.source, purpose: p.purpose, guarded };
}

async function run(tx: Tx, orgId: string, readOnly: boolean): Promise<BackfillFileLinksResult> {
  const unlinked = await filesRepo.listReferencedUnlinked(tx, orgId);
  const problems = await filesRepo.listReferenceProblems(tx, orgId);
  const unref = await filesRepo.listUnreferenced(tx, orgId);

  const linked: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  const wrongPurpose: FileLinkProblem[] = [];
  const done = new Set<string>();

  // listReferencedUnlinked is ordered lowest owner id first per file: the first reference of a file owns the link.
  for (const r of unlinked) {
    if (done.has(r.fileId)) continue;
    done.add(r.fileId);
    if (!allowedFor(r.source).includes(r.purpose)) {
      wrongPurpose.push(toProblem(r));
      continue;
    }
    // --check is read-only: no UPDATE at all, not even one that is rolled back.
    if (!readOnly && !(await filesRepo.backfillLink(tx, orgId, r.fileId, r.ownerId))) continue;
    linked[r.purpose] = (linked[r.purpose] ?? 0) + 1;
    bySource[r.source] = (bySource[r.source] ?? 0) + 1;
  }

  const unreferenced: Record<string, number> = {};
  for (const u of unref) unreferenced[`${u.purpose}:${u.bucket}`] = u.n;

  return {
    linked,
    bySource,
    shared: problems.shared.map(toProblem),
    mismatched: problems.mismatched.map(toProblem),
    crossOrg: problems.crossOrg.map(toProblem),
    wrongPurpose,
    unreferenced,
  };
}

export async function backfillFileLinks(orgId: string, opts: { confirm: boolean; readOnly?: boolean }): Promise<BackfillFileLinksResult> {
  if (opts.confirm && opts.readOnly) throw refuse('backfillFileLinks: mutually exclusive options.', "A read-only file check can't also confirm changes.");
  if (opts.confirm) return withSystemOrgPrincipal(orgId, (tx) => run(tx, orgId, false));
  let result: BackfillFileLinksResult | undefined;
  try {
    await withSystemOrgPrincipal(orgId, async (tx) => {
      result = await run(tx, orgId, opts.readOnly === true);
      throw DRY_RUN_ROLLBACK;
    });
  } catch (err) {
    if (err !== DRY_RUN_ROLLBACK) throw err;
  }
  if (!result) throw refuse('backfillFileLinks: dry-run body did not finish.', 'The file-link dry run did not finish. No links were saved.');
  return result;
}

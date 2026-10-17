/**
 * `posDayImportSweep` - the 06:00 Manila POS day-import. T-396 S1, `docs/tasks/396-link-remaining-stores-and-morning-import.md` D1.
 *
 * ## What it does
 *
 * For every store with a LIVE POS link, it drafts yesterday's sales day (and any missed day in the last 7) from the POS v1 feed,
 * by calling the ordinary `importSalesDay` as the person who last vouched for the link. The draft is `open`: **it never submits,
 * verifies, posts, re-imports or voids**, and the ledger is untouched. A person submits it, and a different person verifies it.
 *
 * ## The rules that are easy to break
 *
 *  - ⛔ Every read and every import runs under `withOrgPrincipal`, never a bare transaction: RLS and migration 0185's trigger fail
 *    closed without `app.org_id`. The integration suite connects as a restricted role, so a job without it imports nothing.
 *  - A date that already has a sales day in ANY status (voided included) is skipped, not refused: re-entering a withdrawn date is a
 *    manager's decision. `ifAbsent: true` makes `importSalesDay` honour that before the gate and again under the store lock; the
 *    partial unique index on (org, store, date) is the last word, and a 23505 from it is a `skipped`, never a failure.
 *  - Typed outcomes, never sentence matching: POS `found:false` is `{ notFound: true }`; a fetch refusal keeps the `Pos...Error`
 *    as its `cause`. One store's HTTP refusal stops THAT store (a store missing from the POS key map answers 403 for it alone);
 *    "not configured" stops the org (one line).
 *  - Not a failure: a closed day (notice, retried every morning until it ages out of the window) and a pile of unverified drafts
 *    (notice). A gap beyond the 7-day window IS said, as a failure (a notice on the org's first-ever run).
 *  - A dry run fetches and imports inside a rolled-back transaction, skips the recheck, and writes no `scheduler_runs` row.
 */
import { AuthorizationError, type Actor } from '@shareat/auth';
import { posV1Repo, salesDaysRepo, schedulerRepo, withOrgPrincipal, type SchedulerFailure } from '@shareat/db';
import { toBusinessDate } from '@shareat/core';
import { addDays as addBusinessDays, parseBusinessDate } from '@shareat/core/datetime';
import { logger } from '@shareat/core/logger';
import { runJobForOrg, listOrgsToRun, type JobOutcome } from '../scheduler';
import { importSalesDay, type ImportFetchers, type ImportSalesDayOutcome } from '../sales-days/import';
import { safeHumanDate } from '../sales-days/create-block';
import { recheckRecentDays } from './v1-recheck';
import { PosNotConfiguredError, PosUnreachableError } from './v1-feed';

/** The recheck window: a host down for a week still fills in. Also the width of the window the timer never reaches beyond. */
export const CATCH_UP_DAYS = 7;

/** More imported drafts than this waiting for submit/verify gets a notice (the timer bypasses the create-block as an admin). */
const BACKLOG_NOTICE_OVER = 3;

export interface PosDayImportOutcome extends JobOutcome {
  /** Dry run only: the store dates that would have been imported (ISO, `YYYY-MM-DD`). */
  readonly wouldImport?: readonly string[];
}

export interface PosDayImportSweepResult {
  readonly outcomes: PosDayImportOutcome[];
  readonly hadFailures: boolean;
}

interface OrgWork {
  posted: number;
  skipped: number;
  failures: SchedulerFailure[];
  detail: string;
  wouldImport: string[];
}

/** Thrown inside a dry run's transaction to roll it back; carries what the import answered. */
class DryRunRollback extends Error {
  constructor(readonly answer: unknown) {
    super('dry run: rolled back');
    this.name = 'DryRunRollback';
  }
}

function addDays(iso: string, n: number): string {
  return addBusinessDays(parseBusinessDate(iso), n);
}

function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d.localeCompare(to) <= 0 && out.length < 400; d = addDays(d, 1)) out.push(d);
  return out;
}

/** The error and every `cause` beneath it. */
function chain(e: unknown): unknown[] {
  const out: unknown[] = [];
  for (let cur: unknown = e; cur != null && out.length < 8; cur = (cur as { cause?: unknown }).cause) out.push(cur);
  return out;
}

function sentenceOf(e: unknown): string {
  const u = (e as { userMessage?: unknown } | null)?.userMessage;
  if (typeof u === 'string' && u.length > 0) return u;
  return e instanceof Error ? e.message : String(e);
}

function isUniqueViolation(e: unknown): boolean {
  return chain(e).some((c) => (c as { code?: unknown } | null)?.code === '23505');
}

/** The HTTP status a POS refusal names ("... returned 403: ..."). Status only: never the body, never the key. */
function httpStatusOf(e: unknown): string | null {
  for (const c of chain(e)) {
    if (c instanceof PosUnreachableError) {
      const m = /returned (\d{3})/.exec(c.message);
      if (m) return m[1]!;
    }
  }
  return null;
}

function listDates(dates: readonly string[]): string {
  return dates.length <= 14
    ? dates.map(safeHumanDate).join(', ')
    : `${safeHumanDate(dates[0]!)} to ${safeHumanDate(dates[dates.length - 1]!)} (${dates.length} days)`;
}

export async function posDayImportSweep(options: {
  orgId?: string;
  now: Date;
  trigger?: 'cron' | 'manual';
  dryRun?: boolean;
  fetchers?: ImportFetchers;
}): Promise<PosDayImportSweepResult> {
  const { now } = options;
  const trigger = options.trigger ?? 'cron';
  const dryRun = options.dryRun === true;
  const today = toBusinessDate(now);
  // `scheduler_runs.period` is a `YYYY-MM` shape: a daily job records the Manila month it ran in.
  const period = today.slice(0, 7);

  const orgs = await listOrgsToRun(options.orgId);
  const outcomes: PosDayImportOutcome[] = [];

  for (const org of orgs) {
    // Read BEFORE this run opens its own row, so "the previous run" is really the previous one.
    const prev = await withOrgPrincipal(org.id, (tx) => schedulerRepo.lastRunFor(tx, org.id, 'pos_day_import'));
    const prevRunAt = prev?.startedAt ?? null;
    const work = () => importForOrg(org, { today, trigger, dryRun, fetchers: options.fetchers, prevRunAt });

    if (dryRun) {
      const base = { orgId: org.id, orgName: org.name, job: 'pos_day_import' as const, period };
      try {
        const w = await work();
        outcomes.push({
          ...base,
          posted: w.posted,
          skipped: w.skipped,
          failed: w.failures.filter((f) => f.kind !== 'notice').length,
          failures: w.failures,
          detail: w.detail,
          wouldImport: w.wouldImport,
        });
      } catch (err) {
        outcomes.push({ ...base, posted: 0, skipped: 0, failed: 0, failures: [], error: err instanceof Error ? err.message : String(err) });
      }
    } else {
      outcomes.push(await runJobForOrg(org, 'pos_day_import', period, trigger, work, now));
    }
  }

  return { outcomes, hadFailures: outcomes.some((o) => o.failed > 0 || o.error) };
}

async function importForOrg(
  org: { id: string; name: string },
  ctx: { today: string; trigger: 'cron' | 'manual'; dryRun: boolean; fetchers: ImportFetchers | undefined; prevRunAt: Date | null },
): Promise<OrgWork> {
  const { today, trigger, dryRun, fetchers, prevRunAt } = ctx;
  const failures: SchedulerFailure[] = [];
  const wouldImport: string[] = [];
  let posted = 0;
  let skipped = 0;
  let closedDays = 0;
  let storesVisited = 0;

  const yesterday = addDays(today, -1);
  const capStart = addDays(yesterday, -(CATCH_UP_DAYS - 1));
  const prevRunDate = prevRunAt ? toBusinessDate(prevRunAt) : null;

  const links = await withOrgPrincipal(org.id, (tx) => posV1Repo.listLiveLinks(tx, org.id));
  let orgStopped = false;

  for (const link of links) {
    if (orgStopped) break;
    storesVisited += 1;
    const line = (reason: string, kind?: 'notice'): SchedulerFailure => ({
      subjectId: link.storeId,
      subjectName: link.storeName,
      reason,
      ...(kind ? { kind } : {}),
    });
    const actor: Actor = { personId: link.updatedBy ?? link.createdBy, orgId: org.id };
    const linkDate = toBusinessDate(link.createdAt);

    // A gap beyond the window: dates the timer will never reach. Said, never silent.
    const gapFrom = prevRunDate && prevRunDate.localeCompare(linkDate) > 0 ? prevRunDate : linkDate;
    if (gapFrom.localeCompare(capStart) < 0) {
      const gap = dateRange(gapFrom, addDays(capStart, -1));
      const reason =
        `${listDates(gap)} ${gap.length === 1 ? 'is' : 'are'} older than the ${CATCH_UP_DAYS}-day window, so the morning import will never reach ` +
        `${gap.length === 1 ? 'it' : 'them'}. Import ${gap.length === 1 ? 'it' : 'them'} by hand on the sales day page.`;
      // The org's first-ever run only has a link date to go on, so it is a notice; a run that follows a stale one is a failure.
      failures.push(line(reason, prevRunDate ? undefined : 'notice'));
    }

    const from = linkDate.localeCompare(capStart) > 0 ? linkDate : capStart;
    if (from.localeCompare(yesterday) > 0) continue;
    const dates = dateRange(from, yesterday);
    const existing = await withOrgPrincipal(org.id, (tx) =>
      salesDaysRepo.datesWithAnyDay(tx, org.id, link.storeId, from, yesterday),
    );

    const imported: string[] = [];
    const closed: string[] = [];
    let storeStopped = false;

    for (const date of dates) {
      if (existing.has(date)) {
        skipped += 1;
        continue;
      }
      if (storeStopped) break;
      const when = safeHumanDate(date);
      try {
        let answer: ImportSalesDayOutcome;
        try {
          answer = await withOrgPrincipal(org.id, async (tx) => {
            const r = await importSalesDay(tx, actor, { storeId: link.storeId, businessDate: date, ifAbsent: true, source: trigger }, fetchers);
            // A dry run did the whole import (it must, to know what would refuse) and takes it all back.
            if (dryRun) throw new DryRunRollback(r);
            return r;
          });
        } catch (e) {
          if (!(e instanceof DryRunRollback)) throw e;
          answer = e.answer as ImportSalesDayOutcome;
        }
        if ('notFound' in answer) {
          closed.push(date);
          closedDays += 1;
        } else if (answer.skipped) {
          skipped += 1;
        } else {
          posted += 1;
          imported.push(date);
          if (dryRun) wouldImport.push(`${link.storeName} ${date}`);
        }
      } catch (e) {
        const typed = chain(e);
        if (typed.some((c) => c instanceof PosNotConfiguredError)) {
          failures.push({ subjectId: org.id, subjectName: 'POS connection', reason: sentenceOf(e) });
          orgStopped = true;
          break;
        }
        if (typed.some((c) => c instanceof PosUnreachableError)) {
          const status = httpStatusOf(e);
          const hint = status === '403' ? ' A 403 usually means this store is not in the POS key map.' : '';
          failures.push(line(`${when}: ${sentenceOf(e)}${status ? ` (POS answered HTTP ${status}.)` : ''}${hint} The rest of this store's days wait for tomorrow.`));
          storeStopped = true;
          continue;
        }
        if (isUniqueViolation(e)) {
          // A person's import won the unique index while this one waited on it: theirs stands, nothing of ours was kept.
          const nowPresent = await withOrgPrincipal(org.id, (tx) =>
            salesDaysRepo.findAnyByBusinessDate(tx, org.id, link.storeId, date),
          );
          if (nowPresent) {
            skipped += 1;
            continue;
          }
        }
        failures.push(line(`${when}: ${sentenceOf(e)}`));
        // A person who may no longer import cannot import any other day either: one line, not seven.
        if (e instanceof AuthorizationError) storeStopped = true;
      }
    }

    if (closed.length > 0) {
      failures.push(line(`${listDates(closed)}: POS has no sales yet: closed, or not synced. It will be asked again tomorrow.`, 'notice'));
    }

    if (dryRun) continue;

    // After this store's imports have committed: the prior days' recheck. It never throws per day, it reports.
    if (imported.length > 0) {
      const newest = imported[imported.length - 1]!;
      try {
        const res = await recheckRecentDays(actor, link.storeId, newest, fetchers);
        for (const f of res.failed) {
          failures.push(line(`${safeHumanDate(f.businessDate)}: the check against POS did not work, so that day was not refreshed.`, 'notice'));
        }
      } catch (e) {
        logger.warn({ storeId: link.storeId, err: e instanceof Error ? e.message : String(e) }, 'posDayImportSweep: the prior-days recheck failed');
        failures.push(line(`${safeHumanDate(newest)}: the check of the days before it against POS did not work: ${sentenceOf(e)}`, 'notice'));
      }
    }

    // The timer drafts as an admin, who bypasses the create-block, so a pile of drafts has to be said instead.
    const waiting = await withOrgPrincipal(org.id, (tx) => salesDaysRepo.countUnverifiedFeedDays(tx, org.id, link.storeId));
    if (waiting > BACKLOG_NOTICE_OVER) {
      failures.push(line(`${waiting} imported days are waiting for submit and verify.`, 'notice'));
    }
  }

  const realFailures = failures.filter((f) => f.kind !== 'notice').length;
  return {
    posted,
    skipped,
    failures,
    wouldImport,
    detail:
      `${dryRun ? 'dry run - would import' : 'imported'} ${posted} - already there ${skipped} - closed ${closedDays} - ` +
      `stores ${storesVisited} - refused ${realFailures}`,
  };
}

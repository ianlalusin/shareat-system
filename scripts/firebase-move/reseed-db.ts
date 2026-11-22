/**
 * T-625 - the ONE write of the Firebase move, and the only database access of reseed-mirror.ts. It adds mirror_outbox rows
 * (never updates or deletes one) through the repo functions; the SQL lives in packages/db/src/repo/mirror-outbox.ts.
 * Same connection and reason as ./db.ts: the outbox is FORCE RLS and this runs once, by a person, across every organisation.
 */
import { mirrorOutboxRepo, systemTransaction } from '@shareat/db';

export const readCoverage = () =>
  systemTransaction(async (tx) => ({
    coverage: await mirrorOutboxRepo.liveCoverage(tx),
    pending: await mirrorOutboxRepo.pendingPerOrg(tx),
  }));

export const enqueueAll = () =>
  systemTransaction(async (tx) => {
    const added = await mirrorOutboxRepo.enqueueLiveEntities(tx);
    return { added, pending: await mirrorOutboxRepo.pendingPerOrg(tx) };
  });

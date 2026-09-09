/**
 * T-245 — the read-back for the prerequisite-refusal counter.
 * docs/tasks/245-prerequisite-refusal-counter.md §4.
 */
import { prerequisiteRefusalsRepo, withOrgPrincipal } from '@shareat/db';
import type { RefusalCount } from '@shareat/db';

export async function refusalCounts(orgId: string): Promise<RefusalCount[]> {
  return withOrgPrincipal(orgId, (tx) => prerequisiteRefusalsRepo.countByReason(tx, orgId));
}

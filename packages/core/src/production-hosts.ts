/**
 * The production database cluster's host (Ian, 2026-10-13), pinned in ONE place.
 * Matched on host only: 25060 (direct) and 25061 (pooler) are the same cluster.
 * Used by the rehearsal guards (scripts/lib/rehearsal/guards.ts) and by the onboarding-file guard
 * (packages/domain/src/organizations/onboarding-file.ts). Never duplicate the literal.
 */
export const PINNED_PRODUCTION_HOSTS: readonly string[] = ['shareat-system-db-do-user-39783702-0.m.db.ondigitalocean.com'];

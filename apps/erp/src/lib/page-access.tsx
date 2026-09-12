/**
 * T-288 — the page-level READ gate. Ian, 2026-09-12: *"do both hide the menu and gate the reads."*
 *
 * ## ⛔ What changed, and what deliberately did not
 *
 * Until now every admin screen's `lib.ts` carried the same note: *"plain reads go straight through
 * with no capability gate — the gate belongs to the WRITE."* That was DEF-051's remedy, and its
 * reasoning — *presentation is not a control* — remains true and is not repealed. What was missing
 * is the control that hiding was supposed to sit on top of. This is that control.
 *
 * ⛔ **Every existing write gate is untouched.** `authorize()` still runs inside every domain
 * service. This is a SECOND layer for reads (bible §15.11: no layer may be the only one for a
 * given risk), not a replacement for the first.
 *
 * ## ⚠️ Why it returns a refusal instead of redirecting
 *
 * A redirect to `/` from a screen the person reached deliberately is indistinguishable from a bug,
 * and it teaches nobody anything. The card names the capability, so a manager who needs it can ask
 * for it by name — which is exactly what `/admin/users`' grant screen takes.
 */
// ⛔ From the CHOKEPOINT, not from `@shareat/db` — T-261 §B6. That module is where the
//    constraint-refusal counter lives; a direct import silently bypasses it.
import { withOrgPrincipal } from '../app/expenses/lib';
import { heldCapabilities, type Actor } from '@shareat/auth';
import { requireSession } from './session';
import { capabilityForRoute } from './route-capability';

export interface PageAccess {
  actor: Actor;
  /** Non-null when the actor may NOT read this route — render it and return immediately. */
  refusal: React.ReactNode | null;
}

/**
 * Establishes the session, then decides whether this actor may READ `route`.
 *
 * ⚠️ `route` is the page's own literal path, passed by the page, because a Server Component cannot
 * read its own pathname in Next 16 (`AppShell.tsx` carries the same note and the doc reference).
 * `tests/unit/route-capability-coverage.test.ts` is what stops a page passing the wrong one or
 * forgetting the call entirely.
 */
export async function requirePageAccess(route: string): Promise<PageAccess> {
  const { actor } = await requireSession(route);
  const required = capabilityForRoute(route);
  if (required === null) return { actor, refusal: null };

  // ⛔ `withOrgPrincipal`, never a bare `transaction()` — T-231. A plain transaction connects as
  //    the table OWNER, for which row-level security does not apply, so every policy in the
  //    database is switched off for the query. This one reads `person_roles` and `person_grants`,
  //    which are org-scoped: unprincipalled, a read gate would have been consulting rows across
  //    tenancy boundaries. Caught by `tests/unit/no-direct-transaction-in-erp.test.ts`.
  const held = await withOrgPrincipal(actor.orgId, (tx) => heldCapabilities(tx, actor));
  if (held.has(required)) return { actor, refusal: null };

  return { actor, refusal: <AccessRefused capability={required} /> };
}

function AccessRefused({ capability }: { capability: string }) {
  return (
    <div className="mx-auto max-w-xl p-8">
      <div className="rounded-lg border border-amber-300 bg-amber-50 p-6 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
        <h1 className="text-base font-semibold">You do not have access to this screen</h1>
        <p className="mt-2">
          It needs the <code className="font-mono text-xs">{capability}</code> capability, which
          your role does not have.
        </p>
        <p className="mt-2 text-xs">
          If you need it, an administrator can grant it to you by name under Users and roles. Your
          sign-in is fine — this is about what the account is allowed to see, not who you are.
        </p>
        {/* ⚠️ A real control, sized to the 24px touch floor — NOT a bare inline <a>, which
            `action-link-sweep` correctly measured at 20px inside this text. The same call as the
            one deleted from the store page earlier today: fix the control, never baseline it. */}
        <a
          href="/"
          className="mt-4 inline-flex min-h-[44px] items-center rounded border border-amber-400 px-4 py-2 font-medium hover:bg-amber-100 dark:border-amber-700 dark:hover:bg-amber-900"
        >
          Back to the dashboard
        </a>
      </div>
    </div>
  );
}

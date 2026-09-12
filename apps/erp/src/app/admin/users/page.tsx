import { requirePageAccess } from '../../../lib/page-access';
import { listUsers } from './lib';
import { Page } from '@/components/shell/Page';

export const metadata = { title: 'Users and roles — Shareat System' };
export const dynamic = 'force-dynamic';

/**
 * T-219 / DEF-167 — the roster of who can do what.
 *
 * ⭐ **"No role" is the headline, not an empty cell.** `authorize()` denies a person with no
 * active role everything, by design, and nothing in the hire flow assigns one — so since T-217
 * shipped PIN issuance, a hired person can sign in and then do nothing at all. This page is the
 * only place that says so.
 */
export default async function UsersPage() {
  const { actor, refusal } = await requirePageAccess('/admin/users');
  // ⭐ T-288 — the READ gate. Ian, 2026-09-12: "do both hide the menu and gate the reads."
  if (refusal) return refusal;
  const users = await listUsers(actor.orgId);
  const roleless = users.filter((u) => u.role === null).length;

  return (
    <Page density="table">
      <div>
        <h1 className="text-2xl font-semibold">Users and roles</h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          Who holds which role, which stores they can see, and what they have been granted beyond
          their role.
        </p>
      </div>

      {roleless > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
          <strong>
            {roleless} {roleless === 1 ? 'person has' : 'people have'} no role.
          </strong>{' '}
          A person with no role is authorized for nothing — they can sign in and every screen will
          refuse them. Assign a role to finish onboarding them.
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
        <table className="w-full text-sm">
          <thead className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
            <tr>
              <th className="px-4 py-2 font-medium">Name</th>
              <th className="px-4 py-2 font-medium">Role</th>
              <th className="px-4 py-2 font-medium">Stores</th>
              <th className="px-4 py-2 font-medium">Extra grants</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {users.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-neutral-500 dark:text-neutral-400">
                  Nobody in this organisation yet. People are created by hiring them on{' '}
                  <a href="/staff" className="underline underline-offset-4">
                    Staff
                  </a>
                  .
                </td>
              </tr>
            )}
            {users.map((u) => (
              <tr key={u.id} className="border-b border-neutral-100 last:border-0 dark:border-neutral-900">
                <td className="px-4 py-2">
                  {u.displayName}
                  {!u.isActive && <span className="ml-2 text-xs text-neutral-400">(inactive)</span>}
                </td>
                <td className="px-4 py-2">
                  {u.role ? (
                    <span className="rounded bg-neutral-100 px-2 py-0.5 text-xs dark:bg-neutral-800">
                      {u.role.replace(/_/g, ' ')}
                    </span>
                  ) : (
                    <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-300">
                      no role — cannot do anything
                    </span>
                  )}
                </td>
                <td className="px-4 py-2 text-neutral-600 dark:text-neutral-400">{u.storeScopeCount}</td>
                <td className="px-4 py-2 text-neutral-600 dark:text-neutral-400">{u.activeGrantCount}</td>
                <td className="px-4 py-2 text-right">
                  <a href={`/admin/users/${u.id}`} className="underline underline-offset-4">
                    Manage →
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        Only a super-admin can appoint an admin (bible row 116). Nobody can change their own role,
        and the org&rsquo;s last admin cannot be demoted.
      </p>
    </Page>
  );
}

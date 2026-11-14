import { requirePageAccess } from '../../../lib/page-access';
import { listUsers } from './lib';
import { ROLE_LABEL } from '@shareat/auth';
import { Page } from '@/components/shell/Page';
import { Banner, LinkRow, NumTd, RowLink, Table, Td, Th } from '@/components/ui';

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
    <Page
      density="table"
      title="Users and roles"
      description="Who holds which role, which stores they can see, and what they have been granted beyond their role."
    >
      {roleless > 0 && (
        <Banner tone="warning">
          <strong>
            {roleless} {roleless === 1 ? 'person has' : 'people have'} no role.
          </strong>{' '}
          A person with no role is authorized for nothing — they can sign in and every screen will
          refuse them. Assign a role to finish onboarding them.
        </Banner>
      )}

      <Table label="Users and roles" card={{ title: 'Name', subtitle: 'Role', keys: ['Stores', 'Extra grants'] }}>
        <thead>
          <tr>
            <Th>Name</Th>
            <Th>Role</Th>
            <Th numeric>Stores</Th>
            <Th numeric>Extra grants</Th>
            <Th className="w-24" />
          </tr>
        </thead>
        <tbody>
          {users.length === 0 && (
            <tr>
              <Td colSpan={5} className="py-6 text-muted">
                Nobody in this organisation yet. People are created by hiring them on{' '}
                <a href="/staff" className="underline underline-offset-4">
                  Staff
                </a>
                .
              </Td>
            </tr>
          )}
          {users.map((u) => (
            <LinkRow key={u.id}>
              <Td>
                <span className="font-medium">{u.displayName}</span>
                {!u.isActive && <span className="ml-2 text-xs text-muted">(inactive)</span>}
              </Td>
              <Td>
                {u.role ? (
                  <span className="inline-flex rounded-full bg-canvas px-2 py-0.5 text-xs text-muted">
                    {ROLE_LABEL[u.role]}
                  </span>
                ) : (
                  <span className="inline-flex rounded-full bg-warning-soft px-2 py-0.5 text-xs text-warning-ink">
                    no role — cannot do anything
                  </span>
                )}
              </Td>
              <NumTd className="text-muted">{u.storeScopeCount}</NumTd>
              <NumTd className="text-muted">{u.activeGrantCount}</NumTd>
              <td data-card-action="" className="border-t border-surface-border px-3 py-2 text-right">
                <RowLink href={`/admin/users/${u.id}`}>Manage</RowLink>
              </td>
            </LinkRow>
          ))}
        </tbody>
      </Table>

      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        Only a super-admin can appoint an admin. Nobody can change their own role, and the
        organisation&rsquo;s last admin cannot be demoted.
      </p>
    </Page>
  );
}

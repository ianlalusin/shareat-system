import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { heldCapabilities, type Capability } from '@shareat/auth';
import { withOrgPrincipal } from '../expenses/lib';
import { requirePageAccess } from '../../lib/page-access';
import { navHrefAllowed } from '../../lib/route-capability';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';

export const metadata = { title: 'Settings — Shareat System' };
// Reads the session cookie, so it can never be statically rendered — declared rather than left to
// be inferred, matching `/settings/attendance`.
export const dynamic = 'force-dynamic';

/**
 * `/settings` — the one door to every business setting. T-229 slice 1, regrouped by T-587 S1.
 *
 * ⭐ **Four sections, one bordered panel each, ROWS not cards** (T-587, Ian 15 Nov 2026). A row is a label, one
 * line saying what changes there, an optional "Also called" for a renamed screen, and a chevron; the whole row is
 * the link. A hub is navigation, so it is not a grid of cards (cards are records with actions, T-582/T-583).
 * The sentence stays one line on purpose: v1's hub (`ERP-rebuild/src/app/manager/settings/page.tsx:21-88`) is right
 * that a specific sentence beats a category word, and wrong that it must be a paragraph.
 *
 * ⭐ **Role-aware: a row the signed-in person may not open is not rendered, and a section with no rows is not
 * rendered** (hide, not tease). The test is `navHrefAllowed` over `ROUTE_CAPABILITY` — the very map the sidebar
 * filters by (`AppShell`) and `requirePageAccess` refuses by — so the hub, the sidebar and the page gate cannot
 * drift (T-288; DEF-310's shape). ⛔ Hiding is presentation, never the control: each screen still gates its own
 * read, and every write still runs `authorize()`. A route with NO key in that map (`/menu/usage-source`,
 * `/expenses/recurring`) shows to everyone who reaches the hub.
 *
 * ⭐ **"View only" (T-587 S2).** A row the person can open but not change wears a small "View only" word pill. Each row
 * declares `writeCap`: the capability (or list, ANY one enough) its save action really authorizes, read from the action and
 * not assumed. It is the one new datum, and `tests/t587-s2-view-only.test.ts` reads each screen's source to prove the word is
 * still the one authorized there. Where a route's read key IS its write key the pill can never show (a person without it never
 * sees the row), which is correct, not a gap.
 *
 * ⚠️ **Three rows are cross-links to screens that live elsewhere and stay there.** Positions in particular:
 * `/staff` already creates them, and moving that form here would be reinventing *towards* v1's layout.
 *
 * ⛔ **Every `href` below is a LITERAL at the call site, and it must stay that way.** The obvious shape for a hub —
 * one array mapped to `<a href={row.href}>` — is **invisible to `tests/unit/nav-route-reachability.test.ts`**, whose
 * `LINK` regex deliberately trusts only a literal (`href=` + a quote + a path): `requireActor('/staff/hire')` and
 * `revalidatePath('/expenses')` both name paths and neither puts a control on a screen, so the guard refuses to
 * infer. Mapping an array made this hub's own children read as orphans and failed the build, correctly by the
 * guard's contract though the runtime links were real. So do not "tidy" these into a data table. `Section` reads
 * each row's `href` prop to decide whether to show it, which keeps the literal in the markup AND the filter.
 */
export default async function SettingsPage() {
  const { actor, refusal } = await requirePageAccess('/settings');
  // ⭐ T-288 — the READ gate. Ian, 2026-09-12: "do both hide the menu and gate the reads."
  if (refusal) return refusal;
  // ⛔ Principalled, like `AppShell`: `heldCapabilities` reads org-scoped rows (T-231).
  const held = await withOrgPrincipal(actor.orgId, (tx) => heldCapabilities(tx, actor));

  return (
    <Page density="table">
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <PageDescription>
          Everything you set up for your stores, your company and your team. Changes apply to what is
          recorded from now on; past records stay as they are.
        </PageDescription>
      </div>

      {/* ⚠️ One column first and no `min-w` anywhere: DEF-199 measured 24 of 66 routes scrolling sideways at 390px.
          Phone portrait is the canvas; two columns only from `lg`, flowed as CSS columns (not a row grid) so a short
          panel never leaves a hole beside a tall one. */}
      <div className="lg:columns-2 lg:gap-4">
        <Section title="This store" held={held}>
          <SettingsRow href="/menu/hours" title="Menu hours" hint="The lunch and dinner hours a menu price can follow." writeCap="manage_store_settings" />
          <SettingsRow href="/kitchen" title="Kitchen stations" also="Kitchen setup" hint="Which kitchen station cooks each item." writeCap="manage_store_settings" />
          <SettingsRow
            href="/settings/sales-channels"
            title="Sales channels (walk-in, Grab, Foodpanda)"
            hint="Whether a channel’s money arrives that day or waits for the platform to pay."
            writeCap="manage_store_settings"
          />
          <SettingsRow href="/settings/wastage-monitor" title="Wastage Monitor" hint="Who answers for a wasted or refunded order at each store." writeCap="manage_store_settings" />
          <SettingsRow href="/settings/attendance" title="Attendance & payroll" hint="Shift hours, late policy, overtime, holiday pay and the pay period." writeCap="manage_store_settings" />
          <SettingsRow href="/budgets" title="Spending limits" also="Budgets, Expense budgets" hint="A spending cap per category, store and period." writeCap="manage_expense_budgets" />
          <SettingsRow href="/expenses/recurring" title="Recurring bills" hint="Bills that repeat, kept as templates." writeCap="manage_recurring_expenses" />
          <SettingsRow href="/staff?view=positions" title="Store positions" hint="The jobs this store’s people hold, set up on the Staff screen." writeCap="manage_store_settings" />
        </Section>

        <Section title="Company" held={held}>
          <SettingsRow href="/settings/organization" title="Organisation" hint="The registered name, TIN and tax type the books are kept under." writeCap="manage_chart_of_accounts" />
          <SettingsRow href="/settings/expense-categories" title="Expense categories" hint="Which account each kind of spend debits." writeCap="manage_chart_of_accounts" />
          <SettingsRow href="/settings/business-rules" title="Business rules" hint="Payout tolerance, loan rounding, and the withholding and VAT rates." writeCap="manage_business_rules" />
          <SettingsRow href="/payroll/rates" title="Payroll rates" hint="SSS, PhilHealth, Pag-IBIG and tax tables, and minimum wages." writeCap="manage_payroll_rates" />
          <SettingsRow href="/settings/usage-tolerance" title="Usage tolerance" hint="How far recorded stock usage may stray from what POS sales imply." writeCap="set_menu_depletion" />
          <SettingsRow href="/menu/usage-source" title="Usage source" hint="Whether daily stock usage comes from POS item maps or menu stock rules." writeCap={['switch_usage_source', 'manage_pos_map']} />
          <SettingsRow href="/admin/stores" title="Stores" hint="Open or close a store and set how it organises stock." writeCap="manage_stores" />
        </Section>

        <Section title="People and access" held={held}>
          <SettingsRow href="/admin/users" title="Users and roles" hint="Who can sign in, their role, their stores and their extra rights." writeCap="manage_users" />
          <SettingsRow href="/admin/access-defaults" title="Position access defaults" hint="What each position can do, store by store." writeCap="grant_capability" />
        </Section>

        <Section title="Devices and connections" held={held}>
          <SettingsRow
            href="/settings/pos-tablet"
            title="POS tablets and cash registers"
            hint="Make this browser the store’s tablet, or cut off a lost one. Also sets each cash register’s tablet and printer."
            writeCap="pair_pos_tablet"
          />
          <SettingsRow href="/attendance/terminals" title="Clock terminals" hint="Register a clock terminal and enrol cards or fingerprints." writeCap="provision_clock_terminal" />
          <SettingsRow href="/attendance/lane" title="Failed clock punches" also="Clock lane" hint="Punches that did not post, waiting for a manager to look." writeCap={['manage_attendance', 'provision_clock_terminal']} />
          <SettingsRow href="/settings/pos-link" title="Link to POS store" also="POS link" hint="Which POS store each store sells under." writeCap="manage_chart_of_accounts" />
        </Section>
      </div>

      {/* ⭐ Named rather than silently absent — the pattern `/expenses/recurring` set when its job was blocked. The reason it is not a form yet:
          four different things put a staff member into debt and none of them checks a limit, so a box here would look like a control without being
          one. UI UX (T-587): that reasoning is for developers, so managers read one plain line. */}
      <p className="text-sm text-neutral-600 dark:text-neutral-400">Staff advance limits: not set up yet.</p>
    </Page>
  );
}

/** One bordered panel. Renders only the rows the person may open; renders nothing when none remain. */
function Section({ title, held, children }: { title: string; held: ReadonlySet<string>; children: ReactNode }) {
  const rows = Children.toArray(children).filter(
    (c): c is ReactElement<RowProps> => isValidElement<RowProps>(c) && navHrefAllowed(c.props.href.split('?')[0]!, held),
  );
  if (rows.length === 0) return null;
  return (
    <section className="mb-4 break-inside-avoid overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-800">
      <h2 className="border-b border-neutral-200 px-4 py-3 text-base font-semibold dark:border-neutral-800">{title}</h2>
      <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
        {rows.map((r) => (
          <li key={r.props.href}>{cloneElement(r, { viewOnly: viewOnly(r.props.writeCap, held) })}</li>
        ))}
      </ul>
    </section>
  );
}

type RowProps = { href: string; title: string; hint: string; also?: string; writeCap: Capability | readonly Capability[]; viewOnly?: boolean };

/** Read but not change: the person holds none of the capabilities the screen's save action authorizes. A list means ANY one is enough. */
function viewOnly(writeCap: RowProps['writeCap'], held: ReadonlySet<string>): boolean {
  return ![writeCap].flat().some((c) => held.has(c));
}

/**
 * One row: the whole row is the link. ⚠️ `href` is a variable HERE by necessity — the guard reads the **call
 * sites** above, which are literal, and that is the honest arrangement: the literal a reader sees in the markup
 * is the href that actually renders.
 */
function SettingsRow({ href, title, hint, also, viewOnly }: RowProps) {
  return (
    <a
      href={href}
      className="flex min-h-11 items-center gap-3 px-4 py-2.5 transition-colors hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink dark:hover:bg-neutral-900"
    >
      <span className="min-w-0 flex-1">
        <span className="block font-medium">
          {title}
          {viewOnly && (
            <span className="ml-2 inline-block rounded-full border border-neutral-300 px-2 py-0.5 align-middle text-xs font-normal text-neutral-700 dark:border-neutral-600 dark:text-neutral-300">View only</span>
          )}
        </span>
        <span className="block text-sm text-neutral-600 dark:text-neutral-400">{hint}</span>
        {also && <span className="block text-xs text-neutral-600 dark:text-neutral-400">{`Also called: ${also}`}</span>}
      </span>
      <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 shrink-0 text-neutral-500">
        <path d="M7 5l5 5-5 5" />
      </svg>
    </a>
  );
}

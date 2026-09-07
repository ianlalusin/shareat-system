import { requireSession } from '../../lib/session';

export const metadata = { title: 'Settings — Shareat System' };
// Reads the session cookie, so it can never be statically rendered — declared rather than left to
// be inferred, matching `/settings/attendance`.
export const dynamic = 'force-dynamic';

/**
 * `/settings` — the shelf. T-229 slice 1.
 *
 * ⭐ **This route is DEF-192's deferred half, and the deferral's own condition is what triggered
 * it.** T-227 dropped the `/settings` nav entry rather than building a hub, and said why: *"A hub
 * page listing exactly one child is a screen that exists to satisfy a link; when a second settings
 * surface lands, a hub earns its place."* Expense categories is that second surface.
 *
 * ⭐ **Every card carries a sentence saying what changes there, not a category label.** That is
 * duplicated deliberately from v1's own settings hub
 * (`ERP-rebuild/src/app/manager/settings/page.tsx:21-88`), whose descriptions are specific enough
 * to navigate by without opening each child — the one thing that hub gets unambiguously right.
 * The shadcn `Card` it renders them in is NOT duplicated; this is v2's house style (§1.2c:
 * familiar, upgraded, not copied).
 *
 * ⚠️ **Three of these cards are cross-links to screens that live elsewhere and stay there.**
 * Positions in particular: `/staff` already creates them, and moving that form here would be
 * reinventing *towards* v1's layout, where creating a position and assigning one were two screens
 * and two navigations. The shelf points at it instead.
 *
 * ⚠️ No per-card capability gating. `manage_chart_of_accounts` is admin-only and the server
 * refuses a manager at the write; hiding a link is presentation, and presentation is not a control
 * (DEF-051, and `nav.tsx`'s own note on `/admin/users`).
 *
 * ⛔ **Every `href` below is a LITERAL at the call site, and it must stay that way.** The obvious
 * shape for a hub — one `CARDS` array mapped to `<a href={card.href}>` — was written first and is
 * **invisible to `tests/unit/nav-route-reachability.test.ts`**, whose `LINK` regex deliberately
 * trusts only a literal (`href=` + a quote + a path). Its own comment says why: *"A bare string
 * that happens to look like a path is not a link"* — `requireActor('/staff/hire')` and
 * `revalidatePath('/expenses')` both name paths and neither puts a control on a screen, so the
 * guard refuses to infer. Mapping the array made this hub's two OWN children read as orphans and
 * failed the build, correctly by the guard's contract even though the runtime links were real.
 *
 * ⚠️ So do not "tidy" these back into a data table. `nav.tsx` can be one, because the guard has a
 * second matcher (`href:` in its `GROUPS` literal) written specifically for it; a page has no such
 * exemption, and the failure is silent at runtime — the links work, the build goes red later, and
 * the reason is three files away.
 */
export default async function SettingsPage() {
  await requireSession('/settings');

  return (
    <main className="mx-auto max-w-4xl space-y-6 p-4 sm:p-8">
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="max-w-2xl text-sm text-neutral-600 dark:text-neutral-400">
          The reference data the rest of the system reads. Changing something here changes what
          every screen can record against — it does not change anything already recorded.
        </p>
      </div>

      {/* ⚠️ `grid-cols-1` first and no `min-w` anywhere: DEF-199 measured 24 of 66 routes
          scrolling sideways at 390px, and a card grid is exactly where a fixed width creeps in.
          Phone portrait is the canvas. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {/* The two this shelf OWNS. */}
        <SettingsCard
          href="/settings/expense-categories"
          title="Expense categories"
          description="Which account each kind of spend debits. A category with no account mapped blocks posting rather than guessing, so an unmapped one holds up every draft in it."
        />
        <SettingsCard
          href="/settings/sales-channels"
          title="Sales channels"
          description="How each branch sells — walk-in and the delivery platforms. Sets whether a channel’s money reaches the till that day or is owed to us until the platform settles, and whether a wasted order through it gets reviewed or is decided on the spot."
        />
        <SettingsCard
          href="/settings/wastage-monitor"
          title="Wastage Monitor"
          description="Who answers for a wasted or refunded order at each branch. With nobody named, a reviewed wastage is created ownerless and the store absorbs it after 15 days — silently, and nothing is recovered."
        />
        <SettingsCard
          href="/settings/attendance"
          title="Attendance & payroll"
          description="Shift hours and allowed start times, late policy, night differential and overtime, holiday multipliers, and the pay period — effective from a chosen day, never rewriting a day already computed."
        />

        {/* Cross-links: these live under their own nav entries and stay there. Listed for
            discoverability, because somebody looking for "where do I add a position" looks in
            Settings first — v1 put it there. */}
        <SettingsCard
          href="/staff"
          title="Store positions"
          description="The jobs this store’s people hold. The canonical six belong to the organisation; a store adds its own beyond them, on the Staff screen where they are assigned."
          elsewhere
        />
        <SettingsCard
          href="/admin/stores"
          title="Stores"
          description="Open or close a branch, set how it organises stock, and check what a new store still needs before anyone can trade in it."
          elsewhere
        />
        <SettingsCard
          href="/budgets"
          title="Expense budgets"
          description="A spending cap per category, per store, per period — and what is left of it, shown at the moment somebody is about to spend."
          elsewhere
        />
      </div>

      <div className="rounded-lg border border-dashed border-neutral-300 p-4 text-sm text-neutral-600 dark:border-neutral-700 dark:text-neutral-400">
        <p className="font-medium text-neutral-800 dark:text-neutral-200">Not here yet</p>
        {/* ⭐ Named rather than silently absent — the pattern `/expenses/recurring` set when its
            job was blocked: a feature that quietly does nothing is the defect class this project
            keeps hitting; one that says it does nothing YET is a plan with a visible next step. */}
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>
            <strong>The staff-advance ceiling.</strong> Deliberately not a form yet: four different
            things put a staff member into debt and none of them checks a limit, so a box here
            would look like a control without being one.
          </li>
          <li>
            <strong>Business name, TIN and registered address.</strong> Not editable anywhere yet —
            the fields do not exist in this system.
          </li>
        </ul>
      </div>
    </main>
  );
}

/**
 * One card. ⚠️ The `href` prop is a variable HERE by necessity — the guard reads the **call sites**
 * above, which are literal, and that is the honest arrangement: the literal a reader sees in the
 * markup is the href that actually renders.
 */
function SettingsCard({
  href,
  title,
  description,
  elsewhere,
}: {
  href: string;
  title: string;
  description: string;
  /** Lives under another route group; shown with its path so the jump is not a surprise. */
  elsewhere?: boolean;
}) {
  return (
    <a
      href={href}
      className="block rounded-lg border border-neutral-200 p-4 transition-colors hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900"
    >
      <p className="font-medium">
        {title}
        {elsewhere && (
          <span className="ml-2 align-middle text-[11px] font-normal text-neutral-400 dark:text-neutral-500">
            {href}
          </span>
        )}
      </p>
      <p className="mt-1 text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
        {description}
      </p>
    </a>
  );
}

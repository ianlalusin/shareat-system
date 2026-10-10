import { redirect } from 'next/navigation';
import { currentSession, readSetupIdentity } from '../../lib/session';
import { createFirstRunAction } from './actions';
import { setupView, systemIsAlreadySetUp } from './lib';
import { SubmitButton } from './SubmitButton';
import { FlashBanner, Input } from '@/components/ui';

export const metadata = { title: 'Set up Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  error?: string;
}

/** ⚠️ Ratified wording — §2.4 and §2.5. Kept identical to `actions.ts`' copy on purpose: the page
 *  and the action refuse independently, and a person who hits both must not see two sentences for
 *  one situation. */
const WINDOW_CLOSED = 'Your setup window has closed. Sign in again to continue.';
const ALREADY_SET_UP = 'This system is already set up.';

const LABEL = 'text-xs font-medium text-neutral-500 dark:text-neutral-400';

/**
 * `/setup` — **the first-run screen.** T-232 slice 2, `docs/tasks/232-…md` §2.5.
 *
 * ⭐ **What it is for.** Ian signs in on production with the email and password he uses in v1, and
 * the system he lands in has no organisation yet. Until this screen existed, the only thing that
 * could create one was `npm run bootstrap-org` on the droplet — so the very first thing a new
 * deployment asked of its owner was an SSH session.
 *
 * ## The three conditions, in this order
 *
 * 1. **Already signed in** → `/`. Setup is not a page you revisit.
 * 2. **No verified setup identity** → back to sign-in. Absent, expired, malformed and tampered are
 *    one answer, because they need one action (§2.4).
 * 3. **An organisation already exists** → back to sign-in. First run happens once, ever.
 *
 * ⛔ **All three are presentation.** Hiding a screen is not a control (DEF-051): the gate that
 * matters is `createFirstRunAction`'s own `readSetupIdentity()`, and under it
 * `bootstrapOrganization`'s advisory lock and zero-organization refusal, which hold whether this
 * page renders or not.
 *
 * ## ⚠️ Ian types his own PIN, and it is never echoed back
 *
 * A deviation from decision 4 ("printed once on the success screen, the same rule as the CLI"),
 * raised in the spec and approved. The CLI prints because the CLI *generates*; a screen can simply
 * ask. Echoing a live credential into an HTML response puts it in the browser's cache, its
 * back-button history and any screenshot — and carrying it to a success page would need either a
 * credential in a URL (⛔ never) or a client-state pattern this app uses nowhere. A mistyped PIN is
 * recoverable from `/staff`; a leaked one is not.
 */
export default async function SetupPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;

  if (await currentSession()) redirect('/');

  const identity = await readSetupIdentity();
  if (!identity) redirect(`/sign-in?error=${encodeURIComponent(WINDOW_CLOSED)}`);

  if (await systemIsAlreadySetUp()) {
    redirect(`/sign-in?error=${encodeURIComponent(ALREADY_SET_UP)}`);
  }

  const view = setupView(identity);

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center p-6 sm:p-8">
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">Set up Shareat System</h1>
          <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
            Nothing exists here yet. This creates your organisation, your first store and your own
            account — all at once, or not at all.
          </p>
        </div>

        <FlashBanner flash={sp} />

        {/* ⭐ Shown so Ian can see WHICH account is about to become the owner — the uid behind it
            is what will sign him in from now on, and it is not something he can change here. */}
        <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-4 text-sm dark:border-neutral-800 dark:bg-neutral-900">
          <span className={LABEL}>Signing in as</span>
          <p className="mt-1 font-medium">{view.email ?? 'this verified account'}</p>
          <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
            This account becomes the organisation&rsquo;s owner. It cannot be changed here.
          </p>
        </div>

        <form action={createFirstRunAction} className="space-y-4 text-sm">
          <label className="flex flex-col gap-1">
            <span className={LABEL}>Organisation code</span>
            <Input name="code" required autoComplete="off" placeholder="SHAREAT_OPC" className="w-full" />
            <span className="text-xs text-neutral-500 dark:text-neutral-400">
              Short, unique and permanent — it is the stable handle for this business.
            </span>
          </label>

          <label className="flex flex-col gap-1">
            <span className={LABEL}>Organisation name</span>
            <Input name="name" required autoComplete="off" placeholder="SHAREAT OPC" className="w-full" />
          </label>

          <label className="flex flex-col gap-1">
            <span className={LABEL}>Your name</span>
            <Input
              name="adminDisplayName"
              required
              autoComplete="name"
              defaultValue={view.suggestedName}
              className="w-full"
            />
            <span className="text-xs text-neutral-500 dark:text-neutral-400">
              Your real name. Every entry in the books is attributed to it, so it is not a login
              label.
            </span>
          </label>

          <label className="flex flex-col gap-1">
            <span className={LABEL}>First store code</span>
            <Input name="storeCode" required autoComplete="off" placeholder="LIPA" className="w-full" />
          </label>

          <label className="flex flex-col gap-1">
            <span className={LABEL}>First store name</span>
            <Input
              name="storeName"
              required
              autoComplete="off"
              placeholder="SharEat Lipa"
              className="w-full"
            />
            <span className="text-xs text-neutral-500 dark:text-neutral-400">
              You can add the rest from Stores once you are in.
            </span>
          </label>

          <label className="flex flex-col gap-1">
            <span className={LABEL}>Your 6-digit PIN</span>
            <input
              name="pin"
              type="password"
              inputMode="numeric"
              pattern="[0-9]{6}"
              autoComplete="new-password"
              required
              maxLength={6}
              placeholder="••••••"
              // Touch-first, and copied from `sign-in/page.tsx:79-90` on purpose: this is the same
              // credential, typed on the same tablet, and it should not look like a different one.
              className="rounded-[10px] border border-field-border bg-field px-3 py-3 text-center text-2xl tracking-[0.5em] tabular-nums text-ink"
            />
            <span className="text-xs text-neutral-500 dark:text-neutral-400">
              Choose it now — this is what signs you in at the store terminal. It is never shown
              back to you, and you can change it later from Staff.
            </span>
          </label>

          {/* ⛔ Disables itself on submit. First run takes a second or two, and a second click
              would land the "already set up" refusal on a screen the person is still filling in —
              which reads like a failure when it was a success. See SubmitButton.tsx. */}
          <SubmitButton pendingLabel="Creating…">Create the organisation</SubmitButton>
        </form>

        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          This screen works once. After it, people are added from Users and stores from Stores.
        </p>
      </div>
    </main>
  );
}

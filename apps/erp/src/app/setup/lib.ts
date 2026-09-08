/**
 * Server-only reads for `/setup` — T-232 slice 2 §2.5. **No writes live here.**
 *
 * ⚠️ **The zero-organization read runs in a PLAIN transaction, with no principal, and that is
 * deliberate** (§2.3.2). There is no principal to apply: the whole precondition is that no
 * organisation, and therefore no person and no session, exists yet. `bootstrapOrganization` opens
 * the same kind of transaction on the same `DATABASE_URL`, so the screen inherits the CLI's
 * database posture exactly — if `npm run bootstrap-org` can write on production, `/setup` can, and
 * if it cannot, neither can.
 *
 * ⛔ **This read is presentation, not the control.** The page uses it to say a sentence Ian can
 * act on; what actually closes first-run setup forever is `bootstrapOrganization` taking an
 * advisory lock and refusing once an organization exists. Same posture as `createOrganization`'s
 * duplicate-code pre-check: *"the UNIQUE constraint remains the actual guarantee."*
 */
import { transaction, organizationsRepo } from '@shareat/db';
import { AuthenticationError, AuthorizationError } from '@shareat/auth';
import type { SetupIdentity } from '../../lib/session';
import { CONSTRAINT_MESSAGES } from '../../lib/constraint-messages';

/**
 * Whether this system has been set up at all.
 *
 * ⚠️ Returns a **boolean**, never organisation rows — the narrow shape DEF-214's ruling permits
 * (`apps/erp/src/app/expenses/lib.ts:62-66`: a cross-org read comes back only as *"an explicit
 * system-principal read WITH a caller"*). It cannot decay into a cross-org listing by a later
 * "small" change, because there is nothing in it to widen.
 */
export async function systemIsAlreadySetUp(): Promise<boolean> {
  return transaction((tx) => organizationsRepo.anyOrganizationExists(tx));
}

/** What the form renders. The uid is deliberately absent — the page never shows it and the action
 *  reads it from the cookie, never from the round trip. */
export interface SetupView {
  /** Shown read-only, so Ian can see WHICH account is about to become the owner. */
  readonly email: string | null;
  /**
   * Prefilled into the editable "your name" field.
   *
   * ⚠️ Editable on purpose: this becomes `persons.display_name`, which is what the ledger
   * attributes the organisation's first entries to. A Firebase display name is a login label and
   * is often absent, initials, or an email local-part; the ledger needs a real name.
   */
  readonly suggestedName: string;
}

export function setupView(identity: SetupIdentity): SetupView {
  return {
    email: identity.email,
    suggestedName: identity.displayName ?? identity.email ?? '',
  };
}

/**
 * ⭐ **Where a failed first run sends you — and the answer changes the instant the transaction
 * commits.** Pure, so it can be executed by a test; the action around it cannot without a Next
 * runtime, and a rule verifiable only by reading is the one that regresses.
 *
 * ⛔ **The bug it exists to prevent** (lane C's review, 2026-09-08). `/setup`'s action clears the
 * setup cookie as soon as `bootstrapOrganization` commits. If the step after that — signing the new
 * owner in — then failed, redirecting to `/setup?error=…` was worse than useless: the page's own
 * `readSetupIdentity` finds no cookie and re-redirects to *"Your setup window has closed. Sign in
 * again to continue."* That **swallows the real error and states something false** — the window has
 * not closed, and the organisation exists.
 *
 * ⚠️ The two answers are not two phrasings of one thing; they are two different situations:
 *
 * | | What is true | Where to send him |
 * |---|---|---|
 * | Before the commit | Nothing was written. The cookie is still valid | `/setup`, with the reason. He fixes the field and re-submits |
 * | After the commit | The organisation, his person and his credential all exist | `/sign-in`, with the reason **and** the news. The email form signs him in |
 */
export function setupFailureRedirect(organisationCreated: boolean, reason: string): string {
  if (!organisationCreated) {
    return `/setup?error=${encodeURIComponent(reason)}`;
  }
  // ⭐ All three parts earn their place: what happened, why, and what to do. Dropping the first
  // makes him retry something already done; dropping the second hides the cause; dropping the
  // third leaves him on a sign-in page with no reason to believe it will work.
  const message =
    `Your organisation was created, but signing you in failed: ${endWithStop(reason)} ` +
    'Sign in with your email to continue.';
  return `/sign-in?error=${encodeURIComponent(message)}`;
}

/** A domain message usually ends in a full stop; a raw driver message often does not. Without this
 *  the two sentences run together. */
function endWithStop(reason: string): string {
  const trimmed = reason.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** Every sentence `constraint-messages.ts` is willing to show a person. A message that IS one of
 *  these was written for this purpose and is safe wherever it appears. */
const WRITTEN_FOR_A_PERSON: ReadonlySet<string> = new Set(Object.values(CONSTRAINT_MESSAGES));

/**
 * ⛔ **Is this a raw infrastructure failure that must not be shown to an unauthenticated
 * visitor?** `/setup` is reached with no session at all, and its refusals travel **in the URL** —
 * so a bare driver error would put a table name, a column, or a connection detail into a query
 * string, a browser history and any proxy log, for someone who has proved nothing but that they
 * hold a Firebase account.
 *
 * ⚠️ **It masks narrowly, and the narrowness is the point.** Three kinds of message are written
 * for a person and stay verbatim, because replacing them would make the screen useless:
 *
 * | Kept | Example |
 * |---|---|
 * | `AuthenticationError` / `AuthorizationError` | the ratified refusals |
 * | A mapped constraint sentence | *"A channel that settles later needs a receivable account…"* |
 * | `bootstrapOrganization`'s own plain-`Error` sentences | *"the PIN must be exactly 6 digits."* |
 *
 * What is left is the case this exists for: an error carrying a **five-character Postgres code**
 * (`23505`, `42P01`, `08006`) that no constraint sentence matched, so `errorMessage` handed back
 * the driver's own words. ⭐ The same posture, and the same production gate, as `/sign-in`'s
 * `emailSignInMessage` and `api/health/route.ts` — *"this endpoint is unauthenticated; in
 * production it must not describe which variables are unset."*
 *
 * ⚠️ Pure, so both branches are executed by a test. The LOGGING and the `NODE_ENV` decision belong
 * to the action; this only answers the question.
 */
export function isUnmappedInfrastructureError(err: unknown, message: string): boolean {
  if (err instanceof AuthenticationError || err instanceof AuthorizationError) return false;
  if (WRITTEN_FOR_A_PERSON.has(message)) return false;

  // postgres.js puts SQLSTATE on `code`; it is always five characters. A domain `Error` has none,
  // which is what makes this a discriminator rather than a guess.
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.length === 5;
}

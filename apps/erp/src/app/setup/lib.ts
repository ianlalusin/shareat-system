/**
 * Server-only reads for `/setup` — T-232 slice 2 §2.5. **No writes live here.**
 *
 * ⭐ **The zero-organization read runs through `systemTransaction()`, T-267, per Ian's ruling of
 * 2026-09-12** (bible §13 row 194 addendum). There is no principal to apply: the whole
 * precondition is that no organisation, and therefore no person and no session, exists yet.
 * `bootstrapOrganization` opens the same bootstrap door for its write, so the screen inherits its
 * database posture exactly — if `npm run bootstrap-org` can write on production, `/setup` can, and
 * if it cannot, neither can.
 *
 * ⛔ **This read is presentation, not the control.** The page uses it to say a sentence Ian can
 * act on; what actually closes first-run setup forever is `bootstrapOrganization` taking an
 * advisory lock and refusing once an organization exists. Same posture as `createOrganization`'s
 * duplicate-code pre-check: *"the UNIQUE constraint remains the actual guarantee."*
 */
import { systemTransaction, organizationsRepo } from '@shareat/db';
import type { SetupIdentity } from '../../lib/session';

/**
 * Whether this system has been set up at all.
 *
 * ⚠️ Returns a **boolean**, never organisation rows — the narrow shape DEF-214's ruling permits
 * (`apps/erp/src/app/expenses/lib.ts:62-66`: a cross-org read comes back only as *"an explicit
 * system-principal read WITH a caller"*). It cannot decay into a cross-org listing by a later
 * "small" change, because there is nothing in it to widen.
 */
export async function systemIsAlreadySetUp(): Promise<boolean> {
  return systemTransaction((tx) => organizationsRepo.anyOrganizationExists(tx));
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

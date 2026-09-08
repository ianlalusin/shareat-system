'use server';

/**
 * `/setup`'s write — T-232 slice 2 §2.5. **The first-run transaction, and the only one there
 * will ever be.**
 *
 * ## ⭐ The uid comes from the cookie, never from the form
 *
 * `bootstrapOrganization` links a `firebase` credential to the uid it is handed, and that
 * credential is what signs Ian in forever after. A uid read from a form field would let the
 * browser name whose account owns the organisation — invariant 5, and the exact shape
 * `tests/unit/no-client-supplied-actor.test.ts` holds closed repo-wide. Everything else on the
 * form is data (a name, a code); the identity is not on the form at all.
 *
 * ## ⛔ This action is the CONTROL, not the page
 *
 * `page.tsx` re-checks the same two conditions, and that check is presentation: a screen hidden
 * without its write being gated is DEF-051. The gate that matters is `readSetupIdentity()` here,
 * plus `bootstrapOrganization`'s own advisory lock and zero-organization refusal, which close
 * first-run setup independently of anything this file does.
 *
 * ## ⚠️ A plain transaction, with no principal, inside a request handler
 *
 * Deliberate, and the one place in `apps/erp` it is true (§2.3.2). There is no principal to apply:
 * the precondition is that no organisation, no person and no session exists. It is the same
 * transaction `scripts/bootstrap-org.ts` opens on the same `DATABASE_URL`, which is the point of
 * sharing one function — the screen inherits the CLI's database posture exactly rather than
 * inventing a new one.
 */
import { redirect } from 'next/navigation';
import { transaction } from '@shareat/db';
import { bootstrapOrganization } from '@shareat/domain';
import { signInWithFirebase } from '@shareat/auth';
import {
  readSetupIdentity,
  clearSetupIdentityCookie,
  setSessionCookie,
} from '../../lib/session';
import { logger } from '@shareat/core/logger';
import { errorMessage } from '../../lib/constraint-messages';
import { isUnmappedInfrastructureError, setupFailureRedirect } from './lib';

/** ⚠️ Ratified wording — §2.4. Absent, expired, malformed and tampered all say this one thing,
 *  because they all need the same action from the person reading it. */
const WINDOW_CLOSED = 'Your setup window has closed. Sign in again to continue.';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * What a visitor is told when first-run setup fails.
 *
 * ⛔ **`/setup` is unauthenticated and its refusals travel in the URL**, so a raw driver error
 * would put a table name, a column or a connection host into a query string, a browser history and
 * any proxy log — shown to someone who has proved nothing but that they hold a Firebase account.
 * Same rule, same production gate, as `/sign-in`'s `emailSignInMessage` and
 * `api/health/route.ts`: *"this endpoint is unauthenticated; in production it must not describe
 * which variables are unset."*
 *
 * ⚠️ **It masks narrowly.** Everything written for a person survives verbatim — the ratified
 * refusals, every sentence `constraint-messages.ts` maps, and `bootstrapOrganization`'s own
 * ("the PIN must be exactly 6 digits", "…first-run setup is closed"). Masking those would leave
 * Ian on a screen that says "Setup failed" with no idea which of six fields is wrong.
 *
 * ⭐ The reason is logged either way, and named in full outside production.
 * `isUnmappedInfrastructureError` is pure and lives in `./lib` so both branches are executed by
 * `apps/erp/tests/setup-failure-redirect.test.ts`. DEF-222 will generalise this later.
 */
function setupErrorMessage(err: unknown): string {
  const message = errorMessage(err);
  if (!isUnmappedInfrastructureError(err, message)) return message;

  logger.error(
    { err: err instanceof Error ? err.message : String(err) },
    'first-run setup failed for a reason that is not a refusal written for a person',
  );
  if (process.env.NODE_ENV !== 'production') return message;
  return 'Setup failed. The reason is in the server log.';
}

export async function createFirstRunAction(formData: FormData): Promise<void> {
  // 1. THE control. Re-checked here rather than trusted from the page.
  const identity = await readSetupIdentity();
  if (!identity) {
    redirect(`/sign-in?error=${encodeURIComponent(WINDOW_CLOSED)}`);
  }

  // ⭐ The commit point. Everything before it can be retried on the same form; everything after it
  // happens in a world where the organisation exists, and a failure there must say so rather than
  // send him back to a screen that will refuse him. `setupFailureRedirect` holds that rule and is
  // executed by `apps/erp/tests/setup-failure-redirect.test.ts`.
  let organisationCreated = false;

  try {
    // 2. Everything — org, chart, categories, person, role, grants, store, room, store scope,
    //    PIN and the firebase credential — in ONE transaction, or none of it.
    await transaction((tx) =>
      bootstrapOrganization(tx, {
        code: str(formData, 'code'),
        name: str(formData, 'name'),
        adminDisplayName: str(formData, 'adminDisplayName'),
        storeCode: str(formData, 'storeCode'),
        storeName: str(formData, 'storeName'),
        // ⚠️ Trimmed like every other field, and nothing more. `isValidPinFormat` refuses anything
        // that is not exactly six digits — a five-digit or non-numeric value is a refusal before
        // a single row is written, never a silent pad or truncation.
        pin: str(formData, 'pin'),
        // ⭐ From the signed cookie `verifyIdToken` produced. Never from `formData`.
        firebaseUid: identity.uid,
      }),
    );

    organisationCreated = true;

    // 3. ⭐ The cookie goes only once the organisation really exists — SUCCESS path only.
    //
    //    ⚠️ §2.4 originally cleared it before the transaction; that was amended on 2026-09-08 for
    //    the reason §2.4 itself gives: *"the guarantee is the database, not the cookie."* A replay
    //    is refused by `bootstrapOrganization`'s advisory lock and zero-organization check whether
    //    this line ran before the write or after it, so clearing first bought nothing — and it
    //    cost the whole first-run window to a mistyped PIN, sending Ian back through Firebase
    //    sign-in for a typo. Failures now leave the cookie and he re-submits.
    await clearSetupIdentityCookie();

    // 4. A SECOND transaction, deliberately — it resolves the credential the first one wrote, so
    //    that credential has to really be committed. Passing `null` lets `signInWithFirebase`
    //    open its own.
    const session = await signInWithFirebase(null, { verifiedUid: identity.uid });
    await setSessionCookie(session.token, session.expiresAt);
  } catch (err) {
    // ⚠️ Two different situations, not two phrasings of one.
    //
    // BEFORE the commit: the transaction rolled back, the system is still un-set-up, and the setup
    // cookie is still valid — so this is a re-submit on the same form rather than a fresh sign-in.
    // When the 10-minute window does lapse, `readSetupIdentity` refuses on the next render.
    //
    // AFTER it: the organisation, his person and his `firebase` credential all exist and only the
    // sign-in failed. Sending him to `/setup` here would be actively wrong — the page would find
    // no cookie and answer "your setup window has closed", which is false and would bury the real
    // reason. He goes to `/sign-in`, told what happened, where his own credential now works.
    redirect(setupFailureRedirect(organisationCreated, setupErrorMessage(err)));
  }

  // ⚠️ OUTSIDE the try, because `redirect()` works by throwing: called inside, its NEXT_REDIRECT
  // would be caught above and rewritten into an error redirect. Same shape as `signInAction`.
  redirect('/');
}

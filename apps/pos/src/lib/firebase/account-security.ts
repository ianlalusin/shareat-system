
'use client';

import { auth } from '@/lib/firebase/client';
import { 
    EmailAuthProvider, 
    reauthenticateWithCredential,
    updatePassword,
    GoogleAuthProvider,
    linkWithPopup,
    linkWithRedirect,
    sendPasswordResetEmail
} from 'firebase/auth';

/**
 * Re-authenticates the user with their current password and then updates it.
 * @param currentPassword The user's current password.
 * @param newPassword The new password to set.
 */
export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
    const user = auth.currentUser;
    if (!user || !user.email) {
        throw new Error("No authenticated user found.");
    }

    const credential = EmailAuthProvider.credential(user.email, currentPassword);
    
    // Re-authenticate to prove identity
    await reauthenticateWithCredential(user, credential);

    // If re-authentication is successful, update the password
    await updatePassword(user, newPassword);
}

/**
 * Links the current user's account with Google.
 * Uses popup first, falls back to redirect only when popup is blocked/unsupported.
 */
export async function linkWithGoogle(): Promise<void> {
  const fbUser = auth.currentUser;
  if (!fbUser) throw new Error("No authenticated user found.");

  const provider = new GoogleAuthProvider();

  try {
    await linkWithPopup(fbUser, provider);
  } catch (error: any) {
    const code = error?.code ?? "";

    // Only fallback to redirect when popup cannot work in this environment
    if (
      code === "auth/popup-blocked" ||
      code === "auth/operation-not-supported-in-this-environment"
    ) {
      await linkWithRedirect(fbUser, provider);
      return;
    }

    // If user simply closed the popup, don't redirect
    if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") {
      return;
    }

    throw error;
  } finally {
    // Refresh providerData after linking (or even after popup close)
    await fbUser.reload().catch(() => {});
  }
}

/**
 * Sends a password reset email to the specified email address.
 * @param email The user's email address.
 */
export async function sendPasswordReset(email: string): Promise<void> {
    await sendPasswordResetEmail(auth, email);
}


'use client';

import { useAuthContext, AppUser } from '@/context/auth-context';
import { User as FirebaseUser } from "firebase/auth";
import Header from '@/components/layout/header';
import { useStoreContext } from '@/context/store-context';
import { useLocalProfile } from '@/context/local-profile-context';
import { bypassesLocalUserGate } from '@/lib/server-profiles/localGate';
import { ServerSignInGate } from '@/components/server/ServerSignInGate';
import { Loader2 } from 'lucide-react';

// This is a helper function to merge FirebaseUser and AppUser
function combineUser(
  firebaseUser: FirebaseUser | null,
  appUser: AppUser | null
): AppUser | null {
  if (!firebaseUser) return null;
  if (!appUser) {
      // If there's a Firebase user but no app user yet, it might be the initial moments
      // of sign-up or a loading state. We can create a partial user.
      return {
          uid: firebaseUser.uid,
          email: firebaseUser.email,
          displayName: firebaseUser.displayName,
          photoURL: firebaseUser.photoURL,
          username: firebaseUser.email ?? firebaseUser.uid,
          status: 'pending', // Assume pending until Firestore doc loads
      };
  }
  
  return {
    ...appUser,
    uid: firebaseUser.uid,
    email: appUser?.email ?? firebaseUser.email,
    displayName: firebaseUser.displayName || appUser?.displayName || appUser?.name,
    photoURL: firebaseUser.photoURL || appUser?.photoURL,
  };
}


export function AppLayout({ children }: { children: React.ReactNode }) {
    const { user, appUser } = useAuthContext();
    const { activeStore } = useStoreContext();
    const { currentProfile, isReady: localProfileReady } = useLocalProfile();
    const combinedUser = combineUser(user, appUser);

    // This component now *only* renders if the user is authenticated and active.
    // The decision to render it is made by FirstLoginGuard.
    if (!combinedUser) return null; // Or a loader, but the guard should handle loading state.

    // App-wide local-user gate: every role except admin/manager must be signed
    // into a local user account before using any page, so shared-account actions
    // are always attributed. Admins/managers are attributed by their own account.
    //
    // `localProfileReady` is critical: on a fresh mount/remount (e.g. opening a
    // logs session-audit deep link) the profile is rehydrated from localStorage
    // one tick after `activeStore` resolves. Without waiting for readiness, that
    // one render had activeStore set + currentProfile still null, which flashed
    // this sign-in gate at already-signed-in cashiers. Only gate once we've
    // actually read storage for the current store.
    const mustResolveLocalUser = !bypassesLocalUserGate(appUser) && !!activeStore;
    const needsLocalUser = mustResolveLocalUser && localProfileReady && !currentProfile;

    // Role-aware sign-in copy.
    const gateProps =
        appUser?.role === "cashier" ? { roleLabel: "cashier station" } :
        appUser?.role === "kitchen" ? { roleLabel: "kitchen display" } :
        appUser?.role === "server" ? { roleLabel: "server station" } :
        { title: "Sign in as a local user", description: "Pick your local user account to use this device. Your actions are recorded under your name." };

    return (
        <div className="flex min-h-screen w-full flex-col">
            <Header user={combinedUser as any} />
            <main className="flex flex-1 flex-col gap-4 p-4 md:gap-8 md:p-8 mt-14 min-w-0">
                {mustResolveLocalUser && !localProfileReady ? (
                    // Local-user status for this store is still resolving — show a
                    // brief loader rather than flashing the page or the sign-in gate.
                    <div className="flex flex-1 items-center justify-center">
                        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                    </div>
                ) : needsLocalUser ? (
                    <ServerSignInGate {...gateProps} />
                ) : (
                    children
                )}
            </main>
        </div>
    );
}

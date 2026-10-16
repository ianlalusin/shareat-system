
"use client";

import React, { createContext, useContext, useEffect, useMemo, useState, useCallback } from "react";
import { onAuthStateChanged, User as FirebaseUser, signOut as firebaseSignOut } from "firebase/auth";
import { doc, onSnapshot, FirestoreError } from "firebase/firestore";
import { auth, db } from "@/lib/firebase/client";
import { useRouter } from "next/navigation";

export type AppUser = {
  username: string;
  uid: string;
  email?: string | null;
  displayName?: string | null;
  photoURL?: string | null;
  role?: "admin" | "manager" | "cashier" | "kitchen" | "server";
  roles?: string[];
  status?: "active" | "pending" | "disabled" | "needs_profile";
  assignedStoreIds?: string[];
  name?: string;
  contactNumber?: string;
  address?: string;
  isPlatformAdmin?: boolean;
  /**
   * Set by an admin password reset. While true, RoleGuard routes every guarded
   * page to /change-password until the user sets their own password.
   */
  mustChangePassword?: boolean;
};

type AuthCtx = {
  user: FirebaseUser | null;
  appUser: AppUser | null;
  loading: boolean;
  authLoading: boolean;
  staffLoading: boolean;
  staffError: Error | null;
  isSigningOut: boolean;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthCtx | undefined>(undefined);

export function AuthContextProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [appUser, setAppUser] = useState<AppUser | null>(null);
  
  const [authLoading, setAuthLoading] = useState(true);
  const [staffLoading, setStaffLoading] = useState(false);
  const [staffError, setStaffError] = useState<Error | null>(null);
  const [isSigningOut, setIsSigningOut] = useState(false);

  useEffect(() => {
    let unsubStaff: (() => void) | null = null;

    const unsubAuth = onAuthStateChanged(auth, (u) => {
      unsubStaff?.();
      unsubStaff = null;
      setUser(u);
      setAppUser(null);
      setAuthLoading(false); // Firebase auth state is now resolved.
      setStaffError(null);
      
      if (!u) {
        setStaffLoading(false); // No user, so no staff profile to load.
        return;
      }
      
      // User is authenticated, now fetch their staff profile.
      setStaffLoading(true);

      const staffDocRef = doc(db, "staff", u.uid);
      unsubStaff = onSnapshot(
        staffDocRef,
        (snap) => {
          if (snap.exists()) {
            const data = snap.data();
            const isPlatformAdmin = data.role === 'admin';
            const baseAppUser: AppUser = {
              username: data.username ?? u.email ?? u.uid,
              uid: u.uid,
              email: u.email,
              displayName: u.displayName || data.name,
              photoURL: u.photoURL || data.photoURL,
              ...data,
              isPlatformAdmin,
            };
            setAppUser(baseAppUser);
          } else {
            // No staff doc for this uid. With offline persistence enabled, the
            // first snapshot can be a negative *cache* hit for a doc that does
            // exist on the server. Concluding "needs_profile" from that cached
            // miss bounced real users (including admins) to /signup, where the
            // profile-creation flow could overwrite and demote them. Wait for
            // the authoritative server snapshot before treating it as missing.
            if (snap.metadata.fromCache) {
              return; // stay in loading; the server emission will follow
            }
            // User exists in Firebase Auth, but no staff doc found.
            // This is the "needs_profile" state for new sign-ups.
            setAppUser({
              username: u.email ?? u.uid,
              uid: u.uid,
              email: u.email,
              displayName: u.displayName,
              photoURL: u.photoURL,
              status: "needs_profile",
              isPlatformAdmin: false,
            });
          }
          setStaffLoading(false); // Staff profile loaded successfully.
          setStaffError(null);
        },
        (error: FirestoreError) => {
          // If permission is denied, it usually means the doc is restricted 
          // or the rules aren't quite right for the user's current state.
          console.warn("AuthContext: Error listening to staff document:", error.code, error.message);
          setStaffLoading(false);
          setStaffError(error);
          setAppUser(null);
        }
      );
    });

    return () => {
      unsubStaff?.();
      unsubAuth();
    };
  }, []);

  const signOut = useCallback(async () => {
    setIsSigningOut(true);
    try {
      await firebaseSignOut(auth);
      router.push('/login');
    } catch (error) {
      console.error("Sign out failed", error);
    } finally {
      setIsSigningOut(false);
    }
  }, [router]);

  const loading = authLoading || (!!user && staffLoading);

  const value = useMemo(() => ({ 
    user, 
    appUser, 
    loading, 
    authLoading, 
    staffLoading, 
    staffError, 
    isSigningOut, 
    signOut 
  }), [user, appUser, loading, authLoading, staffLoading, staffError, isSigningOut, signOut]);
  
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuthContext() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuthContext must be used within AuthContextProvider");
  return ctx;
}

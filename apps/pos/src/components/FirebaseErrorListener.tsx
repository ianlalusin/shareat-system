'use client';

import { useState, useEffect } from 'react';
import { errorEmitter } from '@/firebase/error-emitter';
import { FirestorePermissionError } from '@/firebase/errors';
import { auth } from '@/lib/firebase/client';
import { onAuthStateChanged } from 'firebase/auth';

/**
 * An invisible component that listens for globally emitted 'permission-error' events.
 * It throws any received error to be caught by Next.js's global-error.tsx,
 * but intelligently suppresses errors that occur during the logout process.
 */
export function FirebaseErrorListener() {
  const [error, setError] = useState<FirestorePermissionError | null>(null);
  const [isUserAuthenticated, setIsUserAuthenticated] = useState(() => !!auth.currentUser);

  // This effect provides a reliable, non-racy view of the auth state.
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setIsUserAuthenticated(!!user);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    const handleError = (error: FirestorePermissionError) => {
      // Use our reliable state variable instead of the racy auth.currentUser
      if (isUserAuthenticated) {
        setError(error);
      } else {
        // Log a warning for debugging, but don't throw to the UI.
        console.warn("Suppressed Firestore permission error for unauthenticated/logging-out user.", {
            message: error.message
        });
      }
    };

    errorEmitter.on('permission-error', handleError);

    return () => {
      errorEmitter.off('permission-error', handleError);
    };
  }, [isUserAuthenticated]); // Depend on our reliable state

  // On re-render, if an error exists in state, throw it.
  if (error) {
    throw error;
  }

  // This component renders nothing.
  return null;
}

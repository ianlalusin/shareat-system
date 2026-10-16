'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { useToast } from '@/hooks/use-toast';

// Open Radix overlays: dialogs, sheets, alert-dialogs, and popper-based
// surfaces (popover / select / dropdown / command).
const OPEN_OVERLAY_SELECTOR =
  '[data-state="open"][role="dialog"],[data-state="open"][role="alertdialog"],[data-radix-popper-content-wrapper]';

/**
 * Hardware back-button handling for the Android (Capacitor) shell.
 *
 * Without a registered listener, Capacitor's default finishes the Activity (=
 * exits the app) whenever the WebView reports no history — which is most of the
 * time in this SPA, because modals/sheets and state-toggled views don't create
 * WebView history entries. Registering ANY backButton listener also suppresses
 * that native default, so we fully own the behaviour:
 *   1. An overlay is open  → close it (dispatch Escape).
 *   2. Else app can go back → router.back().
 *   3. Else at a root screen → require a second press within 2s to exit.
 *
 * No-op on web (only runs inside the native shell).
 */
export function AndroidBackHandler() {
  const router = useRouter();
  const { toast } = useToast();

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;

    let lastBackMs = 0;
    let removed = false;
    let handle: { remove: () => void } | null = null;

    App.addListener('backButton', () => {
      // 1) Close the top-most open overlay first.
      if (document.querySelector(OPEN_OVERLAY_SELECTOR)) {
        document.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }),
        );
        return;
      }

      // 2) Walk back through app history when there is somewhere to go.
      if (typeof window !== 'undefined' && window.history.length > 1) {
        router.back();
        return;
      }

      // 3) Root screen — confirm before exiting.
      const now = Date.now();
      if (now - lastBackMs < 2000) {
        App.exitApp();
      } else {
        lastBackMs = now;
        toast({ description: 'Press back again to exit.' });
      }
    }).then((h) => {
      if (removed) h.remove();
      else handle = h;
    });

    return () => {
      removed = true;
      handle?.remove();
    };
  }, [router, toast]);

  return null;
}

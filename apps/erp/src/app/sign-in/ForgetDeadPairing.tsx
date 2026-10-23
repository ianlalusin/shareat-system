'use client';

/**
 * T-464 - renders nothing. When the sign-in page finds that this browser's pairing cookie no longer names a live pairing (revoked,
 * unused for 30 days, forged), it mounts this once so the cookie is cleared and every later load is today's screen. A Server
 * Component cannot delete a cookie while rendering, so the delete is a server action.
 */
import { useEffect } from 'react';
import { forgetDeadPosTabletAction } from './actions';

export function ForgetDeadPairing() {
  useEffect(() => {
    void forgetDeadPosTabletAction();
  }, []);
  return null;
}

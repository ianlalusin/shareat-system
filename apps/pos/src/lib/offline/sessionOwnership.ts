"use client";

/**
 * Fields stamped on a session at creation for the offline conflict model
 * (spec §4.4): which device owns the session and a monotonic revision that
 * later payment/void writes increment. Pure so it is unit-testable.
 */
export function sessionOwnershipFields(
  deviceId: string,
  revision: number = 1,
): { ownerTerminalId: string; revision: number } {
  return { ownerTerminalId: deviceId, revision };
}

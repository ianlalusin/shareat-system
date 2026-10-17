import 'server-only';
/** T-424 - the manager-PIN step shared by the refund, correction and void handlers. Called only AFTER identity passes. */
import type { Pos2Deps } from './types';
import { fail, isNonBlank, isUuid } from './http';

export const DEVICE_ID_MISSING = 'This tablet has no device id. Open Settings on the tablet and try again.';

/** Validates the tablet device id and the PIN text, then asks the approval port. Returns the approver, or the response to send. */
export async function requireManagerApproval(
  deps: Pos2Deps,
  input: { storeId: string; deviceId: unknown; pin: unknown; terminalNo?: number },
): Promise<{ ok: true; approverPersonId: string } | { ok: false; response: Response }> {
  if (!isUuid(input.deviceId)) return { ok: false, response: fail(400, DEVICE_ID_MISSING) };
  if (!isNonBlank(input.pin)) return { ok: false, response: fail(400, 'Enter the store manager PIN.') };
  const result = await deps.approveManagerPin({ posStoreId: input.storeId, deviceId: input.deviceId, pin: input.pin });
  if (!result.ok) return { ok: false, response: fail(403, result.message) };
  if (input.terminalNo !== undefined && result.terminalNo !== undefined && input.terminalNo !== result.terminalNo) {
    return { ok: false, response: fail(400, "The terminal number does not match this tablet's registration. Check Settings.") };
  }
  return { ok: true, approverPersonId: result.approverPersonId };
}

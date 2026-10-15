/**
 * T-402 S3 (Ian's ruling on audit finding 6): free text a person typed, recorded in the audit log's `after`, is capped.
 * First 500 characters + a marker. Applies ONLY to the log copy; the source tables keep the full text.
 */
export const AUDIT_FREE_TEXT_MAX = 500;
export const AUDIT_TRUNCATED_MARK = '…[truncated]';

export function capAuditText(text: string): string;
export function capAuditText(text: string | null | undefined): string | null;
export function capAuditText(text: string | null | undefined): string | null {
  if (text === null || text === undefined) return null;
  // Cap in code points (characters as a person counts them), never splitting a surrogate pair.
  if (text.length <= AUDIT_FREE_TEXT_MAX) return text;
  const points = Array.from(text);
  return points.length > AUDIT_FREE_TEXT_MAX ? points.slice(0, AUDIT_FREE_TEXT_MAX).join('') + AUDIT_TRUNCATED_MARK : text;
}

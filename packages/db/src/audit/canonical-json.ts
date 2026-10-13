/**
 * T-402 S1b (R10) - canonical JSON for the offline-event hash: RFC 8785 (JCS) in the parts this log needs.
 * Keys sorted at every depth, no insignificant whitespace, numbers normalised (`1.0` is `1`, `-0` is `0`),
 * arrays keep their order. The same event with keys in another order hashes the same, so a replay is a replay
 * and never a conflict (Invariant 22b).
 *
 * Pure: no imports, so the catalogue and redaction unit tests run before any migration.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'null';
    return Object.is(value, -0) ? '0' : JSON.stringify(value);
  }
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const k of Object.keys(obj).sort()) {
      if (obj[k] === undefined) continue;
      parts.push(`${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
    }
    return `{${parts.join(',')}}`;
  }
  return 'null';
}

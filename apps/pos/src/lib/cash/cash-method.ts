/** Configured cash names cover custom drawers; the legacy fallback must not mistake GCash for cash. */
export function isCashMethod(name: string, configured: ReadonlySet<string>): boolean {
  return configured.has(name) || /\bcash\b/i.test(name);
}

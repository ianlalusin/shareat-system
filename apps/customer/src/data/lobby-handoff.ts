/** T-455 S4 - where the server's hand-off link may send the phone: https on these hosts (or the page's own origin), nothing else. */
export const DEFAULT_HANDOFF_HOSTS: readonly string[] = ['customer.shareat.net'];

export function isAllowedHandoff(link: string, hosts: readonly string[], origin?: string): boolean {
  let u: URL;
  try {
    u = new URL(link);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  if (hosts.includes(u.hostname)) return true;
  return origin !== undefined && u.origin === origin;
}

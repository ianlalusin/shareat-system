/** T-526 R3 - the words in the top bar's status pill. Pure. */

function offlineFor(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function statusPillLabel(s: { online: boolean; sending: boolean; pending: number; offlineForMs: number; signedOut?: boolean }): string {
  if (s.signedOut) return 'Signed out';
  if (s.online) return s.sending ? 'Sending…' : 'Online';
  return `Offline ${offlineFor(s.offlineForMs)}${s.pending > 0 ? ` · ${s.pending} waiting to send` : ''}`;
}

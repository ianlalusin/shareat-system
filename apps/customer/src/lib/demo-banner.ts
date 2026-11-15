/** T-581 R3: the "Demo - sample data" banner is true on the fixture screens, false on /lobby and everything under it (live, sends check-ins to the store). */
export function showDemoBanner(pathname: string | null): boolean {
  return !(pathname ?? '').startsWith('/lobby');
}

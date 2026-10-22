/** Presentation only. The active role and permissions are always read on the server. */
export function staffRoleTitle(role: string | null | undefined, primaryPosition: string | null): string {
  if (role === 'super_admin') return 'Super admin';
  if (role === 'admin') return 'Admin';
  if (role === 'manager') return 'Manager';
  if (role === 'staff') return primaryPosition ?? 'No primary position';
  return 'No active role';
}

interface HolderRow { id: string; displayName: string; role?: string | null; positions: { positionId: string }[] }

/** Everyone assigned to a position, whatever their role; legacy non-staff holders carry an explanatory note. */
export function positionHolders<T extends HolderRow>(roster: T[], positionId: string): (T & { note: string | null })[] {
  const note = (role: string | null | undefined): string | null => {
    if (role === 'staff') return null;
    if (role === 'manager' || role === 'admin' || role === 'super_admin') return `${staffRoleTitle(role, null)} — legacy position, grants still apply`;
    return 'No active role — legacy position';
  };
  const held = roster.filter((r) => r.positions.some((a) => a.positionId === positionId)).map((r) => ({ ...r, note: note(r.role) }));
  const byName = (a: { displayName: string }, b: { displayName: string }) => a.displayName.localeCompare(b.displayName);
  return [...held.filter((h) => h.note === null).sort(byName), ...held.filter((h) => h.note !== null).sort(byName)];
}

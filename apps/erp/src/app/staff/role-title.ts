/** Presentation only. The active role and permissions are always read on the server. */
export function staffRoleTitle(role: string | null | undefined, primaryPosition: string | null): string {
  if (role === 'super_admin') return 'Super admin';
  if (role === 'admin') return 'Admin';
  if (role === 'manager') return 'Manager';
  if (role === 'staff') return primaryPosition ?? 'No primary position';
  return 'No active role';
}

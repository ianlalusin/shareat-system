import type { AppUser } from "@/context/auth-context";

/**
 * Admins and managers are attributed by their own account, so they skip the
 * device-level local-profile sign-in gate. Cashier / server / kitchen (and any
 * other) roles must pick a local profile so shared-account actions are
 * identifiable.
 */
export function bypassesLocalUserGate(appUser: AppUser | null | undefined): boolean {
  if (!appUser) return false;
  return appUser.isPlatformAdmin === true || appUser.role === "admin" || appUser.role === "manager";
}

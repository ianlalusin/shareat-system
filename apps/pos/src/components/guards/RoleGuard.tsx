"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuthContext, type AppUser } from "@/context/auth-context";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ShieldAlert } from "lucide-react";

type Role = "admin" | "manager" | "cashier" | "kitchen" | "server";

type Props = {
  allow: Array<Role>;
  children: React.ReactNode;
  /**
   * When the signed-in user's role isn't allowed, render nothing instead of the
   * access-denied screen. Use this ONLY for inline sections/tools embedded in a
   * page the user is otherwise allowed to see (e.g. an admin-only "Sync" button
   * on the cashier page) — those should silently hide, not show a denial banner
   * in the middle of an otherwise-valid page. For whole-page guards, leave this
   * off so a blocked user gets a clear "access restricted" message.
   */
  hideOnDeny?: boolean;
};

function roleHome(role?: string) {
  switch (role) {
    case "admin":
      return "/cashier";
    case "manager":
      return "/cashier";
    case "cashier":
      return "/cashier";
    case "kitchen":
      return "/kitchen";
    case "server":
      return "/server";
    default:
      return "/cashier";
  }
}

function isRoleAllowed(allow: Array<Role>, appUser: AppUser) {
  return allow.some((requiredRole) => {
    // A page that requires 'admin' specifically requires the platformAdmin claim.
    if (requiredRole === "admin") return appUser.isPlatformAdmin === true;
    // Platform admins can access any non-admin page too.
    if (appUser.isPlatformAdmin) return true;
    return appUser.role === requiredRole;
  });
}

export function RoleGuard({ allow, children, hideOnDeny = false }: Props) {
  const { user, appUser, loading } = useAuthContext();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;

    // Unauthenticated → let the app shell route them to login.
    if (!user) {
      router.replace("/");
      return;
    }

    if (!appUser) return;

    // Authenticated but not yet active (pending/disabled) → status page.
    if (appUser.status !== "active") {
      router.replace("/pending");
      return;
    }

    // NOTE: the forced password change after an admin reset is handled in
    // FirstLoginGuard, not here. It has to run app-wide (this guard only wraps
    // guarded pages) and has to render the change screen outside AppLayout,
    // whose local-user gate would otherwise make a cashier sign into a local
    // profile before they could fix their password.

    // NOTE: We intentionally do NOT auto-redirect a wrong-role user to their
    // role-home here. That silent `router.replace(roleHome)` is what made
    // restricted pages feel like random "jumps" (e.g. a cashier landing on a
    // manager-only page was bounced to /cashier with no explanation, and an
    // inline manager-only guard could yank the whole app off the page). Instead
    // the render path below shows an explicit access-restricted screen so the
    // block is visible and self-explanatory.
  }, [appUser, loading, router, user]);

  // While auth is resolving, or the effect is redirecting an unauth/inactive
  // user, render nothing.
  if (loading || !user || !appUser || appUser.status !== "active") {
    return null;
  }

  if (!isRoleAllowed(allow, appUser)) {
    if (hideOnDeny) return null;

    const home = roleHome(appUser.role);
    const roleLabel = appUser.role ?? "your account";
    return (
      <div className="flex min-h-[60vh] items-center justify-center p-4">
        <Card className="w-full max-w-md border-destructive">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldAlert className="text-destructive" />
              Access restricted
            </CardTitle>
            <CardDescription>
              This page is limited to {allow.join(" / ")} accounts. You&apos;re signed in as{" "}
              <span className="font-medium capitalize">{roleLabel}</span>, so you don&apos;t have access.
              If you think this is a mistake, ask an admin to check your role.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => router.replace(home)} className="w-full">
              Go to my home
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return <>{children}</>;
}

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { getAuth } from "firebase/auth";
import { useAuthContext } from "@/context/auth-context";
import { useToast } from "@/hooks/use-toast";
import { changePassword } from "@/lib/firebase/account-security";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Eye, EyeOff, KeyRound, Loader2 } from "lucide-react";

/**
 * Forced password change after an admin-issued reset.
 *
 * Deliberately NOT wrapped in RoleGuard — RoleGuard redirects here when
 * mustChangePassword is set, so guarding this page would loop.
 *
 * There is no cancel: the only ways out are setting a password or signing out.
 */

const formSchema = z
  .object({
    currentPassword: z.string().min(1, { message: "Enter the temporary password you were given." }),
    newPassword: z.string().min(6, { message: "New password must be at least 6 characters." }),
    confirmPassword: z.string().min(6, { message: "Please confirm your new password." }),
  })
  .refine((d) => d.newPassword === d.confirmPassword, {
    message: "New passwords do not match.",
    path: ["confirmPassword"],
  })
  .refine((d) => d.newPassword !== d.currentPassword, {
    message: "Pick a password different from the temporary one.",
    path: ["newPassword"],
  });

function roleHome(role?: string) {
  switch (role) {
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

export default function ChangePasswordPage() {
  const router = useRouter();
  const { user, appUser, loading, signOut } = useAuthContext();
  const { toast } = useToast();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: { currentPassword: "", newPassword: "", confirmPassword: "" },
  });

  // Routing in and out of this page is owned by FirstLoginGuard: it sends
  // flagged users here and sends everyone else home, and it renders this page
  // outside AppLayout. Nothing to redirect here.

  const onSubmit = async (values: z.infer<typeof formSchema>) => {
    setIsSubmitting(true);
    try {
      // Firebase reauthenticates with the temporary password here, so this is
      // what actually proves the user was given it.
      await changePassword(values.currentPassword, values.newPassword);

      const current = getAuth().currentUser;
      if (!current) throw new Error("Not signed in.");
      // Force-refresh: the reset revoked the old refresh token, and the
      // clear-flag route verifies with checkRevoked.
      const idToken = await current.getIdToken(true);

      const res = await fetch("/api/account/password-changed", {
        method: "POST",
        headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.ok) throw new Error(json?.error || `Could not finish setup (${res.status})`);

      toast({ title: "Password Updated", description: "You're all set." });
      // The staff-doc listener clears mustChangePassword, which releases
      // RoleGuard; push to the role home rather than waiting for a bounce.
      router.replace(roleHome(appUser?.role));
    } catch (error: any) {
      let description = "An unexpected error occurred. Please try again.";
      if (error.code === "auth/wrong-password" || error.code === "auth/invalid-credential") {
        description = "That temporary password is incorrect. Check it with your admin.";
      } else if (error.code === "auth/weak-password") {
        description = "That password is too weak. Use at least 6 characters.";
      } else if (error.code === "auth/requires-recent-login") {
        description = "For security, sign out and sign back in, then try again.";
      } else if (error.code === "auth/too-many-requests") {
        description = "Too many attempts. Please wait a few minutes and try again.";
      } else if (error?.message) {
        description = error.message;
      }
      toast({ variant: "destructive", title: "Could Not Change Password", description });
    } finally {
      setIsSubmitting(false);
    }
  };

  if (loading || !user) return null;

  return (
    <div className="flex min-h-[80vh] items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="h-5 w-5" /> Set a new password
          </CardTitle>
          <CardDescription>
            An admin reset your password. Choose your own before continuing.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert>
            <AlertTitle>Temporary password</AlertTitle>
            <AlertDescription className="text-xs">
              Enter the temporary password your admin gave you, then pick a new one only you know.
            </AlertDescription>
          </Alert>

          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="currentPassword"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Temporary password</FormLabel>
                    <div className="relative">
                      <FormControl>
                        <Input type={showCurrent ? "text" : "password"} autoComplete="current-password" {...field} />
                      </FormControl>
                      <button
                        type="button"
                        onClick={() => setShowCurrent(!showCurrent)}
                        className="absolute inset-y-0 right-0 px-3 flex items-center text-muted-foreground"
                        aria-label={showCurrent ? "Hide password" : "Show password"}
                      >
                        {showCurrent ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="newPassword"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>New password</FormLabel>
                    <div className="relative">
                      <FormControl>
                        <Input type={showNew ? "text" : "password"} autoComplete="new-password" {...field} />
                      </FormControl>
                      <button
                        type="button"
                        onClick={() => setShowNew(!showNew)}
                        className="absolute inset-y-0 right-0 px-3 flex items-center text-muted-foreground"
                        aria-label={showNew ? "Hide password" : "Show password"}
                      >
                        {showNew ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="confirmPassword"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Confirm new password</FormLabel>
                    <FormControl>
                      <Input type="password" autoComplete="new-password" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <Button type="submit" className="w-full" disabled={isSubmitting}>
                {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Set password and continue
              </Button>
            </form>
          </Form>

          <Button
            type="button"
            variant="ghost"
            className="w-full"
            disabled={isSubmitting}
            onClick={() => void signOut()}
          >
            Sign out instead
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

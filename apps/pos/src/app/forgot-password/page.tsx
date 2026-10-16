"use client";

import { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { sendPasswordReset } from "@/lib/firebase/account-security";
import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const { toast } = useToast();
  const router = useRouter();

  async function handleResetPassword(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await sendPasswordReset(email);
      setSubmitted(true);
    } catch (err: any) {
      toast({
        variant: "destructive",
        title: "Error",
        description: err.message || "Failed to send reset email.",
      });
    } finally {
      setLoading(false);
    }
  }

  if (submitted) {
    return (
      <div className="w-full min-h-screen flex items-center justify-center bg-background">
        <Card className="mx-auto max-w-sm w-full">
          <CardHeader className="text-center">
            <CardTitle>Check Your Email</CardTitle>
            <CardDescription>
              A password reset link has been sent to <span className="font-medium">{email}</span> if an account with that email exists.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => router.push("/login")} className="w-full">
              Back to Login
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="w-full min-h-screen flex items-center justify-center bg-background">
      <Card className="mx-auto max-w-sm w-full bg-card">
        <CardHeader className="text-center">
          <div className="flex flex-col justify-center items-center gap-4 mb-4">
            <Image 
              src="/logo.png"
              alt="SharEat"
              width={128}
              height={128}
              priority
              className="object-contain"
            />
            <h1 className="text-3xl font-bold font-serif text-destructive">SharEat Hub</h1>
          </div>
          <CardTitle>Forgot Password</CardTitle>
          <CardDescription>
            Enter your email to receive a password reset link.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleResetPassword} className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                placeholder="m@example.com"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? <Loader2 className="animate-spin" /> : "Send Reset Email"}
            </Button>
          </form>
          <div className="mt-4 text-center text-sm">
            Remember your password?{" "}
            <Link href="/login" className="underline">
              Login
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

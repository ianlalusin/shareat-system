
"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import Image from "next/image";
import { useAuthContext } from "@/context/auth-context";

export default function PendingPage() {
  const router = useRouter();
  const { signOut } = useAuthContext();

  async function handleLogout() {
    await signOut();
  }

  return (
    <div className="w-full min-h-screen flex items-center justify-center bg-background">
       <Card className="mx-auto max-w-md w-full">
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
          <CardTitle className="text-xl">Account Creation Successful</CardTitle>
          <CardDescription>
            Your account is currently <span className="font-medium text-primary">Pending Approval</span>.
          </CardDescription>
        </CardHeader>
        <CardContent>
           <p className="mb-6 text-center text-sm text-muted-foreground">
            You will be able to access the system once an administrator approves your account.
            You can log out and check back later.
          </p>
          <div className="flex flex-col sm:flex-row gap-2">
            <Button className="w-full" onClick={handleLogout}>
              Logout
            </Button>
            <Button
              className="w-full"
              variant="secondary"
              onClick={() => router.push("/support")}
            >
              Contact Support
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

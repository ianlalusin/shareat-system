
"use client";

import { useState, useEffect } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { createUserWithEmailAndPassword, User } from 'firebase/auth';
import { doc, getDoc, serverTimestamp, setDoc } from 'firebase/firestore';
import { auth, db } from '@/lib/firebase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { useAuthContext } from '@/context/auth-context';
import { Eye, EyeOff } from 'lucide-react';

export default function SignupPage() {
  const router = useRouter();
  const { toast } = useToast();
  const { appUser, user: firebaseUser } = useAuthContext();

  // Step 1: Account Creation
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [isCreatingAccount, setIsCreatingAccount] = useState(false);

  // Step 2: User Details
  const [isDetailsModalOpen, setIsDetailsModalOpen] = useState(false);
  const [createdUser, setCreatedUser] = useState<User | null>(null);
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [contactNumber, setContactNumber] = useState('');
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const [isSavingDetails, setIsSavingDetails] = useState(false);

  useEffect(() => {
    // Only pull a signed-in user into the profile-creation modal when they
    // GENUINELY have no staff doc yet (needs_profile). This previously also
    // fired on a sticky `signup_flow` sessionStorage flag, which re-opened the
    // (overwriting) modal for fully-provisioned users — including admins — who
    // merely landed on /signup, and demoted them on submit. Gate strictly on
    // the real no-doc state.
    if (firebaseUser && appUser?.status === 'needs_profile') {
      setCreatedUser(firebaseUser);
      setIsDetailsModalOpen(true);
    }
  }, [firebaseUser, appUser]);


  async function handleAccountCreation(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 8) {
      setAccountError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirmPassword) {
      setAccountError("Passwords do not match.");
      return;
    }
    setAccountError(null);
    setIsCreatingAccount(true);

    try {
      const userCredential = await createUserWithEmailAndPassword(auth, email, password);
      setCreatedUser(userCredential.user);
      setIsDetailsModalOpen(true);
    } catch (err: any) {
      const rawError = err.message ?? "Failed to create account.";
      const cleanedError = rawError.replace("Firebase: ", "");
      setAccountError(cleanedError);
    } finally {
      setIsCreatingAccount(false);
    }
  }

  async function handleDetailsSubmission(e: React.FormEvent) {
    e.preventDefault();
    if (!createdUser) {
      setDetailsError("No user session found. Please try signing up again.");
      return;
    }
    if (!name || !address || !contactNumber) {
      setDetailsError("Please fill out all fields.");
      return;
    }
    setDetailsError(null);
    setIsSavingDetails(true);

    try {
      const userDocRef = doc(db, "staff", createdUser.uid);

      // Never overwrite an existing profile. This self-signup flow is strictly
      // for brand-new accounts with no staff doc. If a doc already exists (e.g.
      // a provisioned admin who transiently bounced through /signup), a full
      // setDoc here would demote them to pending/server and wipe store access —
      // the admin-lockout bug. Bail out and send them home instead.
      const existing = await getDoc(userDocRef);
      if (existing.exists()) {
        setIsDetailsModalOpen(false);
        toast({
          title: "You already have an account",
          description: "Taking you to your home page.",
        });
        router.replace("/");
        return;
      }

      await setDoc(userDocRef, {
        staffId: createdUser.uid,
        email: createdUser.email,
        name,
        address,
        contactNumber,
        status: "pending",
        role: "server", // Default role
        assignedStoreIds: [],
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      router.push("/pending");

    } catch (err: any) {
      const errorMessage = err.message ?? "Failed to save details.";
      setDetailsError(errorMessage);
      toast({
        variant: "destructive",
        title: "Error saving details",
        description: "An unexpected error occurred. Please contact support.",
      });
      setIsSavingDetails(false);
    }
  }

  return (
    <>
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
            <CardDescription>Create an account to get started</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleAccountCreation} className="grid gap-4">
              <div className="grid gap-2">
                <Label htmlFor="email">Email</Label>
                <Input id="email" type="email" placeholder="m@example.com" required value={email} onChange={(e) => setEmail(e.target.value)} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="password">Password</Label>
                <div className="relative">
                  <Input id="password" type={showPassword ? "text" : "password"} required value={password} onChange={(e) => setPassword(e.target.value)} />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground"
                  >
                    {showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                  </button>
                </div>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="confirm-password">Confirm Password</Label>
                <div className="relative">
                  <Input id="confirm-password" type={showConfirmPassword ? "text" : "password"} required value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} />
                  <button
                    type="button"
                    onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                    className="absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground"
                  >
                    {showConfirmPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                  </button>
                </div>
              </div>
              {accountError && <p className="text-sm text-destructive">{accountError}</p>}
              <Button type="submit" className="w-full" disabled={isCreatingAccount}>
                {isCreatingAccount ? "Creating Account..." : "Create Account"}
              </Button>
            </form>
            <div className="mt-4 text-center text-sm">
              Already have an account?{' '}
              <Link href="/login" className="underline">
                Login
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>

      <Dialog open={isDetailsModalOpen} onOpenChange={(isOpen) => {
        if (!isOpen && !isSavingDetails) {
            setIsDetailsModalOpen(true); // Keep it open
            toast({
                variant: 'destructive',
                title: "Please complete your profile",
                description: "You must provide your details to finish creating your account.",
            });
        }
      }}>
        <DialogContent onPointerDownOutside={(e) => e.preventDefault()} onEscapeKeyDown={(e) => e.preventDefault()} className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>Almost there!</DialogTitle>
            <DialogDescription>
              We just need a few more details to set up your account.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleDetailsSubmission} className="grid gap-4 py-4">
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="details-email" className="text-right">Email</Label>
              <Input id="details-email" value={createdUser?.email || ''} readOnly disabled className="col-span-3" />
            </div>
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="name" className="text-right">Full Name</Label>
              <Input id="name" placeholder="John Doe" required className="col-span-3" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="address" className="text-right">Address</Label>
              <Input id="address" placeholder="123 Main St, Anytown" required className="col-span-3" value={address} onChange={(e) => setAddress(e.target.value)} />
            </div>
             <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="contactNumber" className="text-right">Contact No.</Label>
              <Input id="contactNumber" placeholder="e.g. +1234567890" required className="col-span-3" value={contactNumber} onChange={(e) => setContactNumber(e.target.value)} />
            </div>
            {detailsError && <p className="text-sm text-destructive text-center col-span-4">{detailsError}</p>}
             <Button type="submit" disabled={isSavingDetails}>
                {isSavingDetails ? "Saving..." : "Complete Signup"}
             </Button>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

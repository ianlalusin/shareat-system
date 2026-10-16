
"use client";

import { useAuthContext } from "@/context/auth-context";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { useRouter } from "next/navigation";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { ImageIcon, Loader2, UploadCloud, View, KeyRound, Link as LinkIcon } from "lucide-react";
import { uploadUserAvatar } from "@/lib/firebase/client";
import { useToast } from "@/hooks/use-toast";
import { RoleGuard } from "@/components/guards/RoleGuard";
import { ChangePasswordDialog } from "@/components/account/ChangePasswordDialog";
import { linkWithGoogle, sendPasswordReset } from "@/lib/firebase/account-security";
import { useConfirmDialog } from "@/components/global/confirm-dialog";
import { useStoreContext } from "@/context/store-context";
import { auth } from "@/lib/firebase/client";

export default function AccountPage() {
    const { appUser, user, loading } = useAuthContext();
    const { activeStore } = useStoreContext();
    const router = useRouter();
    const { toast } = useToast();
    const [isUploading, setIsUploading] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [isAvatarDialogOpen, setIsAvatarDialogOpen] = useState(false);
    const [isPasswordDialogOpen, setIsPasswordDialogOpen] = useState(false);
    const [isLinking, setIsLinking] = useState(false);
    const [providerRefreshKey, setProviderRefreshKey] = useState(0);
    const { confirm, Dialog: ConfirmDialog } = useConfirmDialog();

    useEffect(() => {
        if (!loading && !appUser) {
            router.push('/');
        }
    }, [appUser, loading, router]);

    const hasPasswordProvider = useMemo(() => {
        if (!user) return false;
        return user.providerData.some(p => p.providerId === 'password');
    }, [user, providerRefreshKey]);

    const hasGoogleProvider = useMemo(() => {
        if (!user) return false;
        return user.providerData.some(p => p.providerId === 'google.com');
    }, [user, providerRefreshKey]);


    if (loading || !appUser || !user) {
        return <div className="flex items-center justify-center h-full"><Loader2 className="animate-spin" /></div>;
    }

    const userInitials = appUser.displayName
        ? appUser.displayName.split(' ').map(n => n[0]).join('')
        : appUser.email ? appUser.email[0].toUpperCase() : 'U';

    const avatarUrl = user.photoURL || appUser.photoURL || undefined;

    const handleAvatarUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file || !user) return;

        setIsUploading(true);
        try {
            await uploadUserAvatar(user.uid, file);
            await user.reload(); // Force reload of user object to get new photoURL
            toast({
                title: "Profile photo updated",
                description: "Your new avatar has been saved.",
            });
        } catch (error) {
            console.error("Failed to upload avatar:", error);
            toast({
                variant: "destructive",
                title: "Upload failed",
                description: "Could not update your profile photo.",
            });
        } finally {
            setIsUploading(false);
            setIsAvatarDialogOpen(false); 
        }
    };

    const handleLinkGoogle = async () => {
        if (!user) {
            toast({
            variant: "destructive",
            title: "Linking Failed",
            description: "You must be signed in to link an account.",
            });
            return;
        }

        setIsLinking(true);
        try {
            await linkWithGoogle();

            // Ensure the user object updates its providerData
            await user.reload();
        
            // Force re-memo of badges (since your memos depend on user/providerData)
            setProviderRefreshKey((k) => k + 1);
        
            toast({ title: "Google Account Linked", description: "You can now sign in with Google." });
        } catch (error: any) {
            console.warn("[Account] Link Google error:", error?.code);

            let description = "Could not link Google account.";
            const code = error?.code ?? "";

            if (code === "auth/credential-already-in-use") {
            description = "This Google account is already linked to another user.";
            } else if (code === "auth/provider-already-linked") {
            description = "Google is already linked.";
            } else if (code === "auth/popup-blocked") {
            description = "Popup was blocked. Please allow popups and try again.";
            } else if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") {
            description = "Popup closed. Please try again.";
            }

            toast({
                variant: "destructive",
                title: "Linking Failed",
                description,
            });
        } finally {
            setIsLinking(false);
        }
    };
    
    const handleSendResetEmail = async () => {
        if (!user?.email) return;
        try {
            await sendPasswordReset(user.email);
            toast({ title: "Password Reset Email Sent", description: `An email has been sent to ${user.email}.`});
        } catch (error) {
            toast({ variant: "destructive", title: "Request Failed", description: "Could not send password reset email." });
        }
        setIsPasswordDialogOpen(false);
    }

    return (
        <RoleGuard allow={["admin", "manager", "cashier", "kitchen", "server"]}>
            <PageHeader title="My Account" description="View and manage your account details." />
            <div className="grid gap-8 md:grid-cols-2 items-start">
                <Card>
                    <CardHeader className="flex flex-col items-center text-center p-6">
                            <Dialog open={isAvatarDialogOpen} onOpenChange={setIsAvatarDialogOpen}>
                            <DialogTrigger asChild>
                                <button className="relative rounded-full">
                                    <Avatar className="h-24 w-24 mb-4 cursor-pointer ring-2 ring-offset-2 ring-transparent hover:ring-primary transition-all">
                                        <AvatarImage src={avatarUrl} alt={appUser.displayName || 'User'} />
                                        <AvatarFallback className="text-3xl">{userInitials}</AvatarFallback>
                                    </Avatar>
                                        <div className="absolute inset-0 bg-black/40 rounded-full flex items-center justify-center opacity-0 hover:opacity-100 transition-opacity">
                                        <ImageIcon className="h-8 w-8 text-white" />
                                    </div>
                                </button>
                            </DialogTrigger>
                            <DialogContent className="sm:max-w-[425px]">
                                <DialogHeader>
                                    <DialogTitle>Profile Photo</DialogTitle>
                                    <DialogDescription>Manage your avatar.</DialogDescription>
                                </DialogHeader>
                                <div className="flex justify-center py-4">
                                    <Avatar className="h-40 w-40">
                                        <AvatarImage src={avatarUrl} alt={appUser.displayName || 'User'}/>
                                        <AvatarFallback className="text-6xl">{userInitials}</AvatarFallback>
                                    </Avatar>
                                </div>
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                    <Button variant="outline" asChild disabled={!avatarUrl}>
                                        <a href={avatarUrl!} target="_blank" rel="noopener noreferrer">
                                            <View className="mr-2" /> View Photo
                                        </a>
                                    </Button>
                                    <Button onClick={() => fileInputRef.current?.click()} disabled={isUploading}>
                                        {isUploading ? (
                                            <Loader2 className="mr-2 animate-spin" />
                                        ) : (
                                            <UploadCloud className="mr-2" />
                                        )}
                                        Upload New
                                    </Button>
                                </div>
                                <input
                                    type="file"
                                    ref={fileInputRef}
                                    onChange={handleAvatarUpload}
                                    className="hidden"
                                    accept="image/*"
                                />
                            </DialogContent>
                        </Dialog>
                        <CardTitle className="text-xl">{appUser.displayName}</CardTitle>
                        <CardDescription>{appUser.email}</CardDescription>
                    </CardHeader>
                    <CardContent>
                        <Separator />
                        <div className="py-4 grid gap-2">
                            <div className="flex justify-between items-center">
                                <span className="text-muted-foreground text-sm">Role</span>
                                <Badge variant="outline" className="capitalize">{appUser.role}</Badge>
                            </div>
                            <div className="flex justify-between items-center">
                                <span className="text-muted-foreground text-sm">Store</span>
                                <span className="font-medium text-sm">{activeStore?.name || 'N/A'}</span>
                            </div>
                            <div className="flex justify-between items-center">
                                <span className="text-muted-foreground text-sm">Status</span>
                                    <Badge variant={appUser.status === 'active' ? 'default' : 'secondary'} className="capitalize">{appUser.status}</Badge>
                            </div>
                        </div>
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader>
                        <CardTitle>Security</CardTitle>
                        <CardDescription>Manage password and sign-in methods.</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <div>
                            <h4 className="text-sm font-medium mb-2">Sign-in Methods</h4>
                            <div className="flex flex-wrap gap-2">
                                {hasPasswordProvider ? <Badge>Password enabled</Badge> : <Badge variant="secondary">No password</Badge>}
                                {hasGoogleProvider ? <Badge>Google linked</Badge> : <Badge variant="secondary">Google not linked</Badge>}
                            </div>
                        </div>

                        <Separator />

                        <div className="space-y-2">
                            <Dialog open={isPasswordDialogOpen} onOpenChange={setIsPasswordDialogOpen}>
                                <DialogTrigger asChild>
                                    <Button variant="outline">
                                        <KeyRound className="mr-2 h-4 w-4" /> Change Password
                                    </Button>
                                </DialogTrigger>
                                <ChangePasswordDialog
                                    hasPasswordProvider={hasPasswordProvider}
                                    onSendResetEmail={handleSendResetEmail}
                                    onClose={() => setIsPasswordDialogOpen(false)}
                                />
                            </Dialog>

                             {!hasGoogleProvider && (
                                <Button variant="outline" onClick={handleLinkGoogle} disabled={isLinking}>
                                    {isLinking ? (
                                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                    ) : (
                                        <LinkIcon className="mr-2 h-4 w-4" />
                                    )}
                                    Link Google Account
                                </Button>
                            )}
                        </div>
                    </CardContent>
                </Card>
            </div>
            {ConfirmDialog}
        </RoleGuard>
    );
}

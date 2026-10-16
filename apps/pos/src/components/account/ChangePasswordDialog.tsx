
'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Button } from '@/components/ui/button';
import { DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Loader2, Eye, EyeOff } from 'lucide-react';
import { changePassword } from '@/lib/firebase/account-security';
import { useToast } from '@/hooks/use-toast';
import { Alert, AlertDescription, AlertTitle } from '../ui/alert';
import { Mail } from 'lucide-react';

const formSchema = z.object({
  currentPassword: z.string().min(1, { message: 'Current password is required.' }),
  newPassword: z.string().min(6, { message: 'New password must be at least 6 characters.' }),
  confirmPassword: z.string().min(6, { message: 'Please confirm your new password.' }),
}).refine(data => data.newPassword === data.confirmPassword, {
  message: 'New passwords do not match.',
  path: ['confirmPassword'],
});

interface ChangePasswordDialogProps {
  onClose: () => void;
  hasPasswordProvider: boolean;
  onSendResetEmail: () => void;
}

export function ChangePasswordDialog({ onClose, hasPasswordProvider, onSendResetEmail }: ChangePasswordDialogProps) {
  const { toast } = useToast();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  
  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: { currentPassword: '', newPassword: '', confirmPassword: '' },
  });

  const onSubmit = async (values: z.infer<typeof formSchema>) => {
    setIsSubmitting(true);
    try {
      await changePassword(values.currentPassword, values.newPassword);
      toast({ title: 'Password Changed', description: 'Your password has been successfully updated.' });
      form.reset();
      onClose();
    } catch (error: any) {
      let description = "An unexpected error occurred. Please try again.";
      if (error.code === 'auth/wrong-password') {
        description = "The current password you entered is incorrect.";
      } else if (error.code === 'auth/requires-recent-login') {
        description = "This action is sensitive. Please sign out and sign in again before changing your password.";
      } else if (error.code === 'auth/too-many-requests') {
        description = "Too many attempts. Please try again later.";
      }
      toast({ variant: 'destructive', title: 'Change Password Failed', description });
    } finally {
      setIsSubmitting(false);
    }
  };
  
  if (!hasPasswordProvider) {
    return (
        <DialogContent>
            <DialogHeader>
                <DialogTitle>Change Password</DialogTitle>
                <DialogDescription>This option is not available for your sign-in method.</DialogDescription>
            </DialogHeader>
            <Alert>
                <AlertTitle>Password Not Set</AlertTitle>
                <AlertDescription>
                    Your account was created using a social sign-in (like Google). To add a password,
                    you can request a password reset email.
                </AlertDescription>
            </Alert>
            <DialogFooter>
                <Button variant="outline" onClick={onClose}>Cancel</Button>
                <Button onClick={onSendResetEmail}>
                    <Mail className="mr-2"/> Send Password Reset Email
                </Button>
            </DialogFooter>
        </DialogContent>
    );
  }

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Change Password</DialogTitle>
        <DialogDescription>Enter your current and new password below.</DialogDescription>
      </DialogHeader>
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <FormField
            control={form.control}
            name="currentPassword"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Current Password</FormLabel>
                <div className="relative">
                  <FormControl>
                    <Input type={showCurrent ? 'text' : 'password'} {...field} />
                  </FormControl>
                  <button type="button" onClick={() => setShowCurrent(!showCurrent)} className="absolute inset-y-0 right-0 px-3 flex items-center text-muted-foreground"><Eye/></button>
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
                <FormLabel>New Password</FormLabel>
                <div className="relative">
                  <FormControl>
                    <Input type={showNew ? 'text' : 'password'} {...field} />
                  </FormControl>
                  <button type="button" onClick={() => setShowNew(!showNew)} className="absolute inset-y-0 right-0 px-3 flex items-center text-muted-foreground"><Eye/></button>
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
                <FormLabel>Confirm New Password</FormLabel>
                 <div className="relative">
                  <FormControl>
                    <Input type={showConfirm ? 'text' : 'password'} {...field} />
                  </FormControl>
                  <button type="button" onClick={() => setShowConfirm(!showConfirm)} className="absolute inset-y-0 right-0 px-3 flex items-center text-muted-foreground"><Eye/></button>
                </div>
                <FormMessage />
              </FormItem>
            )}
          />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={isSubmitting}>Cancel</Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting && <Loader2 className="mr-2 animate-spin" />}
              Save Changes
            </Button>
          </DialogFooter>
        </form>
      </Form>
    </DialogContent>
  );
}

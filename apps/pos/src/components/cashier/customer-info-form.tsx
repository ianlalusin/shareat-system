
"use client";

import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useState, useEffect } from "react";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Loader2, Save } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { doc, updateDoc, serverTimestamp } from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import { useAuthContext } from "@/context/auth-context";
import type { PendingSession } from "@/lib/types";

const formSchema = z.object({
  name: z.string().min(2, "Customer name is required."),
  tin: z.string().optional(),
  address: z.string().optional(),
});

type FormValues = z.infer<typeof formSchema>;

export function CustomerInfoForm({ session }: { session: PendingSession }) {
  const { appUser } = useAuthContext();
  const { toast } = useToast();
  const [isSubmitting, setIsSubmitting] = useState(false);

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: "",
      tin: "",
      address: "",
    },
  });

  useEffect(() => {
    form.reset({
      name: session.customer?.name ?? "",
      tin: session.customer?.tin ?? "",
      address: session.customer?.address ?? "",
    });
  }, [session, form]);

  const onSubmit = async (data: FormValues) => {
    if (!appUser) return;
    setIsSubmitting(true);
    const sessionRef = doc(db, "stores", session.storeId, "sessions", session.id);
    try {
      await updateDoc(sessionRef, {
        "customer.name": data.name || null,
        "customer.tin": data.tin || null,
        "customer.address": data.address || null,
        updatedAt: serverTimestamp(),
      });
      toast({ title: "Customer Info Saved" });
    } catch (error: any) {
      toast({ variant: "destructive", title: "Save Failed", description: error.message });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="p-4">
      <Accordion type="single" collapsible>
        <AccordionItem value="customer-info">
          <AccordionTrigger>
            <h3 className="text-lg font-semibold">Customer Information</h3>
          </AccordionTrigger>
          <AccordionContent>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Customer Name <span className="text-destructive">*</span></FormLabel>
                      <FormControl>
                        <Input placeholder="John Doe" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="tin"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>TIN</FormLabel>
                      <FormControl>
                        <Input placeholder="Taxpayer Identification Number" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="address"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Address</FormLabel>
                      <FormControl>
                        <Input placeholder="123 Main St, Anytown" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <Button type="submit" disabled={isSubmitting} className="w-full">
                  {isSubmitting ? <Loader2 className="mr-2 animate-spin" /> : <Save className="mr-2" />}
                  Save Customer Info
                </Button>
              </form>
            </Form>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  );
}


import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import Link from "next/link";

export default function SupportPage() {
  return (
    <div className="w-full min-h-screen flex items-center justify-center bg-background">
      <Card className="mx-auto max-w-md w-full">
        <CardHeader>
          <CardTitle className="text-2xl">Support</CardTitle>
          <CardDescription>
            Need help? Here’s how you can contact us.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <p className="text-muted-foreground">
              For account approval or role-related questions, please contact your direct manager or a system administrator.
            </p>
             <p className="text-muted-foreground">
              For technical issues, please email our support team at <a href="mailto:support@shareathub.com" className="text-primary underline">support@shareathub.com</a>.
            </p>
            <Button asChild className="w-full">
                <Link href="/login">Back to Login</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

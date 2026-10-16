
"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function CashierSessionsRedirectPage() {
    const router = useRouter();

    useEffect(() => {
        router.replace('/cashier');
    }, [router]);

    return null;
}

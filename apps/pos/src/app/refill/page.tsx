"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function RefillPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/server");
  }, [router]);

  return null;
}

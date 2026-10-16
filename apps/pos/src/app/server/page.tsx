
"use client";

import { Suspense } from 'react';
import { Loader2 } from 'lucide-react';
import dynamic from 'next/dynamic';

const ServerPageClient = dynamic(
  () => import('@/components/server/ServerPageClient').then((mod) => mod.ServerPageClient),
  { 
    ssr: false,
    loading: () => <div className="flex items-center justify-center h-full"><Loader2 className="animate-spin" /></div>
  }
);

export default function ServerPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-full"><Loader2 className="animate-spin" /></div>}>
      <ServerPageClient />
    </Suspense>
  )
}

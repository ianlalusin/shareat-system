
"use client";

import { Suspense } from 'react';
import { Loader2 } from 'lucide-react';
import dynamic from 'next/dynamic';

const HistoryPageClient = dynamic(
  () => import('@/components/kitchen/history/HistoryPageClient').then((mod) => mod.HistoryPageClient),
  {
    ssr: false,
    loading: () => <div className="flex items-center justify-center h-full"><Loader2 className="animate-spin" /></div>
  }
);


export default function KitchenHistoryPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-full"><Loader2 className="animate-spin" /></div>}>
      <HistoryPageClient />
    </Suspense>
  )
}

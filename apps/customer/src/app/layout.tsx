import type { ReactNode } from 'react';
import type { Viewport } from 'next';
import { AppShell, DemoBanner } from '@/components/app-shell';
import { CustomerProvider } from '@/data/provider';
import './globals.css';

export const metadata = {
  title: 'Shareat Customer v2',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <CustomerProvider>
          <DemoBanner />
          <AppShell>{children}</AppShell>
        </CustomerProvider>
      </body>
    </html>
  );
}

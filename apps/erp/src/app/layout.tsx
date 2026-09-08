import type { Metadata } from 'next';
import './globals.css';
import { AppShell } from '../components/shell/AppShell';

export const metadata: Metadata = {
  title: 'Shareat System',
  description: 'Shareat ERP — correct books, simply modelled',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {/* ⚠️ Reads the session, so every page under it is dynamic. That is already true of every
            screen in this app — each one calls `requireSession` — so nothing was static to lose. */}
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}

import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Shareat System',
  description: 'Shareat ERP — correct books, simply modelled',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

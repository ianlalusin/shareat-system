'use client';

import { AuthContextProvider } from '@/context/auth-context';
import { StoreContextProvider } from '@/context/store-context';
import { LocalProfileProvider } from '@/context/local-profile-context';
import { QrWalletProvider } from '@/context/qr-wallet-context';
import { FirebaseClientProvider } from '@/firebase/client-provider';
import { Capacitor } from '@capacitor/core';
import { useEffect } from 'react';
import { getLastPrinterAddress } from '@/lib/printing/printHub';
import ThermalPrinter from '@/lib/printing/thermalPrinter';
import { AndroidBackHandler } from '@/components/shared/AndroidBackHandler';
import { ProofOutboxSync } from '@/components/shared/ProofOutboxSync';
import { installApiBaseFetch } from '@/lib/api-base';

export function Providers({ children }: { children: React.ReactNode }) {
    useEffect(() => {
        // Capacitor build: redirect relative /api calls to the deployed backend.
        installApiBaseFetch();

        // Register the service worker only in the browser, not in the native app.
        if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
            const isWorkstation = window.location.hostname.endsWith('.cloudworkstations.dev');
            if (!Capacitor.isNativePlatform() && !isWorkstation) {
                navigator.serviceWorker.register('/sw.js').then(
                    (registration) => {
                        console.debug('[SW] Registration successful:', registration.scope);
                    },
                    (err) => {
                        console.warn('[SW] Registration failed:', err);
                    }
                );
            }
        }

        // On native: reconnect BT printer when app resumes from background
        if (Capacitor.isNativePlatform()) {
            const onResume = () => {
                const addr = getLastPrinterAddress();
                if (addr) {
                    ThermalPrinter.connectBluetoothPrinter({ address: addr }).catch((err: any) => {
                        console.warn('[BT] Resume reconnect failed:', err?.message);
                    });
                }
            };
            document.addEventListener('resume', onResume);
            return () => document.removeEventListener('resume', onResume);
        }
    }, []);
    
    return (
        <FirebaseClientProvider>
            <AuthContextProvider>
                <StoreContextProvider>
                    <LocalProfileProvider>
                        {/* Inside LocalProfileProvider: the wallet's audit trail
                            attributes a QR display to the device's local user. */}
                        <QrWalletProvider>
                            <AndroidBackHandler />
                            <ProofOutboxSync />
                            {children}
                        </QrWalletProvider>
                    </LocalProfileProvider>
                </StoreContextProvider>
            </AuthContextProvider>
        </FirebaseClientProvider>
    );
}

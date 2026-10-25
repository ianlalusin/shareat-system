'use client';

import { useState, useEffect } from 'react';
import { PageHeader } from "@/components/page-header";
import { RoleGuard } from "@/components/guards/RoleGuard";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Printer, Bluetooth, RefreshCw, Usb, Check, ChefHat } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import ThermalPrinter, { type BluetoothDevice, type PrintDarkness, PRINT_DARKNESS_OPTIONS } from "@/lib/printing/thermalPrinter";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Capacitor } from '@capacitor/core';
import { getLastPrinterAddress, setLastPrinterAddress, printViaNativeBluetooth, printViaWebUSB } from "@/lib/printing/printHub";
import { getPinQrMode, setPinQrMode, renderPinQr, PIN_QR_MODES, PIN_QR_NATIVE_DOTS, DEFAULT_PIN_QR_MODE, type PinQrMode } from "@/lib/printing/pinQr";
import { TerminalSection } from "@/components/settings/TerminalSection";
import { OutboxSection } from "@/components/settings/OutboxSection";
import { DaySection } from "@/components/settings/DaySection";
import { getKitchenPrinterAddress, setKitchenPrinterAddress, printKitchenText } from "@/lib/printing/kitchenPrinter";

export default function SettingsPage() {
  const { toast } = useToast();
  const [devices, setDevices] = useState<BluetoothDevice[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [connectedAddress, setConnectedAddress] = useState<string | null>(null);
  const [kitchenAddress, setKitchenAddressState] = useState<string | null>(null);
  const [paperWidth, setPaperWidth] = useState<"58" | "80">("80");
  const [isNative, setIsNative] = useState(false);
  const [hasWebUSB, setHasWebUSB] = useState(false);
  const [webusbSelected, setWebusbSelected] = useState(false);
  const [pinQrMode, setPinQrModeState] = useState<PinQrMode>(DEFAULT_PIN_QR_MODE);
  const [darkness, setDarkness] = useState<PrintDarkness>('normal');

  useEffect(() => {
    const native = Capacitor.isNativePlatform();
    setIsNative(native);
    setHasWebUSB(typeof navigator !== 'undefined' && 'usb' in (navigator as any));
    const stored = getLastPrinterAddress();
    if (stored) setConnectedAddress(stored);
    const storedKitchen = getKitchenPrinterAddress();
    if (storedKitchen) setKitchenAddressState(storedKitchen);
    setPinQrModeState(getPinQrMode());
    if (native && stored) {
      ThermalPrinter.getPrintDarkness({ address: stored })
        .then(({ mode }) => setDarkness(mode))
        .catch(() => {});
    }
    if (native) refreshDevices();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshDevices = async () => {
    if (!Capacitor.isNativePlatform()) return;
    setIsLoading(true);
    try {
      const { devices } = await ThermalPrinter.listBluetoothPrinters();
      setDevices(devices);
    } catch (e: any) {
      toast({ variant: 'destructive', title: 'Bluetooth Error', description: e.message });
    } finally {
      setIsLoading(false);
    }
  };

  const handleConnect = async (address: string) => {
    setIsLoading(true);
    try {
      await ThermalPrinter.connectBluetoothPrinter({ address });
      setLastPrinterAddress(address);
      setConnectedAddress(address);
      toast({ title: 'Bluetooth Connected', description: 'Printer is ready.' });
    } catch (e: any) {
      toast({ variant: 'destructive', title: 'Connection Failed', description: e.message });
    } finally {
      setIsLoading(false);
    }
  };

  const handleConnectKitchen = async (address: string) => {
    setIsLoading(true);
    try {
      await ThermalPrinter.connectBluetoothPrinter({ address });
      setKitchenPrinterAddress(address);
      setKitchenAddressState(address);
      toast({ title: 'Kitchen Printer Connected', description: 'Printer is ready.' });
    } catch (e: any) {
      toast({ variant: 'destructive', title: 'Connection Failed', description: e.message });
    } finally {
      setIsLoading(false);
    }
  };

  const handleTestPrintKitchen = async () => {
    setIsLoading(true);
    try {
      await printKitchenText("*** KITCHEN TEST ***\n\n\n", 80);
      toast({ title: 'Test Sent', description: 'Check your kitchen printer output.' });
    } catch (e: any) {
      toast({ variant: 'destructive', title: 'Print Failed', description: e.message });
    } finally {
      setIsLoading(false);
    }
  };

  const handleTestPrintBluetooth = async () => {
    setIsLoading(true);
    try {
      await printViaNativeBluetooth({
        target: 'receipt',
        text: `TEST PRINT\n\nPaper: ${paperWidth}mm\nBluetooth OK\n\n\n`,
        widthMm: parseInt(paperWidth) as 58 | 80,
        cut: true,
        beep: false,
      });
      toast({ title: 'Test Sent', description: 'Check your printer output.' });
    } catch (e: any) {
      toast({ variant: 'destructive', title: 'Print Failed', description: e.message });
    } finally {
      setIsLoading(false);
    }
  };

  const handleDarknessChange = async (mode: string) => {
    const address = getLastPrinterAddress();
    if (!address) return;
    try {
      await ThermalPrinter.setPrintDarkness({ mode: mode as PrintDarkness, address });
      setDarkness(mode as PrintDarkness);
    } catch (e: any) {
      toast({ variant: 'destructive', title: 'Could not save darkness', description: e.message });
    }
  };

  const handleDarknessTestPrint = async () => {
    const address = getLastPrinterAddress();
    if (!address) return;
    setIsLoading(true);
    try {
      await ThermalPrinter.connectBluetoothPrinter({ address });
      try {
        await ThermalPrinter.printDarknessTest({ paperWidthMm: parseInt(paperWidth) as 58 | 80 });
      } finally {
        try { await ThermalPrinter.disconnectBluetoothPrinter(); } catch {}
      }
      toast({ title: 'Darkness Test Sent', description: 'Pick the darkest clean section below.' });
    } catch (e: any) {
      toast({ variant: 'destructive', title: 'Print Failed', description: e.message });
    } finally {
      setIsLoading(false);
    }
  };

  const handlePinQrModeChange = (mode: string) => {
    const next = mode as PinQrMode;
    setPinQrMode(next);
    setPinQrModeState(next);
  };

  // Same length as a real join URL, so the samples are the same QR size (v8/v9)
  // and density the customer actually scans.
  const handleQrTestPrint = async () => {
    const address = getLastPrinterAddress();
    if (!address) return;
    setIsLoading(true);
    try {
      const qrData = `https://customer.shareat.net/join?t=QRTEST.${'x'.repeat(100)}`;
      const { qrImageBase64, qrModules } = await renderPinQr(qrData);
      await ThermalPrinter.connectBluetoothPrinter({ address });
      try {
        await ThermalPrinter.printQrTest({
          qrImageBase64,
          qrData,
          qrModules,
          moduleDots: PIN_QR_NATIVE_DOTS,
          paperWidthMm: parseInt(paperWidth) as 58 | 80,
        });
      } finally {
        try { await ThermalPrinter.disconnectBluetoothPrinter(); } catch {}
      }
      toast({ title: 'QR Test Sent', description: 'Scan A-D and pick the cleanest below.' });
    } catch (e: any) {
      toast({ variant: 'destructive', title: 'Print Failed', description: e.message });
    } finally {
      setIsLoading(false);
    }
  };

  const handleSelectUsbPrinter = async () => {
    setIsLoading(true);
    try {
      await printViaWebUSB({ target: 'receipt', text: 'TEST PRINT\n\n\n', cut: true });
      setWebusbSelected(true);
      toast({ title: 'USB Printer Selected', description: 'Ready for WebUSB printing.' });
    } catch (e: any) {
      toast({ variant: 'destructive', title: 'USB Error', description: e.message });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <RoleGuard allow={["admin", "manager", "cashier"]}>
      <div className="max-w-2xl mx-auto p-6 space-y-6">
        <PageHeader title="Settings" description="Printer and device configuration." />

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Bluetooth className="h-5 w-5" /> Bluetooth Printer
            </CardTitle>
            <CardDescription>
              {isNative
                ? 'Select a paired Bluetooth thermal printer for the Android app.'
                : 'Only available in the Android APK build.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {connectedAddress && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Check className="h-4 w-4 text-green-500" />
                Saved: <Badge variant="secondary">{connectedAddress}</Badge>
              </div>
            )}
            {isNative && (
              <>
                <div className="flex gap-2">
                  <Select
                    value={connectedAddress ?? ''}
                    onValueChange={handleConnect}
                    disabled={isLoading || devices.length === 0}
                  >
                    <SelectTrigger className="flex-1">
                      <SelectValue placeholder={devices.length === 0 ? 'No devices found' : 'Select printer'} />
                    </SelectTrigger>
                    <SelectContent>
                      {devices.map(d => (
                        <SelectItem key={d.address} value={d.address}>
                          {d.name} ({d.address})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button variant="outline" onClick={refreshDevices} disabled={isLoading}>
                    <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
                  </Button>
                </div>
                <div className="flex items-center gap-2">
                  <Select value={paperWidth} onValueChange={(v) => setPaperWidth(v as "58" | "80")}>
                    <SelectTrigger className="w-32">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="58">58mm</SelectItem>
                      <SelectItem value="80">80mm</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button onClick={handleTestPrintBluetooth} disabled={isLoading || !connectedAddress}>
                    <Printer className="mr-2 h-4 w-4" /> Print Test
                  </Button>
                </div>
                <div className="space-y-2">
                  <div className="text-sm font-medium">PIN slip QR</div>
                  <div className="flex items-center gap-2">
                    <Select value={pinQrMode} onValueChange={handlePinQrModeChange}>
                      <SelectTrigger className="flex-1">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {PIN_QR_MODES.map(m => (
                          <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button variant="outline" onClick={handleQrTestPrint} disabled={isLoading || !connectedAddress}>
                      <Printer className="mr-2 h-4 w-4" /> QR Test
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    QR Test prints samples A-D on one slip. Scan each, then pick the one that scans first try. Saved on this device.
                  </p>
                </div>
                <div className="space-y-2">
                  <div className="text-sm font-medium">Print darkness</div>
                  <div className="flex items-center gap-2">
                    <Select value={darkness} onValueChange={handleDarknessChange} disabled={!connectedAddress}>
                      <SelectTrigger className="flex-1">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {PRINT_DARKNESS_OPTIONS.map(o => (
                          <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button variant="outline" onClick={handleDarknessTestPrint} disabled={isLoading || !connectedAddress}>
                      <Printer className="mr-2 h-4 w-4" /> Darkness Test
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Darkness Test prints sections 0-3. Pick the number whose section came out darkest without smudging. Applies to every print on this printer. If the test leaves the printer too dark or too light, turn it off and on.
                  </p>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ChefHat className="h-5 w-5" /> Kitchen Printer
            </CardTitle>
            <CardDescription>
              {isNative
                ? 'Select the Bluetooth thermal printer used to back up kitchen tickets during an internet outage.'
                : 'Only available in the Android APK build.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {kitchenAddress && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Check className="h-4 w-4 text-green-500" />
                Saved: <Badge variant="secondary">{kitchenAddress}</Badge>
              </div>
            )}
            {isNative && (
              <>
                <div className="flex gap-2">
                  <Select
                    value={kitchenAddress ?? ''}
                    onValueChange={handleConnectKitchen}
                    disabled={isLoading || devices.length === 0}
                  >
                    <SelectTrigger className="flex-1">
                      <SelectValue placeholder={devices.length === 0 ? 'No devices found' : 'Select printer'} />
                    </SelectTrigger>
                    <SelectContent>
                      {devices.map(d => (
                        <SelectItem key={d.address} value={d.address}>
                          {d.name} ({d.address})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button variant="outline" onClick={refreshDevices} disabled={isLoading}>
                    <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
                  </Button>
                </div>
                <Button onClick={handleTestPrintKitchen} disabled={isLoading || !kitchenAddress}>
                  <Printer className="mr-2 h-4 w-4" /> Test Print
                </Button>
              </>
            )}
          </CardContent>
        </Card>

        <TerminalSection />
        <OutboxSection />
        <DaySection />

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Usb className="h-5 w-5" /> USB Printer (WebUSB)
            </CardTitle>
            <CardDescription>Connect a USB thermal printer directly from the browser.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {webusbSelected && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Check className="h-4 w-4 text-green-500" /> USB printer selected
              </div>
            )}
            <Button variant="outline" onClick={handleSelectUsbPrinter} disabled={!hasWebUSB || isLoading}>
              <Usb className="mr-2 h-4 w-4" /> Select USB Printer
            </Button>
            {!hasWebUSB && (
              <p className="text-sm text-muted-foreground">WebUSB is not supported in this browser.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </RoleGuard>
  );
}

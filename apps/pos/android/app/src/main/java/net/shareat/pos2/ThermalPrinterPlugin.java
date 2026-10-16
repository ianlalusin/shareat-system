package net.shareat.pos2;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothSocket;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.ColorMatrix;
import android.graphics.ColorMatrixColorFilter;
import android.graphics.Paint;
import android.graphics.Rect;
import android.os.Build;
import android.util.Base64;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONArray;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.Charset;
import java.util.Set;
import java.util.UUID;

@CapacitorPlugin(
    name = "ThermalPrinter",
    permissions = {
        @Permission(
            alias = "bluetooth",
            strings = {
                Manifest.permission.BLUETOOTH,
                Manifest.permission.BLUETOOTH_ADMIN
            }
        ),
        @Permission(
            alias = "bluetooth_connect",
            strings = {
                "android.permission.BLUETOOTH_CONNECT",
                "android.permission.BLUETOOTH_SCAN"
            }
        )
    }
)
public class ThermalPrinterPlugin extends Plugin {
    private static final String TAG = "ThermalPrinter";
    private static final UUID SPP_UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");

    private BluetoothAdapter bluetoothAdapter;
    private BluetoothSocket bluetoothSocket;
    private OutputStream outputStream;
    private String connectedAddress;
    private static final int MAX_RETRIES = 3;
    private static final int RETRY_DELAY_MS = 1500;

    // How the PIN-slip QR reaches the paper (qrMode). See writeQrBlock.
    private static final String QR_MODE_TRIM   = "raster-trim";
    private static final String QR_MODE_MARGIN = "raster-margin";
    private static final String QR_MODE_FULL   = "raster-full";
    private static final String QR_MODE_NATIVE = "native";

    // Print darkness, saved per printer address (see setPrintDarkness). There is no
    // one ESC/POS darkness command: which of these a printer obeys is found by the
    // darkness test slip. "normal" sends nothing, so it can never break a printer.
    private static final String DARK_NORMAL  = "normal";
    private static final String DARK_EPSON   = "density-gs";  // GS ( K 49: Epson-style density
    private static final String DARK_DC2     = "density-dc2"; // DC2 #: CSN/Xprinter-style density
    private static final String DARK_HEAT    = "heat-esc7";   // ESC 7: longer heating time
    private static final String PREFS_NAME   = "thermalPrinter";
    // Delays before each connect attempt (ms). First attempt is immediate; subsequent
    // ones wait progressively longer for another app (e.g. GrabFood) to release the socket.
    private static final int[] CONNECT_RETRY_DELAYS_MS = {0, 1500, 3000, 5000};

    @Override
    public void load() {
        bluetoothAdapter = BluetoothAdapter.getDefaultAdapter();
    }

    private boolean checkBluetoothPermissions() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            return getPermissionState("bluetooth_connect") == PermissionState.GRANTED;
        } else {
            return getPermissionState("bluetooth") == PermissionState.GRANTED;
        }
    }

    @PluginMethod
    public void listBluetoothPrinters(PluginCall call) {
        if (!checkBluetoothPermissions()) {
            requestPermissionForAlias(Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? "bluetooth_connect" : "bluetooth", call, "permissionCallback");
            return;
        }
        if (bluetoothAdapter == null) {
            call.reject("Bluetooth not supported on this device.");
            return;
        }
        Set<BluetoothDevice> pairedDevices = bluetoothAdapter.getBondedDevices();
        JSONArray devicesArray = new JSONArray();
        for (BluetoothDevice device : pairedDevices) {
            JSObject deviceObj = new JSObject();
            deviceObj.put("name", device.getName());
            deviceObj.put("address", device.getAddress());
            devicesArray.put(deviceObj);
        }
        JSObject ret = new JSObject();
        ret.put("devices", devicesArray);
        call.resolve(ret);
    }

    @PermissionCallback
    private void permissionCallback(PluginCall call) {
        if (checkBluetoothPermissions()) {
            if ("listBluetoothPrinters".equals(call.getMethodName())) {
                listBluetoothPrinters(call);
            } else {
                call.resolve();
            }
        } else {
            call.reject("Bluetooth permissions are required for printing.");
        }
    }

    @PluginMethod
    public void connectBluetoothPrinter(PluginCall call) {
        if (!checkBluetoothPermissions()) {
            requestPermissionForAlias(Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? "bluetooth_connect" : "bluetooth", call, "permissionCallback");
            return;
        }
        String address = call.getString("address");
        if (address == null) {
            call.reject("Printer address is required.");
            return;
        }
        try {
            // Reuse existing connection if healthy
            if (bluetoothSocket != null && bluetoothSocket.isConnected() && address.equals(bluetoothSocket.getRemoteDevice().getAddress())) {
                // Verify socket is truly alive with a zero-byte write
                try {
                    outputStream.write(new byte[0]);
                    outputStream.flush();
                    call.resolve();
                    return;
                } catch (Exception ignored) {
                    // Socket is dead — fall through to reconnect
                    disconnect();
                }
            }
            disconnect();
            if (bluetoothAdapter.isDiscovering()) {
                bluetoothAdapter.cancelDiscovery();
            }
            connectWithRetry(address);
            call.resolve();
        } catch (Exception e) {
            Log.e(TAG, "Connection failed", e);
            disconnect();
            call.reject("Connection failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void disconnectBluetoothPrinter(PluginCall call) {
        disconnect();
        call.resolve();
    }

    @PluginMethod
    public void printReceipt(PluginCall call) {
        String text = call.getString("text");
        String encoding = call.getString("encoding", "CP437");
        Boolean skipInit = call.getBoolean("skipInit", false);
        Boolean cut = call.getBoolean("cut", false);
        Boolean beep = call.getBoolean("beep", false);
        String font = call.getString("font", "normal"); // small=Font B, normal=Font A, large=double-height

        if (outputStream == null) {
            call.reject("Printer not connected.");
            return;
        }

        Exception lastError = null;
        for (int attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            try {
                if (!skipInit) {
                    outputStream.write(new byte[]{0x1B, 0x40});
                }
                writeDarkness(darknessFor(connectedAddress));
                // Built-in font + size for the whole body. Thermal printers only
                // have ROM fonts: Font A (normal) and the denser Font B (small).
                // "large" doubles the height only — character WIDTH is unchanged,
                // so column alignment is preserved (the formatter lays out the
                // matching characters-per-line for each mode).
                byte fontSel = (byte) ("small".equals(font) ? 0x01 : 0x00); // ESC M: 0=Font A, 1=Font B
                outputStream.write(new byte[]{0x1B, 0x4D, fontSel});
                byte sizeSel = (byte) ("large".equals(font) ? 0x01 : 0x00); // GS !: 0x01 = double height
                outputStream.write(new byte[]{0x1D, 0x21, sizeSel});
                outputStream.write(new byte[]{0x1B, 0x61, 0x00});
                try {
                    outputStream.write(text.getBytes(encoding));
                } catch (Exception e) {
                    outputStream.write(text.getBytes(Charset.forName("UTF-8")));
                }
                outputStream.write(new byte[]{0x0A, 0x0A, 0x0A, 0x0A});
                if (cut) {
                    outputStream.write(new byte[]{0x1D, 0x56, 0x41, 0x03});
                }
                if (beep) {
                    outputStream.write(new byte[]{0x1B, 0x42, 0x02, 0x02});
                }
                outputStream.flush();
                call.resolve();
                return;
            } catch (IOException e) {
                lastError = e;
                Log.w(TAG, "printReceipt attempt " + (attempt + 1) + " failed: " + e.getMessage());
                if (attempt < MAX_RETRIES) {
                    try {
                        Thread.sleep(RETRY_DELAY_MS);
                        reconnect();
                    } catch (Exception re) {
                        Log.e(TAG, "Reconnect failed", re);
                    }
                }
            } catch (Exception e) {
                call.reject("Print failed: " + e.getMessage());
                return;
            }
        }
        call.reject("Print failed after retries: " + (lastError != null ? lastError.getMessage() : "unknown"));
    }

    @PluginMethod
    public void printPinSlip(PluginCall call) {
        String topText        = call.getString("top", "");
        String bottomText     = call.getString("bottom", "");
        String qrData         = call.getString("qrData", "https://customer.shareat.net");
        int    qrSize         = call.getInt("qrSize", 4);
        String encoding       = call.getString("encoding", "CP437");
        String qrImageBase64  = call.getString("qrImageBase64", "");
        int    paperWidthMm   = call.getInt("paperWidthMm", 80);
        // Absent → the pre-2026-09 behaviour (full-width raster, or native when no image).
        String qrMode         = call.getString("qrMode", QR_MODE_FULL);
        int    qrModules      = call.getInt("qrModules", 0);

        if (outputStream == null) {
            call.reject("Printer not connected.");
            return;
        }

        Exception lastError = null;
        for (int attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            boolean qrStarted = false;
            try {
                // Init + slow down print speed
            outputStream.write(new byte[]{0x1B, 0x40});
            writeDarkness(darknessFor(connectedAddress));
            outputStream.flush();
            Thread.sleep(300);

            // TOP TEXT — centered, per-line styles (see writePinSlipLines)
            if (topText != null && !topText.isEmpty()) {
                writePinSlipLines(topText, encoding);
            }
            outputStream.flush();
            Thread.sleep(400);

            // QR CODE
            // Pad above the QR so the top row of modules isn't clipped by the
            // previous line's print-head trailing ink.
            outputStream.write(new byte[]{0x0A, 0x0A});
            outputStream.flush();

            // From here on a failure must not retry: a half-sent GS v 0 leaves the
            // printer waiting for raster bytes, so a retry's ESC @ + text would be
            // swallowed as image data and print as streaks, then a second slip.
            qrStarted = true;
            writeQrBlock(qrMode, qrImageBase64, qrData, qrSize, qrModules, paperWidthMm);
            outputStream.write(new byte[]{0x0A, 0x0A});
            outputStream.flush();
            Thread.sleep(300);

            // BOTTOM TEXT — PIN line gets double height/width, rest per-line styles
            if (bottomText != null && !bottomText.isEmpty()) {
                setLeftMargin(0); // never let a QR's margin shift the PIN off-centre
                writePinSlipLines(bottomText, encoding);
            }

            // Feed + cut
            outputStream.write(new byte[]{0x0A, 0x0A, 0x0A, 0x0A});
            outputStream.write(new byte[]{0x1D, 0x56, 0x41, 0x03});
            outputStream.flush();
            call.resolve();
                return;
            } catch (IOException e) {
                lastError = e;
                Log.w(TAG, "printPinSlip attempt " + (attempt + 1) + " failed: " + e.getMessage());
                if (qrStarted) {
                    call.reject("Printing stopped partway through the QR. Press Print again.");
                    return;
                }
                if (attempt < MAX_RETRIES) {
                    try {
                        Thread.sleep(RETRY_DELAY_MS);
                        reconnect();
                    } catch (Exception re) {
                        Log.e(TAG, "Reconnect failed", re);
                    }
                }
            } catch (Exception e) {
                call.reject("printPinSlip failed: " + e.getMessage());
                return;
            }
        }
        call.reject("printPinSlip failed after retries: " + (lastError != null ? lastError.getMessage() : "unknown"));
    }

    @PluginMethod
    public void printQRCode(PluginCall call) {
        String data = call.getString("data");
        int size = call.getInt("size", 4);

        if (outputStream == null) {
            call.reject("Printer not connected.");
            return;
        }
        if (data == null || data.isEmpty()) {
            call.reject("QR data is required.");
            return;
        }

        Exception lastError = null;
        for (int attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            try {
            byte[] dataBytes = data.getBytes("UTF-8");
            int dataLen = dataBytes.length;
            writeDarkness(darknessFor(connectedAddress));
            outputStream.write(new byte[]{0x1B, 0x61, 0x01});
            outputStream.write(new byte[]{0x1D, 0x28, 0x6B, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00});
            outputStream.write(new byte[]{0x1D, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x43, (byte) size});
            outputStream.write(new byte[]{0x1D, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x45, 0x31});
            int storeLen = dataLen + 3;
            byte pL = (byte)(storeLen & 0xFF);
            byte pH = (byte)((storeLen >> 8) & 0xFF);
            outputStream.write(new byte[]{0x1D, 0x28, 0x6B, pL, pH, 0x31, 0x50, 0x30});
            outputStream.write(dataBytes);
            outputStream.write(new byte[]{0x1D, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x51, 0x30});
            outputStream.write(new byte[]{0x1B, 0x61, 0x00});
            outputStream.write(new byte[]{0x0A});
            outputStream.flush();
            call.resolve();
                return;
            } catch (IOException e) {
                lastError = e;
                Log.w(TAG, "printQRCode attempt " + (attempt + 1) + " failed: " + e.getMessage());
                if (attempt < MAX_RETRIES) {
                    try {
                        Thread.sleep(RETRY_DELAY_MS);
                        reconnect();
                    } catch (Exception re) {
                        Log.e(TAG, "Reconnect failed", re);
                    }
                }
            } catch (Exception e) {
                call.reject("QR print failed: " + e.getMessage());
                return;
            }
        }
        call.reject("QR print failed after retries: " + (lastError != null ? lastError.getMessage() : "unknown"));
    }

    @PluginMethod
    public void printImage(PluginCall call) {
        String base64 = call.getString("base64");
        int widthMm = call.getInt("widthMm", 80);
        String align = call.getString("align", "center");
        int widthPct = call.getInt("widthPct", 0); // receipt "logo width %" (20-100); 0 = unset

        if (outputStream == null) {
            call.reject("Printer not connected.");
            return;
        }
        if (base64 == null || base64.isEmpty()) {
            call.reject("base64 image data is required.");
            return;
        }

        Exception lastError = null;
        for (int attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            try {
                // Decode base64 to bitmap
                byte[] imageBytes = Base64.decode(base64, Base64.DEFAULT);
                Bitmap original = BitmapFactory.decodeByteArray(imageBytes, 0, imageBytes.length);
                if (original == null) {
                    call.reject("Failed to decode image.");
                    return;
                }

                // Max print width in dots (203 dpi): 58mm ≈ 384 dots, 80mm ≈ 576 dots
                int maxWidthPx = widthMm == 58 ? 384 : 576;
                // Logo print width. The receipt settings expose a "logo width %"
                // (logoWidthPct, 20-100); honor it as a fraction of the paper
                // width so the size control actually takes effect. Fall back to
                // ~67% of the head when unset, so a square brand mark doesn't eat
                // a huge band of paper.
                int targetCap;
                if (widthPct >= 20 && widthPct <= 100) {
                    targetCap = Math.round(maxWidthPx * widthPct / 100f);
                } else {
                    targetCap = Math.round(maxWidthPx * 0.67f);
                }
                if (targetCap < 48) targetCap = 48;
                if (targetCap > maxWidthPx) targetCap = maxWidthPx;

                // Many uploaded logos are a small mark centered on a large, mostly
                // TRANSPARENT canvas. Printed as-is, two things go wrong:
                //   1) transparent pixels (alpha 0, rgb 0) threshold to BLACK, so
                //      the background prints as a solid black square; and
                //   2) scaling the whole canvas shrinks the actual mark to a tiny
                //      blob lost in white space.
                // So crop to the visible (non-transparent) content first, scale
                // that to a sane width, then flatten onto WHITE before threshold.
                Rect bounds = contentBounds(original);
                Bitmap content = original;
                if (bounds != null
                        && (bounds.width() < original.getWidth() || bounds.height() < original.getHeight())) {
                    content = Bitmap.createBitmap(original, bounds.left, bounds.top,
                            bounds.width(), bounds.height());
                    original.recycle();
                }

                int targetWidth = Math.min(content.getWidth(), targetCap);
                float ratio = (float) targetWidth / content.getWidth();
                int targetHeight = Math.max(1, Math.round(content.getHeight() * ratio));
                Bitmap scaled = Bitmap.createScaledBitmap(content, targetWidth, targetHeight, true);

                // Flatten any transparency onto white so the background prints
                // blank, not black, then convert to 1-bit.
                Bitmap opaque = flattenOnWhite(scaled);
                if (scaled != content) scaled.recycle();
                content.recycle();
                Bitmap mono = toMonochrome(opaque, targetWidth, targetHeight);
                opaque.recycle();

                // Build ESC/POS raster data
                byte[] rasterData = bitmapToEscPosRaster(mono, maxWidthPx);
                mono.recycle();
                writeDarkness(darknessFor(connectedAddress));

                // Set alignment
                byte alignByte = 0x01; // center
                if ("left".equals(align)) alignByte = 0x00;
                else if ("right".equals(align)) alignByte = 0x02;
                outputStream.write(new byte[]{0x1B, 0x61, alignByte});

                // Write raster data in small chunks with brief pauses. A single
                // ~30KB write overruns the Bluetooth input buffer on cheap
                // printers, dropping bytes mid-raster; that desyncs the GS v 0
                // command so the logo prints incomplete and the following text
                // bytes get rendered as garbage "letter codes" (or not at all).
                // Chunking — same as the QR raster path — keeps the stream intact.
                writeChunked(rasterData, 512, 30);

                // Reset alignment to left
                outputStream.write(new byte[]{0x1B, 0x61, 0x00});
                outputStream.flush();
                call.resolve();
                return;
            } catch (IOException e) {
                lastError = e;
                Log.w(TAG, "printImage attempt " + (attempt + 1) + " failed: " + e.getMessage());
                if (attempt < MAX_RETRIES) {
                    try {
                        Thread.sleep(RETRY_DELAY_MS);
                        reconnect();
                    } catch (Exception re) {
                        Log.e(TAG, "Reconnect failed", re);
                    }
                }
            } catch (Exception e) {
                call.reject("printImage failed: " + e.getMessage());
                return;
            }
        }
        call.reject("printImage failed after retries: " + (lastError != null ? lastError.getMessage() : "unknown"));
    }

    /**
     * Writes PIN-slip text centred, one line at a time:
     *  - a line of exactly 6 uppercase letters/digits is the PIN: bold, double width+height
     *  - a line starting with "**" is bold at normal size (the marker is not printed)
     *  - anything else is normal
     * Ends with normal size and bold off.
     */
    private void writePinSlipLines(String text, String encoding) throws IOException {
        outputStream.write(new byte[]{0x1B, 0x61, 0x01}); // center
        for (String line : text.split("\n", -1)) {
            boolean isPinLine = line.trim().matches("[A-Z0-9]{6}");
            boolean isBold = line.startsWith("**");
            if (isBold) line = line.substring(2);
            outputStream.write(new byte[]{0x1D, 0x21, (byte) (isPinLine ? 0x11 : 0x00)});
            outputStream.write(new byte[]{0x1B, 0x45, (byte) (isPinLine || isBold ? 0x01 : 0x00)});
            try { outputStream.write((line + "\n").getBytes(encoding)); }
            catch (Exception e) { outputStream.write((line + "\n").getBytes("UTF-8")); }
        }
        outputStream.write(new byte[]{0x1D, 0x21, 0x00});
        outputStream.write(new byte[]{0x1B, 0x45, 0x00});
    }

    /** Saves the darkness for one printer address. Read back on every print to it. */
    @PluginMethod
    public void setPrintDarkness(PluginCall call) {
        String address = call.getString("address", connectedAddress);
        String mode = call.getString("mode", DARK_NORMAL);
        if (address == null || address.isEmpty()) {
            call.reject("No printer address.");
            return;
        }
        prefs().edit().putString("darkness:" + address, normalizeDarkness(mode)).apply();
        call.resolve();
    }

    @PluginMethod
    public void getPrintDarkness(PluginCall call) {
        String address = call.getString("address", connectedAddress);
        JSObject ret = new JSObject();
        ret.put("mode", darknessFor(address));
        call.resolve(ret);
    }

    /**
     * One slip: the same sample under each darkness command, labelled, so the cashier
     * can see which command this printer obeys. A command the printer does not know
     * is ignored or prints a few junk characters. Each darker section restores that
     * command's normal value after itself; power-cycling the printer also clears all.
     */
    @PluginMethod
    public void printDarknessTest(PluginCall call) {
        int paperDots = paperWidthDots(call.getInt("paperWidthMm", 80));
        if (outputStream == null) {
            call.reject("Printer not connected.");
            return;
        }
        String[][] sections = {
            {DARK_NORMAL, "0  Normal (nothing sent)"},
            {DARK_EPSON,  "1  Density - GS ( K"},
            {DARK_DC2,    "2  Density - DC2 #"},
            {DARK_HEAT,   "3  Heat - ESC 7"},
        };
        try {
            outputStream.write(new byte[]{0x1B, 0x40});
            outputStream.write(new byte[]{0x1B, 0x61, 0x01});
            outputStream.write("DARKNESS TEST\nPick the darkest clean section.\n\n".getBytes("US-ASCII"));
            outputStream.flush();
            Thread.sleep(300);
            for (String[] section : sections) {
                writeDarkness(section[0]);
                outputStream.write(new byte[]{0x1B, 0x61, 0x01});
                outputStream.write(new byte[]{0x1B, 0x45, 0x00});
                outputStream.write((section[1] + "\n").getBytes("US-ASCII"));
                outputStream.write("Scan the QR code or go to\n".getBytes("US-ASCII"));
                outputStream.write(new byte[]{0x1B, 0x45, 0x01});
                outputStream.write("CUSTOMER.SHAREAT.NET\n".getBytes("US-ASCII"));
                outputStream.write(new byte[]{0x1D, 0x21, 0x11});
                outputStream.write("K7Q2ZX\n".getBytes("US-ASCII"));
                outputStream.write(new byte[]{0x1D, 0x21, 0x00});
                outputStream.write(new byte[]{0x1B, 0x45, 0x00});
                // Solid bar: shows darkness and any faint streaks at a glance.
                writeChunked(solidBar(paperDots / 2, 24, paperDots), 512, 30);
                outputStream.write(new byte[]{0x0A, 0x0A});
                writeDarknessRestore(section[0]);
                outputStream.flush();
                Thread.sleep(400);
            }
            outputStream.write(new byte[]{0x0A, 0x0A, 0x0A, 0x0A});
            outputStream.write(new byte[]{0x1D, 0x56, 0x41, 0x03});
            outputStream.flush();
            call.resolve();
        } catch (Exception e) {
            call.reject("printDarknessTest failed: " + e.getMessage());
        }
    }

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS_NAME, android.content.Context.MODE_PRIVATE);
    }

    private String normalizeDarkness(String mode) {
        if (DARK_EPSON.equals(mode) || DARK_DC2.equals(mode) || DARK_HEAT.equals(mode)) return mode;
        return DARK_NORMAL;
    }

    private String darknessFor(String address) {
        if (address == null) return DARK_NORMAL;
        return normalizeDarkness(prefs().getString("darkness:" + address, DARK_NORMAL));
    }

    /** Sends the darker setting for a mode. Normal sends nothing at all. */
    private void writeDarkness(String mode) throws IOException {
        if (DARK_EPSON.equals(mode)) {
            // GS ( K pL pH fn=49 m: m = 1..6 darker than standard. +6 = darkest.
            outputStream.write(new byte[]{0x1D, 0x28, 0x4B, 0x02, 0x00, 0x31, 0x06});
        } else if (DARK_DC2.equals(mode)) {
            // DC2 # n: bits 0-4 density (50% + 5% x n), bits 5-7 break time.
            // n = (2 << 5) | 20 -> 150% density.
            outputStream.write(new byte[]{0x12, 0x23, (byte) ((2 << 5) | 20)});
        } else if (DARK_HEAT.equals(mode)) {
            // ESC 7 n1 n2 n3: max heating dots (8 x (n1+1)), heating time (10us units),
            // heating interval (10us). Common default 7/80/2; 160 = twice the heat time.
            outputStream.write(new byte[]{0x1B, 0x37, 0x07, (byte) 160, 0x02});
        }
    }

    /** Puts one darkness command back to its usual default (test slip only). */
    private void writeDarknessRestore(String mode) throws IOException {
        if (DARK_EPSON.equals(mode)) {
            outputStream.write(new byte[]{0x1D, 0x28, 0x4B, 0x02, 0x00, 0x31, 0x00});
        } else if (DARK_DC2.equals(mode)) {
            outputStream.write(new byte[]{0x12, 0x23, (byte) ((2 << 5) | 10)});
        } else if (DARK_HEAT.equals(mode)) {
            outputStream.write(new byte[]{0x1B, 0x37, 0x07, 80, 0x02});
        }
    }

    private int paperWidthDots(int paperWidthMm) {
        return paperWidthMm == 58 ? 384 : 576;
    }

    /** A centred solid black bar as one GS v 0 raster, rows padded to the left edge only. */
    private byte[] solidBar(int widthDots, int rows, int paperDots) {
        int barBytes = widthDots / 8;
        int padBytes = Math.max(0, (paperDots / 8 - barBytes) / 2);
        int rowBytes = padBytes + barBytes;
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        baos.write(0x1D); baos.write(0x76); baos.write(0x30); baos.write(0x00);
        baos.write(rowBytes & 0xFF); baos.write((rowBytes >> 8) & 0xFF);
        baos.write(rows & 0xFF); baos.write((rows >> 8) & 0xFF);
        for (int r = 0; r < rows; r++) {
            for (int i = 0; i < rowBytes; i++) baos.write(i < padBytes ? 0x00 : 0xFF);
        }
        return baos.toByteArray();
    }

    /**
     * Prints one labelled QR per mode on a single slip, so the cashier can scan each
     * and keep the one this printer renders cleanly. Native goes last: a printer
     * without GS ( k support may print its bytes as junk text, which must not
     * spoil the raster samples above it.
     */
    @PluginMethod
    public void printQrTest(PluginCall call) {
        String qrImageBase64 = call.getString("qrImageBase64", "");
        String qrData        = call.getString("qrData", "https://customer.shareat.net");
        int    qrModules     = call.getInt("qrModules", 0);
        int    moduleDots    = call.getInt("moduleDots", 5);
        int    paperWidthMm  = call.getInt("paperWidthMm", 80);

        if (outputStream == null) {
            call.reject("Printer not connected.");
            return;
        }
        String[][] samples = {
            {QR_MODE_TRIM,   "A  Trimmed image"},
            {QR_MODE_MARGIN, "B  Image + left margin"},
            {QR_MODE_FULL,   "C  Full-width image (old)"},
            {QR_MODE_NATIVE, "D  Printer-drawn"},
        };
        try {
            outputStream.write(new byte[]{0x1B, 0x40});
            writeDarkness(darknessFor(connectedAddress));
            outputStream.write(new byte[]{0x1B, 0x61, 0x01});
            outputStream.write("PIN QR TEST\nScan each. Keep the best.\n\n".getBytes("US-ASCII"));
            outputStream.flush();
            Thread.sleep(300);
            for (String[] sample : samples) {
                setLeftMargin(0);
                outputStream.write(new byte[]{0x1B, 0x61, 0x01});
                outputStream.write((sample[1] + "\n\n").getBytes("US-ASCII"));
                outputStream.flush();
                writeQrBlock(sample[0], qrImageBase64, qrData, moduleDots, qrModules, paperWidthMm);
                outputStream.write(new byte[]{0x0A, 0x0A, 0x0A});
                outputStream.flush();
                Thread.sleep(400);
            }
            outputStream.write(new byte[]{0x0A, 0x0A, 0x0A, 0x0A});
            outputStream.write(new byte[]{0x1D, 0x56, 0x41, 0x03});
            outputStream.flush();
            call.resolve();
        } catch (Exception e) {
            call.reject("printQrTest failed: " + e.getMessage());
        }
    }

    /**
     * Sends the QR in the given mode. Leaves alignment left and the left margin reset.
     *
     *  raster-trim   - image rows carry only the left padding + the QR, not the blank
     *                  right half. Centred by padding alone, so no command support needed.
     *  raster-margin - rows carry only the QR; GS L shifts it to centre. Least image data.
     *  raster-full   - every row padded to the full paper width (the pre-2026-09 path).
     *  native        - the printer draws the QR from the text (GS ( k), centred with
     *                  GS L because this firmware ignores ESC a for GS ( k. ~200 bytes.
     */
    private void writeQrBlock(String mode, String qrImageBase64, String qrData,
                              int moduleDots, int qrModules, int paperWidthMm) throws Exception {
        int maxWidthPx = paperWidthMm == 58 ? 384 : 576;
        boolean haveImage = qrImageBase64 != null && !qrImageBase64.isEmpty();
        if (!haveImage) mode = QR_MODE_NATIVE;

        outputStream.write(new byte[]{0x1B, 0x61, 0x00}); // left: centring is done here
        outputStream.flush();

        if (QR_MODE_NATIVE.equals(mode)) {
            int dots = Math.max(1, Math.min(16, moduleDots));
            // Centre the symbol; the printer adds its own quiet zone. Unknown size: no shift.
            int marginDots = qrModules > 0 ? Math.max(0, (maxWidthPx - qrModules * dots) / 2) : 0;
            setLeftMargin(marginDots);
            byte[] qrBytes = qrData.getBytes("UTF-8");
            int storeLen = qrBytes.length + 3;
            byte pL = (byte)(storeLen & 0xFF);
            byte pH = (byte)((storeLen >> 8) & 0xFF);
            outputStream.write(new byte[]{0x1D, 0x28, 0x6B, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00}); // model 2
            outputStream.write(new byte[]{0x1D, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x43, (byte) dots}); // module size
            outputStream.write(new byte[]{0x1D, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x45, 0x31}); // ECC M
            outputStream.write(new byte[]{0x1D, 0x28, 0x6B, pL, pH, 0x31, 0x50, 0x30}); // store data
            outputStream.write(qrBytes);
            outputStream.write(new byte[]{0x1D, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x51, 0x30}); // print
            outputStream.flush();
            Thread.sleep(500);
            resetLeftMargin();
            return;
        }

        byte[] imgBytes = Base64.decode(qrImageBase64, Base64.DEFAULT);
        Bitmap qrSrc = BitmapFactory.decodeByteArray(imgBytes, 0, imgBytes.length);
        if (qrSrc == null) throw new IOException("Failed to decode qrImageBase64.");
        // Threshold to 1-bit without dithering (preserves QR module crispness).
        Bitmap qrMono = qrToMonochrome(qrSrc);
        qrSrc.recycle();

        int paperBytes = (maxWidthPx + 7) / 8;
        int imgRowBytes = (qrMono.getWidth() + 7) / 8;
        int padBytes = Math.max(0, (paperBytes - imgRowBytes) / 2);

        byte[] raster;
        if (QR_MODE_MARGIN.equals(mode)) {
            setLeftMargin(padBytes * 8);
            raster = bitmapToEscPosRaster(qrMono, imgRowBytes, 0);
        } else if (QR_MODE_TRIM.equals(mode)) {
            raster = bitmapToEscPosRaster(qrMono, padBytes + imgRowBytes, padBytes);
        } else {
            raster = bitmapToEscPosRaster(qrMono, maxWidthPx);
        }
        qrMono.recycle();

        // Stream the raster in small chunks with brief pauses so the printer's
        // Bluetooth buffer can drain between writes. A full-width 80mm QR raster
        // is ~15KB and overflows many printer buffers if sent in one shot -
        // symptoms are mid-QR truncation followed by garbage as the printer
        // mis-reads the remaining raster bytes as ESC/POS commands.
        writeChunked(raster, 512, 30);
        if (QR_MODE_MARGIN.equals(mode)) resetLeftMargin();
    }

    /**
     * Ends the QR's line, then clears GS L. The store printer ignored a GS L 0 sent
     * straight after the QR (test slip 2026-09-24: every later line printed shifted
     * right), so the reset goes out only once a line feed has put it at line start.
     */
    private void resetLeftMargin() throws IOException {
        outputStream.write(new byte[]{0x0A});
        setLeftMargin(0);
        outputStream.flush();
    }

    /** GS L nL nH - left margin in dots. Only takes effect at the start of a line. */
    private void setLeftMargin(int dots) throws IOException {
        outputStream.write(new byte[]{0x1D, 0x4C, (byte)(dots & 0xFF), (byte)((dots >> 8) & 0xFF)});
    }

    /**
     * Write a large byte buffer to the printer in fixed-size chunks with a
     * brief pause between each. Prevents Bluetooth buffer overflow on
     * printers with small input buffers (which would otherwise drop bytes
     * mid-stream and corrupt the in-flight ESC/POS command).
     */
    private void writeChunked(byte[] data, int chunkSize, int sleepMs) throws Exception {
        int offset = 0;
        while (offset < data.length) {
            int len = Math.min(chunkSize, data.length - offset);
            outputStream.write(data, offset, len);
            outputStream.flush();
            if (sleepMs > 0) Thread.sleep(sleepMs);
            offset += len;
        }
    }

    /**
     * QR-specific monochrome conversion: pure threshold, no dithering.
     * Dithering would scatter the QR module edges with noise pixels and
     * could break scanability. Source is expected to already be near-B&W
     * (PNG from a QR generator), so a simple threshold is correct.
     */
    private Bitmap qrToMonochrome(Bitmap src) {
        int w = src.getWidth();
        int h = src.getHeight();
        int[] pixels = new int[w * h];
        src.getPixels(pixels, 0, w, 0, 0, w, h);

        Bitmap mono = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
        int[] out = new int[w * h];
        for (int i = 0; i < pixels.length; i++) {
            int p = pixels[i];
            // Use luminance-ish (average of RGB) since src might not be desaturated.
            int r = (p >> 16) & 0xFF;
            int g = (p >> 8) & 0xFF;
            int b = p & 0xFF;
            int gray = (r + g + b) / 3;
            out[i] = gray < 128 ? 0xFF000000 : 0xFFFFFFFF;
        }
        mono.setPixels(out, 0, w, 0, 0, w, h);
        return mono;
    }

    /**
     * Bounding box of the visible (sufficiently opaque) content in an image,
     * computed on a downscaled probe for speed, then mapped back to source
     * coordinates. Returns null if the image is effectively fully transparent.
     * Lets us crop away the large transparent margins many logos ship with.
     */
    private Rect contentBounds(Bitmap src) {
        int sw = src.getWidth();
        int sh = src.getHeight();
        if (sw <= 0 || sh <= 0) return null;

        // Probe at most ~256px on the long edge — enough to locate the margins
        // without scanning millions of pixels on big uploads.
        int probeMax = 256;
        float s = Math.min(1f, (float) probeMax / Math.max(sw, sh));
        int pw = Math.max(1, Math.round(sw * s));
        int ph = Math.max(1, Math.round(sh * s));
        Bitmap probe = Bitmap.createScaledBitmap(src, pw, ph, true);
        int[] px = new int[pw * ph];
        probe.getPixels(px, 0, pw, 0, 0, pw, ph);
        if (probe != src) probe.recycle();

        int minX = pw, minY = ph, maxX = -1, maxY = -1;
        for (int y = 0; y < ph; y++) {
            int row = y * pw;
            for (int x = 0; x < pw; x++) {
                int alpha = (px[row + x] >>> 24) & 0xFF;
                if (alpha > 24) { // visible enough to count as content
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                }
            }
        }
        if (maxX < 0) return null; // nothing visible

        // Map back to source coords with a small padding margin.
        float inv = 1f / s;
        int pad = 2;
        int left = Math.max(0, Math.round((minX - pad) * inv));
        int top = Math.max(0, Math.round((minY - pad) * inv));
        int right = Math.min(sw, Math.round((maxX + 1 + pad) * inv));
        int bottom = Math.min(sh, Math.round((maxY + 1 + pad) * inv));
        if (right <= left || bottom <= top) return null;
        return new Rect(left, top, right, bottom);
    }

    /** Composite an image onto an opaque white background (drops alpha). */
    private Bitmap flattenOnWhite(Bitmap src) {
        int w = src.getWidth();
        int h = src.getHeight();
        Bitmap out = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(out);
        canvas.drawColor(Color.WHITE);
        canvas.drawBitmap(src, 0, 0, null);
        return out;
    }

    /**
     * Convert a bitmap to monochrome using a simple luminance threshold.
     */
    private Bitmap toMonochrome(Bitmap src, int w, int h) {
        // Convert to grayscale
        Bitmap grayscale = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(grayscale);
        Paint paint = new Paint();
        ColorMatrix cm = new ColorMatrix();
        cm.setSaturation(0);
        paint.setColorFilter(new ColorMatrixColorFilter(cm));
        canvas.drawBitmap(src, 0, 0, paint);

        // Threshold to 1-bit
        int[] pixels = new int[w * h];
        grayscale.getPixels(pixels, 0, w, 0, 0, w, h);
        grayscale.recycle();

        Bitmap mono = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
        int[] monoPixels = new int[w * h];
        for (int i = 0; i < pixels.length; i++) {
            int gray = pixels[i] & 0xFF; // blue channel (same as R and G after desaturation)
            monoPixels[i] = gray < 128 ? 0xFF000000 : 0xFFFFFFFF;
        }
        mono.setPixels(monoPixels, 0, w, 0, 0, w, h);
        return mono;
    }

    /**
     * Convert a monochrome bitmap to ESC/POS GS v 0 raster, emitted as a series of
     * short horizontal BANDS (one GS v 0 command per band). A single tall raster can
     * overflow a buffer-limited Bluetooth printer and corrupt the middle of the image;
     * banding keeps each command small and gives the firmware a re-sync point between
     * commands. Each row is left-padded so the image is centered within the printer's
     * full dot width (maxWidthPx).
     */
    private byte[] bitmapToEscPosRaster(Bitmap mono, int maxWidthPx) {
        // Bytes per row — must cover full printer width for proper centering
        int bytesPerRow = (maxWidthPx + 7) / 8;
        int imgBytesPerRow = (mono.getWidth() + 7) / 8;
        int leftPadBytes = (bytesPerRow - imgBytesPerRow) / 2;
        if (leftPadBytes < 0) leftPadBytes = 0;
        return bitmapToEscPosRaster(mono, bytesPerRow, leftPadBytes);
    }

    /** As above, with the row width and left padding (both in bytes) chosen by the caller. */
    private byte[] bitmapToEscPosRaster(Bitmap mono, int bytesPerRow, int leftPadBytes) {
        int imgWidth = mono.getWidth();
        int imgHeight = mono.getHeight();

        // Rows per GS v 0 command. Small bands print reliably on cheap printers.
        final int BAND_ROWS = 24;

        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        int[] rowPixels = new int[imgWidth];

        for (int bandStart = 0; bandStart < imgHeight; bandStart += BAND_ROWS) {
            int bandRows = Math.min(BAND_ROWS, imgHeight - bandStart);

            // GS v 0: 1D 76 30 m xL xH yL yH [data]
            // m=0 (normal), xL/xH = bytes per row, yL/yH = rows in this band
            baos.write(0x1D); // GS
            baos.write(0x76); // v
            baos.write(0x30); // 0
            baos.write(0x00); // m = normal density
            baos.write(bytesPerRow & 0xFF);
            baos.write((bytesPerRow >> 8) & 0xFF);
            baos.write(bandRows & 0xFF);
            baos.write((bandRows >> 8) & 0xFF);

            for (int r = 0; r < bandRows; r++) {
                int y = bandStart + r;
                mono.getPixels(rowPixels, 0, imgWidth, 0, y, imgWidth, 1);

                byte[] rowBytes = new byte[bytesPerRow]; // zero-filled = white padding

                for (int x = 0; x < imgWidth; x++) {
                    // Black pixel = bit set to 1
                    if ((rowPixels[x] & 0xFF) == 0) { // black
                        int byteIndex = leftPadBytes + (x / 8);
                        int bitIndex = 7 - (x % 8);
                        if (byteIndex < bytesPerRow) {
                            rowBytes[byteIndex] |= (1 << bitIndex);
                        }
                    }
                }
                baos.write(rowBytes, 0, bytesPerRow);
            }
        }

        return baos.toByteArray();
    }

    /**
     * Attempts to connect to {@code address}, retrying with increasing delays so that
     * a competing app (e.g. GrabFood) has time to release the BT socket between tries.
     * Also tries the hidden createRfcommSocket(1) reflection path when SDP-based connect fails.
     */
    private void connectWithRetry(String address) throws Exception {
        BluetoothDevice device = bluetoothAdapter.getRemoteDevice(address);
        Exception lastError = null;
        for (int i = 0; i < CONNECT_RETRY_DELAYS_MS.length; i++) {
            if (CONNECT_RETRY_DELAYS_MS[i] > 0) {
                Log.w(TAG, "BT connect retry " + i + " — waiting " + CONNECT_RETRY_DELAYS_MS[i] + "ms for socket to free up");
                Thread.sleep(CONNECT_RETRY_DELAYS_MS[i]);
            }
            try {
                BluetoothSocket socket = createSocket(device);
                socket.connect();
                bluetoothSocket = socket;
                outputStream = bluetoothSocket.getOutputStream();
                connectedAddress = address;
                Thread.sleep(80);
                Log.d(TAG, "Connected to " + address + " on attempt " + (i + 1));
                return;
            } catch (Exception e) {
                lastError = e;
                Log.w(TAG, "Connect attempt " + (i + 1) + " failed: " + e.getMessage());
                if (bluetoothSocket != null) {
                    try { bluetoothSocket.close(); } catch (Exception ignored) {}
                    bluetoothSocket = null;
                    outputStream = null;
                }
            }
        }
        throw lastError != null ? lastError : new IOException("Connection failed after retries");
    }

    /**
     * Creates an RFCOMM socket using the standard UUID path; falls back to the
     * hidden createRfcommSocket(channel=1) on devices where SDP lookup fails.
     */
    @SuppressWarnings({"JavaReflectionMemberAccess", "PrivateApi"})
    private BluetoothSocket createSocket(BluetoothDevice device) throws Exception {
        try {
            return device.createRfcommSocketToServiceRecord(SPP_UUID);
        } catch (IOException e) {
            Log.w(TAG, "createRfcommSocketToServiceRecord failed, trying reflection fallback: " + e.getMessage());
            try {
                java.lang.reflect.Method m = device.getClass().getMethod("createRfcommSocket", int.class);
                return (BluetoothSocket) m.invoke(device, 1);
            } catch (Exception ex) {
                throw e; // rethrow original if reflection also fails
            }
        }
    }

    private synchronized void reconnect() throws Exception {
        if (connectedAddress == null) {
            throw new IOException("No previous connection address");
        }
        disconnect();
        if (bluetoothAdapter.isDiscovering()) {
            bluetoothAdapter.cancelDiscovery();
        }
        BluetoothDevice device = bluetoothAdapter.getRemoteDevice(connectedAddress);
        BluetoothSocket socket = createSocket(device);
        socket.connect();
        bluetoothSocket = socket;
        outputStream = bluetoothSocket.getOutputStream();
        Thread.sleep(100);
        Log.d(TAG, "Reconnected to " + connectedAddress);
    }

    private void disconnect() {
        if (outputStream != null) {
            try { outputStream.close(); } catch (IOException e) { Log.w(TAG, "Stream close error", e); }
            outputStream = null;
        }
        if (bluetoothSocket != null) {
            try { bluetoothSocket.close(); } catch (IOException e) { Log.w(TAG, "Socket close error", e); }
            bluetoothSocket = null;
        }
        // Keep connectedAddress so reconnect() can find the printer
    }

    /** Explicit user-initiated disconnect — clears stored address too. */
    @PluginMethod
    public void forgetPrinter(PluginCall call) {
        disconnect();
        connectedAddress = null;
        call.resolve();
    }

    @Override
    protected void handleOnPause() {
        super.handleOnPause();
        // Release the socket when the app goes to background so other apps (e.g. GrabFood)
        // can connect to the same printer without being blocked by a stale held socket.
        if (bluetoothSocket != null) {
            Log.d(TAG, "onPause: releasing socket for other apps");
            disconnect();
        }
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        // Drop any held socket when the app returns to foreground — it may have been
        // invalidated while we were paused. Connect fresh on the next print job.
        if (bluetoothSocket != null) {
            Log.d(TAG, "onResume: releasing stale socket — will reconnect on next print");
            disconnect();
        }
    }
}

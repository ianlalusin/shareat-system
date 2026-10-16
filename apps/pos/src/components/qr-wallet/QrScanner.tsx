"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CameraOff, ImageUp, Loader2, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { decodeQrFromFrame, decodeQrFromImage } from "@/lib/qr/decode-image";

/**
 * Live QR scanner for adding a saved QR to the wallet.
 *
 * WHY A LIVE SCANNER AND NOT A PHOTO: the wallet stores the decoded EMVCo
 * payload and re-renders it as a fresh, crisp QR. A photo is never displayed to
 * a customer, so there is no reason to keep one — and a still capture that
 * fails to decode leaves nothing usable, whereas a scanner simply keeps trying
 * until it reads. Nothing is saved until a payload is actually in hand.
 *
 * This is the reason the app needs android.permission.CAMERA: reading the
 * preview stream means getUserMedia, not the OS camera app.
 */

/** How often to attempt a decode. ~10/s is smooth and leaves the UI responsive. */
const SCAN_INTERVAL_MS = 100;
/** Frames are downscaled to this long edge before decoding — plenty for a QR. */
const FRAME_MAX_EDGE = 720;

type ScannerState = "starting" | "scanning" | "denied" | "unavailable" | "insecure";

export function QrScanner({
  onResult,
  onCancel,
}: {
  onResult: (payload: string) => void;
  onCancel: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const busyRef = useRef(false);
  /** Latches on first hit so a burst of frames cannot fire onResult twice. */
  const doneRef = useRef(false);

  const [state, setState] = useState<ScannerState>("starting");
  const [detail, setDetail] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [decodingFile, setDecodingFile] = useState(false);

  const stop = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  const tick = useCallback(async () => {
    if (busyRef.current || doneRef.current) return;
    const video = videoRef.current;
    if (!video || video.readyState < video.HAVE_CURRENT_DATA) return;

    busyRef.current = true;
    try {
      const scale = Math.min(1, FRAME_MAX_EDGE / Math.max(video.videoWidth, video.videoHeight));
      const width = Math.max(1, Math.round(video.videoWidth * scale));
      const height = Math.max(1, Math.round(video.videoHeight * scale));

      if (!canvasRef.current) canvasRef.current = document.createElement("canvas");
      const canvas = canvasRef.current;
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }

      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(video, 0, 0, width, height);

      const hit = await decodeQrFromFrame(ctx.getImageData(0, 0, width, height));
      if (hit && !doneRef.current) {
        doneRef.current = true;
        stop();
        onResult(hit.payload);
      }
    } catch {
      // A bad frame must never break the scan loop.
    } finally {
      busyRef.current = false;
    }
  }, [onResult, stop]);

  const start = useCallback(async () => {
    doneRef.current = false;
    setDetail(null);
    setState("starting");

    // getUserMedia is absent outside a secure context. The APK is fine
    // (androidScheme https), but plain-http dev hosts are not — say so rather
    // than showing a bare "camera unavailable".
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setState(window.isSecureContext === false ? "insecure" : "unavailable");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });
      streamRef.current = stream;

      const video = videoRef.current;
      if (!video) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      video.srcObject = stream;
      // iOS/WebView will not autoplay without this pair being set on the element.
      video.setAttribute("playsinline", "true");
      video.muted = true;
      await video.play();

      setState("scanning");
      timerRef.current = setInterval(() => void tick(), SCAN_INTERVAL_MS);
    } catch (error: any) {
      const name = String(error?.name ?? "");
      if (name === "NotAllowedError" || name === "SecurityError") {
        setState("denied");
      } else if (name === "NotFoundError" || name === "OverconstrainedError") {
        setState("unavailable");
      } else {
        setState("unavailable");
        setDetail(error?.message ?? null);
      }
    }
  }, [tick]);

  useEffect(() => {
    void start();
    return stop;
    // start/stop are stable; re-running would restart the camera mid-scan.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const problem = state === "denied" || state === "unavailable" || state === "insecure";

  /**
   * Fallback for when there is no usable camera — a desktop manager, or a
   * tablet whose camera is broken or blocked. Decodes an existing image and
   * keeps ONLY the payload; the image itself is read in memory and discarded,
   * so this still never stores a picture of a QR.
   */
  const handleFile = useCallback(
    async (file: File) => {
      setDecodingFile(true);
      setDetail(null);
      try {
        const hit = await decodeQrFromImage(file);
        if (hit) {
          doneRef.current = true;
          stop();
          onResult(hit.payload);
        } else {
          setDetail("No QR code found in that image. Try a sharper, closer shot.");
        }
      } catch (error: any) {
        setDetail(error?.message ?? "Could not read that image.");
      } finally {
        setDecodingFile(false);
      }
    },
    [onResult, stop],
  );

  return (
    <div className="space-y-3">
      <div className="relative aspect-[4/3] w-full overflow-hidden rounded-lg border bg-black">
        <video
          ref={videoRef}
          playsInline
          muted
          className="h-full w-full object-cover"
        />

        {state === "scanning" && (
          // Aiming box — matches the centre region the decoder tries first.
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="h-2/3 w-2/3 rounded-lg border-2 border-white/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" />
          </div>
        )}

        {state === "starting" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-white">
            <Loader2 className="h-6 w-6 animate-spin" />
            <p className="text-sm">Starting camera…</p>
          </div>
        )}

        {problem && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center text-white">
            <CameraOff className="h-8 w-8 opacity-70" />
            <p className="text-sm font-medium">
              {state === "denied"
                ? "Camera permission was denied"
                : state === "insecure"
                  ? "Camera needs a secure (https) connection"
                  : "No camera available"}
            </p>
            <p className="max-w-xs text-sm text-white/70">
              {state === "denied"
                ? "Allow camera access for SHAREAT POS in Android settings, then try again."
                : state === "insecure"
                  ? "Open the app over https, or use the installed APK."
                  : (detail ?? "This device has no usable camera.")}
            </p>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {state === "scanning" ? "Point at the QR code — it saves automatically." : " "}
        </p>
        <div className="flex gap-2">
          {problem && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) void handleFile(file);
                }}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                disabled={decodingFile}
                title="Read a QR out of a saved image — only its data is kept"
              >
                {decodingFile ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <ImageUp className="mr-2 h-4 w-4" />
                )}
                Use an image
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => void start()}>
                <RefreshCw className="mr-2 h-4 w-4" />
                Try again
              </Button>
            </>
          )}
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}

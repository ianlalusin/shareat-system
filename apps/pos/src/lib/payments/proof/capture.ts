"use client";

import { Timestamp, doc, serverTimestamp, setDoc, updateDoc } from "firebase/firestore";
import { getDownloadURL, ref as storageRef, uploadBytes } from "firebase/storage";

import { auth, db, storage } from "@/lib/firebase/client";
import { PROOF_UPLOAD_MAX_EDGE, downscaleImage } from "@/lib/images/downscale";
import type { PaymentProof, SavedQrCode } from "@/lib/types";

import {
  MAX_UPLOAD_ATTEMPTS,
  enqueueProofPhoto,
  listQueuedProofPhotos,
  markProofPhotoAttempted,
  removeQueuedProofPhoto,
} from "./outbox";

/**
 * How long a proof photo is kept. Mirrored by the Storage lifecycle rule in
 * storage-lifecycle.json — if you change one, change the other, or the photo
 * and its document will stop expiring together.
 */
export const PROOF_RETENTION_DAYS = 15;

/**
 * Storage prefix. Top-level rather than under stores/{id}/ so a lifecycle rule
 * can match it with a literal prefix — see storage-lifecycle.json.
 */
function proofStoragePath(storeId: string, proofId: string): string {
  return `paymentProofs/${storeId}/${proofId}.jpg`;
}

export type CaptureProofArgs = {
  file: Blob;
  storeId: string;
  qr: Pick<SavedQrCode, "id" | "name" | "provider"> | null;
  localUserId: string | null;
  isOnline: boolean;
};

/**
 * Saves a photo of the customer's payment confirmation.
 *
 * DELIBERATELY JUST A PHOTO — no amount, no reference, no OCR. The sale is
 * still rung up through the normal Mode-of-Payment flow; this is a visual
 * record, not a second source of truth for money.
 *
 * Offline the photo parks in the outbox and the document is written local-first
 * with imageUrl null, so a capture is never lost for want of a connection.
 */
export async function capturePaymentProof({
  file,
  storeId,
  qr,
  localUserId,
  isOnline,
}: CaptureProofArgs): Promise<PaymentProof> {
  const proofId = crypto.randomUUID();
  const storagePath = proofStoragePath(storeId, proofId);
  const now = Date.now();

  const shrunk = await downscaleImage(file, { maxEdge: PROOF_UPLOAD_MAX_EDGE });

  let imageUrl: string | null = null;
  let imageUploadStatus: PaymentProof["imageUploadStatus"] = "pending";

  if (isOnline) {
    try {
      const target = storageRef(storage, storagePath);
      await uploadBytes(target, shrunk.blob, { contentType: "image/jpeg" });
      imageUrl = await getDownloadURL(target);
      imageUploadStatus = "uploaded";
    } catch (error) {
      // Online but the upload failed — queue it rather than lose the photo.
      console.warn("[proof] upload failed, queueing:", error);
      await enqueueProofPhoto({
        proofId,
        storeId,
        storagePath,
        contentType: "image/jpeg",
        blob: shrunk.blob,
      });
    }
  } else {
    await enqueueProofPhoto({
      proofId,
      storeId,
      storagePath,
      contentType: "image/jpeg",
      blob: shrunk.blob,
    });
  }

  const record: PaymentProof = {
    id: proofId,
    storeId,
    qrId: qr?.id ?? null,
    qrName: qr?.name ?? null,
    provider: qr?.provider ?? null,
    imageUrl,
    imageStoragePath: storagePath,
    imageUploadStatus,
    capturedAtMs: now,
    createdAt: serverTimestamp(),
    createdByUid: auth.currentUser?.uid ?? "",
    createdByName: auth.currentUser?.displayName ?? null,
    createdByLocalUserId: localUserId,
    // Timestamp, NOT a number: a Firestore TTL policy silently ignores a field
    // of any other type, and the collection would grow forever with no error.
    expiresAt: Timestamp.fromMillis(now + PROOF_RETENTION_DAYS * 24 * 60 * 60 * 1000),
  };

  // Not awaited against the network: offline this lands in the persistent cache
  // and replays on reconnect, which is the whole point.
  void setDoc(doc(db, "stores", storeId, "paymentProofs", proofId), record).catch((error) =>
    console.warn("[proof] document write failed:", error),
  );

  return record;
}

/** Serializes flushes so a reconnect burst cannot upload the same photo twice. */
let flushing = false;

/**
 * Uploads every parked proof photo and patches its document. Best-effort
 * throughout — this runs behind a live till and must never interrupt anyone.
 */
export async function flushProofOutbox(): Promise<{ uploaded: number; failed: number }> {
  if (flushing || (typeof navigator !== "undefined" && navigator.onLine === false)) {
    return { uploaded: 0, failed: 0 };
  }
  flushing = true;

  let uploaded = 0;
  let failed = 0;
  try {
    for (const entry of await listQueuedProofPhotos()) {
      try {
        const target = storageRef(storage, entry.storagePath);
        await uploadBytes(target, entry.blob, { contentType: entry.contentType });
        const imageUrl = await getDownloadURL(target);

        await updateDoc(doc(db, "stores", entry.storeId, "paymentProofs", entry.proofId), {
          imageUrl,
          imageUploadStatus: "uploaded",
        });
        await removeQueuedProofPhoto(entry.proofId);
        uploaded += 1;
      } catch (error) {
        failed += 1;
        console.warn(`[proof-outbox] upload failed for ${entry.proofId}:`, error);

        if (entry.attempts + 1 >= MAX_UPLOAD_ATTEMPTS) {
          await removeQueuedProofPhoto(entry.proofId);
          await updateDoc(doc(db, "stores", entry.storeId, "paymentProofs", entry.proofId), {
            imageUploadStatus: "failed",
          }).catch(() => {
            /* The document may itself still be replaying from the offline cache. */
          });
        } else {
          await markProofPhotoAttempted(entry);
        }
      }
    }
  } finally {
    flushing = false;
  }

  return { uploaded, failed };
}

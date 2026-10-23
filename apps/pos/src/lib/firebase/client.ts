

"use client";

import { initializeApp, getApps } from "firebase/app";
import { getAuth, updateProfile, connectAuthEmulator } from "firebase/auth";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, doc, updateDoc, serverTimestamp, setDoc, connectFirestoreEmulator } from "firebase/firestore";
import { getStorage, ref, uploadBytes, getDownloadURL, connectStorageEmulator } from "firebase/storage";
import { firebaseConfig } from "@/firebase/config";
import { emulatorProfile } from '../../../config/emulator-profile.mjs';

// Initialize Firebase
const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];

const auth = getAuth(app);
// Initialize with ignoreUndefinedProperties and offline persistence.
const db = initializeFirestore(app, {
  ignoreUndefinedProperties: true,
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});

const storage = getStorage(app);
const emulator = emulatorProfile(process.env.NEXT_PUBLIC_POS_EMULATOR_MODE, process.env.NEXT_PUBLIC_POS_EMULATOR_HOST);
if (emulator) {
    if (app.options.projectId !== emulator.projectId) throw new Error('The POS emulator build cannot use a live Firebase app.');
    connectAuthEmulator(auth, `http://${emulator.host}:${emulator.authPort}`, { disableWarnings: true });
    connectFirestoreEmulator(db, emulator.host, emulator.firestorePort);
    connectStorageEmulator(storage, emulator.host, emulator.storagePort);
}

export async function uploadProductImage(productId: string, file: File): Promise<string> {
    if (!productId) {
        throw new Error("Product ID is required to upload an image.");
    }

    const storageRef = ref(storage, `Items/${productId}.webp`);
    
    await uploadBytes(storageRef, file);
    const downloadURL = await getDownloadURL(storageRef);

    const productDocRef = doc(db, "products", productId);
    await updateDoc(productDocRef, {
        imageUrl: downloadURL,
        updatedAt: serverTimestamp(),
    });

    return downloadURL;
}

/**
 * Uploads a manager's local photo for an item at their own store to
 * productPhotos/{productId}/{storeId}/{uuid}.webp. Does NOT write any
 * Firestore field itself — callers must follow up with POST
 * /api/product-photo-requests { op: "submit", storeId, productId, imageUrl }
 * so the submission is recorded and reviewable, not just silently applied.
 *
 * The file name is a fresh crypto.randomUUID() per submission (same
 * convention as paymentProofs — see storage.rules), NOT a deterministic
 * `{storeId}.webp`. A deterministic name breaks the moment an admin promotes
 * the photo: products/{id}.imageUrl then points at that exact object, so a
 * manager replacing their own local photo would overwrite the file every
 * store's global picture resolves to — silently changing (or blanking) the
 * global photo without any review. A new object per upload keeps the promoted
 * URL immutable, so promote/reject stay the only ways the global photo moves.
 */
export async function uploadItemPhotoLocal(productId: string, storeId: string, file: File): Promise<string> {
    if (!productId || !storeId) {
        throw new Error("Product ID and store ID are required to upload a photo.");
    }

    const storageRef = ref(storage, `productPhotos/${productId}/${storeId}/${crypto.randomUUID()}.webp`);
    await uploadBytes(storageRef, file);
    return getDownloadURL(storageRef);
}

export async function uploadUserAvatar(userId: string, file: File): Promise<string> {
    const user = auth.currentUser;
    if (!user || user.uid !== userId) {
        throw new Error("User ID does not match authenticated user.");
    }

    const storageRef = ref(storage, `users/${userId}/avatar.jpg`);
    await uploadBytes(storageRef, file);
    const downloadURL = await getDownloadURL(storageRef);

    // Update both Firestore and Firebase Auth profile
    const userDocRef = doc(db, "staff", userId);
    await updateDoc(userDocRef, {
        photoURL: downloadURL,
        updatedAt: serverTimestamp(),
    });

    await updateProfile(user, { photoURL: downloadURL });

    return downloadURL;
}

export async function uploadStoreLogo(storeId: string, file: File): Promise<string> {
    if (!storeId) {
        throw new Error("Store ID is required to upload a logo.");
    }

    const storageRef = ref(storage, `stores/${storeId}/logo.png`);
    
    await uploadBytes(storageRef, file);
    const downloadURL = await getDownloadURL(storageRef);

    const storeDocRef = doc(db, "stores", storeId);
    await updateDoc(storeDocRef, {
        logoUrl: downloadURL,
        updatedAt: serverTimestamp(),
    });

    return downloadURL;
}

export async function uploadReceiptLogo(storeId: string, file: File): Promise<string> {
  if (!storeId) {
    throw new Error('Store ID is required to upload a logo.');
  }

  const storageRef = ref(storage, `stores/${storeId}/receipt_logo.png`);

  await uploadBytes(storageRef, file);
  const downloadURL = await getDownloadURL(storageRef);

  const settingsDocRef = doc(db, `stores/${storeId}/receiptSettings`, 'main');
  await setDoc(settingsDocRef, { logoUrl: downloadURL }, { merge: true });

  return downloadURL;
}


export { app, auth, db, storage };

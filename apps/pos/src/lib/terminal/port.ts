/** T-423 S2 - the real Firestore port for `claim.ts`: the modular SDK's functions plus the app's `db`. */
import {
  collection, doc, documentId, getDoc, getDocs, limit, orderBy, query, runTransaction, serverTimestamp, where,
} from 'firebase/firestore';
import { db } from '@/lib/firebase/client';
import type { FirestorePort } from '@/lib/terminal/claim';

export function getFirestorePort(): FirestorePort {
  return { db, doc, collection, getDoc, getDocs, query, where, orderBy, limit, documentId, runTransaction, serverTimestamp } as unknown as FirestorePort;
}

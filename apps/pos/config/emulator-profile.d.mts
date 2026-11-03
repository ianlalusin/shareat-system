export interface EmulatorProfile {
  readonly projectId: 'demo-shareat-pos2';
  readonly host: string;
  readonly apiBase: string;
  /** Defaults 9099 / 8080 / 9199; moved only by POS_EMULATOR_{AUTH,FIRESTORE,STORAGE}_PORT (practice copy). */
  readonly authPort: number;
  readonly firestorePort: number;
  readonly storagePort: number;
}
export function emulatorProfile(enabled?: string, host?: string): Readonly<EmulatorProfile> | null;

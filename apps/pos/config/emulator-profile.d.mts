export interface EmulatorProfile {
  readonly projectId: 'demo-shareat-pos2';
  readonly host: string;
  readonly apiBase: string;
  readonly authPort: 9099;
  readonly firestorePort: 8080;
  readonly storagePort: 9199;
}
export function emulatorProfile(enabled?: string, host?: string): Readonly<EmulatorProfile> | null;

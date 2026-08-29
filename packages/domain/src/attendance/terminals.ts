/**
 * Provisioning, activating and revoking a clock terminal. T-159.
 * `docs/tasks/159-firestore-rules-and-device-identity.md`, bible §5.3.
 *
 * ⭐ **Transport-free.** Minting the Firebase custom token is a driver call, so this module — like
 * every other in `packages/domain` — never imports a cloud SDK. `packages/sync-firestore` is the
 * one place `firebase-admin` lives for this lane, exactly as `packages/storage-firebase` is for the
 * bucket.
 */
import { sql } from 'drizzle-orm';
import { authorize, type Actor } from '@shareat/auth';
import { clockTerminalsRepo, type ClockTerminalRow, type Tx } from '@shareat/db';
import { terminalFirebaseUid } from '@shareat/db/schema';

export class TerminalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TerminalError';
  }
}

/**
 * What a terminal identity provider must do. Implemented by `packages/sync-firestore`; faked in
 * tests, which is the point of stating it as an interface here.
 */
export interface TerminalIdentityDriver {
  /**
   * A ONE-TIME token the device exchanges for a real Firebase session.
   * ⚠️ Returned once and never stored — the same rule `sessions.tokenHash` already follows.
   */
  mintCustomToken(input: {
    firebaseUid: string;
    claims: { deviceId: string; storeId: string; orgId: string };
  }): Promise<string>;

  /** ⛔ Must make the device's NEXT token refresh fail. Disabling, not deleting. */
  disable(firebaseUid: string): Promise<void>;
}

export interface ProvisionResult {
  terminal: ClockTerminalRow;
  /** ⚠️ Shown once, as a QR code for the device to scan. Never logged, never stored. */
  customToken: string;
}

/**
 * Create a terminal identity and mint its pairing token.
 *
 * ⚠️ **This does not make the terminal ready.** T-153 finding 3: a device cannot begin
 * authenticating offline, so it must complete one sign-in *while it has a connection* before it can
 * write anything. `activatedAt` records that, and `isReady` is the question a screen should ask.
 */
export async function provisionTerminal(
  tx: Tx,
  actor: Actor,
  driver: TerminalIdentityDriver,
  input: { storeId: string; label: string },
): Promise<ProvisionResult> {
  await authorize(tx, actor, 'provision_clock_terminal', { storeId: input.storeId });

  const label = input.label.trim();
  if (!label) throw new TerminalError('A terminal needs a label — it is how a manager finds it again.');

  const id = await nextTerminalId(tx);
  const terminal = await clockTerminalsRepo.insertTerminal(tx, {
    id,
    orgId: actor.orgId,
    storeId: input.storeId,
    label,
    firebaseUid: terminalFirebaseUid(id),
    provisionedBy: actor.personId,
  });

  const customToken = await driver.mintCustomToken({
    firebaseUid: terminal.firebaseUid,
    // ⭐ `deviceId` is the terminal's own id. The rules compare it against the event's `deviceId`,
    // so one identifier travels from the token to the document to the row.
    claims: { deviceId: terminal.id, storeId: terminal.storeId, orgId: terminal.orgId },
  });

  return { terminal, customToken };
}

/**
 * Re-pair a device that was wiped or replaced, without changing its identity.
 *
 * ⭐ The same terminal row and the same `deviceId`, so its history — the punches it captured, its
 * `lastSeenAt` — stays attached to the thing on the counter rather than to a serial number.
 */
export async function mintTerminalToken(
  tx: Tx,
  actor: Actor,
  driver: TerminalIdentityDriver,
  input: { terminalId: string },
): Promise<{ customToken: string }> {
  const terminal = await requireLive(tx, input.terminalId);
  await authorize(tx, actor, 'provision_clock_terminal', {
    storeId: terminal.storeId,
    orgId: terminal.orgId,
  });
  const customToken = await driver.mintCustomToken({
    firebaseUid: terminal.firebaseUid,
    claims: { deviceId: terminal.id, storeId: terminal.storeId, orgId: terminal.orgId },
  });
  return { customToken };
}

/**
 * The device has signed in for the first time. **Now** it is ready.
 *
 * ⛔ No `authorize()`: the caller is the device itself, proving it by holding a token this server
 * minted. Requiring a human capability here would mean a manager has to stand next to every
 * terminal at the moment it first connects.
 */
export async function activateTerminal(
  tx: Tx,
  input: { terminalId: string },
): Promise<ClockTerminalRow> {
  const terminal = await requireLive(tx, input.terminalId);
  if (terminal.activatedAt) return terminal;
  return clockTerminalsRepo.markActivated(tx, terminal.id, new Date());
}

/**
 * Revoke a terminal — lost, stolen, or retired.
 *
 * ⚠️ **An already-issued ID token stays valid for up to an hour.** That is Firebase's model, not a
 * defect here, and it is stated rather than implied: what that hour still permits is reading one
 * store's mirror and writing idempotent, attributable inbox events. Anything stronger would need a
 * revocation check on every read, which is a Postgres round trip the offline lane cannot make.
 */
export async function revokeTerminal(
  tx: Tx,
  actor: Actor,
  driver: TerminalIdentityDriver,
  input: { terminalId: string; reason: string },
): Promise<ClockTerminalRow> {
  const terminal = await requireLive(tx, input.terminalId);
  await authorize(tx, actor, 'provision_clock_terminal', {
    storeId: terminal.storeId,
    orgId: terminal.orgId,
  });

  const reason = input.reason.trim();
  if (!reason) {
    throw new TerminalError(
      'Revoking a terminal needs a reason — a revoked row nobody can explain is not an audit trail.',
    );
  }

  await driver.disable(terminal.firebaseUid);
  return clockTerminalsRepo.markRevoked(tx, {
    id: terminal.id,
    at: new Date(),
    by: actor.personId,
    reason,
  });
}

export async function listTerminals(
  tx: Tx,
  actor: Actor,
  input: { storeId: string },
): Promise<ClockTerminalRow[]> {
  await authorize(tx, actor, 'manage_attendance', { storeId: input.storeId });
  return clockTerminalsRepo.listForStore(tx, input.storeId);
}

/** Provisioned, activated, not revoked. The only state that may write a punch. */
export function isReady(terminal: ClockTerminalRow): boolean {
  return terminal.activatedAt !== null && terminal.revokedAt === null;
}

async function requireLive(tx: Tx, terminalId: string): Promise<ClockTerminalRow> {
  const terminal = await clockTerminalsRepo.getTerminal(tx, terminalId);
  if (!terminal) throw new TerminalError(`No clock terminal ${terminalId}`);
  if (terminal.revokedAt) {
    throw new TerminalError(
      `Terminal ${terminal.label} was revoked on ${terminal.revokedAt.toISOString().slice(0, 10)} ` +
        `(${terminal.revokeReason}). Provision a new one rather than reviving it — its history stays readable.`,
    );
  }
  return terminal;
}

/** Postgres mints the id so it is time-ordered and generated in one place. */
async function nextTerminalId(tx: Tx): Promise<string> {
  const r = await tx.execute<{ id: string }>(sql`select uuidv7() as id`);
  return String((r as unknown as { id: string }[])[0]!.id);
}

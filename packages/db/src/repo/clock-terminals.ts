/** The only place SQL is written for clock terminals. T-159. */
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Tx } from '../client';
import { clockTerminals } from '../../schema/clock-terminals';

export interface ClockTerminalRow {
  id: string;
  orgId: string;
  storeId: string;
  label: string;
  firebaseUid: string;
  provisionedBy: string | null;
  provisionedAt: Date;
  activatedAt: Date | null;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
  revokedBy: string | null;
  revokeReason: string | null;
}

export async function insertTerminal(
  tx: Tx,
  input: { id: string; orgId: string; storeId: string; label: string; firebaseUid: string; provisionedBy: string },
): Promise<ClockTerminalRow> {
  const [row] = await tx.insert(clockTerminals).values(input).returning();
  return row as ClockTerminalRow;
}

export async function getTerminal(tx: Tx, id: string): Promise<ClockTerminalRow | undefined> {
  const [row] = await tx.select().from(clockTerminals).where(eq(clockTerminals.id, id)).limit(1);
  return row as ClockTerminalRow | undefined;
}

/** Live terminals for a store — provisioned, not revoked. Activation is a separate question. */
export async function listForStore(tx: Tx, storeId: string): Promise<ClockTerminalRow[]> {
  const rows = await tx
    .select()
    .from(clockTerminals)
    .where(and(eq(clockTerminals.storeId, storeId), isNull(clockTerminals.revokedAt)))
    .orderBy(asc(clockTerminals.label));
  return rows as ClockTerminalRow[];
}

export async function markActivated(tx: Tx, id: string, at: Date): Promise<ClockTerminalRow> {
  const [row] = await tx
    .update(clockTerminals)
    .set({ activatedAt: at, updatedAt: new Date() })
    .where(eq(clockTerminals.id, id))
    .returning();
  return row as ClockTerminalRow;
}

export async function markRevoked(
  tx: Tx,
  input: { id: string; at: Date; by: string; reason: string },
): Promise<ClockTerminalRow> {
  const [row] = await tx
    .update(clockTerminals)
    .set({ revokedAt: input.at, revokedBy: input.by, revokeReason: input.reason, updatedAt: new Date() })
    .where(eq(clockTerminals.id, input.id))
    .returning();
  return row as ClockTerminalRow;
}

/** Stamped by the ingestor on every batch. A terminal silent for a day is an operational signal. */
export async function touchLastSeen(tx: Tx, id: string, at: Date): Promise<void> {
  await tx.update(clockTerminals).set({ lastSeenAt: at }).where(eq(clockTerminals.id, id));
}

"use client";

/** The write surface `createKitchenTickets` needs — satisfied by both a
 *  Firestore `Transaction` and a `WriteBatch`. */
export interface TicketWriter {
  set(ref: any, data: any, options?: any): unknown;
  update(ref: any, data: any): unknown;
}

/** Picks the transaction or batch writer, so `createKitchenTickets` can run
 *  inside an online transaction OR an offline local-first batch with identical
 *  write logic. */
export function selectTicketWriter(
  opts: { tx: TicketWriter } | { batch: TicketWriter },
): TicketWriter {
  return "tx" in opts ? opts.tx : opts.batch;
}

# POS v2 device store (T-530a)

The tablet's own storage, over IndexedDB (`shareat-pos-v2`, version 1).

- **One opener.** Only `db.ts` calls `indexedDB.open`; `indexedDB` is read lazily inside functions.
- **Durable before resolved.** `enqueue`/`reserveTerminalSeq` resolve on the transaction's
  `complete`, so a resolved promise means the row and its counter are on disk.
- **Nothing here talks to the network.** `drain` is handed the caller's `send`.
- **The outbox is not a backup.** "Clear site data" or an uninstall loses it (design §5.4); the
  server has whatever was already sent.
- **The snapshot is never blanked** — a failed refresh leaves the last good menu in place.

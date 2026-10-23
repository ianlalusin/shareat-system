# T-460 evidence
Status: source/targets/APK build verified; paid receipt acknowledgement runtime gate remains pending. Saved as unfinished work because Ian asked to commit and stop development.
- Initial RED: 5 failed / 71 passed across cleaner, payment wiring and reconciliation. Failures exposed real SDK prototype loss, plain-map receipt transport and the legacy false conflict.
- Final targets: 79 passed across 3 files, using real Timestamp/serverTimestamp/DocumentReference instances; normal typed timestamp control retained.
- Changed qty/price/discount quantity/value/type/item id/total/receipt number still quarantined; malformed/extra-key/null clocks not discarded. Existing server-read refusal and replay tests retained.
- Original computeLinesHash and saved event hash unchanged. Compatibility candidate removes only exact valid timestamp maps at top-level createdAt/updatedAt, then compares to the ORIGINAL hash; no ops-only equality shortcut.
- Cleaner preserves SDK instances and still removes undefined plain/array values; no SDK calls/network needed in the real-type unit tests.
- Full POS969 passed / 1 existing skip / 90 files; typecheck clean. No pricing, auth, schema or historical receipt/status edits.
- Old EMU-01-000001 quarantine remains forensic evidence; this slice never automatically reprocesses it. New runtime order required before claiming acknowledgement.
- APK build passed 111 native tasks; all 34 moved sources restored byte-identically, no cap stash. Installed only net.shareat.pos2.emulator. Native new own Timestamp Test session SbcdOyxj8ED8XH4GdwAI created one Test dish100 while online; local demo REST confirmed createdAt/updatedAt are timestampValue, not plain maps. Offline payment modal opened but was NOT confirmed. When Ian switched priorities to ERP, the modal was closed, app force-stopped, WiFi/data restored ON, local9009 stopped and generated files cleaned. REST confirmed isPaid=false. No paid T460 receipt/restart/reconnect acknowledgement claim.
- Ian's 2026-10-22 closing instruction: commit current work and stop development; next role is a read-only auditor every five hours, starting at an exact time he will supply. Old development heartbeat is paused. Do not resume implementation from a stale heartbeat or treat an idle emulator as soak evidence.
## FOR IAN
The timestamp mismatch is reproduced and corrected in code. POS remains unreleased until runtime and remaining gates pass.

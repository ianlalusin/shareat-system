# T-463 — emulator harness checkpoint, 21 October
Explicit local demo profile; dedicated net.shareat.pos2.emulator APK; no live Firebase or payment writes.
Target red: 3 failed/2 passed before wiring; fixture/release control red: 1 failed/5 passed; final focused 6 passed.
Postcommit ef42de5: 910 POS tests passed, 1 existing skip, 86 files; 241 guards/census passed, 8 files.
TypeScript noEmit passed; static export and APK build passed; incremental native repeat passed (111 tasks).
Real Gradle preReleaseBuild refused demo assets with the intended message; no timeout or security baseline widened.
All 34 temporarily moved tracked server/API/middleware files byte-identical to HEAD; no .cap-stash remains.
Android API35: installed, synthetic manager signed in; offline force-stop/reopen retained login; reconnect loaded store/session data.
Offline session survived reopen and synced once; first dish failed (DEF-741), corrected and order-retested in T-456; paid-sale persistence remains unverified.
Root checks: 239 passed/2 failed initially; copy log omissions corrected and 20 passed; unchanged artifact scan repeat 20 passed.
Copy-log supporting scope expanded in T-463; phase plan/runbook updated under Ian's explicit documentation request.
Physical tablet/printer/payment/visual/soak, local server approvals and shared-auth migration remain unverified.
## FOR IAN
Emulator testing now works and found an offline selling defect. Harness checkpoint is not POS release approval.

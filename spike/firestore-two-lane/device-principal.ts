/**
 * T-180 Contract §4 — "Does `request.auth.token.deviceId` work from a custom token, which is what
 * T-159's device-principal design assumes?"
 *
 * This is the spike's answer to that question, and it is the mechanism plan §3 row 5 proposes:
 * bible §5.3 forbids a plaintext device secret in localStorage (v1 stores `{id, secret}` in the
 * clear), so the device authenticates as ITSELF via a server-minted custom token carrying a
 * `deviceId` claim — and the SDK, not our code, holds the refresh material.
 *
 * ⚠️ The Auth EMULATOR accepts a custom token with an unsigned ("alg": "none") signature. Production
 * does not: there, the token is signed by the service account. That is the whole difference between
 * this file and the real minting service, and it is the only reason a spike needs no credential.
 */
const b64url = (o: unknown) =>
  Buffer.from(JSON.stringify(o)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

export function unsignedCustomToken(uid: string, claims: Record<string, unknown>): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'none', typ: 'JWT' };
  const payload = {
    iss: 'spike@shareat-spike.iam.gserviceaccount.com',
    sub: 'spike@shareat-spike.iam.gserviceaccount.com',
    aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
    iat: now,
    exp: now + 3600,
    uid,
    claims,
  };
  return `${b64url(header)}.${b64url(payload)}.`;
}

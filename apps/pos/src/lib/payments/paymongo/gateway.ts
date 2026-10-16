export function isPaymongoQrMethod(mop: { gateway?: 'paymongo_qrph' | null }): boolean {
  return mop.gateway === "paymongo_qrph";
}

export function shouldOfferPaymongoQr(
  mop: { gateway?: 'paymongo_qrph' | null; isActive: boolean },
  isOnline: boolean,
): boolean {
  if (!isPaymongoQrMethod(mop)) return true; // non-gateway → normal rules apply upstream
  return mop.isActive && isOnline;
}

import "server-only";
import QRCode from "qrcode";

const ISSUER = "KEP Keuskupan Bandung";

/** otpauth URI plus a QR code rendered server-side as a PNG data URI (CSP img-src allows data:). */
export async function enrollmentPayload(email: string, secret: string): Promise<{ secret: string; otpauthUri: string; qr: string }> {
  const otpauthUri =
    `otpauth://totp/${encodeURIComponent(`${ISSUER}:${email}`)}` +
    `?secret=${secret}&issuer=${encodeURIComponent(ISSUER)}`;
  const qr = await QRCode.toDataURL(otpauthUri, { errorCorrectionLevel: "M", margin: 2, width: 240 });
  return { secret, otpauthUri, qr };
}

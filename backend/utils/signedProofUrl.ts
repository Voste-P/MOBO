/**
 * Signed proof URL utility.
 *
 * Generates time-limited HMAC-signed tokens so Excel/Google Sheets
 * can open proof images via HYPERLINK without requiring auth headers.
 *
 * Token format: base64url(payload).base64url(hmac-sha256)
 * Payload: { oid: orderId, pt: proofType, exp: expiryTimestamp }
 */
import crypto from 'node:crypto';

/** Token validity: 7 days (Excel reports may be opened days later) */
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function getSigningKey(env: { JWT_ACCESS_SECRET: string }): string {
  return env.JWT_ACCESS_SECRET;
}

export function createProofToken(
  orderId: string,
  proofType: string,
  env: { JWT_ACCESS_SECRET: string },
): string {
  const payload = JSON.stringify({
    oid: orderId,
    pt: proofType,
    exp: Date.now() + TOKEN_TTL_MS,
  });
  const payloadB64 = Buffer.from(payload).toString('base64url');
  const sig = crypto
    .createHmac('sha256', getSigningKey(env))
    .update(payloadB64)
    .digest('base64url');
  return `${payloadB64}.${sig}`;
}

export function verifyProofToken(
  token: string,
  env: { JWT_ACCESS_SECRET: string },
): { orderId: string; proofType: string } | null {
  const dotIdx = token.indexOf('.');
  if (dotIdx < 0) return null;

  const payloadB64 = token.slice(0, dotIdx);
  const sig = token.slice(dotIdx + 1);
  const expectedSig = crypto
    .createHmac('sha256', getSigningKey(env))
    .update(payloadB64)
    .digest('base64url');

  // Constant-time comparison to prevent timing attacks
  if (
    sig.length !== expectedSig.length ||
    !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
    if (!payload.oid || !payload.pt || !payload.exp) return null;
    if (Date.now() > payload.exp) return null; // expired
    return { orderId: String(payload.oid), proofType: String(payload.pt) };
  } catch {
    return null;
  }
}

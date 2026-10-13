export interface FcmServiceAccount {
  clientEmail: string;
  /** PEM, PKCS#8. */
  privateKey: string;
}

/**
 * FCM_SERVICE_ACCOUNT: the service-account JSON Firebase hands out, base64
 * encoded so it fits one env line. Null when it is not that. Nothing here
 * ever puts the value, or a part of it, in a message.
 */
export function parseFcmServiceAccount(
  encoded: string,
): FcmServiceAccount | null {
  try {
    if (!/^[A-Za-z0-9+/=_-]+$/.test(encoded.trim())) return null;
    const json: unknown = JSON.parse(
      Buffer.from(encoded.trim(), 'base64').toString('utf8'),
    );
    if (typeof json !== 'object' || json === null) return null;
    const { client_email: clientEmail, private_key: privateKey } =
      json as Record<string, unknown>;
    if (typeof clientEmail !== 'string' || !clientEmail.includes('@'))
      return null;
    if (
      typeof privateKey !== 'string' ||
      !privateKey.includes('-----BEGIN PRIVATE KEY-----')
    )
      return null;
    return { clientEmail, privateKey };
  } catch {
    return null;
  }
}

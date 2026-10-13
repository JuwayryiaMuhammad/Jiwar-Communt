import { createPrivateKey } from 'node:crypto';
import { isEmail } from 'class-validator';

export interface FcmServiceAccount {
  clientEmail: string;
  /** PEM, with real newlines. */
  privateKey: string;
}

/**
 * FCM_PRIVATE_KEY as the key itself: an env line holds the PEM with its
 * newlines written as the two characters `\n` (the way Firebase's JSON
 * has them); a loader that already turned them into newlines changes
 * nothing here.
 */
export function fcmPrivateKeyPem(value: string): string {
  return value.replace(/\\n/g, '\n').trim() + '\n';
}

/**
 * The service account behind FCM_CLIENT_EMAIL and FCM_PRIVATE_KEY, or what
 * is wrong with them. Nothing here ever puts a value, or a part of one, in
 * a message.
 */
export function fcmServiceAccount(
  clientEmail: string,
  privateKey: string,
): FcmServiceAccount | { invalid: 'FCM_CLIENT_EMAIL' | 'FCM_PRIVATE_KEY' } {
  if (!isEmail(clientEmail)) return { invalid: 'FCM_CLIENT_EMAIL' };
  const pem = fcmPrivateKeyPem(privateKey);
  try {
    // RS256 signs with it: it must be a private RSA key.
    if (createPrivateKey(pem).asymmetricKeyType !== 'rsa')
      return { invalid: 'FCM_PRIVATE_KEY' };
  } catch {
    return { invalid: 'FCM_PRIVATE_KEY' };
  }
  return { clientEmail, privateKey: pem };
}

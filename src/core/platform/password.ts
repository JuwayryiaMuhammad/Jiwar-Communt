import * as argon2 from 'argon2';

/** OWASP-recommended argon2id parameters (19 MiB, 2 passes, 1 lane). */
const OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export const MIN_PASSWORD_LENGTH = 12;

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, OPTIONS);
}

/** Never throws on a malformed hash; that is simply a mismatch. */
export async function verifyPassword(
  hash: string,
  password: string,
): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

let dummy: Promise<string> | undefined;

/**
 * A real hash to verify against when the email is unknown, so an unknown
 * email costs the same time as a wrong password (ADR 0011).
 */
export function dummyHash(): Promise<string> {
  dummy ??= hashPassword('dummy-password-for-timing-equalization');
  return dummy;
}

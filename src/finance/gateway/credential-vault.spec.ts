import { randomBytes } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../../core/config/env.schema';
import {
  CredentialVault,
  VaultOpenError,
  VaultUnavailableError,
} from './credential-vault';

const T1 = '0190a1b2-0000-7000-8000-000000000001';
const T2 = '0190a1b2-0000-7000-8000-000000000002';
const k = () => randomBytes(32).toString('base64');

function vault(env: Partial<Env>): CredentialVault {
  const values: Partial<Env> = { PAYMENT_CREDENTIALS_KEY_VERSION: 1, ...env };
  return new CredentialVault({
    get: (key: keyof Env) => values[key],
  } as unknown as ConfigService<Env, true>);
}

describe('CredentialVault (ADR 0046)', () => {
  it('seals and opens a value for its compound and field', () => {
    const v = vault({ PAYMENT_CREDENTIALS_KEY: k() });
    const sealed = v.seal(T1, 'secret_key', 'egy_sk_test_abc');
    expect(sealed.keyVersion).toBe(1);
    expect(Buffer.from(sealed.ciphertext).toString('utf8')).not.toContain(
      'egy_sk_test_abc',
    );
    expect(v.open(T1, 'secret_key', sealed.ciphertext, 1)).toBe(
      'egy_sk_test_abc',
    );
  });

  it('a fresh IV every time: the same value never seals the same way twice', () => {
    const v = vault({ PAYMENT_CREDENTIALS_KEY: k() });
    const a = v.seal(T1, 'hmac_secret', 'x'.repeat(30));
    const b = v.seal(T1, 'hmac_secret', 'x'.repeat(30));
    expect(Buffer.from(a.ciphertext).equals(Buffer.from(b.ciphertext))).toBe(
      false,
    );
  });

  it('a value copied to another compound, another field or relabelled with another version does not open', () => {
    const key = k();
    const v = vault({
      PAYMENT_CREDENTIALS_KEY: key,
      PAYMENT_CREDENTIALS_KEY_VERSION: 2,
      PAYMENT_CREDENTIALS_PREVIOUS_KEYS: `1:${key}`,
    });
    const sealed = v.seal(T1, 'secret_key', 'egy_sk_test_abc');
    expect(() => v.open(T2, 'secret_key', sealed.ciphertext, 2)).toThrow(
      VaultOpenError,
    );
    expect(() => v.open(T1, 'public_key', sealed.ciphertext, 2)).toThrow(
      VaultOpenError,
    );
    // Same key bytes under version 1: the AAD carries the version.
    expect(() => v.open(T1, 'secret_key', sealed.ciphertext, 1)).toThrow(
      VaultOpenError,
    );
  });

  it('a tampered value does not open', () => {
    const v = vault({ PAYMENT_CREDENTIALS_KEY: k() });
    const sealed = v.seal(T1, 'secret_key', 'egy_sk_test_abc');
    const bad = Uint8Array.from(sealed.ciphertext);
    bad[bad.length - 1] ^= 1;
    expect(() => v.open(T1, 'secret_key', bad, 1)).toThrow(VaultOpenError);
    expect(() => v.open(T1, 'secret_key', bad.subarray(0, 20), 1)).toThrow(
      VaultOpenError,
    );
  });

  it('rotation: a value sealed under a retired key still opens, new values use the current one', () => {
    const old = k();
    const before = vault({ PAYMENT_CREDENTIALS_KEY: old });
    const sealed = before.seal(T1, 'secret_key', 'egy_sk_live_abc');
    const after = vault({
      PAYMENT_CREDENTIALS_KEY: k(),
      PAYMENT_CREDENTIALS_KEY_VERSION: 2,
      PAYMENT_CREDENTIALS_PREVIOUS_KEYS: `1:${old}`,
    });
    expect(after.canOpen(1)).toBe(true);
    expect(after.open(T1, 'secret_key', sealed.ciphertext, 1)).toBe(
      'egy_sk_live_abc',
    );
    expect(after.seal(T1, 'secret_key', 'x').keyVersion).toBe(2);
    // Once the old key is dropped, its values do not open.
    const dropped = vault({
      PAYMENT_CREDENTIALS_KEY: k(),
      PAYMENT_CREDENTIALS_KEY_VERSION: 2,
    });
    expect(dropped.canOpen(1)).toBe(false);
    expect(() => dropped.open(T1, 'secret_key', sealed.ciphertext, 1)).toThrow(
      VaultOpenError,
    );
  });

  it('without a key nothing is sealed', () => {
    const v = vault({});
    expect(v.available).toBe(false);
    expect(v.currentVersion).toBeNull();
    expect(() => v.seal(T1, 'secret_key', 'x')).toThrow(VaultUnavailableError);
  });
});

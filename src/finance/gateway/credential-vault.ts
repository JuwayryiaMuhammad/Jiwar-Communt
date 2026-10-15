import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../core/config/env.schema';
import {
  paymentKeyRing,
  type PaymentKeyRing,
} from '../../core/config/payment-key-ring';

/** What a ciphertext seals: one field of one compound's gateway, or a checkout secret. */
export type VaultField =
  | 'secret_key'
  | 'public_key'
  | 'hmac_secret'
  | 'card_integration_id'
  | 'wallet_integration_id'
  | `client_secret:${string}`;

export interface Sealed {
  /** iv (12) ‖ tag (16) ‖ ciphertext. */
  ciphertext: Uint8Array<ArrayBuffer>;
  keyVersion: number;
}

const IV_BYTES = 12;
const TAG_BYTES = 16;

/** No key configured: nothing can be sealed (ADR 0046). */
export class VaultUnavailableError extends Error {
  constructor() {
    super('PAYMENT_CREDENTIALS_KEY is not set');
  }
}

/**
 * The value cannot be opened: unknown key version, wrong compound or field
 * (AAD), or tampering. Deliberately says nothing more.
 */
export class VaultOpenError extends Error {
  constructor() {
    super('ciphertext cannot be opened');
  }
}

/**
 * The payment credential vault (ADR 0046): AES-256-GCM, a fresh 12-byte IV
 * per value, and additional data that binds each ciphertext to its compound,
 * its field and the key version, so a value copied to another compound or
 * column, or relabelled with another version, does not open.
 */
@Injectable()
export class CredentialVault {
  private readonly ring: PaymentKeyRing;

  constructor(config: ConfigService<Env, true>) {
    this.ring = paymentKeyRing({
      PAYMENT_CREDENTIALS_KEY: config.get('PAYMENT_CREDENTIALS_KEY', {
        infer: true,
      }),
      PAYMENT_CREDENTIALS_KEY_VERSION: config.get(
        'PAYMENT_CREDENTIALS_KEY_VERSION',
        { infer: true },
      ),
      PAYMENT_CREDENTIALS_PREVIOUS_KEYS: config.get(
        'PAYMENT_CREDENTIALS_PREVIOUS_KEYS',
        { infer: true },
      ),
    });
  }

  /** A key is configured, so values can be sealed. */
  get available(): boolean {
    return this.ring.current !== null;
  }

  /** The version new values are sealed with, or null without a key. */
  get currentVersion(): number | null {
    return this.ring.current?.version ?? null;
  }

  /** A value sealed with this version can be opened. */
  canOpen(keyVersion: number): boolean {
    return this.ring.byVersion.has(keyVersion);
  }

  seal(tenantId: string, field: VaultField, plaintext: string): Sealed {
    const current = this.ring.current;
    if (!current) throw new VaultUnavailableError();
    if (plaintext.length === 0) throw new Error('nothing to seal');
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', current.key, iv);
    cipher.setAAD(aad(tenantId, field, current.version));
    const body = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const out = new Uint8Array(IV_BYTES + TAG_BYTES + body.length);
    out.set(iv, 0);
    out.set(cipher.getAuthTag(), IV_BYTES);
    out.set(body, IV_BYTES + TAG_BYTES);
    return { ciphertext: out, keyVersion: current.version };
  }

  open(
    tenantId: string,
    field: VaultField,
    ciphertext: Uint8Array,
    keyVersion: number,
  ): string {
    const key = this.ring.byVersion.get(keyVersion);
    if (!key || ciphertext.length <= IV_BYTES + TAG_BYTES) {
      throw new VaultOpenError();
    }
    const bytes = Buffer.from(ciphertext);
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        key,
        bytes.subarray(0, IV_BYTES),
      );
      decipher.setAAD(aad(tenantId, field, keyVersion));
      decipher.setAuthTag(bytes.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
      return Buffer.concat([
        decipher.update(bytes.subarray(IV_BYTES + TAG_BYTES)),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new VaultOpenError();
    }
  }
}

function aad(tenantId: string, field: VaultField, version: number): Buffer {
  return Buffer.from(`jiwar:finance:${tenantId}:${field}:v${version}`, 'utf8');
}

/** The last four characters, the only part of a credential ever shown. */
export function last4(value: string): string {
  return value.slice(-4);
}

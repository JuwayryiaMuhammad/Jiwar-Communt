import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../core/config/env.schema';

/**
 * The resident's entry QR (ADR 0031): `JWR2.<credentialId>.<step>.<mac>`.
 * - `secret = HMAC-SHA256(ENTRY_CREDENTIAL_KEY, "entry:<tenantId>:<credentialId>")`,
 *   32 bytes, shown to the phone once (base64url) and never stored;
 * - `step = floor(unixSeconds / 30)`;
 * - `mac = base64url(first 16 bytes of HMAC-SHA256(secret, "<credentialId>.<step>"))`,
 *   the key being the secret's 32 raw bytes.
 * The phone computes the mac offline; the server derives the same secret and
 * compares. Nothing here touches a database.
 */
export const ENTRY_STEP_SECONDS = 30;
/** The clock skew allowed: the current step and one either side. */
export const ENTRY_SKEW_STEPS = 1;
export const ENTRY_QR_PREFIX = 'JWR2.';
const MAC_BYTES = 16;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const QR = new RegExp(
  `^${ENTRY_QR_PREFIX.replace('.', '\\.')}(${UUID})\\.(\\d{1,12})\\.([A-Za-z0-9_-]{22})$`,
);

export interface EntryQr {
  credentialId: string;
  step: number;
  mac: string;
}

/** The secret of one credential: 32 bytes, derived and never stored. */
export function deriveEntrySecret(
  key: string,
  tenantId: string,
  credentialId: string,
): Buffer {
  return createHmac('sha256', key)
    .update(`entry:${tenantId}:${credentialId}`)
    .digest();
}

export function entryMac(
  secret: Buffer,
  credentialId: string,
  step: number,
): string {
  return createHmac('sha256', secret)
    .update(`${credentialId}.${step}`)
    .digest()
    .subarray(0, MAC_BYTES)
    .toString('base64url');
}

export function entryStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / ENTRY_STEP_SECONDS);
}

export function entryQr(
  credentialId: string,
  step: number,
  mac: string,
): string {
  return `${ENTRY_QR_PREFIX}${credentialId}.${step}.${mac}`;
}

/** The parts of a scanned payload, or null when it is not shaped like one. */
export function parseEntryQr(raw: string): EntryQr | null {
  const m = QR.exec(raw.trim());
  if (!m) return null;
  const step = Number(m[2]);
  if (!Number.isSafeInteger(step)) return null;
  return { credentialId: m[1], step, mac: m[3] };
}

/** Constant-time comparison of two macs. */
export function macsEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Holds the key; the one place that derives a credential's secret. */
@Injectable()
export class EntrySecrets {
  private readonly key: string;

  constructor(config: ConfigService<Env, true>) {
    this.key = config.get('ENTRY_CREDENTIAL_KEY', { infer: true });
  }

  secretFor(tenantId: string, credentialId: string): Buffer {
    return deriveEntrySecret(this.key, tenantId, credentialId);
  }

  /** What the phone keeps: base64url of the 32 bytes. */
  encodedSecretFor(tenantId: string, credentialId: string): string {
    return this.secretFor(tenantId, credentialId).toString('base64url');
  }

  macFor(tenantId: string, credentialId: string, step: number): string {
    return entryMac(this.secretFor(tenantId, credentialId), credentialId, step);
  }
}

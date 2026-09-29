import { createHmac } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { IdentifierType } from '@prisma/client';
import { isEmail } from 'class-validator';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import type { Env } from '../config/env.schema';

export interface NormalizedIdentifier {
  type: IdentifierType;
  value: string;
}

/** Default region for numbers typed without a country code. */
const DEFAULT_REGION = 'EG';

export function normalizeEmail(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  return isEmail(value) ? value : null;
}

/** E.164 (`+2010…`), or null when the input is not a valid number. */
export function normalizePhone(raw: string): string | null {
  const parsed = parsePhoneNumberFromString(raw.trim(), DEFAULT_REGION);
  return parsed?.isValid() ? parsed.number : null;
}

/** A login identifier is an email if it contains `@`, otherwise a phone. */
export function parseIdentifier(raw: string): NormalizedIdentifier | null {
  if (raw.includes('@')) {
    const value = normalizeEmail(raw);
    return value ? { type: 'email', value } : null;
  }
  const value = normalizePhone(raw);
  return value ? { type: 'phone', value } : null;
}

/**
 * HMAC-SHA256 with the server pepper. A plain SHA of a phone number is
 * brute-forceable in minutes; without the pepper this is not (ADR 0004).
 */
@Injectable()
export class IdentifierHasher {
  private readonly pepper: string;

  constructor(config: ConfigService<Env, true>) {
    this.pepper = config.get('IDENTIFIER_PEPPER', { infer: true });
  }

  hashIdentifier(id: NormalizedIdentifier): string {
    return this.hmac(`id:${id.type}:${id.value}`);
  }

  /** Bound to the challenge so a code hash is useless outside its row. */
  hashOtp(challengeId: string, code: string): string {
    return this.hmac(`otp:${challengeId}:${code}`);
  }

  private hmac(data: string): string {
    return createHmac('sha256', this.pepper).update(data).digest('hex');
  }
}

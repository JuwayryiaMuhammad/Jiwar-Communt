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

  /** An invite link token (ADR 0016). The raw token is never stored. */
  hashInviteToken(token: string): string {
    return this.hmac(`invite:${token}`);
  }

  /** A compound registration link token (ADR 0024). Never stored raw. */
  hashRegistrationLink(token: string): string {
    return this.hmac(`registration-link:${token}`);
  }

  /**
   * The key of a registration code (ADR 0024): bound to the link, the email
   * the code goes to and the exact request, so the code confirms only what
   * was sent — the payload cannot be swapped at completion.
   */
  hashRegistrationRequest(
    linkHash: string,
    email: string,
    digest: string,
  ): string {
    return this.hmac(`register:${linkHash}:${email}:${digest}`);
  }

  /** A worker's national ID, to find the same person again (ADR 0017). */
  hashWorkerNationalId(nationalId: string): string {
    return this.hmac(`worker-national-id:${nationalId}`);
  }

  /** A worker's passport: the same number may exist in two countries (ADR 0018). */
  hashWorkerPassport(nationality: string, number: string): string {
    return this.hmac(`passport:${nationality}:${number}`);
  }

  /** A worker access code, unique among the compound's active ones (ADR 0017). */
  hashWorkerCode(tenantId: string, code: string): string {
    return this.hmac(`worker-code:${tenantId}:${code}`);
  }

  /** A visitor pass code (ADR 0028), bound to its compound like a worker's. */
  hashVisitorCode(tenantId: string, code: string): string {
    return this.hmac(`visitor-code:${tenantId}:${code}`);
  }

  private hmac(data: string): string {
    return createHmac('sha256', this.pepper).update(data).digest('hex');
  }
}

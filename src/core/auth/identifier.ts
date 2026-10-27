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
   * A registrant's status link token (ADR 0062), derived from the request
   * and the link's number: the email that carries it is rendered at send
   * time from ids alone, so no outbox row, log or audit entry holds it. A
   * newer number makes a new token; only the newest has a pointer.
   */
  registrationStatusToken(
    tenantId: string,
    registrationId: string,
    seq: number,
  ): string {
    return this.hmac(
      `registration-status:v1:${tenantId}:${registrationId}:${seq}`,
    );
  }

  /** What the status link's pointer keeps of its token (ADR 0062). */
  hashRegistrationStatusLink(token: string): string {
    return this.hmac(`registration-status-link:${token}`);
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

  /**
   * The key of a step-up code (ADR 0036): what the code unlocks — one
   * session, one email action token, or one platform session (ADR 0046) —
   * so a code issued for one can never
   * be used for another.
   */
  stepUpKey(
    scope: 'session' | 'action-token' | 'platform-session',
    id: string,
  ): string {
    return this.hmac(`step-up:${scope}:${id}`);
  }

  /**
   * A device an account logged in from (ADR 0036): bound to the account, so
   * the same install can never be linked across accounts.
   */
  hashDevice(
    accountId: string,
    source: 'app' | 'web',
    material: string,
  ): string {
    return this.hmac(`device:v1:${accountId}:${source}:${material}`);
  }

  /**
   * The mac of an email action token (ADR 0036). The token is
   * `<id>.<mac>`: derived from the row's id and purpose with the pepper, so
   * nothing secret is ever stored and only the server can make one.
   */
  actionTokenMac(purpose: string, id: string): string {
    return this.hmac(`action-token:v1:${purpose}:${id}`);
  }

  /**
   * The last four characters of a contractor worker's ID (ADR 0049), bound
   * to the compound and the worker: the guard types them from the card and
   * only the server can compare. Four characters have few values; without
   * the pepper none of them can be tried against a stored hash.
   */
  hashPermitWorkerIdLast4(
    tenantId: string,
    workerId: string,
    last4: string,
  ): string {
    return this.hmac(`permit-worker-id:v1:${tenantId}:${workerId}:${last4}`);
  }

  /**
   * A full ID number on the compound's blocklist (ADR 0053), normalized
   * (`normalizeIdNumber`), bound to the compound: the number is never
   * stored, and an ID typed at the gate is compared by this alone.
   */
  hashBlocklistId(tenantId: string, idNumber: string): string {
    return this.hmac(`blocklist-id:v1:${tenantId}:${idNumber}`);
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

  /**
   * The QR token of a pass or a worker engagement, bound to its compound
   * (ADR 0030): another compound's QR is simply unknown at this gate.
   */
  hashQrToken(tenantId: string, token: string): string {
    return this.hmac(`qr:${tenantId}:${token}`);
  }

  /**
   * A parcel's code (ADR 0035), bound to its compound, with a label of its
   * own: a parcel code is never a visitor or a worker code.
   */
  hashParcelCode(tenantId: string, code: string): string {
    return this.hmac(`parcel-code:${tenantId}:${code}`);
  }

  /** A parcel's QR token, bound to its compound and apart from `qr:` (ADR 0035). */
  hashParcelQr(tenantId: string, token: string): string {
    return this.hmac(`parcel-qr:${tenantId}:${token}`);
  }

  /**
   * An outside escort's pickup code (ADR 0054), bound to its compound, with
   * a label of its own: never a visitor, a worker or a parcel code.
   */
  hashChildPickupCode(tenantId: string, code: string): string {
    return this.hmac(`child-pickup-code:${tenantId}:${code}`);
  }

  /** A pickup code's QR token, bound to its compound and apart from `qr:` (ADR 0054). */
  hashChildPickupQr(tenantId: string, token: string): string {
    return this.hmac(`child-pickup-qr:${tenantId}:${token}`);
  }

  /** A pickup link, global: the public page knows no compound yet (ADR 0054). */
  hashChildPickupLink(token: string): string {
    return this.hmac(`child-pickup-link:${token}`);
  }

  /** A visitor's link, global: the public page knows no compound yet (ADR 0030). */
  hashVisitorLink(token: string): string {
    return this.hmac(`visitor-link:${token}`);
  }

  /**
   * The short code derived from a token (ADR 0030): whoever holds the token
   * (the link, the card) can show the code, and the server stores neither.
   * The first 64 bits of the HMAC modulo 10^digits; the bias is ~10^-11.
   */
  deriveCode(token: string, digits: 6 | 8): string {
    const head = BigInt(`0x${this.hmac(`code:${token}`).slice(0, 16)}`);
    return (head % 10n ** BigInt(digits)).toString().padStart(digits, '0');
  }

  private hmac(data: string): string {
    return createHmac('sha256', this.pepper).update(data).digest('hex');
  }
}

import type { OtpPurpose } from '@prisma/client';
import type { Locale } from '../common/i18n/locale';

export interface OtpMessage {
  to: string;
  code: string;
  ttlSeconds: number;
  locale: Locale;
  /** Changes the wording only; the code works for this purpose alone. */
  purpose: OtpPurpose;
}

/**
 * How a one-time code reaches the user. Email, and for a login typed as a phone,
 * SMS (ADR 0004, 0009, 0095); WhatsApp can be added behind the same
 * interface.
 */
export interface OtpChannel {
  send(message: OtpMessage): Promise<void>;
}

export const OTP_CHANNEL = Symbol('OTP_CHANNEL');

/** The login code by SMS (ADR 0095): the same interface, `to` is a phone. */
export const SMS_OTP_CHANNEL = Symbol('SMS_OTP_CHANNEL');

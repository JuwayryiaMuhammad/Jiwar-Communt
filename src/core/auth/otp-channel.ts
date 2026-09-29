import type { Locale } from '../common/i18n/locale';

export interface OtpMessage {
  to: string;
  code: string;
  ttlSeconds: number;
  locale: Locale;
}

/**
 * How a one-time code reaches the user. Email in Phase 0; WhatsApp/SMS can be
 * added behind the same interface (ADR 0004, 0009).
 */
export interface OtpChannel {
  send(message: OtpMessage): Promise<void>;
}

export const OTP_CHANNEL = Symbol('OTP_CHANNEL');

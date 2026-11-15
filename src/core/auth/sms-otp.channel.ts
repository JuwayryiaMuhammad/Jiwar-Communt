import { Inject, Injectable } from '@nestjs/common';
import { SMS_SENDER, type SmsSender } from '../sms/sms-sender';
import type { OtpChannel, OtpMessage } from './otp-channel';
import { renderOtpSms } from './otp-sms.templates';

/** A text that did not go: what the sender answered, never the number or the text. */
export class SmsDeliveryError extends Error {
  constructor(
    readonly kind: 'number' | 'rejected' | 'unavailable' | 'unknown' | 'off',
    readonly code: string,
  ) {
    super(`SMS not delivered (${kind} ${code})`);
  }
}

/**
 * The login code by SMS (ADR 0095): `to` is a phone in E.164. Only the login
 * purpose goes this way; every other purpose stays on the email channel.
 * Throws when the text did not go, so the caller can fall back to email.
 */
@Injectable()
export class SmsOtpChannel implements OtpChannel {
  constructor(@Inject(SMS_SENDER) private readonly sender: SmsSender | null) {}

  async send({ to, code, ttlSeconds, locale, purpose }: OtpMessage) {
    if (purpose !== 'login') throw new SmsDeliveryError('rejected', 'PURPOSE');
    if (!this.sender) throw new SmsDeliveryError('off', 'OFF');
    const result = await this.sender.send({
      to,
      body: renderOtpSms(locale, code, ttlSeconds),
      // Not worth delivering after the code expired.
      validitySeconds: ttlSeconds,
    });
    if (!result.ok) throw new SmsDeliveryError(result.kind, result.code);
  }
}

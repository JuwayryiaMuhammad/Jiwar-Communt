import { Injectable } from '@nestjs/common';
import { Mailer } from '../mail/mailer';
import type { OtpChannel, OtpMessage } from './otp-channel';
import { renderOtpEmail } from './otp-email.templates';

@Injectable()
export class EmailOtpChannel implements OtpChannel {
  constructor(private readonly mailer: Mailer) {}

  async send({ to, code, ttlSeconds, locale, purpose }: OtpMessage) {
    await this.mailer.send(
      to,
      renderOtpEmail(locale, code, ttlSeconds, purpose),
    );
  }
}

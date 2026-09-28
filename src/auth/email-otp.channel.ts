import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';
import type { Env } from '../config/env.schema';
import type { OtpChannel, OtpMessage } from './otp-channel';
import { renderOtpEmail } from './otp-email.templates';

@Injectable()
export class EmailOtpChannel implements OtpChannel, OnApplicationShutdown {
  private readonly transport: Transporter;
  private readonly from: string;

  constructor(config: ConfigService<Env, true>) {
    const user = config.get('SMTP_USER', { infer: true });
    const pass = config.get('SMTP_PASSWORD', { infer: true });
    this.transport = createTransport({
      host: config.get('SMTP_HOST', { infer: true }),
      port: config.get('SMTP_PORT', { infer: true }),
      secure: config.get('SMTP_SECURE', { infer: true }),
      auth: user ? { user, pass } : undefined,
    });
    this.from = config.get('SMTP_FROM', { infer: true });
  }

  async send({ to, code, ttlSeconds, locale }: OtpMessage): Promise<void> {
    const email = renderOtpEmail(locale, code, ttlSeconds);
    await this.transport.sendMail({
      from: this.from,
      to,
      subject: email.subject,
      text: email.text,
      html: email.html,
    });
  }

  onApplicationShutdown(): void {
    this.transport.close();
  }
}

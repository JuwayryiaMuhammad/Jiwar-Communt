import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';
import type { Env } from '../config/env.schema';
import type { OtpChannel } from './otp-channel';

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

  async send({
    to,
    code,
    ttlSeconds,
  }: {
    to: string;
    code: string;
    ttlSeconds: number;
  }) {
    const minutes = Math.max(1, Math.round(ttlSeconds / 60));
    // No tenant or account details: the email proves possession of the
    // address and nothing else.
    await this.transport.sendMail({
      from: this.from,
      to,
      subject: 'Your Jiwar login code',
      text:
        `Your Jiwar login code is ${code}.\n\n` +
        `It expires in ${minutes} minutes. If you did not try to log in, ignore this email.`,
    });
  }

  onApplicationShutdown(): void {
    this.transport.close();
  }
}

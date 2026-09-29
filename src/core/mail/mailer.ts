import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';
import type { Env } from '../config/env.schema';
import type { RenderedEmail } from './layout';

/**
 * The one SMTP transport (SMTP_* settings). OTP codes and domain notices
 * (household removal, delegation) all go through it. Callers send after the
 * transaction that caused the email has committed.
 */
@Injectable()
export class Mailer implements OnApplicationShutdown {
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

  async send(to: string, email: RenderedEmail): Promise<void> {
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

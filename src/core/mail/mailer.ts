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
    // Pooled: connections are reused instead of one SMTP (and TLS)
    // handshake per email. Opening a connection per message also stalls
    // under bursts — against the local Mailpit, every send after ~10 quick
    // connections took ~5 s.
    this.transport = createTransport({
      pool: true,
      maxConnections: 3,
      host: config.get('SMTP_HOST', { infer: true }),
      port: config.get('SMTP_PORT', { infer: true }),
      secure: config.get('SMTP_SECURE', { infer: true }),
      auth: user ? { user, pass } : undefined,
    });
    this.from = config.get('SMTP_FROM', { infer: true });
  }

  /**
   * `messageId` makes a re-sent message recognizable as the same one (the
   * outbox delivers at least once; ADR 0019).
   */
  async send(
    to: string,
    email: RenderedEmail,
    options: { messageId?: string } = {},
  ): Promise<void> {
    await this.transport.sendMail({
      from: this.from,
      to,
      subject: email.subject,
      text: email.text,
      html: email.html,
      ...(options.messageId ? { messageId: options.messageId } : {}),
    });
  }

  /** `<local@domain>` in the domain of SMTP_FROM. */
  messageIdFor(local: string): string {
    const domain = /@([^>\s]+)/.exec(this.from)?.[1] ?? 'jiwar.local';
    return `<${local}@${domain}>`;
  }

  onApplicationShutdown(): void {
    this.transport.close();
  }
}

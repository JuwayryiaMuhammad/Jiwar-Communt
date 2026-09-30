import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { Locale } from '../common/i18n/locale';
import { newId } from '../common/uuid';
import { GlobalDbService } from '../database/global-db.service';
import type { TenantTxClient } from '../database/tenant-tx.service';
import { EmailTemplates } from './email-templates';

export interface OutboxEmail {
  /** The compound that caused the message, if any. */
  tenantId?: string | null;
  templateKey: string;
  locale: Locale;
  recipient: string;
  params: Record<string, unknown>;
}

/**
 * The transactional outbox (ADR 0019). `enqueue` writes the message in the
 * SAME transaction as the action that causes it: if the action rolls back
 * there is no message, and if the message cannot be written the action
 * rolls back. OutboxProcessor delivers it later, at least once.
 *
 * Every non-OTP email goes through here. OTP codes are sent directly: the
 * user is waiting, and can ask for a new code.
 */
@Injectable()
export class Outbox {
  constructor(
    private readonly globalDb: GlobalDbService,
    private readonly templates: EmailTemplates,
  ) {}

  async enqueue(tx: TenantTxClient, email: OutboxEmail): Promise<string> {
    if (!this.templates.has(email.templateKey)) {
      // A developer mistake: fail the action now rather than write a message
      // that can never be rendered.
      throw new Error(`Unknown email template ${email.templateKey}`);
    }
    const id = newId();
    await this.globalDb.in(tx).outboxMessage.create({
      data: {
        id,
        tenantId: email.tenantId ?? null,
        channel: 'email',
        templateKey: email.templateKey,
        locale: email.locale,
        recipient: email.recipient,
        params: email.params as Prisma.InputJsonValue,
      },
    });
    return id;
  }
}

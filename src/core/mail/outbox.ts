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
  /**
   * The account the message is for, when it is for an account. Erasure
   * strips that account's pending messages by this pointer: an address may
   * be shared by several accounts.
   */
  recipientAccountId?: string | null;
}

/** `last_error_code` of a notice that had nobody to go to. */
export const NO_RECIPIENT = 'NO_RECIPIENT';

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
    this.assertTemplate(email.templateKey);
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
        recipientAccountId: email.recipientAccountId ?? null,
      },
    });
    return id;
  }

  /**
   * "Never silent" when there is nobody to tell (a minor has no account, a
   * permission has no holder): the notice is recorded as already dead, with
   * nothing personal in it, so the failure is on file instead of skipped.
   */
  async recordUndeliverable(
    tx: TenantTxClient,
    notice: {
      tenantId: string;
      templateKey: string;
      locale?: Locale;
      recipientAccountId?: string | null;
    },
  ): Promise<string> {
    this.assertTemplate(notice.templateKey);
    const id = newId();
    const now = new Date();
    await this.globalDb.in(tx).outboxMessage.create({
      data: {
        id,
        tenantId: notice.tenantId,
        channel: 'email',
        templateKey: notice.templateKey,
        locale: notice.locale ?? 'ar',
        recipient: null,
        params: undefined,
        status: 'dead',
        lastErrorCode: NO_RECIPIENT,
        strippedAt: now,
        recipientAccountId: notice.recipientAccountId ?? null,
      },
    });
    return id;
  }

  private assertTemplate(key: string): void {
    if (!this.templates.has(key)) {
      // A developer mistake: fail the action now rather than write a message
      // that can never be rendered.
      throw new Error(`Unknown email template ${key}`);
    }
  }
}

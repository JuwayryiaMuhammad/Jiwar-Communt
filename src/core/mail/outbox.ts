import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { Locale } from '../common/i18n/locale';
import { newId } from '../common/uuid';
import { GlobalDbService } from '../database/global-db.service';
import type { TenantTxClient } from '../database/tenant-tx.service';
import {
  deliveryDecision,
  type DeliveryPrefs,
} from '../preferences/delivery-decision';
import { DeliveryPreferences } from '../preferences/delivery-preferences';
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
 *
 * A message for an account follows that account's delivery preferences
 * (ADR 0036), decided here with the template's delivery class: sent now,
 * held until quiet hours or a pause end (`held_at`; a pause "until resumed"
 * parks it as `held`), or not written at all when its category is switched
 * off. Critical templates always go. Whenever the preferences change, the
 * account's held messages are decided again (`redecideHeld`).
 */
@Injectable()
export class Outbox {
  constructor(
    private readonly globalDb: GlobalDbService,
    private readonly templates: EmailTemplates,
    private readonly preferences: DeliveryPreferences,
  ) {}

  /** The message's id; null when the account's preferences skip it. */
  async enqueue(
    tx: TenantTxClient,
    email: OutboxEmail,
    now: Date = new Date(),
  ): Promise<string | null> {
    this.assertTemplate(email.templateKey);
    let hold: { status: 'pending' | 'held'; nextAttemptAt: Date } | null = null;
    if (email.recipientAccountId) {
      const decision = deliveryDecision(
        await this.preferences.load(tx, email.recipientAccountId),
        this.templates.delivery(email.templateKey),
        'email',
        now,
      );
      if (decision.action === 'skip') return null;
      if (decision.action === 'hold')
        hold = decision.until
          ? { status: 'pending', nextAttemptAt: decision.until }
          : { status: 'held', nextAttemptAt: now };
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
        recipientAccountId: email.recipientAccountId ?? null,
        ...(hold
          ? {
              status: hold.status,
              nextAttemptAt: hold.nextAttemptAt,
              heldAt: now,
            }
          : {}),
      },
    });
    return id;
  }

  /**
   * The account's preferences changed (in this transaction): every message
   * they held and nobody has tried yet is decided again — released now,
   * held until the new end, or deleted when its category is now off. A
   * pause turned off therefore releases its mail at once.
   */
  async redecideHeld(
    tx: TenantTxClient,
    accountId: string,
    prefs: DeliveryPrefs,
    now: Date = new Date(),
  ): Promise<number> {
    const global = this.globalDb.in(tx);
    const held = await global.outboxMessage.findMany({
      where: {
        recipientAccountId: accountId,
        heldAt: { not: null },
        status: { in: ['pending', 'held'] },
        attempts: 0,
      },
      select: { id: true, templateKey: true },
    });
    let changed = 0;
    for (const m of held) {
      if (!this.templates.has(m.templateKey)) continue;
      const decision = deliveryDecision(
        prefs,
        this.templates.delivery(m.templateKey),
        'email',
        now,
      );
      // Untouched by the processor since it was read: still never tried.
      const untried = {
        id: m.id,
        status: { in: ['pending' as const, 'held' as const] },
        attempts: 0,
      };
      if (decision.action === 'skip') {
        changed += (await global.outboxMessage.deleteMany({ where: untried }))
          .count;
        continue;
      }
      const data =
        decision.action === 'deliver'
          ? { status: 'pending' as const, nextAttemptAt: now, heldAt: null }
          : decision.until
            ? { status: 'pending' as const, nextAttemptAt: decision.until }
            : { status: 'held' as const };
      changed += (
        await global.outboxMessage.updateMany({ where: untried, data })
      ).count;
    }
    return changed;
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

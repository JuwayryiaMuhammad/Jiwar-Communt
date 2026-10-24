import { Injectable } from '@nestjs/common';
import { StaffRecipients } from '../../core/access/staff-recipients';
import { GlobalDbService } from '../../core/database/global-db.service';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { Outbox } from '../../core/mail/outbox';
import type {
  NotificationKind,
  NotificationParams,
} from '../../core/notifications/kinds';
import { Notifier } from '../../core/notifications/notifier';
import { PARTNER_EMAILS } from './partner-email-templates';

/**
 * The partners' notifications (ADR 0027, 0060), in the action's
 * transaction. The category is `partners`; no kind is critical. Params are
 * codes at most — never a partner's or anyone's name, a unit, a time or a
 * note. A partner has no account: it is told of a new request by an email
 * to its notify address with no resident data and no link, and a partner
 * the management relays for has its requests told to `partners.manage`.
 */
@Injectable()
export class PartnerNotices {
  constructor(
    private readonly notifier: Notifier,
    private readonly staff: StaffRecipients,
    private readonly outbox: Outbox,
    private readonly globalDb: GlobalDbService,
  ) {}

  /** Tells the active accounts among `to`, never `except` (the one who acted). */
  async send(
    tx: TenantTxClient,
    to: readonly (string | null)[],
    kind: NotificationKind,
    targetId: string,
    params: NotificationParams = {},
    except: string | null = null,
  ): Promise<number> {
    const ids = [...new Set(to)].filter(
      (id): id is string => id !== null && id !== except,
    );
    if (!ids.length) return 0;
    const active = await tx.account.findMany({
      where: { id: { in: ids }, status: 'active' },
      select: { id: true },
    });
    if (!active.length) return 0;
    return this.notifier.notify(
      tx,
      active.map((a) => a.id),
      { kind, params, targetId },
    );
  }

  /** Every holder of `partners.manage`: a request waits for the relay. */
  async toRelay(
    tx: TenantTxClient,
    kind: NotificationKind,
    targetId: string,
    params: NotificationParams = {},
  ): Promise<number> {
    const holders = await this.staff.holding(tx, 'partners.manage');
    return this.send(
      tx,
      holders.map((h) => h.id),
      kind,
      targetId,
      params,
    );
  }

  /**
   * An email to the partner's notify address that a request waits on its
   * desk: the compound's name and nothing else, no link (the link is the
   * management's to give, once). In Arabic, the compound's language.
   */
  async toPartner(
    tx: TenantTxClient,
    tenantId: string,
    recipient: string,
  ): Promise<void> {
    const tenant = await this.globalDb
      .in(tx)
      .tenant.findUniqueOrThrow({ where: { id: tenantId } });
    await this.outbox.enqueue(tx, {
      tenantId,
      templateKey: PARTNER_EMAILS.newRequest,
      locale: 'ar',
      recipient,
      params: { compoundName: tenant.name },
    });
  }
}

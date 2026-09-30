import { Injectable } from '@nestjs/common';
import { GlobalDbService } from '../../core/database/global-db.service';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { Outbox } from '../../core/mail/outbox';
import type { CommunityNoticeKey, NoticeParams } from './community-notices';

/**
 * Queues community notices in the caller's transaction (ADR 0019), so a
 * notice exists exactly when its action commits. An account that cannot be
 * reached (no email: erased) gets an undeliverable record instead of
 * nothing ("never silent").
 */
@Injectable()
export class CommunityNotifier {
  constructor(
    private readonly outbox: Outbox,
    private readonly globalDb: GlobalDbService,
  ) {}

  /** The compound's name and, when given, the unit's code. */
  async place(
    tx: TenantTxClient,
    tenantId: string,
    unitId?: string,
  ): Promise<{ compoundName: string; unitCode?: string }> {
    const tenant = await this.globalDb.in(tx).tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { name: true },
    });
    if (!unitId) return { compoundName: tenant.name };
    const unit = await tx.unit.findUniqueOrThrow({
      where: { id: unitId },
      select: { code: true },
    });
    return { compoundName: tenant.name, unitCode: unit.code };
  }

  /** One notice to each account, deduplicated. Returns how many were undeliverable. */
  async toAccounts(
    tx: TenantTxClient,
    tenantId: string,
    accountIds: string[],
    key: CommunityNoticeKey,
    params: NoticeParams,
  ): Promise<number> {
    const ids = [...new Set(accountIds)];
    if (!ids.length) return 0;
    const people = await tx.account.findMany({
      where: { id: { in: ids } },
      select: { id: true, email: true, preferredLocale: true },
    });
    let undeliverable = 0;
    for (const id of ids) {
      const p = people.find((x) => x.id === id);
      if (!p?.email) {
        undeliverable++;
        await this.outbox.recordUndeliverable(tx, {
          tenantId,
          templateKey: key,
          recipientAccountId: id,
        });
        continue;
      }
      await this.outbox.enqueue(tx, {
        tenantId,
        templateKey: key,
        locale: p.preferredLocale,
        recipient: p.email,
        params: { ...params },
        recipientAccountId: p.id,
      });
    }
    return undeliverable;
  }

  /** A notice for someone without an account (a minor): on file, undelivered. */
  undeliverable(
    tx: TenantTxClient,
    tenantId: string,
    key: CommunityNoticeKey,
  ): Promise<string> {
    return this.outbox.recordUndeliverable(tx, { tenantId, templateKey: key });
  }
}
